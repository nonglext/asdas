require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

const { initializeDatabase, userDB, messageDB, dmDB, fileDB, reactionDB, friendDB, serverDB, channelDB } = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: process.env.CLIENT_ORIGIN || "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. Add it to your .env file (see .env.example).');
    process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}
app.use('/uploads', express.static(uploadsDir));

const BLOCKED_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.sh', '.msi', '.dll', '.js', '.mjs', '.cjs',
    '.jar', '.com', '.scr', '.vbs', '.ps1', '.php', '.html', '.htm', '.svg'
]);

function sanitizeBaseName(originalName) {
    const base = path.basename(originalName);
    return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const safeName = sanitizeBaseName(file.originalname);
        const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
        cb(null, `${uniqueSuffix}-${safeName}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (BLOCKED_EXTENSIONS.has(ext)) {
            return cb(new Error('This file type is not allowed'));
        }
        cb(null, true);
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
}

// API Routes

app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const existingUser = await userDB.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await userDB.create(username, email, hashedPassword);

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: username.charAt(0).toUpperCase()
            }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const user = await userDB.findByEmail(email);
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatar: user.avatar || user.username.charAt(0).toUpperCase()
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await userDB.findById(req.user.id);
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const users = await userDB.getAll();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get users' });
    }
});

app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const { channelId } = req.body;
        const fileRecord = await fileDB.create(
            req.file.filename,
            req.file.path,
            req.file.mimetype,
            req.file.size,
            req.user.id,
            channelId
        );

        res.json({
            id: fileRecord.id,
            filename: req.file.originalname,
            url: `/uploads/${req.file.filename}`,
            type: req.file.mimetype,
            size: req.file.size
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message === 'This file type is not allowed') {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

app.get('/api/messages/:channelId', authenticateToken, async (req, res) => {
    try {
        const messages = await messageDB.getByChannel(req.params.channelId);
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

app.get('/api/dm/:userId', authenticateToken, async (req, res) => {
    try {
        const messages = await dmDB.getConversation(req.user.id, req.params.userId);
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

app.post('/api/servers', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;

        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Server name must be at least 2 characters' });
        }

        const server = await serverDB.create(name.trim(), req.user.id);
        await serverDB.addMember(server.id, req.user.id);

        const [generalText, randomText, generalVoice] = await Promise.all([
            channelDB.create('general', 'text', server.id),
            channelDB.create('random', 'text', server.id),
            channelDB.create('General', 'voice', server.id)
        ]);

        res.json({
            ...server,
            channels: [generalText, randomText, generalVoice]
        });
    } catch (error) {
        console.error('Create server error:', error);
        res.status(500).json({ error: 'Failed to create server' });
    }
});

app.get('/api/servers', authenticateToken, async (req, res) => {
    try {
        const servers = await serverDB.getUserServers(req.user.id);
        res.json(servers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get servers' });
    }
});

app.get('/api/servers/:serverId/channels', authenticateToken, async (req, res) => {
    try {
        const channels = await channelDB.getByServer(req.params.serverId);
        res.json(channels);
    } catch (error) {
        console.error('Get channels error:', error);
        res.status(500).json({ error: 'Failed to get channels' });
    }
});

app.get('/api/servers/:serverId/members', authenticateToken, async (req, res) => {
    try {
        const members = await serverDB.getMembers(req.params.serverId);
        res.json(members);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get server members' });
    }
});

app.get('/api/friends', authenticateToken, async (req, res) => {
    try {
        const friends = await friendDB.getFriends(req.user.id);
        res.json(friends);
    } catch (error) {
        console.error('Get friends error:', error);
        res.status(500).json({ error: 'Failed to get friends' });
    }
});

app.get('/api/friends/pending', authenticateToken, async (req, res) => {
    try {
        const requests = await friendDB.getPendingRequests(req.user.id);
        res.json(requests);
    } catch (error) {
        console.error('Get pending requests error:', error);
        res.status(500).json({ error: 'Failed to get pending requests' });
    }
});

app.post('/api/friends/request', authenticateToken, async (req, res) => {
    try {
        const { friendId } = req.body;
        const result = await friendDB.sendRequest(req.user.id, friendId);

        if (result.changes > 0) {
            const receiverSocket = Array.from(users.values()).find(u => u.id === friendId);
            if (receiverSocket) {
                io.to(receiverSocket.socketId).emit('new-friend-request');
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Friend request error:', error);
        res.status(500).json({ error: 'Failed to send friend request' });
    }
});

app.post('/api/friends/accept', authenticateToken, async (req, res) => {
    try {
        const { friendId } = req.body;
        await friendDB.acceptRequest(req.user.id, friendId);

        // Сообщаем тому, кто отправил запрос, что его приняли —
        // без этого у него друг не появится без reload
        const requesterSocket = Array.from(users.values()).find(u => u.id === friendId);
        if (requesterSocket) {
            io.to(requesterSocket.socketId).emit('friend-request-accepted', { friendId: req.user.id });
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Accept friend request error:', error);
        res.status(500).json({ error: 'Failed to accept friend request' });
    }
});

app.post('/api/friends/reject', authenticateToken, async (req, res) => {
    try {
        const { friendId } = req.body;
        await friendDB.rejectRequest(req.user.id, friendId);
        res.sendStatus(200);
    } catch (error) {
        console.error('Reject friend request error:', error);
        res.status(500).json({ error: 'Failed to reject friend request' });
    }
});

app.delete('/api/friends/:friendId', authenticateToken, async (req, res) => {
    try {
        const friendId = parseInt(req.params.friendId, 10);
        await friendDB.removeFriend(req.user.id, friendId);

        // Уведомляем удалённого друга — иначе он всё ещё видит тебя
        // в списке друзей до перезагрузки
        const otherSocket = Array.from(users.values()).find(u => u.id === friendId);
        if (otherSocket) {
            io.to(otherSocket.socketId).emit('friend-removed', { friendId: req.user.id });
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Remove friend error:', error);
        res.status(500).json({ error: 'Failed to remove friend' });
    }
});

const users = new Map();
const rooms = new Map();

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error'));
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error'));
        socket.userId = decoded.id;
        socket.userEmail = decoded.email;
        next();
    });
});

io.on('connection', async (socket) => {
    console.log('User connected:', socket.userId);

    try {
        const user = await userDB.findById(socket.userId);

        users.set(socket.id, {
            ...user,
            socketId: socket.id
        });

        await userDB.updateStatus(socket.userId, 'Online');

        io.emit('user-list-update', Array.from(users.values()));
    } catch (error) {
        console.error('Error loading user:', error);
    }

    socket.on('send-message', async (messageData) => {
        try {
            const { channelId, message } = messageData;

            if (!channelId || !message || !message.text || !message.text.trim()) {
                return;
            }

            const user = await userDB.findById(socket.userId);

            const savedMessage = await messageDB.create(
                message.text,
                socket.userId,
                channelId
            );

            const broadcastMessage = {
                id: savedMessage.id,
                author: user.username,
                avatar: user.avatar || user.username.charAt(0).toUpperCase(),
                text: message.text,
                file: message.file || null,
                timestamp: new Date()
            };

            io.emit('new-message', {
                channelId,
                message: broadcastMessage
            });
        } catch (error) {
            console.error('Message error:', error);
        }
    });

    socket.on('send-dm', async (data) => {
        try {
            const { receiverId, message } = data;
            const sender = await userDB.findById(socket.userId);

            const savedMessage = await dmDB.create(
                message.text,
                socket.userId,
                receiverId
            );

            const messagePayload = {
                id: savedMessage.id,
                author: sender.username,
                avatar: sender.avatar || sender.username.charAt(0).toUpperCase(),
                text: message.text,
                timestamp: new Date()
            };

            const receiverSocket = Array.from(users.values())
                .find(u => u.id === receiverId);

            if (receiverSocket) {
                io.to(receiverSocket.socketId).emit('new-dm', {
                    senderId: socket.userId,
                    message: messagePayload
                });
            }

            socket.emit('dm-sent', {
                receiverId,
                message: messagePayload
            });
        } catch (error) {
            console.error('DM error:', error);
        }
    });

    socket.on('add-reaction', async (data) => {
        try {
            const { messageId, emoji } = data;
            await reactionDB.add(emoji, messageId, socket.userId);

            const reactions = await reactionDB.getByMessage(messageId);
            io.emit('reaction-update', { messageId, reactions });
        } catch (error) {
            console.error('Reaction error:', error);
        }
    });

    socket.on('remove-reaction', async (data) => {
        try {
            const { messageId, emoji } = data;
            await reactionDB.remove(emoji, messageId, socket.userId);

            const reactions = await reactionDB.getByMessage(messageId);
            io.emit('reaction-update', { messageId, reactions });
        } catch (error) {
            console.error('Reaction error:', error);
        }
    });

    socket.on('voice-activity', (data) => {
        socket.broadcast.emit('user-speaking', {
            userId: socket.userId,
            speaking: data.speaking
        });
    });

    socket.on('join-voice-channel', (channelData) => {
        const { channelName, userId } = channelData;

        socket.join(`voice-${channelName}`);

        if (!rooms.has(channelName)) {
            rooms.set(channelName, new Set());
        }
        rooms.get(channelName).add(socket.id);

        socket.to(`voice-${channelName}`).emit('user-joined-voice', {
            userId,
            socketId: socket.id
        });

        const existingUsers = Array.from(rooms.get(channelName))
            .filter(id => id !== socket.id)
            .map(id => users.get(id));

        socket.emit('existing-voice-users', existingUsers);
    });

    socket.on('offer', (data) => {
        socket.to(data.to).emit('offer', {
            offer: data.offer,
            from: socket.id
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.to).emit('answer', {
            answer: data.answer,
            from: socket.id
        });
    });

    socket.on('ice-candidate', (data) => {
        socket.to(data.to).emit('ice-candidate', {
            candidate: data.candidate,
            from: socket.id
        });
    });

    socket.on('leave-voice-channel', (channelName) => {
        socket.leave(`voice-${channelName}`);

        if (rooms.has(channelName)) {
            rooms.get(channelName).delete(socket.id);
            socket.to(`voice-${channelName}`).emit('user-left-voice', socket.id);
        }
    });

    socket.on('initiate-call', (data) => {
        const { to, type, from } = data;
        console.log(`Call initiated from ${from.id} to ${to}, type: ${type}`);

        const receiverSocket = Array.from(users.values()).find(u => u.id === to);
        if (receiverSocket) {
            io.to(receiverSocket.socketId).emit('incoming-call', {
                from: {
                    id: from.id,
                    username: from.username,
                    socketId: socket.id,
                    avatar: from.username?.charAt(0).toUpperCase()
                },
                type: type
            });
        } else {
            socket.emit('call-rejected', { message: 'User is offline' });
        }
    });

    socket.on('accept-call', (data) => {
        const { to, from } = data;
        console.log(`Call accepted by ${from.id}, connecting to ${to}`);

        io.to(to).emit('call-accepted', {
            from: {
                id: from.id,
                username: from.username,
                socketId: socket.id
            }
        });
    });

    socket.on('reject-call', (data) => {
        const { to } = data;
        console.log(`Call rejected, notifying ${to}`);

        io.to(to).emit('call-rejected', {
            from: socket.id,
            message: 'Call was declined'
        });
    });

    socket.on('video-toggle', (data) => {
        const { to, enabled } = data;
        if (to) {
            io.to(to).emit('video-toggle', {
                from: socket.id,
                enabled: enabled
            });
        }
    });

    socket.on('end-call', (data) => {
        const { to } = data;
        if (to) {
            io.to(to).emit('call-ended', { from: socket.id });
        }
    });

    socket.on('disconnect', async () => {
        const user = users.get(socket.id);

        if (user) {
            console.log(`${user.username} disconnected`);

            try {
                await userDB.updateStatus(socket.userId, 'Offline');
            } catch (error) {
                console.error('Error updating status:', error);
            }

            rooms.forEach((members, roomName) => {
                if (members.has(socket.id)) {
                    members.delete(socket.id);
                    io.to(`voice-${roomName}`).emit('user-left-voice', socket.id);
                }
            });

            users.delete(socket.id);
            io.emit('user-list-update', Array.from(users.values()));
        }
    });
});

// Start server (после того как база готова)
initializeDatabase()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`Discord Clone server running on http://localhost:${PORT}`);
            console.log(`Open http://localhost:${PORT}/login.html in your browser`);
        });
    })
    .catch((err) => {
        console.error('FATAL: Failed to initialize database:', err);
        process.exit(1);
    });