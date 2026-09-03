'use strict';

let me = null;
let activeFriend = null;
let activeGroup = null;
let friends = Object.create(null);
let groups = Object.create(null);
let unread = Object.create(null);
let groupUnread = Object.create(null);
let pendingDeleteId = null;
let chatRequestSeq = 0;
let groupChatRequestSeq = 0;
let profileRequestSeq = 0;

const MAX_MESSAGE_LENGTH = 4000;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const BACKEND_URL = "https://asdas-p7ht.onrender.com";

const socket = io(BACKEND_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling']
});
const $ = id => document.getElementById(id);

// Иконка коронки для владельца группы
const CROWN_SVG = '<svg class="gm-crown" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" title="Владелец группы"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>';

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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}
function setErr(msg) { $('auth-error').textContent = msg || ''; }

function closeAllModals() {
  ['profile-modal', 'edit-profile-modal', 'blocked-users-modal', 'delete-confirm',
   'create-group-modal', 'group-info-modal', 'add-members-modal'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });
  pendingDeleteId = null;
}

function forceLogoutToLogin(message) {
  me = null; activeFriend = null; activeGroup = null;
  friends = Object.create(null); groups = Object.create(null);
  unread = Object.create(null); groupUnread = Object.create(null);
  if (socket.connected) socket.disconnect();
  localStorage.removeItem('chatapp_id');
  localStorage.removeItem('chatapp_pw');
  localStorage.removeItem('chatapp_token');
  localStorage.removeItem('chatapp_profile');
  document.documentElement.classList.remove('has-session');
  closeAllModals();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('auth-screen').classList.add('active');
  if (message) setErr(message);
}

async function authFetch(url, options = {}) {
  const token = localStorage.getItem('chatapp_token');
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { 'Authorization': 'Bearer ' + token } : {})
    }
  });
  if (res.status === 401 && me) {
    forceLogoutToLogin('Сессия истекла, войдите снова');
  }
  return res;
}

function renderAv(el, nickname, avatarUrl) {
  if (!el) return;
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

// Аватар группы — сетка из лиц участников (как в Discord)
function renderGroupAv(el, group) {
  if (!el) return;
  el.textContent = '';
  el.classList.add('group-av');
  const members = (group.members || []).slice(0, 4);
  if (!members.length) { el.textContent = '#'; return; }
  const grid = document.createElement('div');
  grid.className = 'group-av-grid g' + members.length;
  members.forEach(m => {
    const cell = document.createElement('div');
    cell.className = 'group-av-cell';
    if (m.avatar) {
      const img = document.createElement('img');
      img.src = m.avatar; img.alt = ''; img.loading = 'lazy';
      img.onerror = () => { cell.textContent = av(m.nickname); };
      cell.appendChild(img);
    } else {
      cell.textContent = av(m.nickname);
    }
    grid.appendChild(cell);
  });
  el.appendChild(grid);
}

// ─── Password toggle ──────────────────────────────────────────────────────────
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
    const svg = btn.querySelector('svg');
    if (svg) svg.style.opacity = input.type === 'text' ? '0.5' : '1';
  });
});

// ─── Auth Tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    setErr('');
  });
});

// ─── Sidebar Tabs (DM / Groups) ──────────────────────────────────────────────
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isGroups = tab.dataset.stab === 'groups';
    $('dm-panel').style.display = isGroups ? 'none' : '';
    $('groups-panel').style.display = isGroups ? '' : 'none';
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
  if (!nickname) return setErr('Введите никнейм');
  if (!password || password.length < 4) return setErr('Пароль минимум 4 символа');

  const btn = $('btn-register');
  btn.disabled = true; btn.textContent = 'Загрузка…';
  try {
    const res = await fetch(BACKEND_URL + '/api/register', {
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
    const res = await fetch(BACKEND_URL + '/api/login', {
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
  localStorage.removeItem('chatapp_pw');
  if (token) localStorage.setItem('chatapp_token', token);
  localStorage.setItem('chatapp_profile', JSON.stringify(user));
  enterApp(user);
}

function enterApp(user) {
  renderAv($('my-avatar'), user.nickname, user.avatar);
  $('my-nick').textContent = user.nickname;
  $('my-id').textContent   = '@' + user.id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('app-screen').classList.add('active');
  connectSocket();
  loadGroups();
}

// ─── Logout ───────────────────────────────────────────────────────────────────
$('btn-logout').addEventListener('click', () => {
  forceLogoutToLogin();
  $('friends-list').innerHTML = emptyFriendsHTML();
  $('requests-list').innerHTML = '';
  $('requests-section').style.display = 'none';
  $('groups-list').innerHTML = emptyGroupsHTML();
  closeActiveChat();
});

function closeActiveChat() {
  activeFriend = null;
  activeGroup = null;
  $('chat-placeholder').style.display = '';
  $('chat-window').style.display = 'none';
  $('group-chat-window').style.display = 'none';
}

function emptyFriendsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg></div>
    <div class="empty-title">Нет контактов</div>
    <div class="empty-sub">Найди кого-нибудь через поиск</div>
  </div>`;
}

function emptyGroupsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg></div>
    <div class="empty-title">Нет групп</div>
    <div class="empty-sub">Создай группу кнопкой +</div>
  </div>`;
}

// ─── Me card → edit profile ───────────────────────────────────────────────────
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
    const res = await authFetch(BACKEND_URL + '/api/search?q=' + encodeURIComponent(q));
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
  localStorage.setItem('chatapp_profile', JSON.stringify(me));
  unread = Object.assign(Object.create(null), profile.unreadCounts || {});
  groupUnread = Object.assign(Object.create(null), profile.groupUnreadCounts || {});
  renderAv($('my-avatar'), me.nickname, me.avatar);
  $('my-nick').textContent = me.nickname;
  (profile.friends || []).forEach(fId => {
    if (!friends[fId]) friends[fId] = { id: fId, nickname: fId, online: false };
  });
  renderRequests(profile.friendRequests || []);
  renderFriendsList();
  fetchNicknames(profile.friends || []);
  loadGroups();
  if (activeFriend) openChat(activeFriend);
  if (activeGroup) openGroupChat(activeGroup);
});

async function fetchNicknames(ids) {
  const results = await Promise.allSettled(
    ids.map(id => authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(id)).then(async res => {
      if (!res.ok) throw new Error('not ok');
      return { id, data: await res.json() };
    }))
  );
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      const { id, data: u } = r.value;
      friends[id] = { id, nickname: u.nickname, avatar: u.avatar, online: u.online };
    }
  });
  renderFriendsList();
}

