'use strict';

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════
let me = null;           // { id, nickname, friends, friendRequests }
let activeFriend = null; // id
let friends = {};        // { id: { id, nickname, online } }
let unread = {};         // { id: count }

const socket = io();

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const qs = sel => document.querySelector(sel);

function avatar(nick) {
  return nick ? nick[0].toUpperCase() : '?';
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function setError(msg) {
  $('auth-error').textContent = msg || '';
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ═══════════════════════════════════════════════════════════════
// Auth tabs
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    setError('');
  });
});

// ─── Register ───────────────────────────────────────────────────
$('btn-register').addEventListener('click', async () => {
  const userId   = $('reg-id').value.trim();
  const nickname = $('reg-nick').value.trim();
  setError('');

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, nickname })
  });
  const data = await res.json();

  if (!res.ok) return setError(data.error);
  loginSuccess(data.user);
});

// ─── Login ──────────────────────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  const userId = $('login-id').value.trim();
  setError('');

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });
  const data = await res.json();

  if (!res.ok) return setError(data.error);
  loginSuccess(data.user);
});

// Enter key on login/register inputs
['login-id', 'reg-id', 'reg-nick'].forEach(id => {
  $(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      if (id.startsWith('login')) $('btn-login').click();
      else $('btn-register').click();
    }
  });
});

// ─── After successful login ──────────────────────────────────────
function loginSuccess(user) {
  me = user;
  localStorage.setItem('chatapp_id', user.id);

  $('my-avatar').textContent = avatar(user.nickname);
  $('my-nick').textContent   = user.nickname;
  $('my-id').textContent     = '@' + user.id;

  showScreen('app-screen');
  socket.emit('auth', user.id);
}

// ─── Logout ─────────────────────────────────────────────────────
$('btn-logout').addEventListener('click', () => {
  me = null; activeFriend = null; friends = {}; unread = {};
  localStorage.removeItem('chatapp_id');
  $('friends-list').innerHTML = '<div class="empty-hint">Пока нет друзей 🙁<br>Найди кого-нибудь выше!</div>';
  $('requests-list').innerHTML = '';
  $('requests-section').style.display = 'none';
  hideChat();
  showScreen('auth-screen');
});

// ═══════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════
let searchTimer = null;

$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) { closeSearch(); return; }
  searchTimer = setTimeout(() => doSearch(q), 300);
});

$('search-input').addEventListener('blur', () => {
  setTimeout(closeSearch, 200);
});

async function doSearch(q) {
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  const results = await res.json();

  const dropdown = $('search-results');
  dropdown.innerHTML = '';

  if (!results.length) {
    dropdown.innerHTML = '<div class="search-item" style="color:var(--text2)">Никого не найдено</div>';
    dropdown.classList.add('open');
    return;
  }

  results.forEach(u => {
    if (u.id === me?.id) return;

    const isFriend = me?.friends?.includes(u.id);
    const el = document.createElement('div');
    el.className = 'search-item';
    el.innerHTML = `
      <div class="f-avatar" style="width:32px;height:32px;font-size:14px">${avatar(u.nickname)}</div>
      <div>
        <div class="s-nick">${esc(u.nickname)}</div>
        <div class="s-id">@${esc(u.id)}</div>
      </div>
      <button class="btn-add s-add" ${isFriend ? 'disabled' : ''}>
        ${isFriend ? '✓ Друг' : '+ Добавить'}
      </button>`;

    el.querySelector('.btn-add').addEventListener('click', e => {
      e.stopPropagation();
      if (!isFriend) {
        socket.emit('sendFriendRequest', u.id);
        el.querySelector('.btn-add').textContent = 'Запрос отправлен';
        el.querySelector('.btn-add').disabled = true;
      }
    });

    el.addEventListener('click', () => {
      if (isFriend) openChat(u.id);
      closeSearch();
    });

    dropdown.appendChild(el);
  });

  dropdown.classList.add('open');
}

function closeSearch() {
  $('search-results').classList.remove('open');
}

// ═══════════════════════════════════════════════════════════════
// Socket events
// ═══════════════════════════════════════════════════════════════

