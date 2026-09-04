const { Pool } = require('pg');
const crypto = require('crypto');

// На Render переменная DATABASE_URL создаётся автоматически,
// когда ты привязываешь Postgres-инстанс к Web Service.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
        ? { rejectUnauthorized: false }
        : false
});

const idTypeCache = {};

async function getIdType(clientOrPool, tableName) {
    if (idTypeCache[tableName]) {
        return idTypeCache[tableName];
    }
    const { rows } = await clientOrPool.query(`
        SELECT format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = $1
          AND a.attname = 'id'
          AND a.attnum > 0
          AND NOT a.attisdropped
    `, [tableName]);
    if (!rows[0] || !rows[0].type) {
        throw new Error(`Unable to determine ${tableName}.id type`);
    }
    idTypeCache[tableName] = rows[0].type;
    return rows[0].type;
}

function isIntegerType(type) {
    if (!type) return false;
    const lower = type.toLowerCase();
    return lower === 'integer' || lower === 'int' || lower === 'int4' || lower === 'int8' || lower === 'bigint' || lower === 'smallint';
}

// Initialize database tables
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                avatar TEXT,
                status TEXT DEFAULT 'Online',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Online';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users(username);
            CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);
        `);

        const userIdType = await getIdType(client, 'users');

        await client.query(`
            CREATE TABLE IF NOT EXISTS servers (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT,
                owner_id ${userIdType} REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            ALTER TABLE servers ADD COLUMN IF NOT EXISTS name TEXT;
            ALTER TABLE servers ADD COLUMN IF NOT EXISTS icon TEXT;
            ALTER TABLE servers ADD COLUMN IF NOT EXISTS owner_id ${userIdType};
            ALTER TABLE servers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        const serverIdType = await getIdType(client, 'servers');

        await client.query(`
            CREATE TABLE IF NOT EXISTS channels (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                server_id ${serverIdType} REFERENCES servers(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            ALTER TABLE channels ADD COLUMN IF NOT EXISTS name TEXT;
            ALTER TABLE channels ADD COLUMN IF NOT EXISTS type TEXT;
            ALTER TABLE channels ADD COLUMN IF NOT EXISTS server_id ${serverIdType};
            ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        const channelIdType = await getIdType(client, 'channels');

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                content TEXT NOT NULL,
                user_id ${userIdType} REFERENCES users(id),
                channel_id ${channelIdType} REFERENCES channels(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT;
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id ${userIdType};
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id ${channelIdType};
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        const messageIdType = await getIdType(client, 'messages');

        await client.query(`
            CREATE TABLE IF NOT EXISTS direct_messages (
                id SERIAL PRIMARY KEY,
                content TEXT NOT NULL,
                sender_id ${userIdType} REFERENCES users(id),
                receiver_id ${userIdType} REFERENCES users(id),
                read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS content TEXT;
            ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS sender_id ${userIdType};
            ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS receiver_id ${userIdType};
            ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT FALSE;
            ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS file_uploads (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                filetype TEXT,
                filesize INTEGER,
                user_id ${userIdType} REFERENCES users(id),
                channel_id ${channelIdType} REFERENCES channels(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS filename TEXT;
            ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS filepath TEXT;
            ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS filetype TEXT;
            ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS filesize INTEGER;
            ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS user_id ${userIdType};
            ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS channel_id ${channelIdType};
            ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS reactions (
                id SERIAL PRIMARY KEY,
                emoji TEXT NOT NULL,
                message_id ${messageIdType} REFERENCES messages(id),
                user_id ${userIdType} REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, user_id, emoji)
            )
        `);

        await client.query(`
            ALTER TABLE reactions ADD COLUMN IF NOT EXISTS emoji TEXT;
            ALTER TABLE reactions ADD COLUMN IF NOT EXISTS message_id ${messageIdType};
            ALTER TABLE reactions ADD COLUMN IF NOT EXISTS user_id ${userIdType};
            ALTER TABLE reactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            CREATE UNIQUE INDEX IF NOT EXISTS reactions_msg_user_emoji_idx ON reactions(message_id, user_id, emoji);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS server_members (
                id SERIAL PRIMARY KEY,
                server_id ${serverIdType} REFERENCES servers(id),
                user_id ${userIdType} REFERENCES users(id),
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(server_id, user_id)
            )
        `);

        await client.query(`
            ALTER TABLE server_members ADD COLUMN IF NOT EXISTS server_id ${serverIdType};
            ALTER TABLE server_members ADD COLUMN IF NOT EXISTS user_id ${userIdType};
            ALTER TABLE server_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            CREATE UNIQUE INDEX IF NOT EXISTS server_members_srv_user_idx ON server_members(server_id, user_id);
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id ${userIdType} REFERENCES users(id),
                friend_id ${userIdType} REFERENCES users(id),
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, friend_id)
            )
        `);

        await client.query(`
            ALTER TABLE friends ADD COLUMN IF NOT EXISTS user_id ${userIdType};
            ALTER TABLE friends ADD COLUMN IF NOT EXISTS friend_id ${userIdType};
            ALTER TABLE friends ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
            ALTER TABLE friends ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
            CREATE UNIQUE INDEX IF NOT EXISTS friends_user_friend_idx ON friends(user_id, friend_id);
        `);

        console.log('Database initialized successfully');
    } finally {
        client.release();
    }
}

// User operations
const userDB = {
    create: async (username, email, hashedPassword) => {
        const { rows: typeRows } = await pool.query(`
            SELECT format_type(a.atttypid, a.atttypmod) AS type
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
              AND c.relname = 'users'
              AND a.attname = 'id'
              AND a.attnum > 0
              AND NOT a.attisdropped
        `);
        const userIdType = typeRows[0] && typeRows[0].type;
        if (!userIdType) {
            throw new Error('Unable to determine users.id type');
        }

        const generatedId = userIdType === 'integer' ? null : crypto.randomUUID();
        const sql = generatedId
            ? 'INSERT INTO users (id, username, email, password) VALUES ($1, $2, $3, $4) RETURNING id'
            : 'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id';
        const values = generatedId
            ? [generatedId, username, email, hashedPassword]
            : [username, email, hashedPassword];
        const { rows } = await pool.query(sql, values);
        return { id: rows[0].id, username, email };
    },

    findByEmail: async (email) => {
        const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        return rows[0];
    },

    findById: async (id) => {
        const sql = 'SELECT id, username, email, avatar, status FROM users WHERE id = $1';
        const { rows } = await pool.query(sql, [id]);
        return rows[0];
    },

    updateStatus: async (id, status) => {
        await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
    },

    updateProfile: async (id, username) => {
        const { rows } = await pool.query(
            'UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username, email, avatar, status',
            [username, id]
        );
        return rows[0];
    },

    getAll: async () => {
        const { rows } = await pool.query('SELECT id, username, email, avatar, status FROM users');
        return rows;
    }
};

// Message operations
const messageDB = {
    create: async (content, userId, channelId) => {
        const sql = 'INSERT INTO messages (content, user_id, channel_id) VALUES ($1, $2, $3) RETURNING id';
        const { rows } = await pool.query(sql, [content, userId, channelId]);
        return { id: rows[0].id, content, userId, channelId };
    },

    getByChannel: async (channelId, limit = 50) => {
        const sql = `
            SELECT m.*, u.username, u.avatar
            FROM messages m
            JOIN users u ON m.user_id = u.id
            WHERE m.channel_id = $1
            ORDER BY m.created_at DESC
            LIMIT $2
        `;
        const { rows } = await pool.query(sql, [channelId, limit]);
        return rows.reverse();
    }
};

// Direct message operations
const dmDB = {
    create: async (content, senderId, receiverId) => {
        const sql = 'INSERT INTO direct_messages (content, sender_id, receiver_id) VALUES ($1, $2, $3) RETURNING id';
        const { rows } = await pool.query(sql, [content, senderId, receiverId]);
        return { id: rows[0].id, content, senderId, receiverId };
    },

    getConversation: async (userId1, userId2, limit = 50) => {
        const sql = `
            SELECT dm.*, u.username, u.avatar
            FROM direct_messages dm
            JOIN users u ON dm.sender_id = u.id
            WHERE (dm.sender_id = $1 AND dm.receiver_id = $2)
               OR (dm.sender_id = $2 AND dm.receiver_id = $1)
            ORDER BY dm.created_at DESC
            LIMIT $3
        `;
        const { rows } = await pool.query(sql, [userId1, userId2, limit]);
        return rows.reverse();
    },

    markAsRead: async (messageId) => {
        await pool.query('UPDATE direct_messages SET read = TRUE WHERE id = $1', [messageId]);
    }
};

// File operations
const fileDB = {
    create: async (filename, filepath, filetype, filesize, userId, channelId) => {
        const sql = `
            INSERT INTO file_uploads (filename, filepath, filetype, filesize, user_id, channel_id)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
        `;
        const { rows } = await pool.query(sql, [filename, filepath, filetype, filesize, userId, channelId]);
        return { id: rows[0].id, filename, filepath };
    },

    getByChannel: async (channelId) => {
        const sql = `
            SELECT f.*, u.username
            FROM file_uploads f
            JOIN users u ON f.user_id = u.id
            WHERE f.channel_id = $1
            ORDER BY f.created_at DESC
        `;
        const { rows } = await pool.query(sql, [channelId]);
        return rows;
    }
};

// Reaction operations
const reactionDB = {
    add: async (emoji, messageId, userId) => {
        const sql = `
            INSERT INTO reactions (emoji, message_id, user_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (message_id, user_id, emoji) DO NOTHING
            RETURNING id
        `;
        const { rows } = await pool.query(sql, [emoji, messageId, userId]);
        return { id: rows[0] ? rows[0].id : null, emoji, messageId, userId };
    },

    remove: async (emoji, messageId, userId) => {
        const sql = 'DELETE FROM reactions WHERE emoji = $1 AND message_id = $2 AND user_id = $3';
        await pool.query(sql, [emoji, messageId, userId]);
    },

    getByMessage: async (messageId) => {
        const sql = `
            SELECT r.emoji, COUNT(*) as count, STRING_AGG(u.username, ',') as users
            FROM reactions r
            JOIN users u ON r.user_id = u.id
            WHERE r.message_id = $1
            GROUP BY r.emoji
        `;
        const { rows } = await pool.query(sql, [messageId]);
        return rows;
    }
};

// Friend operations
const friendDB = {
    sendRequest: async (userId, friendId) => {
        const sql = `
            INSERT INTO friends (user_id, friend_id, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (user_id, friend_id) DO NOTHING
            RETURNING id
        `;
        const { rows } = await pool.query(sql, [userId, friendId]);
        return { changes: rows.length };
    },

    acceptRequest: async (userId, friendId) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                'UPDATE friends SET status = $1 WHERE user_id = $2 AND friend_id = $3',
                ['accepted', friendId, userId]
            );
            await client.query(
                `INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, 'accepted')
                 ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'`,
                [userId, friendId]
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    },

    rejectRequest: async (userId, friendId) => {
        await pool.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [friendId, userId]);
    },

    removeFriend: async (userId, friendId) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [userId, friendId]);
            await client.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [friendId, userId]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    },

    getFriends: async (userId) => {
        const sql = `
            SELECT u.id, u.username, u.email, u.avatar, u.status, f.status as friendship_status
            FROM friends f
            JOIN users u ON f.friend_id = u.id
            WHERE f.user_id = $1 AND f.status = 'accepted'
        `;
        const { rows } = await pool.query(sql, [userId]);
        return rows;
    },

    getPendingRequests: async (userId) => {
        const sql = `
            SELECT u.id, u.username, u.email, u.avatar, u.status
            FROM friends f
            JOIN users u ON f.user_id = u.id
            WHERE f.friend_id = $1 AND f.status = 'pending'
        `;
        const { rows } = await pool.query(sql, [userId]);
        return rows;
    },

    checkFriendship: async (userId, friendId) => {
        const sql = "SELECT * FROM friends WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'";
        const { rows } = await pool.query(sql, [userId, friendId]);
        return rows.length > 0;
    }
};

