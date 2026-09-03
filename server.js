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
const crypto = require('crypto');
// FIX #2.1: HTTP security headers. Требуется: npm i helmet
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);

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

const corsAllowList = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean);
if (corsAllowList.length === 0) {
  logger.warn('⚠️  CLIENT_URL не задан — CORS разрешает ЛЮБОЙ origin! (нормально только для локальной разработки)');
}

const JWTSECRET = process.env.JWTSECRET || 'changethissecretinproduction';
const SALT_ROUNDS = 12;

if (!process.env.JWT_SECRET) {
  logger.warn('⚠️  JWT_SECRET не задан — используется дефолтный небезопасный секрет! (нормально только для локальной разработки)');
}

if (process.env.NODE_ENV === 'production') {
  const missingEnv = [];
  if (!process.env.JWTSECRET) missingEnv.push('JWTSECRET');
  if (corsAllowList.length === 0) missingEnv.push('CLIENT_URL');
  if (missingEnv.length) {
    logger.error(❌ В production обязательны переменные окружения: ${missingEnv.join(', ')}. Задайте их в настройках Render (Environment) и передеплойте. Остановка запуска.);
    process.exit(1);
  }
}

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_FRIENDS         = 500;
const MAX_BLOCKED         = 200;
const MAXFRIENDREQUESTS = 200;
const MAXGROUPMEMBERS   = 50;
const MAXGROUPSPER_USER = 100;
// FIX #2.5: base64 раздувает данные ровно в 4/3 ≈ 1.3334 раза (раньше было 1.37 — завышено)
const MAXIMAGEBASE64_CHARS = Math.ceil((5  1024  1024) * (4 / 3));
const MAXNICKNAMELENGTH = 50;
const MAXSTATUSLENGTH   = 150;
const MAXBIOLENGTH      = 1000;
const MAXTEXTLENGTH     = 4000;
const MAXPASSWORDLENGTH = 128;
const MAXGROUPNAME_LENGTH = 50;

// FIX #2.3: единый формат UUID для валидации groupId во всех обработчиках
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsAllowList.length === 0 || corsAllowList.includes(origin)) return callback(null, true);
      callback(new Error('CORS blocked'));
    },
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: MAXIMAGEBASE64CHARS + 100000
});

app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
// FIX #2.1: helmet. CSP отключён, т.к. index.html содержит inline-
// (анти-мигание сессии) и грузит шрифты с Google Fonts — дефолтный CSP это ломает.
// Остальные security-заголовки (X-Content-Type-Options, HSTS и т.д.) остаются.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// FIX #4.6: requestId для трассировки запросов в логах
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(dirname, 'public')));
app.use('/uploads', express.static(path.join(dirname, 'uploads')));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// FIX #2.4 (документация): express-rate-limit и makeSocketLimiter хранят счётчики
// В ПАМЯТИ ПРОЦЕССА. При горизонтальном масштабировании (несколько инстансов/воркеров)
// лимиты будут применяться к каждому инстансу отдельно и суммарно станут в N раз мягче.
// Для production с несколькими воркерами подключить общий store:
//   const { RedisStore } = require('rate-limit-redis');
//   const { createClient } = require('redis');
//   const client = createClient({ url: process.env.REDIS_URL });
//   await client.connect();
//   rateLimit({ ..., store: new RedisStore({ sendCommand: (...a) => client.sendCommand(a) }) })
// Сейчас приложение работает в один процесс — оставляем in-memory.
const authLimiter = rateLimit({
  windowMs: 15  60  1000,
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
const isInternalRenderUrl = /@dpg-[^.]+-a(:\d+)?\//.test(dbUrl);
const needsSSL = process.env.NODE_ENV === 'production' && !isInternalRenderUrl;

const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: needsSSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  retry: { max: 3 }
});

// FIX #3.4: экспоненциальный backoff с jitter вместо постоянной задержки
async function connectWithRetry(retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt  setTimeout(res, backoff));
      }
    }
  }
  logger.error('❌ Не удалось подключиться к PostgreSQL после нескольких попыток');
  return false;
}

// ─── Models ───────────────────────────────────────────────────────────────────
const User = sequelize.define('User', {
  id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
  nickname: { type: DataTypes.STRING, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  avatar: { type: DataTypes.STRING, defaultValue: null },
  status: { type: DataTypes.STRING(150), defaultValue: 'Привет! Я использую ChatApp' },
  bio: { type: DataTypes.TEXT, defaultValue: '' },
  friends: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  friendRequests: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  blockedUsers: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] }
}, { timestamps: true, underscored: true, tableName: 'users' });

const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  chatKey: { type: DataTypes.STRING, allowNull: true },
  groupId: { type: DataTypes.UUID, allowNull: true },
  from: { type: DataTypes.STRING, allowNull: false },
  to: { type: DataTypes.STRING, allowNull: true },
  text: { type: DataTypes.TEXT, defaultValue: '' },
  image: { type: DataTypes.TEXT, defaultValue: null },
  type: { type: DataTypes.ENUM('text', 'image'), defaultValue: 'text' },
  read: { type: DataTypes.BOOLEAN, defaultValue: false },
  deleted: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
  timestamps: true, underscored: true, tableName: 'messages',
  indexes: [
    { fields: ['chat_key'] },
    { fields: ['group_id'] },
    { fields: ['created_at'] },
    // FIX #4.5: индексы по полям, используемым в WHERE (unread-подсчёты, история)
    { fields: ['from'] },
    { fields: ['to'] },
    { fields: ['read'] }
  ]
});

