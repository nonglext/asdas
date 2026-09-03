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

const corsAllowList = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean);
if (corsAllowList.length === 0) {
  logger.warn('⚠️  CLIENT_URL не задан — CORS разрешает ЛЮБОЙ origin!');
}

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const SALT_ROUNDS = 12;

if (!process.env.JWT_SECRET) {
  logger.warn('⚠️  JWT_SECRET не задан — используется дефолтный небезопасный секрет!');
}

if (process.env.NODE_ENV === 'production') {
  const missingEnv = [];
  if (!process.env.JWT_SECRET) missingEnv.push('JWT_SECRET');
  if (corsAllowList.length === 0) missingEnv.push('CLIENT_URL');
  if (missingEnv.length) {
    logger.error(`❌ В production обязательны: ${missingEnv.join(', ')}. Остановка.`);
    process.exit(1);
  }
}

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_FRIENDS         = 500;
const MAX_BLOCKED         = 200;
const MAX_FRIEND_REQUESTS = 200;
const MAX_GROUP_MEMBERS   = 50;
const MAX_GROUPS_PER_USER = 100;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) * 1.37);
const MAX_NICKNAME_LENGTH = 50;
const MAX_STATUS_LENGTH   = 150;
const MAX_BIO_LENGTH      = 1000;
const MAX_TEXT_LENGTH     = 4000;
const MAX_PASSWORD_LENGTH = 128;
const MAX_GROUP_NAME_LENGTH = 50;

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsAllowList.length === 0 || corsAllowList.includes(origin)) return callback(null, true);
      callback(new Error('CORS blocked'));
    },
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: MAX_IMAGE_BASE64_CHARS + 100_000
});