socket.on('friendRequest', req => {
  if (!me) return;
  if (!me.friendRequests) me.friendRequests = [];
  const already = me.friendRequests.some(r => (r.id || r) === req.id);
  if (!already) {
    me.friendRequests.push({ id: req.id, nickname: req.nickname });
    renderRequests(me.friendRequests);
  }
});
socket.on('requestSent', () => {});
socket.on('friendRequestError', ({ reason }) => {
  const addBtn = $('btn-add-friend');
  if (addBtn && addBtn.style.display !== 'none') {
    addBtn.textContent = 'Добавить в друзья';
    addBtn.disabled = false;
  }
  const messages = {
    rate_limited: 'Слишком много заявок, попробуйте позже',
    not_found: 'Пользователь не найден',
    self: 'Нельзя добавить самого себя',
    already_friends: 'Вы уже друзья',
    already_sent: 'Заявка уже отправлена',
    blocked: 'Невозможно отправить заявку',
    limit_reached: 'Достигнут лимит заявок/друзей',
    target_limit_reached: 'У пользователя переполнен список заявок',
    server_error: 'Ошибка сервера'
  };
  alert(messages[reason] || 'Не удалось отправить заявку');
});
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
socket.on('friendRemoved', ({ id }) => {
  if (me?.friends) me.friends = me.friends.filter(fid => fid !== id);
  delete friends[id];
  delete unread[id];
  renderFriendsList();
  if (activeFriend === id) {
    activeFriend = null;
    $('chat-placeholder').style.display = 'flex';
    $('chat-window').style.display = 'none';
  }
});
socket.on('friendOnline', u => {
  if (friends[u.id]) { friends[u.id].online = true; updateStatus(u.id, true); }
  renderGroupsList();
  if (activeGroup && groups[activeGroup]) {
    const g = groups[activeGroup];
    const m = g.members.find(x => x.id === u.id);
    if (m) { m.online = true; renderGroupMembersPanel(g); }
  }
});
socket.on('friendOffline', id => {
  if (friends[id]) { friends[id].online = false; updateStatus(id, false); }
  renderGroupsList();
  if (activeGroup && groups[activeGroup]) {
    const g = groups[activeGroup];
    const m = g.members.find(x => x.id === id);
    if (m) { m.online = false; renderGroupMembersPanel(g); }
  }
});
socket.on('newMessage', ({ chatWith, msg }) => {
  if (activeFriend === chatWith) { appendMsg(msg, 'messages'); scrollMsgs('messages'); }
  else { unread[chatWith] = (unread[chatWith]||0) + 1; refreshFriendItem(chatWith); }
});

// Удаление сообщения — работает и в DM, и в группах
socket.on('messageDeleted', ({ messageId }) => {
  const wrap = document.querySelector(`[data-msgid="${CSS.escape(messageId)}"]`);
  if (!wrap) return;
  const delBtn = wrap.querySelector('.msg-del-btn');
  if (delBtn) delBtn.remove();
  const bubble = wrap.querySelector('.msg');
  if (bubble) {
    bubble.classList.add('deleted-msg');
    bubble.innerHTML = '<em>Сообщение удалено</em>';
  }
  const gText = wrap.querySelector('.g-msg-text');
  if (gText) {
    wrap.classList.add('deleted');
    gText.textContent = 'Сообщение удалено';
  }
});

socket.on('rateLimited', (kind) => {
  if (kind === 'sendMessage') {
    showTransientNotice('Слишком много сообщений, подождите немного');
  }
});
socket.on('sendMessageError', ({ reason }) => {
  if (reason === 'image_too_large') showTransientNotice('Изображение слишком большое');
  else if (reason === 'text_too_long') showTransientNotice('Сообщение слишком длинное');
  else showTransientNotice('Не удалось отправить сообщение');
});

