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
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ─── Logging ──────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    }),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// ─── Config / env ─────────────────────────────────────────────────────────────
const corsAllowList = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean);
if (corsAllowList.length === 0) {
  logger.warn('⚠️  CLIENT_URL не задан — CORS разрешает ЛЮБОЙ origin! (нормально только для локальной разработки)');
}

const JWT_SECRET = process.env.JWT_SECRET || 'changethissecretinproduction';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const SALT_ROUNDS = 12;

if (!process.env.JWT_SECRET) {
  logger.warn('⚠️  JWT_SECRET не задан — используется дефолтный небезопасный секрет!');
}

if (process.env.NODE_ENV === 'production') {
  const missingEnv = [];
  if (!process.env.JWT_SECRET) missingEnv.push('JWT_SECRET');
  if (corsAllowList.length === 0) missingEnv.push('CLIENT_URL');
  if (missingEnv.length) {
    logger.error(`❌ В production обязательны переменные окружения: ${missingEnv.join(', ')}. Остановка.`);
    process.exit(1);
  }
}

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_FRIENDS = 500;
const MAX_BLOCKED = 200;
const MAX_FRIEND_REQUESTS = 200;
const MAX_GROUP_MEMBERS = 50;
const MAX_GROUPS_PER_USER = 100;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES * (4 / 3)) + 64; // + data:-префикс
const MAX_NICKNAME_LENGTH = 50;
const MAX_STATUS_LENGTH = 150;
const MAX_BIO_LENGTH = 1000;
const MAX_TEXT_LENGTH = 4000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_GROUP_NAME_LENGTH = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID_RE = /^[a-z0-9_]{3,30}$/;
const UPLOAD_PATH_RE = /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
// FIX: картинка в сообщении — только data-URL с известным image/* типом
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── Socket.IO ────────────────────────────────────────────────────────────────
function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true);
  if (corsAllowList.length === 0 || corsAllowList.includes(origin)) return callback(null, true);
  callback(new Error('CORS blocked'));
}

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  maxHttpBufferSize: MAX_IMAGE_BASE64_CHARS + 100_000
});

app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  // FIX: иначе helmet ставит CORP: same-origin и картинки из /uploads
  // не грузятся на фронтенде с другого origin.
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({ origin: corsOrigin }));

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// FIX: 10mb для JSON не нужно — картинки идут через multer/сокеты
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Слишком много попыток, попробуйте через 15 минут' }
});
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Слишком много запросов поиска' }
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Слишком много загрузок, подождите минуту' }
});

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
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

async function connectWithRetry(retries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sequelize.authenticate();
      logger.info('✅ Подключение к PostgreSQL установлено');
      return true;
    } catch (err) {
      logger.error(`❌ Попытка подключения к БД ${attempt}/${retries} не удалась`, { error: err.message });
      if (attempt < retries) {
        const backoff = delayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
        await new Promise(res => setTimeout(res, backoff));
      }
    }
  }
  return false;
}

// ─── Models ───────────────────────────────────────────────────────────────────
const User = sequelize.define('User', {
  id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
  nickname: { type: DataTypes.STRING(MAX_NICKNAME_LENGTH), allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  // NEW: инвалидация старых токенов после смены пароля
  passwordChangedAt: { type: DataTypes.DATE, allowNull: true },
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
    // FIX: составные индексы под реальные запросы пагинации/непрочитанных
    { fields: ['chat_key', 'created_at'] },
    { fields: ['group_id', 'created_at'] },
    { fields: ['to', 'read'] },
    { fields: ['from'] }
  ]
});

const Group = sequelize.define('Group', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(MAX_GROUP_NAME_LENGTH), allowNull: false },
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
  indexes: [{ unique: true, fields: ['group_id', 'user_id'] }, { fields: ['user_id'] }]
});

// NEW: персональное состояние прочтения групповых чатов
const GroupReadState = sequelize.define('GroupReadState', {
  groupId: { type: DataTypes.UUID, primaryKey: true },
  userId: { type: DataTypes.STRING, primaryKey: true },
  lastReadAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, { timestamps: false, underscored: true, tableName: 'group_read_states' });

Group.hasMany(GroupMember, { foreignKey: 'groupId', onDelete: 'CASCADE' });
GroupMember.belongsTo(Group, { foreignKey: 'groupId' });
GroupMember.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(GroupMember, { foreignKey: 'userId' });

// ─── Presence ─────────────────────────────────────────────────────────────────
// NB: состояние хранится в памяти процесса — при нескольких инстансах нужен
// socket.io redis-adapter + Redis для presence.
const onlineUsers = {}; // userId -> Set<socketId>

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
function userSockets(userId) {
  const out = [];
  for (const sid of onlineUsers[userId] || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) out.push(s);
  }
  return out;
}

setInterval(() => {
  const connected = new Set(io.sockets.sockets.keys());
  for (const [userId, sids] of Object.entries(onlineUsers)) {
    for (const sid of sids) if (!connected.has(sid)) sids.delete(sid);
    if (sids.size === 0) delete onlineUsers[userId];
  }
}, 60_000).unref();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getChatKey(a, b) { return [a, b].sort().join('::'); }

function publicUser(u) {
  return { id: u.id, nickname: u.nickname, avatar: u.avatar, status: u.status, online: isOnline(u.id) };
}
function privateUser(u) {
  return {
    id: u.id, nickname: u.nickname, avatar: u.avatar, status: u.status, bio: u.bio,
    friends: u.friends, friendRequests: u.friendRequests, blockedUsers: u.blockedUsers
  };
}
function signToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// FIX: удаляем только файлы из /uploads с ожидаемым именем, иначе сюда могли
// прилетать base64-строки картинок сообщений.
async function deleteUploadedFile(publicPath) {
  if (!publicPath || typeof publicPath !== 'string' || !UPLOAD_PATH_RE.test(publicPath)) return;
  const fullPath = path.join(UPLOAD_DIR, path.basename(publicPath));
  try {
    await fs.promises.unlink(fullPath);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.error('Ошибка удаления файла', { file: fullPath, error: err.message });
  }
}

function validateImagePayload(image) {
  if (image === undefined || image === null) return { ok: true, image: null };
  if (typeof image !== 'string') return { ok: false, reason: 'invalid_image' };
  if (image.length > MAX_IMAGE_BASE64_CHARS) return { ok: false, reason: 'image_too_large' };
  if (!IMAGE_DATA_URL_RE.test(image)) return { ok: false, reason: 'invalid_image' };
  return { ok: true, image };
}

function makeSocketLimiter(maxPerWindow, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, arr] of hits) if (arr.every(t => now - t >= windowMs)) hits.delete(key);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= maxPerWindow) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}
const canSendFriendRequest = makeSocketLimiter(20, 60 * 1000);
const canSendMessage = makeSocketLimiter(30, 10 * 1000);
const canGroupAction = makeSocketLimiter(20, 60 * 1000);
const canTyping = makeSocketLimiter(30, 10 * 1000);

// ─── Group rooms ──────────────────────────────────────────────────────────────
function joinUserToGroupRoom(userId, groupId) {
  for (const s of userSockets(userId)) {
    s.join(`group:${groupId}`);
    s.groupIds?.add(groupId);
  }
}
function leaveUserFromGroupRoom(userId, groupId) {
  for (const s of userSockets(userId)) {
    s.leave(`group:${groupId}`);
    s.groupIds?.delete(groupId);
  }
}

async function getGroupWithMembers(groupId) {
  const group = await Group.findByPk(groupId);
  if (!group) return null;
  const memberships = await GroupMember.findAll({
    where: { groupId },
    include: [{ model: User, attributes: ['id', 'nickname', 'avatar'] }]
  });
  return {
    id: group.id, name: group.name, avatar: group.avatar, ownerId: group.ownerId, createdAt: group.createdAt,
    members: memberships.map(m => ({
      id: m.User.id, nickname: m.User.nickname, avatar: m.User.avatar, online: isOnline(m.User.id), role: m.role
    }))
  };
}
async function isGroupMember(userId, groupId) {
  return !!(await GroupMember.findOne({ where: { userId, groupId }, attributes: ['id'] }));
}

// NEW: непрочитанные в группах считаются персонально через group_read_states
async function getGroupUnreadCounts(userId, groupIds) {
  if (!groupIds.length) return {};
  const rows = await sequelize.query(
    `SELECT m.group_id AS "groupId", COUNT(*)::int AS "count"
     FROM "messages" m
     LEFT JOIN "group_read_states" r ON r.group_id = m.group_id AND r.user_id = :userId
     WHERE m.group_id IN (:groupIds)
       AND m."from" <> :userId
       AND m.deleted = false
       AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
     GROUP BY m.group_id`,
    { replacements: { userId, groupIds }, type: sequelize.QueryTypes.SELECT }
  );
  return Object.fromEntries(rows.map(r => [r.groupId, r.count]));
}

