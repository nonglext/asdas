const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage (resets on restart — достаточно для демо)
const users = {}; // { userId: { id, nickname, friends: [], friendRequests: [] } }
const onlineUsers = {}; // { userId: socketId }
const messages = {}; // { chatKey: [{ from, text, time }] }

function getChatKey(a, b) {
  return [a, b].sort().join('::');
}

// ─── REST: Регистрация ───────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { userId, nickname } = req.body;
  const id = userId.trim().toLowerCase();
  const nick = nickname ? nickname.trim() : id;

  if (!id || id.length < 3) {
    return res.status(400).json({ error: 'ID должен быть минимум 3 символа' });
  }
  if (!/^[a-z0-9_]+$/.test(id)) {
    return res.status(400).json({ error: 'ID может содержать только a-z, 0-9, _' });
  }
  if (users[id]) {
    return res.status(400).json({ error: 'Этот ID уже занят' });
  }

  users[id] = { id, nickname: nick, friends: [], friendRequests: [] };
  console.log(`[register] ${id} (${nick})`);
  res.json({ success: true, user: users[id] });
});

// ─── REST: Войти (проверить ID) ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { userId } = req.body;
  const id = userId.trim().toLowerCase();
  if (!users[id]) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ success: true, user: users[id] });
});

// ─── REST: Поиск по ID ───────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const results = Object.values(users)
    .filter(u => u.id.includes(q) || u.nickname.toLowerCase().includes(q))
    .slice(0, 10)
    .map(u => ({ id: u.id, nickname: u.nickname, online: !!onlineUsers[u.id] }));
  res.json(results);
});

// ─── REST: История чата ──────────────────────────────────────────────────────
app.get('/api/messages/:userId/:friendId', (req, res) => {
  const key = getChatKey(req.params.userId, req.params.friendId);
  res.json(messages[key] || []);
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentUserId = null;

  // Пользователь авторизуется через сокет
  socket.on('auth', (userId) => {
    const id = userId.trim().toLowerCase();
    if (!users[id]) return;
    currentUserId = id;
    onlineUsers[id] = socket.id;
    socket.join(id);

    // Уведомить друзей об онлайне
    users[id].friends.forEach(fId => {
      io.to(fId).emit('friendOnline', { id, nickname: users[id].nickname });
    });

    // Отправить текущий профиль
    socket.emit('profile', {
      ...users[id],
      friendRequests: users[id].friendRequests.map(fId => ({
        id: fId,
        nickname: users[fId]?.nickname || fId
      }))
    });

    console.log(`[online] ${id}`);
  });

  // Запрос в друзья
  socket.on('sendFriendRequest', (toId) => {
    if (!currentUserId || !users[toId]) return;
    const from = users[currentUserId];
    const to = users[toId];

    if (to.friends.includes(currentUserId)) return;
    if (to.friendRequests.includes(currentUserId)) return;

    to.friendRequests.push(currentUserId);
    io.to(toId).emit('friendRequest', { id: currentUserId, nickname: from.nickname });
    socket.emit('requestSent', { id: toId });
    console.log(`[friend-req] ${currentUserId} → ${toId}`);
  });

  // Принять запрос в друзья
  socket.on('acceptFriendRequest', (fromId) => {
    if (!currentUserId || !users[fromId]) return;
    const me = users[currentUserId];
    const them = users[fromId];

    me.friendRequests = me.friendRequests.filter(id => id !== fromId);
    if (!me.friends.includes(fromId)) me.friends.push(fromId);
    if (!them.friends.includes(currentUserId)) them.friends.push(currentUserId);

    socket.emit('friendAdded', { id: fromId, nickname: them.nickname, online: !!onlineUsers[fromId] });
    io.to(fromId).emit('friendAdded', { id: currentUserId, nickname: me.nickname, online: true });
    console.log(`[friends] ${currentUserId} ↔ ${fromId}`);
  });

  // Отклонить запрос
  socket.on('declineFriendRequest', (fromId) => {
    if (!currentUserId) return;
    users[currentUserId].friendRequests = users[currentUserId].friendRequests.filter(id => id !== fromId);
    socket.emit('requestDeclined', fromId);
  });

  // Отправить сообщение
  socket.on('sendMessage', ({ toId, text }) => {
    if (!currentUserId || !text.trim()) return;
    const me = users[currentUserId];
    if (!me.friends.includes(toId)) return;

    const key = getChatKey(currentUserId, toId);
    if (!messages[key]) messages[key] = [];

    const msg = { from: currentUserId, text: text.trim(), time: new Date().toISOString() };
    messages[key].push(msg);
    if (messages[key].length > 200) messages[key].shift();

    io.to(currentUserId).emit('newMessage', { chatWith: toId, msg });
    io.to(toId).emit('newMessage', { chatWith: currentUserId, msg });
    console.log(`[msg] ${currentUserId} → ${toId}: ${text.slice(0, 30)}`);
  });

  // Отключение
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

// ─── Запуск ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
