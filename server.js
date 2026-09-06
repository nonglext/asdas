'use strict';
// Single-process ChatApp backend. Read README before deploying this replacement.
require('dotenv').config();
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { rateLimit } = require('express-rate-limit');
const { Sequelize, DataTypes, Op, QueryTypes } = require('sequelize');
const multer = require('multer');
const sharp = require('sharp');
const helmet = require('helmet');
const cors = require('cors');
const winston = require('winston');
const { friendAction } = require('./lib/friend-policy');

const production = process.env.NODE_ENV === 'production';
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
  transports: [new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error', maxsize: 5_000_000, maxFiles: 3 }),
    new winston.transports.File({ filename: 'combined.log', maxsize: 5_000_000, maxFiles: 3 })]
});
function fail(message) { throw new Error(message); }
function intEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
const PORT = intEnv('PORT', 3000, 1, 65535);
const JWT_SECRET = process.env.JWT_SECRET || (production ? '' : crypto.randomBytes(48).toString('base64url'));
if (Buffer.byteLength(JWT_SECRET) < 32 || JWT_SECRET === 'changethissecretinproduction') fail('Set JWT_SECRET to a random secret of at least 32 bytes');
if (!process.env.JWT_SECRET) logger.warn('Temporary random JWT key: restarting invalidates sessions');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
jwt.sign({ test: true }, JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN });
const origins = (process.env.CLIENT_URL || (production ? '' : `http://localhost:${PORT},http://127.0.0.1:${PORT}`)).split(',').map(s => s.trim()).filter(Boolean);
if (!origins.length) fail('Set CLIENT_URL to your frontend origin');
for (const origin of origins) {
  const u = new URL(origin);
  if (!['https:', 'http:'].includes(u.protocol) || u.origin !== origin) fail('CLIENT_URL must contain exact origins, without trailing slash');
}
const dbUrl = process.env.DATABASE_URL || (production ? '' : 'postgresql://user:password@localhost:5432/chatapp');
if (!dbUrl) fail('Set DATABASE_URL');
const dbHost = new URL(dbUrl).hostname;
const internalRender = /^dpg-[a-z0-9-]+-a$/.test(dbHost);
const ssl = process.env.DATABASE_SSL === 'true' || (process.env.DATABASE_SSL !== 'false' && production && !internalRender);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const TMP_DIR = path.join(UPLOAD_DIR, '.tmp');
const PUBLIC_DIR = path.join(__dirname, 'public');
if (UPLOAD_DIR === PUBLIC_DIR || UPLOAD_DIR.startsWith(PUBLIC_DIR + path.sep)) fail('UPLOAD_DIR must be outside public');
fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_USER_MEDIA_BYTES = intEnv('MAX_USER_MEDIA_BYTES', 100 * 1024 * 1024, MAX_IMAGE_BYTES, 10 * 1024 ** 3);
const MAX_PENDING_UPLOADS = 20;
const PENDING_TTL = 24 * 3600_000;
const MAX_FRIENDS = 500, MAX_REQUESTS = 200, MAX_BLOCKED = 200, MAX_MEMBERS = 50, MAX_GROUPS = 100;
const USER_RE = /^[a-z0-9_]{3,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_RE = /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;
const idOK = x => typeof x === 'string' && USER_RE.test(x);
const uuidOK = x => typeof x === 'string' && UUID_RE.test(x);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x);
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 128 && Buffer.byteLength(p) <= 72 && !p.includes('\0'); }
function clientId(x) { return typeof x === 'string' && /^[\w.-]{1,64}$/.test(x) ? x : undefined; }
function chatKey(a, b) { return [a, b].sort().join('::'); }
function dmKey(a, b) { return `dm:${[a, b].sort().join(':')}`; }
function boundedText(value, max, { required = false, min = 0 } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || value.trim().length < min) throw new ApiError(400, 'Некорректная длина или тип текста', 'bad_request');
  return value.trim();
}
class ApiError extends Error {
  constructor(status, message, reason = 'bad_request') { super(message); this.status = status; this.reason = reason; }
}
function reject(status, message, reason) { throw new ApiError(status, message, reason); }

const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres', logging: false, pool: { max: 5, min: 0, acquire: 20_000, idle: 10_000 }, retry: { max: 0 },
  dialectOptions: { statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000,
    ...(ssl ? { ssl: { require: true, rejectUnauthorized: true,
      ...(process.env.DATABASE_CA ? { ca: process.env.DATABASE_CA.replace(/\\n/g, '\n') } : {}) } } : {}) }
});
const common = { timestamps: true, underscored: true };
const User = sequelize.define('User', {
  id: { type: DataTypes.STRING, primaryKey: true }, nickname: { type: DataTypes.STRING(50), allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false }, tokenVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  avatar: DataTypes.STRING, status: { type: DataTypes.STRING(150), defaultValue: 'Привет! Я использую ChatApp' },
  bio: { type: DataTypes.TEXT, defaultValue: '' },
  friends: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
  friendRequests: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
  blockedUsers: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] }
}, { ...common, tableName: 'users' });
const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  chatKey: DataTypes.STRING, groupId: DataTypes.UUID, from: { type: DataTypes.STRING, allowNull: false }, to: DataTypes.STRING,
  text: { type: DataTypes.TEXT, defaultValue: '' }, image: DataTypes.TEXT,
  type: { type: DataTypes.ENUM('text', 'image'), defaultValue: 'text' },
  read: { type: DataTypes.BOOLEAN, defaultValue: false }, deleted: { type: DataTypes.BOOLEAN, defaultValue: false },
  clientId: DataTypes.STRING(64)
}, { ...common, tableName: 'messages' });
const Group = sequelize.define('Group', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  name: { type: DataTypes.STRING(50), allowNull: false }, avatar: DataTypes.STRING,
  ownerId: { type: DataTypes.STRING, allowNull: false }
}, { ...common, tableName: 'groups' });
const GroupMember = sequelize.define('GroupMember', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  groupId: { type: DataTypes.UUID, allowNull: false }, userId: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.ENUM('owner', 'member'), defaultValue: 'member' }
}, { ...common, tableName: 'group_members' });
const GroupReadState = sequelize.define('GroupReadState', {
  groupId: { type: DataTypes.UUID, primaryKey: true }, userId: { type: DataTypes.STRING, primaryKey: true },
  lastReadAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
}, { timestamps: false, underscored: true, tableName: 'group_read_states' });
// Persistent ledger: attaching a file and writing its reference share one transaction.
const Upload = sequelize.define('Upload', {
  path: { type: DataTypes.STRING, primaryKey: true }, ownerId: { type: DataTypes.STRING, allowNull: false },
  state: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
  bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 }
}, { ...common, updatedAt: false, tableName: 'uploads' });