// ─── Auth (JWT) ───────────────────────────────────────────────────────────────
const authCache = new Map(); // userId -> { exists, pwdChangedAt, exp }
const AUTH_CACHE_TTL = 30_000;

async function getAuthInfo(id) {
  const now = Date.now();
  const hit = authCache.get(id);
  if (hit && hit.exp > now) return hit;
  const u = await User.findByPk(id, { attributes: ['id', 'passwordChangedAt'] });
  const info = {
    exists: !!u,
    pwdChangedAt: u?.passwordChangedAt ? new Date(u.passwordChangedAt).getTime() : 0,
    exp: now + (u ? AUTH_CACHE_TTL : 5000)
  };
  authCache.set(id, info);
  if (authCache.size > 10_000) authCache.clear();
  return info;
}

// Возвращает payload токена либо null
async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { return null; }
  if (!payload?.id || typeof payload.id !== 'string') return null;
  const info = await getAuthInfo(payload.id);
  if (!info.exists) return null;
  if (info.pwdChangedAt && (payload.iat || 0) * 1000 < info.pwdChangedAt) return null;
  return payload;
}

async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Не авторизован' });
    const payload = await verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Токен недействителен или истёк' });
    req.user = payload;
    next();
  } catch (err) { next(err); }
}

// ─── File Upload ──────────────────────────────────────────────────────────────
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_EXTS = new Set(['jpg', 'png', 'webp', 'gif']);
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // расширение проставляем позже, по реальному содержимому
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.tmp')
  }),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения (jpeg, png, webp, gif)'));
  }
});

let fileTypeModule = null;
async function getFileType() {
  if (!fileTypeModule) fileTypeModule = await import('file-type'); // ESM-only
  return fileTypeModule;
}

// Проверяет магические байты, переименовывает в <uuid>.<ext>, возвращает
// публичный путь или null (файл при этом удалён).
async function finalizeUpload(file) {
  if (!file) return null;
  const tmpPath = file.path;
  try {
    const { fileTypeFromFile } = await getFileType();
    const detected = await fileTypeFromFile(tmpPath);
    if (!detected || !ALLOWED_IMAGE_EXTS.has(detected.ext)) {
      await fs.promises.unlink(tmpPath).catch(() => {});
      return null;
    }
    const finalName = `${crypto.randomUUID()}.${detected.ext}`;
    await fs.promises.rename(tmpPath, path.join(UPLOAD_DIR, finalName));
    return `/uploads/${finalName}`;
  } catch (err) {
    logger.error('Ошибка обработки загруженного файла', { file: tmpPath, error: err.message });
    await fs.promises.unlink(tmpPath).catch(() => {});
    return null;
  }
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { userId, nickname, password } = req.body || {};
    const id = (typeof userId === 'string' ? userId : '').trim().toLowerCase();
    const nick = (typeof nickname === 'string' ? nickname : '').trim().slice(0, MAX_NICKNAME_LENGTH) || id;

    if (!id || id.length < 3) return res.status(400).json({ error: 'ID минимум 3 символа' });
    if (id.length > 30) return res.status(400).json({ error: 'ID максимум 30 символов' });
    if (!USER_ID_RE.test(id)) return res.status(400).json({ error: 'ID: только a-z, 0-9, _' });
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Пароль минимум ${MIN_PASSWORD_LENGTH} символов` });
    }
    if (password.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: `Пароль максимум ${MAX_PASSWORD_LENGTH} символов` });

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    let user;
    try {
      user = await User.create({ id, nickname: nick, passwordHash, friends: [], friendRequests: [], blockedUsers: [] });
    } catch (err) {
      // FIX: гонка двух одновременных регистраций одного ID — ловим по PK
      if (err.name === 'SequelizeUniqueConstraintError') return res.status(400).json({ error: 'Этот ID уже занят' });
      throw err;
    }

    res.json({ success: true, token: signToken(user.id), user: privateUser(user) });
  } catch (err) {
    logger.error('Register error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

const DUMMY_PASSWORD_HASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKNjM4YFf6/EHou';

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { userId, password } = req.body || {};
    const id = (typeof userId === 'string' ? userId : '').trim().toLowerCase();
    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(401).json({ error: 'Неверный ID или пароль' });
    }

    const user = USER_ID_RE.test(id) ? await User.findByPk(id) : null;
    const match = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
    if (!user || !match) return res.status(401).json({ error: 'Неверный ID или пароль' });

    res.json({ success: true, token: signToken(user.id), user: privateUser(user) });
  } catch (err) {
    logger.error('Login error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// NEW: смена пароля с инвалидацией всех ранее выданных токенов
app.post('/api/password/change', authMiddleware, authLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Некорректные данные' });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Пароль минимум ${MIN_PASSWORD_LENGTH} символов` });
    if (newPassword.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: `Пароль максимум ${MAX_PASSWORD_LENGTH} символов` });
    if (currentPassword === newPassword) return res.status(400).json({ error: 'Новый пароль совпадает с текущим' });

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: 'Текущий пароль неверен' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    // iat в JWT округлён до секунд — отступаем на секунду назад, чтобы
    // только что выданный токен не считался "старым"
    user.passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
    await user.save();
    authCache.delete(user.id);

    const token = signToken(user.id);
    // все старые сокет-сессии сбрасываем — клиент переподключится с новым токеном
    io.in(user.id).disconnectSockets(true);
    res.json({ success: true, token });
  } catch (err) {
    logger.error('Change password error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка смены пароля' });
  }
});

// ─── User Routes ──────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(privateUser(user));
  } catch (err) {
    logger.error('Me error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка' });
  }
});

// NEW: друзья + входящие заявки с никами/аватарами/онлайном одним запросом
app.get('/api/friends', authMiddleware, async (req, res) => {
  try {
    const me = await User.findByPk(req.user.id, { attributes: ['id', 'friends', 'friendRequests'] });
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    const ids = [...new Set([...me.friends, ...me.friendRequests])];
    const users = ids.length
      ? await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'nickname', 'avatar', 'status'] })
      : [];
    const byId = Object.fromEntries(users.map(u => [u.id, publicUser(u)]));
    res.json({
      friends: me.friends.map(id => byId[id]).filter(Boolean),
      requests: me.friendRequests.map(id => byId[id]).filter(Boolean)
    });
  } catch (err) {
    logger.error('Friends error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки друзей' });
  }
});

