require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { Sequelize, DataTypes, Op } = require('sequelize');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'https://asdas-p7ht.onrender.com/',
    methods: ['GET', 'POST']
  }
});

// Render (и большинство PaaS) работают за обратным прокси —
// без этого express-rate-limit будет падать с ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const SALT_ROUNDS = 12;

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET не задан в .env — используется дефолтный небезопасный секрет!');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Слишком много попыток, попробуйте через 15 минут' }
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Слишком много запросов поиска' }
});

// ─── PostgreSQL Connection ────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/chatapp';
const isInternalRenderUrl = /@dpg-[^.]+-a(:\d+)?\//.test(dbUrl) || /@dpg-[^./]+-a\//.test(dbUrl);
const needsSSL = process.env.NODE_ENV === 'production' && !isInternalRenderUrl;

const sequelize = new Sequelize(
  dbUrl,
  {
    dialect: 'postgres',
    logging: false,
    dialectOptions: needsSSL ? {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    } : {},
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    retry: {
      max: 3
    }
  }
);

async function connectWithRetry(retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sequelize.authenticate();
      console.log('✅ PostgreSQL подключена');
      return true;
    } catch (err) {
      console.error(`❌ PostgreSQL (попытка ${attempt}/${retries}):`, err.message);
      if (attempt < retries) {
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
  }
  console.error('❌ Не удалось подключиться к PostgreSQL после нескольких попыток');
  return false;
}

// ─── Models ───────────────────────────────────────────────────────────────────
const User = sequelize.define('User', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
    lowercase: true
  },
  nickname: {
    type: DataTypes.STRING,
    allowNull: false,
    index: true
  },
  passwordHash: {
    type: DataTypes.STRING,
    allowNull: false
  },
  avatar: {
    type: DataTypes.STRING,
    defaultValue: null
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'Привет! Я использую ChatApp'
  },
  bio: {
    type: DataTypes.TEXT,
    defaultValue: ''
  },
  friends: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  },
  friendRequests: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  },
  blockedUsers: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: []
  }
}, {
  timestamps: true,
  underscored: true
});

const Message = sequelize.define('Message', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chatKey: {
    type: DataTypes.STRING,
    allowNull: false,
    index: true
  },
  from: {
    type: DataTypes.STRING,
    allowNull: false
  },
  to: {
    type: DataTypes.STRING,
    allowNull: false
  },
  text: {
    type: DataTypes.TEXT,
    defaultValue: ''
  },
  image: {
    type: DataTypes.STRING,
    defaultValue: null
  },
  type: {
    type: DataTypes.ENUM('text', 'image'),
    defaultValue: 'text'
  },
  read: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  deleted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['chatKey'] },
    { fields: ['createdAt'] }
  ]
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const onlineUsers = {};
function getChatKey(a, b) { return [a, b].sort().join('::'); }

// Простой rate limiter для socket-событий — REST-лимитеры их не покрывают (см. аудит, пункт 2)
function makeSocketLimiter(maxPerWindow, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= maxPerWindow;
  };
}
const canSendMessage = makeSocketLimiter(20, 10_000);       // 20 сообщений / 10 сек
const canSendFriendRequest = makeSocketLimiter(10, 60_000); // 10 заявок / мин

// ─── JWT Auth Middleware ──────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

// ─── File Upload ───────────────────────────────────────────────────────────────
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const crypto = require('crypto');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const storage = multer.diskStorage({
  destination: 'uploads/',
  // originalname от клиента НИКОГДА не участвует в имени файла на диске —
  // иначе это path traversal / произвольное расширение (см. аудит, пункт 5)
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + (EXT_BY_MIME[file.mimetype] || ''))
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только изображения (jpeg, png, webp, gif)'));
    }
  }
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { userId, nickname, password } = req.body;
    const id   = (userId || '').trim().toLowerCase();
    const nick = (nickname || '').trim() || id;

    if (!id || id.length < 3)         return res.status(400).json({ error: 'ID минимум 3 символа' });
    if (!/^[a-z0-9_]+$/.test(id))     return res.status(400).json({ error: 'ID: только a-z, 0-9, _' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });

    const exists = await User.findByPk(id);
    if (exists) return res.status(400).json({ error: 'Этот ID уже занят' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create({ id, nickname: nick, passwordHash, friends: [], friendRequests: [], blockedUsers: [] });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, friends: user.friends, friendRequests: user.friendRequests }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { userId, password } = req.body;
    const id   = (userId || '').trim().toLowerCase();
    const user = await User.findByPk(id);

    if (!user) return res.status(401).json({ error: 'Неверный ID или пароль' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Неверный ID или пароль' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, friends: user.friends, friendRequests: user.friendRequests }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// ─── User Routes ──────────────────────────────────────────────────────────────
app.get('/api/search', authMiddleware, searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    // Ищем по id И по nickname (без учёта регистра)
    const results = await User.findAll({
      where: {
        [Op.or]: [
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('id')),
            'LIKE',
            `%${q.toLowerCase()}%`
          ),
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('nickname')),
            'LIKE',
            `%${q.toLowerCase()}%`
          )
        ]
      },
      limit: 10
    });

    res.json(results.map(u => ({
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar,
      status: u.status,
      online: !!onlineUsers[u.id]
    })));
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

