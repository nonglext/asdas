'use strict';

let me = null;
let activeFriend = null;
let friends = {};
let unread = {};
let pendingDeleteId = null;

// Раньше: const socket = io()  — без токена. Сервер (io.use в server.js) требует
// socket.handshake.auth.token и без него сразу рвёт соединение с 'Unauthorized'.
// Из-за этого ни одно событие (sendFriendRequest, sendMessage и т.д.) не доходило.
const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

function connectSocket() {
  const token = localStorage.getItem('chatapp_token');
  if (!token) return;
  socket.auth = { token };
  if (socket.connected) socket.disconnect();
  socket.connect();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function av(nick) { return nick ? nick[0].toUpperCase() : '?'; }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function setErr(msg) { $('auth-error').textContent = msg || ''; }

// ─── Auth Fetch (всегда отправляет JWT-токен) ──────────────────────────────────
function authFetch(url, options = {}) {
  const token = localStorage.getItem('chatapp_token');
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { 'Authorization': 'Bearer ' + token } : {})
    }
  });
}

// Render avatar: image or letter
function renderAv(el, nickname, avatarUrl) {
  if (avatarUrl) {
    el.textContent = '';
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { el.textContent = av(nickname); };
    el.appendChild(img);
  } else {
    el.textContent = av(nickname);
  }
}

// ─── Password toggle ──────────────────────────────────────────────────────────
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.style.opacity = input.type === 'text' ? '0.5' : '1';
    }
  });
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    setErr('');
  });
});

// ─── Register ─────────────────────────────────────────────────────────────────
$('btn-register').addEventListener('click', async () => {
  setErr('');
  const userId   = $('reg-id').value.trim();
  const nickname = $('reg-nick').value.trim();
  const password = $('reg-pw').value;

  if (!userId || userId.length < 3) return setErr('ID минимум 3 символа');
  if (!/^[a-z0-9_]+$/.test(userId)) return setErr('ID: только a-z, 0-9, _');
  if (!password || password.length < 4) return setErr('Пароль минимум 4 символа');

  const btn = $('btn-register');
  btn.disabled = true; btn.textContent = 'Загрузка…';
  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, nickname, password })
    });
    const data = await res.json();
    if (!res.ok) return setErr(data.error || 'Ошибка регистрации');
    saveAndLogin(data.user, userId, password, data.token);
  } catch(e) {
    setErr('Ошибка сети');
  } finally {
    btn.disabled = false; btn.textContent = 'Зарегистрироваться';
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  setErr('');
  const userId   = $('login-id').value.trim();
  const password = $('login-pw').value;

  if (!userId || !password) return setErr('Введите ID и пароль');

  const btn = $('btn-login');
  btn.disabled = true; btn.textContent = 'Загрузка…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password })
    });
    const data = await res.json();
    if (!res.ok) return setErr(data.error || 'Ошибка входа');
    saveAndLogin(data.user, userId, password, data.token);
  } catch(e) {
    setErr('Ошибка сети');
  } finally {
    btn.disabled = false; btn.textContent = 'Войти';
  }
});

['login-id','login-pw'].forEach(id => $(id).addEventListener('keydown', e => { if(e.key==='Enter') $('btn-login').click(); }));
['reg-id','reg-nick','reg-pw'].forEach(id => $(id).addEventListener('keydown', e => { if(e.key==='Enter') $('btn-register').click(); }));

function saveAndLogin(user, userId, password, token) {
  me = user;
  localStorage.setItem('chatapp_id', userId);
  localStorage.setItem('chatapp_pw', password);
  if (token) localStorage.setItem('chatapp_token', token);
  enterApp(user);
}

function enterApp(user) {
  renderAv($('my-avatar'), user.nickname, user.avatar);
  $('my-nick').textContent = user.nickname;
  $('my-id').textContent   = '@' + user.id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('app-screen').classList.add('active');
  connectSocket(); // было: socket.emit('auth', user.id) — сервер это событие не слушал
}