// ─── Group Socket Events ──────────────────────────────────────────────────────
socket.on('addedToGroup', ({ group }) => {
  if (!group) return;
  groups[group.id] = group;
  renderGroupsList();
  showTransientNotice(`Вас добавили в группу «${group.name}»`);
});

socket.on('newGroupMessage', ({ groupId, msg }) => {
  if (activeGroup === groupId) {
    appendGroupMsg(msg);
    scrollMsgs('group-messages');
  } else {
    groupUnread[groupId] = (groupUnread[groupId]||0) + 1;
    refreshGroupItem(groupId);
  }
});

socket.on('groupMemberJoined', ({ groupId, user }) => {
  const g = groups[groupId];
  if (!g) return;
  if (!g.members.some(m => m.id === user.id)) g.members.push(user);
  renderGroupsList();
  if (activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
    showTransientNotice(`${user.nickname} присоединился к группе`);
  }
});

socket.on('groupMemberLeft', ({ groupId, userId }) => {
  const g = groups[groupId];
  if (!g) return;
  g.members = g.members.filter(m => m.id !== userId);
  renderGroupsList();
  if (activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
  }
});

socket.on('groupDeleted', ({ groupId }) => {
  delete groups[groupId];
  delete groupUnread[groupId];
  renderGroupsList();
  if (activeGroup === groupId) {
    activeGroup = null;
    $('chat-placeholder').style.display = 'flex';
    $('group-chat-window').style.display = 'none';
  }
});

socket.on('groupError', ({ reason }) => {
  const messages = {
    not_found: 'Группа не найдена',
    not_member: 'Вы не участник группы',
    not_owner: 'Только владелец может это делать',
    limit_reached: 'Достигнут лимит участников',
    not_friends: 'Можно добавлять только друзей',
    already_member: 'Пользователь уже в группе',
    blocked: 'Невозможно добавить пользователя',
    rate_limited: 'Слишком много действий, подождите'
  };
  showTransientNotice(messages[reason] || 'Ошибка группы');
});

function showTransientNotice(text) {
  let el = $('transient-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'transient-notice';
    el.className = 'transient-notice';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.classList.remove('show'); }, 3000);
}

// ─── Render: Requests ─────────────────────────────────────────────────────────
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

// ─── Render: Friends ──────────────────────────────────────────────────────────
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
  const u = unread[id]||0;

  const el = document.createElement('div');
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
  list.appendChild(el);
}