const Group = sequelize.define('Group', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(MAXGROUPNAME_LENGTH), allowNull: false },
  avatar: { type: DataTypes.STRING, defaultValue: null },
  ownerId: { type: DataTypes.STRING, allowNull: false }
}, { timestamps: true, underscored: true, tableName: 'groups' });

const GroupMember = sequelize.define('GroupMember', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  groupId: { type: DataTypes.UUID, allowNull: false },
  userId: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.ENUM('owner', 'member'), defaultValue: 'member' }
}, {
  timestamps: true, underscored: true, tableName: 'group_members',
  indexes: [
    { unique: true, fields: ['groupid', 'userid'] },
    { fields: ['user_id'] }
  ]
});

Group.hasMany(GroupMember, { foreignKey: 'groupId', onDelete: 'CASCADE' });
GroupMember.belongsTo(Group, { foreignKey: 'groupId' });
GroupMember.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(GroupMember, { foreignKey: 'userId' });

// ─── Helpers ──────────────────────────────────────────────────────────────────
const onlineUsers = {}; // userId -> Set

function markOnline(userId, socketId) {
  if (!onlineUsers[userId]) onlineUsers[userId] = new Set();
  const wasOffline = onlineUsers[userId].size === 0;
  onlineUsers[userId].add(socketId);
  return wasOffline;
}

function markOffline(userId, socketId) {
  const set = onlineUsers[userId];
  if (!set) return false;
  set.delete(socketId);
  const becameOffline = set.size === 0;
  if (becameOffline) delete onlineUsers[userId];
  return becameOffline;
}

function isOnline(userId) {
  return !!(onlineUsers[userId] && onlineUsers[userId].size > 0);
}

function getChatKey(a, b) { return [a, b].sort().join('::'); }

// FIX #4.1: async/await вместо callback — единообразно с остальным кодом
async function deleteUploadedFile(publicPath) {
  if (!publicPath || typeof publicPath !== 'string') return;
  const fullPath = path.join(dirname, 'uploads', path.basename(publicPath));
  try {
    await fs.promises.unlink(fullPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error('Ошибка удаления файла', { file: fullPath, error: err.message });
    }
  }
}

const AVATARPATHRE = /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

// FIX #2.4: см. комментарий у rateLimit выше — in-memory, не работает при масштабировании
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
    const arr = (hits.get(key) || []).filter(t => now - t  {
  const connectedSocketIds = new Set(io.sockets.sockets.keys());
  for (const [userId, socketIds] of Object.entries(onlineUsers)) {
    for (const sid of socketIds) {
      if (!connectedSocketIds.has(sid)) socketIds.delete(sid);
    }
    if (socketIds.size === 0) delete onlineUsers[userId];
  }
}, 60_000);

// ─── Group room helpers (FIX #3.3) ────────────────────────────────────────────
// Set групп хранится НА СОКЕТЕ (socket.groupIds) и заполняется при подключении,
// чтобы groupMessage/markGroupRead не ходили в БД на каждое сообщение.
// Обновляется в addGroupMember / leaveGroup / kickGroupMember / groupDeleted.
function joinUserToGroupRoom(userId, groupId) {
  const sids = onlineUsers[userId];
  if (!sids) return;
  for (const sid of sids) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.join(group:${groupId});
      if (s.groupIds) s.groupIds.add(groupId);
    }
  }
}

function leaveUserFromGroupRoom(userId, groupId) {
  const sids = onlineUsers[userId];
  if (!sids) return;
  for (const sid of sids) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.leave(group:${groupId});
      if (s.groupIds) s.groupIds.delete(groupId);
    }
  }
}

// ─── JWT Auth Middleware ──────────────────────────────────────────────────────
// FIX #2.2: короткий in-memory кэш существования пользователя, чтобы JWT удалённого
// пользователя не оставался валидным до истечения срока. TTL 30с — компромисс между
// безопасностью и нагрузкой на БД (негативный кэш — 5с).
const userExistCache = new Map(); // userId -> { ok, exp }
const USEREXISTCACHETTL = 30000;

async function userExists(id) {
  const now = Date.now();
  const hit = userExistCache.get(id);
  if (hit && hit.exp > now) return hit.ok;
  const u = await User.findByPk(id);
  const ok = !!u;
  userExistCache.set(id, { ok, exp: now + (ok ? USEREXISTCACHETTL : 5000) });
  if (userExistCache.size > 10_000) userExistCache.clear(); // защита от переполнения
  return ok;
}

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
  if (!(await userExists(req.user.id))) {
    return res.status(401).json({ error: 'Пользователь не найден' });
  }
  next();
}