// Profile (initial)
socket.on('profile', profile => {
  me = { ...me, ...profile };

  // Load friends
  (profile.friends || []).forEach(fId => {
    if (!friends[fId]) friends[fId] = { id: fId, nickname: fId, online: false };
  });

  // Load friend requests
  renderRequests(profile.friendRequests || []);

  // Render friends from server info
  renderFriendsList();
  fetchFriendNicknames(profile.friends || []);
});

async function fetchFriendNicknames(ids) {
  if (!ids.length) return;
  // Search each to get nickname (quick hack using search)
  for (const id of ids) {
    const res = await fetch('/api/search?q=' + encodeURIComponent(id));
    const results = await res.json();
    const found = results.find(u => u.id === id);
    if (found) {
      friends[id] = { id, nickname: found.nickname, online: found.online };
    }
  }
  renderFriendsList();
}

// Friend request received
socket.on('friendRequest', req => {
  if (!me) return;
  if (!me.friendRequests) me.friendRequests = [];
  me.friendRequests.push({ id: req.id, nickname: req.nickname });
  renderRequests(me.friendRequests);
});

// Request sent confirm
socket.on('requestSent', () => {});

// Request declined
socket.on('requestDeclined', fromId => {
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id || r) !== fromId);
    renderRequests(me.friendRequests);
  }
});

// Friend added (both sides)
socket.on('friendAdded', user => {
  friends[user.id] = { id: user.id, nickname: user.nickname, online: user.online };
  if (!me.friends) me.friends = [];
  if (!me.friends.includes(user.id)) me.friends.push(user.id);

  // Remove from requests if existed
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id || r) !== user.id);
    renderRequests(me.friendRequests);
  }
  renderFriendsList();
});

// Online / offline
socket.on('friendOnline', user => {
  if (friends[user.id]) {
    friends[user.id].online = true;
    updateFriendStatus(user.id, true);
  }
});
socket.on('friendOffline', id => {
  if (friends[id]) {
    friends[id].online = false;
    updateFriendStatus(id, false);
  }
});

// New message
socket.on('newMessage', ({ chatWith, msg }) => {
  if (activeFriend === chatWith) {
    appendMessage(msg);
    scrollMessages();
  } else {
    unread[chatWith] = (unread[chatWith] || 0) + 1;
    updateUnreadBadge(chatWith);
  }
});

// ═══════════════════════════════════════════════════════════════
// Render helpers
// ═══════════════════════════════════════════════════════════════

function renderRequests(requests) {
  const list = $('requests-list');
  const section = $('requests-section');
  const badge = $('req-badge');

  if (!requests || !requests.length) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  badge.textContent = requests.length;
  list.innerHTML = '';

  requests.forEach(r => {
    const id   = r.id   || r;
    const nick = r.nickname || id;
    const el = document.createElement('div');
    el.className = 'req-card';
    el.innerHTML = `
      <div class="f-avatar" style="width:32px;height:32px;font-size:14px">${avatar(nick)}</div>
      <div>
        <div class="req-nick">${esc(nick)}</div>
        <div class="req-id">@${esc(id)}</div>
      </div>
      <div class="req-actions">
        <button class="btn-accept">✓</button>
        <button class="btn-decline">✕</button>
      </div>`;

    el.querySelector('.btn-accept').addEventListener('click', () => {
      socket.emit('acceptFriendRequest', id);
    });
    el.querySelector('.btn-decline').addEventListener('click', () => {
      socket.emit('declineFriendRequest', id);
    });

    list.appendChild(el);
  });
}

function renderFriendsList() {
  const list = $('friends-list');
  const ids = Object.keys(friends);

  if (!ids.length) {
    list.innerHTML = '<div class="empty-hint">Пока нет друзей 🙁<br>Найди кого-нибудь выше!</div>';
    return;
  }

  list.innerHTML = '';
  ids.forEach(id => addOrUpdateFriendItem(id));
}