function refreshFriendItem(id) {
  const list = $('friends-list');
  const old = list.querySelector(`[data-fid="${CSS.escape(id)}"]`);
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

// ─── Render Groups ────────────────────────────────────────────────────────────
async function loadGroups() {
  try {
    const res = await authFetch(BACKEND_URL + '/api/groups');
    if (!res.ok) return;
    const list = await res.json();
    groups = Object.create(null);
    list.forEach(g => { groups[g.id] = g; });
    renderGroupsList();
  } catch(e) {}
}

function renderGroupsList() {
  const list = $('groups-list');
  const ids = Object.keys(groups);
  if (!ids.length) { list.innerHTML = emptyGroupsHTML(); return; }
  list.innerHTML = '';
  ids.forEach(id => buildGroupEl(id));
}

function buildGroupEl(id) {
  const g = groups[id]; if (!g) return;
  const list = $('groups-list');
  const u = groupUnread[id]||0;
  const onlineCount = (g.members||[]).filter(m => m.online).length;

  const el = document.createElement('div');
  el.className = 'friend-item group-item' + (activeGroup===id?' active':'');
  el.dataset.gid = id;
  el.innerHTML = `
    <div class="f-av group-av-slot"></div>
    <div class="f-info">
      <div class="f-nick">${esc(g.name)}</div>
      <div class="f-stat">${(g.members||[]).length} уч. · ${onlineCount} онлайн</div>
    </div>
    ${u?`<div class="f-unread">${u}</div>`:''}`;

  renderGroupAv(el.querySelector('.group-av-slot'), g);
  el.onclick = () => openGroupChat(id);
  list.appendChild(el);
}

function refreshGroupItem(id) {
  const list = $('groups-list');
  const old = list.querySelector(`[data-gid="${CSS.escape(id)}"]`);
  if (old) old.remove();
  buildGroupEl(id);
}

// ─── DM Chat ──────────────────────────────────────────────────────────────────
async function openChat(id) {
  if (!me || !id) return;
  activeFriend = id;
  activeGroup = null;
  unread[id] = 0;
  document.querySelectorAll('.friend-item').forEach(el => el.classList.toggle('active', el.dataset.fid===id));
  refreshFriendItem(id);

  const f = friends[id]||{id, nickname: id, online: false};
  renderAv($('chat-avatar'), f.nickname, f.avatar);
  $('chat-nick').textContent   = f.nickname;
  $('chat-status').textContent = f.online ? '● онлайн' : 'офлайн';
  $('chat-status').className   = 'chat-head-status' + (f.online?' on':'');

  $('chat-placeholder').style.display = 'none';
  $('group-chat-window').style.display = 'none';
  $('chat-window').style.display = 'flex';

  if (window.innerWidth <= 640) {
    document.querySelector('.sidebar').classList.add('hidden');
    document.querySelector('.chat-main').classList.remove('hidden');
    $('btn-back').style.display = '';
  }

  $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Загрузка…</div>';

  const requestSeq = ++chatRequestSeq;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(me.id)}/${encodeURIComponent(id)}`);
    if (requestSeq !== chatRequestSeq) return;
    if (!res.ok) throw new Error();
    const history = await res.json();
    if (requestSeq !== chatRequestSeq) return;
    $('messages').innerHTML = '';
    if (!history || !history.length) {
      $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Напишите первым! 👋</div>';
    } else {
      history.forEach(m => appendMsg(m, 'messages'));
    }
    scrollMsgs('messages');
  } catch(e) {
    if (requestSeq !== chatRequestSeq) return;
    $('messages').innerHTML = '<div style="text-align:center;color:var(--red);padding:24px;font-size:13px">Ошибка загрузки</div>';
  }
  socket.emit('markRead', id);
  $('msg-input').focus();
}

function appendMsg(msg, containerId, doScroll=true) {
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

  $(containerId).appendChild(wrap);
  if (doScroll) scrollMsgs(containerId);
}

function scrollMsgs(containerId) {
  const m = $(containerId);
  if (m) m.scrollTop = m.scrollHeight;
}

// ─── Group Chat ───────────────────────────────────────────────────────────────
async function openGroupChat(groupId) {
  if (!me || !groupId || !groups[groupId]) return;
  activeGroup = groupId;
  activeFriend = null;
  groupUnread[groupId] = 0;

  document.querySelectorAll('.friend-item').forEach(el => el.classList.remove('active'));
  refreshGroupItem(groupId);

  const g = groups[groupId];
  updateGroupChatHeader(g);
  renderGroupMembersPanel(g);
  $('group-msg-input').placeholder = 'Написать в ' + g.name;

  $('chat-placeholder').style.display = 'none';
  $('chat-window').style.display = 'none';
  $('group-chat-window').style.display = 'flex';

  if (window.innerWidth <= 640) {
    document.querySelector('.sidebar').classList.add('hidden');
    document.querySelector('.chat-main').classList.remove('hidden');
    $('btn-back-group').style.display = '';
  }

  $('group-messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Загрузка…</div>';

  const requestSeq = ++groupChatRequestSeq;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/groups/${encodeURIComponent(groupId)}/messages`);
    if (requestSeq !== groupChatRequestSeq) return;
    if (!res.ok) throw new Error();
    const history = await res.json();
    if (requestSeq !== groupChatRequestSeq) return;
    $('group-messages').innerHTML = '';
    if (!history || !history.length) {
      $('group-messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Начните общение в группе! 👋</div>';
    } else {
      history.forEach(m => appendGroupMsg(m, false));
    }
    scrollMsgs('group-messages');
  } catch(e) {
    if (requestSeq !== groupChatRequestSeq) return;
    $('group-messages').innerHTML = '<div style="text-align:center;color:var(--red);padding:24px;font-size:13px">Ошибка загрузки</div>';
  }
  socket.emit('markGroupRead', groupId);
  $('group-msg-input').focus();
}

function updateGroupChatHeader(g) {
  renderGroupAv($('group-chat-avatar'), g);
  $('group-chat-name').textContent = g.name;
  const membersCount = (g.members||[]).length;
  const onlineCount = (g.members||[]).filter(m => m.online).length;
  $('group-chat-members-count').textContent = `${membersCount} участников · ${onlineCount} онлайн`;
}

