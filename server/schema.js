'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Op, QueryTypes } = require('sequelize');

async function ensureSchema({
  sequelize,
  User,
  Message,
  Group,
  GroupMember,
  GroupReadState,
  Upload,
  FILE_RE,
  UPLOAD_DIR,
  fail
}) {
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
       ADD COLUMN IF NOT EXISTS client_id VARCHAR(64),
       ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(180),
       ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(80),
       ADD COLUMN IF NOT EXISTS attachment_size BIGINT`
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
       ADD COLUMN IF NOT EXISTS bytes BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS original_name VARCHAR(180),
       ADD COLUMN IF NOT EXISTS mime VARCHAR(80)`
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

  return Math.max(Date.now(), latest);

}

module.exports = ensureSchema;