app.get('/api/search', authMiddleware, searchLimiter, async (req, res) => {
  try {
    const q = (typeof req.query.q === 'string' ? req.query.q : '').trim().slice(0, 50);
    if (!q) return res.json([]);
    const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const results = await User.findAll({
      where: {
        id: { [Op.ne]: req.user.id },
        [Op.or]: [
          { id: { [Op.iLike]: `%${escaped}%` } },
          { nickname: { [Op.iLike]: `%${escaped}%` } }
        ]
      },
      attributes: ['id', 'nickname', 'avatar', 'status'],
      limit: 10
    });
    res.json(results.map(publicUser));
  } catch (err) {
    logger.error('Search error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

app.get('/api/profile/:userId', authMiddleware, async (req, res) => {
  try {
    if (!USER_ID_RE.test(req.params.userId)) return res.status(404).json({ error: 'Пользователь не найден' });
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ...publicUser(user), bio: user.bio, createdAt: user.createdAt });
  } catch (err) {
    logger.error('Profile error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка профиля' });
  }
});

app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const { nickname, status, bio, avatar } = req.body || {};

    if (nickname !== undefined && (typeof nickname !== 'string' || nickname.length > MAX_NICKNAME_LENGTH)) {
      return res.status(400).json({ error: `Никнейм максимум ${MAX_NICKNAME_LENGTH} символов` });
    }
    if (nickname !== undefined && nickname.trim().length === 0) {
      return res.status(400).json({ error: 'Никнейм не может быть пустым' });
    }
    if (status !== undefined && (typeof status !== 'string' || status.length > MAX_STATUS_LENGTH)) {
      return res.status(400).json({ error: `Статус максимум ${MAX_STATUS_LENGTH} символов` });
    }
    if (bio !== undefined && (typeof bio !== 'string' || bio.length > MAX_BIO_LENGTH)) {
      return res.status(400).json({ error: `Описание максимум ${MAX_BIO_LENGTH} символов` });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // FIX: раньше можно было подставить путь к любому чужому файлу в /uploads.
    // Здесь аватар можно только убрать (null) или оставить текущим.
    if (avatar !== undefined && avatar !== null && avatar !== user.avatar) {
      return res.status(400).json({ error: 'Аватар можно изменить только через загрузку файла' });
    }

    if (nickname !== undefined) user.nickname = nickname.trim();
    if (status !== undefined) user.status = status.trim();
    if (bio !== undefined) user.bio = bio.trim();
    let oldAvatar = null;
    if (avatar === null && user.avatar) { oldAvatar = user.avatar; user.avatar = null; }
    await user.save();
    if (oldAvatar) await deleteUploadedFile(oldAvatar);

    const payload = { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio };
    // NEW: друзья и остальные вкладки сразу видят новые ник/аватар
    io.to(user.id).emit('profileUpdated', payload);
    user.friends.forEach(fId => io.to(fId).emit('userUpdated', payload));

    res.json({ success: true, user: payload });
  } catch (err) {
    logger.error('Profile update error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

app.post('/api/upload/avatar', authMiddleware, uploadLimiter, upload.single('avatar'), async (req, res) => {
  let publicPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    publicPath = await finalizeUpload(req.file);
    if (!publicPath) return res.status(400).json({ error: 'Файл не является допустимым изображением' });

    const user = await User.findByPk(req.user.id);
    if (!user) { await deleteUploadedFile(publicPath); return res.status(404).json({ error: 'Пользователь не найден' }); }

    const oldAvatar = user.avatar;
    user.avatar = publicPath;
    await user.save();
    if (oldAvatar) await deleteUploadedFile(oldAvatar);

    const payload = { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio };
    io.to(user.id).emit('profileUpdated', payload);
    user.friends.forEach(fId => io.to(fId).emit('userUpdated', payload));

    res.json({ success: true, avatar: user.avatar });
  } catch (err) {
    if (publicPath) await deleteUploadedFile(publicPath);
    logger.error('Avatar upload error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки аватара' });
  }
});

// ─── Block / Unblock ──────────────────────────────────────────────────────────
app.post('/api/users/:id/block', authMiddleware, async (req, res) => {
  try {
    const myId = req.user.id;
    const targetId = req.params.id;
    if (!USER_ID_RE.test(targetId)) return res.status(400).json({ error: 'Некорректный ID' });
    if (targetId === myId) return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });

    // FIX: атомарно, без read-modify-write гонок
    const rows = await sequelize.query(
      `UPDATE "users"
       SET blocked_users = array_append(blocked_users, :t),
           friends = array_remove(friends, :t),
           friend_requests = array_remove(friend_requests, :t)
       WHERE id = :me
         AND NOT (:t = ANY(blocked_users))
         AND (array_length(blocked_users, 1) IS NULL OR array_length(blocked_users, 1) < :max)
       RETURNING blocked_users AS "blockedUsers"`,
      { replacements: { t: targetId, me: myId, max: MAX_BLOCKED }, type: sequelize.QueryTypes.SELECT }
    );

    let blockedUsers;
    if (rows.length) {
      blockedUsers = rows[0].blockedUsers;
    } else {
      const me = await User.findByPk(myId, { attributes: ['blockedUsers'] });
      if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
      if (!me.blockedUsers.includes(targetId)) return res.status(400).json({ error: `Лимит заблокированных (${MAX_BLOCKED})` });
      blockedUsers = me.blockedUsers; // уже заблокирован — идемпотентно
    }

    const targetRows = await sequelize.query(
      `UPDATE "users"
       SET friends = array_remove(friends, :me), friend_requests = array_remove(friend_requests, :me)
       WHERE id = :t AND (:me = ANY(friends) OR :me = ANY(friend_requests))
       RETURNING id`,
      { replacements: { t: targetId, me: myId }, type: sequelize.QueryTypes.SELECT }
    );
    if (targetRows.length) io.to(targetId).emit('friendRemoved', { id: myId });

    // синхронизируем остальные вкладки
    io.to(myId).emit('friendRemoved', { id: targetId });
    io.to(myId).emit('userBlocked', { id: targetId, blockedUsers });

    res.json({ success: true, blockedUsers });
  } catch (err) {
    logger.error('Block error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка блокировки' });
  }
});

app.post('/api/users/:id/unblock', authMiddleware, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (!USER_ID_RE.test(targetId)) return res.status(400).json({ error: 'Некорректный ID' });
    const rows = await sequelize.query(
      `UPDATE "users" SET blocked_users = array_remove(blocked_users, :t)
       WHERE id = :me RETURNING blocked_users AS "blockedUsers"`,
      { replacements: { t: targetId, me: req.user.id }, type: sequelize.QueryTypes.SELECT }
    );
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    io.to(req.user.id).emit('userUnblocked', { id: targetId, blockedUsers: rows[0].blockedUsers });
    res.json({ success: true, blockedUsers: rows[0].blockedUsers });
  } catch (err) {
    logger.error('Unblock error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка разблокировки' });
  }
});

app.get('/api/users/blocked', authMiddleware, async (req, res) => {
  try {
    const me = await User.findByPk(req.user.id, { attributes: ['blockedUsers'] });
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!me.blockedUsers.length) return res.json([]);
    const users = await User.findAll({
      where: { id: { [Op.in]: me.blockedUsers } }, attributes: ['id', 'nickname', 'avatar']
    });
    res.json(users.map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar })));
  } catch (err) {
    logger.error('Blocked list error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки списка заблокированных' });
  }
});

// ─── Messages ─────────────────────────────────────────────────────────────────
function parsePagination(query) {
  const parsedLimit = parseInt(query.limit, 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 50));
  let before = null;
  if (query.before) {
    before = new Date(query.before);
    if (Number.isNaN(before.getTime())) return { error: 'Некорректный параметр before' };
  }
  return { limit, before };
}
function serializeMessage(m) {
  return {
    _id: m.id, from: m.from, to: m.to, groupId: m.groupId, text: m.text, image: m.image,
    type: m.type, deleted: m.deleted, read: m.read, time: m.createdAt.toISOString()
  };
}