// Discord-style сообщение в группе: аватар + ник (+коронка) + время + текст
function appendGroupMsg(msg, doScroll=true) {
  if (!me) return;
  const g = groups[activeGroup];
  const isMine = msg.from === me.id;
  const isDeleted = msg.deleted;
  const msgId = msg._id || msg.id || '';

  const sender = g?.members?.find(m => m.id === msg.from);
  const senderNick = sender?.nickname || msg.from;
  const isOwner = g?.ownerId === msg.from;

  const wrap = document.createElement('div');
  wrap.className = 'g-msg' + (isMine ? ' mine' : '') + (isDeleted ? ' deleted' : '');
  if (msgId) wrap.dataset.msgid = msgId;

  const avEl = document.createElement('div');
  avEl.className = 'g-msg-av';
  renderAv(avEl, senderNick, sender?.avatar || null);
  if (!isMine) avEl.style.cursor = 'pointer';
  if (!isMine) avEl.addEventListener('click', () => showUserProfile(msg.from));
  wrap.appendChild(avEl);

  const body = document.createElement('div');
  body.className = 'g-msg-body';

  const head = document.createElement('div');
  head.className = 'g-msg-head';
  head.innerHTML = `
    <span class="g-msg-nick">${esc(senderNick)}</span>
    ${isOwner ? CROWN_SVG : ''}
    <span class="g-msg-time">${fmtTime(msg.time || msg.createdAt)}</span>`;
  body.appendChild(head);

  const text = document.createElement('div');
  text.className = 'g-msg-text';
  text.textContent = isDeleted ? 'Сообщение удалено' : (msg.text || '');
  body.appendChild(text);

  wrap.appendChild(body);

  if (isMine && !isDeleted && msgId) {
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-del-btn';
    delBtn.title = 'Удалить';
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>`;
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteConfirm(msgId); });
    wrap.appendChild(delBtn);
  }

  $('group-messages').appendChild(wrap);
  if (doScroll) scrollMsgs('group-messages');
}

// Клик по шапке группы → инфо
$('group-chat-head-click').addEventListener('click', () => {
  if (activeGroup) openGroupInfoModal(activeGroup);
});
$('btn-group-info').addEventListener('click', () => {
  if (activeGroup) openGroupInfoModal(activeGroup);
});

// ─── Send DM message ──────────────────────────────────────────────────────────
$('btn-send').onclick = sendMsg;
$('msg-input').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } });

function sendMsg() {
  const text = $('msg-input').value.trim();
  if (!text || !activeFriend) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    return;
  }
  socket.emit('sendMessage', { toId: activeFriend, text });
  $('msg-input').value = '';
  $('msg-input').focus();
}

// ─── Send Group message ───────────────────────────────────────────────────────
$('btn-group-send').onclick = sendGroupMsg;
$('group-msg-input').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendGroupMsg(); } });

function sendGroupMsg() {
  const text = $('group-msg-input').value.trim();
  if (!text || !activeGroup) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    return;
  }
  socket.emit('groupMessage', { groupId: activeGroup, text });
  $('group-msg-input').value = '';
  $('group-msg-input').focus();
}

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
  const idToDelete = pendingDeleteId;
  closeDeleteConfirm();
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(idToDelete)}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error || 'Ошибка удаления');
    }
  } catch(e) {
    alert('Ошибка сети');
  }
});

// ─── Profile: view other user ─────────────────────────────────────────────────
$('chat-head-click').addEventListener('click', () => {
  if (activeFriend) showUserProfile(activeFriend);
});

async function showUserProfile(userId) {
  const requestSeq = ++profileRequestSeq;
  try {
    const res = await authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(userId));
    if (requestSeq !== profileRequestSeq) return;
    if (!res.ok) return;
    const u = await res.json();
    if (requestSeq !== profileRequestSeq) return;

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
    addBtn.textContent = 'Добавить в друзья';
    addBtn.disabled = false;
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
      const isBlocked = !!me?.blockedUsers?.includes(userId);
      blockBtn.style.display = isMe ? 'none' : '';
      blockBtn.disabled = false;
      blockBtn.className = 'btn-secondary' + (isBlocked ? '' : ' btn-danger-outline');
      blockBtn.textContent = isBlocked ? 'Разблокировать' : 'Заблокировать';
      blockBtn.onclick = () => isBlocked ? performUnblock(userId) : performBlock(userId);
    }

    $('profile-modal').style.display = 'flex';
  } catch(e) {}
}

async function performUnblock(userId) {
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/unblock`, { method: 'POST' });
    if (!res.ok) return alert('Ошибка разблокировки');
    if (me.blockedUsers) me.blockedUsers = me.blockedUsers.filter(id => id !== userId);
    showUserProfile(userId);
  } catch (e) { alert('Ошибка сети'); }
}

async function performBlock(userId) {
  if (!confirm(`Заблокировать @${userId}?`)) return;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return alert(d.error || 'Ошибка блокировки');
    }
    if (!me.blockedUsers) me.blockedUsers = [];
    if (!me.blockedUsers.includes(userId)) me.blockedUsers = [...me.blockedUsers, userId];
    if (me.friends) me.friends = me.friends.filter(id => id !== userId);
    delete friends[userId];
    delete unread[userId];
    renderFriendsList();
    if (activeFriend === userId) {
      activeFriend = null;
      $('chat-placeholder').style.display = 'flex';
      $('chat-window').style.display = 'none';
    }
    showUserProfile(userId);
  } catch (e) { alert('Ошибка сети'); }
}

function closeProfileModal() { $('profile-modal').style.display = 'none'; }
window.closeProfileModal = closeProfileModal;

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

$('avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !me) return;
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    alert('Разрешены только изображения (jpeg, png, webp, gif)');
    e.target.value = ''; return;
  }
  if (file.size > MAX_AVATAR_SIZE) {
    alert('Файл слишком большой (максимум 5MB)');
    e.target.value = ''; return;
  }
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const res = await authFetch(BACKEND_URL + '/api/upload/avatar', { method: 'POST', body: formData });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return alert(d.error || 'Ошибка загрузки аватара');
    }
    const data = await res.json();
    me.avatar = data.avatar;
    localStorage.setItem('chatapp_profile', JSON.stringify(me));
    renderAv($('edit-avatar'), me.nickname, me.avatar);
    renderAv($('my-avatar'), me.nickname, me.avatar);
  } catch(e) { alert('Ошибка сети'); }
  e.target.value = '';
});

