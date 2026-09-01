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
const winston = require('winston');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const allowList = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!origin) return callback(null, true);
      if (allowList.length === 0 || allowList.includes(origin)) return callback(null, true);
      callback(new Error('CORS blocked'));
    },
    methods: ['GET', 'POST']
  }
});

app.set('trust proxy', 1);

// ─── Logging (Winston) ────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const SALT_ROUNDS = 12;

if (!process.env.JWT_SECRET) {
  logger.warn('⚠️  JWT_SECRET не задан в .env — используется дефолтный небезопасный секрет!');
}

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_FRIENDS         = 500;
const MAX_BLOCKED         = 200;
const MAX_FRIEND_REQUESTS = 200;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) * 1.37); // ~5 MB после base64-инфляции
// FIX #7: добавлены отсутствующие константы для валидации полей
const MAX_NICKNAME_LENGTH = 50;
const MAX_STATUS_LENGTH   = 150;
const MAX_BIO_LENGTH      = 1000;
const MAX_TEXT_LENGTH     = 4000;
const MAX_PASSWORD_LENGTH = 128; // FIX #8: bcrypt медленно хэширует строки >72 байт → потенциальный DoS

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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

const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: needsSSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  retry: { max: 3 }
});

async function connectWithRetry(retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sequelize.authenticate();
      logger.info('✅ PostgreSQL подключена');
      return true;
    } catch (err) {
      logger.error(`❌ PostgreSQL (попытка ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) await new Promise(res => setTimeout(res, delayMs));
    }
  }
  logger.error('❌ Не удалось подключиться к PostgreSQL после нескольких попыток');
  return false;
}

// ─── Models ───────────────────────────────────────────────────────────────────
const User = sequelize.define('User', {
  id: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
    // FIX #6: убран `lowercase: true` — это несуществующая опция Sequelize,
    // тихо игнорировалась; toLowerCase() делается на уровне обработчиков маршрутов
  },
  nickname: {
    type: DataTypes.STRING,
    allowNull: false
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
    type: DataTypes.STRING(150), // явная длина совпадает с MAX_STATUS_LENGTH
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
  underscored: true,
  tableName: 'users'
});

const Message = sequelize.define('Message', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chatKey: {
    type: DataTypes.STRING,
    allowNull: false
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
    // FIX #2 (КРИТИЧЕСКИЙ): было DataTypes.STRING → VARCHAR(255).
    // Base64 картинки весят мегабайты — поле молча обрезало их до 255 символов,
    // любое сообщение с изображением ломалось при записи в БД.
    type: DataTypes.TEXT,
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
  tableName: 'messages',
  indexes: [
    { fields: ['chat_key'] },
    { fields: ['created_at'] }
  ]
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const onlineUsers = {};
function getChatKey(a, b) { return [a, b].sort().join('::'); }

function deleteUploadedFile(publicPath) {
  if (!publicPath || typeof publicPath !== 'string') return;
  const filename = path.basename(publicPath);
  const fullPath = path.join(__dirname, 'uploads', filename);
  fs.unlink(fullPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.error('Ошибка удаления файла', { file: fullPath, error: err.message });
    }
  });
}

// FIX #5: добавлена периодическая очистка Map — в оригинале ключи (userId) накапливались
// вечно даже для давно неактивных пользователей → утечка памяти при большой аудитории
function makeSocketLimiter(maxPerWindow, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, arr] of hits) {
      if (arr.every(t => now - t >= windowMs)) hits.delete(key);
    }
  }, windowMs);
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= maxPerWindow;
  };
}
const canSendMessage      = makeSocketLimiter(20, 10_000);  // 20 сообщений / 10 сек
const canSendFriendRequest = makeSocketLimiter(10, 60_000); // 10 заявок / мин

setInterval(() => {
  const connectedSocketIds = new Set(io.sockets.sockets.keys());
  for (const [userId, socketId] of Object.entries(onlineUsers)) {
    if (!connectedSocketIds.has(socketId)) {
      delete onlineUsers[userId];
      logger.warn('Удалён протухший onlineUsers-запись', { userId }); // FIX #4: опечатка 'эатрая' → 'запись'
    }
  }
}, 60_000);

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
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif'
};

const storage = multer.diskStorage({
  destination: 'uploads/',
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
    const nick = (nickname || '').trim().slice(0, MAX_NICKNAME_LENGTH) || id;

    if (!id || id.length < 3)           return res.status(400).json({ error: 'ID минимум 3 символа' });
    if (id.length > 30)                 return res.status(400).json({ error: 'ID максимум 30 символов' });
    if (!/^[a-z0-9_]+$/.test(id))       return res.status(400).json({ error: 'ID: только a-z, 0-9, _' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    // FIX #8: очень длинный пароль заставляет bcrypt работать секунды → DoS
    if (password.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: `Пароль максимум ${MAX_PASSWORD_LENGTH} символов` });

    const exists = await User.findByPk(id);
    if (exists) return res.status(400).json({ error: 'Этот ID уже занят' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create({ id, nickname: nick, passwordHash, friends: [], friendRequests: [], blockedUsers: [] });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, friends: user.friends, friendRequests: user.friendRequests, blockedUsers: user.blockedUsers }
    });
  } catch (err) {
    logger.error('Register error', { error: err.message });
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
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, friends: user.friends, friendRequests: user.friendRequests, blockedUsers: user.blockedUsers }
    });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// ─── User Routes ──────────────────────────────────────────────────────────────
app.get('/api/search', authMiddleware, searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    // FIX #3: экранируем LIKE-метасимволы % и _ — без этого поиск "100%" находил
    // ВСЕХ пользователей, а "_va" находил "ova", "iva" и т.д. (работало как regexp)
    const escaped = q.toLowerCase()
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');

    const results = await User.findAll({
      where: {
        [Op.or]: [
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('id')),
            'LIKE',
            `%${escaped}%`
          ),
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('nickname')),
            'LIKE',
            `%${escaped}%`
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
    logger.error('Search error', { error: err.message });
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

app.get('/api/profile/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, online: !!onlineUsers[user.id], createdAt: user.createdAt });
  } catch (err) {
    logger.error('Profile error', { error: err.message });
    res.status(500).json({ error: 'Ошибка профиля' });
  }
});

app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { nickname, status, bio, avatar } = req.body;

    // FIX #7: валидация длины — раньше отсутствовала полностью
    if (nickname !== undefined && nickname.length > MAX_NICKNAME_LENGTH) {
      return res.status(400).json({ error: `Никнейм максимум ${MAX_NICKNAME_LENGTH} символов` });
    }
    if (status !== undefined && status.length > MAX_STATUS_LENGTH) {
      return res.status(400).json({ error: `Статус максимум ${MAX_STATUS_LENGTH} символов` });
    }
    if (bio !== undefined && bio.length > MAX_BIO_LENGTH) {
      return res.status(400).json({ error: `Описание максимум ${MAX_BIO_LENGTH} символов` });
    }
    if (avatar !== undefined && typeof avatar === 'string' && avatar.length > MAX_IMAGE_BASE64_CHARS) {
      return res.status(400).json({ error: 'Аватар слишком большой' });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (nickname !== undefined) user.nickname = nickname.trim();
    if (status   !== undefined) user.status   = status.trim();
    if (bio      !== undefined) user.bio      = bio.trim();
    if (avatar   !== undefined) user.avatar   = avatar;
    await user.save();

    res.json({ success: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio } });
  } catch (err) {
    logger.error('Profile update error', { error: err.message });
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

app.post('/api/upload/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const userId = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const user = await User.findByPk(userId);
    if (!user) {
      deleteUploadedFile(`/uploads/${req.file.filename}`);
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const oldAvatar = user.avatar;
    user.avatar = `/uploads/${req.file.filename}`;
    await user.save();

    if (oldAvatar) deleteUploadedFile(oldAvatar);

    res.json({ success: true, avatar: user.avatar });
  } catch (err) {
    logger.error('Avatar upload error', { error: err.message });
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
      if (me.blockedUsers.length >= MAX_BLOCKED) {
        return res.status(400).json({ error: `Лимит заблокированных пользователей (${MAX_BLOCKED})` });
      }
      me.blockedUsers    = [...me.blockedUsers, targetId];
      me.friends         = me.friends.filter(id => id !== targetId);
      me.friendRequests  = me.friendRequests.filter(id => id !== targetId);
      await me.save();
    }

    const target = await User.findByPk(targetId);
    if (target) {
      const hadFriend  = target.friends.includes(me.id);
      const hadRequest = target.friendRequests.includes(me.id);
      if (hadFriend || hadRequest) {
        if (hadFriend)  target.friends        = target.friends.filter(id => id !== me.id);
        if (hadRequest) target.friendRequests = target.friendRequests.filter(id => id !== me.id);
        await target.save();
        io.to(targetId).emit('friendRemoved', { id: me.id });
      }
    }

    res.json({ success: true, blockedUsers: me.blockedUsers });
  } catch (err) {
    logger.error('Block error', { error: err.message });
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
    logger.error('Unblock error', { error: err.message });
    res.status(500).json({ error: 'Ошибка разблокировки' });
  }
});

app.get('/api/users/blocked', authMiddleware, async (req, res) => {
  try {
    const me = await User.findByPk(req.user.id);
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!me.blockedUsers.length) return res.json([]);

    const users = await User.findAll({ where: { id: { [Op.in]: me.blockedUsers } } });
    res.json(users.map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar })));
  } catch (err) {
    logger.error('Blocked list error', { error: err.message });
    res.status(500).json({ error: 'Ошибка загрузки списка заблокированных' });
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

    const key   = getChatKey(req.params.userId, req.params.friendId);
    const where = { chatKey: key };
    if (before) where.createdAt = { [Op.lt]: new Date(before) };

    const messages = await Message.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: limitNum
    });

    res.json(messages.reverse().map(m => ({
      _id:     m.id,
      from:    m.from,
      to:      m.to,
      text:    m.text,
      image:   m.image,
      type:    m.type,
      deleted: m.deleted,
      time:    m.createdAt.toISOString()
    })));
  } catch (err) {
    logger.error('Messages error', { error: err.message });
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

// ─── Delete Message ───────────────────────────────────────────────────────────
app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const userId    = req.user.id;
    const messageId = req.params.messageId;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId || '');
    if (!isUuid) return res.status(400).json({ error: 'Некорректный ID сообщения' });

    const msg = await Message.findByPk(messageId);
    if (!msg)                return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.from !== userId) return res.status(403).json({ error: 'Нет доступа' });

    const imageToDelete = msg.image;
    msg.deleted = true;
    msg.text    = '';
    msg.image   = null;
    await msg.save();

    if (imageToDelete) deleteUploadedFile(imageToDelete);

    const otherUser = msg.chatKey.split('::').find(id => id !== userId);
    io.to(userId).emit('messageDeleted', { messageId, chatWith: otherUser || null });
    if (otherUser) io.to(otherUser).emit('messageDeleted', { messageId, chatWith: userId });

    res.json({ success: true });
  } catch (err) {
    logger.error('Delete message error', { error: err.message });
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

  let expiryTimer = null;
  if (socket.user.exp) {
    const msUntilExpiry = socket.user.exp * 1000 - Date.now();
    expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(msUntilExpiry, 0));
  }

  // ── FIX #1 (КРИТИЧЕСКИЙ): онлайн-статус регистрируем СИНХРОННО, до любого await ──
  //
  // В оригинале эти строки стояли внутри async IIFE после await User.findByPk().
  // Это вызывало гонку при переподключении (обновление страницы / reconnect):
  //
  //   Без фикса:
  //   1. socket_new подключается → IIFE запускается, await ещё не завершён
  //   2. socket_old дисконнектится → delete onlineUsers[userId]  ← нет записи, ок
  //   3. IIFE socket_new завершается → onlineUsers[userId] = socket_new.id  ← ОК,
  //      НО если шаги 2 и 3 меняются местами (сеть, нагрузка):
  //   1. socket_new IIFE завершается → onlineUsers[userId] = socket_new.id
  //   2. socket_old дисконнектится → delete onlineUsers[userId]  ← удаляет запись НОВОГО сокета!
  //   → пользователь подключён, но onlineUsers пуст → все видят «оффлайн»
  //
  //   С фиксом:
  //   1. socket_new подключается → onlineUsers[userId] = socket_new.id  (SYNC)
  //   2. socket_old дисконнектится → onlineUsers[userId] === socket_old.id? НЕТ → выходим
  //   → запись нового сокета сохранена, пользователь корректно онлайн
  onlineUsers[currentUserId] = socket.id;
  socket.join(currentUserId);

  (async () => {
    try {
      const user = await User.findByPk(currentUserId);
      if (!user) {
        // Удаляем только если запись всё ещё наша (другой сокет мог уже подключиться)
        if (onlineUsers[currentUserId] === socket.id) delete onlineUsers[currentUserId];
        return socket.disconnect();
      }

      user.friends.forEach(fId => io.to(fId).emit('friendOnline', { id: currentUserId, nickname: user.nickname }));

      const unreadRows = await Message.findAll({
        where: { to: currentUserId, read: false, deleted: false },
        attributes: ['from', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
        group: ['from']
      });
      const unreadCounts = Object.fromEntries(
        unreadRows.map(r => [r.from, parseInt(r.get('count'), 10)])
      );

      socket.emit('profile', {
        id:             user.id,
        nickname:       user.nickname,
        avatar:         user.avatar,
        status:         user.status,
        bio:            user.bio,
        friends:        user.friends,
        friendRequests: user.friendRequests,
        blockedUsers:   user.blockedUsers,
        unreadCounts
      });
      logger.info(`[online] ${currentUserId}`);
    } catch (err) { logger.error('Connection init error', { error: err.message }); }
  })();

  // ─── Friend Requests ───────────────────────────────────────────────────────
  socket.on('sendFriendRequest', async (toId) => {
    try {
      if (!canSendFriendRequest(currentUserId)) {
        return socket.emit('friendRequestError', { toId, reason: 'rate_limited' });
      }
      // FIX: валидация типа toId
      if (!toId || typeof toId !== 'string') {
        return socket.emit('friendRequestError', { toId, reason: 'not_found' });
      }
      if (toId === currentUserId) return socket.emit('friendRequestError', { toId, reason: 'self' });

      const from = await User.findByPk(currentUserId);
      if (!from) return;
      if (from.friends.length >= MAX_FRIENDS) {
        return socket.emit('friendRequestError', { toId, reason: 'limit_reached' });
      }

      const to = await User.findByPk(toId);
      if (!to)                                    return socket.emit('friendRequestError', { toId, reason: 'not_found' });
      if (to.friends.includes(currentUserId))     return socket.emit('friendRequestError', { toId, reason: 'already_friends' });
      if (to.friendRequests.includes(currentUserId)) return socket.emit('friendRequestError', { toId, reason: 'already_sent' });
      if (to.blockedUsers.includes(currentUserId))   return socket.emit('friendRequestError', { toId, reason: 'blocked' });
      if (from.blockedUsers.includes(toId))          return socket.emit('friendRequestError', { toId, reason: 'blocked' });
      if (to.friendRequests.length >= MAX_FRIEND_REQUESTS) return socket.emit('friendRequestError', { toId, reason: 'target_limit_reached' });

      const affected = await sequelize.query(`
        UPDATE "users"
        SET friend_requests = array_append(friend_requests, :fromId)
        WHERE id = :toId
          AND NOT (:fromId = ANY(friend_requests))
          AND NOT (:fromId = ANY(friends))
          AND NOT (:fromId = ANY(blocked_users))
          AND array_length(friend_requests, 1) IS DISTINCT FROM :maxRequests
        RETURNING id
      `, {
        replacements: { fromId: currentUserId, toId, maxRequests: MAX_FRIEND_REQUESTS },
        type: sequelize.QueryTypes.SELECT
      });

      if (!affected || !affected.length) return socket.emit('friendRequestError', { toId, reason: 'already_sent' });

      io.to(toId).emit('friendRequest', { id: currentUserId, nickname: from.nickname });
      socket.emit('requestSent', { id: toId });
    } catch (err) {
      logger.error('Friend request error', { error: err.message });
      socket.emit('friendRequestError', { toId, reason: 'server_error' });
    }
  });

  socket.on('acceptFriendRequest', async (fromId) => {
    try {
      if (!fromId) return;

      const meResult = await sequelize.query(`
        UPDATE "users"
        SET friend_requests = array_remove(friend_requests, :fromId),
            friends = CASE
              WHEN :fromId = ANY(friends) THEN friends
              ELSE array_append(friends, :fromId)
            END
        WHERE id = :myId
          AND :fromId = ANY(friend_requests)
        RETURNING id, nickname, avatar
      `, { replacements: { fromId, myId: currentUserId }, type: sequelize.QueryTypes.SELECT });

      if (!meResult || !meResult.length) return;

      const themResult = await sequelize.query(`
        UPDATE "users"
        SET friends = CASE
              WHEN :myId = ANY(friends) THEN friends
              ELSE array_append(friends, :myId)
            END
        WHERE id = :fromId
        RETURNING id, nickname, avatar
      `, { replacements: { fromId, myId: currentUserId }, type: sequelize.QueryTypes.SELECT });

      if (!themResult || !themResult.length) return;

      const me   = meResult[0];
      const them = themResult[0];

      socket.emit('friendAdded',        { id: fromId,        nickname: them.nickname, avatar: them.avatar, online: !!onlineUsers[fromId] });
      io.to(fromId).emit('friendAdded', { id: currentUserId, nickname: me.nickname,   avatar: me.avatar,   online: true });
    } catch (err) { logger.error('Accept friend error', { error: err.message }); }
  });

  socket.on('declineFriendRequest', async (fromId) => {
    try {
      const user = await User.findByPk(currentUserId);
      if (!user) return;
      user.friendRequests = user.friendRequests.filter(id => id !== fromId);
      await user.save();
      socket.emit('requestDeclined', fromId);
    } catch (err) { logger.error('Decline friend error', { error: err.message }); }
  });

  // FIX #9: добавлен отсутствующий обработчик removeFriend.
  // В оригинале убрать друга без блокировки было невозможно.
  socket.on('removeFriend', async (friendId) => {
    try {
      if (!friendId || typeof friendId !== 'string') return;

      // Атомарный UPDATE: убираем friendId из нашего списка только если он там есть
      const result = await sequelize.query(`
        UPDATE "users"
        SET friends = array_remove(friends, :friendId)
        WHERE id = :myId AND :friendId = ANY(friends)
        RETURNING id
      `, { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.SELECT });

      if (!result || !result.length) return; // и так не друзья

      // Симметрично убираем себя из его списка
      await sequelize.query(`
        UPDATE "users"
        SET friends = array_remove(friends, :myId)
        WHERE id = :friendId
      `, { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.UPDATE });

      socket.emit('friendRemoved',          { id: friendId });
      io.to(friendId).emit('friendRemoved', { id: currentUserId });
    } catch (err) { logger.error('Remove friend error', { error: err.message }); }
  });

  // ─── Messages ─────────────────────────────────────────────────────────────
  socket.on('sendMessage', async ({ toId, text, image }) => {
    try {
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      if (!text?.trim() && !image) return;

      // FIX #7: валидация длины текста
      if (text && text.trim().length > MAX_TEXT_LENGTH) {
        return socket.emit('sendMessageError', { toId, reason: 'text_too_long' });
      }
      if (image && typeof image === 'string' && image.length > MAX_IMAGE_BASE64_CHARS) {
        return socket.emit('sendMessageError', { toId, reason: 'image_too_large' });
      }

      const me = await User.findByPk(currentUserId);
      const to = await User.findByPk(toId);
      if (!me || !to || !me.friends.includes(toId)) return;
      if (to.blockedUsers.includes(currentUserId) || me.blockedUsers.includes(toId)) return;

      const key = getChatKey(currentUserId, toId);
      const msg = await Message.create({
        chatKey: key,
        from:    currentUserId,
        to:      toId,
        text:    text?.trim() || '',
        image:   image || null,
        type:    image ? 'image' : 'text'
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
      io.to(currentUserId).emit('newMessage', { chatWith: toId,          msg: msgData });
      io.to(toId).emit('newMessage',          { chatWith: currentUserId, msg: msgData });
    } catch (err) { logger.error('Send message error', { error: err.message }); }
  });

  socket.on('markRead', async (friendId) => {
    try {
      if (!friendId) return;
      await Message.update(
        { read: true },
        { where: { chatKey: getChatKey(currentUserId, friendId), to: currentUserId, read: false } }
      );
    } catch (err) { logger.error('Mark read error', { error: err.message }); }
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    if (expiryTimer) clearTimeout(expiryTimer);

    // FIX #1 (продолжение): проверяем, что отключается именно тот сокет,
    // который сейчас зарегистрирован как активный для данного пользователя.
    // Если socketId уже другой — новый сокет успел подключиться раньше;
    // выходим без изменений, чтобы не затереть его запись в onlineUsers.
    if (onlineUsers[currentUserId] !== socket.id) {
      logger.info(`[socket superseded, not marking offline] ${currentUserId}`);
      return;
    }

    delete onlineUsers[currentUserId];
    try {
      const user = await User.findByPk(currentUserId);
      if (user) user.friends.forEach(fId => io.to(fId).emit('friendOffline', currentUserId));
    } catch (err) { logger.error('Disconnect error', { error: err.message }); }
    logger.info(`[offline] ${currentUserId}`);
  });
});

// ─── Запуск сервера ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  const connected = await connectWithRetry();

  if (connected) {
    try {
      await sequelize.sync({ alter: true });
      logger.info('✅ Таблицы синхронизированы');
    } catch (err) {
      logger.error('❌ Sync error', { error: err.message });
    }
  } else {
    logger.warn('⚠️  Сервер запускается без подтверждённого подключения к БД.');
  }

  server.listen(PORT, () => {
    logger.info(`✅ Сервер запущен на http://localhost:${PORT}`);
  });
})();

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: err?.message || String(err) });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Получен ${signal}, начинаю штатную остановку сервера...`);

  io.close();

  server.close(async () => {
    try {
      await sequelize.close();
      logger.info('Соединение с БД закрыто, выход.');
      process.exit(0);
    } catch (err) {
      logger.error('Ошибка при закрытии БД', { error: err.message });
      process.exit(1);
    }
  });

  setTimeout(() => {
    logger.error('Не удалось завершить работу штатно за 30с, принудительный выход.');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));