// ─── Logout ───────────────────────────────────────────────────────────────────
$('btn-logout').addEventListener('click', () => {
  me = null; activeFriend = null; friends = {}; unread = {};
  if (socket.connected) socket.disconnect();
  localStorage.removeItem('chatapp_id');
  localStorage.removeItem('chatapp_pw');
  localStorage.removeItem('chatapp_token');
  $('friends-list').innerHTML = emptyFriendsHTML();
  $('requests-list').innerHTML = '';
  $('requests-section').style.display = 'none';
  $('chat-window').style.display = 'none';
  $('chat-placeholder').style.display = '';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('auth-screen').classList.add('active');
});

function emptyFriendsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
    </div>
    <div class="empty-title">Нет контактов</div>
    <div class="empty-sub">Найди кого-нибудь через поиск</div>
  </div>`;
}

// ─── Me card → open edit profile ─────────────────────────────────────────────
$('me-card').addEventListener('click', (e) => {
  if (e.target.closest('#btn-logout')) return;
  if (me) openEditProfileModal();
});

// ─── Search ───────────────────────────────────────────────────────────────────
let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) { closeDrop(); return; }
  searchTimer = setTimeout(() => doSearch(q), 280);
});
$('search-input').addEventListener('blur', () => setTimeout(closeDrop, 200));

async function doSearch(q) {
  try {
    const res = await authFetch('/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error();
    const list = await res.json();
    const drop = $('search-results');
    drop.innerHTML = '';

    if (!list || !list.length) {
      drop.innerHTML = '<div class="s-item" style="color:var(--text3);font-size:13px">Никого не найдено</div>';
      drop.classList.add('open'); return;
    }

    list.forEach(u => {
      if (u.id === me?.id) return;
      const isFriend = me?.friends?.includes(u.id);
      const el = document.createElement('div');
      el.className = 's-item';
      el.innerHTML = `
        <div class="s-mini-av"></div>
        <div style="flex:1;min-width:0">
          <div class="s-nick">${esc(u.nickname)}</div>
          <div class="s-id">@${esc(u.id)}</div>
        </div>
        <button class="btn-add" ${isFriend?'disabled':''}>${isFriend?'✓ Друг':'+ Добавить'}</button>`;

      renderAv(el.querySelector('.s-mini-av'), u.nickname, u.avatar);

      el.querySelector('.btn-add').addEventListener('click', e => {
        e.stopPropagation();
        if (!isFriend) {
          socket.emit('sendFriendRequest', u.id);
          const btn = el.querySelector('.btn-add');
          btn.textContent = 'Отправлено'; btn.disabled = true;
        }
      });
      el.addEventListener('click', () => {
        if (isFriend) openChat(u.id);
        else showUserProfile(u.id);
        closeDrop();
      });
      drop.appendChild(el);
    });
    drop.classList.add('open');
  } catch(e) {
    $('search-results').innerHTML = '<div class="s-item" style="color:var(--red);font-size:13px">Ошибка поиска</div>';
    $('search-results').classList.add('open');
  }
}
function closeDrop() { $('search-results').classList.remove('open'); $('search-input').value = ''; }

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('profile', profile => {
  me = { ...me, ...profile };
  unread = { ...(profile.unreadCounts || {}) }; // раньше не подтягивались — не было бейджей после захода/реконнекта
  renderAv($('my-avatar'), me.nickname, me.avatar);
  $('my-nick').textContent = me.nickname;
  (profile.friends || []).forEach(fId => {
    if (!friends[fId]) friends[fId] = { id: fId, nickname: fId, online: false };
  });
  renderRequests(profile.friendRequests || []);
  renderFriendsList();
  fetchNicknames(profile.friends || []);
  // Если чат был открыт в момент дисконнекта — переоткрываем, чтобы подтянуть
  // возможные messageDeleted/новые сообщения, пропущенные во время оффлайна (аудит, пункт 1)
  if (activeFriend) openChat(activeFriend);
});

async function fetchNicknames(ids) {
  for (const id of ids) {
    try {
      const res = await authFetch('/api/profile/' + encodeURIComponent(id));
      if (res.ok) {
        const u = await res.json();
        friends[id] = { id, nickname: u.nickname, avatar: u.avatar, online: u.online };
      }
    } catch(e) {}
  }
  renderFriendsList();
}

socket.on('friendRequest', req => {
  if (!me) return;
  if (!me.friendRequests) me.friendRequests = [];
  me.friendRequests.push({ id: req.id, nickname: req.nickname });
  renderRequests(me.friendRequests);
});
socket.on('requestSent', () => {});
socket.on('requestDeclined', fromId => {
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id||r) !== fromId);
    renderRequests(me.friendRequests);
  }
});
socket.on('friendAdded', user => {
  friends[user.id] = { id: user.id, nickname: user.nickname, avatar: user.avatar, online: user.online };
  if (!me.friends) me.friends = [];
  if (!me.friends.includes(user.id)) me.friends.push(user.id);
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id||r) !== user.id);
    renderRequests(me.friendRequests);
  }
  renderFriendsList();
});
socket.on('friendOnline', u => {
  if (friends[u.id]) { friends[u.id].online = true; updateStatus(u.id, true); }
});
socket.on('friendOffline', id => {
  if (friends[id]) { friends[id].online = false; updateStatus(id, false); }
});
socket.on('newMessage', ({ chatWith, msg }) => {
  if (activeFriend === chatWith) { appendMsg(msg); scrollMsgs(); }
  else { unread[chatWith] = (unread[chatWith]||0) + 1; refreshFriendItem(chatWith); }
});
socket.on('messageDeleted', ({ messageId, chatWith }) => {
  const wrap = document.querySelector(`[data-msgid="${messageId}"]`);
  if (wrap) {
    const bubble = wrap.querySelector('.msg');
    if (bubble) {
      bubble.classList.add('deleted-msg');
      bubble.innerHTML = '<em>Сообщение удалено</em>';
    }
    const delBtn = wrap.querySelector('.msg-del-btn');
    if (delBtn) delBtn.remove();
  }
});

// ─── Render ───────────────────────────────────────────────────────────────────
function renderRequests(reqs) {
  const sec = $('requests-section');
  const list = $('requests-list');
  if (!reqs || !reqs.length) { sec.style.display = 'none'; list.innerHTML = ''; return; }
  sec.style.display = 'block';
  $('req-badge').textContent = reqs.length;
  list.innerHTML = '';
  reqs.forEach(r => {
    const id = r.id||r, nick = r.nickname||id;
    const el = document.createElement('div');
    el.className = 'req-card';
    el.innerHTML = `
      <div class="f-av" style="width:34px;height:34px;font-size:13px"></div>
      <div style="flex:1;min-width:0">
        <div class="req-nick">${esc(nick)}</div>
        <div class="req-id">@${esc(id)}</div>
      </div>
      <div class="req-btns">
        <button class="btn-ok">✓</button>
        <button class="btn-no">✕</button>
      </div>`;
    renderAv(el.querySelector('.f-av'), nick, null);
    el.querySelector('.btn-ok').onclick = () => socket.emit('acceptFriendRequest', id);
    el.querySelector('.btn-no').onclick = () => socket.emit('declineFriendRequest', id);
    list.appendChild(el);
  });
}

function renderFriendsList() {
  const list = $('friends-list');
  const ids = Object.keys(friends);
  if (!ids.length) { list.innerHTML = emptyFriendsHTML(); return; }
  list.innerHTML = '';
  ids.forEach(id => buildFriendEl(id));
}

function buildFriendEl(id) {
  const f = friends[id]; if (!f) return;
  const list = $('friends-list');
  const old = list.querySelector(`[data-fid="${id}"]`);
  const u = unread[id]||0;

  const el = old || document.createElement('div');
  el.className = 'friend-item' + (activeFriend===id?' active':'');
  el.dataset.fid = id;
  el.innerHTML = `
    <div class="f-av">${f.online?'<div class="f-dot"></div>':''}</div>
    <div class="f-info">
      <div class="f-nick">${esc(f.nickname)}</div>
      <div class="f-stat ${f.online?'on':''}">${f.online?'● онлайн':'офлайн'}</div>
    </div>
    ${u?`<div class="f-unread">${u}</div>`:''}`;

  const avEl = el.querySelector('.f-av');
  // prepend letter/img before dot
  const dot = avEl.querySelector('.f-dot');
  const span = document.createElement('span');
  span.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:50%';
  if (f.avatar) {
    const img = document.createElement('img');
    img.src = f.avatar;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover';
    img.onerror = () => { span.textContent = av(f.nickname); };
    span.appendChild(img);
  } else {
    span.textContent = av(f.nickname);
  }
  avEl.style.position = 'relative';
  avEl.insertBefore(span, dot);

  el.onclick = () => openChat(id);
  if (!old) list.appendChild(el);
}

function refreshFriendItem(id) {
  const list = $('friends-list');
  const old = list.querySelector(`[data-fid="${id}"]`);
  if (old) old.remove();
  buildFriendEl(id);
}

function updateStatus(id, online) {
  refreshFriendItem(id);
  if (activeFriend === id) {
    $('chat-status').textContent = online ? '● онлайн' : 'офлайн';
    $('chat-status').className = 'chat-head-status' + (online ? ' on' : '');
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function openChat(id) {
  if (!me || !id) return;
  activeFriend = id;
  unread[id] = 0;
  document.querySelectorAll('.friend-item').forEach(el => el.classList.toggle('active', el.dataset.fid===id));
  refreshFriendItem(id);

  const f = friends[id]||{id, nickname: id, online: false};
  renderAv($('chat-avatar'), f.nickname, f.avatar);
  $('chat-nick').textContent   = f.nickname;
  $('chat-status').textContent = f.online ? '● онлайн' : 'офлайн';
  $('chat-status').className   = 'chat-head-status' + (f.online?' on':'');

  $('chat-placeholder').style.display = 'none';
  $('chat-window').style.display = 'flex';

  // Mobile: show chat panel
  if (window.innerWidth <= 640) {
    document.querySelector('.sidebar').classList.add('hidden');
    document.querySelector('.chat-main').classList.remove('hidden');
  }

  $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Загрузка…</div>';

  try {
    const res = await authFetch(`/api/messages/${me.id}/${id}`);
    if (!res.ok) throw new Error();
    const history = await res.json();
    $('messages').innerHTML = '';
    if (!history || !history.length) {
      $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Напишите первым! 👋</div>';
    } else {
      history.forEach(m => appendMsg(m, false));
    }
    scrollMsgs();
  } catch(e) {
    $('messages').innerHTML = '<div style="text-align:center;color:var(--red);padding:24px;font-size:13px">Ошибка загрузки</div>';
  }
  socket.emit('markRead', id);
  $('msg-input').focus();
}

function appendMsg(msg, doScroll=true) {
  if (!me) return;
  const isMine = msg.from === me.id;
  const isDeleted = msg.deleted;
  const msgId = msg._id || msg.id || '';

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + (isMine ? 'mine' : 'theirs');
  if (msgId) wrap.dataset.msgid = msgId;

  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (isMine ? 'mine' : 'theirs') + (isDeleted ? ' deleted-msg' : '');

  if (isDeleted) {
    bubble.innerHTML = '<em>Сообщение удалено</em>';
  } else {
    bubble.innerHTML = `${esc(msg.text || '')}<div class="msg-time">${fmtTime(msg.time || msg.timestamp || msg.createdAt)}</div>`;
  }

  wrap.appendChild(bubble);

  // Delete button (only for own non-deleted messages)
  if (isMine && !isDeleted && msgId) {
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-del-btn';
    delBtn.title = 'Удалить';
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>`;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteConfirm(msgId);
    });
    wrap.appendChild(delBtn);
  }

  $('messages').appendChild(wrap);
  if (doScroll) scrollMsgs();
}