$('btn-save-profile').addEventListener('click', async () => {
  if (!me) return;
  const nickname = $('edit-nick').value.trim();
  const status   = $('edit-status').value.trim();
  const bio      = $('edit-bio').value.trim();

  const btn = $('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Сохранение…';
  try {
    const res = await authFetch(BACKEND_URL + '/api/profile/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, status, bio })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Ошибка сохранения');
    me.nickname = data.user.nickname;
    me.status   = data.user.status;
    me.bio      = data.user.bio;
    localStorage.setItem('chatapp_profile', JSON.stringify(me));
    $('my-nick').textContent = me.nickname;
    renderAv($('my-avatar'), me.nickname, me.avatar);
    closeEditProfileModal();
  } catch(e) { alert('Ошибка сети'); }
  finally { btn.disabled = false; btn.textContent = 'Сохранить'; }
});

// ─── Blocked users ────────────────────────────────────────────────────────────
$('btn-open-blocked')?.addEventListener('click', () => {
  closeEditProfileModal();
  openBlockedUsersModal();
});

async function openBlockedUsersModal() {
  $('blocked-users-modal').style.display = 'flex';
  const list = $('blocked-users-list');
  list.innerHTML = '<div class="blocked-users-empty">Загрузка…</div>';
  try {
    const res = await authFetch(BACKEND_URL + '/api/users/blocked');
    if (!res.ok) throw new Error();
    const users = await res.json();
    me.blockedUsers = users.map(u => u.id);
    renderBlockedUsersList(users);
  } catch (e) {
    list.innerHTML = '<div class="blocked-users-empty" style="color:var(--red)">Ошибка загрузки</div>';
  }
}
function closeBlockedUsersModal() { $('blocked-users-modal').style.display = 'none'; }
window.closeBlockedUsersModal = closeBlockedUsersModal;

$('blocked-users-modal').addEventListener('click', e => {
  if (e.target === $('blocked-users-modal')) closeBlockedUsersModal();
});

function renderBlockedUsersList(users) {
  const list = $('blocked-users-list');
  list.innerHTML = '';
  if (!users || !users.length) {
    list.innerHTML = '<div class="blocked-users-empty">Нет заблокированных пользователей</div>';
    return;
  }
  users.forEach(u => {
    const el = document.createElement('div');
    el.className = 'blocked-user-item';
    el.dataset.uid = u.id;
    el.innerHTML = `
      <div class="f-av"></div>
      <div class="f-info">
        <div class="blocked-user-nick">${esc(u.nickname)}</div>
        <div class="blocked-user-id">@${esc(u.id)}</div>
      </div>
      <button class="btn-unblock">Разблокировать</button>`;
    renderAv(el.querySelector('.f-av'), u.nickname, u.avatar);
    el.querySelector('.btn-unblock').addEventListener('click', async () => {
      try {
        const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(u.id)}/unblock`, { method: 'POST' });
        if (!res.ok) return alert('Ошибка разблокировки');
        if (me.blockedUsers) me.blockedUsers = me.blockedUsers.filter(id => id !== u.id);
        el.remove();
        if (!list.children.length) {
          list.innerHTML = '<div class="blocked-users-empty">Нет заблокированных пользователей</div>';
        }
      } catch (e) { alert('Ошибка сети'); }
    });
    list.appendChild(el);
  });
}

// ─── Create Group Modal ───────────────────────────────────────────────────────
let selectedGroupMembers = new Set();

$('btn-create-group').addEventListener('click', () => {
  if (!me) return;
  selectedGroupMembers = new Set();
  $('group-name-input').value = '';
  $('group-selected-count').textContent = 'выбрано: 0';
  renderGroupFriendsPicker();
  $('create-group-modal').style.display = 'flex';
});

function closeCreateGroupModal() { $('create-group-modal').style.display = 'none'; }
window.closeCreateGroupModal = closeCreateGroupModal;

$('create-group-modal').addEventListener('click', e => {
  if (e.target === $('create-group-modal')) closeCreateGroupModal();
});

function renderGroupFriendsPicker() {
  const picker = $('group-friends-picker');
  const ids = Object.keys(friends);
  if (!ids.length) {
    picker.innerHTML = '<div class="empty-state" style="padding:16px"><div class="empty-sub">Сначала добавь друзей</div></div>';
    return;
  }
  picker.innerHTML = '';
  ids.forEach(id => {
    const f = friends[id];
    const el = document.createElement('div');
    el.className = 'picker-item' + (selectedGroupMembers.has(id) ? ' selected' : '');
    el.innerHTML = `
      <div class="f-av" style="width:32px;height:32px;font-size:12px"></div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:13px">${esc(f.nickname)}</div>
        <div class="f-stat" style="font-size:11px">@${esc(id)}</div>
      </div>
      <div class="picker-check">${selectedGroupMembers.has(id) ? '✓' : ''}</div>`;
    renderAv(el.querySelector('.f-av'), f.nickname, f.avatar);
    el.addEventListener('click', () => {
      if (selectedGroupMembers.has(id)) selectedGroupMembers.delete(id);
      else selectedGroupMembers.add(id);
      $('group-selected-count').textContent = 'выбрано: ' + selectedGroupMembers.size;
      renderGroupFriendsPicker();
    });
    picker.appendChild(el);
  });
}

$('btn-confirm-create-group').addEventListener('click', async () => {
  const name = $('group-name-input').value.trim();
  if (!name || name.length < 2) return showTransientNotice('Название минимум 2 символа');
  if (selectedGroupMembers.size < 1) return showTransientNotice('Выберите хотя бы одного друга');

  const btn = $('btn-confirm-create-group');
  btn.disabled = true; btn.textContent = 'Создание…';
  try {
    const res = await authFetch(BACKEND_URL + '/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, memberIds: [...selectedGroupMembers] })
    });
    const data = await res.json();
    if (!res.ok) return showTransientNotice(data.error || 'Ошибка создания группы');
    closeCreateGroupModal();
    await loadGroups();
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('[data-stab="groups"]').classList.add('active');
    $('dm-panel').style.display = 'none';
    $('groups-panel').style.display = '';
    if (data.group) openGroupChat(data.group.id);
  } catch(e) {
    showTransientNotice('Ошибка сети');
  } finally {
    btn.disabled = false; btn.textContent = 'Создать группу';
  }
});

// ─── Group Info Modal ─────────────────────────────────────────────────────────
function openGroupInfoModal(groupId) {
  const g = groups[groupId];
  if (!g) return;

  renderGroupAv($('group-info-avatar'), g);
  $('group-info-name').textContent = g.name;
  $('group-info-created').textContent = 'Создана ' + fmtDate(g.createdAt || Date.now());
  $('group-info-count').textContent = (g.members||[]).length;

  const isOwner = g.ownerId === me?.id;
  $('group-info-owner-actions').style.display = isOwner ? '' : 'none';

  renderGroupInfoMembers(g);
  $('group-info-modal').style.display = 'flex';
}

function renderGroupInfoMembers(g) {
  const list = $('group-info-members');
  list.innerHTML = '';
  (g.members||[]).forEach(m => {
    const el = document.createElement('div');
    el.className = 'group-member-item';
    el.innerHTML = `
      <div class="f-av" style="width:32px;height:32px;font-size:12px">${m.online?'<div class="f-dot"></div>':''}</div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:13px">${esc(m.nickname)} ${m.role==='owner'?'<span class="owner-badge">👑</span>':''}</div>
        <div class="f-stat" style="font-size:11px">@${esc(m.id)}</div>
      </div>
      ${m.id !== me?.id && g.ownerId === me?.id ? '<button class="btn-kick" title="Удалить из группы">✕</button>' : ''}`;
    renderAv(el.querySelector('.f-av'), m.nickname, m.avatar);
    el.querySelector('.f-av').style.position = 'relative';
    const kickBtn = el.querySelector('.btn-kick');
    if (kickBtn) {
      kickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Удалить ${m.nickname} из группы?`)) {
          socket.emit('kickGroupMember', { groupId: g.id, userId: m.id });
        }
      });
    }
    if (m.id !== me?.id) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        closeGroupInfoModal();
        showUserProfile(m.id);
      });
    }
    list.appendChild(el);
  });
}