app.get('/api/messages/:userId/:friendId', authMiddleware, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId) return res.status(403).json({ error: 'Нет доступа' });
    const friendId = req.params.friendId;
    if (!USER_ID_RE.test(friendId)) return res.status(400).json({ error: 'Некорректный ID' });

    const me = await User.findByPk(req.user.id, { attributes: ['id', 'friends'] });
    if (!me || !me.friends.includes(friendId)) return res.status(403).json({ error: 'Нет доступа' });

    const pg = parsePagination(req.query);
    if (pg.error) return res.status(400).json({ error: pg.error });

    const where = { chatKey: getChatKey(req.user.id, friendId), groupId: null };
    if (pg.before) where.createdAt = { [Op.lt]: pg.before };
    const messages = await Message.findAll({ where, order: [['createdAt', 'DESC']], limit: pg.limit });
    res.json(messages.reverse().map(serializeMessage));
  } catch (err) {
    logger.error('Messages error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    if (!UUID_RE.test(messageId || '')) return res.status(400).json({ error: 'Некорректный ID сообщения' });

    const msg = await Message.findByPk(messageId);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.deleted) return res.json({ success: true });

    // NEW: владелец группы может удалять любые сообщения в своей группе
    let allowed = msg.from === userId;
    if (!allowed && msg.groupId) {
      const group = await Group.findByPk(msg.groupId, { attributes: ['ownerId'] });
      allowed = group?.ownerId === userId;
    }
    if (!allowed) return res.status(403).json({ error: 'Нет доступа' });

    msg.deleted = true;
    msg.text = '';
    msg.image = null;
    await msg.save();

    if (msg.groupId) {
      io.to(`group:${msg.groupId}`).emit('messageDeleted', { messageId, chatWith: null, groupId: msg.groupId, by: userId });
    } else {
      const otherUser = (msg.chatKey || '').split('::').find(id => id !== userId) || null;
      io.to(userId).emit('messageDeleted', { messageId, chatWith: otherUser });
      if (otherUser) io.to(otherUser).emit('messageDeleted', { messageId, chatWith: userId });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('Delete message error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ─── Groups API ───────────────────────────────────────────────────────────────
function validateGroupName(name) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) return 'Название группы минимум 2 символа';
  if (name.trim().length > MAX_GROUP_NAME_LENGTH) return `Название группы максимум ${MAX_GROUP_NAME_LENGTH} символов`;
  return null;
}

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, memberIds } = req.body || {};
    const userId = req.user.id;

    const nameErr = validateGroupName(name);
    if (nameErr) return res.status(400).json({ error: nameErr });
    if (!Array.isArray(memberIds)) return res.status(400).json({ error: 'Некорректный список участников' });

    const cleanMemberIds = [...new Set(memberIds.filter(id => typeof id === 'string' && USER_ID_RE.test(id) && id !== userId))];
    const uniqueMembers = [userId, ...cleanMemberIds];
    if (uniqueMembers.length > MAX_GROUP_MEMBERS) return res.status(400).json({ error: `Максимум ${MAX_GROUP_MEMBERS} участников` });

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const groupCount = await GroupMember.count({ where: { userId } });
    if (groupCount >= MAX_GROUPS_PER_USER) return res.status(400).json({ error: `Максимум ${MAX_GROUPS_PER_USER} групп` });

    const friendSet = new Set(user.friends);
    for (const memberId of cleanMemberIds) {
      if (!friendSet.has(memberId)) return res.status(400).json({ error: `Пользователь ${memberId} не в друзьях` });
    }
    // FIX: не добавляем тех, кто нас заблокировал
    if (cleanMemberIds.length) {
      const targets = await User.findAll({ where: { id: { [Op.in]: cleanMemberIds } }, attributes: ['id', 'blockedUsers'] });
      const blockedMe = targets.find(t => t.blockedUsers.includes(userId));
      if (blockedMe) return res.status(400).json({ error: `Пользователь ${blockedMe.id} недоступен` });
    }

    const group = await sequelize.transaction(async (t) => {
      const g = await Group.create({ name: name.trim(), ownerId: userId }, { transaction: t });
      const now = new Date();
      await GroupMember.bulkCreate(
        uniqueMembers.map(id => ({ groupId: g.id, userId: id, role: id === userId ? 'owner' : 'member' })),
        { transaction: t, ignoreDuplicates: true }
      );
      await GroupReadState.bulkCreate(
        uniqueMembers.map(id => ({ groupId: g.id, userId: id, lastReadAt: now })),
        { transaction: t, ignoreDuplicates: true }
      );
      return g;
    });

    // FIX: владелец тоже должен быть в комнате группы
    for (const memberId of uniqueMembers) joinUserToGroupRoom(memberId, group.id);

    const groupData = await getGroupWithMembers(group.id);
    for (const memberId of uniqueMembers) {
      if (memberId !== userId) io.to(memberId).emit('addedToGroup', { group: groupData });
    }
    // остальные вкладки владельца
    io.to(userId).emit('groupCreated', { group: groupData });

    res.json({ success: true, group: groupData });
  } catch (err) {
    logger.error('Create group error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка создания группы' });
  }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const myMemberships = await GroupMember.findAll({
      where: { userId },
      include: [{ model: Group, required: true }],
      order: [[Group, 'createdAt', 'DESC']],
      limit, offset
    });
    if (!myMemberships.length) return res.json([]);

    const groupIds = myMemberships.map(m => m.Group.id);
    const allMembers = await GroupMember.findAll({
      where: { groupId: { [Op.in]: groupIds } },
      include: [{ model: User, attributes: ['id', 'nickname', 'avatar'] }]
    });

    const membersByGroup = {};
    for (const row of allMembers) {
      if (!row.User) continue;
      (membersByGroup[row.groupId] ||= []).push({
        id: row.User.id, nickname: row.User.nickname, avatar: row.User.avatar,
        online: isOnline(row.User.id), role: row.role
      });
    }

    res.json(myMemberships.map(m => ({
      id: m.Group.id, name: m.Group.name, avatar: m.Group.avatar, ownerId: m.Group.ownerId,
      createdAt: m.Group.createdAt, members: membersByGroup[m.Group.id] || []
    })));
  } catch (err) {
    logger.error('Get groups error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки групп' });
  }
});

app.patch('/api/groups/:groupId', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ error: 'Некорректный ID группы' });
    const { name } = req.body || {};
    const nameErr = validateGroupName(name);
    if (nameErr) return res.status(400).json({ error: nameErr });

    const group = await Group.findByPk(groupId);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    if (group.ownerId !== req.user.id) return res.status(403).json({ error: 'Только владелец может переименовывать группу' });

    group.name = name.trim();
    await group.save();

    io.to(`group:${groupId}`).emit('groupUpdated', { groupId, name: group.name, avatar: group.avatar });
    res.json({ success: true, group: { id: group.id, name: group.name, avatar: group.avatar, ownerId: group.ownerId } });
  } catch (err) {
    logger.error('Rename group error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка переименования группы' });
  }
});

app.post('/api/groups/:groupId/avatar', authMiddleware, uploadLimiter, upload.single('avatar'), async (req, res) => {
  let publicPath = null;
  try {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) {
      if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Некорректный ID группы' });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    publicPath = await finalizeUpload(req.file);
    if (!publicPath) return res.status(400).json({ error: 'Файл не является допустимым изображением' });

    const group = await Group.findByPk(groupId);
    if (!group) { await deleteUploadedFile(publicPath); return res.status(404).json({ error: 'Группа не найдена' }); }
    if (group.ownerId !== req.user.id) {
      await deleteUploadedFile(publicPath);
      return res.status(403).json({ error: 'Только владелец может менять аватар группы' });
    }

    const oldAvatar = group.avatar;
    group.avatar = publicPath;
    await group.save();
    if (oldAvatar) await deleteUploadedFile(oldAvatar);

    io.to(`group:${groupId}`).emit('groupUpdated', { groupId, name: group.name, avatar: group.avatar });
    res.json({ success: true, avatar: group.avatar });
  } catch (err) {
    if (publicPath) await deleteUploadedFile(publicPath);
    logger.error('Group avatar upload error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки аватара группы' });
  }
});

app.get('/api/groups/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!UUID_RE.test(groupId)) return res.status(400).json({ error: 'Некорректный ID группы' });
    if (!(await isGroupMember(req.user.id, groupId))) return res.status(403).json({ error: 'Вы не участник группы' });

    const pg = parsePagination(req.query);
    if (pg.error) return res.status(400).json({ error: pg.error });

    const where = { groupId };
    if (pg.before) where.createdAt = { [Op.lt]: pg.before };
    const messages = await Message.findAll({ where, order: [['createdAt', 'DESC']], limit: pg.limit });
    res.json(messages.reverse().map(serializeMessage));
  } catch (err) {
    logger.error('Group messages error', { requestId: req.requestId, error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки сообщений группы' });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: 'ok', db: 'connected', uptimeSeconds: Math.round(process.uptime()), online: Object.keys(onlineUsers).length });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// NEW: JSON-404 для неизвестных API-маршрутов и SPA-fallback для остального
app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
if (fs.existsSync(INDEX_HTML)) {
  app.get(/^\/(?!api\/|uploads\/).*/, (req, res) => res.sendFile(INDEX_HTML));
}

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Некорректный формат JSON в теле запроса' });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большое тело запроса' });
  if (err.message === 'CORS blocked') return res.status(403).json({ error: 'CORS: источник запроса не разрешён' });
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Файл слишком большой (максимум 5 МБ)' });
    return res.status(400).json({ error: 'Ошибка загрузки файла' });
  }
  if (err.message && err.message.includes('Разрешены только')) return res.status(400).json({ error: err.message });
  logger.error('Express error', { requestId: req.requestId, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ─── Socket.IO auth ───────────────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const payload = await verifyToken(socket.handshake.auth?.token);
    if (!payload) return next(new Error('Unauthorized'));
    socket.user = payload;
    next();
  } catch (err) {
    logger.error('Socket auth error', { error: err.message });
    next(new Error('Unauthorized'));
  }
});

// ─── Calls registry ───────────────────────────────────────────────────────────
const activeCalls = new Map(); // chatKey -> call
const callsById = new Map();   // callId  -> call
const pendingCalls = new Map(); // userId -> [invitation]
const PENDING_CALL_TTL = 5 * 60 * 1000;
const EMPTY_CALL_TTL = 60 * 1000;
const DM_RING_TIMEOUT = 90 * 1000;

function dmChatKey(a, b) { return `dm:${[a, b].sort().join(':')}`; }
function groupChatKey(groupId) { return `group:${groupId}`; }

function registerCall(call) { activeCalls.set(call.chatKey, call); callsById.set(call.callId, call); }
function unregisterCall(call) { activeCalls.delete(call.chatKey); callsById.delete(call.callId); }
function findCallById(callId) { return (callId && typeof callId === 'string') ? callsById.get(callId) || null : null; }

function emitGroupVoiceState(groupId, target) {
  const call = activeCalls.get(groupChatKey(groupId));
  const payload = call
    ? { groupId, callId: call.callId, video: call.video, participants: [...call.participants] }
    : { groupId, callId: null };
  const emitter = target ? (typeof target === 'string' ? io.to(target) : target) : io.to(`group:${groupId}`);
  emitter.emit('groupVoiceState', payload);
}