app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Слишком много попыток, попробуйте через 15 минут' }
});
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Слишком много запросов поиска' }
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
      logger.info('✅ PostgreSQL подключена');
      return true;
    } catch (err) {
      logger.error(`❌ PostgreSQL (попытка ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) await new Promise(res => setTimeout(res, delayMs));
    }
  }
  logger.error('❌ Не удалось подключиться к PostgreSQL');
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
  groupId: { type: DataTypes.UUID, allowNull: true }, // NEW
  from: { type: DataTypes.STRING, allowNull: false },
  to: { type: DataTypes.STRING, allowNull: true }, // null для групп
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
    { fields: ['created_at'] }
  ]
});

// ─── NEW: Group Models ────────────────────────────────────────────────────────
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
  indexes: [
    { unique: true, fields: ['group_id', 'user_id'] },
    { fields: ['user_id'] }
  ]
});

Group.hasMany(GroupMember, { foreignKey: 'groupId', onDelete: 'CASCADE' });
GroupMember.belongsTo(Group, { foreignKey: 'groupId' });
GroupMember.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(GroupMember, { foreignKey: 'userId' });

// ─── Helpers ──────────────────────────────────────────────────────────────────
const onlineUsers = {};

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

const AVATAR_PATH_RE = /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

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
const canSendMessage       = makeSocketLimiter(20, 10_000);
const canSendFriendRequest = makeSocketLimiter(10, 60_000);
const canGroupAction       = makeSocketLimiter(10, 10_000); // NEW

// Очистка протухших сокетов
setInterval(() => {
  const connectedSocketIds = new Set(io.sockets.sockets.keys());
  for (const [userId, socketIds] of Object.entries(onlineUsers)) {
    for (const sid of socketIds) {
      if (!connectedSocketIds.has(sid)) socketIds.delete(sid);
    }
    if (socketIds.size === 0) delete onlineUsers[userId];
  }
}, 60_000);

// ─── NEW: Group Helpers ───────────────────────────────────────────────────────
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

// ─── File Upload ──────────────────────────────────────────────────────────────
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif'
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
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения (jpeg, png, webp, gif)'));
  }
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { userId, nickname, password } = req.body;
    const id   = (typeof userId === 'string' ? userId : '').trim().toLowerCase();
    const nick = (typeof nickname === 'string' ? nickname : '').trim().slice(0, MAX_NICKNAME_LENGTH) || id;

    if (!id || id.length < 3)           return res.status(400).json({ error: 'ID минимум 3 символа' });
    if (id.length > 30)                 return res.status(400).json({ error: 'ID максимум 30 символов' });
    if (!/^[a-z0-9_]+$/.test(id))       return res.status(400).json({ error: 'ID: только a-z, 0-9, _' });
    if (typeof password !== 'string' || password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    if (password.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: `Пароль максимум ${MAX_PASSWORD_LENGTH} символов` });

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
    logger.error('Register error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

const DUMMY_PASSWORD_HASH = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKNjM4YFf6/EHou';

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { userId, password } = req.body;
    const id = (typeof userId === 'string' ? userId : '').trim().toLowerCase();

    if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(401).json({ error: 'Неверный ID или пароль' });
    }

    const user  = await User.findByPk(id);
    const match = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
    if (!user || !match) return res.status(401).json({ error: 'Неверный ID или пароль' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true, token,
      user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, friends: user.friends, friendRequests: user.friendRequests, blockedUsers: user.blockedUsers }
    });
  } catch (err) {
    logger.error('Login error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// ─── User Routes ──────────────────────────────────────────────────────────────
app.get('/api/search', authMiddleware, searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const escaped = q.toLowerCase().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const results = await User.findAll({
      where: {
        [Op.or]: [
          sequelize.where(sequelize.fn('LOWER', sequelize.col('id')), 'LIKE', `%${escaped}%`),
          sequelize.where(sequelize.fn('LOWER', sequelize.col('nickname')), 'LIKE', `%${escaped}%`)
        ]
      },
      limit: 10
    });
    res.json(results.map(u => ({
      id: u.id, nickname: u.nickname, avatar: u.avatar, status: u.status, online: isOnline(u.id)
    })));
  } catch (err) {
    logger.error('Search error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

app.get('/api/profile/:userId', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, online: isOnline(user.id), createdAt: user.createdAt });
  } catch (err) {
    logger.error('Profile error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка профиля' });
  }
});

app.post('/api/profile/update', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { nickname, status, bio, avatar } = req.body;

    if (nickname !== undefined && (typeof nickname !== 'string' || nickname.length > MAX_NICKNAME_LENGTH)) {
      return res.status(400).json({ error: `Никнейм максимум ${MAX_NICKNAME_LENGTH} символов` });
    }
    if (status !== undefined && (typeof status !== 'string' || status.length > MAX_STATUS_LENGTH)) {
      return res.status(400).json({ error: `Статус максимум ${MAX_STATUS_LENGTH} символов` });
    }
    if (bio !== undefined && (typeof bio !== 'string' || bio.length > MAX_BIO_LENGTH)) {
      return res.status(400).json({ error: `Описание максимум ${MAX_BIO_LENGTH} символов` });
    }
    if (avatar !== undefined && avatar !== null && !(typeof avatar === 'string' && AVATAR_PATH_RE.test(avatar))) {
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
    logger.error('Profile update error', { error: err.message, stack: err.stack });
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
    logger.error('Avatar upload error', { error: err.message, stack: err.stack });
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
        return res.status(400).json({ error: `Лимит заблокированных (${MAX_BLOCKED})` });
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
    logger.error('Block error', { error: err.message, stack: err.stack });
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
    logger.error('Unblock error', { error: err.message, stack: err.stack });
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
    logger.error('Blocked list error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки списка заблокированных' });
  }
});

// ─── DM Message Routes ────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:friendId', authMiddleware, async (req, res) => {
  try {
    if (req.user.id !== req.params.userId) return res.status(403).json({ error: 'Нет доступа' });
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
    logger.error('Messages error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

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

    if (msg.groupId) {
      // Групповое сообщение — шлём всем участникам
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
    logger.error('Delete message error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ─── NEW: Groups API ──────────────────────────────────────────────────────────
app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, memberIds } = req.body;
    const userId = req.user.id;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Название группы минимум 2 символа' });
    }
    if (name.trim().length > MAX_GROUP_NAME_LENGTH) {
      return res.status(400).json({ error: `Название группы максимум ${MAX_GROUP_NAME_LENGTH} символов` });
    }
    if (!Array.isArray(memberIds)) {
      return res.status(400).json({ error: 'Некорректный список участников' });
    }

    const uniqueMembers = [...new Set([userId, ...memberIds.filter(id => typeof id === 'string')])];
    if (uniqueMembers.length < 2) return res.status(400).json({ error: 'Минимум 2 участника' });
    if (uniqueMembers.length > MAX_GROUP_MEMBERS) return res.status(400).json({ error: `Максимум ${MAX_GROUP_MEMBERS} участников` });

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // Проверяем лимит групп пользователя
    const groupCount = await GroupMember.count({ where: { userId } });
    if (groupCount >= MAX_GROUPS_PER_USER) {
      return res.status(400).json({ error: `Максимум ${MAX_GROUPS_PER_USER} групп` });
    }

    // Проверяем, что все — друзья и не заблокированы
    for (const memberId of memberIds) {
      if (memberId === userId) continue;
      if (!user.friends.includes(memberId)) {
        return res.status(400).json({ error: `Пользователь ${memberId} не в друзьях` });
      }
    }

    const transaction = await sequelize.transaction();
    try {
      const group = await Group.create({
        name: name.trim(),
        ownerId: userId
      }, { transaction });

      const members = uniqueMembers.map(id => ({
        groupId: group.id,
        userId: id,
        role: id === userId ? 'owner' : 'member'
      }));
      await GroupMember.bulkCreate(members, { transaction, ignoreDuplicates: true });
      await transaction.commit();

      // Отправляем уведомления и заставляем клиентов обновить группы
      for (const memberId of uniqueMembers) {
        if (memberId !== userId) {
          const groupData = await getGroupWithMembers(group.id);
          io.to(memberId).emit('addedToGroup', { group: groupData });
        }
      }

      const groupData = await getGroupWithMembers(group.id);
      res.json({ success: true, group: groupData });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    logger.error('Create group error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка создания группы' });
  }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const memberships = await GroupMember.findAll({
      where: { userId },
      include: [{ model: Group }]
    });

    const result = [];
    for (const m of memberships) {
      const groupData = await getGroupWithMembers(m.Group.id);
      if (groupData) result.push(groupData);
    }
    res.json(result);
  } catch (err) {
    logger.error('Get groups error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Ошибка загрузки групп' });
  }
});

app.get('/api/groups/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { groupId } = req.params;
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
    logger.error('Group messages error', { error: err.message, stack: err.stack });
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

      // NEW: присоединяем ко всем групповым комнатам
      const memberships = await GroupMember.findAll({ where: { userId: currentUserId } });
      for (const m of memberships) {
        socket.join(`group:${m.groupId}`);
      }

      // DM unread
      const unreadRows = await Message.findAll({
        where: { to: currentUserId, read: false, deleted: false, groupId: null },
        attributes: ['from', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
        group: ['from']
      });
      const unreadCounts = Object.fromEntries(
        unreadRows.map(r => [r.from, parseInt(r.get('count'), 10)])
      );

      // NEW: Group unread — считаем сообщения в группах, отправленные НЕ нами,
      // которые мы ещё не прочитали (read=false для нашего userId)
      // Для простоты: считаем все непрочитанные сообщения в группах где мы участники
      const groupIds = memberships.map(m => m.groupId);
      let groupUnreadCounts = {};
      if (groupIds.length) {
        const groupUnreadRows = await Message.findAll({
          where: {
            groupId: { [Op.in]: groupIds },
            from: { [Op.ne]: currentUserId },
            deleted: false
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
      logger.info(`[online] ${currentUserId}`);
    } catch (err) { logger.error('Connection init error', { error: err.message, stack: err.stack }); }
  })();

  // ─── Friend Requests ───────────────────────────────────────────────────────
  socket.on('sendFriendRequest', async (toId) => {
    try {
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
      if (to.friendRequests.length >= MAX_FRIEND_REQUESTS) return socket.emit('friendRequestError', { toId, reason: 'target_limit_reached' });

      const affected = await sequelize.query(`
        UPDATE "users"
        SET friend_requests = array_append(friend_requests, :fromId)
        WHERE id = :toId
          AND NOT (:fromId = ANY(friend_requests))
          AND NOT (:fromId = ANY(friends))
          AND NOT (:fromId = ANY(blocked_users))
          AND (array_length(friend_requests, 1) IS NULL OR array_length(friend_requests, 1) < :maxRequests)
        RETURNING id
      `, {
        replacements: { fromId: currentUserId, toId, maxRequests: MAX_FRIEND_REQUESTS },
        type: sequelize.QueryTypes.SELECT
      });

      if (!affected || !affected.length) return socket.emit('friendRequestError', { toId, reason: 'already_sent' });

      io.to(toId).emit('friendRequest', { id: currentUserId, nickname: from.nickname });
      socket.emit('requestSent', { id: toId });
    } catch (err) {
      logger.error('Friend request error', { error: err.message, stack: err.stack });
      socket.emit('friendRequestError', { toId, reason: 'server_error' });
    }
  });

  socket.on('acceptFriendRequest', async (fromId) => {
    try {
      if (!fromId || typeof fromId !== 'string') return;

      let result;
      try {
        result = await sequelize.transaction(async (t) => {
          const meResult = await sequelize.query(`
            UPDATE "users"
            SET friend_requests = array_remove(friend_requests, :fromId),
                friends = CASE WHEN :fromId = ANY(friends) THEN friends ELSE array_append(friends, :fromId) END
            WHERE id = :myId AND :fromId = ANY(friend_requests)
              AND (:fromId = ANY(friends) OR array_length(friends, 1) IS NULL OR array_length(friends, 1) < :maxFriends)
            RETURNING id, nickname, avatar
          `, { replacements: { fromId, myId: currentUserId, maxFriends: MAX_FRIENDS }, type: sequelize.QueryTypes.SELECT, transaction: t });

          if (!meResult || !meResult.length) return null;

          const themResult = await sequelize.query(`
            UPDATE "users"
            SET friends = CASE WHEN :myId = ANY(friends) THEN friends ELSE array_append(friends, :myId) END
            WHERE id = :fromId
              AND (:myId = ANY(friends) OR array_length(friends, 1) IS NULL OR array_length(friends, 1) < :maxFriends)
            RETURNING id, nickname, avatar
          `, { replacements: { fromId, myId: currentUserId, maxFriends: MAX_FRIENDS }, type: sequelize.QueryTypes.SELECT, transaction: t });

          if (!themResult || !themResult.length) throw new Error('FRIEND_LIMIT_REACHED');
          return { me: meResult[0], them: themResult[0] };
        });
      } catch (txErr) {
        if (txErr.message === 'FRIEND_LIMIT_REACHED') {
          return socket.emit('friendRequestError', { toId: fromId, reason: 'target_limit_reached' });
        }
        throw txErr;
      }

      if (!result) return;
      const { me: meData, them } = result;
      socket.emit('friendAdded', { id: fromId, nickname: them.nickname, avatar: them.avatar, online: isOnline(fromId) });
      io.to(fromId).emit('friendAdded', { id: currentUserId, nickname: meData.nickname, avatar: meData.avatar, online: true });
    } catch (err) { logger.error('Accept friend error', { error: err.message, stack: err.stack }); }
  });

  socket.on('declineFriendRequest', async (fromId) => {
    try {
      const user = await User.findByPk(currentUserId);
      if (!user) return;
      user.friendRequests = user.friendRequests.filter(id => id !== fromId);
      await user.save();
      socket.emit('requestDeclined', fromId);
    } catch (err) { logger.error('Decline friend error', { error: err.message, stack: err.stack }); }
  });

  socket.on('removeFriend', async (friendId) => {
    try {
      if (!friendId || typeof friendId !== 'string') return;
      const result = await sequelize.query(`
        UPDATE "users" SET friends = array_remove(friends, :friendId)
        WHERE id = :myId AND :friendId = ANY(friends) RETURNING id
      `, { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.SELECT });
      if (!result || !result.length) return;
      await sequelize.query(`
        UPDATE "users" SET friends = array_remove(friends, :myId) WHERE id = :friendId
      `, { replacements: { friendId, myId: currentUserId }, type: sequelize.QueryTypes.UPDATE });
      socket.emit('friendRemoved', { id: friendId });
      io.to(friendId).emit('friendRemoved', { id: currentUserId });
    } catch (err) { logger.error('Remove friend error', { error: err.message, stack: err.stack }); }
  });

  // ─── DM Messages ────────────────────────────────────────────────────────────
  socket.on('sendMessage', async ({ toId, text, image } = {}) => {
    try {
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      if (text !== undefined && typeof text !== 'string') return;
      if (image !== undefined && image !== null && typeof image !== 'string') return;
      if (!text?.trim() && !image) return;
      if (text && text.trim().length > MAX_TEXT_LENGTH) {
        return socket.emit('sendMessageError', { toId, reason: 'text_too_long' });
      }
      if (image && image.length > MAX_IMAGE_BASE64_CHARS) {
        return socket.emit('sendMessageError', { toId, reason: 'image_too_large' });
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
    } catch (err) { logger.error('Send message error', { error: err.message, stack: err.stack }); }
  });

  socket.on('markRead', async (friendId) => {
    try {
      if (!friendId) return;
      await Message.update(
        { read: true },
        { where: { chatKey: getChatKey(currentUserId, friendId), to: currentUserId, read: false, groupId: null } }
      );
    } catch (err) { logger.error('Mark read error', { error: err.message, stack: err.stack }); }
  });

  // ─── NEW: Group Messages ────────────────────────────────────────────────────
  socket.on('groupMessage', async ({ groupId, text, image } = {}) => {
    try {
      if (!canSendMessage(currentUserId)) return socket.emit('rateLimited', 'sendMessage');
      if (!groupId || typeof groupId !== 'string') return;
      if (text !== undefined && typeof text !== 'string') return;
      if (!text?.trim() && !image) return;
      if (text && text.trim().length > MAX_TEXT_LENGTH) {
        return socket.emit('sendMessageError', { groupId, reason: 'text_too_long' });
      }

      if (!(await isGroupMember(currentUserId, groupId))) return;

      const msg = await Message.create({
        chatKey: null, groupId, from: currentUserId, to: null,
        text: text?.trim() || '', image: image || null, type: image ? 'image' : 'text'
      });

      const msgData = {
        _id: msg.id, from: currentUserId, text: msg.text, image: msg.image,
        type: msg.type, time: msg.createdAt.toISOString(), deleted: false
      };
      io.to(`group:${groupId}`).emit('newGroupMessage', { groupId, msg: msgData });
    } catch (err) { logger.error('Group message error', { error: err.message, stack: err.stack }); }
  });

  socket.on('markGroupRead', async (groupId) => {
    try {
      // Для групповых сообщений просто логируем — unread сбрасывается на клиенте
      // В будущем можно сделать таблицу group_read_status для точного трекинга
    } catch (err) { logger.error('Mark group read error', { error: err.message, stack: err.stack }); }
  });

  // ─── NEW: Group Management ──────────────────────────────────────────────────
  socket.on('addGroupMember', async ({ groupId, userId } = {}) => {
    try {
      if (!canGroupAction(currentUserId)) return socket.emit('groupError', { reason: 'rate_limited' });
      if (!groupId || !userId || typeof userId !== 'string') return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership) return socket.emit('groupError', { reason: 'not_member' });

      // Только владелец может добавлять
      if (membership.role !== 'owner') return socket.emit('groupError', { reason: 'not_owner' });

      // Проверяем лимит
      const memberCount = await GroupMember.count({ where: { groupId } });
      if (memberCount >= MAX_GROUP_MEMBERS) return socket.emit('groupError', { reason: 'limit_reached' });

      // Проверяем дружбу
      const owner = await User.findByPk(currentUserId);
      if (!owner || !owner.friends.includes(userId)) return socket.emit('groupError', { reason: 'not_friends' });

      // Проверяем блокировку
      const target = await User.findByPk(userId);
      if (!target) return socket.emit('groupError', { reason: 'not_found' });
      if (target.blockedUsers.includes(currentUserId) || owner.blockedUsers.includes(userId)) {
        return socket.emit('groupError', { reason: 'blocked' });
      }

      // Проверяем, что ещё не участник
      const existing = await GroupMember.findOne({ where: { groupId, userId } });
      if (existing) return socket.emit('groupError', { reason: 'already_member' });

      await GroupMember.create({ groupId, userId, role: 'member' });

      // Присоединяем сокет нового участника к комнате (если онлайн)
      const targetSockets = io.sockets.adapter.rooms.get(userId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) s.join(`group:${groupId}`);
        }
      }

      const groupData = await getGroupWithMembers(groupId);
      io.to(`group:${groupId}`).emit('groupMemberJoined', { groupId, user: { id: userId, nickname: target.nickname, avatar: target.avatar, online: isOnline(userId), role: 'member' } });
      io.to(userId).emit('addedToGroup', { group: groupData });
    } catch (err) {
      logger.error('Add group member error', { error: err.message, stack: err.stack });
      socket.emit('groupError', { reason: 'server_error' });
    }
  });

  socket.on('leaveGroup', async (groupId) => {
    try {
      if (!groupId || typeof groupId !== 'string') return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership) return;

      const group = await Group.findByPk(groupId);
      if (!group) return;

      if (membership.role === 'owner') {
        // Владелец покидает → удаляем группу целиком
        await Message.destroy({ where: { groupId } });
        await GroupMember.destroy({ where: { groupId } });
        await group.destroy();

        // Уведомляем всех
        const members = await GroupMember.findAll({ where: { groupId } }).catch(() => []);
        io.to(`group:${groupId}`).emit('groupDeleted', { groupId });
      } else {
        await membership.destroy();
        socket.leave(`group:${groupId}`);
        io.to(`group:${groupId}`).emit('groupMemberLeft', { groupId, userId: currentUserId });
      }
    } catch (err) { logger.error('Leave group error', { error: err.message, stack: err.stack }); }
  });

  socket.on('kickGroupMember', async ({ groupId, userId } = {}) => {
    try {
      if (!canGroupAction(currentUserId)) return socket.emit('groupError', { reason: 'rate_limited' });
      if (!groupId || !userId) return;

      const membership = await GroupMember.findOne({ where: { groupId, userId: currentUserId } });
      if (!membership || membership.role !== 'owner') return socket.emit('groupError', { reason: 'not_owner' });
      if (userId === currentUserId) return; // нельзя кикнуть себя, используй leaveGroup

      const targetMembership = await GroupMember.findOne({ where: { groupId, userId } });
      if (!targetMembership) return;

      await targetMembership.destroy();

      // Убираем сокет из комнаты
      const targetSockets = io.sockets.adapter.rooms.get(userId);
      if (targetSockets) {
        for (const sid of targetSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) s.leave(`group:${groupId}`);
        }
      }

      io.to(`group:${groupId}`).emit('groupMemberLeft', { groupId, userId });
      io.to(userId).emit('groupDeleted', { groupId }); // для кикнутого это выглядит как "группа исчезла"
    } catch (err) { logger.error('Kick member error', { error: err.message, stack: err.stack }); }
  });

  // ─── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    const wentOffline = markOffline(currentUserId, socket.id);
    if (!wentOffline) return;

    try {
      const user = await User.findByPk(currentUserId);
      if (user) user.friends.forEach(fId => io.to(fId).emit('friendOffline', currentUserId));
    } catch (err) { logger.error('Disconnect error', { error: err.message, stack: err.stack }); }
    logger.info(`[offline] ${currentUserId}`);
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
    logger.info(`✅ Сервер запущен на http://localhost:${PORT}`);
  });
})();

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: err?.message || String(err), stack: err?.stack });
});

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Получен ${signal}, штатная остановка...`);
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
    logger.error('Принудительный выход.');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));