function addOrUpdateFriendItem(id) {
  const f = friends[id];
  if (!f) return;

  const list = $('friends-list');
  const existing = list.querySelector(`[data-friend="${id}"]`);

  const el = existing || document.createElement('div');
  el.className = 'friend-item' + (activeFriend === id ? ' active' : '');
  el.dataset.friend = id;

  const u = unread[id] || 0;
  el.innerHTML = `
    <div class="f-avatar">
      ${avatar(f.nickname)}
      ${f.online ? '<div class="online-dot"></div>' : ''}
    </div>
    <div class="f-info">
      <div class="f-nick">${esc(f.nickname)}</div>
      <div class="f-status ${f.online ? 'online' : ''}">${f.online ? '● онлайн' : 'офлайн'}</div>
    </div>
    ${u ? `<div class="f-unread">${u}</div>` : ''}`;

  el.addEventListener('click', () => openChat(id));

  if (!existing) list.appendChild(el);
}

function updateFriendStatus(id, online) {
  const el = $('friends-list').querySelector(`[data-friend="${id}"]`);
  if (el) {
    el.querySelector('.f-status').className = `f-status ${online ? 'online' : ''}`;
    el.querySelector('.f-status').textContent = online ? '● онлайн' : 'офлайн';
    const dot = el.querySelector('.online-dot');
    if (online && !dot) {
      const av = el.querySelector('.f-avatar');
      const d = document.createElement('div');
      d.className = 'online-dot';
      av.appendChild(d);
    } else if (!online && dot) dot.remove();
  }

  // Update chat header if open
  if (activeFriend === id) {
    $('chat-status').textContent = online ? '● онлайн' : 'офлайн';
    $('chat-status').className = 'chat-friend-status' + (online ? ' online' : '');
  }
}

function updateUnreadBadge(id) {
  addOrUpdateFriendItem(id);
}

// ═══════════════════════════════════════════════════════════════
// Chat
// ═══════════════════════════════════════════════════════════════

async function openChat(id) {
  activeFriend = id;
  unread[id] = 0;

  const f = friends[id] || { id, nickname: id, online: false };

  // Mark active in sidebar
  document.querySelectorAll('.friend-item').forEach(el => {
    el.classList.toggle('active', el.dataset.friend === id);
  });
  updateUnreadBadge(id);

  // Update header
  $('chat-avatar').textContent = avatar(f.nickname);
  $('chat-nick').textContent = f.nickname;
  $('chat-status').textContent = f.online ? '● онлайн' : 'офлайн';
  $('chat-status').className = 'chat-friend-status' + (f.online ? ' online' : '');

  $('chat-placeholder').style.display = 'none';
  const win = $('chat-window');
  win.style.display = 'flex';

  // Load history
  const res = await fetch(`/api/messages/${me.id}/${id}`);
  const history = await res.json();

  $('messages').innerHTML = '';
  history.forEach(msg => appendMessage(msg, false));
  scrollMessages();

  $('msg-input').focus();
}

function hideChat() {
  activeFriend = null;
  $('chat-placeholder').style.display = 'flex';
  $('chat-window').style.display = 'none';
  $('messages').innerHTML = '';
}

function appendMessage(msg, scroll = true) {
  const isMine = msg.from === me.id;
  const el = document.createElement('div');
  el.className = 'msg ' + (isMine ? 'mine' : 'theirs');
  el.innerHTML = `${esc(msg.text)}<div class="msg-time">${fmtTime(msg.time)}</div>`;
  $('messages').appendChild(el);
  if (scroll) scrollMessages();
}

function scrollMessages() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

// Send message
$('btn-send').addEventListener('click', sendMessage);
$('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

function sendMessage() {
  const text = $('msg-input').value.trim();
  if (!text || !activeFriend) return;
  socket.emit('sendMessage', { toId: activeFriend, text });
  $('msg-input').value = '';
}

// ═══════════════════════════════════════════════════════════════
// XSS escape
// ═══════════════════════════════════════════════════════════════
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════
// Auto-login from localStorage
// ═══════════════════════════════════════════════════════════════
(async () => {
  const savedId = localStorage.getItem('chatapp_id');
  if (savedId) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: savedId })
    });
    if (res.ok) {
      const data = await res.json();
      loginSuccess(data.user);
    }
  }
})();
