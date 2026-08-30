require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── MongoDB ─────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chatapp';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB подключена'))
  .catch(err => console.error('❌ MongoDB:', err));

// ─── Schemas ─────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true, lowercase: true },
  nickname: String,
  passwordHash: String,
  avatar: String,
  status: { type: String, default: 'Привет! Я использую ChatApp' },
  bio: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  friends: [String],
  friendRequests: [String],
  blockedUsers: [String]
});

const messageSchema = new mongoose.Schema({
  chatKey: String,
  from: String,
  to: String,
  text: String,
  image: String,
  type: { type: String, enum: ['text', 'image'], default: 'text' },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// ─── Helpers ─────────────────────────────────────────────────────────────────
const onlineUsers = {};

function hashPassword(p) {
  return crypto.createHash('sha256').update(p + 'chatapp_salt_2024').digest('hex');
}
function getChatKey(a, b) { return [a, b].sort().join('::'); }

// ─── File Upload ─────────────────────────────────────────────────────────────
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { userId, nickname, password } = req.body;
    const id = (userId || '').trim().toLowerCase();
    const nick = (nickname || '').trim() || id;

    if (!id || id.length < 3) return res.status(400).json({ error: 'ID минимум 3 символа' });
    if (!/^[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'ID: только a-z, 0-9, _' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    if (await User.findOne({ id })) return res.status(400).json({ error: 'Этот ID уже занят' });

    const user = new User({ id, nickname: nick, passwordHash: hashPassword(password), friends: [], friendRequests: [], blockedUsers: [] });
    await user.save();
    res.json({ success: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, friends: user.friends, friendRequests: user.friendRequests } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { userId, password } = req.body;
    const id = (userId || '').trim().toLowerCase();
    const user = await User.findOne({ id });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Неверный пароль' });
    res.json({ success: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, friends: user.friends, friendRequests: user.friendRequests } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

// ─── User Routes ─────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = await User.find({ $or: [{ id: { $regex: q, $options: 'i' } }, { nickname: { $regex: q, $options: 'i' } }] }).limit(10);
    res.json(results.map(u => ({ id: u.id, nickname: u.nickname, avatar: u.avatar, status: u.status, online: !!onlineUsers[u.id] })));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

app.get('/api/profile/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, online: !!onlineUsers[user.id], createdAt: user.createdAt });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка профиля' });
  }
});

app.post('/api/profile/update', async (req, res) => {
  try {
    const { userId, nickname, status, bio, avatar } = req.body;
    if (!userId) return res.status(400).json({ error: 'Не указан userId' });
    const user = await User.findOne({ id: userId });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (nickname !== undefined) user.nickname = nickname;
    if (status !== undefined) user.status = status;
    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    await user.save();
    res.json({ success: true, user: { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

app.post('/api/upload/avatar', upload.single('avatar'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || !req.file) return res.status(400).json({ error: 'Ошибка загрузки' });
    const user = await User.findOne({ id: userId });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    user.avatar = `/uploads/${req.file.filename}`;
    await user.save();
    res.json({ success: true, avatar: user.avatar });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки аватара' });
  }
});

// ─── Message Routes ───────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:friendId', async (req, res) => {
  try {
    const key = getChatKey(req.params.userId, req.params.friendId);
    const messages = await Message.find({ chatKey: key }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

// ─── Delete Message ───────────────────────────────────────────────────────────
app.delete('/api/messages/:messageId', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Не указан userId' });
    const msg = await Message.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.from !== userId) return res.status(403).json({ error: 'Нет доступа' });
    msg.deleted = true;
    msg.text = '';
    msg.image = null;
    await msg.save();
    // Notify both parties
    const chatKey = msg.chatKey;
    const otherUser = chatKey.split('::').find(id => id !== userId);
    io.to(userId).emit('messageDeleted', { messageId: req.params.messageId, chatWith: otherUser });
    io.to(otherUser).emit('messageDeleted', { messageId: req.params.messageId, chatWith: userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentUserId = null;

  socket.on('auth', async (userId) => {
    try {
      const id = (userId || '').trim().toLowerCase();
      const user = await User.findOne({ id });
      if (!user) return;
      currentUserId = id;
      onlineUsers[id] = socket.id;
      socket.join(id);
      user.friends.forEach(fId => io.to(fId).emit('friendOnline', { id, nickname: user.nickname }));
      socket.emit('profile', { id: user.id, nickname: user.nickname, avatar: user.avatar, status: user.status, bio: user.bio, friends: user.friends, friendRequests: user.friendRequests, blockedUsers: user.blockedUsers });
      console.log(`[online] ${id}`);
    } catch (err) { console.error('Auth error:', err); }
  });

  socket.on('sendFriendRequest', async (toId) => {
    try {
      if (!currentUserId) return;
      const from = await User.findOne({ id: currentUserId });
      const to = await User.findOne({ id: toId });
      if (!from || !to) return;
      if (to.friends.includes(currentUserId)) return;
      if (to.friendRequests.includes(currentUserId)) return;
      if (to.blockedUsers.includes(currentUserId)) return;
      to.friendRequests.push(currentUserId);
      await to.save();
      io.to(toId).emit('friendRequest', { id: currentUserId, nickname: from.nickname });
      socket.emit('requestSent', { id: toId });
    } catch (err) { console.error('Friend request error:', err); }
  });

  socket.on('acceptFriendRequest', async (fromId) => {
    try {
      if (!currentUserId) return;
      const me = await User.findOne({ id: currentUserId });
      const them = await User.findOne({ id: fromId });
      if (!me || !them) return;
      me.friendRequests = me.friendRequests.filter(id => id !== fromId);
      if (!me.friends.includes(fromId)) me.friends.push(fromId);
      if (!them.friends.includes(currentUserId)) them.friends.push(currentUserId);
      await me.save(); await them.save();
      socket.emit('friendAdded', { id: fromId, nickname: them.nickname, avatar: them.avatar, online: !!onlineUsers[fromId] });
      io.to(fromId).emit('friendAdded', { id: currentUserId, nickname: me.nickname, avatar: me.avatar, online: true });
    } catch (err) { console.error('Accept friend error:', err); }
  });

  socket.on('declineFriendRequest', async (fromId) => {
    try {
      if (!currentUserId) return;
      const user = await User.findOne({ id: currentUserId });
      if (!user) return;
      user.friendRequests = user.friendRequests.filter(id => id !== fromId);
      await user.save();
      socket.emit('requestDeclined', fromId);
    } catch (err) { console.error('Decline friend error:', err); }
  });

  socket.on('sendMessage', async ({ toId, text, image }) => {
    try {
      if (!currentUserId || (!text?.trim() && !image)) return;
      const me = await User.findOne({ id: currentUserId });
      if (!me || !me.friends.includes(toId)) return;
      const key = getChatKey(currentUserId, toId);
      const msg = new Message({ chatKey: key, from: currentUserId, to: toId, text: text?.trim() || '', image: image || null, type: image ? 'image' : 'text', timestamp: new Date() });
      await msg.save();
      const msgData = { _id: msg._id.toString(), from: currentUserId, text: msg.text, image: msg.image, type: msg.type, time: msg.timestamp.toISOString(), deleted: false };
      io.to(currentUserId).emit('newMessage', { chatWith: toId, msg: msgData });
      io.to(toId).emit('newMessage', { chatWith: currentUserId, msg: msgData });
    } catch (err) { console.error('Send message error:', err); }
  });

  socket.on('disconnect', async () => {
    if (currentUserId) {
      delete onlineUsers[currentUserId];
      const user = await User.findOne({ id: currentUserId });
      if (user) user.friends.forEach(fId => io.to(fId).emit('friendOffline', currentUserId));
      console.log(`[offline] ${currentUserId}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
  console.log(`📦 MongoDB: ${MONGODB_URI}`);
});