function closeGroupInfoModal() { $('group-info-modal').style.display = 'none'; }
window.closeGroupInfoModal = closeGroupInfoModal;

$('group-info-modal').addEventListener('click', e => {
  if (e.target === $('group-info-modal')) closeGroupInfoModal();
});

$('btn-leave-group').addEventListener('click', () => {
  if (!activeGroup) return;
  const g = groups[activeGroup];
  const isOwner = g?.ownerId === me?.id;
  const msg = isOwner
    ? 'Вы владелец группы. Группа будет УДАЛЁНА для всех. Продолжить?'
    : 'Покинуть группу?';
  if (!confirm(msg)) return;
  socket.emit('leaveGroup', activeGroup);
  closeGroupInfoModal();
});

// ─── Add Members Modal ────────────────────────────────────────────────────────
let selectedAddMembers = new Set();

$('btn-add-members').addEventListener('click', () => {
  if (!activeGroup || !groups[activeGroup]) return;
  selectedAddMembers = new Set();
  $('add-members-count').textContent = 'выбрано: 0';
  renderAddMembersPicker();
  closeGroupInfoModal();
  $('add-members-modal').style.display = 'flex';
});

function closeAddMembersModal() { $('add-members-modal').style.display = 'none'; }
window.closeAddMembersModal = closeAddMembersModal;

$('add-members-modal').addEventListener('click', e => {
  if (e.target === $('add-members-modal')) closeAddMembersModal();
});