function removePendingInvite(userId, callId) {
  const queued = pendingCalls.get(userId);
  if (!queued) return;
  const rest = queued.filter(i => i.callId !== callId);
  if (rest.length) pendingCalls.set(userId, rest); else pendingCalls.delete(userId);
}

// Полное завершение звонка: уведомляем всех, чистим комнаты и pending
function endCall(call, reason = 'ended') {
  if (!callsById.has(call.callId)) return;
  unregisterCall(call);
  const room = `call:${call.callId}`;
  const payload = { callId: call.callId, chatKey: call.chatKey, reason };

  io.to(room).emit('callEnded', payload);
  if (call.type === 'dm') {
    // FIX: собеседник, который ещё не принял звонок, не был в комнате и не
    // узнавал об отмене — "звонил" до бесконечности
    io.to(call.initiator).emit('callEnded', payload);
    io.to(call.targetId).emit('callEnded', payload);
    removePendingInvite(call.targetId, call.callId);
  }

  for (const sid of io.sockets.adapter.rooms.get(room) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) { s.leave(room); s.activeCallKeys?.delete(call.chatKey); }
  }
  call.participants.clear();
  if (call.type === 'group') emitGroupVoiceState(call.groupId);
}

function leaveCall(userId, callId, reason = 'left') {
  const call = findCallById(callId);
  if (!call || !call.participants.has(userId)) return;

  call.participants.delete(userId);
  const room = `call:${call.callId}`;
  for (const s of userSockets(userId)) {
    s.leave(room);
    s.activeCallKeys?.delete(call.chatKey);
  }
  io.to(room).emit('peerLeft', { callId: call.callId, peerId: userId, reason });

  if (call.participants.size === 0 || (call.type === 'dm' && call.answered)) {
    // DM после ответа — уход любого из двух завершает звонок
    endCall(call, reason === 'left' ? 'ended' : reason);
  } else if (call.type === 'group') {
    emitGroupVoiceState(call.groupId);
  }
}

// FIX: уборка утечек — пустые/неотвеченные звонки и протухшие приглашения
setInterval(() => {
  const now = Date.now();
  for (const call of [...callsById.values()]) {
    if (call.participants.size === 0 && now - call.createdAt > EMPTY_CALL_TTL) endCall(call, 'timeout');
    else if (call.type === 'dm' && !call.answered && now - call.createdAt > DM_RING_TIMEOUT) endCall(call, 'no_answer');
  }
  for (const [userId, list] of pendingCalls) {
    const fresh = list.filter(i => now - i.createdAt < PENDING_CALL_TTL && callsById.has(i.callId));
    if (fresh.length) pendingCalls.set(userId, fresh); else pendingCalls.delete(userId);
  }
}, 15_000).unref();