// Channel operations
const channelDB = {
    create: async (name, type, serverId) => {
        const sql = 'INSERT INTO channels (name, type, server_id) VALUES ($1, $2, $3) RETURNING id';
        const { rows } = await pool.query(sql, [name, type, serverId]);
        return { id: rows[0].id, name, type, serverId };
    },

    getByServer: async (serverId) => {
        const sql = 'SELECT * FROM channels WHERE server_id = $1 ORDER BY type ASC, id ASC';
        const { rows } = await pool.query(sql, [serverId]);
        return rows;
    },

    findById: async (id) => {
        const { rows } = await pool.query('SELECT * FROM channels WHERE id = $1', [id]);
        return rows[0];
    }
};

// Server operations
const serverDB = {
    create: async (name, ownerId) => {
        const icon = name.charAt(0).toUpperCase();
        const sql = 'INSERT INTO servers (name, icon, owner_id) VALUES ($1, $2, $3) RETURNING id';
        const { rows } = await pool.query(sql, [name, icon, ownerId]);
        return { id: rows[0].id, name, icon, ownerId };
    },

    getUserServers: async (userId) => {
        const sql = `
            SELECT s.* FROM servers s
            JOIN server_members sm ON s.id = sm.server_id
            WHERE sm.user_id = $1
            ORDER BY s.created_at ASC
        `;
        const { rows } = await pool.query(sql, [userId]);
        return rows;
    },

    addMember: async (serverId, userId) => {
        const sql = `
            INSERT INTO server_members (server_id, user_id)
            VALUES ($1, $2)
            ON CONFLICT (server_id, user_id) DO NOTHING
        `;
        await pool.query(sql, [serverId, userId]);
    },

    getMembers: async (serverId) => {
        const sql = `
            SELECT u.id, u.username, u.avatar, u.status
            FROM users u
            JOIN server_members sm ON u.id = sm.user_id
            WHERE sm.server_id = $1
        `;
        const { rows } = await pool.query(sql, [serverId]);
        return rows;
    }
};

module.exports = {
    pool,
    initializeDatabase,
    userDB,
    messageDB,
    dmDB,
    fileDB,
    reactionDB,
    friendDB,
    serverDB,
    channelDB
};