// ─── File Upload ──────────────────────────────────────────────────────────────
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const EXTBYMIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif'
};

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + (EXTBYMIME[file.mimetype] || ''))
});

const upload = multer({
  storage,
  limits: { fileSize: 5  1024  1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения (jpeg, png, webp, gif)'));
  }
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { userId, nickname, password } = req.body;
    const id   = (typeof userId === 'string' ? userId : '').trim().toLowerCase();
    const nick = (typeof nickname === 'string' ? nickname : '').trim().slice(0, MAXNICKNAMELENGTH) || id;

    if (!id || id.length  30)                 return res.status(400).json({ error: 'ID максимум 30 символов' });
    if (!/^[a-z0-9]+$/.test(id))       return res.status(400).json({ error: 'ID: только a-z, 0-9, ' });
    if (typeof password !== 'string' || password.length  MAXPASSWORDLENGTH) return res.status(400).json({ error: Пароль максимум ${MAXPASSWORDLENGTH} символов });

    const exists = await User.findByPk(id);
    if (exists) return res.status(400).json({ error: 'Этот ID уже занят' });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create({ id, nickname: nick, passwordHash, friends: [], friendRequests: [], blockedUsers: [] });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true, token,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, friends: user.friends, friendRequests: user.friendRequests, blockedUsers: user.blockedUsers }
    });
  } catch (err) {
    logger.error('Register error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

const DUMMYPASSWORDHASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKNjM4YFf6/EHou';

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { userId, password } = req.body;
    const id = (typeof userId === 'string' ? userId : '').trim().toLowerCase();

    if (typeof password !== 'string' || password.length > MAXPASSWORDLENGTH) {
      return res.status(401).json({ error: 'Неверный ID или пароль' });
    }

    const user  = await User.findByPk(id);
    const match = await bcrypt.compare(password, user ? user.passwordHash : DUMMYPASSWORDHASH);
    if (!user || !match) return res.status(401).json({ error: 'Неверный ID или пароль' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true, token,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, friends: user.friends, friendRequests: user.friendRequests, blockedUsers: user.blockedUsers }
    });
  } catch (err) {
    logger.error('Login error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// ─── User Routes ──────────────────────────────────────────────────────────────
app.get('/api/search', authMiddleware, searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const escaped = q.toLowerCase().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(//g, '\\');
    const results = await User.findAll({
      where: {
        [Op.or]: [
          sequelize.where(sequelize.fn('LOWER', sequelize.col('id')), 'LIKE', %${escaped}%),
          sequelize.where(sequelize.fn('LOWER', sequelize.col('nickname')), 'LIKE', %${escaped}%)
        ]
      },
      limit: 10
    });
    res.json(results.map(u => ({
      id: u.id, nickname: u.nickname, avatar: u.avatar, status: u.status, online: isOnline(u.id)
    })));
  } catch (err) {
    logger.error('Search error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

app.get('/api/profile/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, online: isOnline(user.id), createdAt: user.createdAt });
  } catch (err) {
    logger.error('Profile error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка профиля' });
  }
});

app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { nickname, status, bio, avatar } = req.body;

    if (nickname !== undefined && (typeof nickname !== 'string' || nickname.length > MAXNICKNAMELENGTH)) {
      return res.status(400).json({ error: Никнейм максимум ${MAXNICKNAMELENGTH} символов });
    }
    // FIX #5: пустой никнейм после trim больше не сохраняется
    if (nickname !== undefined && nickname.trim().length === 0) {
      return res.status(400).json({ error: 'Никнейм не может быть пустым' });
    }
    if (status !== undefined && (typeof status !== 'string' || status.length > MAXSTATUSLENGTH)) {
      return res.status(400).json({ error: Статус максимум ${MAXSTATUSLENGTH} символов });
    }
    if (bio !== undefined && (typeof bio !== 'string' || bio.length > MAXBIOLENGTH)) {
      return res.status(400).json({ error: Описание максимум ${MAXBIOLENGTH} символов });
    }
    if (avatar !== undefined && avatar !== null && !(typeof avatar === 'string' && AVATARPATHRE.test(avatar))) {
      return res.status(400).json({ error: 'Аватар можно изменить только через загрузку файла' });
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
    logger.error('Profile update error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

app.post('/api/upload/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const userId = req.user.id;
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const user = await User.findByPk(userId);
    if (!user) {
      await deleteUploadedFile(/uploads/${req.file.filename});
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    const oldAvatar = user.avatar;
    user.avatar = /uploads/${req.file.filename};
    await user.save();
    if (oldAvatar) await deleteUploadedFile(oldAvatar);
    res.json({ success: true, avatar: user.avatar });
  } catch (err) {
    logger.error('Avatar upload error', { requestId: req.requestId, error: err.message, stack: err.stack });
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
        return res.status(400).json({ error: Лимит заблокированных (${MAX_BLOCKED}) });
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
    logger.error('Block error', { requestId: req.requestId, error: err.message, stack: err.stack });
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
    logger.error('Unblock error', { requestId: req.requestId, error: err.message, stack: err.stack });
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
    logger.error('Blocked list error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки списка заблокированных' });
  }
});

// ─── DM Message Routes ────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:friendId', authMiddleware, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId) return res.status(403).json({ error: 'Нет доступа' });

    // FIX #5: история доступна только между друзьями
    const meUser = await User.findByPk(req.user.id, { attributes: ['id', 'friends'] });
    if (!meUser || !meUser.friends.includes(req.params.friendId)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const { before, limit = 50 } = req.query;
    const parsedLimit = parseInt(limit, 10);
    const limitNum = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 50));
    const key   = getChatKey(req.params.userId, req.params.friendId);
    const where = { chatKey: key, groupId: null };
    if (before) {
      const beforeDate = new Date(before);
      if (Number.isNaN(beforeDate.getTime())) return res.status(400).json({ error: 'Некорректный параметр before' });
      where.createdAt = { [Op.lt]: beforeDate };
    }
    const messages = await Message.findAll({ where, order: [['createdAt', 'DESC']], limit: limitNum });
    res.json(messages.reverse().map(m => ({
      _id: m.id, from: m.from, to: m.to, text: m.text, image: m.image,
      type: m.type, deleted: m.deleted, time: m.createdAt.toISOString()
    })));
  } catch (err) {
    logger.error('Messages error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const userId    = req.user.id;
    const messageId = req.params.messageId;
    const isUuid = UUID_RE.test(messageId || '');
    if (!isUuid) return res.status(400).json({ error: 'Некорректный ID сообщения' });

    const msg = await Message.findByPk(messageId);
    if (!msg)                return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.from !== userId) return res.status(403).json({ error: 'Нет доступа' });

    const imageToDelete = msg.image;
    msg.deleted = true;
    msg.text    = '';
    msg.image   = null;
    await msg.save();
    if (imageToDelete) await deleteUploadedFile(imageToDelete);

    if (msg.groupId) {
      const members = await GroupMember.findAll({ where: { groupId: msg.groupId } });
      members.forEach(m => {
        io.to(m.userId).emit('messageDeleted', { messageId, chatWith: null, groupId: msg.groupId });
      });
    } else {
      const otherUser = msg.chatKey.split('::').find(id => id !== userId);
      io.to(userId).emit('messageDeleted', { messageId, chatWith: otherUser || null });
      if (otherUser) io.to(otherUser).emit('messageDeleted', { messageId, chatWith: userId });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error('Delete message error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ─── Groups API ───────────────────────────────────────────────────────────────
app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, memberIds } = req.body;
    const userId = req.user.id;

    if (!name || typeof name !== 'string' || name.trim().length  MAXGROUPNAME_LENGTH) {
      return res.status(400).json({ error: Название группы максимум ${MAXGROUPNAME_LENGTH} символов });
    }
    if (!Array.isArray(memberIds)) {
      return res.status(400).json({ error: 'Некорректный список участников' });
    }

    const uniqueMembers = [...new Set([userId, ...memberIds.filter(id => typeof id === 'string')])];
    if (uniqueMembers.length  MAXGROUPMEMBERS) return res.status(400).json({ error: Максимум ${MAXGROUPMEMBERS} участников });

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const groupCount = await GroupMember.count({ where: { userId } });
    if (groupCount >= MAXGROUPSPER_USER) {
      return res.status(400).json({ error: Максимум ${MAXGROUPSPER_USER} групп });
    }

    // FIX #4.4: Set вместо includes в цикле — O(N+M) вместо O(N*M)
    const friendSet = new Set(user.friends);
    for (const memberId of memberIds) {
      if (memberId === userId) continue;
      if (!friendSet.has(memberId)) {
        return res.status(400).json({ error: Пользователь ${memberId} не в друзьях });
      }
    }

    const transaction = await sequelize.transaction();
    try {
      const group = await Group.create({ name: name.trim(), ownerId: userId }, { transaction });

      const members = uniqueMembers.map(id => ({
        groupId: group.id,
        userId: id,
        role: id === userId ? 'owner' : 'member'
      }));
      await GroupMember.bulkCreate(members, { transaction, ignoreDuplicates: true });
      await transaction.commit();

      for (const memberId of uniqueMembers) {
        if (memberId !== userId) joinUserToGroupRoom(memberId, group.id);
      }
      // Участники подтянут актуальные данные через свой loadGroups/addedToGroup
      for (const memberId of uniqueMembers) {
        if (memberId !== userId) io.to(memberId).emit('addedToGroup', { groupId: group.id });
      }

      const groupData = await getGroupWithMembers(group.id);
      res.json({ success: true, group: groupData });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    logger.error('Create group error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка создания группы' });
  }
});

