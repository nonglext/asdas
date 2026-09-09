'use strict';

require('dotenv').config();

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { Server } = require('socket.io');
const { Client: PgClient } = require('pg');
const { Sequelize, DataTypes, Op, QueryTypes } = require('sequelize');

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const helmet = require('helmet');
const cors = require('cors');
const winston = require('winston');
const proxyaddr = require('proxy-addr');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const production = process.env.NODE_ENV === 'production';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

function fail(message) {
  throw new Error(message);
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);

  if (
    raw === '' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`Invalid ${name}`);
  }

  return value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];

  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  fail(`${name} must be true or false`);
}

const PORT = intEnv('PORT', 3000, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';

const JWT_SECRET =
  process.env.JWT_SECRET ||
  (production ? '' : crypto.randomBytes(48).toString('base64url'));

if (
  Buffer.byteLength(JWT_SECRET) < 32 ||
  JWT_SECRET === 'changethissecretinproduction'
) {
  fail('Set JWT_SECRET to a random secret of at least 32 bytes');
}

if (!process.env.JWT_SECRET) {
  logger.warn('Temporary JWT secret: restarting invalidates all sessions');
}

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const tokenProbe = jwt.decode(
  jwt.sign({ test: true }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN
  })
);

if (
  !tokenProbe ||
  !Number.isFinite(tokenProbe.exp) ||
  tokenProbe.exp <= Math.floor(Date.now() / 1000)
) {
  fail('JWT_EXPIRES_IN must specify a positive lifetime, for example 7d');
}