app.get('/api/profile/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, online: !!onlineUsers[user.id], createdAt: user.createdAt });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Ошибка профиля' });
  }
});

app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { nickname, status, bio, avatar } = req.body;

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (nickname !== undefined) user.nickname = nickname;
    if (status  !== undefined) user.status   = status;
    if (bio     !== undefined) user.bio      = bio;
    if (avatar  !== undefined) user.avatar   = avatar;
    await user.save();

    res.json({ success: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio } });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

app.post('/api/upload/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const userId = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    user.avatar = `/uploads/${req.file.filename}`;
    await user.save();
    res.json({ success: true, avatar: user.avatar });
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Ошибка загрузки аватара' });
  }
});

// ─── Block / Unblock ──────────────────────────────────────────────────────────
app.post('/api/users/:id/block', authMiddleware, async (req, res) => {
  try {
    const me = await User.findByPk(req.user.id);
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    const targetId = req.params.id;
    if (targetId === me.id) return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });

    if (!me.blockedUsers.includes(targetId)) {
      me.blockedUsers = [...me.blockedUsers, targetId];
      me.friends = me.friends.filter(id => id !== targetId);
      me.friendRequests = me.friendRequests.filter(id => id !== targetId);
      await me.save();
    }
    res.json({ success: true, blockedUsers: me.blockedUsers });
  } catch (err) {
    console.error('Block error:', err);
    res.status(500).json({ error: 'Ошибка блокировки' });
  }
});

app.post('/api/users/:id/unblock', authMiddleware, async (req, res) => {
  try {
    const me = await User.findByPk(req.user.id);
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    me.blockedUsers = me.blockedUsers.filter(id => id !== req.params.id);
    await me.save();
    res.json({ success: true, blockedUsers: me.blockedUsers });
  } catch (err) {
    console.error('Unblock error:', err);
    res.status(500).json({ error: 'Ошибка разблокировки' });
  }
});