// All application state transitions are serialized in this single-instance version.
// Bounded queue, bounded age, no network upload inside it. DB instance lock prevents
// a second updated process from silently breaking presence/calls/quotas.
let queueTail = Promise.resolve(), queueSize = 0, stopping = false, ready = false;
const MAX_QUEUE = 128;
function serial(fn) {
  if (stopping || queueSize >= MAX_QUEUE) return Promise.reject(new ApiError(503, 'Сервер занят', 'busy'));
  queueSize++;
  const deadline = Date.now() + 10_000;
  const work = queueTail.then(() => {
    if (stopping || Date.now() > deadline) throw new ApiError(503, 'Сервер занят', 'busy');
    return fn();
  });
  queueTail = work.catch(() => {}).finally(() => { queueSize--; });
  return work;
}
function limiter(max, window) {
  const map = new Map();
  const tick = setInterval(() => { for (const [k, v] of map) if (v.until <= Date.now()) map.delete(k); }, window);
  tick.unref();
  return key => {
    let hit = map.get(key);
    if (!hit || hit.until <= Date.now()) { if (map.size >= 20_000) return false; map.set(key, hit = { count: 0, until: Date.now() + window }); }
    return ++hit.count <= max;
  };
}
const connectionLimit = limiter(40, 60_000), eventLimit = limiter(500, 10_000);
const messageLimit = limiter(30, 10_000), friendLimit = limiter(20, 60_000), groupLimit = limiter(20, 60_000);
const typingLimit = limiter(30, 10_000), startCallLimit = limiter(10, 60_000), signalLimit = limiter(300, 10_000);
const authUserLimit = limiter(20, 15 * 60_000), uploadUserLimit = limiter(10, 60_000);
const app = express(), server = http.createServer(app);
app.disable('x-powered-by');
app.set('query parser', 'simple');
app.set('trust proxy', process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',').map(s => s.trim()) : (production ? 1 : false));
server.requestTimeout = 30_000; server.headersTimeout = 15_000;
function corsOrigin(origin, cb) { cb(!origin || origins.includes(origin) ? null : new ApiError(403, 'Origin запрещён'), !origin || origins.includes(origin)); }
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true }, maxHttpBufferSize: 100_000, connectTimeout: 10_000,
  allowRequest: (req, cb) => cb(null, ready && connectionLimit(req.socket.remoteAddress || 'unknown') && (!req.headers.origin || origins.includes(req.headers.origin)))
});
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'"], connectSrc: ["'self'", ...origins.map(o => o.replace(/^http/, 'ws'))],
  mediaSrc: ["'self'", 'blob:'], objectSrc: ["'none'"], baseUri: ["'self'"],
  frameAncestors: ["'none'"], formAction: ["'self'"],
  upgradeInsecureRequests: production ? [] : null
} }, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
// All executable page scripts are same-origin external files. User text is escaped before rendering.
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use((req, res, next) => { req.requestId = crypto.randomUUID(); res.set('X-Request-Id', req.requestId); next(); });
const rate = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много запросов' } });
app.use('/api', rate(60_000, 180));
app.use('/uploads', rate(60_000, 300));
app.use(express.json({ limit: '32kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 30 }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!ready || stopping) return res.status(503).json({ error: 'Сервер не готов' });
  if (req.body !== undefined && !record(req.body)) return res.status(400).json({ error: 'Ожидается объект' });
  next();
});
const authRate = rate(15 * 60_000, 30), uploadRate = rate(60_000, 20);
function signToken(user, audience = 'chatapp-api', expiry = JWT_EXPIRES_IN) {
  return jwt.sign({ id: user.id, v: user.tokenVersion }, JWT_SECRET, { algorithm: 'HS256', issuer: 'chatapp', audience, expiresIn: expiry });
}
async function verifyToken(token, audience = 'chatapp-api') {
  if (typeof token !== 'string' || token.length > 4096) return null;
  let p;
  try { p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'chatapp', audience }); } catch { return null; }
  if (!idOK(p?.id) || !Number.isSafeInteger(p.v) || p.v < 0 || !Number.isFinite(p.exp)) return null;
  const u = await User.findByPk(p.id);
  return u && u.tokenVersion === p.v ? { payload: p, user: u } : null;
}
function bearer(req) { return /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1]; }
function mediaCookie(res, user) {
  res.cookie('chatapp_media', signToken(user, 'chatapp-media', '1h'), { httpOnly: true, secure: production, sameSite: 'lax', path: '/uploads', maxAge: 3600_000 });
}
async function authenticate(req, res, next) {
  try {
    req.authToken = bearer(req);
    const auth = await verifyToken(req.authToken);
    if (!auth) reject(401, 'Токен недействителен или истёк', 'unauthorized');
    req.user = auth.user;
    next();
  } catch (e) { next(e); }
}
function route(method, url, middleware, handler, { publicRoute = false } = {}) {
  app[method](url, ...middleware, (req, res, next) => {
    serial(async () => {
      if (req.aborted || res.destroyed) return;
      if (!publicRoute) {
        const auth = await verifyToken(req.authToken);
        if (!auth) reject(401, 'Сессия отозвана', 'unauthorized');
        req.user = auth.user;
      }
      await handler(req, res);
    }).catch(next).finally(() => discardTmp(req.file).catch(e => logger.warn('Temp cleanup failed', { error: e.message })));
  });
}
const onlineUsers = new Map();
function sockets(userId) { return [...(onlineUsers.get(userId) || [])].map(sid => io.sockets.sockets.get(sid)).filter(s => s?.connected); }
function online(id) { return sockets(id).length > 0; }
function publicUser(u) { return { id: u.id, nickname: u.nickname, avatar: u.avatar, status: u.status, online: online(u.id) }; }
function privateUser(u) { return { ...publicUser(u), bio: u.bio, friends: u.friends, friendRequests: u.friendRequests, blockedUsers: u.blockedUsers }; }
function profileUpdate(u) {
  const payload = { ...publicUser(u), bio: u.bio };
  io.to(u.id).emit('profileUpdated', payload);
  for (const id of u.friends) io.to(id).emit('userUpdated', payload);
  return payload;
}
async function dmAccess(meId, otherId, transaction) {
  if (!idOK(otherId) || otherId === meId) reject(400, 'Некорректный ID', 'bad_request');
  const opts = transaction ? { transaction } : {};
  const me = await User.findByPk(meId, opts), other = await User.findByPk(otherId, opts);
  if (!me || !other || other.blockedUsers.includes(meId)) reject(404, 'Пользователь недоступен', 'not_found');
  if (me.blockedUsers.includes(otherId)) reject(403, 'Пользователь заблокирован', 'blocked');
  if (!me.friends.includes(otherId) || !other.friends.includes(meId)) reject(403, 'Пользователь не в друзьях', 'not_friends');
  return { me, other };
}
async function membership(userId, groupId, owner = false, transaction) {
  if (!uuidOK(groupId)) reject(400, 'Некорректный ID группы', 'bad_request');
  const options = transaction ? { transaction } : {};
  const group = await Group.findByPk(groupId, options);
  const member = group && await GroupMember.findOne({ where: { groupId, userId }, ...options });
  if (!group || !member) reject(403, 'Вы не участник группы', 'not_member');
  if (owner && (group.ownerId !== userId || member.role !== 'owner')) reject(403, 'Только владелец группы', 'not_owner');
  return { group, member };
}
async function groupData(groupId) {
  const g = await Group.findByPk(groupId);
  if (!g) return null;
  const members = await GroupMember.findAll({ where: { groupId }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  const ids = members.map(m => m.userId);
  const users = ids.length ? await User.findAll({ where: { id: ids } }) : [];
  const byId = new Map(users.map(u => [u.id, u]));
  return { id: g.id, name: g.name, avatar: g.avatar, ownerId: g.ownerId, createdAt: g.createdAt,
    members: members.filter(m => byId.has(m.userId)).map(m => ({ id: m.userId, nickname: byId.get(m.userId).nickname,
      avatar: byId.get(m.userId).avatar, online: online(m.userId), role: m.role })) };
}
function groupRoomJoin(userId, gid) { for (const s of sockets(userId)) s.join(`group:${gid}`); }
function groupRoomLeave(userId, gid) { for (const s of sockets(userId)) s.leave(`group:${gid}`); }
function serializeMessage(m) { return { _id: m.id, from: m.from, to: m.to, groupId: m.groupId, text: m.deleted ? '' : m.text,
  image: m.deleted ? null : m.image, type: m.type, deleted: m.deleted, read: m.read, time: m.createdAt.toISOString(),
  ...(m.clientId ? { clientId: m.clientId } : {}) }; }
function parsePage(q) {
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) reject(400, 'limit: целое число от 1 до 100');
  if (q.beforeId !== undefined && !uuidOK(q.beforeId)) reject(400, 'Некорректный beforeId');
  if (q.beforeId && !q.before) reject(400, 'beforeId требует before');
  if (q.before === undefined) return { limit, cursor: {} };
  if (typeof q.before !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(q.before)) reject(400, 'before: ISO timestamp из поля time');
  const time = new Date(q.before);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== q.before) reject(400, 'Некорректный before');
  return { limit, cursor: q.beforeId ? { [Op.or]: [{ createdAt: { [Op.lt]: time } }, { createdAt: time, id: { [Op.lt]: q.beforeId } }] } : { createdAt: { [Op.lt]: time } } };
}
async function history(where, query) {
  const { limit, cursor } = parsePage(query);
  const rows = await Message.findAll({ where: { ...where, ...cursor }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit });
  return rows.reverse().map(serializeMessage);
}
async function advanceRead(groupId, userId, time, transaction) {
  await sequelize.query(`INSERT INTO group_read_states (group_id,user_id,last_read_at) VALUES (:g,:u,:time)
    ON CONFLICT (group_id,user_id) DO UPDATE SET last_read_at = GREATEST(group_read_states.last_read_at, EXCLUDED.last_read_at)`,
    { replacements: { g: groupId, u: userId, time }, transaction });
}