const origins = [
  ...new Set(
    (
      process.env.CLIENT_URL ||
      (production
        ? ''
        : `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
    )
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )
];

if (!origins.length) {
  fail('Set CLIENT_URL to exact frontend origins');
}

for (const origin of origins) {
  let parsed;

  try {
    parsed = new URL(origin);
  } catch {
    fail(`Invalid CLIENT_URL origin: ${origin}`);
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.origin !== origin
  ) {
    fail('CLIENT_URL must contain exact HTTP(S) origins without trailing slash');
  }

  if (production && parsed.protocol !== 'https:') {
    fail('Production CLIENT_URL must use HTTPS');
  }
}

const originSet = new Set(origins);

const DATABASE_URL =
  process.env.DATABASE_URL ||
  (production
    ? ''
    : 'postgresql://user:password@localhost:5432/chatapp');

if (!DATABASE_URL) fail('Set DATABASE_URL');

const parsedDatabaseUrl = new URL(DATABASE_URL);

if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
  fail('DATABASE_URL must be a PostgreSQL URL');
}

// SSL is configured explicitly, not guessed from a provider hostname.
// Avoid connection-string SSL options overriding certificate verification.
for (const key of parsedDatabaseUrl.searchParams.keys()) {
  if (/^ssl/i.test(key)) {
    fail(
      'Remove SSL parameters from DATABASE_URL; use DATABASE_SSL and DATABASE_CA'
    );
  }
}

const DATABASE_SSL = boolEnv('DATABASE_SSL', production);

const pgSsl = DATABASE_SSL
  ? {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_CA
        ? { ca: process.env.DATABASE_CA.replace(/\\n/g, '\n') }
        : {})
    }
  : undefined;

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')
);

function inside(parent, child) {
  const relative = path.relative(parent, child);

  return (
    relative === '' ||
    (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function realOrResolved(p) {
  return fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

if (
  inside(realOrResolved(PUBLIC_DIR), fs.realpathSync(UPLOAD_DIR)) ||
  inside(fs.realpathSync(UPLOAD_DIR), realOrResolved(PUBLIC_DIR))
) {
  fail('UPLOAD_DIR and public must be separate, non-nested directories');
}

const TMP_DIR = path.join(UPLOAD_DIR, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });

if (!inside(fs.realpathSync(UPLOAD_DIR), fs.realpathSync(TMP_DIR))) {
  fail('Upload temporary directory must not point outside UPLOAD_DIR');
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_USER_MEDIA_BYTES = intEnv(
  'MAX_USER_MEDIA_BYTES',
  100 * 1024 * 1024,
  MAX_IMAGE_BYTES,
  10 * 1024 ** 3
);

const MIN_FREE_DISK_BYTES = 128 * 1024 * 1024;
const MAX_PENDING_UPLOADS = 20;
const PENDING_TTL = 24 * 3600_000;

const MAX_FRIENDS = 500;
const MAX_REQUESTS = 200;
const MAX_BLOCKED = 200;
const MAX_MEMBERS = 50;
const MAX_GROUPS = 100;

const MAX_QUEUE = 128;
const MAX_QUEUE_AGE = 10_000;
const MAX_SOCKET_CONNECTIONS = intEnv(
  'MAX_SOCKET_CONNECTIONS',
  2000,
  8,
  100_000
);

const USER_RE = /^[a-z0-9_]{3,30}$/;

// Canonical lowercase UUIDs only: the same ID must always yield the same room.
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);
const FILE_RE = new RegExp(
  `^/uploads/${UUID_PATTERN}\\.(?:jpg|png|webp|gif)$`
);
const TMP_RE = new RegExp(`^${UUID_PATTERN}\\.tmp$`);

const idOK = value =>
  typeof value === 'string' && USER_RE.test(value);

const uuidOK = value =>
  typeof value === 'string' && UUID_RE.test(value);

const record = value => {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.isBuffer(value)
  ) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function validPassword(value) {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    Buffer.byteLength(value) <= 72 &&
    !value.includes('\0')
  );
}

function loginPasswordOK(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 72 &&
    !value.includes('\0')
  );
}

function clientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : undefined;
}

function chatKey(a, b) {
  return [a, b].sort().join('::');
}

function dmKey(a, b) {
  return `dm:${[a, b].sort().join(':')}`;
}

const userRoom = id => `user:${id}`;
const groupRoom = id => `group:${id}`;
const callRoom = id => `call:${id}`;

class ApiError extends Error {
  constructor(status, message, reason = 'bad_request') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

function reject(status, message, reason) {
  throw new ApiError(status, message, reason);
}

function boundedText(value, max, { required = false, min = 0 } = {}) {
  if (value === undefined && !required) return undefined;

  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > max ||
    value.trim().length < min
  ) {
    reject(400, 'Некорректная длина или тип текста');
  }

  return value.trim();
}

function assertRequestId(data) {
  if (data.requestId !== undefined && !clientId(data.requestId)) {
    reject(400, 'Некорректный requestId');
  }
}

// -----------------------------------------------------------------------------
// Database
// -----------------------------------------------------------------------------

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: {
    max: 5,
    min: 0,
    acquire: 20_000,
    idle: 10_000
  },
  retry: { max: 0 },
  dialectOptions: {
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    ...(pgSsl ? { ssl: pgSsl } : {})
  }
});

const common = {
  timestamps: true,
  underscored: true
};

const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    nickname: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false
    },
    tokenVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    avatar: DataTypes.STRING,
    status: {
      type: DataTypes.STRING(150),
      defaultValue: 'Привет! Я использую ChatApp'
    },
    bio: {
      type: DataTypes.TEXT,
      defaultValue: ''
    },
    friends: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: []
    },
    friendRequests: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: []
    },
    blockedUsers: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: []
    }
  },
  { ...common, tableName: 'users' }
);

const Message = sequelize.define(
  'Message',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    chatKey: DataTypes.STRING,
    groupId: DataTypes.UUID,
    from: {
      type: DataTypes.STRING,
      allowNull: false
    },
    to: DataTypes.STRING,
    text: {
      type: DataTypes.TEXT,
      defaultValue: '',
      allowNull: false
    },
    image: DataTypes.TEXT,
    type: {
      type: DataTypes.ENUM('text', 'image'),
      defaultValue: 'text',
      allowNull: false
    },
    read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false
    },
    deleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false
    },
    clientId: DataTypes.STRING(64)
  },
  { ...common, tableName: 'messages' }
);

const Group = sequelize.define(
  'Group',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    avatar: DataTypes.STRING,
    ownerId: {
      type: DataTypes.STRING,
      allowNull: false
    }
  },
  { ...common, tableName: 'groups' }
);

const GroupMember = sequelize.define(
  'GroupMember',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    groupId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    role: {
      type: DataTypes.ENUM('owner', 'member'),
      defaultValue: 'member',
      allowNull: false
    }
  },
  { ...common, tableName: 'group_members' }
);

const GroupReadState = sequelize.define(
  'GroupReadState',
  {
    groupId: {
      type: DataTypes.UUID,
      primaryKey: true
    },
    userId: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    lastReadAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    }
  },
  {
    timestamps: false,
    underscored: true,
    tableName: 'group_read_states'
  }
);

const Upload = sequelize.define(
  'Upload',
  {
    path: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    ownerId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    state: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'pending'
    },
    bytes: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    }
  },
  {
    ...common,
    updatedAt: false,
    tableName: 'uploads'
  }
);

// All application DB mutations use this single-process queue.
// Do not run other writers against the same database while this server runs.

let queueTail = Promise.resolve();
let queueSize = 0;
let stopping = false;
let ready = false;

function serial(fn) {
  if (stopping || queueSize >= MAX_QUEUE) {
    return Promise.reject(new ApiError(503, 'Сервер занят', 'busy'));
  }

  queueSize++;
  const deadline = Date.now() + MAX_QUEUE_AGE;

  const work = queueTail.then(async () => {
    if (stopping || Date.now() > deadline) {
      reject(503, 'Сервер занят', 'busy');
    }

    return fn();
  });

  queueTail = work.catch(() => {}).finally(() => {
    queueSize--;
  });

  return work;
}

// Distinct timestamps prevent a message written in the same millisecond as a
// read marker from incorrectly becoming "already read".
let logicalTime = Date.now();

function nextTime() {
  logicalTime = Math.max(Date.now(), logicalTime + 1);
  return new Date(logicalTime);
}

// -----------------------------------------------------------------------------
// Rate limits
// -----------------------------------------------------------------------------

const limiterTimers = new Set();

function limiter(max, windowMs) {
  const map = new Map();

  const tick = setInterval(() => {
    const now = Date.now();

    for (const [key, value] of map) {
      if (value.until <= now) map.delete(key);
    }
  }, windowMs);

  tick.unref();
  limiterTimers.add(tick);

  return key => {
    const now = Date.now();
    let hit = map.get(key);

    if (!hit || hit.until <= now) {
      if (hit) map.delete(key);
      if (map.size >= 20_000) return false;

      hit = { count: 0, until: now + windowMs };
      map.set(key, hit);
    }

    hit.count++;
    return hit.count <= max;
  };
}

const connectionLimit = limiter(40, 60_000);
const eventLimit = limiter(500, 10_000);
const messageLimit = limiter(30, 10_000);
const friendLimit = limiter(20, 60_000);
const groupLimit = limiter(20, 60_000);
const typingLimit = limiter(30, 10_000);
const startCallLimit = limiter(10, 60_000);
const signalLimit = limiter(300, 10_000);
const authUserLimit = limiter(20, 15 * 60_000);
const uploadUserLimit = limiter(10, 60_000);

function checkLimit(check, uid) {
  if (!check(uid)) {
    reject(429, 'Слишком много действий', 'rate_limited');
  }
}

// -----------------------------------------------------------------------------
// HTTP and Socket.IO
// -----------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('query parser', 'simple');

// Never implicitly trust one proxy hop in production.
// Configure explicit proxy IPs/subnets when using a reverse proxy.
const trustProxyRaw = process.env.TRUST_PROXY?.trim();

if (!trustProxyRaw || trustProxyRaw === 'false') {
  app.set('trust proxy', false);
} else {
  if (
    trustProxyRaw === 'true' ||
    /^\d+$/.test(trustProxyRaw) ||
    trustProxyRaw.split(',').some(s =>
      ['0.0.0.0/0', '::/0'].includes(s.trim())
    )
  ) {
    fail('TRUST_PROXY must list trusted proxy IPs/subnets, not true or hop count');
  }

  const entries = trustProxyRaw.split(',').map(s => s.trim());

  if (entries.some(s => !s)) fail('Invalid TRUST_PROXY');

  app.set('trust proxy', entries);
}

function requestIp(req) {
  return proxyaddr(req, app.get('trust proxy fn'));
}

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;

function corsOrigin(origin, callback) {
  const allowed = !origin || originSet.has(origin);

  callback(
    allowed ? null : new ApiError(403, 'Origin запрещён', 'forbidden'),
    allowed
  );
}

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 100_000,
  connectTimeout: 10_000,
  allowRequest(req, callback) {
    try {
      callback(
        null,
        ready &&
          !stopping &&
          io.engine.clientsCount < MAX_SOCKET_CONNECTIONS &&
          connectionLimit(requestIp(req)) &&
          (!req.headers.origin || originSet.has(req.headers.origin))
      );
    } catch {
      callback(null, false);
    }
  }
});

const MEDIA_COOKIE_SAME_SITE =
  process.env.MEDIA_COOKIE_SAME_SITE || 'lax';

if (!['lax', 'strict', 'none'].includes(MEDIA_COOKIE_SAME_SITE)) {
  fail('MEDIA_COOKIE_SAME_SITE must be lax, strict or none');
}

if (MEDIA_COOKIE_SAME_SITE === 'none' && !production) {
  fail('MEDIA_COOKIE_SAME_SITE=none requires production HTTPS cookies');
}

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: [
          "'self'",
          ...origins,
          ...origins.map(origin => origin.replace(/^http/, 'ws'))
        ],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: production ? [] : null
      }
    },
    strictTransportSecurity: production ? undefined : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' }
  })
);

app.use(cors({ origin: corsOrigin, credentials: true }));

const rate = (windowMs, limit) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: 'Слишком много запросов',
      reason: 'rate_limited'
    }
  });

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api', rate(60_000, 180));
app.use('/uploads', rate(60_000, 300));

app.get('/api/health', (req, res) => {
  res.status(ready && !stopping ? 200 : 503).json({
    status: ready && !stopping ? 'ok' : 'error'
  });
});

app.use('/api', (req, res, next) => {
  if (!ready || stopping) {
    return res.status(503).json({
      error: 'Сервер не готов',
      reason: 'unavailable'
    });
  }

  next();
});

app.use(express.json({ limit: '32kb', strict: true }));
app.use(
  express.urlencoded({
    extended: false,
    limit: '32kb',
    parameterLimit: 30
  })
);

app.use('/api', (req, res, next) => {
  if (req.body !== undefined && !record(req.body)) {
    return res.status(400).json({
      error: 'Ожидается объект',
      reason: 'bad_request'
    });
  }

  next();
});

const authRate = rate(15 * 60_000, 30);
const uploadRate = rate(60_000, 20);

function signToken(
  user,
  audience = 'chatapp-api',
  expiry = JWT_EXPIRES_IN
) {
  return jwt.sign(
    { id: user.id, v: user.tokenVersion },
    JWT_SECRET,
    {
      algorithm: 'HS256',
      issuer: 'chatapp',
      audience,
      expiresIn: expiry
    }
  );
}

async function verifyToken(token, audience = 'chatapp-api') {
  if (typeof token !== 'string' || !token || token.length > 4096) {
    return null;
  }

  let payload;

  try {
    payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'chatapp',
      audience
    });
  } catch {
    return null;
  }

  if (
    !record(payload) ||
    !idOK(payload.id) ||
    !Number.isSafeInteger(payload.v) ||
    payload.v < 0 ||
    !Number.isSafeInteger(payload.exp)
  ) {
    return null;
  }

  const user = await User.findByPk(payload.id);

  return user && user.tokenVersion === payload.v
    ? { payload, user }
    : null;
}

function bearer(req) {
  const header = req.headers.authorization;

  return typeof header === 'string'
    ? /^Bearer ([^\s]+)$/i.exec(header)?.[1]
    : undefined;
}

const cookieOptions = {
  httpOnly: true,
  secure: production,
  sameSite: MEDIA_COOKIE_SAME_SITE,
  path: '/uploads'
};

function mediaCookie(res, user) {
  res.cookie(
    'chatapp_media',
    signToken(user, 'chatapp-media', '1h'),
    { ...cookieOptions, maxAge: 3600_000 }
  );
}

function readMediaCookie(req) {
  const matches = (req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith('chatapp_media='));

  if (matches.length !== 1) return undefined;

  try {
    return decodeURIComponent(matches[0].slice('chatapp_media='.length));
  } catch {
    return undefined;
  }
}

async function authenticate(req, res, next) {
  try {
    req.authToken = bearer(req);

    const auth = await verifyToken(req.authToken);

    if (!auth) {
      reject(401, 'Токен недействителен или истёк', 'unauthorized');
    }

    req.user = auth.user;
    next();
  } catch (error) {
    next(error);
  }
}

function route(
  method,
  url,
  middleware,
  handler,
  { publicRoute = false } = {}
) {
  app[method](url, ...middleware, (req, res, next) => {
    serial(async () => {
      if (req.aborted || res.destroyed) return;

      if (!publicRoute) {
        const auth = await verifyToken(req.authToken);

        if (!auth) {
          reject(401, 'Сессия отозвана или истекла', 'unauthorized');
        }

        req.user = auth.user;
      }

      await handler(req, res);
    })
      .catch(next)
      .finally(() => {
        void cleanupRequestTmp(req).catch(error => {
          logger.warn('Temporary file cleanup failed', {
            requestId: req.requestId,
            error: error.message
          });
        });
      });
  });
}

// -----------------------------------------------------------------------------
// Users, access control, messages
// -----------------------------------------------------------------------------

const onlineUsers = new Map();

function sockets(userId) {
  return [...(onlineUsers.get(userId) || [])]
    .map(id => io.sockets.sockets.get(id))
    .filter(socket => socket?.connected && socket.initialized);
}

function online(userId) {
  return sockets(userId).length > 0;
}

function publicUser(user) {
  return {
    id: user.id,
    nickname: user.nickname,
    avatar: user.avatar,
    status: user.status,
    online: online(user.id)
  };
}

function privateUser(user) {
  return {
    ...publicUser(user),
    bio: user.bio,
    friends: user.friends,
    friendRequests: user.friendRequests,
    blockedUsers: user.blockedUsers
  };
}

function profileUpdate(user) {
  const payload = { ...publicUser(user), bio: user.bio };

  io.to(userRoom(user.id)).emit('profileUpdated', payload);

  for (const id of user.friends) {
    io.to(userRoom(id)).emit('userUpdated', payload);
  }

  return payload;
}

async function dmAccess(meId, otherId, transaction) {
  if (!idOK(otherId) || otherId === meId) {
    reject(400, 'Некорректный ID');
  }

  const options = transaction ? { transaction } : {};

  const me = await User.findByPk(meId, options);
  const other = await User.findByPk(otherId, options);

  if (!me || !other || other.blockedUsers.includes(meId)) {
    reject(404, 'Пользователь недоступен', 'not_found');
  }

  if (me.blockedUsers.includes(otherId)) {
    reject(403, 'Пользователь заблокирован', 'blocked');
  }

  if (
    !me.friends.includes(otherId) ||
    !other.friends.includes(meId)
  ) {
    reject(403, 'Пользователь не в друзьях', 'not_friends');
  }

  return { me, other };
}

async function membership(
  userId,
  groupId,
  owner = false,
  transaction
) {
  if (!uuidOK(groupId)) reject(400, 'Некорректный ID группы');

  const options = transaction ? { transaction } : {};
  const group = await Group.findByPk(groupId, options);

  const member = group
    ? await GroupMember.findOne({
        where: { groupId, userId },
        ...options
      })
    : null;

  if (!group || !member) {
    reject(403, 'Вы не участник группы', 'not_member');
  }

  if (
    owner &&
    (group.ownerId !== userId || member.role !== 'owner')
  ) {
    reject(403, 'Только владелец группы', 'not_owner');
  }

  return { group, member };
}

async function groupData(groupId) {
  const group = await Group.findByPk(groupId);
  if (!group) return null;

  const members = await GroupMember.findAll({
    where: { groupId },
    order: [['createdAt', 'ASC'], ['id', 'ASC']]
  });

  const ids = members.map(member => member.userId);

  const users = ids.length
    ? await User.findAll({
        where: { id: { [Op.in]: ids } },
        attributes: ['id', 'nickname', 'avatar']
      })
    : [];

  const byId = new Map(users.map(user => [user.id, user]));

  return {
    id: group.id,
    name: group.name,
    avatar: group.avatar,
    ownerId: group.ownerId,
    createdAt: group.createdAt,
    members: members
      .filter(member => byId.has(member.userId))
      .map(member => ({
        id: member.userId,
        nickname: byId.get(member.userId).nickname,
        avatar: byId.get(member.userId).avatar,
        online: online(member.userId),
        role: member.role
      }))
  };
}

function groupRoomJoin(userId, groupId) {
  for (const socket of sockets(userId)) {
    socket.join(groupRoom(groupId));
  }
}

function groupRoomLeave(userId, groupId) {
  for (const socket of sockets(userId)) {
    socket.leave(groupRoom(groupId));
  }
}

function serializeMessage(message) {
  return {
    _id: message.id,
    from: message.from,
    to: message.to,
    groupId: message.groupId,
    text: message.deleted ? '' : message.text,
    image: message.deleted ? null : message.image,
    type: message.type,
    deleted: message.deleted,
    read: message.read,
    time: message.createdAt.toISOString(),
    ...(message.clientId ? { clientId: message.clientId } : {})
  };
}

function queryInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    reject(400, `Некорректный ${name}`);
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    reject(400, `Некорректный ${name}`);
  }

  return parsed;
}

function parsePage(query) {
  const limit = queryInteger(query.limit, 50, 1, 100, 'limit');

  if (query.beforeId !== undefined && !uuidOK(query.beforeId)) {
    reject(400, 'Некорректный beforeId');
  }

  if (query.beforeId && !query.before) {
    reject(400, 'beforeId требует before');
  }

  if (query.before === undefined) {
    return { limit, cursor: {} };
  }

  if (
    typeof query.before !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(query.before)
  ) {
    reject(400, 'before должен быть ISO timestamp из поля time');
  }

  const time = new Date(query.before);

  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString() !== query.before
  ) {
    reject(400, 'Некорректный before');
  }

  return {
    limit,
    cursor: query.beforeId
      ? {
          [Op.or]: [
            { createdAt: { [Op.lt]: time } },
            {
              createdAt: time,
              id: { [Op.lt]: query.beforeId }
            }
          ]
        }
      : { createdAt: { [Op.lt]: time } }
  };
}

async function history(where, query) {
  const { limit, cursor } = parsePage(query);

  const rows = await Message.findAll({
    where: { [Op.and]: [where, cursor] },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit
  });

  return rows.reverse().map(serializeMessage);
}

async function advanceRead(groupId, userId, time, transaction) {
  await sequelize.query(
    `INSERT INTO group_read_states (group_id, user_id, last_read_at)
     VALUES (:g, :u, :time)
     ON CONFLICT (group_id, user_id)
     DO UPDATE SET last_read_at =
       GREATEST(group_read_states.last_read_at, EXCLUDED.last_read_at)`,
    {
      replacements: { g: groupId, u: userId, time },
      transaction
    }
  );
}

// -----------------------------------------------------------------------------
// Uploads
// -----------------------------------------------------------------------------

sharp.cache({ memory: 32, files: 0, items: 50 });
sharp.concurrency(2);

let uploading = 0;
const activeTmp = new Set();

function trackTmp(req, filename) {
  const absolute = path.join(TMP_DIR, filename);

  req.tmpPaths ||= new Set();
  req.tmpPaths.add(absolute);
  activeTmp.add(absolute);

  return absolute;
}

async function discardTmp(file) {
  if (!file?.path || path.dirname(file.path) !== TMP_DIR) return;

  await fs.promises.unlink(file.path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function cleanupRequestTmp(req) {
  const paths = [...(req.tmpPaths || [])];

  for (const p of paths) {
    if (path.dirname(p) !== TMP_DIR) continue;

    try {
      await fs.promises.unlink(p).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    } finally {
      activeTmp.delete(p);
      req.tmpPaths?.delete(p);
    }
  }

  await discardTmp(req.file);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename(req, file, callback) {
      const name = `${crypto.randomUUID()}.tmp`;
      trackTmp(req, name);
      callback(null, name);
    }
  }),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 0,
    parts: 1,
    fieldNameSize: 64,
    headerPairs: 100
  },
  fileFilter(req, file, callback) {
    const mime = String(file.mimetype || '').toLowerCase();

    const allowed = new Set([
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/octet-stream'
    ]);

    if (!allowed.has(mime)) {
      return callback(
        new ApiError(400, 'Поддерживаются JPEG, PNG, WEBP и GIF')
      );
    }

    callback(null, true);
  }
});

async function uploadGuard(req, res, next) {
  let release;

  try {
    checkLimit(uploadUserLimit, req.user.id);

    if (uploading >= 4) reject(503, 'Загрузка занята', 'busy');

    uploading++;
    let released = false;

    release = () => {
      if (!released) {
        released = true;
        uploading--;
      }
    };

    res.once('finish', release);
    res.once('close', release);

    const stat = await fs.promises.statfs(UPLOAD_DIR, { bigint: true });

    if (stat.bavail * stat.bsize < BigInt(MIN_FREE_DISK_BYTES)) {
      reject(507, 'Недостаточно места на диске', 'storage_full');
    }

    if (req.aborted || res.destroyed) {
      release();
      return;
    }

    next();
  } catch (error) {
    release?.();
    next(error);
  }
}

async function unlinkMedia(publicPath) {
  if (!FILE_RE.test(publicPath || '')) return;

  await fs.promises
    .unlink(path.join(UPLOAD_DIR, path.basename(publicPath)))
    .catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
}

async function finalizeUpload(req) {
  if (!req.file) {
    reject(400, 'Загрузите изображение JPEG, PNG, WEBP или GIF');
  }

  const pending = await Upload.count({
    where: { ownerId: req.user.id, state: 'pending' }
  });

  if (pending >= MAX_PENDING_UPLOADS) {
    reject(429, 'Слишком много неотправленных изображений');
  }

  // Files pending deletion still consume disk space and count towards quota.
  const [usage] = await sequelize.query(
    `SELECT COALESCE(SUM(bytes), 0)::text AS used
     FROM uploads WHERE owner_id = :u`,
    {
      replacements: { u: req.user.id },
      type: QueryTypes.SELECT
    }
  );

  const used = BigInt(usage.used);
  const output = trackTmp(req, `${crypto.randomUUID()}.tmp`);
  const name = `${crypto.randomUUID()}.webp`;
  const publicPath = `/uploads/${name}`;
  const destination = path.join(UPLOAD_DIR, name);

  try {
    const image = sharp(req.file.path, {
      limitInputPixels: 16_000_000,
      failOn: 'warning',
      animated: false
    });

    const metadata = await image.metadata();

    if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) {
      reject(400, 'Недопустимый формат изображения', 'invalid_image');
    }

    await image
      .rotate()
      .resize({
        width: 4096,
        height: 4096,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 85 })
      .timeout({ seconds: 8 })
      .toFile(output);
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (
      ['ENOSPC', 'EACCES', 'EROFS', 'EIO', 'EMFILE'].includes(error.code)
    ) {
      throw error;
    }

    logger.warn('Image decoding failed', {
      requestId: req.requestId,
      error: error.message
    });

    reject(400, 'Повреждённое или недопустимое изображение', 'invalid_image');
  }

  const size = (await fs.promises.stat(output)).size;

  if (size > MAX_IMAGE_BYTES) {
    reject(400, 'Изображение слишком большое', 'invalid_image');
  }

  if (used + BigInt(size) > BigInt(MAX_USER_MEDIA_BYTES)) {
    reject(429, 'Достигнут лимит хранилища изображений', 'storage_limit');
  }

  if (req.aborted) reject(400, 'Загрузка прервана');

  await fs.promises.chmod(output, 0o600);
  await fs.promises.rename(output, destination);

  try {
    await Upload.create({
      path: publicPath,
      ownerId: req.user.id,
      state: 'pending',
      bytes: size
    });
  } catch (error) {
    await unlinkMedia(publicPath).catch(cleanupError => {
      logger.error('Orphan upload cleanup failed', {
        error: cleanupError.message
      });
    });

    throw error;
  }

  return publicPath;
}

async function claimUpload(publicPath, userId, transaction) {
  if (!publicPath) return;

  if (!FILE_RE.test(publicPath)) {
    reject(400, 'Недопустимое изображение', 'invalid_image');
  }

  const [count] = await Upload.update(
    { state: 'attached' },
    {
      where: {
        path: publicPath,
        ownerId: userId,
        state: 'pending',
        createdAt: {
          [Op.gte]: new Date(Date.now() - PENDING_TTL)
        }
      },
      transaction
    }
  );

  if (count !== 1) {
    reject(
      400,
      'Изображение не принадлежит вам, просрочено или уже использовано',
      'invalid_image'
    );
  }
}

async function retireMedia(publicPath, ownerId, transaction) {
  if (!FILE_RE.test(publicPath || '')) return;

  // Preserve the original owner and byte count.
  await Upload.findOrCreate({
    where: { path: publicPath },
    defaults: {
      ownerId,
      state: 'deleting',
      bytes: 0
    },
    transaction
  });

  await Upload.update(
    { state: 'deleting' },
    { where: { path: publicPath }, transaction }
  );
}

async function fileReferenced(publicPath) {
  return Boolean(
    await Message.findOne({
      where: { image: publicPath, deleted: false },
      attributes: ['id']
    }) ||
    await User.findOne({
      where: { avatar: publicPath },
      attributes: ['id']
    }) ||
    await Group.findOne({
      where: { avatar: publicPath },
      attributes: ['id']
    })
  );
}

// Persistent directory handles bound work per cleanup run.
const sweepHandles = new Map();

async function sweepDirectory(directory, visit, limit = 100) {
  let handle = sweepHandles.get(directory);

  if (!handle) {
    handle = await fs.promises.opendir(directory);
    sweepHandles.set(directory, handle);
  }

  try {
    for (let i = 0; i < limit; i++) {
      const entry = await handle.read();

      if (!entry) {
        sweepHandles.delete(directory);
        await handle.close();
        return;
      }

      await visit(entry);
    }
  } catch (error) {
    sweepHandles.delete(directory);
    await handle.close().catch(() => {});
    throw error;
  }
}

async function cleanupUploads() {
  const candidates = await Upload.findAll({
    where: {
      [Op.or]: [
        { state: 'deleting' },
        {
          state: 'pending',
          createdAt: {
            [Op.lt]: new Date(Date.now() - PENDING_TTL)
          }
        }
      ]
    },
    order: [['createdAt', 'ASC'], ['path', 'ASC']],
    limit: 100
  });

  for (const item of candidates) {
    if (await fileReferenced(item.path)) {
      await item.update({ state: 'attached' });
      continue;
    }

    await unlinkMedia(item.path);
    await item.destroy();
  }

  await sweepDirectory(TMP_DIR, async entry => {
    if (!TMP_RE.test(entry.name)) return;

    const absolute = path.join(TMP_DIR, entry.name);
    if (activeTmp.has(absolute)) return;

    const stat = await fs.promises.lstat(absolute).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });

    if (stat && Date.now() - stat.mtimeMs > 3600_000) {
      await fs.promises.unlink(absolute).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  });

  await sweepDirectory(UPLOAD_DIR, async entry => {
    const publicPath = `/uploads/${entry.name}`;
    if (!FILE_RE.test(publicPath)) return;

    const stat = await fs.promises
      .lstat(path.join(UPLOAD_DIR, entry.name))
      .catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });

    if (!stat || Date.now() - stat.mtimeMs < PENDING_TTL) return;

    if (
      !await Upload.findByPk(publicPath) &&
      !await fileReferenced(publicPath)
    ) {
      await unlinkMedia(publicPath);
    }
  });
}

// -----------------------------------------------------------------------------
// HTTP API
// -----------------------------------------------------------------------------

const DUMMY_HASH = bcrypt.hashSync(
  crypto.randomBytes(32).toString('base64'),
  12
);

route(
  'post',
  '/api/register',
  [authRate],
  async (req, res) => {
    const { userId, nickname, password } = req.body || {};

    const id =
      typeof userId === 'string'
        ? userId.trim().toLowerCase()
        : '';

    if (!idOK(id)) {
      reject(400, 'ID: 3–30 символов a-z, 0-9, _');
    }

    if (!validPassword(password)) {
      reject(400, 'Пароль: минимум 8 символов, максимум 72 байта UTF-8, без NUL');
    }

    checkLimit(authUserLimit, id);

    const nick =
      nickname === undefined
        ? id
        : boundedText(nickname, 50, { required: true, min: 1 });

    const passwordHash = await bcrypt.hash(password, 12);

    if (req.aborted || res.destroyed) return;

    let user;

    try {
      user = await User.create({ id, nickname: nick, passwordHash });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        reject(409, 'Этот ID уже занят', 'id_taken');
      }

      throw error;
    }

    mediaCookie(res, user);

    res.json({
      success: true,
      token: signToken(user),
      user: privateUser(user)
    });
  },
  { publicRoute: true }
);

route(
  'post',
  '/api/login',
  [authRate],
  async (req, res) => {
    const { userId, password } = req.body || {};

    const id =
      typeof userId === 'string'
        ? userId.trim().toLowerCase()
        : '';

    if (!idOK(id) || !loginPasswordOK(password)) {
      reject(401, 'Неверный ID или пароль', 'unauthorized');
    }

    checkLimit(authUserLimit, id);

    const user = await User.findByPk(id);
    const match = await bcrypt.compare(
      password,
      user ? user.passwordHash : DUMMY_HASH
    );

    if (!user || !match) {
      reject(401, 'Неверный ID или пароль', 'unauthorized');
    }

    mediaCookie(res, user);

    res.json({
      success: true,
      token: signToken(user),
      user: privateUser(user)
    });
  },
  { publicRoute: true }
);

async function revokeSessions(user, passwordHash) {
  const rows = await sequelize.query(
    `UPDATE users
     SET token_version = token_version + 1,
         updated_at = NOW()
         ${passwordHash ? ', password_hash = :hash' : ''}
     WHERE id = :id
     RETURNING token_version AS "tokenVersion"`,
    {
      replacements: {
        id: user.id,
        hash: passwordHash || ''
      },
      type: QueryTypes.SELECT
    }
  );

  if (!rows.length) {
    reject(401, 'Пользователь не найден', 'unauthorized');
  }

  user.tokenVersion = rows[0].tokenVersion;

  for (const call of [...calls.values()]) {
    if (
      call.type === 'dm' &&
      [call.initiator, call.targetId].includes(user.id)
    ) {
      endCall(call, 'session_revoked');
    } else if (call.participants.has(user.id)) {
      leaveCall(user.id, call.callId, 'session_revoked');
    }
  }

  io.in(userRoom(user.id)).disconnectSockets(true);
}

route(
  'post',
  '/api/password/change',
  [authRate, authenticate],
  async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (
      !loginPasswordOK(currentPassword) ||
      !validPassword(newPassword)
    ) {
      reject(400, 'Некорректный пароль: 8+ символов, до 72 байт UTF-8');
    }

    if (currentPassword === newPassword) {
      reject(400, 'Новый пароль совпадает с текущим');
    }

    checkLimit(authUserLimit, req.user.id);

    if (!await bcrypt.compare(currentPassword, req.user.passwordHash)) {
      reject(401, 'Текущий пароль неверен', 'unauthorized');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await revokeSessions(req.user, passwordHash);

    mediaCookie(res, req.user);
    res.json({ success: true, token: signToken(req.user) });
  }
);

route('post', '/api/logout-all', [authenticate], async (req, res) => {
  await revokeSessions(req.user);
  res.clearCookie('chatapp_media', cookieOptions);
  res.json({ success: true });
});

function turnConfig(userId) {
  const urls = (process.env.TURN_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(url => url.replace(/^turn(s?):\/\//i, 'turn$1:'));

  const validUrls =
    urls.length > 0 &&
    urls.every(url =>
      /^turns?:(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url)
    );

  const hasCredentials = Boolean(
    process.env.TURN_SHARED_SECRET ||
    (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL)
  );

  const configured = validUrls && hasCredentials;
  const required = boolEnv('TURN_FORCE_RELAY', false);

  const iceServers = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302'
      ]
    }
  ];

  if (configured) {
    if (process.env.TURN_SHARED_SECRET) {
      const username =
        `${Math.floor(Date.now() / 1000) + 3600}:${userId}`;

      const credential = crypto
        .createHmac('sha1', process.env.TURN_SHARED_SECRET)
        .update(username)
        .digest('base64');

      iceServers.push({ urls, username, credential });
    } else {
      iceServers.push({
        urls,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL
      });
    }
  }

  return {
    iceServers,
    iceTransportPolicy: required ? 'relay' : 'all',
    iceCandidatePoolSize: 0,
    relayConfigured: configured,
    relayRequired: required,
    relayError:
      required && !configured
        ? 'TURN_FORCE_RELAY включён, но TURN не настроен'
        : null
  };
}

route('get', '/api/rtc-config', [authenticate], async (req, res) => {
  const config = turnConfig(req.user.id);

  // Fail closed: never silently use a direct connection if relay is required.
  res.status(config.relayError ? 503 : 200).json(config);
});

route('get', '/api/me', [authenticate], async (req, res) => {
  mediaCookie(res, req.user);
  res.json(privateUser(req.user));
});

route('get', '/api/friends', [authenticate], async (req, res) => {
  const me = req.user;
  const ids = [...new Set([...me.friends, ...me.friendRequests])];

  const users = ids.length
    ? await User.findAll({ where: { id: { [Op.in]: ids } } })
    : [];

  const byId = new Map(
    users
      .filter(user =>
        !user.blockedUsers.includes(me.id) &&
        !me.blockedUsers.includes(user.id)
      )
      .map(user => [user.id, publicUser(user)])
  );

  res.json({
    friends: me.friends.map(id => byId.get(id)).filter(Boolean),
    requests: me.friendRequests.map(id => byId.get(id)).filter(Boolean)
  });
});

route(
  'get',
  '/api/search',
  [rate(60_000, 30), authenticate],
  async (req, res) => {
    const query = boundedText(req.query.q ?? '', 50);
    if (!query) return res.json([]);

    // Escape LIKE wildcards: "%" and "_" are searched as literal text.
    const escaped = query.replace(/[\\%_]/g, '\\$&');

    const where = {
      id: {
        [Op.notIn]: [req.user.id, ...req.user.blockedUsers]
      },
      [Op.not]: {
        blockedUsers: { [Op.contains]: [req.user.id] }
      },
      [Op.or]: [
        { id: { [Op.iLike]: `%${escaped}%` } },
        { nickname: { [Op.iLike]: `%${escaped}%` } }
      ]
    };

    const users = await User.findAll({
      where,
      attributes: ['id', 'nickname', 'avatar', 'status'],
      order: [['id', 'ASC']],
      limit: 10
    });

    res.json(users.map(publicUser));
  }
);

route(
  'get',
  '/api/profile/:userId',
  [authenticate],
  async (req, res) => {
    const user = idOK(req.params.userId)
      ? await User.findByPk(req.params.userId)
      : null;

    if (
      !user ||
      (
        user.id !== req.user.id &&
        (
          user.blockedUsers.includes(req.user.id) ||
          req.user.blockedUsers.includes(user.id)
        )
      )
    ) {
      reject(404, 'Пользователь не найден', 'not_found');
    }

    res.json({
      ...publicUser(user),
      bio: user.bio,
      createdAt: user.createdAt
    });
  }
);

route(
  'post',
  '/api/profile/update',
  [authenticate],
  async (req, res) => {
    const user = req.user;
    const { nickname, status, bio, avatar } = req.body || {};
    const values = {};

    if (nickname !== undefined) {
      values.nickname = boundedText(nickname, 50, { min: 1 });
    }

    if (status !== undefined) {
      values.status = boundedText(status, 150);
    }

    if (bio !== undefined) {
      values.bio = boundedText(bio, 1000);
    }

    if (
      avatar !== undefined &&
      avatar !== null &&
      avatar !== user.avatar
    ) {
      reject(400, 'Аватар изменяется через загрузку файла');
    }

    await sequelize.transaction(async transaction => {
      if (avatar === null) {
        await retireMedia(user.avatar, user.id, transaction);
        values.avatar = null;
      }

      if (Object.keys(values).length) {
        await user.update(values, { transaction });
      }
    });

    res.json({
      success: true,
      user: profileUpdate(user)
    });
  }
);

route(
  'post',
  '/api/upload/image',
  [authenticate, uploadRate, uploadGuard, upload.single('image')],
  async (req, res) => {
    const url = await finalizeUpload(req);
    res.json({ success: true, url });
  }
);

route(
  'post',
  '/api/upload/avatar',
  [authenticate, uploadRate, uploadGuard, upload.single('avatar')],
  async (req, res) => {
    const url = await finalizeUpload(req);
    const user = req.user;

    await sequelize.transaction(async transaction => {
      await claimUpload(url, user.id, transaction);
      await retireMedia(user.avatar, user.id, transaction);
      await user.update({ avatar: url }, { transaction });
    });

    profileUpdate(user);
    res.json({ success: true, avatar: url });
  }
);

route(
  'post',
  '/api/users/:id/block',
  [authenticate],
  async (req, res) => {
    const me = req.user;
    const targetId = req.params.id;

    checkLimit(friendLimit, me.id);

    if (!idOK(targetId) || targetId === me.id) {
      reject(400, 'Некорректный ID');
    }

    const target = await User.findByPk(targetId);

    if (!target) reject(404, 'Пользователь не найден', 'not_found');

    if (
      !me.blockedUsers.includes(targetId) &&
      me.blockedUsers.length >= MAX_BLOCKED
    ) {
      reject(400, 'Лимит заблокированных пользователей', 'limit_reached');
    }

    const hadRelation =
      target.friends.includes(me.id) ||
      target.friendRequests.includes(me.id) ||
      me.friendRequests.includes(targetId);

    await sequelize.transaction(async transaction => {
      await me.update(
        {
          blockedUsers: [...new Set([...me.blockedUsers, targetId])],
          friends: me.friends.filter(id => id !== targetId),
          friendRequests: me.friendRequests.filter(id => id !== targetId)
        },
        { transaction }
      );

      await target.update(
        {
          friends: target.friends.filter(id => id !== me.id),
          friendRequests: target.friendRequests.filter(id => id !== me.id)
        },
        { transaction }
      );
    });

    const call = callsByChat.get(dmKey(me.id, targetId));
    if (call) endCall(call, 'unavailable');

    if (hadRelation) {
      io.to(userRoom(targetId)).emit('friendRemoved', { id: me.id });
    }

    io.to(userRoom(me.id)).emit('friendRemoved', { id: targetId });
    io.to(userRoom(me.id)).emit('userBlocked', {
      id: targetId,
      blockedUsers: me.blockedUsers
    });

    res.json({ success: true, blockedUsers: me.blockedUsers });
  }
);

route(
  'post',
  '/api/users/:id/unblock',
  [authenticate],
  async (req, res) => {
    checkLimit(friendLimit, req.user.id);

    if (!idOK(req.params.id) || req.params.id === req.user.id) {
      reject(400, 'Некорректный ID');
    }

    await req.user.update({
      blockedUsers: req.user.blockedUsers.filter(id => id !== req.params.id)
    });

    io.to(userRoom(req.user.id)).emit('userUnblocked', {
      id: req.params.id,
      blockedUsers: req.user.blockedUsers
    });

    res.json({
      success: true,
      blockedUsers: req.user.blockedUsers
    });
  }
);

route(
  'get',
  '/api/users/blocked',
  [authenticate],
  async (req, res) => {
    const users = req.user.blockedUsers.length
      ? await User.findAll({
          where: { id: { [Op.in]: req.user.blockedUsers } },
          attributes: ['id', 'nickname', 'avatar']
        })
      : [];

    res.json(
      users.map(user => ({
        id: user.id,
        nickname: user.nickname,
        avatar: user.avatar
      }))
    );
  }
);

route(
  'get',
  '/api/messages/:userId/:friendId',
  [authenticate],
  async (req, res) => {
    if (req.user.id !== req.params.userId) {
      reject(403, 'Нет доступа', 'forbidden');
    }

    await dmAccess(req.user.id, req.params.friendId);

    res.json(
      await history(
        {
          chatKey: chatKey(req.user.id, req.params.friendId),
          groupId: null
        },
        req.query
      )
    );
  }
);

route(
  'delete',
  '/api/messages/:messageId',
  [authenticate],
  async (req, res) => {
    if (!uuidOK(req.params.messageId)) {
      reject(400, 'Некорректный ID сообщения');
    }

    const message = await Message.findByPk(req.params.messageId);

    if (!message) reject(404, 'Сообщение не найдено', 'not_found');

    if (message.groupId) {
      await membership(
        req.user.id,
        message.groupId,
        message.from !== req.user.id
      );
    } else if (message.from !== req.user.id) {
      reject(403, 'Нет доступа', 'forbidden');
    }

    if (message.deleted) return res.json({ success: true });

    await sequelize.transaction(async transaction => {
      await retireMedia(message.image, message.from, transaction);

      await message.update(
        { deleted: true, text: '', image: null },
        { transaction }
      );
    });

    if (message.groupId) {
      io.to(groupRoom(message.groupId)).emit('messageDeleted', {
        messageId: message.id,
        chatWith: null,
        groupId: message.groupId,
        by: req.user.id
      });
    } else {
      io.to(userRoom(message.from)).emit('messageDeleted', {
        messageId: message.id,
        chatWith: message.to
      });

      if (message.to) {
        io.to(userRoom(message.to)).emit('messageDeleted', {
          messageId: message.id,
          chatWith: message.from
        });
      }
    }

    res.json({ success: true });
  }
);

route('post', '/api/groups', [authenticate], async (req, res) => {
  const { name, memberIds } = req.body || {};
  const me = req.user;

  checkLimit(groupLimit, me.id);

  const cleanName = boundedText(name, 50, {
    required: true,
    min: 2
  });

  if (
    !Array.isArray(memberIds) ||
    memberIds.length > MAX_MEMBERS ||
    memberIds.some(id => !idOK(id))
  ) {
    reject(400, 'Некорректный список участников');
  }

  const ids = [...new Set([me.id, ...memberIds])];

  if (ids.length > MAX_MEMBERS) {
    reject(400, 'Максимум 50 участников', 'limit_reached');
  }

  for (const id of ids) {
    if (id !== me.id) await dmAccess(me.id, id);

    if (
      await GroupMember.count({ where: { userId: id } }) >= MAX_GROUPS
    ) {
      reject(400, 'У участника достигнут лимит групп', 'target_limit_reached');
    }
  }

  const group = await sequelize.transaction(async transaction => {
    const created = await Group.create(
      { name: cleanName, ownerId: me.id },
      { transaction }
    );

    await GroupMember.bulkCreate(
      ids.map(id => ({
        groupId: created.id,
        userId: id,
        role: id === me.id ? 'owner' : 'member'
      })),
      { transaction }
    );

    const readTime = nextTime();

    await GroupReadState.bulkCreate(
      ids.map(id => ({
        groupId: created.id,
        userId: id,
        lastReadAt: readTime
      })),
      { transaction }
    );

    return created;
  });

  for (const id of ids) groupRoomJoin(id, group.id);

  const data = await groupData(group.id);

  for (const id of ids) {
    io.to(userRoom(id)).emit(
      id === me.id ? 'groupCreated' : 'addedToGroup',
      { group: data }
    );
  }

  res.json({ success: true, group: data });
});

route('get', '/api/groups', [authenticate], async (req, res) => {
  const limit = queryInteger(req.query.limit, 100, 1, 100, 'limit');
  const offset = queryInteger(req.query.offset, 0, 0, 10_000, 'offset');

  const memberships = await GroupMember.findAll({
    where: { userId: req.user.id },
    attributes: ['groupId']
  });

  if (!memberships.length) return res.json([]);

  const groups = await Group.findAll({
    where: {
      id: { [Op.in]: memberships.map(member => member.groupId) }
    },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset
  });

  const result = [];

  for (const group of groups) {
    const data = await groupData(group.id);
    if (data) result.push(data);
  }

  res.json(result);
});

route(
  'patch',
  '/api/groups/:groupId',
  [authenticate],
  async (req, res) => {
    checkLimit(groupLimit, req.user.id);

    const { group } = await membership(
      req.user.id,
      req.params.groupId,
      true
    );

    await group.update({
      name: boundedText(req.body?.name, 50, {
        required: true,
        min: 2
      })
    });

    io.to(groupRoom(group.id)).emit('groupUpdated', {
      groupId: group.id,
      name: group.name,
      avatar: group.avatar
    });

    res.json({
      success: true,
      group: {
        id: group.id,
        name: group.name,
        avatar: group.avatar,
        ownerId: group.ownerId
      }
    });
  }
);

async function groupUploadAuth(req, res, next) {
  try {
    await membership(req.user.id, req.params.groupId, true);
    next();
  } catch (error) {
    next(error);
  }
}

route(
  'post',
  '/api/groups/:groupId/avatar',
  [
    authenticate,
    uploadRate,
    groupUploadAuth,
    uploadGuard,
    upload.single('avatar')
  ],
  async (req, res) => {
    const { group } = await membership(
      req.user.id,
      req.params.groupId,
      true
    );

    const url = await finalizeUpload(req);

    await sequelize.transaction(async transaction => {
      await claimUpload(url, req.user.id, transaction);
      await retireMedia(group.avatar, group.ownerId, transaction);
      await group.update({ avatar: url }, { transaction });
    });

    io.to(groupRoom(group.id)).emit('groupUpdated', {
      groupId: group.id,
      name: group.name,
      avatar: url
    });

    res.json({ success: true, avatar: url });
  }
);

route(
  'get',
  '/api/groups/:groupId/messages',
  [authenticate],
  async (req, res) => {
    await membership(req.user.id, req.params.groupId);

    res.json(
      await history({ groupId: req.params.groupId }, req.query)
    );
  }
);

// Images are never exposed through express.static.
app.get('/uploads/:filename', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie');
  res.vary('Authorization');

  serial(async () => {
    if (!ready || req.aborted || res.destroyed) {
      if (!res.destroyed) reject(503, 'Сервер не готов', 'unavailable');
      return;
    }

    const publicPath = `/uploads/${req.params.filename}`;

    if (!FILE_RE.test(publicPath)) {
      reject(404, 'Файл не найден', 'not_found');
    }

    let auth;

    if (req.headers.authorization !== undefined) {
      auth = await verifyToken(bearer(req));
    } else {
      auth = await verifyToken(readMediaCookie(req), 'chatapp-media');
    }

    if (!auth) reject(401, 'Не авторизован', 'unauthorized');

    const uid = auth.user.id;
    const ledger = await Upload.findByPk(publicPath);

    let allowed = Boolean(
      ledger?.state === 'pending' &&
      ledger.ownerId === uid &&
      Date.now() - ledger.createdAt.getTime() < PENDING_TTL
    );

    if (!allowed) {
      const avatarUser = await User.findOne({
        where: { avatar: publicPath }
      });

      if (
        avatarUser &&
        (
          avatarUser.id === uid ||
          (
            !avatarUser.blockedUsers.includes(uid) &&
            !auth.user.blockedUsers.includes(avatarUser.id)
          )
        )
      ) {
        allowed = true;
      }
    }

    if (!allowed) {
      const avatarGroup = await Group.findOne({
        where: { avatar: publicPath },
        attributes: ['id']
      });

      if (avatarGroup) {
        allowed = Boolean(
          await GroupMember.findOne({
            where: { groupId: avatarGroup.id, userId: uid }
          })
        );
      }
    }

    if (!allowed) {
      const message = await Message.findOne({
        where: { image: publicPath, deleted: false }
      });

      if (message?.groupId) {
        allowed = Boolean(
          await GroupMember.findOne({
            where: { groupId: message.groupId, userId: uid }
          })
        );
      } else if (
        message &&
        (message.from === uid || message.to === uid)
      ) {
        try {
          await dmAccess(
            uid,
            message.from === uid ? message.to : message.from
          );

          allowed = true;
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
        }
      }
    }

    if (!allowed) reject(404, 'Файл не найден', 'not_found');

    const absolute = path.join(UPLOAD_DIR, req.params.filename);
    const stat = await fs.promises.lstat(absolute);

    if (!stat.isFile() || stat.isSymbolicLink()) {
      reject(404, 'Файл не найден', 'not_found');
    }

    if (res.destroyed) return;

    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });

    res.sendFile(
      absolute,
      {
        dotfiles: 'deny',
        acceptRanges: false,
        cacheControl: false,
        lastModified: false,
        headers: { 'Cache-Control': 'private, no-store' }
      },
      error => {
        if (error) next(error);
      }
    );
  }).catch(next);
});

app.use('/uploads', (req, res) => {
  res.status(404).json({
    error: 'Файл не найден',
    reason: 'not_found'
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'Маршрут не найден',
    reason: 'not_found'
  });
});

app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));

if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  app.get(/^\/(?!api(?:\/|$)|uploads(?:\/|$)).*/, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  void cleanupRequestTmp(req).catch(cleanupError => {
    logger.warn('Request temporary cleanup failed', {
      requestId: req.requestId,
      error: cleanupError.message
    });
  });

  if (res.headersSent) return next(error);
  if (res.destroyed) return;

  let status = 500;
  let message = 'Внутренняя ошибка сервера';
  let reason = 'server_error';

  if (error instanceof ApiError) {
    status = error.status;
    message = error.message;
    reason = error.reason;
  } else if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message = 'Разрешён один файл до 10 МБ без дополнительных полей';
    reason = 'invalid_upload';
  } else if (
    error.type === 'entity.parse.failed' ||
    error instanceof URIError ||
    error.type === 'request.aborted' ||
    error.type === 'request.size.invalid'
  ) {
    status = 400;
    message = 'Некорректный запрос';
    reason = 'bad_request';
  } else if (error.type === 'entity.too.large') {
    status = 413;
    message = 'Слишком большое тело запроса';
    reason = 'payload_too_large';
  } else if (
    error.type === 'encoding.unsupported' ||
    error.type === 'charset.unsupported'
  ) {
    status = 415;
    message = 'Неподдерживаемая кодировка';
    reason = 'unsupported_media_type';
  } else if (error.code === 'ENOENT' || error.status === 404) {
    status = 404;
    message = 'Файл не найден';
    reason = 'not_found';
  } else if (error.code === 'ENOSPC') {
    status = 507;
    message = 'Недостаточно места на диске';
    reason = 'storage_full';
  }

  if (status >= 500) {
    logger.error('HTTP error', {
      requestId: req.requestId,
      error: error.message,
      stack: error.stack
    });
  }

  res.status(status).json({
    error: message,
    reason,
    requestId: req.requestId
  });
});

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

const calls = new Map();
const callsByChat = new Map();
const pendingEvents = new Map();

const CALL_RECONNECT_GRACE_MS = 60_000;
const GROUP_EMPTY_GRACE_MS = 60_000;

function busyUser(uid, exceptCallId) {
  for (const call of calls.values()) {
    if (call.callId === exceptCallId) continue;

    if (
      call.participants.has(uid) ||
      (
        call.type === 'dm' &&
        !call.answered &&
        [call.initiator, call.targetId].includes(uid)
      )
    ) {
      return true;
    }
  }

  return false;
}

function voiceState(groupId, target = io.to(groupRoom(groupId))) {
  const call = callsByChat.get(groupRoom(groupId));

  target.emit(
    'groupVoiceState',
    call
      ? {
          groupId,
          callId: call.callId,
          video: call.video,
          participants: [...call.participants]
        }
      : {
          groupId,
          callId: null,
          participants: []
        }
  );
}

function dmVoiceState(call) {
  if (call.type !== 'dm') return;

  const live = calls.get(call.callId) === call && call.answered;

  for (const uid of [call.initiator, call.targetId]) {
    io.to(userRoom(uid)).emit('dmVoiceState', {
      peerId: uid === call.initiator ? call.targetId : call.initiator,
      callId: live ? call.callId : null,
      video: call.video,
      participants: live ? [...call.participants] : []
    });
  }
}

function invite(call) {
  return {
    callId: call.callId,
    chatKey: call.chatKey,
    isGroup: call.type === 'group',
    ...(call.groupId ? { groupId: call.groupId } : {}),
    video: call.video,
    from: call.initiator,
    fromNick: call.fromNick,
    fromAvatar: call.fromAvatar,
    createdAt: call.createdAt
  };
}

function endCall(call, reason = 'ended') {
  if (!call || calls.get(call.callId) !== call) return;

  calls.delete(call.callId);

  if (callsByChat.get(call.chatKey) === call) {
    callsByChat.delete(call.chatKey);
  }

  for (const timer of call.grace.values()) clearTimeout(timer);
  call.grace.clear();

  clearTimeout(call.emptyTimer);
  call.emptyTimer = null;

  if (
    call.type === 'dm' &&
    !call.answered &&
    ['cancelled', 'no_answer'].includes(reason)
  ) {
    io.to(userRoom(call.targetId)).emit('callCancelled', {
      callId: call.callId,
      reason
    });
  }

  const target =
    call.type === 'dm'
      ? io.to(userRoom(call.initiator)).to(userRoom(call.targetId))
      : io.to(callRoom(call.callId));

  target.emit('callEnded', {
    callId: call.callId,
    chatKey: call.chatKey,
    reason
  });

  const room = callRoom(call.callId);
  const socketIds = [...(io.sockets.adapter.rooms.get(room) || [])];

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    socket?.leave(room);
    socket?.activeCallKeys?.delete(call.chatKey);
  }

  call.participants.clear();
  call.peers.clear();

  if (call.type === 'group') voiceState(call.groupId);
  else dmVoiceState(call);
}

function scheduleEmptyGroupCall(call) {
  if (
    call.type !== 'group' ||
    call.emptyTimer ||
    call.participants.size
  ) {
    return;
  }

  call.emptyTimer = setTimeout(() => {
    call.emptyTimer = null;

    if (
      calls.get(call.callId) === call &&
      call.participants.size === 0
    ) {
      endCall(call, 'timeout');
    }
  }, GROUP_EMPTY_GRACE_MS);

  call.emptyTimer.unref();
  voiceState(call.groupId);
}

function leaveCall(uid, callId, reason = 'left') {
  const call = calls.get(callId);

  if (!call || !call.participants.has(uid)) return;

  // A DM does not remain alive with one participant after an explicit leave,
  // or after the disconnected participant's grace period expires.
  if (call.type === 'dm') {
    io.to(userRoom(uid)).emit('callLeft', { callId, reason });
    endCall(call, reason === 'left' ? 'ended' : reason);
    return;
  }

  clearTimeout(call.grace.get(uid));
  call.grace.delete(uid);
  call.participants.delete(uid);
  call.peers.delete(uid);

  for (const socket of sockets(uid)) {
    socket.leave(callRoom(callId));
    socket.activeCallKeys.delete(call.chatKey);
  }

  io.to(callRoom(callId)).emit('callPeerLeft', {
    callId,
    peerId: uid,
    reason
  });

  io.to(userRoom(uid)).emit('callLeft', { callId, reason });

  if (!call.participants.size) scheduleEmptyGroupCall(call);
  else voiceState(call.groupId);
}

function scheduleLeave(call, uid) {
  if (call.grace.has(uid) || calls.get(call.callId) !== call) return;

  const timer = setTimeout(() => {
    call.grace.delete(uid);

    if (
      calls.get(call.callId) !== call ||
      call.peers.has(uid)
    ) {
      return;
    }

    leaveCall(uid, call.callId, 'disconnected');
  }, CALL_RECONNECT_GRACE_MS);

  timer.unref();
  call.grace.set(uid, timer);

  io.to(callRoom(call.callId)).emit('callPeerReconnecting', {
    callId: call.callId,
    peerId: uid,
    graceMs: CALL_RECONNECT_GRACE_MS
  });
}

function attachCall(socket, call, notify = false) {
  requireLiveCall(call);

  if (!socket.connected || !socket.initialized) {
    reject(503, 'Соединение потеряно', 'disconnected');
  }

  const uid = socket.user.id;
  const oldSocketId = call.peers.get(uid);
  const already = call.participants.has(uid);
  const recovering = call.grace.has(uid);

  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);

    oldSocket?.leave(callRoom(call.callId));
    oldSocket?.activeCallKeys.delete(call.chatKey);
    oldSocket?.emit('callEnded', {
      callId: call.callId,
      chatKey: call.chatKey,
      reason: 'replaced_device'
    });
  }

  clearTimeout(call.grace.get(uid));
  call.grace.delete(uid);

  clearTimeout(call.emptyTimer);
  call.emptyTimer = null;

  call.participants.add(uid);
  call.peers.set(uid, socket.id);

  socket.join(callRoom(call.callId));
  socket.activeCallKeys.add(call.chatKey);

  if (
    !already ||
    recovering ||
    notify ||
    (oldSocketId && oldSocketId !== socket.id)
  ) {
    socket.to(callRoom(call.callId)).emit('callPeerJoined', {
      callId: call.callId,
      peerId: uid
    });
  }
}

function requireLiveCall(call) {
  if (!call || calls.get(call.callId) !== call) {
    reject(404, 'Звонок завершён', 'not_found');
  }
}

async function callAccess(call, uid) {
  requireLiveCall(call);

  if (call.type === 'dm') {
    if (![call.initiator, call.targetId].includes(uid)) {
      reject(403, 'Нет доступа', 'forbidden');
    }

    await dmAccess(
      uid,
      uid === call.initiator ? call.targetId : call.initiator
    );
  } else {
    await membership(uid, call.groupId);
  }

  // A timer may have ended the call while the DB request was running.
  requireLiveCall(call);
}

const ringTimer = setInterval(() => {
  for (const call of [...calls.values()]) {
    if (
      call.type === 'dm' &&
      !call.answered &&
      Date.now() - call.createdAt >= 90_000
    ) {
      endCall(call, 'no_answer');
    }
  }
}, 5000);

ringTimer.unref();

// -----------------------------------------------------------------------------
// Socket event handling
// -----------------------------------------------------------------------------

function socketError(socket, event, argument, error) {
  if (!(error instanceof ApiError)) {
    logger.error('Socket handler error', {
      event,
      socketId: socket.id,
      error: error?.message || String(error),
      stack: error?.stack
    });
  }

  const reason =
    error instanceof ApiError ? error.reason : 'server_error';

  const data = record(argument) ? argument : {};

  const correlation = {
    ...(idOK(data.toId) ? { toId: data.toId } : {}),
    ...(uuidOK(data.groupId) ? { groupId: data.groupId } : {}),
    ...(uuidOK(data.callId) ? { callId: data.callId } : {}),
    ...(clientId(data.requestId)
      ? { requestId: data.requestId }
      : {}),
    ...(clientId(data.clientId)
      ? { clientId: data.clientId }
      : {})
  };

  if (event === 'sendMessage' || event === 'groupMessage') {
    socket.emit('sendMessageError', { ...correlation, reason });
  } else if (event.toLowerCase().includes('friend')) {
    socket.emit('friendRequestError', {
      ...(idOK(argument)
        ? { toId: argument, targetId: argument }
        : {}),
      reason
    });
  } else if (
    event.startsWith('call') ||
    ['watchGroupVoice', 'watchDmVoice'].includes(event)
  ) {
    socket.emit('callError', { ...correlation, event, reason });
  } else {
    socket.emit('groupError', { ...correlation, event, reason });
  }

  if (reason === 'rate_limited') {
    socket.emit('rateLimited', event);
  }
}

function installEvent(socket, event, shape, handler) {
  socket.on(event, (...args) => {
    const uid = socket.user.id;

    const hasAck =
      args.length > 0 && typeof args[args.length - 1] === 'function';

    const callback = hasAck ? args[args.length - 1] : null;
    let acknowledged = false;

    const ack = payload => {
      if (!callback || acknowledged) return;
      acknowledged = true;
      callback(payload);
    };

    const count = args.length - (hasAck ? 1 : 0);
    const argument = args[0];

    const report = error => {
      socketError(socket, event, argument, error);

      ack({
        ok: false,
        reason:
          error instanceof ApiError ? error.reason : 'server_error',
        error:
          error instanceof ApiError ? error.message : 'Ошибка сервера'
      });
    };

    if (!socket.connected) return;

    if ((pendingEvents.get(uid) || 0) >= 16) {
      report(new ApiError(429, 'Слишком много событий', 'rate_limited'));
      return;
    }

    const validShape =
      shape === 'object'
        ? record(argument)
        : shape === 'groupId'
          ? uuidOK(argument)
          : shape === 'userId'
            ? idOK(argument)
            : false;

    if (count !== 1 || !validShape) {
      report(new ApiError(400, 'Некорректный payload'));
      return;
    }

    pendingEvents.set(uid, (pendingEvents.get(uid) || 0) + 1);

    serial(async () => {
      if (!socket.connected || !socket.initialized) {
        reject(503, 'Соединение не готово', 'disconnected');
      }

      const auth = await verifyToken(socket.authToken);

      if (!auth) {
        ack({
          ok: false,
          reason: 'unauthorized',
          error: 'Сессия истекла'
        });

        socket.disconnect(true);
        return;
      }

      if (!socket.connected) {
        reject(503, 'Соединение потеряно', 'disconnected');
      }

      socket.user = auth.user;

      const result = await handler(argument);

      ack({ ok: true, ...(result || {}) });
    })
      .catch(report)
      .finally(() => {
        const countLeft = (pendingEvents.get(uid) || 1) - 1;

        if (countLeft > 0) pendingEvents.set(uid, countLeft);
        else pendingEvents.delete(uid);
      });
  });
}

async function sendMessage(socket, data, isGroup) {
  const uid = socket.user.id;

  checkLimit(messageLimit, uid);

  const text = boundedText(data.text ?? '', 4000);
  const image =
    data.image === '' || data.image == null ? null : data.image;

  if (
    image !== null &&
    (typeof image !== 'string' || !FILE_RE.test(image))
  ) {
    reject(400, 'Недопустимое изображение', 'invalid_image');
  }

  if (!text && !image) {
    reject(400, 'Сообщение пустое', 'empty_message');
  }

  const cid = clientId(data.clientId);

  if (data.clientId !== undefined && !cid) {
    reject(400, 'Некорректный clientId');
  }

  let destination;

  if (isGroup) {
    if (data.toId !== undefined) reject(400, 'Укажите один чат');

    await membership(uid, data.groupId);

    destination = {
      groupId: data.groupId,
      chatKey: null,
      to: null
    };
  } else {
    if (data.groupId !== undefined && data.groupId !== null) {
      reject(400, 'Укажите один чат');
    }

    await dmAccess(uid, data.toId);

    destination = {
      groupId: null,
      chatKey: chatKey(uid, data.toId),
      to: data.toId
    };
  }

  let message = cid
    ? await Message.findOne({ where: { from: uid, clientId: cid } })
    : null;

  if (
    message &&
    (
      message.groupId !== destination.groupId ||
      message.to !== destination.to ||
      message.chatKey !== destination.chatKey ||
      (
        !message.deleted &&
        (message.text !== text || message.image !== image)
      )
    )
  ) {
    reject(
      409,
      'clientId уже использован для другого сообщения',
      'client_id_conflict'
    );
  }

  const duplicate = Boolean(message);

  if (!message) {
    message = await sequelize.transaction(async transaction => {
      await claimUpload(image, uid, transaction);

      return Message.create(
        {
          ...destination,
          from: uid,
          text,
          image,
          type: image ? 'image' : 'text',
          clientId: cid || null,
          createdAt: nextTime()
        },
        { transaction }
      );
    });
  }

  const value = serializeMessage(message);

  if (isGroup) {
    (duplicate ? socket : io.to(groupRoom(data.groupId))).emit(
      'newGroupMessage',
      { groupId: data.groupId, msg: value }
    );
  } else {
    (duplicate ? socket : io.to(userRoom(uid))).emit('newMessage', {
      chatWith: data.toId,
      msg: value
    });

    if (!duplicate) {
      io.to(userRoom(data.toId)).emit('newMessage', {
        chatWith: uid,
        msg: value
      });
    }
  }

  return { message: value, duplicate };
}

function friendAction(me, target) {
  if (!target || target.id === me.id) {
    return { action: 'reject', reason: 'not_found' };
  }

  if (
    me.blockedUsers.includes(target.id) ||
    target.blockedUsers.includes(me.id)
  ) {
    return { action: 'reject', reason: 'not_found' };
  }

  if (
    me.friends.includes(target.id) &&
    target.friends.includes(me.id)
  ) {
    return { action: 'friends' };
  }

  if (
    (!me.friends.includes(target.id) && me.friends.length >= MAX_FRIENDS) ||
    (!target.friends.includes(me.id) && target.friends.length >= MAX_FRIENDS)
  ) {
    return { action: 'reject', reason: 'target_limit_reached' };
  }

  if (me.friendRequests.includes(target.id)) {
    return { action: 'accept' };
  }

  if (target.friendRequests.includes(me.id)) {
    return { action: 'pending' };
  }

  if (target.friendRequests.length >= MAX_REQUESTS) {
    return { action: 'reject', reason: 'target_limit_reached' };
  }

  return { action: 'send' };
}

async function makeFriends(me, other) {
  await sequelize.transaction(async transaction => {
    await me.update(
      {
        friendRequests: me.friendRequests.filter(id => id !== other.id),
        friends: [...new Set([...me.friends, other.id])]
      },
      { transaction }
    );

    await other.update(
      {
        friendRequests: other.friendRequests.filter(id => id !== me.id),
        friends: [...new Set([...other.friends, me.id])]
      },
      { transaction }
    );
  });

  io.to(userRoom(me.id)).emit('friendAdded', publicUser(other));
  io.to(userRoom(other.id)).emit('friendAdded', publicUser(me));
}

io.use(async (socket, next) => {
  try {
    if (!ready || stopping) return next(new Error('Unavailable'));

    const auth = await verifyToken(socket.handshake.auth?.token);

    if (!auth) return next(new Error('Unauthorized'));

    socket.authToken = socket.handshake.auth.token;
    socket.user = auth.user;
    socket.expiry = auth.payload.exp;

    next();
  } catch (error) {
    logger.warn('Socket authentication failed', {
      error: error.message
    });

    next(new Error('Unauthorized'));
  }
});

io.on('connection', socket => {
  const uid = socket.user.id;

  socket.activeCallKeys = new Set();
  socket.initialized = false;

  let expiryTimer;

  function scheduleExpiry() {
    const remaining = socket.expiry * 1000 - Date.now();

    if (remaining <= 0) {
      socket.disconnect(true);
      return;
    }

    expiryTimer = setTimeout(
      scheduleExpiry,
      Math.min(remaining, 2 ** 31 - 1)
    );

    expiryTimer.unref();
  }

  // Rate-limit all incoming events, including malformed or unknown names.
  socket.use((packet, next) => {
    if (!eventLimit(uid)) {
      socket.emit('rateLimited', String(packet[0] || 'event'));
      socket.disconnect(true);
      return;
    }

    next();
  });

  // Installed before any asynchronous initialization.
  socket.on('disconnect', () => {
    clearTimeout(expiryTimer);

    const wasInitialized = socket.initialized;
    socket.initialized = false;

    const set = onlineUsers.get(uid);
    set?.delete(socket.id);

    if (!set?.size) onlineUsers.delete(uid);

    for (const key of socket.activeCallKeys) {
      const call = callsByChat.get(key);

      if (!call || call.peers.get(uid) !== socket.id) continue;

      call.peers.delete(uid);
      scheduleLeave(call, uid);
    }

    socket.activeCallKeys.clear();

    if (!wasInitialized || stopping) return;

    serial(async () => {
      if (online(uid)) return;

      const user = await User.findByPk(uid);
      if (!user || online(uid)) return;

      for (const id of user.friends) {
        io.to(userRoom(id)).emit('friendOffline', uid);
      }
    }).catch(error => {
      if (!stopping) {
        logger.warn('Presence cleanup failed', {
          error: error.message
        });
      }
    });
  });

  scheduleExpiry();

  serial(async () => {
    const auth = await verifyToken(socket.authToken);

    if (!auth || !socket.connected) {
      socket.disconnect(true);
      return;
    }

    if (sockets(uid).length >= 8) {
      socket.emit('callError', { reason: 'too_many_connections' });
      socket.disconnect(true);
      return;
    }

    socket.user = auth.user;

    const memberships = await GroupMember.findAll({
      where: { userId: uid },
      attributes: ['groupId']
    });

    const groupIds = memberships.map(member => member.groupId);

    const dmRows = await sequelize.query(
      `SELECT "from", COUNT(*)::int AS count
       FROM messages
       WHERE "to" = :u
         AND read = false
         AND deleted = false
         AND group_id IS NULL
       GROUP BY "from"`,
      {
        replacements: { u: uid },
        type: QueryTypes.SELECT
      }
    );

    const groupRows = groupIds.length
      ? await sequelize.query(
          `SELECT m.group_id AS "groupId", COUNT(*)::int AS count
           FROM messages m
           LEFT JOIN group_read_states r
             ON r.group_id = m.group_id AND r.user_id = :u
           WHERE m.group_id IN (:ids)
             AND m."from" <> :u
             AND m.deleted = false
             AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
           GROUP BY m.group_id`,
          {
            replacements: { u: uid, ids: groupIds },
            type: QueryTypes.SELECT
          }
        )
      : [];

    if (
      !socket.connected ||
      auth.payload.exp * 1000 <= Date.now()
    ) {
      socket.disconnect(true);
      return;
    }

    const wasOffline = !online(uid);

    if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());

    onlineUsers.get(uid).add(socket.id);
    socket.initialized = true;
    socket.join(userRoom(uid));

    for (const groupId of groupIds) {
      socket.join(groupRoom(groupId));
    }

    socket.emit('profile', {
      ...privateUser(auth.user),
      unreadCounts: Object.fromEntries(
        dmRows
          .filter(row => auth.user.friends.includes(row.from))
          .map(row => [row.from, row.count])
      ),
      groupUnreadCounts: Object.fromEntries(
        groupRows.map(row => [row.groupId, row.count])
      )
    });

    for (const groupId of groupIds) {
      voiceState(groupId, socket);
    }

    socket.emit(
      'dmVoiceSnapshot',
      [...calls.values()]
        .filter(call =>
          call.type === 'dm' &&
          call.answered &&
          [call.initiator, call.targetId].includes(uid)
        )
        .map(call => ({
          peerId:
            call.initiator === uid
              ? call.targetId
              : call.initiator,
          callId: call.callId,
          video: call.video,
          participants: [...call.participants]
        }))
    );

    if (wasOffline) {
      for (const id of auth.user.friends) {
        io.to(userRoom(id)).emit('friendOnline', {
          id: uid,
          nickname: auth.user.nickname,
          avatar: auth.user.avatar
        });
      }
    }

    for (const call of calls.values()) {
      if (
        call.type === 'dm' &&
        call.targetId === uid &&
        !call.answered
      ) {
        socket.emit('callIncoming', invite(call));
      }
    }
  }).catch(error => {
    logger.warn('Socket initialization failed', {
      error: error.message
    });

    socket.disconnect(true);
  });

  const on = (event, shape, handler) =>
    installEvent(socket, event, shape, handler);

  on('sendFriendRequest', 'userId', async toId => {
    checkLimit(friendLimit, uid);

    const me = socket.user;
    const target = await User.findByPk(toId);
    const decision = friendAction(me, target);

    if (decision.action === 'reject') {
      reject(400, 'Не удалось добавить пользователя', decision.reason);
    }

    if (decision.action === 'friends') {
      io.to(userRoom(uid)).emit('friendAdded', publicUser(target));
      return { status: 'friends', toId };
    }

    if (decision.action === 'accept') {
      await makeFriends(me, target);
      return { status: 'friends', toId };
    }

    if (decision.action === 'pending') {
      socket.emit('requestSent', { toId, alreadySent: true });
      return { status: 'pending', toId };
    }

    await target.update({
      friendRequests: [...new Set([...target.friendRequests, uid])]
    });

    io.to(userRoom(uid)).emit('requestSent', { toId });
    io.to(userRoom(toId)).emit('friendRequest', {
      id: uid,
      nickname: me.nickname,
      avatar: me.avatar
    });

    return { status: 'pending', toId };
  });

  on('acceptFriendRequest', 'userId', async fromId => {
    checkLimit(friendLimit, uid);

    if (fromId === uid) reject(400, 'Некорректный ID');

    const me = socket.user;
    const other = await User.findByPk(fromId);

    if (!other || !me.friendRequests.includes(fromId)) {
      reject(404, 'Запрос не найден', 'no_request');
    }

    const decision = friendAction(me, other);

    if (!['accept', 'friends'].includes(decision.action)) {
      reject(403, 'Нельзя принять запрос', decision.reason || 'forbidden');
    }

    await makeFriends(me, other);
    return { status: 'friends', fromId };
  });

  on('declineFriendRequest', 'userId', async fromId => {
    checkLimit(friendLimit, uid);

    await socket.user.update({
      friendRequests: socket.user.friendRequests.filter(id => id !== fromId)
    });

    io.to(userRoom(uid)).emit('requestDeclined', fromId);
  });

  on('removeFriend', 'userId', async friendId => {
    checkLimit(friendLimit, uid);

    if (friendId === uid) reject(400, 'Некорректный ID');

    const me = socket.user;
    const other = await User.findByPk(friendId);

    const hadRelation = Boolean(
      me.friends.includes(friendId) ||
      me.friendRequests.includes(friendId) ||
      other?.friends.includes(uid) ||
      other?.friendRequests.includes(uid)
    );

    await sequelize.transaction(async transaction => {
      await me.update(
        {
          friends: me.friends.filter(id => id !== friendId),
          friendRequests: me.friendRequests.filter(id => id !== friendId)
        },
        { transaction }
      );

      if (other) {
        await other.update(
          {
            friends: other.friends.filter(id => id !== uid),
            friendRequests: other.friendRequests.filter(id => id !== uid)
          },
          { transaction }
        );
      }
    });

    const call = callsByChat.get(dmKey(uid, friendId));
    if (call) endCall(call, 'unavailable');

    io.to(userRoom(uid)).emit('friendRemoved', { id: friendId });

    if (hadRelation) {
      io.to(userRoom(friendId)).emit('friendRemoved', { id: uid });
    }
  });

  on('sendMessage', 'object', data =>
    sendMessage(socket, data, false)
  );

  on('groupMessage', 'object', data =>
    sendMessage(socket, data, true)
  );

  on('markRead', 'userId', async friendId => {
    checkLimit(typingLimit, uid);
    await dmAccess(uid, friendId);

    const [count] = await Message.update(
      { read: true },
      {
        where: {
          chatKey: chatKey(uid, friendId),
          to: uid,
          groupId: null,
          read: false,
          deleted: false
        }
      }
    );

    if (count) {
      io.to(userRoom(friendId)).emit('messagesRead', {
        by: uid,
        count
      });
    }

    io.to(userRoom(uid)).emit('unreadCleared', {
      chatWith: friendId
    });
  });

  on('typing', 'object', async data => {
    checkLimit(typingLimit, uid);

    if (typeof data.isTyping !== 'boolean') {
      reject(400, 'isTyping должен быть boolean');
    }

    if (Boolean(data.toId) === Boolean(data.groupId)) {
      reject(400, 'Укажите один чат');
    }

    if (data.toId) {
      await dmAccess(uid, data.toId);

      io.to(userRoom(data.toId)).emit('typing', {
        from: uid,
        isTyping: data.isTyping
      });
    } else {
      await membership(uid, data.groupId);

      socket.to(groupRoom(data.groupId)).emit('typing', {
        from: uid,
        groupId: data.groupId,
        isTyping: data.isTyping
      });
    }
  });

  on('markGroupRead', 'groupId', async groupId => {
    checkLimit(typingLimit, uid);
    await membership(uid, groupId);
    await advanceRead(groupId, uid, nextTime());

    io.to(userRoom(uid)).emit('unreadCleared', { groupId });
  });

  on('addGroupMember', 'object', async data => {
    checkLimit(groupLimit, uid);

    const groupId = data.groupId;
    const targetId = data.userId;

    await membership(uid, groupId, true);

    if (!idOK(targetId) || targetId === uid) {
      reject(400, 'Некорректный ID');
    }

    const { other } = await dmAccess(uid, targetId);

    if (
      await GroupMember.findOne({
        where: { groupId, userId: targetId }
      })
    ) {
      reject(400, 'Уже участник', 'already_member');
    }

    if (
      await GroupMember.count({ where: { groupId } }) >= MAX_MEMBERS
    ) {
      reject(400, 'Лимит участников', 'limit_reached');
    }

    if (
      await GroupMember.count({ where: { userId: targetId } }) >= MAX_GROUPS
    ) {
      reject(400, 'Лимит групп', 'target_limit_reached');
    }

    await sequelize.transaction(async transaction => {
      await GroupMember.create(
        { groupId, userId: targetId, role: 'member' },
        { transaction }
      );

      await advanceRead(groupId, targetId, nextTime(), transaction);
    });

    groupRoomJoin(targetId, groupId);

    io.to(groupRoom(groupId)).emit('groupMemberJoined', {
      groupId,
      user: {
        id: targetId,
        nickname: other.nickname,
        avatar: other.avatar,
        online: online(targetId),
        role: 'member'
      }
    });

    io.to(userRoom(targetId)).emit('addedToGroup', {
      group: await groupData(groupId)
    });

    voiceState(groupId, io.to(userRoom(targetId)));
  });

  on('leaveGroup', 'groupId', async groupId => {
    checkLimit(groupLimit, uid);

    const { group, member } = await membership(uid, groupId);

    if (group.ownerId === uid) {
      if (member.role !== 'owner') {
        reject(409, 'Некорректное состояние владельца группы', 'conflict');
      }

      await sequelize.transaction(async transaction => {
        await sequelize.query(
          `INSERT INTO uploads (path, owner_id, state, bytes, created_at)
           SELECT image, MIN("from"), 'deleting', 0, NOW()
           FROM messages
           WHERE group_id = :g AND image LIKE '/uploads/%'
           GROUP BY image
           ON CONFLICT (path)
           DO UPDATE SET state = 'deleting'`,
          {
            replacements: { g: groupId },
            transaction
          }
        );

        await retireMedia(group.avatar, uid, transaction);

        await Message.destroy({ where: { groupId }, transaction });
        await GroupReadState.destroy({ where: { groupId }, transaction });
        await GroupMember.destroy({ where: { groupId }, transaction });
        await group.destroy({ transaction });
      });

      const call = callsByChat.get(groupRoom(groupId));
      if (call) endCall(call, 'group_deleted');

      io.to(groupRoom(groupId)).emit('groupDeleted', { groupId });
      io.in(groupRoom(groupId)).socketsLeave(groupRoom(groupId));
    } else {
      await sequelize.transaction(async transaction => {
        await member.destroy({ transaction });

        await GroupReadState.destroy({
          where: { groupId, userId: uid },
          transaction
        });
      });

      const call = callsByChat.get(groupRoom(groupId));
      if (call) leaveCall(uid, call.callId, 'left_group');

      groupRoomLeave(uid, groupId);

      io.to(groupRoom(groupId)).emit('groupMemberLeft', {
        groupId,
        userId: uid
      });

      io.to(userRoom(uid)).emit('groupDeleted', { groupId });
    }
  });

  on('kickGroupMember', 'object', async data => {
    checkLimit(groupLimit, uid);

    const groupId = data.groupId;
    const targetId = data.userId;

    await membership(uid, groupId, true);

    if (!idOK(targetId) || targetId === uid) {
      reject(400, 'Некорректный ID');
    }

    const member = await GroupMember.findOne({
      where: { groupId, userId: targetId }
    });

    if (!member) reject(404, 'Участник не найден', 'not_member');

    await sequelize.transaction(async transaction => {
      await member.destroy({ transaction });

      await GroupReadState.destroy({
        where: { groupId, userId: targetId },
        transaction
      });
    });

    const call = callsByChat.get(groupRoom(groupId));
    if (call) leaveCall(targetId, call.callId, 'kicked');

    groupRoomLeave(targetId, groupId);

    io.to(groupRoom(groupId)).emit('groupMemberLeft', {
      groupId,
      userId: targetId,
      kicked: true
    });

    io.to(userRoom(targetId)).emit('groupDeleted', {
      groupId,
      kicked: true
    });
  });

  on('callStart', 'object', async data => {
    checkLimit(startCallLimit, uid);
    assertRequestId(data);

    if (data.video !== undefined && typeof data.video !== 'boolean') {
      reject(400, 'video должен быть boolean');
    }

    if (Boolean(data.toId) === Boolean(data.groupId)) {
      reject(400, 'Укажите один чат');
    }

    const isGroup = Boolean(data.groupId);

    if (isGroup) await membership(uid, data.groupId);
    else await dmAccess(uid, data.toId);

    if (!socket.connected) {
      reject(503, 'Соединение потеряно', 'disconnected');
    }

    const key = isGroup
      ? groupRoom(data.groupId)
      : dmKey(uid, data.toId);

    let call = callsByChat.get(key);

    if (busyUser(uid, call?.callId)) {
      reject(409, 'Занято', 'busy');
    }

    if (!isGroup) {
      if (!call && busyUser(data.toId)) {
        reject(409, 'Занято', 'busy');
      }

      if (call && !call.answered && call.initiator !== uid) {
        reject(409, 'Входящий звонок уже существует; используйте callJoin', 'busy');
      }
    }

    const isNew = !call;

    if (!call) {
      call = {
        callId: crypto.randomUUID(),
        chatKey: key,
        type: isGroup ? 'group' : 'dm',
        groupId: isGroup ? data.groupId : null,
        initiator: uid,
        targetId: isGroup ? null : data.toId,
        video: Boolean(data.video),
        answered: isGroup,
        createdAt: Date.now(),
        fromNick: socket.user.nickname,
        fromAvatar: socket.user.avatar,
        participants: new Set(),
        peers: new Map(),
        grace: new Map(),
        emptyTimer: null
      };

      calls.set(call.callId, call);
      callsByChat.set(key, call);
    }

    const peers = [...call.participants].filter(id => id !== uid);

    attachCall(socket, call);

    socket.lastCallRequest = {
      callId: call.callId,
      requestId: clientId(data.requestId)
    };

    const result = {
      callId: call.callId,
      requestId: clientId(data.requestId),
      answered: call.answered,
      chatKey: key,
      video: call.video,
      isGroup,
      ...(isGroup ? { groupId: call.groupId } : {}),
      participants: peers
    };

    socket.emit('callStarted', result);

    if (isNew) {
      if (isGroup) {
        io.to(groupRoom(call.groupId))
          .except(userRoom(uid))
          .emit('callIncoming', invite(call));
      } else {
        io.to(userRoom(call.targetId)).emit('callIncoming', invite(call));
      }
    }

    if (isGroup) voiceState(call.groupId);
    else if (call.answered) dmVoiceState(call);

    return result;
  });

  on('callJoin', 'object', async data => {
    checkLimit(startCallLimit, uid);
    assertRequestId(data);

    if (!uuidOK(data.callId)) {
      reject(400, 'Некорректный ID звонка');
    }

    if (data.rejoin !== undefined && typeof data.rejoin !== 'boolean') {
      reject(400, 'rejoin должен быть boolean');
    }

    const call = calls.get(data.callId);
    await callAccess(call, uid);

    if (busyUser(uid, call.callId)) {
      reject(409, 'Занято', 'busy');
    }

    if (!socket.connected) {
      reject(503, 'Соединение потеряно', 'disconnected');
    }

    if (call.type === 'dm' && uid === call.targetId) {
      call.answered = true;

      socket.to(userRoom(uid)).emit('callCancelled', {
        callId: call.callId,
        reason: 'answered_elsewhere'
      });
    }

    const peers = [...call.participants].filter(id => id !== uid);

    attachCall(socket, call, data.rejoin === true);

    socket.lastCallRequest = {
      callId: call.callId,
      requestId: clientId(data.requestId)
    };

    const result = {
      callId: call.callId,
      requestId: clientId(data.requestId),
      chatKey: call.chatKey,
      answered: call.answered,
      video: call.video,
      isGroup: call.type === 'group',
      groupId: call.groupId,
      participants: peers
    };

    socket.emit('callJoined', result);

    if (call.type === 'group') voiceState(call.groupId);
    else dmVoiceState(call);

    return result;
  });

  on('callReject', 'object', async data => {
    if (!uuidOK(data.callId)) {
      reject(400, 'Некорректный ID звонка');
    }

    const call = calls.get(data.callId);
    await callAccess(call, uid);

    const reason = ['rejected', 'busy', 'timeout'].includes(data.reason)
      ? data.reason
      : 'rejected';

    if (call.type === 'dm') {
      if (uid !== call.targetId || call.answered) return;

      io.to(userRoom(call.initiator)).emit('callRejected', {
        callId: call.callId,
        peerId: uid,
        reason
      });

      endCall(call, reason);
    }
  });

  on('watchGroupVoice', 'object', async data => {
    checkLimit(typingLimit, uid);
    await membership(uid, data.groupId);
    voiceState(data.groupId, socket);
  });

  on('watchDmVoice', 'object', async data => {
    checkLimit(typingLimit, uid);
    await dmAccess(uid, data.peerId);

    const call = callsByChat.get(dmKey(uid, data.peerId));

    socket.emit('dmVoiceState', {
      peerId: data.peerId,
      callId: call?.answered ? call.callId : null,
      video: Boolean(call?.video),
      participants: call?.answered ? [...call.participants] : []
    });
  });

  on('callSignal', 'object', async data => {
    checkLimit(signalLimit, uid);

    if (!uuidOK(data.callId)) {
      reject(400, 'Некорректный ID звонка');
    }

    const call = calls.get(data.callId);
    await callAccess(call, uid);

    if (
      !idOK(data.to) ||
      !record(data.data) ||
      data.to === uid ||
      call.peers.get(uid) !== socket.id ||
      !call.participants.has(uid) ||
      !call.participants.has(data.to) ||
      !socket.rooms.has(callRoom(call.callId))
    ) {
      reject(403, 'Нет доступа', 'forbidden');
    }

    if (call.type === 'dm' && !call.answered) {
      reject(409, 'Звонок ещё не принят', 'not_answered');
    }

    const encoded = JSON.stringify(data.data);

    if (Buffer.byteLength(encoded) > 64_000) {
      reject(400, 'Слишком большой сигнал');
    }

    const peer = io.sockets.sockets.get(call.peers.get(data.to));

    if (
      peer?.connected &&
      peer.initialized &&
      peer.rooms.has(callRoom(call.callId))
    ) {
      peer.emit('callSignal', {
        callId: call.callId,
        from: uid,
        data: data.data
      });

      return { delivered: true };
    }

    return { delivered: false };
  });

  on('callLeave', 'object', async data => {
    assertRequestId(data);

    if (!uuidOK(data.callId)) {
      reject(400, 'Некорректный ID звонка');
    }

    const call = calls.get(data.callId);

    if (!call || call.peers.get(uid) !== socket.id) return;

    if (
      data.requestId &&
      (
        socket.lastCallRequest?.callId !== call.callId ||
        socket.lastCallRequest?.requestId !== data.requestId
      )
    ) {
      return;
    }

    if (
      call.type === 'dm' &&
      !call.answered &&
      call.initiator === uid
    ) {
      endCall(call, 'cancelled');
    } else {
      leaveCall(uid, call.callId);
    }
  });
});

// -----------------------------------------------------------------------------
// Schema and startup
// -----------------------------------------------------------------------------

async function ensureSchema() {
  const qi = sequelize.getQueryInterface();

  const tables = new Set(
    (await qi.showAllTables()).map(table =>
      typeof table === 'string' ? table : table.tableName
    )
  );

  if (tables.has('users')) {
    await sequelize.query(
      `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS friends VARCHAR(255)[] NOT NULL DEFAULT '{}',
       ADD COLUMN IF NOT EXISTS friend_requests VARCHAR(255)[] NOT NULL DEFAULT '{}',
       ADD COLUMN IF NOT EXISTS blocked_users VARCHAR(255)[] NOT NULL DEFAULT '{}'`
    );

    for (const column of ['friends', 'friend_requests', 'blocked_users']) {
      await sequelize.query(
        `UPDATE users SET "${column}" = '{}' WHERE "${column}" IS NULL`
      );

      await sequelize.query(
        `ALTER TABLE users
         ALTER COLUMN "${column}" SET DEFAULT '{}',
         ALTER COLUMN "${column}" SET NOT NULL`
      );
    }

    await sequelize.query(
      'UPDATE users SET token_version = 0 WHERE token_version IS NULL'
    );

    await sequelize.query(
      `ALTER TABLE users
       ALTER COLUMN token_version SET DEFAULT 0,
       ALTER COLUMN token_version SET NOT NULL`
    );
  }

  if (tables.has('messages')) {
    await sequelize.query(
      `ALTER TABLE messages
       ADD COLUMN IF NOT EXISTS group_id UUID,
       ADD COLUMN IF NOT EXISTS client_id VARCHAR(64)`
    );

    const columns = await qi.describeTable('messages');

    for (const column of ['chat_key', 'group_id', 'to', 'image']) {
      if (columns[column]) {
        await sequelize.query(
          `ALTER TABLE messages ALTER COLUMN "${column}" DROP NOT NULL`
        );
      }
    }
  }

  if (tables.has('uploads')) {
    await sequelize.query(
      `ALTER TABLE uploads
       ADD COLUMN IF NOT EXISTS state VARCHAR(16) NOT NULL DEFAULT 'pending',
       ADD COLUMN IF NOT EXISTS bytes BIGINT NOT NULL DEFAULT 0`
    );
  }

  // Creates missing tables; does not alter or drop existing tables.
  await sequelize.sync();

  const models = [User, Message, Group, GroupMember, GroupReadState, Upload];

  for (const model of models) {
    const table = model.getTableName();
    const actual = await qi.describeTable(table);

    const missing = Object.values(model.rawAttributes)
      .map(attribute => attribute.field)
      .filter(field => !actual[field]);

    if (missing.length) {
      fail(
        `Incompatible schema in ${table}: missing columns ${missing.join(', ')}. ` +
        'Apply an explicit migration before starting.'
      );
    }
  }

  const indexes = [
    `CREATE UNIQUE INDEX IF NOT EXISTS group_members_group_id_user_id
     ON group_members(group_id, user_id)`,

    `CREATE UNIQUE INDEX IF NOT EXISTS group_read_states_group_user_unique
     ON group_read_states(group_id, user_id)`,

    `CREATE INDEX IF NOT EXISTS group_members_user_id
     ON group_members(user_id)`,

    `CREATE INDEX IF NOT EXISTS messages_chat_key_created_at_id
     ON messages(chat_key, created_at, id)`,

    `CREATE INDEX IF NOT EXISTS messages_group_id_created_at_id
     ON messages(group_id, created_at, id)`,

    `CREATE INDEX IF NOT EXISTS messages_to_read
     ON messages("to", read)`,

    `CREATE INDEX IF NOT EXISTS messages_from
     ON messages("from")`,

    `CREATE UNIQUE INDEX IF NOT EXISTS messages_from_client_id_unique
     ON messages("from", client_id) WHERE client_id IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS messages_image_active
     ON messages(image) WHERE image IS NOT NULL AND deleted = false`,

    `CREATE INDEX IF NOT EXISTS users_avatar
     ON users(avatar) WHERE avatar IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS groups_avatar
     ON groups(avatar) WHERE avatar IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS uploads_owner_id
     ON uploads(owner_id)`,

    `CREATE INDEX IF NOT EXISTS uploads_state_created_at
     ON uploads(state, created_at)`
  ];

  for (const sql of indexes) await sequelize.query(sql);

  // Legacy media ledger backfill: do not rewrite message contents.
  await sequelize.query(
    `INSERT INTO uploads(path, owner_id, state, bytes, created_at)
     SELECT image, MIN("from"), 'attached', 0, NOW()
     FROM messages
     WHERE deleted = false AND image LIKE '/uploads/%'
     GROUP BY image
     ON CONFLICT(path) DO NOTHING`
  );

  await sequelize.query(
    `INSERT INTO uploads(path, owner_id, state, bytes, created_at)
     SELECT avatar, MIN(id), 'attached', 0, NOW()
     FROM users
     WHERE avatar LIKE '/uploads/%'
     GROUP BY avatar
     ON CONFLICT(path) DO NOTHING`
  );

  await sequelize.query(
    `INSERT INTO uploads(path, owner_id, state, bytes, created_at)
     SELECT avatar, MIN(owner_id), 'attached', 0, NOW()
     FROM groups
     WHERE avatar LIKE '/uploads/%'
     GROUP BY avatar
     ON CONFLICT(path) DO NOTHING`
  );

  let after = '';

  while (true) {
    const rows = await Upload.findAll({
      where: {
        bytes: 0,
        path: { [Op.gt]: after }
      },
      order: [['path', 'ASC']],
      limit: 200
    });

    if (!rows.length) break;

    for (const row of rows) {
      if (!FILE_RE.test(row.path)) continue;

      const stat = await fs.promises
        .lstat(path.join(UPLOAD_DIR, path.basename(row.path)))
        .catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });

      if (stat?.isFile() && !stat.isSymbolicLink()) {
        await row.update({ bytes: stat.size });
      }
    }

    after = rows[rows.length - 1].path;
  }

  const [clock] = await sequelize.query(
    `SELECT GREATEST(
       COALESCE((SELECT MAX(created_at) FROM messages), NOW()),
       COALESCE((SELECT MAX(last_read_at) FROM group_read_states), NOW())
     ) AS latest`,
    { type: QueryTypes.SELECT }
  );

  const latest = new Date(clock.latest).getTime();

  if (!Number.isFinite(latest)) fail('Invalid timestamps in database');

  logicalTime = Math.max(Date.now(), latest);
}

let instanceConnection;
let cleanupTimer;
let lockHeartbeatTimer;
let lockHeartbeatBusy = false;
let startupPromise;
let shutdownPromise;
let exitCode = 0;

async function acquireInstanceLock() {
  // Must connect directly to PostgreSQL or a session-pooling proxy.
  // Transaction-mode PgBouncer is not supported for this session lock.
  instanceConnection = new PgClient({
    connectionString: DATABASE_URL,
    ssl: pgSsl,
    application_name: 'chatapp-instance-lock',
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000
  });

  instanceConnection.on('error', error => {
    logger.error('Instance lock connection failed', {
      error: error.message
    });

    if (!stopping) void shutdown(1);
  });

  instanceConnection.on('end', () => {
    if (!stopping) {
      logger.error('Instance lock connection ended');
      void shutdown(1);
    }
  });

  await instanceConnection.connect();

  let locked = false;

  for (let attempt = 0; attempt < 15 && !stopping; attempt++) {
    const result = await instanceConnection.query(
      `SELECT pg_try_advisory_lock(
         1780317111,
         hashtext(current_database())
       ) AS locked`
    );

    if (result.rows[0]?.locked) {
      locked = true;
      break;
    }

    logger.warn('Waiting for previous ChatApp instance', {
      attempt: attempt + 1,
      maxAttempts: 15
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (stopping) return;

  if (!locked) {
    fail('Another ChatApp instance holds the database lock');
  }

  lockHeartbeatTimer = setInterval(() => {
    if (stopping || lockHeartbeatBusy) return;

    lockHeartbeatBusy = true;

    instanceConnection
      .query('SELECT 1')
      .catch(error => {
        logger.error('Instance lock heartbeat failed', {
          error: error.message
        });

        if (!stopping) void shutdown(1);
      })
      .finally(() => {
        lockHeartbeatBusy = false;
      });
  }, 10_000);

  lockHeartbeatTimer.unref();
}

async function startInternal() {
  await acquireInstanceLock();
  if (stopping) return;

  await sequelize.authenticate();
  await ensureSchema();
  if (stopping) return;

  const rtc = turnConfig('config_check');

  if (rtc.relayError) fail(rtc.relayError);

  if (production && !rtc.relayConfigured) {
    logger.warn(
      'TURN is not configured: calls may fail behind NAT or restricted networks'
    );
  }

  await new Promise((resolve, rejectPromise) => {
    const onError = error => {
      server.off('listening', onListening);
      rejectPromise(error);
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });

  if (stopping) return;

  ready = true;

  logger.info('Server started', {
    host: HOST,
    port: PORT,
    production
  });

  const cleanup = () => {
    if (stopping || queueSize > 16) return;

    serial(cleanupUploads).catch(error => {
      if (!stopping) {
        logger.warn('Upload cleanup failed', {
          error: error.message
        });
      }
    });
  };

  cleanup();
  cleanupTimer = setInterval(cleanup, 60_000);
  cleanupTimer.unref();
}

function start() {
  if (stopping) return Promise.reject(new Error('Server is stopping'));
  startupPromise ||= startInternal();
  return startupPromise;
}

function shutdown(code = 0) {
  exitCode = Math.max(exitCode, code);

  if (shutdownPromise) return shutdownPromise;

  stopping = true;
  ready = false;

  clearInterval(cleanupTimer);
  clearInterval(lockHeartbeatTimer);
  clearInterval(ringTimer);

  for (const timer of limiterTimers) clearInterval(timer);

  shutdownPromise = (async () => {
    const forced = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30_000);

    try {
      for (const call of [...calls.values()]) {
        endCall(call, 'server_shutdown');
      }

      io.disconnectSockets(true);

      // Avoid closing the database while startup migrations are still running.
      await startupPromise?.catch(() => {});

      clearInterval(cleanupTimer);
      clearInterval(lockHeartbeatTimer);

      await new Promise(resolve => {
        io.close(() => resolve());
        server.closeIdleConnections?.();
      });

      await queueTail;

      for (const handle of sweepHandles.values()) {
        await handle.close().catch(() => {});
      }

      sweepHandles.clear();

      // Release the singleton lock only after application DB work stops.
      await sequelize.close();

      if (instanceConnection) {
        await instanceConnection.end().catch(error => {
          logger.warn('Closing instance connection failed', {
            error: error.message
          });
        });

        instanceConnection = null;
      }

      clearTimeout(forced);
      process.exit(exitCode);
    } catch (error) {
      logger.error('Shutdown failed', {
        error: error.message,
        stack: error.stack
      });

      clearTimeout(forced);
      process.exit(1);
    }
  })();

  return shutdownPromise;
}

server.on('error', error => {
  if (ready && !stopping) {
    logger.error('HTTP server error', {
      error: error.message,
      stack: error.stack
    });

    void shutdown(1);
  }
});

if (require.main === module) {
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  process.on('unhandledRejection', error => {
    logger.error('Unhandled rejection', {
      error: error?.message || String(error),
      stack: error?.stack
    });

    void shutdown(1);
  });

  process.on('uncaughtException', error => {
    logger.error('Uncaught exception', {
      error: error.message,
      stack: error.stack
    });

    void shutdown(1);
  });

  start().catch(error => {
    logger.error('Startup failed', {
      error: error.message,
      stack: error.stack
    });

    void shutdown(1);
  });
}

module.exports = {
  validPassword,
  clientId,
  chatKey,
  parsePage,
  record,
  FILE_RE,
  serial,
  start
};