// FIX #3.1: вместо N+1 (по 2 запроса на группу) — 2 запроса суммарно:
// 1) страницы групп пользователя, 2) ВСЕ участники этих групп одним запросом.
// FIX #5: лимит + пагинация.
app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const myMemberships = await GroupMember.findAll({
      where: { userId },
      include: [{ model: Group }],
      order: [[Group, 'createdAt', 'DESC']],
      limit,
      offset
    });
    if (!myMemberships.length) return res.json([]);

    const groupIds = myMemberships.map(m => m.Group.id);
    const allMembers = await GroupMember.findAll({
      where: { groupId: { [Op.in]: groupIds } },
      include: [{ model: User, attributes: ['id', 'nickname', 'avatar'] }]
    });

    const membersByGroup = {};
    for (const row of allMembers) {
      if (!membersByGroup[row.groupId]) membersByGroup[row.groupId] = [];
      membersByGroup[row.groupId].push({
        id: row.User.id,
        nickname: row.User.nickname,
        avatar: row.User.avatar,
        online: isOnline(row.User.id),
        role: row.role
      });
    }

    const result = myMemberships.map(m => ({
      id: m.Group.id,
      name: m.Group.name,
      avatar: m.Group.avatar,
      ownerId: m.Group.ownerId,
      createdAt: m.Group.createdAt,
      members: membersByGroup[m.Group.id] || []
    }));

    res.json(result);
  } catch (err) {
    logger.error('Get groups error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки групп' });
  }
});