let uploading = 0;
const upload = multer({
  storage: multer.diskStorage({ destination: TMP_DIR, filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.tmp`) }),
  // Some browsers/clipboard providers send a valid image as application/octet-stream
  // or image/jpg. sharp still validates the actual bytes in finalizeUpload().
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 1, parts: 2, fieldNameSize: 64, fieldNestingDepth: 0, fieldArrayIndexLimit: 0 },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedMime = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const allowedExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    cb(null, allowedMime.includes(mime) || allowedExt.includes(ext));
  }
});
async function uploadGuard(req, res, next) {
  try {
    if (!uploadUserLimit(req.user.id)) reject(429, 'Слишком много загрузок', 'rate_limited');
    if (uploading >= 4) reject(503, 'Загрузка занята', 'busy');
    const stat = await fs.promises.statfs(UPLOAD_DIR);
    if (stat.bavail * stat.bsize < 128 * 1024 * 1024) reject(507, 'Недостаточно места');
    // Recheck after await so concurrent uploads cannot all reserve the last slot.
    if (uploading >= 4) reject(503, 'Загрузка занята', 'busy');
    uploading++;
    let released = false;
    const release = () => { if (!released) { released = true; uploading--; } };
    res.once('finish', release); res.once('close', release);
    next();
  } catch (e) { next(e); }
}
async function discardTmp(file) { if (file?.path) await fs.promises.unlink(file.path).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
async function unlinkMedia(p) {
  if (!FILE_RE.test(p || '')) return;
  await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(p))).catch(e => { if (e.code !== 'ENOENT') throw e; });
}
async function finalizeUpload(req) {
  if (!req.file) reject(400, 'Загрузите изображение jpeg, png, webp или gif');
  const pending = await Upload.count({ where: { ownerId: req.user.id, state: 'pending' } });
  if (pending >= MAX_PENDING_UPLOADS) reject(429, 'Слишком много неотправленных загрузок');
  const used = Number(await Upload.sum('bytes', { where: { ownerId: req.user.id, state: { [Op.ne]: 'deleting' } } }) || 0);
  const name = `${crypto.randomUUID()}.webp`, out = path.join(TMP_DIR, `${crypto.randomUUID()}.tmp`);
  const publicPath = `/uploads/${name}`;
  let renamed = false;
  try {
    const input = sharp(req.file.path, { limitInputPixels: 16_000_000, failOn: 'warning', animated: false });
    const metadata = await input.metadata();
    if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) reject(400, 'Недопустимый формат изображения');
    // Decode and re-encode: strip metadata, trailing payloads and animation; do not trust magic bytes alone.
    await input.rotate().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).timeout({ seconds: 8 }).toFile(out);
    const size = (await fs.promises.stat(out)).size;
    if (size > MAX_IMAGE_BYTES) reject(400, 'Изображение слишком большое');
    if (used + size > MAX_USER_MEDIA_BYTES) reject(429, 'Лимит хранилища изображений');
    if (req.aborted) reject(400, 'Загрузка прервана');
    await fs.promises.rename(out, path.join(UPLOAD_DIR, name)); renamed = true;
    await Upload.create({ path: publicPath, ownerId: req.user.id, state: 'pending', bytes: size });
    return publicPath;
  } catch (e) {
    if (renamed) await unlinkMedia(publicPath);
    if (e instanceof ApiError) throw e;
    logger.warn('Image processing failed', { requestId: req.requestId, error: e.message });
    reject(400, 'Повреждённое или недопустимое изображение');
  } finally {
    await fs.promises.unlink(out).catch(() => {});
    await discardTmp(req.file);
  }
}
async function claimUpload(p, uid, transaction) {
  if (!p) return;
  const [n] = await Upload.update({ state: 'attached' }, { where: { path: p, ownerId: uid, state: 'pending', createdAt: { [Op.gte]: new Date(Date.now() - PENDING_TTL) } }, transaction });
  if (n !== 1) reject(400, 'Изображение не принадлежит вам, просрочено или уже использовано', 'invalid_image');
}
async function retireMedia(p, ownerId, transaction) {
  if (!FILE_RE.test(p || '')) return;
  await Upload.upsert({ path: p, ownerId, state: 'deleting', bytes: 0 }, { transaction });
}
async function fileReferenced(p) {
  return !!(await Message.findOne({ where: { image: p, deleted: false }, attributes: ['id'] }) ||
    await User.findOne({ where: { avatar: p }, attributes: ['id'] }) || await Group.findOne({ where: { avatar: p }, attributes: ['id'] }));
}
async function cleanupUploads() {
  // Called only through serial(). Persistent deletion intent survives process crashes.
  const candidates = await Upload.findAll({ where: { [Op.or]: [{ state: 'deleting' }, { state: 'pending', createdAt: { [Op.lt]: new Date(Date.now() - PENDING_TTL) } }] }, limit: 200 });
  for (const item of candidates) {
    if (await fileReferenced(item.path)) { await item.update({ state: 'attached' }); continue; }
    await unlinkMedia(item.path); await item.destroy();
  }
  // Bounded-memory directory iteration also covers crash between rename and ledger insert.
  for await (const entry of await fs.promises.opendir(TMP_DIR)) {
    if (!/^[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue;
    const p = path.join(TMP_DIR, entry.name);
    const st = await fs.promises.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 3600_000) await fs.promises.unlink(p).catch(() => {});
  }
  for await (const entry of await fs.promises.opendir(UPLOAD_DIR)) {
    const p = `/uploads/${entry.name}`;
    if (!FILE_RE.test(p)) continue;
    const st = await fs.promises.stat(path.join(UPLOAD_DIR, entry.name)).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < PENDING_TTL) continue;
    if (!await Upload.findByPk(p) && !await fileReferenced(p)) await unlinkMedia(p);
  }
}

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('base64'), 12);
route('post', '/api/register', [authRate], async (req, res) => {
  const { userId, nickname, password } = req.body || {};
  const id = typeof userId === 'string' ? userId.trim().toLowerCase() : '';
  if (!idOK(id)) reject(400, 'ID: 3-30 символов a-z, 0-9, _');
  if (!validPassword(password)) reject(400, 'Пароль: минимум 8 символов, максимум 72 байта UTF-8, без NUL');
  if (!authUserLimit(id)) reject(429, 'Слишком много попыток');
  const nick = nickname === undefined ? id : boundedText(nickname, 50, { required: true, min: 1 });
  const hash = await bcrypt.hash(password, 12);
  let u;
  try { u = await User.create({ id, nickname: nick, passwordHash: hash }); }
  catch (e) { if (e.name === 'SequelizeUniqueConstraintError') reject(400, 'Этот ID уже занят'); throw e; }
  mediaCookie(res, u); res.json({ success: true, token: signToken(u), user: privateUser(u) });
}, { publicRoute: true });
route('post', '/api/login', [authRate], async (req, res) => {
  const { userId, password } = req.body || {};
  const id = typeof userId === 'string' ? userId.trim().toLowerCase() : '';
  if (!idOK(id) || !authUserLimit(id) || typeof password !== 'string' || Buffer.byteLength(password) > 72 || password.includes('\0')) reject(401, 'Неверный ID или пароль');
  const u = await User.findByPk(id);
  const match = await bcrypt.compare(password, u ? u.passwordHash : DUMMY_HASH);
  if (!u || !match) reject(401, 'Неверный ID или пароль');
  mediaCookie(res, u); res.json({ success: true, token: signToken(u), user: privateUser(u) });
}, { publicRoute: true });
async function revokeSessions(u, passwordHash) {
  const rows = await sequelize.query(`UPDATE users SET token_version=token_version+1, updated_at=NOW()
    ${passwordHash ? ',password_hash=:hash' : ''} WHERE id=:id RETURNING token_version AS "tokenVersion"`,
    { replacements: { id: u.id, hash: passwordHash || '' }, type: QueryTypes.SELECT });
  if (!rows.length) reject(401, 'Пользователь не найден');
  u.tokenVersion = rows[0].tokenVersion;
  for (const call of [...calls.values()]) {
    if (call.type === 'dm' && [call.initiator, call.targetId].includes(u.id)) endCall(call, 'session_revoked');
    else if (call.participants.has(u.id)) leaveCall(u.id, call.callId, 'session_revoked');
  }
  io.in(u.id).disconnectSockets(true);
}
route('post', '/api/password/change', [authRate, authenticate], async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || Buffer.byteLength(currentPassword) > 72 || !validPassword(newPassword)) reject(400, 'Некорректный пароль (8+ символов, до 72 байт UTF-8)');
  if (currentPassword === newPassword) reject(400, 'Новый пароль совпадает с текущим');
  if (!authUserLimit(req.user.id)) reject(429, 'Слишком много попыток');
  if (!await bcrypt.compare(currentPassword, req.user.passwordHash)) reject(401, 'Текущий пароль неверен');
  await revokeSessions(req.user, await bcrypt.hash(newPassword, 12));
  mediaCookie(res, req.user); res.json({ success: true, token: signToken(req.user) });
});
route('post', '/api/logout-all', [authenticate], async (req, res) => {
  await revokeSessions(req.user);
  res.clearCookie('chatapp_media', { path: '/uploads', httpOnly: true, secure: production, sameSite: 'lax' }); res.json({ success: true });
});
route('get', '/api/rtc-config', [authenticate], async (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  // Browsers expect turn:host and turns:host, not turn://host. Accept both
  // env spellings because reverse proxies and deployment UIs often add //.
  const urls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(url => url.replace(/^turn(s?):\/\//i, 'turn$1:'));
  const validTurnUrls = urls.length > 0 && urls.every(url => /^turns?:[^\s]+$/i.test(url));
  const hasCredentials = !!process.env.TURN_SHARED_SECRET || (!!process.env.TURN_USERNAME && !!process.env.TURN_CREDENTIAL);
  if (validTurnUrls && hasCredentials) {
    if (process.env.TURN_SHARED_SECRET) {
      // Short-lived credentials keep the TURN secret server-side and work with coturn's use-auth-secret.
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${req.user.id}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SHARED_SECRET).update(username).digest('base64');
      iceServers.push({ urls, username, credential });
    } else {
      iceServers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  // VPN/corporate networks often allow only HTTPS-like TCP 443. In relay mode
  // no host/srflx candidate is used, so the call does not get stuck on a dead UDP path.
  const relay = process.env.TURN_FORCE_RELAY === 'true' && validTurnUrls && hasCredentials;
  res.json({
    iceServers,
    iceTransportPolicy: relay ? 'relay' : 'all',
    iceCandidatePoolSize: relay ? 4 : 0,
    relayConfigured: !!(validTurnUrls && hasCredentials),
    relayRequired: process.env.TURN_FORCE_RELAY === 'true',
    relayError: process.env.TURN_FORCE_RELAY === 'true' && !(validTurnUrls && hasCredentials)
      ? 'TURN_FORCE_RELAY включён, но TURN_URLS или credentials не настроены'
      : null,
  });
});
route('get', '/api/me', [authenticate], async (req, res) => { mediaCookie(res, req.user); res.json(privateUser(req.user)); });
route('get', '/api/friends', [authenticate], async (req, res) => {
  const me = req.user, ids = [...new Set([...me.friends, ...me.friendRequests])];
  const users = ids.length ? await User.findAll({ where: { id: ids } }) : [];
  const byId = new Map(users.filter(u => !u.blockedUsers.includes(me.id) && !me.blockedUsers.includes(u.id)).map(u => [u.id, publicUser(u)]));
  res.json({ friends: me.friends.map(id => byId.get(id)).filter(Boolean), requests: me.friendRequests.map(id => byId.get(id)).filter(Boolean) });
});
route('get', '/api/search', [rate(60_000, 30), authenticate], async (req, res) => {
  const q = boundedText(req.query.q === undefined ? '' : req.query.q, 50);
  if (!q) return res.json([]);
  const me = req.user;
  const blocked = Array.isArray(me.blockedUsers) ? me.blockedUsers : [];
  const rows = await User.findAll({
    where: {
      id: {
        [Op.ne]: me.id,
        [Op.notIn]: blocked.length ? blocked : ['__dummy_none__']
      },
      [Op.and]: [
        Sequelize.literal(`NOT (:meId = ANY(COALESCE("blocked_users", ARRAY[]::VARCHAR[])))`)
      ],
      [Op.or]: [
        { id: { [Op.iLike]: `%${q}%` } },
        { nickname: { [Op.iLike]: `%${q}%` } }
      ]
    },
    replacements: { meId: me.id },
    attributes: ['id', 'nickname', 'avatar', 'status'],
    order: [['id', 'ASC']],
    limit: 10
  });
  res.json(rows.map(publicUser));
});
route('get', '/api/profile/:userId', [authenticate], async (req, res) => {
  const u = idOK(req.params.userId) ? await User.findByPk(req.params.userId) : null;
  if (!u || u.blockedUsers.includes(req.user.id)) reject(404, 'Пользователь не найден');
  res.json({ ...publicUser(u), bio: u.bio, createdAt: u.createdAt });
});
route('post', '/api/profile/update', [authenticate], async (req, res) => {
  const u = req.user, { nickname, status, bio, avatar } = req.body || {};
  const values = {};
  if (nickname !== undefined) values.nickname = boundedText(nickname, 50, { min: 1 });
  if (status !== undefined) values.status = boundedText(status, 150);
  if (bio !== undefined) values.bio = boundedText(bio, 1000);
  if (avatar !== undefined && avatar !== null && avatar !== u.avatar) reject(400, 'Аватар изменяется через загрузку файла');
  await sequelize.transaction(async t => {
    if (avatar === null) { await retireMedia(u.avatar, u.id, t); values.avatar = null; }
    await u.update(values, { transaction: t });
  });
  res.json({ success: true, user: profileUpdate(u) });
});
route('post', '/api/upload/image', [authenticate, uploadRate, uploadGuard, upload.single('image')], async (req, res) => {
  const url = await finalizeUpload(req); res.json({ success: true, url });
});
route('post', '/api/upload/avatar', [authenticate, uploadRate, uploadGuard, upload.single('avatar')], async (req, res) => {
  const url = await finalizeUpload(req), u = req.user;
  await sequelize.transaction(async t => { await claimUpload(url, u.id, t); await retireMedia(u.avatar, u.id, t); await u.update({ avatar: url }, { transaction: t }); });
  profileUpdate(u); res.json({ success: true, avatar: url });
});
route('post', '/api/users/:id/block', [authenticate], async (req, res) => {
  const me = req.user, targetId = req.params.id;
  if (!idOK(targetId) || targetId === me.id) reject(400, 'Некорректный ID');
  const target = await User.findByPk(targetId);
  if (!target) reject(404, 'Пользователь не найден');
  if (!me.blockedUsers.includes(targetId) && me.blockedUsers.length >= MAX_BLOCKED) reject(400, 'Лимит заблокированных');
  const hadRelation = target.friends.includes(me.id) || target.friendRequests.includes(me.id);
  await sequelize.transaction(async t => {
    await me.update({ blockedUsers: [...new Set([...me.blockedUsers, targetId])], friends: me.friends.filter(x => x !== targetId), friendRequests: me.friendRequests.filter(x => x !== targetId) }, { transaction: t });
    await target.update({ friends: target.friends.filter(x => x !== me.id), friendRequests: target.friendRequests.filter(x => x !== me.id) }, { transaction: t });
  });
  const c = callsByChat.get(dmKey(me.id, targetId)); if (c) endCall(c, 'unavailable');
  if (hadRelation) io.to(targetId).emit('friendRemoved', { id: me.id });
  io.to(me.id).emit('friendRemoved', { id: targetId });
  io.to(me.id).emit('userBlocked', { id: targetId, blockedUsers: me.blockedUsers }); res.json({ success: true, blockedUsers: me.blockedUsers });
});
route('post', '/api/users/:id/unblock', [authenticate], async (req, res) => {
  if (!idOK(req.params.id)) reject(400, 'Некорректный ID');
  await req.user.update({ blockedUsers: req.user.blockedUsers.filter(x => x !== req.params.id) });
  io.to(req.user.id).emit('userUnblocked', { id: req.params.id, blockedUsers: req.user.blockedUsers }); res.json({ success: true, blockedUsers: req.user.blockedUsers });
});
route('get', '/api/users/blocked', [authenticate], async (req, res) => {
  const users = req.user.blockedUsers.length ? await User.findAll({ where: { id: req.user.blockedUsers }, attributes: ['id', 'nickname', 'avatar'] }) : [];
  res.json(users.map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar })));
});
route('get', '/api/messages/:userId/:friendId', [authenticate], async (req, res) => {
  if (req.user.id !== req.params.userId) reject(403, 'Нет доступа');
  await dmAccess(req.user.id, req.params.friendId);
  res.json(await history({ chatKey: chatKey(req.user.id, req.params.friendId), groupId: null }, req.query));
});
route('delete', '/api/messages/:messageId', [authenticate], async (req, res) => {
  if (!uuidOK(req.params.messageId)) reject(400, 'Некорректный ID сообщения');
  const m = await Message.findByPk(req.params.messageId);
  if (!m) reject(404, 'Сообщение не найдено');
  if (m.groupId) { await membership(req.user.id, m.groupId, m.from !== req.user.id); }
  else if (m.from !== req.user.id) reject(403, 'Нет доступа');
  if (m.deleted) return res.json({ success: true });
  await sequelize.transaction(async t => { await retireMedia(m.image, m.from, t); await m.update({ deleted: true, text: '', image: null }, { transaction: t }); });
  if (m.groupId) io.to(`group:${m.groupId}`).emit('messageDeleted', { messageId: m.id, chatWith: null, groupId: m.groupId, by: req.user.id });
  else {
    io.to(m.from).emit('messageDeleted', { messageId: m.id, chatWith: m.to });
    io.to(m.to).emit('messageDeleted', { messageId: m.id, chatWith: m.from });
  }
  res.json({ success: true });
});
route('post', '/api/groups', [authenticate], async (req, res) => {
  const { name, memberIds } = req.body || {}, me = req.user;
  if (!groupLimit(me.id)) reject(429, 'Слишком много действий', 'rate_limited');
  const cleanName = boundedText(name, 50, { required: true, min: 2 });
  if (!Array.isArray(memberIds) || memberIds.length > MAX_MEMBERS || memberIds.some(x => !idOK(x))) reject(400, 'Некорректный список участников');
  const ids = [...new Set([me.id, ...memberIds])];
  if (ids.length > MAX_MEMBERS) reject(400, 'Максимум 50 участников');
  for (const id of ids) {
    if (id !== me.id) await dmAccess(me.id, id);
    if (await GroupMember.count({ where: { userId: id } }) >= MAX_GROUPS) reject(400, 'У участника достигнут лимит групп', 'target_limit_reached');
  }
  const g = await sequelize.transaction(async t => {
    const g = await Group.create({ name: cleanName, ownerId: me.id }, { transaction: t });
    await GroupMember.bulkCreate(ids.map(id => ({ groupId: g.id, userId: id, role: id === me.id ? 'owner' : 'member' })), { transaction: t });
    await GroupReadState.bulkCreate(ids.map(id => ({ groupId: g.id, userId: id, lastReadAt: new Date() })), { transaction: t });
    return g;
  });
  for (const id of ids) groupRoomJoin(id, g.id);
  const data = await groupData(g.id);
  for (const id of ids) io.to(id).emit(id === me.id ? 'groupCreated' : 'addedToGroup', { group: data });
  res.json({ success: true, group: data });
});
route('get', '/api/groups', [authenticate], async (req, res) => {
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit), offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) reject(400, 'Некорректная пагинация');
  const ms = await GroupMember.findAll({ where: { userId: req.user.id }, attributes: ['groupId'] });
  if (!ms.length) return res.json([]);
  const gs = await Group.findAll({ where: { id: ms.map(m => m.groupId) }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit, offset });
  const out = []; for (const g of gs) out.push(await groupData(g.id)); res.json(out.filter(Boolean));
});
route('patch', '/api/groups/:groupId', [authenticate], async (req, res) => {
  if (!groupLimit(req.user.id)) reject(429, 'Слишком много действий');
  const { group } = await membership(req.user.id, req.params.groupId, true);
  await group.update({ name: boundedText(req.body?.name, 50, { required: true, min: 2 }) });
  io.to(`group:${group.id}`).emit('groupUpdated', { groupId: group.id, name: group.name, avatar: group.avatar });
  res.json({ success: true, group: { id: group.id, name: group.name, avatar: group.avatar, ownerId: group.ownerId } });
});
async function groupUploadAuth(req, res, next) { try { await membership(req.user.id, req.params.groupId, true); next(); } catch (e) { next(e); } }
route('post', '/api/groups/:groupId/avatar', [authenticate, uploadRate, groupUploadAuth, uploadGuard, upload.single('avatar')], async (req, res) => {
  // Revalidate after network upload and queue wait.
  const { group } = await membership(req.user.id, req.params.groupId, true);
  const url = await finalizeUpload(req);
  await sequelize.transaction(async t => { await claimUpload(url, req.user.id, t); await retireMedia(group.avatar, group.ownerId, t); await group.update({ avatar: url }, { transaction: t }); });
  io.to(`group:${group.id}`).emit('groupUpdated', { groupId: group.id, name: group.name, avatar: url }); res.json({ success: true, avatar: url });
});
route('get', '/api/groups/:groupId/messages', [authenticate], async (req, res) => {
  await membership(req.user.id, req.params.groupId); res.json(await history({ groupId: req.params.groupId }, req.query));
});
// Private images: ordinary <img src="/uploads/..."> works on a same-site frontend
// via a short-lived HttpOnly cookie. API auth never accepts that cookie.
app.get('/uploads/:filename', (req, res, next) => {
  serial(async () => {
    const p = `/uploads/${req.params.filename}`;
    if (!FILE_RE.test(p)) reject(404, 'Файл не найден');
    let auth;
    if (bearer(req)) auth = await verifyToken(bearer(req));
    else {
      const value = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('chatapp_media='))?.slice(14);
      auth = await verifyToken(value, 'chatapp-media');
    }
    if (!auth) reject(401, 'Не авторизован');
    const uid = auth.user.id;
    const pending = await Upload.findByPk(p);
    let allowed = pending?.state === 'pending' && pending.ownerId === uid && Date.now() - pending.createdAt.getTime() < PENDING_TTL;
    const avatarUser = await User.findOne({ where: { avatar: p } });
    if (avatarUser && !avatarUser.blockedUsers.includes(uid)) allowed = true;
    const avatarGroup = await Group.findOne({ where: { avatar: p } });
    if (avatarGroup && await GroupMember.findOne({ where: { groupId: avatarGroup.id, userId: uid } })) allowed = true;
    const m = await Message.findOne({ where: { image: p, deleted: false } });
    if (m?.groupId) allowed ||= !!(await GroupMember.findOne({ where: { groupId: m.groupId, userId: uid } }));
    else if (m && (m.from === uid || m.to === uid)) {
      try { await dmAccess(uid, m.from === uid ? m.to : m.from); allowed = true; } catch (e) { if (!(e instanceof ApiError)) throw e; }
    }
    if (!allowed) reject(404, 'Файл не найден');
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.join(UPLOAD_DIR, req.params.filename), { dotfiles: 'deny', acceptRanges: false, cacheControl: false }, e => { if (e && !res.headersSent) next(e); });
  }).catch(next);
});
app.use('/uploads', (req, res) => res.status(404).json({ error: 'Файл не найден' }));
app.get('/api/health', async (req, res) => { try { await sequelize.authenticate(); res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'error' }); } catch { res.status(503).json({ status: 'error' }); } });
app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));
if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) app.get(/^\/(?!api(?:\/|$)|uploads(?:\/|$)).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((err, req, res, next) => {
  discardTmp(req.file).catch(() => {});
  if (res.headersSent) return next(err);
  let status = err instanceof ApiError ? err.status : 500, error = err instanceof ApiError ? err.message : 'Внутренняя ошибка сервера';
  if (err instanceof multer.MulterError) { status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400; error = 'Недопустимая загрузка (один файл до 10 МБ, без дополнительных полей)'; }
  else if (err.type === 'entity.parse.failed' || err instanceof URIError) { status = 400; error = 'Некорректный запрос'; }
  else if (err.type === 'entity.too.large') { status = 413; error = 'Слишком большое тело запроса'; }
  else if (err.code === 'ENOENT' || err.status === 404) { status = 404; error = 'Файл не найден'; }
  if (status >= 500) logger.error('HTTP error', { requestId: req.requestId, error: err.message, stack: err.stack });
  res.status(status).json({ error, requestId: req.requestId });
});

// Calls and socket state are intentionally process-local. No cluster/PM2 workers.
const calls = new Map(), callsByChat = new Map();
const CALL_RECONNECT_GRACE_MS = 60_000;
const pendingEvents = new Map();
function busyUser(uid, except) {
  for (const c of calls.values()) if (c.callId !== except && (c.participants.has(uid) || (c.type === 'dm' && (c.initiator === uid || c.targetId === uid)))) return true;
  return false;
}
function voiceState(gid, target = io.to(`group:${gid}`)) {
  const c = callsByChat.get(`group:${gid}`);
  target.emit('groupVoiceState', c ? { groupId: gid, callId: c.callId, video: c.video, participants: [...c.participants] } : { groupId: gid, callId: null });
}
function invite(c) { return { callId: c.callId, chatKey: c.chatKey, isGroup: c.type === 'group', ...(c.groupId ? { groupId: c.groupId } : {}),
  video: c.video, from: c.initiator, fromNick: c.fromNick, fromAvatar: c.fromAvatar, createdAt: c.createdAt }; }
function endCall(c, reason = 'ended') {
  if (calls.get(c.callId) !== c) return;
  calls.delete(c.callId); if (callsByChat.get(c.chatKey) === c) callsByChat.delete(c.chatKey);
  for (const timer of c.grace.values()) clearTimeout(timer); c.grace.clear();
  if (c.type === 'dm' && !c.answered && ['cancelled', 'no_answer'].includes(reason)) io.to(c.targetId).emit('callCancelled', { callId: c.callId, reason });
  const emitter = c.type === 'dm' ? io.to(c.initiator).to(c.targetId) : io.to(`call:${c.callId}`);
  emitter.emit('callEnded', { callId: c.callId, chatKey: c.chatKey, reason });
  for (const sid of [...(io.sockets.adapter.rooms.get(`call:${c.callId}`) || [])]) {
    const s = io.sockets.sockets.get(sid); s?.leave(`call:${c.callId}`); s?.activeCallKeys?.delete(c.chatKey);
  }
  c.participants.clear(); c.peers.clear();
  if (c.type === 'group') voiceState(c.groupId);
}
function leaveCall(uid, callId, reason = 'left') {
  const c = calls.get(callId); if (!c || !c.participants.has(uid)) return;
  clearTimeout(c.grace.get(uid)); c.grace.delete(uid); c.participants.delete(uid); c.peers.delete(uid);
  for (const s of sockets(uid)) { s.leave(`call:${callId}`); s.activeCallKeys?.delete(c.chatKey); }
  io.to(`call:${callId}`).emit('callPeerLeft', { callId, peerId: uid, reason });
  if (!c.participants.size) endCall(c, reason === 'left' ? 'ended' : reason);
  else if (c.type === 'dm') schedulePeerReturn(c, uid);
  else voiceState(c.groupId);
}
function schedulePeerReturn(c, uid) {
  if (c.grace.has(uid)) return;
  const timer = setTimeout(() => {
    c.grace.delete(uid);
    if (calls.get(c.callId) !== c || c.participants.has(uid) || c.peers.has(uid)) return;
    endCall(c, 'timeout');
  }, CALL_RECONNECT_GRACE_MS);
  timer.unref(); c.grace.set(uid, timer);
  io.to(`call:${c.callId}`).emit('callPeerReconnecting', { callId: c.callId, peerId: uid, graceMs: CALL_RECONNECT_GRACE_MS });
}
function scheduleLeave(c, uid) {
  if (c.grace.has(uid)) return;
  const timer = setTimeout(() => {
    // Synchronous timer touches only call state; no DB await or stale authorization.
    c.grace.delete(uid);
    if (calls.get(c.callId) !== c || c.peers.has(uid)) return;
    leaveCall(uid, c.callId, 'disconnected');
  }, CALL_RECONNECT_GRACE_MS);
  timer.unref(); c.grace.set(uid, timer);
  io.to(`call:${c.callId}`).emit('callPeerReconnecting', { callId: c.callId, peerId: uid, graceMs: CALL_RECONNECT_GRACE_MS });
}
function attachCall(socket, c, notify = false) {
  const uid = socket.user.id, oldSid = c.peers.get(uid), already = c.participants.has(uid), recovering = c.grace.has(uid);
  if (oldSid && oldSid !== socket.id) {
    const old = io.sockets.sockets.get(oldSid);
    old?.leave(`call:${c.callId}`); old?.activeCallKeys?.delete(c.chatKey);
    old?.emit('callEnded', { callId: c.callId, chatKey: c.chatKey, reason: 'replaced_device' });
  }
  clearTimeout(c.grace.get(uid)); c.grace.delete(uid);
  c.participants.add(uid); c.peers.set(uid, socket.id); socket.join(`call:${c.callId}`); socket.activeCallKeys.add(c.chatKey);
  if (!already || recovering || notify || (oldSid && oldSid !== socket.id)) socket.to(`call:${c.callId}`).emit('callPeerJoined', { callId: c.callId, peerId: uid });
}
function requireLiveCall(c) { if (!c || calls.get(c.callId) !== c) reject(404, 'Звонок завершён', 'not_found'); }
async function callAccess(c, uid) {
  requireLiveCall(c);
  if (c.type === 'dm') {
    if (uid !== c.initiator && uid !== c.targetId) reject(403, 'Нет доступа', 'forbidden');
    await dmAccess(uid, uid === c.initiator ? c.targetId : c.initiator);
  } else await membership(uid, c.groupId);
  requireLiveCall(c); // a ring/grace timeout may have fired during DB access
}
const ringTimer = setInterval(() => {
  for (const c of [...calls.values()]) if (c.type === 'dm' && !c.answered && Date.now() - c.createdAt >= 90_000) endCall(c, 'no_answer');
}, 5_000); ringTimer.unref();
function checkLimit(check, uid) { if (!check(uid)) reject(429, 'Слишком много действий', 'rate_limited'); }
function socketError(s, event, arg, error) {
  if (!(error instanceof ApiError)) logger.error('Socket handler error', { event, socketId: s.id, error: error.message, stack: error.stack });
  const reason = error instanceof ApiError ? error.reason : 'server_error';
  const data = record(arg) ? arg : {};
  const correlation = { ...(idOK(data.toId) ? { toId: data.toId } : {}), ...(uuidOK(data.groupId) ? { groupId: data.groupId } : {}),
    ...(uuidOK(data.callId) ? { callId: data.callId } : {}), ...(clientId(data.clientId) ? { clientId: data.clientId } : {}) };
  if (event === 'sendMessage' || event === 'groupMessage') s.emit('sendMessageError', { ...correlation, reason });
  else if (event.toLowerCase().includes('friend')) s.emit('friendRequestError', { ...(idOK(arg) ? { toId: arg, targetId: arg } : {}), reason });
  else if (event.startsWith('call') || event === 'watchGroupVoice') s.emit('callError', { ...correlation, event, reason });
  else s.emit('groupError', { ...correlation, reason });
  if (reason === 'rate_limited') s.emit('rateLimited', event);
}
function installEvent(socket, event, shape, handler) {
  socket.on(event, (...args) => {
    const arg = args[0], uid = socket.user.id;
    const trailingAck = typeof args[args.length - 1] === 'function';
    const ack = trailingAck ? args[args.length - 1] : () => {};
    const report = error => {
      socketError(socket, event, arg, error);
      ack({ ok: false, reason: error instanceof ApiError ? error.reason : 'server_error',
        error: error instanceof ApiError ? error.message : 'Ошибка сервера' });
    };
    const count = args.length - (trailingAck ? 1 : 0);
    if (count !== 1 || (shape === 'object' ? !record(arg) : !idOK(arg) && !(shape === 'groupId' && uuidOK(arg)))) {
      report(new ApiError(400, 'Некорректный payload')); return;
    }
    if (!socket.connected) return;
    if (!eventLimit(uid) || (pendingEvents.get(uid) || 0) >= 16) {
      report(new ApiError(429, 'Слишком много событий', 'rate_limited')); return;
    }
    pendingEvents.set(uid, (pendingEvents.get(uid) || 0) + 1);
    serial(async () => {
      if (!socket.connected) throw new ApiError(503, 'Соединение потеряно', 'disconnected');
      const auth = await verifyToken(socket.authToken);
      if (!auth || !socket.connected) {
        ack({ ok: false, reason: 'unauthorized', error: 'Сессия истекла' });
        socket.disconnect(true); return;
      }
      socket.user = auth.user;
      const result = await handler(arg);
      ack({ ok: true, ...(result || {}) });
    }).catch(report).finally(() => {
      const n = (pendingEvents.get(uid) || 1) - 1;
      if (n > 0) pendingEvents.set(uid, n); else pendingEvents.delete(uid);
    });
  });
}
async function sendMessage(socket, data, isGroup) {
  const uid = socket.user.id;
  checkLimit(messageLimit, uid);
  const text = boundedText(data.text == null ? '' : data.text, 4000), image = data.image === '' || data.image == null ? null : data.image;
  if (image !== null && (typeof image !== 'string' || !FILE_RE.test(image))) reject(400, 'Недопустимое изображение', 'invalid_image');
  if (!text && !image) reject(400, 'Сообщение пустое', 'empty_message');
  const cid = clientId(data.clientId);
  if (data.clientId !== undefined && !cid) reject(400, 'Некорректный clientId');
  let where;
  if (isGroup) { await membership(uid, data.groupId); where = { groupId: data.groupId, chatKey: null, to: null }; }
  else { await dmAccess(uid, data.toId); where = { groupId: null, chatKey: chatKey(uid, data.toId), to: data.toId }; }
  let msg;
  if (cid) msg = await Message.findOne({ where: { from: uid, clientId: cid } });
  if (msg && (msg.groupId !== where.groupId || msg.to !== where.to || (!msg.deleted && (msg.text !== text || msg.image !== image)))) reject(409, 'clientId уже использован для другого сообщения', 'client_id_conflict');
  const duplicate = !!msg;
  if (!msg) msg = await sequelize.transaction(async t => {
    await claimUpload(image, uid, t);
    return Message.create({ ...where, from: uid, text, image, type: image ? 'image' : 'text', clientId: cid || null }, { transaction: t });
  });
  const value = serializeMessage(msg);
  if (isGroup) {
    if (duplicate) socket.emit('newGroupMessage', { groupId: data.groupId, msg: value });
    else io.to(`group:${data.groupId}`).emit('newGroupMessage', { groupId: data.groupId, msg: value });
  } else {
    (duplicate ? socket : io.to(uid)).emit('newMessage', { chatWith: data.toId, msg: value });
    if (!duplicate) io.to(data.toId).emit('newMessage', { chatWith: uid, msg: value });
  }
}
io.use(async (socket, next) => {
  try {
    if (!ready || stopping) return next(new Error('Unavailable'));
    const auth = await verifyToken(socket.handshake.auth?.token);
    if (!auth) return next(new Error('Unauthorized'));
    socket.authToken = socket.handshake.auth.token; socket.user = auth.user; socket.expiry = auth.payload.exp;
    next();
  } catch (e) { logger.warn('Socket authentication failed', { error: e.message }); next(new Error('Unauthorized')); }
});
io.on('connection', socket => {
  const uid = socket.user.id;
  socket.activeCallKeys = new Set();
  if ((onlineUsers.get(uid)?.size || 0) >= 8) { socket.emit('callError', { reason: 'too_many_connections' }); socket.disconnect(true); return; }
  const wasOffline = !online(uid);
  if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set()); onlineUsers.get(uid).add(socket.id);
  socket.join(uid);
  let expiryTimer;
  function scheduleExpiry() {
    const remaining = socket.expiry * 1000 - Date.now();
    if (remaining <= 0) return socket.disconnect(true);
    expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2 ** 31 - 1)); expiryTimer.unref();
  }
  scheduleExpiry();
  // Register disconnect synchronously, before starting any asynchronous initialization.
  socket.on('disconnect', () => {
    clearTimeout(expiryTimer);
    const set = onlineUsers.get(uid); set?.delete(socket.id); if (!set?.size) onlineUsers.delete(uid);
    for (const key of socket.activeCallKeys) {
      const c = callsByChat.get(key);
      if (!c || c.peers.get(uid) !== socket.id) continue;
      c.peers.delete(uid); scheduleLeave(c, uid);
    }
    serial(async () => {
      if (online(uid)) return;
      const u = await User.findByPk(uid);
      if (u) for (const id of u.friends) io.to(id).emit('friendOffline', uid);
    }).catch(e => { if (!stopping) logger.warn('Disconnect cleanup failed', { error: e.message }); });
  });
  serial(async () => {
    const auth = await verifyToken(socket.authToken);
    if (!auth || !socket.connected) { socket.disconnect(true); return; }
    socket.user = auth.user;
    const ms = await GroupMember.findAll({ where: { userId: uid }, attributes: ['groupId'] });
    if (!socket.connected) return;
    const gids = ms.map(m => m.groupId);
    for (const gid of gids) { socket.join(`group:${gid}`); voiceState(gid, socket); }
    const dmRows = await sequelize.query(`SELECT "from", COUNT(*)::int AS count FROM messages
      WHERE "to"=:u AND read=false AND deleted=false AND group_id IS NULL GROUP BY "from"`, { replacements: { u: uid }, type: QueryTypes.SELECT });
    const groupRows = gids.length ? await sequelize.query(`SELECT m.group_id AS "groupId",COUNT(*)::int AS count FROM messages m
      LEFT JOIN group_read_states r ON r.group_id=m.group_id AND r.user_id=:u
      WHERE m.group_id IN (:ids) AND m."from"<>:u AND m.deleted=false
      AND (r.last_read_at IS NULL OR m.created_at>r.last_read_at) GROUP BY m.group_id`, { replacements: { u: uid, ids: gids }, type: QueryTypes.SELECT }) : [];
    if (!socket.connected) return;
    socket.emit('profile', { ...privateUser(auth.user), unreadCounts: Object.fromEntries(dmRows.map(r => [r.from, r.count])), groupUnreadCounts: Object.fromEntries(groupRows.map(r => [r.groupId, r.count])) });
    if (wasOffline) for (const id of auth.user.friends) io.to(id).emit('friendOnline', { id: uid, nickname: auth.user.nickname, avatar: auth.user.avatar });
    for (const c of calls.values()) if (c.type === 'dm' && c.targetId === uid && !c.answered) socket.emit('callIncoming', invite(c));
  }).catch(e => { logger.warn('Socket initialization failed', { error: e.message }); socket.disconnect(true); });

  const on = (event, shape, handler) => installEvent(socket, event, shape, handler);
  on('sendFriendRequest', 'userId', async toId => {
    checkLimit(friendLimit, uid);
    const me = socket.user, target = await User.findByPk(toId);
    const decision = friendAction(me, target, { maxFriends: MAX_FRIENDS, maxRequests: MAX_REQUESTS });
    if (decision.action === 'reject') reject(400, 'Не удалось добавить пользователя', decision.reason);
    if (decision.action === 'friends') {
      io.to(uid).emit('friendAdded', publicUser(target));
      return { status: 'friends', toId };
    }
    if (decision.action === 'accept') {
      await sequelize.transaction(async t => {
        await me.update({ friendRequests: me.friendRequests.filter(x => x !== toId),
          friends: [...new Set([...me.friends, toId])] }, { transaction: t });
        await target.update({ friendRequests: target.friendRequests.filter(x => x !== uid),
          friends: [...new Set([...target.friends, uid])] }, { transaction: t });
      });
      io.to(uid).emit('friendAdded', publicUser(target));
      io.to(toId).emit('friendAdded', publicUser(me));
      return { status: 'friends', toId };
    }
    if (decision.action === 'pending') {
      socket.emit('requestSent', { toId, alreadySent: true });
      return { status: 'pending', toId };
    }
    await target.update({ friendRequests: [...target.friendRequests, uid] });
    io.to(uid).emit('requestSent', { toId }); io.to(toId).emit('friendRequest', { id: uid, nickname: me.nickname, avatar: me.avatar });
    return { status: 'pending', toId };
  });
  on('acceptFriendRequest', 'userId', async fromId => {
    checkLimit(friendLimit, uid);
    const me = socket.user, other = await User.findByPk(fromId);
    if (!other || !me.friendRequests.includes(fromId)) reject(404, 'Запрос не найден', 'no_request');
    if (me.blockedUsers.includes(fromId) || other.blockedUsers.includes(uid)) reject(403, 'Пользователь недоступен', 'not_found');
    if ((!me.friends.includes(fromId) && me.friends.length >= MAX_FRIENDS) || (!other.friends.includes(uid) && other.friends.length >= MAX_FRIENDS)) reject(400, 'Лимит друзей', 'target_limit_reached');
    await sequelize.transaction(async t => {
      await me.update({ friendRequests: me.friendRequests.filter(x => x !== fromId), friends: [...new Set([...me.friends, fromId])] }, { transaction: t });
      await other.update({ friendRequests: other.friendRequests.filter(x => x !== uid), friends: [...new Set([...other.friends, uid])] }, { transaction: t });
    });
    io.to(uid).emit('friendAdded', publicUser(other)); io.to(fromId).emit('friendAdded', publicUser(me));
  });
  on('declineFriendRequest', 'userId', async fromId => {
    checkLimit(friendLimit, uid); await socket.user.update({ friendRequests: socket.user.friendRequests.filter(x => x !== fromId) }); io.to(uid).emit('requestDeclined', fromId);
  });
  on('removeFriend', 'userId', async friendId => {
    checkLimit(friendLimit, uid);
    const me = socket.user, other = await User.findByPk(friendId);
    await sequelize.transaction(async t => {
      await me.update({ friends: me.friends.filter(x => x !== friendId), friendRequests: me.friendRequests.filter(x => x !== friendId) }, { transaction: t });
      if (other) await other.update({ friends: other.friends.filter(x => x !== uid), friendRequests: other.friendRequests.filter(x => x !== uid) }, { transaction: t });
    });
    const c = callsByChat.get(dmKey(uid, friendId)); if (c) endCall(c, 'unavailable');
    io.to(uid).emit('friendRemoved', { id: friendId }); io.to(friendId).emit('friendRemoved', { id: uid });
  });
  on('sendMessage', 'object', data => sendMessage(socket, data, false));
  on('groupMessage', 'object', data => sendMessage(socket, data, true));
  on('markRead', 'userId', async friendId => {
    checkLimit(typingLimit, uid); await dmAccess(uid, friendId);
    const [count] = await Message.update({ read: true }, { where: { chatKey: chatKey(uid, friendId), to: uid, groupId: null, read: false } });
    if (count) io.to(friendId).emit('messagesRead', { by: uid, count });
    socket.to(uid).emit('unreadCleared', { chatWith: friendId });
  });
  on('typing', 'object', async data => {
    checkLimit(typingLimit, uid);
    if (typeof data.isTyping !== 'boolean') reject(400, 'isTyping должен быть boolean');
    if (data.toId && data.groupId) reject(400, 'Укажите один чат');
    if (data.toId) { await dmAccess(uid, data.toId); io.to(data.toId).emit('typing', { from: uid, isTyping: data.isTyping }); }
    else { await membership(uid, data.groupId); socket.to(`group:${data.groupId}`).emit('typing', { from: uid, groupId: data.groupId, isTyping: data.isTyping }); }
  });
  on('markGroupRead', 'groupId', async gid => {
    checkLimit(typingLimit, uid); await membership(uid, gid);
    await advanceRead(gid, uid, new Date()); socket.to(uid).emit('unreadCleared', { groupId: gid });
  });
  on('addGroupMember', 'object', async data => {
    checkLimit(groupLimit, uid);
    const gid = data.groupId, targetId = data.userId;
    await membership(uid, gid, true);
    if (!idOK(targetId) || targetId === uid) reject(400, 'Некорректный ID');
    const { other } = await dmAccess(uid, targetId);
    if (await GroupMember.findOne({ where: { groupId: gid, userId: targetId } })) reject(400, 'Уже участник', 'already_member');
    if (await GroupMember.count({ where: { groupId: gid } }) >= MAX_MEMBERS) reject(400, 'Лимит участников', 'limit_reached');
    if (await GroupMember.count({ where: { userId: targetId } }) >= MAX_GROUPS) reject(400, 'Лимит групп', 'target_limit_reached');
    await sequelize.transaction(async t => {
      await GroupMember.create({ groupId: gid, userId: targetId, role: 'member' }, { transaction: t });
      await advanceRead(gid, targetId, new Date(), t);
    });
    groupRoomJoin(targetId, gid);
    io.to(`group:${gid}`).emit('groupMemberJoined', { groupId: gid, user: { id: targetId, nickname: other.nickname, avatar: other.avatar, online: online(targetId), role: 'member' } });
    io.to(targetId).emit('addedToGroup', { group: await groupData(gid) }); voiceState(gid, io.to(targetId));
  });
  on('leaveGroup', 'groupId', async gid => {
    checkLimit(groupLimit, uid);
    const { group, member } = await membership(uid, gid);
    if (group.ownerId === uid && member.role === 'owner') {
      await sequelize.transaction(async t => {
        // INSERT..SELECT avoids loading all images/messages of a large group into RAM.
        await sequelize.query(`INSERT INTO uploads (path,owner_id,state,bytes,created_at)
          SELECT DISTINCT image,"from",'deleting',0,NOW() FROM messages WHERE group_id=:g AND image LIKE '/uploads/%'
          ON CONFLICT (path) DO UPDATE SET state='deleting'`, { replacements: { g: gid }, transaction: t });
        await retireMedia(group.avatar, uid, t);
        await Message.destroy({ where: { groupId: gid }, transaction: t });
        await GroupReadState.destroy({ where: { groupId: gid }, transaction: t });
        await GroupMember.destroy({ where: { groupId: gid }, transaction: t });
        await group.destroy({ transaction: t });
      });
      const c = callsByChat.get(`group:${gid}`); if (c) endCall(c, 'group_deleted');
      io.to(`group:${gid}`).emit('groupDeleted', { groupId: gid }); io.in(`group:${gid}`).socketsLeave(`group:${gid}`);
    } else {
      await sequelize.transaction(async t => { await member.destroy({ transaction: t }); await GroupReadState.destroy({ where: { groupId: gid, userId: uid }, transaction: t }); });
      const c = callsByChat.get(`group:${gid}`); if (c) leaveCall(uid, c.callId, 'left_group');
      groupRoomLeave(uid, gid); io.to(`group:${gid}`).emit('groupMemberLeft', { groupId: gid, userId: uid }); io.to(uid).emit('groupDeleted', { groupId: gid });
    }
  });
  on('kickGroupMember', 'object', async data => {
    checkLimit(groupLimit, uid);
    const gid = data.groupId, targetId = data.userId;
    await membership(uid, gid, true);
    if (!idOK(targetId) || targetId === uid) reject(400, 'Некорректный ID');
    await sequelize.transaction(async t => { await GroupMember.destroy({ where: { groupId: gid, userId: targetId }, transaction: t }); await GroupReadState.destroy({ where: { groupId: gid, userId: targetId }, transaction: t }); });
    const c = callsByChat.get(`group:${gid}`); if (c) leaveCall(targetId, c.callId, 'kicked');
    groupRoomLeave(targetId, gid); io.to(`group:${gid}`).emit('groupMemberLeft', { groupId: gid, userId: targetId, kicked: true }); io.to(targetId).emit('groupDeleted', { groupId: gid, kicked: true });
  });
  on('callStart', 'object', async data => {
    checkLimit(startCallLimit, uid);
    if (data.video !== undefined && typeof data.video !== 'boolean') reject(400, 'video должен быть boolean');
    if (!!data.toId === !!data.groupId) reject(400, 'Укажите один чат');
    const isGroup = !!data.groupId;
    if (isGroup) await membership(uid, data.groupId); else await dmAccess(uid, data.toId);
    if (!socket.connected) return;
    const key = isGroup ? `group:${data.groupId}` : dmKey(uid, data.toId);
    let c = callsByChat.get(key);
    if (busyUser(uid, c?.callId) || (!isGroup && (c || busyUser(data.toId)))) reject(409, 'Занято', 'busy');
    const isNew = !c;
    if (isNew) {
      c = { callId: crypto.randomUUID(), chatKey: key, type: isGroup ? 'group' : 'dm', groupId: isGroup ? data.groupId : null,
        initiator: uid, targetId: isGroup ? null : data.toId, video: !!data.video, answered: false, createdAt: Date.now(),
        fromNick: socket.user.nickname, fromAvatar: socket.user.avatar, participants: new Set(), peers: new Map(), grace: new Map() };
      calls.set(c.callId, c); callsByChat.set(key, c);
    }
    const peers = [...c.participants].filter(id => id !== uid);
    attachCall(socket, c);
    socket.emit('callStarted', { callId: c.callId, chatKey: key, video: c.video, isGroup, ...(isGroup ? { groupId: c.groupId } : {}), participants: peers });
    if (isNew) {
      if (isGroup) io.to(`group:${c.groupId}`).except(uid).emit('callIncoming', invite(c));
      else io.to(c.targetId).emit('callIncoming', invite(c));
    }
    if (isGroup) voiceState(c.groupId);
  });
  on('callJoin', 'object', async data => {
    if (!uuidOK(data.callId)) reject(400, 'Некорректный ID звонка');
    const c = calls.get(data.callId); await callAccess(c, uid);
    if (busyUser(uid, c.callId)) reject(409, 'Занято', 'busy');
    if (!socket.connected) return;
    if (c.type === 'dm' && uid === c.targetId) {
      c.answered = true;
      // Clear ringing UI on the user's other devices without granting them media access.
      socket.to(uid).emit('callCancelled', { callId: c.callId, reason: 'answered_elsewhere' });
    }
    const peers = [...c.participants].filter(id => id !== uid);
    attachCall(socket, c, data.rejoin === true);
    socket.emit('callJoined', { callId: c.callId, chatKey: c.chatKey, video: c.video, isGroup: c.type === 'group', groupId: c.groupId, participants: peers });
    if (c.type === 'group') voiceState(c.groupId);
  });
  on('callReject', 'object', async data => {
    const c = uuidOK(data.callId) ? calls.get(data.callId) : null;
    await callAccess(c, uid);
    const reason = ['rejected', 'busy', 'timeout'].includes(data.reason) ? data.reason : 'rejected';
    if (c.type === 'dm') {
      if (uid !== c.targetId || c.answered) return;
      io.to(c.initiator).emit('callRejected', { callId: c.callId, peerId: uid, reason }); endCall(c, reason);
    }
    // Declining a group invitation is local, not a broadcast to every caller.
  });
  on('watchGroupVoice', 'object', async data => { checkLimit(typingLimit, uid); await membership(uid, data.groupId); voiceState(data.groupId, socket); });
  on('callSignal', 'object', async data => {
    checkLimit(signalLimit, uid);
    const c = uuidOK(data.callId) ? calls.get(data.callId) : null;
    await callAccess(c, uid);
    if (!idOK(data.to) || !record(data.data) || data.to === uid || c.peers.get(uid) !== socket.id || !c.participants.has(data.to)) reject(403, 'Нет доступа', 'forbidden');
    const encoded = JSON.stringify(data.data);
    if (Buffer.byteLength(encoded) > 64_000) reject(400, 'Слишком большой сигнал');
    const peer = io.sockets.sockets.get(c.peers.get(data.to));
    if (peer?.connected && peer.rooms.has(`call:${c.callId}`)) peer.emit('callSignal', { callId: c.callId, from: uid, data: data.data });
  });
  on('callLeave', 'object', async data => {
    const c = uuidOK(data.callId) ? calls.get(data.callId) : null;
    if (!c || c.peers.get(uid) !== socket.id) return;
    if (c.type === 'dm' && !c.answered && c.initiator === uid) endCall(c, 'cancelled'); else leaveCall(uid, c.callId);
  });
});

// Additive migrations only; no sync({alter:true}) and no startup after a failed migration.
async function ensureSchema() {
  const qi = sequelize.getQueryInterface();
  const tables = new Set((await qi.showAllTables()).map(t => typeof t === 'string' ? t : t.tableName));
  if (tables.has('users')) {
    await sequelize.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0');
    for (const column of ['friends', 'friend_requests', 'blocked_users']) {
      await sequelize.query(`UPDATE users SET "${column}"='{}' WHERE "${column}" IS NULL`);
      await sequelize.query(`ALTER TABLE users ALTER COLUMN "${column}" SET DEFAULT '{}', ALTER COLUMN "${column}" SET NOT NULL`);
    }
  }
  if (tables.has('messages')) {
    await sequelize.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id UUID, ADD COLUMN IF NOT EXISTS client_id VARCHAR(64)');
    const cols = await qi.describeTable('messages');
    for (const col of ['chat_key', 'group_id', 'to', 'image']) if (cols[col]) await sequelize.query(`ALTER TABLE messages ALTER COLUMN "${col}" DROP NOT NULL`);
  }
  if (tables.has('uploads')) await sequelize.query(`ALTER TABLE uploads ADD COLUMN IF NOT EXISTS state VARCHAR(16) NOT NULL DEFAULT 'pending', ADD COLUMN IF NOT EXISTS bytes BIGINT NOT NULL DEFAULT 0`);
  await sequelize.sync(); // creates missing tables only; it does not rewrite existing columns
  const indexes = [
    'CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_id_user_id ON group_members(group_id,user_id)',
    'CREATE INDEX IF NOT EXISTS group_members_user_id ON group_members(user_id)',
    'CREATE INDEX IF NOT EXISTS messages_chat_key_created_at_id ON messages(chat_key,created_at,id)',
    'CREATE INDEX IF NOT EXISTS messages_group_id_created_at_id ON messages(group_id,created_at,id)',
    'CREATE INDEX IF NOT EXISTS messages_to_read ON messages("to",read)',
    'CREATE INDEX IF NOT EXISTS messages_from ON messages("from")',
    'CREATE UNIQUE INDEX IF NOT EXISTS messages_from_client_id_unique ON messages("from",client_id) WHERE client_id IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS uploads_owner_id ON uploads(owner_id)',
    'CREATE INDEX IF NOT EXISTS uploads_created_at ON uploads(created_at)',
    'CREATE INDEX IF NOT EXISTS uploads_state_created_at ON uploads(state,created_at)'
  ];
  for (const sql of indexes) await sequelize.query(sql);
  // Repair only missing ledger rows for existing local media; no message content is altered.
  await sequelize.query(`INSERT INTO uploads(path,owner_id,state,bytes,created_at)
    SELECT image,MIN("from"),'attached',0,NOW() FROM messages WHERE deleted=false AND image LIKE '/uploads/%' GROUP BY image
    ON CONFLICT(path) DO NOTHING`);
  await sequelize.query(`INSERT INTO uploads(path,owner_id,state,bytes,created_at)
    SELECT avatar,MIN(id),'attached',0,NOW() FROM users WHERE avatar LIKE '/uploads/%' GROUP BY avatar ON CONFLICT(path) DO NOTHING`);
  await sequelize.query(`INSERT INTO uploads(path,owner_id,state,bytes,created_at)
    SELECT avatar,MIN(owner_id),'attached',0,NOW() FROM groups WHERE avatar LIKE '/uploads/%' GROUP BY avatar ON CONFLICT(path) DO NOTHING`);
  // Older ledger rows have no byte count. Charge them to the quota when the file exists.
  let after = '';
  while (true) {
    const rows = await Upload.findAll({ where: { bytes: 0, state: { [Op.ne]: 'deleting' }, path: { [Op.gt]: after } }, order: [['path', 'ASC']], limit: 200 });
    if (!rows.length) break;
    for (const row of rows) if (FILE_RE.test(row.path)) {
      const stat = await fs.promises.stat(path.join(UPLOAD_DIR, path.basename(row.path))).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (stat) await row.update({ bytes: stat.size });
    }
    after = rows[rows.length - 1].path;
  }
}
let instanceConnection, cleanupTimer;
async function start() {
  // Lock must use a dedicated persistent PostgreSQL session, not transaction-mode PgBouncer.
  // Do not run this and the old unguarded server together against the same database.
  await sequelize.authenticate();
  const shouldLock = process.env.ENABLE_INSTANCE_LOCK === 'true';
  if (shouldLock) {
    instanceConnection = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
    let locked = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      const res = await instanceConnection.query("SELECT pg_try_advisory_lock(1780317111, hashtext(current_database())) AS locked");
      if (res.rows[0].locked) { locked = true; break; }
      logger.warn(`Waiting for previous instance to release database lock (attempt ${attempt + 1}/15)...`);
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!locked) fail('Another ChatApp instance holds this database. Stop it before starting this server.');
    instanceConnection.on('error', err => { logger.error('Instance lock connection lost', { error: err.message }); shutdown(1); });
    instanceConnection.on('end', () => { if (!stopping) { logger.error('Instance lock session ended'); shutdown(1); } });
  } else {
    logger.info('Instance advisory lock disabled (ENABLE_INSTANCE_LOCK!=true). Starting server directly.');
  }
  await ensureSchema();
  ready = true;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, resolve); });
  logger.info('Server started', { port: PORT });
  const cleanup = () => serial(cleanupUploads).catch(e => logger.warn('Upload cleanup failed', { error: e.message }));
  cleanup(); cleanupTimer = setInterval(cleanup, 3600_000); cleanupTimer.unref();
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true; ready = false; clearInterval(cleanupTimer); clearInterval(ringTimer);
  const forced = setTimeout(() => process.exit(1), 30_000); forced.unref();
  for (const c of [...calls.values()]) endCall(c, 'server_shutdown');
  io.disconnectSockets(true);
  server.closeIdleConnections?.();
  try {
    // Stop accepting new work, wait for active handlers, then release the DB lock.
    await new Promise(resolve => io.close(resolve));
    await queueTail;
    if (instanceConnection) { await sequelize.connectionManager.destroyConnection(instanceConnection); instanceConnection = null; }
    await sequelize.close();
    process.exit(code);
  } catch (e) { logger.error('Shutdown failed', { error: e.message }); process.exit(1); }
}
if (require.main === module) {
  process.on('SIGINT', () => shutdown()); process.on('SIGTERM', () => shutdown());
  process.on('unhandledRejection', err => { logger.error('Unhandled rejection', { error: err?.message || String(err) }); shutdown(1); });
  process.on('uncaughtException', err => { logger.error('Uncaught exception', { error: err.message, stack: err.stack }); shutdown(1); });
  start().catch(err => { logger.error('Startup failed', { error: err.message, stack: err.stack }); shutdown(1); });
}
module.exports = { validPassword, clientId, chatKey, parsePage, record, FILE_RE, serial };