// ─── Message Routes ───────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:friendId', authMiddleware, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { before, limit = 50 } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const key = getChatKey(req.params.userId, req.params.friendId);
    const where = { chatKey: key };
    // Курсорная пагинация: страница без "before" — последние N сообщений;
    // "before" = createdAt самого старого уже загруженного сообщения —
    // так листание истории не сбивается при параллельно приходящих новых сообщениях
    // (в отличие от OFFSET/LIMIT, см. аудит, пункт 8)
    if (before) where.createdAt = { [Op.lt]: new Date(before) };

    const messages = await Message.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: limitNum
    });

    res.json(messages.reverse().map(m => ({
      _id: m.id,
      from: m.from,
      to: m.to,
      text: m.text,
      image: m.image,
      type: m.type,
      deleted: m.deleted,
      time: m.createdAt.toISOString() // раньше отдавался только createdAt — клиент ждал time/timestamp → "Invalid Date"
    })));
  } catch (err) {
    console.error('Messages error:', err);
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

// ─── Delete Message ───────────────────────────────────────────────────────────
app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const msg    = await Message.findByPk(req.params.messageId);

    if (!msg)             return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.from !== userId) return res.status(403).json({ error: 'Нет доступа' });

    msg.deleted = true;
    msg.text    = '';
    msg.image   = null;
    await msg.save();

    const otherUser = msg.chatKey.split('::').find(id => id !== userId);
    io.to(userId).emit('messageDeleted',    { messageId: req.params.messageId, chatWith: otherUser });
    io.to(otherUser).emit('messageDeleted', { messageId: req.params.messageId, chatWith: userId });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete message error:', err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ─── Socket.IO — JWT Auth ────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const currentUserId = socket.user.id;

  // Токен рано или поздно истекает — jwt.verify в io.use проверяет это только
  // на подключении, поэтому соединение принудительно закрываем по exp (см. аудит, пункт 6)
  let expiryTimer = null;
  if (socket.user.exp) {
    const msUntilExpiry = socket.user.exp * 1000 - Date.now();
    expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(msUntilExpiry, 0));
  }

  (async () => {
    try {
      const user = await User.findByPk(currentUserId);
      if (!user) return socket.disconnect();

      onlineUsers[currentUserId] = socket.id;
      socket.join(currentUserId);
      user.friends.forEach(fId => io.to(fId).emit('friendOnline', { id: currentUserId, nickname: user.nickname }));

      // Счётчики непрочитанных сообщений, накопившихся, пока пользователь был оффлайн (аудит, пункт 7)
      const unreadRows = await Message.findAll({
        where: { to: currentUserId, read: false, deleted: false },
        attributes: ['from', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
        group: ['from']
      });
      const unreadCounts = Object.fromEntries(unreadRows.map(r => [r.from, parseInt(r.get('count'), 10)]));

      socket.emit('profile', {
        id:             user.id,
        nickname:       user.nickname,
        avatar:         user.avatar,
        status:         user.status,
        bio:            user.bio,
        friends:        user.friends,
        friendRequests: user.friendRequests,
        unreadCounts
      });
      console.log(`[online] ${currentUserId}`);
    } catch (err) { console.error('Connection init error:', err); }
  })();

  socket.on('sendFriendRequest', async (toId) => {
    try {
      if (!canSendFriendRequest(currentUserId)) return;
      const from = await User.findByPk(currentUserId);
      if (!from || !toId || toId === currentUserId) return;

      // Атомарный UPDATE вместо "прочитать массив → проверить в JS → сохранить" —
      // старая версия была уязвима к гонке при параллельных вызовах (аудит, пункт 3)
      const affected = await sequelize.query(`
        UPDATE "Users"
        SET friend_requests = array_append(friend_requests, :fromId)
        WHERE id = :toId
          AND NOT (:fromId = ANY(friend_requests))
          AND NOT (:fromId = ANY(friends))
          AND NOT (:fromId = ANY(blocked_users))
        RETURNING id
      `, { replacements: { fromId: currentUserId, toId }, type: sequelize.QueryTypes.SELECT });

      if (!affected || !affected.length) return; // уже есть заявка / уже друзья / заблокирован

      io.to(toId).emit('friendRequest', { id: currentUserId, nickname: from.nickname });
      socket.emit('requestSent', { id: toId });
    } catch (err) { console.error('Friend request error:', err); }
  });

  socket.on('acceptFriendRequest', async (fromId) => {
    try {
      const me   = await User.findByPk(currentUserId);
      const them = await User.findByPk(fromId);
      if (!me || !them) return;
      me.friendRequests = me.friendRequests.filter(id => id !== fromId);
      if (!me.friends.includes(fromId))          me.friends = [...me.friends, fromId];
      if (!them.friends.includes(currentUserId)) them.friends = [...them.friends, currentUserId];
      await me.save();
      await them.save();
      socket.emit('friendAdded',        { id: fromId,        nickname: them.nickname, avatar: them.avatar, online: !!onlineUsers[fromId] });
      io.to(fromId).emit('friendAdded', { id: currentUserId, nickname: me.nickname,   avatar: me.avatar,   online: true });
    } catch (err) { console.error('Accept friend error:', err); }
  });

  socket.on('declineFriendRequest', async (fromId) => {
    try {
      const user = await User.findByPk(currentUserId);
      if (!user) return;
      user.friendRequests = user.friendRequests.filter(id => id !== fromId);
      await user.save();
      socket.emit('requestDeclined', fromId);
    } catch (err) { console.error('Decline friend error:', err); }
  });

  socket.on('sendMessage', async ({ toId, text, image }) => {
    try {
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      if (!text?.trim() && !image) return;
      const me = await User.findByPk(currentUserId);
      const to = await User.findByPk(toId);
      if (!me || !to || !me.friends.includes(toId)) return;
      if (to.blockedUsers.includes(currentUserId) || me.blockedUsers.includes(toId)) return;

      const key = getChatKey(currentUserId, toId);
      const msg = await Message.create({
        chatKey:   key,
        from:      currentUserId,
        to:        toId,
        text:      text?.trim() || '',
        image:     image || null,
        type:      image ? 'image' : 'text'
      });

      const msgData = {
        _id:     msg.id,
        from:    currentUserId,
        text:    msg.text,
        image:   msg.image,
        type:    msg.type,
        time:    msg.createdAt.toISOString(),
        deleted: false
      };
      io.to(currentUserId).emit('newMessage', { chatWith: toId,           msg: msgData });
      io.to(toId).emit('newMessage',          { chatWith: currentUserId,  msg: msgData });
    } catch (err) { console.error('Send message error:', err); }
  });

  socket.on('markRead', async (friendId) => {
    try {
      if (!friendId) return;
      await Message.update(
        { read: true },
        { where: { chatKey: getChatKey(currentUserId, friendId), to: currentUserId, read: false } }
      );
    } catch (err) { console.error('Mark read error:', err); }
  });

  socket.on('disconnect', async () => {
    delete onlineUsers[currentUserId];
    if (expiryTimer) clearTimeout(expiryTimer);
    try {
      const user = await User.findByPk(currentUserId);
      if (user) user.friends.forEach(fId => io.to(fId).emit('friendOffline', currentUserId));
    } catch (err) { console.error('Disconnect error:', err); }
    console.log(`[offline] ${currentUserId}`);
  });
});

// ─── Запуск сервера ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  const connected = await connectWithRetry();

  if (connected) {
    try {
      await sequelize.sync({ alter: true });
      console.log('✅ Таблицы синхронизированы');
    } catch (err) {
      console.error('❌ Sync error:', err.message);
    }
  } else {
    console.warn('⚠️  Сервер запускается без подтверждённого подключения к БД.');
  }

  server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  });
})();

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});