// FIX #4.2: переименование группы (только владелец)
app.patch('/api/groups/:groupId', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ error: 'Некорректный ID группы' });
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length  MAXGROUPNAME_LENGTH) {
      return res.status(400).json({ error: Название группы максимум ${MAXGROUPNAME_LENGTH} символов });
    }

    const group = await Group.findByPk(groupId);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    if (group.ownerId !== req.user.id) return res.status(403).json({ error: 'Только владелец может переименовывать группу' });

    group.name = name.trim();
    await group.save();

    io.to(group:${groupId}).emit('groupUpdated', { groupId, name: group.name });
    res.json({ success: true, group: { id: group.id, name: group.name, avatar: group.avatar, ownerId: group.ownerId } });
  } catch (err) {
    logger.error('Rename group error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка переименования группы' });
  }
});

// FIX #4.3: аватар группы (только владелец)
app.post('/api/groups/:groupId/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ error: 'Некорректный ID группы' });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const group = await Group.findByPk(groupId);
    if (!group) {
      await deleteUploadedFile(/uploads/${req.file.filename});
      return res.status(404).json({ error: 'Группа не найдена' });
    }
    if (group.ownerId !== req.user.id) {
      await deleteUploadedFile(/uploads/${req.file.filename});
      return res.status(403).json({ error: 'Только владелец может менять аватар группы' });
    }

    const oldAvatar = group.avatar;
    group.avatar = /uploads/${req.file.filename};
    await group.save();
    if (oldAvatar) await deleteUploadedFile(oldAvatar);

    io.to(group:${groupId}).emit('groupUpdated', { groupId, name: group.name, avatar: group.avatar });
    res.json({ success: true, avatar: group.avatar });
  } catch (err) {
    logger.error('Group avatar upload error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки аватара группы' });
  }
});

app.get('/api/groups/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ error: 'Некорректный ID группы' });
    const { before, limit = 50 } = req.query;

    if (!(await isGroupMember(userId, groupId))) {
      return res.status(403).json({ error: 'Вы не участник группы' });
    }

    const parsedLimit = parseInt(limit, 10);
    const limitNum = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 50));

    const where = { groupId };
    if (before) {
      const beforeDate = new Date(before);
      if (Number.isNaN(beforeDate.getTime())) return res.status(400).json({ error: 'Некорректный параметр before' });
      where.createdAt = { [Op.lt]: beforeDate };
    }

    const messages = await Message.findAll({ where, order: [['createdAt', 'DESC']], limit: limitNum });
    res.json(messages.reverse().map(m => ({
      _id: m.id, from: m.from, to: m.to, text: m.text, image: m.image,
      type: m.type, deleted: m.deleted, time: m.createdAt.toISOString()
    })));
  } catch (err) {
    logger.error('Group messages error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки сообщений группы' });
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