function scrollMsgs() { const m = $('messages'); m.scrollTop = m.scrollHeight; }

// ─── Delete message ───────────────────────────────────────────────────────────
function openDeleteConfirm(msgId) {
  pendingDeleteId = msgId;
  $('delete-confirm').style.display = 'flex';
}
function closeDeleteConfirm() {
  pendingDeleteId = null;
  $('delete-confirm').style.display = 'none';
}
$('btn-confirm-delete').addEventListener('click', async () => {
  if (!pendingDeleteId || !me) return;
  closeDeleteConfirm();
  try {
    const res = await authFetch(`/api/messages/${pendingDeleteId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: me.id })
    });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error || 'Ошибка удаления');
    }
  } catch(e) {
    alert('Ошибка сети');
  }
});

// ─── Send message ─────────────────────────────────────────────────────────────
$('btn-send').onclick = sendMsg;
$('msg-input').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } });

function sendMsg() {
  const text = $('msg-input').value.trim();
  if (!text || !activeFriend) return;
  socket.emit('sendMessage', { toId: activeFriend, text });
  $('msg-input').value = '';
  $('msg-input').focus();
}

// ─── Profile: view other user ─────────────────────────────────────────────────
$('chat-head-click').addEventListener('click', () => {
  if (activeFriend) showUserProfile(activeFriend);
});

async function showUserProfile(userId) {
  try {
    const res = await authFetch('/api/profile/' + encodeURIComponent(userId));
    if (!res.ok) return;
    const u = await res.json();

    renderAv($('profile-modal-avatar'), u.nickname, u.avatar);
    $('profile-modal-nick').textContent = u.nickname;
    $('profile-modal-id').textContent   = '@' + u.id;

    const onlineBadge = $('profile-modal-online');
    onlineBadge.textContent = u.online ? '● онлайн' : 'офлайн';
    onlineBadge.className   = 'modal-online-badge ' + (u.online ? 'online' : 'offline');

    const statusRow = $('profile-modal-status-row');
    const bioRow    = $('profile-modal-bio-row');
    if (u.status) {
      $('profile-modal-status').textContent = u.status;
      statusRow.style.display = '';
    } else { statusRow.style.display = 'none'; }
    if (u.bio) {
      $('profile-modal-bio').textContent = u.bio;
      bioRow.style.display = '';
    } else { bioRow.style.display = 'none'; }

    const addBtn = $('btn-add-friend');
    const isFriend = me?.friends?.includes(userId);
    const isMe = userId === me?.id;
    addBtn.style.display = (isFriend || isMe) ? 'none' : '';
    if (!isFriend && !isMe) {
      addBtn.onclick = () => {
        socket.emit('sendFriendRequest', userId);
        addBtn.textContent = 'Запрос отправлен';
        addBtn.disabled = true;
      };
    }

    const blockBtn = $('btn-block-user');
    if (blockBtn) {
      blockBtn.style.display = isMe ? 'none' : '';
      blockBtn.disabled = false;
      blockBtn.textContent = 'Заблокировать';
      blockBtn.onclick = async () => {
        if (!confirm(`Заблокировать @${userId}?`)) return;
        try {
          const res = await authFetch(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' });
          if (!res.ok) return alert('Ошибка блокировки');
          if (me.friends) me.friends = me.friends.filter(id => id !== userId);
          delete friends[userId];
          renderFriendsList();
          blockBtn.textContent = 'Заблокирован';
          blockBtn.disabled = true;
        } catch (e) { alert('Ошибка сети'); }
      };
    }

    $('profile-modal').style.display = 'flex';
  } catch(e) {}
}

function closeProfileModal() { $('profile-modal').style.display = 'none'; }
window.closeProfileModal = closeProfileModal;

// Click outside to close
$('profile-modal').addEventListener('click', e => {
  if (e.target === $('profile-modal')) closeProfileModal();
});

// ─── Profile: edit own ────────────────────────────────────────────────────────
function openEditProfileModal() {
  if (!me) return;
  renderAv($('edit-avatar'), me.nickname, me.avatar);
  $('edit-nick').value   = me.nickname || '';
  $('edit-status').value = me.status || '';
  $('edit-bio').value    = me.bio || '';
  $('edit-profile-modal').style.display = 'flex';
}
function closeEditProfileModal() { $('edit-profile-modal').style.display = 'none'; }
window.closeEditProfileModal = closeEditProfileModal;

$('edit-profile-modal').addEventListener('click', e => {
  if (e.target === $('edit-profile-modal')) closeEditProfileModal();
});

// Avatar upload
$('avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !me) return;
  const formData = new FormData();
  formData.append('avatar', file);
  formData.append('userId', me.id);
  try {
    const res = await authFetch('/api/upload/avatar', { method: 'POST', body: formData });
    if (!res.ok) return alert('Ошибка загрузки аватара');
    const data = await res.json();
    me.avatar = data.avatar;
    renderAv($('edit-avatar'), me.nickname, me.avatar);
    renderAv($('my-avatar'), me.nickname, me.avatar);
  } catch(e) { alert('Ошибка сети'); }
  e.target.value = '';
});

// Save profile
$('btn-save-profile').addEventListener('click', async () => {
  if (!me) return;
  const nickname = $('edit-nick').value.trim();
  const status   = $('edit-status').value.trim();
  const bio      = $('edit-bio').value.trim();

  const btn = $('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Сохранение…';
  try {
    const res = await authFetch('/api/profile/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: me.id, nickname, status, bio })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Ошибка сохранения');
    me.nickname = data.user.nickname;
    me.status   = data.user.status;
    me.bio      = data.user.bio;
    $('my-nick').textContent = me.nickname;
    renderAv($('my-avatar'), me.nickname, me.avatar);
    closeEditProfileModal();
  } catch(e) { alert('Ошибка сети'); }
  finally { btn.disabled = false; btn.textContent = 'Сохранить'; }
});

// ─── Mobile back button ───────────────────────────────────────────────────────
$('btn-back')?.addEventListener('click', () => {
  activeFriend = null;
  document.querySelector('.sidebar').classList.remove('hidden');
  document.querySelector('.chat-main').classList.add('hidden');
});

// Handle resize
window.addEventListener('resize', () => {
  if (window.innerWidth > 640) {
    document.querySelector('.sidebar')?.classList.remove('hidden');
    document.querySelector('.chat-main')?.classList.remove('hidden');
  }
});

// ─── Auto-login ───────────────────────────────────────────────────────────────
(async () => {
  const savedId = localStorage.getItem('chatapp_id');
  const savedPw = localStorage.getItem('chatapp_pw');
  if (savedId && savedPw) {
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: savedId, password: savedPw })
      });
      if (res.ok) {
        const d = await res.json();
        me = d.user;
        if (d.token) localStorage.setItem('chatapp_token', d.token);
        enterApp(d.user);
      } else {
        localStorage.removeItem('chatapp_id');
        localStorage.removeItem('chatapp_pw');
        localStorage.removeItem('chatapp_token');
      }
    } catch(e) {}
  }
})();

// ─── Socket error handling ────────────────────────────────────────────────────
socket.on('connect_error', err => {
  console.error('Socket error:', err);
  if (err.message === 'Unauthorized') {
    localStorage.removeItem('chatapp_id');
    localStorage.removeItem('chatapp_pw');
    localStorage.removeItem('chatapp_token');
    me = null;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $('auth-screen').classList.add('active');
    setErr('Сессия истекла, войдите снова');
  }
});
socket.on('disconnect', reason => console.warn('Socket disconnected:', reason));