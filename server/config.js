'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const winston = require('winston');

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

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads')
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
const MAX_FILE_BYTES = intEnv(
  'MAX_FILE_BYTES',
  50 * 1024 * 1024,
  MAX_IMAGE_BYTES,
  1024 * 1024 * 1024
);
const MAX_USER_MEDIA_BYTES = intEnv(
  'MAX_USER_MEDIA_BYTES',
  500 * 1024 * 1024,
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

module.exports = {
  production,
  logger,
  fail,
  intEnv,
  boolEnv,
  PORT,
  HOST,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  origins,
  originSet,
  DATABASE_URL,
  pgSsl,
  PUBLIC_DIR,
  UPLOAD_DIR,
  TMP_DIR,
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  MAX_USER_MEDIA_BYTES,
  MIN_FREE_DISK_BYTES,
  MAX_PENDING_UPLOADS,
  PENDING_TTL,
  MAX_FRIENDS,
  MAX_REQUESTS,
  MAX_BLOCKED,
  MAX_MEMBERS,
  MAX_GROUPS,
  MAX_QUEUE,
  MAX_QUEUE_AGE,
  MAX_SOCKET_CONNECTIONS
};