function renderAddMembersPicker() {
  const picker = $('add-members-picker');
  const g = groups[activeGroup];
  if (!g) return;
  const memberIds = new Set((g.members||[]).map(m => m.id));
  const candidates = Object.keys(friends).filter(id => !memberIds.has(id));

  if (!candidates.length) {
    picker.innerHTML = '<div class="empty-state" style="padding:16px"><div class="empty-sub">Все друзья уже в группе</div></div>';
    return;
  }
  picker.innerHTML = '';
  candidates.forEach(id => {
    const f = friends[id];
    const el = document.createElement('div');
    el.className = 'picker-item' + (selectedAddMembers.has(id) ? ' selected' : '');
    el.innerHTML = `
      <div class="f-av" style="width:32px;height:32px;font-size:12px"></div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:13px">${esc(f.nickname)}</div>
        <div class="f-stat" style="font-size:11px">@${esc(id)}</div>
      </div>
      <div class="picker-check">${selectedAddMembers.has(id) ? '✓' : ''}</div>`;
    renderAv(el.querySelector('.f-av'), f.nickname, f.avatar);
    el.addEventListener('click', () => {
      if (selectedAddMembers.has(id)) selectedAddMembers.delete(id);
      else selectedAddMembers.add(id);
      $('add-members-count').textContent = 'выбрано: ' + selectedAddMembers.size;
      renderAddMembersPicker();
    });
    picker.appendChild(el);
  });
}

$('btn-confirm-add-members').addEventListener('click', () => {
  if (!activeGroup || !selectedAddMembers.size) return;
  selectedAddMembers.forEach(userId => {
    socket.emit('addGroupMember', { groupId: activeGroup, userId });
  });
  closeAddMembersModal();
  showTransientNotice('Приглашения отправлены');
});

// ─── Panel участников (правая колонка Discord-style) ──────────────────────────
function renderGroupMembersPanel(g) {
  if (!g) return;
  const countEl = $('gm-count');
  const list = $('group-members-list');
  if (!countEl || !list) return;

  countEl.textContent = (g.members||[]).length;
  list.innerHTML = '';

  // Владелец сверху, потом онлайн, потом оффлайн, по алфавиту
  const sorted = [...(g.members||[])].sort((a,b) => {
    if (a.role === 'owner') return -1;
    if (b.role === 'owner') return 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.nickname||'').localeCompare(b.nickname||'');
  });

  sorted.forEach(m => {
    const el = document.createElement('div');
    el.className = 'gm-item' + (m.online ? '' : ' offline');
    el.innerHTML = `
      <div class="gm-av"></div>
      <div class="gm-name">${esc(m.nickname)}</div>
      ${m.role === 'owner' ? CROWN_SVG : ''}`;
    const avEl = el.querySelector('.gm-av');
    renderAv(avEl, m.nickname, m.avatar);
    if (m.online) {
      const dot = document.createElement('div');
      dot.className = 'f-dot';
      avEl.appendChild(dot);
    }
    if (m.id !== me?.id) el.addEventListener('click', () => showUserProfile(m.id));
    list.appendChild(el);
  });

  // Кнопка "Добавить участников" — только у владельца
  const inviteBtn = $('btn-invite-group');
  if (inviteBtn) inviteBtn.style.display = (g.ownerId === me?.id) ? '' : 'none';
}

// Кнопка свернуть/показать панель участников
$('btn-toggle-members').addEventListener('click', () => {
  $('group-members-panel').classList.toggle('hidden');
});

// Кнопка "Добавить участников" в панели
$('btn-invite-group').addEventListener('click', () => {
  if (!activeGroup || !groups[activeGroup]) return;
  selectedAddMembers = new Set();
  $('add-members-count').textContent = 'выбрано: 0';
  renderAddMembersPicker();
  $('add-members-modal').style.display = 'flex';
});

// ─── Mobile back buttons ──────────────────────────────────────────────────────
$('btn-back')?.addEventListener('click', goBackMobile);
$('btn-back-group')?.addEventListener('click', goBackMobile);

function goBackMobile() {
  activeFriend = null;
  activeGroup = null;
  document.querySelector('.sidebar').classList.remove('hidden');
  document.querySelector('.chat-main').classList.add('hidden');
  document.querySelectorAll('.friend-item').forEach(el => el.classList.remove('active'));
  $('chat-window').style.display = 'none';
  $('group-chat-window').style.display = 'none';
  $('chat-placeholder').style.display = 'flex';
}

window.addEventListener('resize', () => {
  if (window.innerWidth > 640) {
    document.querySelector('.sidebar')?.classList.remove('hidden');
    document.querySelector('.chat-main')?.classList.remove('hidden');
  }
});

// ─── Auto-login ───────────────────────────────────────────────────────────────
(() => {
  const token = localStorage.getItem('chatapp_token');
  const cached = localStorage.getItem('chatapp_profile');
  if (token && cached) {
    try {
      me = JSON.parse(cached);
      enterApp(me);
    } catch (e) {
      localStorage.removeItem('chatapp_profile');
      document.documentElement.classList.remove('has-session');
    }
  } else {
    document.documentElement.classList.remove('has-session');
  }
})();

// ─── Socket error handling ────────────────────────────────────────────────────
socket.on('connect_error', err => {
  console.error('Socket error:', err);
  if (err.message === 'Unauthorized') {
    forceLogoutToLogin('Сессия истекла, войдите снова');
  } else {
    showTransientNotice('Нет соединения с сервером');
  }
});
socket.on('disconnect', reason => {
  console.warn('Socket disconnected:', reason);
  if (reason !== 'io client disconnect') {
    showTransientNotice('Соединение потеряно, переподключение…');
  }
});