// ─── Socket.IO connection ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const currentUserId = socket.user.id;

  socket.groupIds = new Set();
  socket.activeCallKeys = new Set();

  let expiryTimer = null;
  if (socket.user.exp) {
    // FIX: setTimeout > 2^31-1 мс срабатывает мгновенно — ограничиваем
    const msUntilExpiry = Math.min(Math.max(socket.user.exp * 1000 - Date.now(), 0), 2 ** 31 - 1);
    expiryTimer = setTimeout(() => socket.disconnect(true), msUntilExpiry);
  }

  const cameOnline = markOnline(currentUserId, socket.id);
  socket.join(currentUserId);

  // Ленивое подтверждение членства в группе (сокет мог подключиться до вступления)
  async function ensureGroupRoom(groupId) {
    if (socket.groupIds.has(groupId)) return true;
    if (!(await isGroupMember(currentUserId, groupId))) return false;
    socket.groupIds.add(groupId);
    socket.join(`group:${groupId}`);
    return true;
  }

  (async () => {
    try {
      const user = await User.findByPk(currentUserId);
      if (!user) { markOffline(currentUserId, socket.id); return socket.disconnect(true); }

      if (cameOnline) {
        user.friends.forEach(fId => io.to(fId).emit('friendOnline', { id: currentUserId, nickname: user.nickname, avatar: user.avatar }));
      }

      const memberships = await GroupMember.findAll({ where: { userId: currentUserId }, attributes: ['groupId'] });
      const groupIds = memberships.map(m => m.groupId);
      for (const gid of groupIds) {
        socket.join(`group:${gid}`);
        socket.groupIds.add(gid);
        emitGroupVoiceState(gid, socket);
      }

      const unreadRows = await Message.findAll({
        where: { to: currentUserId, read: false, deleted: false, groupId: null },
        attributes: ['from', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
        group: ['from']
      });
      const unreadCounts = Object.fromEntries(unreadRows.map(r => [r.from, parseInt(r.get('count'), 10)]));
      const groupUnreadCounts = await getGroupUnreadCounts(currentUserId, groupIds);

      socket.emit('profile', { ...privateUser(user), unreadCounts, groupUnreadCounts });

      const pendingForUser = pendingCalls.get(currentUserId) || [];
      pendingCalls.delete(currentUserId);
      for (const pending of pendingForUser) {
        if (Date.now() - pending.createdAt < PENDING_CALL_TTL && findCallById(pending.callId)) {
          socket.emit('incomingCall', pending);
        }
      }
      logger.info(`[online] ${currentUserId}`);
    } catch (err) {
      logger.error('Connection init error', { socketId: socket.id, error: err.message, stack: err.stack });
    }
  })();

  // ─── Friend Requests ───────────────────────────────────────────────────────
  socket.on('sendFriendRequest', async (toId) => {
    try {
      if (!canSendFriendRequest(currentUserId)) return socket.emit('friendRequestError', { toId, reason: 'rate_limited' });
      if (typeof toId !== 'string' || !USER_ID_RE.test(toId)) return socket.emit('friendRequestError', { toId, reason: 'not_found' });
      if (toId === currentUserId) return socket.emit('friendRequestError', { toId, reason: 'self' });

      const [from, to] = await Promise.all([User.findByPk(currentUserId), User.findByPk(toId)]);
      if (!from) return socket.disconnect(true);
      if (!to) return socket.emit('friendRequestError', { toId, reason: 'not_found' });
      if (from.friends.length >= MAX_FRIENDS) return socket.emit('friendRequestError', { toId, reason: 'limit_reached' });
      if (to.friends.includes(currentUserId)) return socket.emit('friendRequestError', { toId, reason: 'already_friends' });
      if (to.friendRequests.includes(currentUserId)) return socket.emit('friendRequestError', { toId, reason: 'already_sent' });
      // NEW: у нас уже есть входящая заявка от этого человека — надо её принять
      if (from.friendRequests.includes(toId)) return socket.emit('friendRequestError', { toId, reason: 'incoming_request_exists' });
      if (to.blockedUsers.includes(currentUserId) || from.blockedUsers.includes(toId)) {
        return socket.emit('friendRequestError', { toId, reason: 'blocked' });
      }
      if (to.friendRequests.length >= MAX_FRIEND_REQUESTS) return socket.emit('friendRequestError', { toId, reason: 'target_limit_reached' });

      const affected = await sequelize.query(
        `UPDATE "users"
         SET friend_requests = array_append(friend_requests, :fromId)
         WHERE id = :toId
           AND NOT (:fromId = ANY(friend_requests))
           AND NOT (:fromId = ANY(friends))
           AND NOT (:fromId = ANY(blocked_users))
           AND (array_length(friend_requests, 1) IS NULL OR array_length(friend_requests, 1) < :maxRequests)
         RETURNING id`,
        { replacements: { fromId: currentUserId, toId, maxRequests: MAX_FRIEND_REQUESTS }, type: sequelize.QueryTypes.SELECT }
      );
      if (!affected.length) return socket.emit('friendRequestError', { toId, reason: 'already_sent' });

      io.to(currentUserId).emit('requestSent', { toId });
      io.to(toId).emit('friendRequest', { id: currentUserId, nickname: from.nickname, avatar: from.avatar });
    } catch (err) {
      logger.error('Send friend request error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('friendRequestError', { toId, reason: 'server_error' });
    }
  });

  socket.on('acceptFriendRequest', async (fromId) => {
    try {
      if (typeof fromId !== 'string' || !USER_ID_RE.test(fromId)) return;

      let result;
      try {
        result = await sequelize.transaction(async (t) => {
          const meResult = await sequelize.query(
            `UPDATE "users"
             SET friend_requests = array_remove(friend_requests, :fromId),
                 friends = CASE WHEN :fromId = ANY(friends) THEN friends ELSE array_append(friends, :fromId) END
             WHERE id = :myId AND :fromId = ANY(friend_requests)
               AND (:fromId = ANY(friends) OR array_length(friends, 1) IS NULL OR array_length(friends, 1) < :maxFriends)
             RETURNING id`,
            { replacements: { fromId, myId: currentUserId, maxFriends: MAX_FRIENDS }, type: sequelize.QueryTypes.SELECT, transaction: t }
          );
          if (!meResult.length) return 'no_request';

          const themResult = await sequelize.query(
            `UPDATE "users"
             SET friends = CASE WHEN :myId = ANY(friends) THEN friends ELSE array_append(friends, :myId) END,
                 friend_requests = array_remove(friend_requests, :myId)
             WHERE id = :fromId
               AND NOT (:myId = ANY(blocked_users))
               AND (:myId = ANY(friends) OR array_length(friends, 1) IS NULL OR array_length(friends, 1) < :maxFriends)
             RETURNING id`,
            { replacements: { fromId, myId: currentUserId, maxFriends: MAX_FRIENDS }, type: sequelize.QueryTypes.SELECT, transaction: t }
          );
          // FIX: если вторую сторону обновить не удалось (лимит/блок/удалён) —
          // откатываем, иначе дружба становилась односторонней
          if (!themResult.length) throw Object.assign(new Error('peer_update_failed'), { code: 'PEER_FAILED' });
          return 'ok';
        });
      } catch (txErr) {
        if (txErr.code === 'PEER_FAILED') return socket.emit('friendRequestError', { toId: fromId, reason: 'target_limit_reached' });
        throw txErr;
      }
      if (result !== 'ok') return;

      const [me, friend] = await Promise.all([User.findByPk(currentUserId), User.findByPk(fromId)]);
      if (!me || !friend) return;

      io.to(currentUserId).emit('friendAdded', { id: friend.id, nickname: friend.nickname, avatar: friend.avatar, status: friend.status, online: isOnline(friend.id) });
      io.to(fromId).emit('friendAdded', { id: me.id, nickname: me.nickname, avatar: me.avatar, status: me.status, online: isOnline(me.id) });
    } catch (err) {
      logger.error('Accept friend error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('friendRequestError', { toId: fromId, reason: 'server_error' });
    }
  });

  socket.on('declineFriendRequest', async (fromId) => {
    try {
      if (typeof fromId !== 'string' || !USER_ID_RE.test(fromId)) return;
      await sequelize.query(
        `UPDATE "users" SET friend_requests = array_remove(friend_requests, :fromId) WHERE id = :myId`,
        { replacements: { fromId, myId: currentUserId }, type: sequelize.QueryTypes.UPDATE }
      );
      io.to(currentUserId).emit('requestDeclined', fromId);
    } catch (err) { logger.error('Decline friend error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  socket.on('removeFriend', async (friendId) => {
    try {
      if (typeof friendId !== 'string' || !USER_ID_RE.test(friendId)) return;
      const result = await sequelize.query(
        `UPDATE "users" SET friends = array_remove(friends, :friendId)
         WHERE id = :myId AND :friendId = ANY(friends) RETURNING id`,
        { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.SELECT }
      );
      if (!result.length) return;
      await sequelize.query(
        `UPDATE "users" SET friends = array_remove(friends, :myId) WHERE id = :friendId`,
        { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.UPDATE }
      );
      io.to(currentUserId).emit('friendRemoved', { id: friendId });
      io.to(friendId).emit('friendRemoved', { id: currentUserId });
    } catch (err) { logger.error('Remove friend error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // ─── DM Messages ────────────────────────────────────────────────────────────
  socket.on('sendMessage', async ({ toId, text, image, clientId } = {}) => {
    try {
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      if (typeof toId !== 'string' || !USER_ID_RE.test(toId)) return;
      if (text !== undefined && text !== null && typeof text !== 'string') return;
      const cleanText = (text || '').trim();
      const img = validateImagePayload(image);
      if (!img.ok) return socket.emit('sendMessageError', { toId, clientId, reason: img.reason });
      if (!cleanText && !img.image) return;
      if (cleanText.length > MAX_TEXT_LENGTH) return socket.emit('sendMessageError', { toId, clientId, reason: 'text_too_long' });

      const [meUser, toUser] = await Promise.all([
        User.findByPk(currentUserId, { attributes: ['id', 'friends', 'blockedUsers'] }),
        User.findByPk(toId, { attributes: ['id', 'blockedUsers'] })
      ]);
      if (!meUser || !toUser || !meUser.friends.includes(toId)) {
        return socket.emit('sendMessageError', { toId, clientId, reason: 'not_friends' });
      }
      if (toUser.blockedUsers.includes(currentUserId) || meUser.blockedUsers.includes(toId)) {
        return socket.emit('sendMessageError', { toId, clientId, reason: 'blocked' });
      }

      const msg = await Message.create({
        chatKey: getChatKey(currentUserId, toId), groupId: null, from: currentUserId, to: toId,
        text: cleanText, image: img.image, type: img.image ? 'image' : 'text'
      });

      const msgData = { ...serializeMessage(msg), clientId };
      io.to(currentUserId).emit('newMessage', { chatWith: toId, msg: msgData });
      io.to(toId).emit('newMessage', { chatWith: currentUserId, msg: msgData });
    } catch (err) {
      logger.error('Send message error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('sendMessageError', { toId, clientId, reason: 'server_error' });
    }
  });

  socket.on('markRead', async (friendId) => {
    try {
      if (typeof friendId !== 'string' || !USER_ID_RE.test(friendId)) return;
      const BATCH = 1000;
      let total = 0;
      let rows;
      do {
        rows = await sequelize.query(
          `UPDATE "messages" SET read = true
           WHERE id IN (
             SELECT id FROM "messages"
             WHERE chat_key = :chatKey AND "to" = :toId AND read = false AND group_id IS NULL
             LIMIT :batch
           ) RETURNING id`,
          {
            replacements: { chatKey: getChatKey(currentUserId, friendId), toId: currentUserId, batch: BATCH },
            type: sequelize.QueryTypes.SELECT
          }
        );
        total += rows.length;
      } while (rows.length === BATCH);

      if (total > 0) {
        // NEW: отправитель видит "прочитано", остальные вкладки сбрасывают счётчик
        io.to(friendId).emit('messagesRead', { by: currentUserId, count: total });
        socket.to(currentUserId).emit('unreadCleared', { chatWith: friendId });
      }
    } catch (err) { logger.error('Mark read error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // NEW: индикатор набора текста
  socket.on('typing', async ({ toId, groupId, isTyping } = {}) => {
    try {
      if (!canTyping(currentUserId)) return;
      const payload = { from: currentUserId, isTyping: !!isTyping };
      if (typeof toId === 'string' && USER_ID_RE.test(toId)) {
        const me = await User.findByPk(currentUserId, { attributes: ['friends'] });
        if (!me || !me.friends.includes(toId)) return;
        io.to(toId).emit('typing', payload);
      } else if (typeof groupId === 'string' && UUID_RE.test(groupId)) {
        if (!(await ensureGroupRoom(groupId))) return;
        socket.to(`group:${groupId}`).emit('typing', { ...payload, groupId });
      }
    } catch (err) { logger.error('Typing error', { socketId: socket.id, error: err.message }); }
  });

  // ─── Group Messages ─────────────────────────────────────────────────────────
  socket.on('groupMessage', async ({ groupId, text, image, clientId } = {}) => {
    try {
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      if (text !== undefined && text !== null && typeof text !== 'string') return;
      const cleanText = (text || '').trim();
      const img = validateImagePayload(image);
      if (!img.ok) return socket.emit('sendMessageError', { groupId, clientId, reason: img.reason });
      if (!cleanText && !img.image) return;
      if (cleanText.length > MAX_TEXT_LENGTH) return socket.emit('sendMessageError', { groupId, clientId, reason: 'text_too_long' });

      if (!(await ensureGroupRoom(groupId))) return socket.emit('sendMessageError', { groupId, clientId, reason: 'not_member' });

      const msg = await Message.create({
        chatKey: null, groupId, from: currentUserId, to: null,
        text: cleanText, image: img.image, type: img.image ? 'image' : 'text'
      });
      // отправитель свои сообщения "прочитал"
      await GroupReadState.upsert({ groupId, userId: currentUserId, lastReadAt: msg.createdAt });

      io.to(`group:${groupId}`).emit('newGroupMessage', { groupId, msg: { ...serializeMessage(msg), clientId } });
    } catch (err) {
      logger.error('Group message error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('sendMessageError', { groupId, clientId, reason: 'server_error' });
    }
  });

  socket.on('markGroupRead', async (groupId) => {
    try {
      if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      if (!(await ensureGroupRoom(groupId))) return;
      // FIX: раньше ставился общий флаг read на сообщениях — прочтение одним
      // участником обнуляло непрочитанные у всех
      await GroupReadState.upsert({ groupId, userId: currentUserId, lastReadAt: new Date() });
      socket.to(currentUserId).emit('unreadCleared', { groupId });
    } catch (err) { logger.error('Mark group read error', { socketId: socket.id, error: err.message, stack: err.stack }); }
  });

  // ─── Group Management ───────────────────────────────────────────────────────
  socket.on('addGroupMember', async ({ groupId, userId } = {}) => {
    try {
      if (!canGroupAction(currentUserId)) return socket.emit('groupError', { reason: 'rate_limited' });
      if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return;
      if (userId === currentUserId) return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership) return socket.emit('groupError', { groupId, reason: 'not_member' });
      if (membership.role !== 'owner') return socket.emit('groupError', { groupId, reason: 'not_owner' });

      const memberCount = await GroupMember.count({ where: { groupId } });
      if (memberCount >= MAX_GROUP_MEMBERS) return socket.emit('groupError', { groupId, reason: 'limit_reached' });

      const [owner, target] = await Promise.all([User.findByPk(currentUserId), User.findByPk(userId)]);
      if (!owner || !owner.friends.includes(userId)) return socket.emit('groupError', { groupId, reason: 'not_friends' });
      if (!target) return socket.emit('groupError', { groupId, reason: 'not_found' });
      if (target.blockedUsers.includes(currentUserId) || owner.blockedUsers.includes(userId)) {
        return socket.emit('groupError', { groupId, reason: 'blocked' });
      }
      // FIX: лимит групп проверяем и для добавляемого
      const targetGroupCount = await GroupMember.count({ where: { userId } });
      if (targetGroupCount >= MAX_GROUPS_PER_USER) return socket.emit('groupError', { groupId, reason: 'target_limit_reached' });

      const [, created] = await GroupMember.findOrCreate({ where: { groupId, userId }, defaults: { role: 'member' } });
      if (!created) return socket.emit('groupError', { groupId, reason: 'already_member' });
      await GroupReadState.upsert({ groupId, userId, lastReadAt: new Date() });

      joinUserToGroupRoom(userId, groupId);

      io.to(`group:${groupId}`).emit('groupMemberJoined', {
        groupId,
        user: { id: userId, nickname: target.nickname, avatar: target.avatar, online: isOnline(userId), role: 'member' }
      });
      const groupData = await getGroupWithMembers(groupId);
      io.to(userId).emit('addedToGroup', { group: groupData });
      emitGroupVoiceState(groupId, userId);
    } catch (err) {
      logger.error('Add group member error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('groupError', { groupId, reason: 'server_error' });
    }
  });

  socket.on('leaveGroup', async (groupId) => {
    try {
      if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership) return;
      const group = await Group.findByPk(groupId);
      if (!group) return;

      if (membership.role === 'owner') {
        const avatarToDelete = group.avatar;
        await sequelize.transaction(async (t) => {
          await Message.destroy({ where: { groupId }, transaction: t });
          await GroupReadState.destroy({ where: { groupId }, transaction: t });
          await GroupMember.destroy({ where: { groupId }, transaction: t });
          await group.destroy({ transaction: t });
        });
        if (avatarToDelete) await deleteUploadedFile(avatarToDelete);

        // FIX: завершаем активный звонок группы
        const call = activeCalls.get(groupChatKey(groupId));
        if (call) endCall(call, 'group_deleted');

        const room = `group:${groupId}`;
        io.to(room).emit('groupDeleted', { groupId });
        for (const sid of [...(io.sockets.adapter.rooms.get(room) || [])]) {
          const s = io.sockets.sockets.get(sid);
          if (s) { s.groupIds?.delete(groupId); s.leave(room); }
        }
      } else {
        await membership.destroy();
        await GroupReadState.destroy({ where: { groupId, userId: currentUserId } });
        const call = activeCalls.get(groupChatKey(groupId));
        if (call) leaveCall(currentUserId, call.callId, 'left_group');
        leaveUserFromGroupRoom(currentUserId, groupId);
        io.to(`group:${groupId}`).emit('groupMemberLeft', { groupId, userId: currentUserId });
        io.to(currentUserId).emit('groupDeleted', { groupId }); // все вкладки вышедшего
      }
    } catch (err) {
      logger.error('Leave group error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('groupError', { groupId, reason: 'server_error' });
    }
  });

  socket.on('kickGroupMember', async ({ groupId, userId } = {}) => {
    try {
      if (!canGroupAction(currentUserId)) return socket.emit('groupError', { reason: 'rate_limited' });
      if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
      if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return;
      if (userId === currentUserId) return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership || membership.role !== 'owner') return socket.emit('groupError', { groupId, reason: 'not_owner' });

      const targetMembership = await GroupMember.findOne({ where: { groupId, userId } });
      if (!targetMembership) return;

      await targetMembership.destroy();
      await GroupReadState.destroy({ where: { groupId, userId } });

      // FIX: выкидываем и из активного звонка группы
      const call = activeCalls.get(groupChatKey(groupId));
      if (call) leaveCall(userId, call.callId, 'kicked');
      leaveUserFromGroupRoom(userId, groupId);

      io.to(`group:${groupId}`).emit('groupMemberLeft', { groupId, userId, kicked: true });
      io.to(userId).emit('groupDeleted', { groupId, kicked: true });
    } catch (err) {
      logger.error('Kick member error', { socketId: socket.id, error: err.message, stack: err.stack });
      socket.emit('groupError', { groupId, reason: 'server_error' });
    }
  });

  // ─── Calls (WebRTC signaling) ──────────────────────────────────────────────
  socket.on('callStart', async ({ toId, groupId, video } = {}) => {
    try {
      if (typeof toId === 'string' && USER_ID_RE.test(toId)) {
        if (toId === currentUserId) return socket.emit('callError', { reason: 'bad_request' });
        const [me, target] = await Promise.all([
          User.findByPk(currentUserId, { attributes: ['id', 'nickname', 'avatar', 'friends', 'blockedUsers'] }),
          User.findByPk(toId, { attributes: ['id', 'blockedUsers'] })
        ]);
        if (!me || !target || !me.friends.includes(toId)) return socket.emit('callError', { reason: 'not_friend' });
        // FIX: не учитывалась блокировка со стороны собеседника
        if (me.blockedUsers.includes(toId) || target.blockedUsers.includes(currentUserId)) {
          return socket.emit('callError', { reason: 'blocked' });
        }
        const chatKey = dmChatKey(currentUserId, toId);
        if (activeCalls.has(chatKey)) return socket.emit('callError', { reason: 'busy' });

        const call = {
          callId: crypto.randomUUID(), type: 'dm', chatKey, video: !!video,
          initiator: currentUserId, targetId: toId, answered: false,
          participants: new Set([currentUserId]), createdAt: Date.now()
        };
        registerCall(call);
        socket.join(`call:${call.callId}`);
        socket.activeCallKeys.add(chatKey);

        socket.emit('callStarted', { callId: call.callId, chatKey });
        const invitation = {
          callId: call.callId, chatKey, isGroup: false, video: !!video,
          from: currentUserId, fromNick: me.nickname, fromAvatar: me.avatar, createdAt: Date.now()
        };
        if (isOnline(toId)) io.to(toId).emit('incomingCall', invitation);
        else {
          const queued = pendingCalls.get(toId) || [];
          queued.push(invitation);
          pendingCalls.set(toId, queued.slice(-10));
        }
      } else if (typeof groupId === 'string' && UUID_RE.test(groupId)) {
        if (!(await ensureGroupRoom(groupId))) return socket.emit('callError', { reason: 'not_member' });
        const chatKey = groupChatKey(groupId);
        const me = await User.findByPk(currentUserId, { attributes: ['id', 'nickname', 'avatar'] });
        if (!me) return;

        let call = activeCalls.get(chatKey);
        if (!call) {
          call = {
            callId: crypto.randomUUID(), type: 'group', chatKey, groupId, video: !!video,
            initiator: currentUserId, participants: new Set(), createdAt: Date.now()
          };
          registerCall(call);
          io.to(`group:${groupId}`).except(socket.id).emit('incomingCall', {
            callId: call.callId, chatKey, isGroup: true, groupId, video: !!video,
            from: currentUserId, fromNick: me.nickname, fromAvatar: me.avatar, createdAt: Date.now()
          });
          emitGroupVoiceState(groupId);
        }
        socket.emit('callStarted', { callId: call.callId, chatKey });
      } else {
        socket.emit('callError', { reason: 'bad_request' });
      }
    } catch (err) {
      logger.error('callStart error', { error: err.message, stack: err.stack });
      socket.emit('callError', { reason: 'server_error' });
    }
  });

  socket.on('callJoin', async ({ callId } = {}) => {
    try {
      const call = findCallById(callId);
      if (!call) return socket.emit('callError', { reason: 'not_found', callId });

      if (call.type === 'dm') {
        if (currentUserId !== call.initiator && currentUserId !== call.targetId) {
          return socket.emit('callError', { reason: 'forbidden', callId });
        }
        if (currentUserId === call.targetId) {
          call.answered = true;
          removePendingInvite(currentUserId, call.callId);
        }
      } else if (!(await isGroupMember(currentUserId, call.groupId))) {
        return socket.emit('callError', { reason: 'forbidden', callId });
      }

      const existingPeers = [...call.participants].filter(id => id !== currentUserId);
      call.participants.add(currentUserId);
      socket.join(`call:${call.callId}`);
      socket.activeCallKeys.add(call.chatKey);

      socket.emit('callParticipants', { callId: call.callId, chatKey: call.chatKey, video: call.video, participants: existingPeers });
      socket.to(`call:${call.callId}`).emit('peerJoined', { callId: call.callId, peerId: currentUserId });
      if (call.type === 'group') emitGroupVoiceState(call.groupId);
    } catch (err) {
      logger.error('callJoin error', { error: err.message, stack: err.stack });
      socket.emit('callError', { reason: 'server_error' });
    }
  });

  socket.on('callReject', async ({ callId } = {}) => {
    try {
      const call = findCallById(callId);
      if (!call) return;
      if (call.type === 'dm') {
        // FIX: отклонить может только адресат
        if (currentUserId !== call.targetId) return;
        io.to(call.initiator).emit('callRejected', { callId: call.callId, peerId: currentUserId });
        endCall(call, 'rejected');
      } else {
        if (!(await isGroupMember(currentUserId, call.groupId))) return;
        socket.to(`call:${call.callId}`).emit('callRejected', { callId: call.callId, peerId: currentUserId });
      }
    } catch (err) { logger.error('callReject error', { error: err.message }); }
  });

  socket.on('watchGroupVoice', async ({ groupId } = {}) => {
    if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) return;
    if (!(await ensureGroupRoom(groupId))) return;
    emitGroupVoiceState(groupId, socket);
  });

  socket.on('callSignal', ({ callId, to, data } = {}) => {
    const call = findCallById(callId);
    if (!call || typeof to !== 'string' || data === undefined) return;
    // FIX: сигналить можно только участникам этого же звонка
    if (!call.participants.has(currentUserId) || !call.participants.has(to) || to === currentUserId) return;
    io.to(to).emit('callSignal', { callId: call.callId, from: currentUserId, data });
  });

  socket.on('callLeave', ({ callId } = {}) => {
    const call = findCallById(callId);
    if (!call) return;
    // инициатор DM отменяет до ответа
    if (call.type === 'dm' && !call.answered && currentUserId === call.initiator) return endCall(call, 'cancelled');
    leaveCall(currentUserId, callId, 'left');
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    if (expiryTimer) clearTimeout(expiryTimer);

    const wentOffline = markOffline(currentUserId, socket.id);

    for (const chatKey of [...socket.activeCallKeys]) {
      const call = activeCalls.get(chatKey);
      if (!call) continue;
      // если у пользователя остались другие сокеты в комнате звонка — не выкидываем
      const stillInRoom = userSockets(currentUserId).some(s => s.rooms.has(`call:${call.callId}`));
      if (stillInRoom) continue;
      if (call.type === 'dm' && !call.answered && currentUserId === call.initiator) endCall(call, 'cancelled');
      else leaveCall(currentUserId, call.callId, 'disconnected');
    }

    if (!wentOffline) return;
    try {
      const user = await User.findByPk(currentUserId, { attributes: ['friends'] });
      if (user) user.friends.forEach(fId => io.to(fId).emit('friendOffline', currentUserId));
    } catch (err) { logger.error('Disconnect error', { socketId: socket.id, error: err.message, stack: err.stack }); }
    logger.info(`[offline] ${currentUserId}`);
  });
});

// ─── Schema migration (additive, idempotent) ──────────────────────────────────
async function ensureSchema() {
  const qi = sequelize.getQueryInterface();

  try {
    await sequelize.query(`
      DO $$ BEGIN
        CREATE TYPE "enum_group_members_role" AS ENUM ('owner', 'member');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS "groups" (
        "id" UUID PRIMARY KEY,
        "name" VARCHAR(${MAX_GROUP_NAME_LENGTH}) NOT NULL,
        "avatar" VARCHAR(255),
        "owner_id" VARCHAR(255) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS "group_members" (
        "id" UUID PRIMARY KEY,
        "group_id" UUID NOT NULL,
        "user_id" VARCHAR(255) NOT NULL,
        "role" "enum_group_members_role" DEFAULT 'member',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "group_members_group_id_user_id" ON "group_members" ("group_id", "user_id");`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS "group_members_user_id" ON "group_members" ("user_id");`);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS "group_read_states" (
        "group_id" UUID NOT NULL,
        "user_id" VARCHAR(255) NOT NULL,
        "last_read_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY ("group_id", "user_id")
      );
    `);
    logger.info('✅ Миграция: таблицы groups/group_members/group_read_states проверены');
  } catch (err) {
    logger.error('❌ Ошибка миграции (groups)', { error: err.message, stack: err.stack });
  }

  try {
    const tables = await qi.showAllTables();
    const tableSet = new Set(tables.map(t => (typeof t === 'string' ? t : t.tableName)));

    if (tableSet.has('messages')) {
      const cols = await qi.describeTable('messages');
      if (!cols.group_id) {
        logger.info('🔧 Миграция: добавляю колонку messages.group_id');
        await qi.addColumn('messages', 'group_id', { type: DataTypes.UUID, allowNull: true });
      }
      for (const col of ['chat_key', 'group_id', 'to', 'image']) {
        if (cols[col] && cols[col].allowNull === false) {
          logger.info(`🔧 Миграция: снимаю NOT NULL с messages.${col}`);
          await sequelize.query(`ALTER TABLE "messages" ALTER COLUMN "${col}" DROP NOT NULL;`);
        }
      }
    }
    if (tableSet.has('users')) {
      const cols = await qi.describeTable('users');
      if (!cols.password_changed_at) {
        logger.info('🔧 Миграция: добавляю колонку users.password_changed_at');
        await qi.addColumn('users', 'password_changed_at', { type: DataTypes.DATE, allowNull: true });
      }
    }
  } catch (err) {
    logger.error('❌ Ошибка миграции (колонки)', { error: err.message, stack: err.stack });
  }

  const indexes = [
    ['messages_chat_key_created_at', 'messages', '"chat_key", "created_at"'],
    ['messages_group_id_created_at', 'messages', '"group_id", "created_at"'],
    ['messages_to_read', 'messages', '"to", "read"'],
    ['messages_from', 'messages', '"from"']
  ];
  for (const [name, table, cols] of indexes) {
    try {
      await sequelize.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${cols});`);
    } catch (err) {
      logger.warn(`Не удалось создать индекс ${name}`, { error: err.message });
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  const connected = await connectWithRetry();
  if (connected) {
    if (process.env.NODE_ENV === 'production') {
      try {
        await sequelize.sync();
        logger.info('✅ sequelize.sync() выполнен (production)');
      } catch (err) {
        logger.error('⚠️  sequelize.sync() завершился с ошибкой (ensureSchema подстрахует)', { error: err.message });
      }
      try {
        await ensureSchema();
        logger.info('✅ Схема проверена (production)');
      } catch (err) {
        logger.error('❌ ensureSchema() error', { error: err.message, stack: err.stack });
      }
    } else {
      try {
        await sequelize.sync({ alter: true });
        logger.info('✅ Таблицы синхронизированы (dev, alter: true)');
      } catch (err) {
        logger.error('❌ Sync error', { error: err.message, stack: err.stack });
      }
    }
  } else {
    logger.warn('⚠️  Сервер запускается без подтверждённого подключения к БД.');
  }

  server.listen(PORT, () => logger.info(`✅ Сервер запущен на http://localhost:${PORT}`));
})();

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: err?.message || String(err), stack: err?.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — завершение процесса', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException', 1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;
function gracefulShutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Получен ${signal}, штатная остановка сервера...`);

  // FIX: io.close() сам закрывал http-сервер, и server.close() вызывался дважды
  io.disconnectSockets(true);
  server.close(async () => {
    try {
      await sequelize.close();
      logger.info('Соединение с БД закрыто, выход.');
      process.exit(exitCode);
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
process.on('SIGINT', () => gracefulShutdown('SIGINT'));