const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
const users = {};       // { userId: { id, nickname, passwordHash, friends, friendRequests } }
const onlineUsers = {}; // { userId: socketId }
const messages = {};    // { chatKey: [{ from, text, time }] }

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'chatapp_salt_2024').digest('hex');
}

function getChatKey(a, b) {
  return [a, b].sort().join('::');
}

// ─── Register ────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { userId, nickname, password } = req.body;
  const id = (userId || '').trim().toLowerCase();
  const nick = (nickname || '').trim() || id;

  if (!id || id.length < 3)
    return res.status(400).json({ error: 'ID должен быть минимум 3 символа' });
  if (!/^[a-z0-9_]+$/.test(id))
    return res.status(400).json({ error: 'ID: только a-z, 0-9, _' });
  if (users[id])
    return res.status(400).json({ error: 'Этот ID уже занят' });
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'Пароль минимум 4 символа' });

  users[id] = { id, nickname: nick, passwordHash: hashPassword(password), friends: [], friendRequests: [] };
  console.log(`[register] ${id}`);
  res.json({ success: true, user: { id, nickname: nick, friends: [], friendRequests: [] } });
});

// ─── Login ───────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { userId, password } = req.body;
  const id = (userId || '').trim().toLowerCase();
  const user = users[id];

  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.passwordHash !== hashPassword(password))
    return res.status(401).json({ error: 'Неверный пароль' });

  res.json({ success: true, user: { id: user.id, nickname: user.nickname, friends: user.friends, friendRequests: user.friendRequests } });
});

// ─── Search ──────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const results = Object.values(users)
    .filter(u => u.id.includes(q) || u.nickname.toLowerCase().includes(q))
    .slice(0, 10)
    .map(u => ({ id: u.id, nickname: u.nickname, online: !!onlineUsers[u.id] }));
  res.json(results);
});

// ─── Messages ────────────────────────────────────────────────────────────────
app.get('/api/messages/:userId/:friendId', (req, res) => {
  const key = getChatKey(req.params.userId, req.params.friendId);
  res.json(messages[key] || []);
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentUserId = null;

  socket.on('auth', (userId) => {
    const id = (userId || '').trim().toLowerCase();
    if (!users[id]) return;
    currentUserId = id;
    onlineUsers[id] = socket.id;
    socket.join(id);

    users[id].friends.forEach(fId => {
      io.to(fId).emit('friendOnline', { id, nickname: users[id].nickname });
    });

    socket.emit('profile', {
      ...users[id],
      passwordHash: undefined,
      friendRequests: users[id].friendRequests.map(fId => ({
        id: fId, nickname: users[fId]?.nickname || fId
      }))
    });
    console.log(`[online] ${id}`);
  });

  socket.on('sendFriendRequest', (toId) => {
    if (!currentUserId || !users[toId]) return;
    const from = users[currentUserId];
    const to = users[toId];
    if (to.friends.includes(currentUserId)) return;
    if (to.friendRequests.includes(currentUserId)) return;
    to.friendRequests.push(currentUserId);
    io.to(toId).emit('friendRequest', { id: currentUserId, nickname: from.nickname });
    socket.emit('requestSent', { id: toId });
  });

  socket.on('acceptFriendRequest', (fromId) => {
    if (!currentUserId || !users[fromId]) return;
    const me = users[currentUserId];
    const them = users[fromId];
    me.friendRequests = me.friendRequests.filter(id => id !== fromId);
    if (!me.friends.includes(fromId)) me.friends.push(fromId);
    if (!them.friends.includes(currentUserId)) them.friends.push(currentUserId);
    socket.emit('friendAdded', { id: fromId, nickname: them.nickname, online: !!onlineUsers[fromId] });
    io.to(fromId).emit('friendAdded', { id: currentUserId, nickname: me.nickname, online: true });
  });

  socket.on('declineFriendRequest', (fromId) => {
    if (!currentUserId) return;
    users[currentUserId].friendRequests = users[currentUserId].friendRequests.filter(id => id !== fromId);
    socket.emit('requestDeclined', fromId);
  });

  socket.on('sendMessage', ({ toId, text }) => {
    if (!currentUserId || !text.trim()) return;
    const me = users[currentUserId];
    if (!me.friends.includes(toId)) return;
    const key = getChatKey(currentUserId, toId);
    if (!messages[key]) messages[key] = [];
    const msg = { from: currentUserId, text: text.trim(), time: new Date().toISOString() };
    messages[key].push(msg);
    if (messages[key].length > 300) messages[key].shift();
    io.to(currentUserId).emit('newMessage', { chatWith: toId, msg });
    io.to(toId).emit('newMessage', { chatWith: currentUserId, msg });
  });

  socket.on('disconnect', () => {
    if (currentUserId) {
      delete onlineUsers[currentUserId];
      users[currentUserId]?.friends.forEach(fId => {
        io.to(fId).emit('friendOffline', currentUserId);
      });
      console.log(`[offline] ${currentUserId}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