// ─── FIX #2.6: централизованная обработка ошибок multer/Express ──────────────
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.code === 'LIMITFILESIZE') return res.status(400).json({ error: 'Файл слишком большой (максимум 5 МБ)' });
  if (err.message && err.message.includes('Разрешены только')) return res.status(400).json({ error: err.message });
  logger.error('Express error', { requestId: req.requestId, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
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

// ─── Group helpers ────────────────────────────────────────────────────────────
async function getGroupWithMembers(groupId) {
  const group = await Group.findByPk(groupId);
  if (!group) return null;
  const memberships = await GroupMember.findAll({
    where: { groupId },
    include: [{ model: User, attributes: ['id', 'nickname', 'avatar'] }]
  });
  return {
    id: group.id,
    name: group.name,
    avatar: group.avatar,
    ownerId: group.ownerId,
    createdAt: group.createdAt,
    members: memberships.map(m => ({
      id: m.User.id,
      nickname: m.User.nickname,
      avatar: m.User.avatar,
      online: isOnline(m.User.id),
      role: m.role
    }))
  };
}

async function isGroupMember(userId, groupId) {
  return !!(await GroupMember.findOne({ where: { userId, groupId } }));
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const currentUserId = socket.user.id;
  // FIX #5: защита от race condition при мгновенном дисконнекте
  if (!currentUserId) return socket.disconnect(true);

  // FIX #3.3: Set групп пользователя живёт на сокете
  socket.groupIds = new Set();
  socket.groupsLoaded = false;

  let expiryTimer = null;
  if (socket.user.exp) {
    const msUntilExpiry = socket.user.exp * 1000 - Date.now();
    expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(msUntilExpiry, 0));
  }

  const cameOnline = markOnline(currentUserId, socket.id);
  socket.join(currentUserId);

  (async () => {
    try {
      const user = await User.findByPk(currentUserId);
      if (!user) {
        markOffline(currentUserId, socket.id);
        return socket.disconnect();
      }

      if (cameOnline) {
        user.friends.forEach(fId => io.to(fId).emit('friendOnline', { id: currentUserId, nickname: user.nickname }));
      }

      // FIX #3.2: memberships запрашивается ОДИН раз и переиспользуется
      // и для join в комнаты, и для groupIds, и для unread-подсчёта.
      const memberships = await GroupMember.findAll({ where: { userId: currentUserId } });
      for (const m of memberships) {
        socket.join(group:${m.groupId});
        socket.groupIds.add(m.groupId);
      }
      socket.groupsLoaded = true;

      const unreadRows = await Message.findAll({
        where: { to: currentUserId, read: false, deleted: false, groupId: null },
        attributes: ['from', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
        group: ['from']
      });
      const unreadCounts = Object.fromEntries(
        unreadRows.map(r => [r.from, parseInt(r.get('count'), 10)])
      );

      // FIX #1.6: считаем только НЕПРОЧИТАННЫЕ (read: false)
      const groupIds = memberships.map(m => m.groupId);
      let groupUnreadCounts = {};
      if (groupIds.length) {
        const groupUnreadRows = await Message.findAll({
          where: {
            groupId: { [Op.in]: groupIds },
            from: { [Op.ne]: currentUserId },
            deleted: false,
            read: false
          },
          attributes: ['groupId', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
          group: ['groupId']
        });
        groupUnreadCounts = Object.fromEntries(
          groupUnreadRows.map(r => [r.groupId, parseInt(r.get('count'), 10)])
        );
      }

      socket.emit('profile', {
        id: user.id, nickname: user.nickname, avatar: user.avatar,
        status: user.status, bio: user.bio,
        friends: user.friends, friendRequests: user.friendRequests,
        blockedUsers: user.blockedUsers,
        unreadCounts, groupUnreadCounts
      });
      logger.info([online] ${currentUserId});
    } catch (err) { logger.error('Connection init error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  })();

  // ─── Friend Requests ───────────────────────────────────────────────────────
  socket.on('sendFriendRequest', async (toId) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!canSendFriendRequest(currentUserId)) {
        return socket.emit('friendRequestError', { toId, reason: 'rate_limited' });
      }
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
      if (!to) return socket.emit('friendRequestError', { toId, reason: 'not_found' });
      if (to.friends.includes(currentUserId)) return socket.emit('friendRequestError', { toId, reason: 'already_friends' });
      if (to.friendRequests.includes(currentUserId)) return socket.emit('friendRequestError', { toId, reason: 'already_sent' });
      if (to.blockedUsers.includes(currentUserId)) return socket.emit('friendRequestError', { toId, reason: 'blocked' });
      if (from.blockedUsers.includes(toId)) return socket.emit('friendRequestError', { toId, reason: 'blocked' });
      if (to.friendRequests.length >= MAXFRIENDREQUESTS) return socket.emit('friendRequestError', { toId, reason: 'targetlimitreached' });

      const affected = await sequelize.query(
        UPDATE "users"
        SET friendrequests = arrayappend(friend_requests, :fromId)
        WHERE id = :toId
          AND NOT (:fromId = ANY(friend_requests))
          AND NOT (:fromId = ANY(friends))
          AND NOT (:fromId = ANY(blocked_users))
          AND (arraylength(friendrequests, 1) IS NULL OR arraylength(friendrequests, 1)  {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!fromId || typeof fromId !== 'string') return;

      let result;
      try {
        result = await sequelize.transaction(async (t) => {
          const meResult = await sequelize.query(
            UPDATE "users"
            SET friendrequests = arrayremove(friend_requests, :fromId),
                friends = CASE WHEN :fromId = ANY(friends) THEN friends ELSE array_append(friends, :fromId) END
            WHERE id = :myId AND :fromId = ANY(friend_requests)
              AND (:fromId = ANY(friends) OR arraylength(friends, 1) IS NULL OR arraylength(friends, 1)  {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!fromId || typeof fromId !== 'string') return;
      await sequelize.query(
        UPDATE "users"
        SET friendrequests = arrayremove(friend_requests, :fromId)
        WHERE id = :myId
        RETURNING id
      , {
        replacements: { fromId, myId: currentUserId },
        type: sequelize.QueryTypes.SELECT
      });
      socket.emit('requestDeclined', fromId);
    } catch (err) { logger.error('Decline friend error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  socket.on('removeFriend', async (friendId) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!friendId || typeof friendId !== 'string') return;
      const result = await sequelize.query(
        UPDATE "users" SET friends = array_remove(friends, :friendId)
        WHERE id = :myId AND :friendId = ANY(friends) RETURNING id
      , { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.SELECT });
      if (!result || !result.length) return;
      await sequelize.query(
        UPDATE "users" SET friends = array_remove(friends, :myId) WHERE id = :friendId
      , { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.UPDATE });
      socket.emit('friendRemoved', { id: friendId });
      io.to(friendId).emit('friendRemoved', { id: currentUserId });
    } catch (err) { logger.error('Remove friend error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // ─── DM Messages ────────────────────────────────────────────────────────────
  socket.on('sendMessage', async ({ toId, text, image } = {}) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      // FIX #1.4: явная ранняя проверка toId
      if (!toId || typeof toId !== 'string') return;
      if (text !== undefined && typeof text !== 'string') return;
      if (image !== undefined && image !== null && typeof image !== 'string') return;
      if (!text?.trim() && !image) return;
      if (text && text.trim().length > MAXTEXTLENGTH) {
        return socket.emit('sendMessageError', { toId, reason: 'texttoolong' });
      }
      if (image && image.length > MAXIMAGEBASE64_CHARS) {
        return socket.emit('sendMessageError', { toId, reason: 'imagetoolarge' });
      }

      const meUser = await User.findByPk(currentUserId);
      const toUser = await User.findByPk(toId);
      if (!meUser || !toUser || !meUser.friends.includes(toId)) return;
      if (toUser.blockedUsers.includes(currentUserId) || meUser.blockedUsers.includes(toId)) return;

      const key = getChatKey(currentUserId, toId);
      const msg = await Message.create({
        chatKey: key, groupId: null, from: currentUserId, to: toId,
        text: text?.trim() || '', image: image || null, type: image ? 'image' : 'text'
      });

      const msgData = {
        _id: msg.id, from: currentUserId, text: msg.text, image: msg.image,
        type: msg.type, time: msg.createdAt.toISOString(), deleted: false
      };
      io.to(currentUserId).emit('newMessage', { chatWith: toId, msg: msgData });
      io.to(toId).emit('newMessage', { chatWith: currentUserId, msg: msgData });
    } catch (err) { logger.error('Send message error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  socket.on('markRead', async (friendId) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!friendId) return;
      await Message.update(
        { read: true },
        { where: { chatKey: getChatKey(currentUserId, friendId), to: currentUserId, read: false, groupId: null } }
      );
    } catch (err) { logger.error('Mark read error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // ─── Group Messages ─────────────────────────────────────────────────────────
  socket.on('groupMessage', async ({ groupId, text, image } = {}) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      // FIX #2.3: валидация формата UUID
      if (!groupId || typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      // FIX #1.3: валидация типа image (как в sendMessage)
      if (text !== undefined && typeof text !== 'string') return;
      if (image !== undefined && image !== null && typeof image !== 'string') return;
      if (!text?.trim() && !image) return;
      if (text && text.trim().length > MAXTEXTLENGTH) {
        return socket.emit('sendMessageError', { groupId, reason: 'texttoolong' });
      }
      // FIX #1.2: проверка размера изображения (как в sendMessage)
      if (image && image.length > MAXIMAGEBASE64_CHARS) {
        return socket.emit('sendMessageError', { groupId, reason: 'imagetoolarge' });
      }

      // FIX #3.3: быстрый путь через socket.groupIds; DB-фолбэк только при промахе
      if (!socket.groupIds.has(groupId)) {
        if (!(await isGroupMember(currentUserId, groupId))) return;
        socket.groupIds.add(groupId);
        socket.join(group:${groupId});
      }

      const msg = await Message.create({
        chatKey: null, groupId, from: currentUserId, to: null,
        text: text?.trim() || '', image: image || null, type: image ? 'image' : 'text'
      });

      const msgData = {
        _id: msg.id, from: currentUserId, text: msg.text, image: msg.image,
        type: msg.type, time: msg.createdAt.toISOString(), deleted: false
      };
      io.to(group:${groupId}).emit('newGroupMessage', { groupId, msg: msgData });
    } catch (err) { logger.error('Group message error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // FIX #1.5: реальное обнуление непрочитанных в БД
  socket.on('markGroupRead', async (groupId) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!groupId || typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      if (!socket.groupIds.has(groupId)) {
        if (!(await isGroupMember(currentUserId, groupId))) return;
        socket.groupIds.add(groupId);
        socket.join(group:${groupId});
      }
      await Message.update(
        { read: true },
        { where: { groupId, from: { [Op.ne]: currentUserId }, read: false } }
      );
    } catch (err) { logger.error('Mark group read error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // ─── Group Management ───────────────────────────────────────────────────────
  socket.on('addGroupMember', async ({ groupId, userId } = {}) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!canGroupAction(currentUserId)) return socket.emit('groupError', { reason: 'rate_limited' });
      if (!groupId || typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      if (!userId || typeof userId !== 'string') return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership) return socket.emit('groupError', { reason: 'not_member' });
      if (membership.role !== 'owner') return socket.emit('groupError', { reason: 'not_owner' });

      const memberCount = await GroupMember.count({ where: { groupId } });
      if (memberCount >= MAXGROUPMEMBERS) return socket.emit('groupError', { reason: 'limit_reached' });

      const owner = await User.findByPk(currentUserId);
      if (!owner || !owner.friends.includes(userId)) return socket.emit('groupError', { reason: 'not_friends' });

      const target = await User.findByPk(userId);
      if (!target) return socket.emit('groupError', { reason: 'not_found' });
      if (target.blockedUsers.includes(currentUserId) || owner.blockedUsers.includes(userId)) {
        return socket.emit('groupError', { reason: 'blocked' });
      }

      // FIX #1.8: findOrCreate атомарно защищает от гонки двух параллельных
      // добавлений (уникальный индекс groupid+userid) — без исключений
      const [row, created] = await GroupMember.findOrCreate({
        where: { groupId, userId },
        defaults: { role: 'member' }
      });
      if (!created) return socket.emit('groupError', { reason: 'already_member' });

      joinUserToGroupRoom(userId, groupId);

      io.to(group:${groupId}).emit('groupMemberJoined', {
        groupId,
        user: { id: userId, nickname: target.nickname, avatar: target.avatar, online: isOnline(userId), role: 'member' }
      });
      const groupData = await getGroupWithMembers(groupId);
      io.to(userId).emit('addedToGroup', { group: groupData });
    } catch (err) {
      logger.error('Add group member error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('groupError', { reason: 'server_error' });
    }
  });

  socket.on('leaveGroup', async (groupId) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!groupId || typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership) return;

      const group = await Group.findByPk(groupId);
      if (!group) return;

      if (membership.role === 'owner') {
        // FIX #1.7: удаление группы — атомарно, в одной транзакции
        await sequelize.transaction(async (t) => {
          await Message.destroy({ where: { groupId }, transaction: t });
          await GroupMember.destroy({ where: { groupId }, transaction: t });
          await group.destroy({ transaction: t });
        });

        // FIX #1.1: уведомляем комнату и чистим кэш groupIds у всех её сокетов.
        // Мёртвый findAll после destroy удалён.
        const roomSids = [...(io.sockets.adapter.rooms.get(group:${groupId}) || [])];
        io.to(group:${groupId}).emit('groupDeleted', { groupId });
        for (const sid of roomSids) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            s.groupIds?.delete(groupId);
            s.leave(group:${groupId});
          }
        }
      } else {
        await membership.destroy();
        socket.groupIds.delete(groupId);
        socket.leave(group:${groupId});
        io.to(group:${groupId}).emit('groupMemberLeft', { groupId, userId: currentUserId });
      }
    } catch (err) { logger.error('Leave group error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  socket.on('kickGroupMember', async ({ groupId, userId } = {}) => {
    try {
      if (!currentUserId) return socket.disconnect();
      if (!canGroupAction(currentUserId)) return socket.emit('groupError', { reason: 'rate_limited' });
      if (!groupId || typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      if (!userId) return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership || membership.role !== 'owner') return socket.emit('groupError', { reason: 'not_owner' });
      if (userId === currentUserId) return;

      const targetMembership = await GroupMember.findOne({ where: { groupId, userId } });
      if (!targetMembership) return;

      await targetMembership.destroy();
      leaveUserFromGroupRoom(userId, groupId);

      io.to(group:${groupId}).emit('groupMemberLeft', { groupId, userId });
      io.to(userId).emit('groupDeleted', { groupId });
    } catch (err) { logger.error('Kick member error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    const wentOffline = markOffline(currentUserId, socket.id);
    if (!wentOffline) return;

    try {
      const user = await User.findByPk(currentUserId);
      if (user) user.friends.forEach(fId => io.to(fId).emit('friendOffline', currentUserId));
    } catch (err) { logger.error('Disconnect error', { socketId: socket.id, error: err.message, stack: err.stack }); }
    logger.info([offline] ${currentUserId});
  });
});

// ─── Запуск сервера ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  const connected = await connectWithRetry();
  if (connected) {
    try {
      if (process.env.NODE_ENV === 'production') {
        await sequelize.sync();
        logger.info('✅ Таблицы проверены (production, без auto-alter)');
      } else {
        await sequelize.sync({ alter: true });
        logger.info('✅ Таблицы синхронизированы (dev, alter: true)');
      }
    } catch (err) {
      logger.error('❌ Sync error', { error: err.message, stack: err.stack });
    }
  } else {
    logger.warn('⚠️  Сервер запускается без подтверждённого подключения к БД.');
  }

  server.listen(PORT, () => {
    logger.info(✅ Сервер запущен на http://localhost:${PORT});
  });
})();

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: err?.message || String(err), stack: err?.stack });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(Получен ${signal}, начинаю штатную остановку сервера...);

  io.close();

  server.close(async () => {
    try {
      await sequelize.close();
      logger.info('Соединение с БД закрыто, выход.');
      process.exit(0);
    } catch (err) {
      logger.error('Ошибка при закрытии БД', { error: err.message, stack: err.stack });
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