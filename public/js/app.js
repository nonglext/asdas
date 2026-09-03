'use strict';

/* ============================================================================
 * CONFIG
 * ==========================================================================*/
const BACKEND_URL = "https://asdas-p7ht.onrender.com";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Keep browser audio processing disabled so the microphone stream stays raw.
const RAW_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
};

// Иконка коронки для владельца группы
const CROWN_SVG = '<svg class="gm-crown" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" title="Владелец группы"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>';

const $ = id => document.getElementById(id);

/* ============================================================================
 * STATE
 * All mutable app state lives here instead of scattered top-level `let`s.
 * ==========================================================================*/
const state = {
  me: null,
  activeFriend: null,
  activeGroup: null,
  friends: Object.create(null),
  groups: Object.create(null),
  unread: Object.create(null),
  groupUnread: Object.create(null),
  pendingDeleteId: null,
  // Monotonic sequence counters guard against out-of-order async responses
  // (e.g. user clicks friend A then B before A's history request resolves).
  seq: { chat: 0, groupChat: 0, profile: 0 },
};

function resetState() {
  state.me = null;
  state.activeFriend = null;
  state.activeGroup = null;
  state.friends = Object.create(null);
  state.groups = Object.create(null);
  state.unread = Object.create(null);
  state.groupUnread = Object.create(null);
  state.pendingDeleteId = null;
}

/* ============================================================================
 * SOCKET.IO
 * ==========================================================================*/
const socket = io(BACKEND_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
});

function connectSocket() {
  const token = localStorage.getItem('chatapp_token');
  if (!token) return;
  socket.auth = { token };
  if (socket.connected) socket.disconnect();
  socket.connect();
}

/* ============================================================================
 * GENERIC HELPERS
 * ==========================================================================*/
function av(nick) {
  return nick ? String(nick).trim().charAt(0).toUpperCase() || '?' : '?';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}

function setErr(msg) {
  const el = $('auth-error');
  if (el) el.textContent = msg || '';
}

function scrollMsgs(containerId) {
  const m = $(containerId);
  if (m) m.scrollTop = m.scrollHeight;
}

function closeAllModals() {
  [
    'profile-modal', 'edit-profile-modal', 'blocked-users-modal', 'delete-confirm',
    'create-group-modal', 'group-info-modal', 'add-members-modal',
  ].forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });
  state.pendingDeleteId = null;
}

let noticeTimer = null;
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
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ============================================================================
 * AUTH / SESSION
 * ==========================================================================*/
function forceLogoutToLogin(message) {
  resetState();
  if (socket.connected) socket.disconnect();
  localStorage.removeItem('chatapp_id');
  localStorage.removeItem('chatapp_pw');
  localStorage.removeItem('chatapp_token');
  localStorage.removeItem('chatapp_profile');
  document.documentElement.classList.remove('has-session');
  closeAllModals();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const authScreen = $('auth-screen');
  if (authScreen) authScreen.classList.add('active');
  if (message) setErr(message);

  // Reset lists that would otherwise show stale data if the user logs back in
  const fl = $('friends-list');
  if (fl) fl.innerHTML = emptyFriendsHTML();
  const rl = $('requests-list');
  if (rl) rl.innerHTML = '';
  const rs = $('requests-section');
  if (rs) rs.style.display = 'none';
  const gl = $('groups-list');
  if (gl) gl.innerHTML = emptyGroupsHTML();
  closeActiveChat();
}

/**
 * A thin wrapper around fetch() that attaches the bearer token and handles
 * session expiry consistently. IMPORTANT: unlike the previous version, this
 * throws on 401 instead of silently returning the (unusable) response, so
 * callers can't accidentally keep processing data for a logged-out session.
 */
class AuthError extends Error {}

async function authFetch(url, options = {}) {
  const token = localStorage.getItem('chatapp_token');
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    });
  } catch (networkErr) {
    throw networkErr;
  }
  if (res.status === 401 && state.me) {
    forceLogoutToLogin('Сессия истекла, войдите снова');
    throw new AuthError('Session expired');
  }
  return res;
}

function saveAndLogin(user, userId, token) {
  state.me = user;
  localStorage.setItem('chatapp_id', userId);
  // Never persist plaintext passwords client-side.
  localStorage.removeItem('chatapp_pw');
  if (token) localStorage.setItem('chatapp_token', token);
  localStorage.setItem('chatapp_profile', JSON.stringify(user));
  enterApp(user);
}

function enterApp(user) {
  renderAv($('my-avatar'), user.nickname, user.avatar);
  $('my-nick').textContent = user.nickname;
  $('my-id').textContent = '@' + user.id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('app-screen').classList.add('active');
  document.documentElement.classList.add('has-session');
  connectSocket();
  loadGroups();
}

/* ============================================================================
 * AVATAR RENDERING
 * ==========================================================================*/
function renderAv(el, nickname, avatarUrl) {
  if (!el) return;
  el.textContent = '';
  if (avatarUrl) {
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
      img.src = m.avatar;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => { cell.textContent = av(m.nickname); };
      cell.appendChild(img);
    } else {
      cell.textContent = av(m.nickname);
    }
    grid.appendChild(cell);
  });
  el.appendChild(grid);
}

/** Single source of truth for "is this member the group owner". Previously
 * some call sites checked `g.ownerId === userId` and others checked
 * `member.role === 'owner'`, which could disagree if the backend payload
 * was ever inconsistent. Now everything funnels through here. */
function isGroupOwner(group, userId) {
  if (!group || !userId) return false;
  if (group.ownerId) return group.ownerId === userId;
  const member = (group.members || []).find(m => m.id === userId);
  return member ? member.role === 'owner' : false;
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

/* ============================================================================
 * UI WIRING: password toggle / tabs
 * ==========================================================================*/
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    const svg = btn.querySelector('svg');
    if (svg) svg.style.opacity = input.type === 'text' ? '0.5' : '1';
  });
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = $('tab-' + tab.dataset.tab);
    if (target) target.classList.add('active');
    setErr('');
  });
});

document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isGroups = tab.dataset.stab === 'groups';
    $('dm-panel').style.display = isGroups ? 'none' : '';
    $('groups-panel').style.display = isGroups ? '' : 'none';
  });
});

/* ============================================================================
 * REGISTER / LOGIN
 * ==========================================================================*/
async function withButtonBusy(btn, busyText, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

$('btn-register').addEventListener('click', async () => {
  setErr('');
  const userId = $('reg-id').value.trim();
  const nickname = $('reg-nick').value.trim();
  const password = $('reg-pw').value;

  if (!userId || userId.length < 3) return setErr('ID минимум 3 символа');
  if (!/^[a-z0-9_]+$/.test(userId)) return setErr('ID: только a-z, 0-9, _');
  if (!nickname) return setErr('Введите никнейм');
  if (!password || password.length < 8) return setErr('Пароль минимум 8 символов');

  await withButtonBusy($('btn-register'), 'Загрузка…', async () => {
    try {
      const res = await fetch(BACKEND_URL + '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, nickname, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(data.error || 'Ошибка регистрации');
      saveAndLogin(data.user, userId, data.token);
    } catch (e) {
      setErr('Ошибка сети');
    }
  });
});

$('btn-login').addEventListener('click', async () => {
  setErr('');
  const userId = $('login-id').value.trim();
  const password = $('login-pw').value;
  if (!userId || !password) return setErr('Введите ID и пароль');

  await withButtonBusy($('btn-login'), 'Загрузка…', async () => {
    try {
      const res = await fetch(BACKEND_URL + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(data.error || 'Ошибка входа');
      saveAndLogin(data.user, userId, data.token);
    } catch (e) {
      setErr('Ошибка сети');
    }
  });
});

['login-id', 'login-pw'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); })
);
['reg-id', 'reg-nick', 'reg-pw'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-register').click(); })
);

$('btn-logout').addEventListener('click', () => {
  forceLogoutToLogin();
});

function closeActiveChat() {
  state.activeFriend = null;
  state.activeGroup = null;
  const ph = $('chat-placeholder');
  if (ph) ph.style.display = '';
  const cw = $('chat-window');
  if (cw) cw.style.display = 'none';
  const gcw = $('group-chat-window');
  if (gcw) gcw.style.display = 'none';
}

/* ============================================================================
 * ME CARD → EDIT PROFILE
 * ==========================================================================*/
$('me-card').addEventListener('click', e => {
  if (e.target.closest('#btn-logout')) return;
  if (state.me) openEditProfileModal();
});

/* ============================================================================
 * SEARCH
 * ==========================================================================*/
let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) { closeDrop(); return; }
  searchTimer = setTimeout(() => doSearch(q), 280);
});
$('search-input').addEventListener('blur', () => setTimeout(closeDrop, 200));

async function doSearch(q) {
  const drop = $('search-results');
  try {
    const res = await authFetch(BACKEND_URL + '/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('search failed');
    const list = await res.json();
    drop.innerHTML = '';

    if (!list || !list.length) {
      drop.innerHTML = '<div class="s-item" style="color:var(--text3);font-size:13px">Никого не найдено</div>';
      drop.classList.add('open');
      return;
    }

    list.forEach(u => {
      if (u.id === state.me?.id) return;
      const isFriend = state.me?.friends?.includes(u.id);
      const el = document.createElement('div');
      el.className = 's-item';
      el.innerHTML = `
        <div class="s-mini-av"></div>
        <div style="flex:1;min-width:0">
          <div class="s-nick">${esc(u.nickname)}</div>
          <div class="s-id">@${esc(u.id)}</div>
        </div>
        <button class="btn-add" ${isFriend ? 'disabled' : ''}>${isFriend ? '✓ Друг' : '+ Добавить'}</button>`;
      renderAv(el.querySelector('.s-mini-av'), u.nickname, u.avatar);

      el.querySelector('.btn-add').addEventListener('click', e => {
        e.stopPropagation();
        if (!isFriend) {
          socket.emit('sendFriendRequest', u.id);
          const btn = el.querySelector('.btn-add');
          btn.textContent = 'Отправлено';
          btn.disabled = true;
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
  } catch (e) {
    if (e instanceof AuthError) return;
    drop.innerHTML = '<div class="s-item" style="color:var(--red);font-size:13px">Ошибка поиска</div>';
    drop.classList.add('open');
  }
}

function closeDrop() {
  $('search-results').classList.remove('open');
  $('search-input').value = '';
}

/* ============================================================================
 * SOCKET EVENTS: profile / friends
 * ==========================================================================*/
socket.on('profile', profile => {
  state.me = { ...state.me, ...profile };
  localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
  state.unread = Object.assign(Object.create(null), profile.unreadCounts || {});
  state.groupUnread = Object.assign(Object.create(null), profile.groupUnreadCounts || {});
  renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
  $('my-nick').textContent = state.me.nickname;

  (profile.friends || []).forEach(fId => {
    if (!state.friends[fId]) state.friends[fId] = { id: fId, nickname: fId, online: false };
  });

  renderRequests(profile.friendRequests || []);
  renderFriendsList();
  fetchNicknames(profile.friends || []);
  loadGroups();
  if (state.activeFriend) openChat(state.activeFriend);
  if (state.activeGroup) openGroupChat(state.activeGroup);
});

async function fetchNicknames(ids) {
  const results = await Promise.allSettled(
    ids.map(id =>
      authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(id)).then(async res => {
        if (!res.ok) throw new Error('not ok');
        return { id, data: await res.json() };
      })
    )
  );
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      const { id, data: u } = r.value;
      state.friends[id] = { id, nickname: u.nickname, avatar: u.avatar, online: u.online };
    }
  });
  renderFriendsList();
}

socket.on('friendRequest', req => {
  if (!state.me) return;
  if (!state.me.friendRequests) state.me.friendRequests = [];
  const already = state.me.friendRequests.some(r => (r.id || r) === req.id);
  if (!already) {
    state.me.friendRequests.push({ id: req.id, nickname: req.nickname });
    renderRequests(state.me.friendRequests);
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
    server_error: 'Ошибка сервера',
  };
  showTransientNotice(messages[reason] || 'Не удалось отправить заявку');
});

socket.on('requestDeclined', fromId => {
  if (state.me?.friendRequests) {
    state.me.friendRequests = state.me.friendRequests.filter(r => (r.id || r) !== fromId);
    renderRequests(state.me.friendRequests);
  }
});

socket.on('friendAdded', user => {
  state.friends[user.id] = { id: user.id, nickname: user.nickname, avatar: user.avatar, online: user.online };
  if (!state.me.friends) state.me.friends = [];
  if (!state.me.friends.includes(user.id)) state.me.friends.push(user.id);
  if (state.me.friendRequests) {
    state.me.friendRequests = state.me.friendRequests.filter(r => (r.id || r) !== user.id);
    renderRequests(state.me.friendRequests);
  }
  renderFriendsList();
});

socket.on('friendRemoved', ({ id }) => {
  if (state.me?.friends) state.me.friends = state.me.friends.filter(fid => fid !== id);
  delete state.friends[id];
  delete state.unread[id];
  renderFriendsList();
  if (state.activeFriend === id) {
    state.activeFriend = null;
    $('chat-placeholder').style.display = 'flex';
    $('chat-window').style.display = 'none';
  }
});

socket.on('friendOnline', u => {
  if (state.friends[u.id]) {
    state.friends[u.id].online = true;
    updateStatus(u.id, true);
  }
  renderGroupsList();
  syncGroupMemberPresence(u.id, true);
});

socket.on('friendOffline', id => {
  if (state.friends[id]) {
    state.friends[id].online = false;
    updateStatus(id, false);
  }
  renderGroupsList();
  syncGroupMemberPresence(id, false);
});

function syncGroupMemberPresence(userId, online) {
  if (!state.activeGroup) return;
  const g = state.groups[state.activeGroup];
  if (!g) return;
  const m = (g.members || []).find(x => x.id === userId);
  if (m) {
    m.online = online;
    renderGroupMembersPanel(g);
  }
}

socket.on('newMessage', ({ chatWith, msg }) => {
  if (state.activeFriend === chatWith) {
    appendMsg(msg, 'messages');
    scrollMsgs('messages');
  } else {
    state.unread[chatWith] = (state.unread[chatWith] || 0) + 1;
    refreshFriendItem(chatWith);
  }
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

socket.on('rateLimited', kind => {
  if (kind === 'sendMessage') {
    showTransientNotice('Слишком много сообщений, подождите немного');
  }
});

socket.on('sendMessageError', ({ reason }) => {
  if (reason === 'image_too_large') showTransientNotice('Изображение слишком большое');
  else if (reason === 'text_too_long') showTransientNotice('Сообщение слишком длинное');
  else showTransientNotice('Не удалось отправить сообщение');
});

/* ============================================================================
 * SOCKET EVENTS: groups
 * ==========================================================================*/
socket.on('addedToGroup', ({ group }) => {
  if (!group) return;
  state.groups[group.id] = group;
  renderGroupsList();
  showTransientNotice(`Вас добавили в группу «${group.name}»`);
});

socket.on('newGroupMessage', ({ groupId, msg }) => {
  if (state.activeGroup === groupId) {
    appendGroupMsg(msg);
    scrollMsgs('group-messages');
  } else {
    state.groupUnread[groupId] = (state.groupUnread[groupId] || 0) + 1;
    refreshGroupItem(groupId);
  }
});

socket.on('groupMemberJoined', ({ groupId, user }) => {
  const g = state.groups[groupId];
  if (!g) return;
  if (!g.members) g.members = [];
  if (!g.members.some(m => m.id === user.id)) g.members.push(user);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
    showTransientNotice(`${user.nickname} присоединился к группе`);
  }
});

socket.on('groupMemberLeft', ({ groupId, userId }) => {
  const g = state.groups[groupId];
  if (!g) return;
  g.members = (g.members || []).filter(m => m.id !== userId);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
  }
});

socket.on('groupDeleted', ({ groupId }) => {
  delete state.groups[groupId];
  delete state.groupUnread[groupId];
  renderGroupsList();
  if (state.activeGroup === groupId) {
    state.activeGroup = null;
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
    rate_limited: 'Слишком много действий, подождите',
  };
  showTransientNotice(messages[reason] || 'Ошибка группы');
});

/* ============================================================================
 * RENDER: friend requests
 * ==========================================================================*/
function renderRequests(reqs) {
  const sec = $('requests-section');
  const list = $('requests-list');
  if (!reqs || !reqs.length) {
    sec.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  sec.style.display = 'block';
  $('req-badge').textContent = reqs.length;
  list.innerHTML = '';
  reqs.forEach(r => {
    const id = r.id || r;
    const nick = r.nickname || id;
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

/* ============================================================================
 * RENDER: friends list
 * ==========================================================================*/
function renderFriendsList() {
  const list = $('friends-list');
  const ids = Object.keys(state.friends);
  if (!ids.length) {
    list.innerHTML = emptyFriendsHTML();
    return;
  }
  list.innerHTML = '';
  ids.forEach(id => buildFriendEl(id));
}

function buildFriendEl(id) {
  const f = state.friends[id];
  if (!f) return;
  const list = $('friends-list');
  const u = state.unread[id] || 0;

  const el = document.createElement('div');
  el.className = 'friend-item' + (state.activeFriend === id ? ' active' : '');
  el.dataset.fid = id;
  el.innerHTML = `
    <div class="f-av"></div>
    <div class="f-info">
      <div class="f-nick">${esc(f.nickname)}</div>
      <div class="f-stat ${f.online ? 'on' : ''}">${f.online ? '● онлайн' : 'офлайн'}</div>
    </div>
    ${u ? `<div class="f-unread">${u}</div>` : ''}`;

  const avEl = el.querySelector('.f-av');
  avEl.style.position = 'relative';
  renderAv(avEl, f.nickname, f.avatar);
  if (f.online) {
    const dot = document.createElement('div');
    dot.className = 'f-dot';
    avEl.appendChild(dot);
  }

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
  if (state.activeFriend === id) {
    $('chat-status').textContent = online ? '● онлайн' : 'офлайн';
    $('chat-status').className = 'chat-head-status' + (online ? ' on' : '');
  }
}

/* ============================================================================
 * RENDER: groups list
 * ==========================================================================*/
async function loadGroups() {
  try {
    const res = await authFetch(BACKEND_URL + '/api/groups');
    if (!res.ok) return;
    const list = await res.json();
    state.groups = Object.create(null);
    list.forEach(g => { state.groups[g.id] = g; });
    renderGroupsList();
  } catch (e) {
    if (!(e instanceof AuthError)) {
      showTransientNotice('Не удалось загрузить группы');
    }
  }
}

function renderGroupsList() {
  const list = $('groups-list');
  const ids = Object.keys(state.groups);
  if (!ids.length) {
    list.innerHTML = emptyGroupsHTML();
    return;
  }
  list.innerHTML = '';
  ids.forEach(id => buildGroupEl(id));
}

function buildGroupEl(id) {
  const g = state.groups[id];
  if (!g) return;
  const list = $('groups-list');
  const u = state.groupUnread[id] || 0;
  const onlineCount = (g.members || []).filter(m => m.online).length;

  const el = document.createElement('div');
  el.className = 'friend-item group-item' + (state.activeGroup === id ? ' active' : '');
  el.dataset.gid = id;
  el.innerHTML = `
    <div class="f-av group-av-slot"></div>
    <div class="f-info">
      <div class="f-nick">${esc(g.name)}</div>
      <div class="f-stat">${(g.members || []).length} уч. · ${onlineCount} онлайн</div>
    </div>
    ${u ? `<div class="f-unread">${u}</div>` : ''}`;

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

/* ============================================================================
 * MOBILE VIEW HELPER (shared by DM + group chat open)
 * ==========================================================================*/
function enterMobileChatView(backBtnId) {
  if (window.innerWidth > 640) return;
  document.querySelector('.sidebar')?.classList.add('hidden');
  document.querySelector('.chat-main')?.classList.remove('hidden');
  const backBtn = $(backBtnId);
  if (backBtn) backBtn.style.display = '';
}

/* ============================================================================
 * DM CHAT
 * ==========================================================================*/
async function openChat(id) {
  if (!state.me || !id) return;
  state.activeFriend = id;
  state.activeGroup = null;
  state.unread[id] = 0;

  document.querySelectorAll('.friend-item').forEach(el =>
    el.classList.toggle('active', el.dataset.fid === id)
  );
  refreshFriendItem(id);

  const f = state.friends[id] || { id, nickname: id, online: false };
  renderAv($('chat-avatar'), f.nickname, f.avatar);
  $('chat-nick').textContent = f.nickname;
  $('chat-status').textContent = f.online ? '● онлайн' : 'офлайн';
  $('chat-status').className = 'chat-head-status' + (f.online ? ' on' : '');

  $('chat-placeholder').style.display = 'none';
  $('group-chat-window').style.display = 'none';
  $('chat-window').style.display = 'flex';

  enterMobileChatView('btn-back');

  $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Загрузка…</div>';

  const requestSeq = ++state.seq.chat;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(state.me.id)}/${encodeURIComponent(id)}`);
    if (requestSeq !== state.seq.chat) return;
    if (!res.ok) throw new Error('history failed');
    const history = await res.json();
    if (requestSeq !== state.seq.chat) return;
    $('messages').innerHTML = '';
    if (!history || !history.length) {
      $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Напишите первым! 👋</div>';
    } else {
      history.forEach(m => appendMsg(m, 'messages', false));
    }
    scrollMsgs('messages');
  } catch (e) {
    if (requestSeq !== state.seq.chat) return;
    if (e instanceof AuthError) return;
    $('messages').innerHTML = '<div style="text-align:center;color:var(--red);padding:24px;font-size:13px">Ошибка загрузки</div>';
  }
  socket.emit('markRead', id);
  $('msg-input').focus();
}

function appendMsg(msg, containerId, doScroll = true) {
  if (!state.me) return;
  const isMine = msg.from === state.me.id;
  const isDeleted = !!msg.deleted;
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
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      openDeleteConfirm(msgId);
    });
    wrap.appendChild(delBtn);
  }

  $(containerId).appendChild(wrap);
  if (doScroll) scrollMsgs(containerId);
}

/* ============================================================================
 * GROUP CHAT
 * ==========================================================================*/
async function openGroupChat(groupId) {
  if (!state.me || !groupId || !state.groups[groupId]) return;
  state.activeGroup = groupId;
  state.activeFriend = null;
  state.groupUnread[groupId] = 0;

  document.querySelectorAll('.friend-item').forEach(el => el.classList.remove('active'));
  refreshGroupItem(groupId);

  const g = state.groups[groupId];
  updateGroupChatHeader(g);
  renderGroupMembersPanel(g);
  $('group-msg-input').placeholder = 'Написать в ' + g.name;

  $('chat-placeholder').style.display = 'none';
  $('chat-window').style.display = 'none';
  $('group-chat-window').style.display = 'flex';

  enterMobileChatView('btn-back-group');

  $('group-messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Загрузка…</div>';

  const requestSeq = ++state.seq.groupChat;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/groups/${encodeURIComponent(groupId)}/messages`);
    if (requestSeq !== state.seq.groupChat) return;
    if (!res.ok) throw new Error('history failed');
    const history = await res.json();
    if (requestSeq !== state.seq.groupChat) return;
    $('group-messages').innerHTML = '';
    if (!history || !history.length) {
      $('group-messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Начните общение в группе! 👋</div>';
    } else {
      history.forEach(m => appendGroupMsg(m, false));
    }
    scrollMsgs('group-messages');
  } catch (e) {
    if (requestSeq !== state.seq.groupChat) return;
    if (e instanceof AuthError) return;
    $('group-messages').innerHTML = '<div style="text-align:center;color:var(--red);padding:24px;font-size:13px">Ошибка загрузки</div>';
  }
  socket.emit('markGroupRead', groupId);
  $('group-msg-input').focus();
}

function updateGroupChatHeader(g) {
  renderGroupAv($('group-chat-avatar'), g);
  $('group-chat-name').textContent = g.name;
  const membersCount = (g.members || []).length;
  const onlineCount = (g.members || []).filter(m => m.online).length;
  $('group-chat-members-count').textContent = `${membersCount} участников · ${onlineCount} онлайн`;
}

// Discord-style сообщение в группе: аватар + ник (+коронка) + время + текст
function appendGroupMsg(msg, doScroll = true) {
  if (!state.me) return;
  const g = state.groups[state.activeGroup];
  const isMine = msg.from === state.me.id;
  const isDeleted = !!msg.deleted;
  const msgId = msg._id || msg.id || '';

  const sender = g?.members?.find(m => m.id === msg.from);
  const senderNick = sender?.nickname || msg.from;
  const isOwner = isGroupOwner(g, msg.from);

  const wrap = document.createElement('div');
  wrap.className = 'g-msg' + (isMine ? ' mine' : '') + (isDeleted ? ' deleted' : '');
  if (msgId) wrap.dataset.msgid = msgId;

  const avEl = document.createElement('div');
  avEl.className = 'g-msg-av';
  renderAv(avEl, senderNick, sender?.avatar || null);
  if (!isMine) {
    avEl.style.cursor = 'pointer';
    avEl.addEventListener('click', () => showUserProfile(msg.from));
  }
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
    delBtn.addEventListener('click', e => { e.stopPropagation(); openDeleteConfirm(msgId); });
    wrap.appendChild(delBtn);
  }

  $('group-messages').appendChild(wrap);
  if (doScroll) scrollMsgs('group-messages');
}

// Клик по шапке группы → инфо
$('group-chat-head-click').addEventListener('click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});
$('btn-group-info').addEventListener('click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});

/* ============================================================================
 * SEND MESSAGES
 * ==========================================================================*/
$('btn-send').onclick = sendMsg;
$('msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

function sendMsg() {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeFriend) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    return;
  }
  socket.emit('sendMessage', { toId: state.activeFriend, text });
  input.value = '';
  input.focus();
}

$('btn-group-send').onclick = sendGroupMsg;
$('group-msg-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGroupMsg(); }
});

function sendGroupMsg() {
  const input = $('group-msg-input');
  const text = input.value.trim();
  if (!text || !state.activeGroup) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    return;
  }
  socket.emit('groupMessage', { groupId: state.activeGroup, text });
  input.value = '';
  input.focus();
}

/* ============================================================================
 * DELETE MESSAGE
 * ==========================================================================*/
function openDeleteConfirm(msgId) {
  state.pendingDeleteId = msgId;
  $('delete-confirm').style.display = 'flex';
}
function closeDeleteConfirm() {
  state.pendingDeleteId = null;
  $('delete-confirm').style.display = 'none';
}

$('btn-confirm-delete').addEventListener('click', async () => {
  if (!state.pendingDeleteId || !state.me) return;
  const idToDelete = state.pendingDeleteId;
  closeDeleteConfirm();
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(idToDelete)}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      showTransientNotice(d.error || 'Ошибка удаления');
    }
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
});

/* ============================================================================
 * PROFILE: view other user
 * ==========================================================================*/
$('chat-head-click').addEventListener('click', () => {
  if (state.activeFriend) showUserProfile(state.activeFriend);
});

async function showUserProfile(userId) {
  const requestSeq = ++state.seq.profile;
  try {
    const res = await authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(userId));
    if (requestSeq !== state.seq.profile) return;
    if (!res.ok) return;
    const u = await res.json();
    if (requestSeq !== state.seq.profile) return;

    renderAv($('profile-modal-avatar'), u.nickname, u.avatar);
    $('profile-modal-nick').textContent = u.nickname;
    $('profile-modal-id').textContent = '@' + u.id;

    const onlineBadge = $('profile-modal-online');
    onlineBadge.textContent = u.online ? '● онлайн' : 'офлайн';
    onlineBadge.className = 'modal-online-badge ' + (u.online ? 'online' : 'offline');

    const statusRow = $('profile-modal-status-row');
    const bioRow = $('profile-modal-bio-row');
    if (u.status) {
      $('profile-modal-status').textContent = u.status;
      statusRow.style.display = '';
    } else {
      statusRow.style.display = 'none';
    }
    if (u.bio) {
      $('profile-modal-bio').textContent = u.bio;
      bioRow.style.display = '';
    } else {
      bioRow.style.display = 'none';
    }

    const addBtn = $('btn-add-friend');
    const isFriend = state.me?.friends?.includes(userId);
    const isMe = userId === state.me?.id;
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
      const isBlocked = !!state.me?.blockedUsers?.includes(userId);
      blockBtn.style.display = isMe ? 'none' : '';
      blockBtn.disabled = false;
      blockBtn.className = 'btn-secondary' + (isBlocked ? '' : ' btn-danger-outline');
      blockBtn.textContent = isBlocked ? 'Разблокировать' : 'Заблокировать';
      blockBtn.onclick = () => (isBlocked ? performUnblock(userId) : performBlock(userId));
    }

    $('profile-modal').style.display = 'flex';
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Не удалось загрузить профиль');
  }
}

async function performUnblock(userId) {
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/unblock`, { method: 'POST' });
    if (!res.ok) return showTransientNotice('Ошибка разблокировки');
    if (state.me.blockedUsers) state.me.blockedUsers = state.me.blockedUsers.filter(id => id !== userId);
    showUserProfile(userId);
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
}

async function performBlock(userId) {
  if (!confirm(`Заблокировать @${userId}?`)) return;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return showTransientNotice(d.error || 'Ошибка блокировки');
    }
    if (!state.me.blockedUsers) state.me.blockedUsers = [];
    if (!state.me.blockedUsers.includes(userId)) state.me.blockedUsers = [...state.me.blockedUsers, userId];
    if (state.me.friends) state.me.friends = state.me.friends.filter(id => id !== userId);
    delete state.friends[userId];
    delete state.unread[userId];
    renderFriendsList();
    if (state.activeFriend === userId) {
      state.activeFriend = null;
      $('chat-placeholder').style.display = 'flex';
      $('chat-window').style.display = 'none';
    }
    showUserProfile(userId);
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
}

function closeProfileModal() { $('profile-modal').style.display = 'none'; }
window.closeProfileModal = closeProfileModal;

$('profile-modal').addEventListener('click', e => {
  if (e.target === $('profile-modal')) closeProfileModal();
});

/* ============================================================================
 * PROFILE: edit own
 * ==========================================================================*/
function openEditProfileModal() {
  if (!state.me) return;
  renderAv($('edit-avatar'), state.me.nickname, state.me.avatar);
  $('edit-nick').value = state.me.nickname || '';
  $('edit-status').value = state.me.status || '';
  $('edit-bio').value = state.me.bio || '';
  $('edit-profile-modal').style.display = 'flex';
}
function closeEditProfileModal() { $('edit-profile-modal').style.display = 'none'; }
window.closeEditProfileModal = closeEditProfileModal;

$('edit-profile-modal').addEventListener('click', e => {
  if (e.target === $('edit-profile-modal')) closeEditProfileModal();
});

$('avatar-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !state.me) return;
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    showTransientNotice('Разрешены только изображения (jpeg, png, webp, gif)');
    e.target.value = '';
    return;
  }
  if (file.size > MAX_AVATAR_SIZE) {
    showTransientNotice('Файл слишком большой (максимум 5MB)');
    e.target.value = '';
    return;
  }
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const res = await authFetch(BACKEND_URL + '/api/upload/avatar', { method: 'POST', body: formData });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      showTransientNotice(d.error || 'Ошибка загрузки аватара');
      return;
    }
    const data = await res.json();
    state.me.avatar = data.avatar;
    localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
    renderAv($('edit-avatar'), state.me.nickname, state.me.avatar);
    renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
  e.target.value = '';
});

$('btn-save-profile').addEventListener('click', async () => {
  if (!state.me) return;
  const nickname = $('edit-nick').value.trim();
  const status = $('edit-status').value.trim();
  const bio = $('edit-bio').value.trim();

  await withButtonBusy($('btn-save-profile'), 'Сохранение…', async () => {
    try {
      const res = await authFetch(BACKEND_URL + '/api/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, status, bio }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showTransientNotice(data.error || 'Ошибка сохранения');
      state.me.nickname = data.user.nickname;
      state.me.status = data.user.status;
      state.me.bio = data.user.bio;
      localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
      $('my-nick').textContent = state.me.nickname;
      renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
      closeEditProfileModal();
    } catch (e) {
      if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
    }
  });
});

/* ============================================================================
 * BLOCKED USERS
 * ==========================================================================*/
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
    if (!res.ok) throw new Error('failed');
    const users = await res.json();
    state.me.blockedUsers = users.map(u => u.id);
    renderBlockedUsersList(users);
  } catch (e) {
    if (e instanceof AuthError) return;
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
        if (!res.ok) return showTransientNotice('Ошибка разблокировки');
        if (state.me.blockedUsers) state.me.blockedUsers = state.me.blockedUsers.filter(id => id !== u.id);
        el.remove();
        if (!list.children.length) {
          list.innerHTML = '<div class="blocked-users-empty">Нет заблокированных пользователей</div>';
        }
      } catch (e) {
        if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
      }
    });
    list.appendChild(el);
  });
}

/* ============================================================================
 * CREATE GROUP MODAL
 * ==========================================================================*/
let selectedGroupMembers = new Set();

$('btn-create-group').addEventListener('click', () => {
  if (!state.me) return;
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
  const ids = Object.keys(state.friends);
  if (!ids.length) {
    picker.innerHTML = '<div class="empty-state" style="padding:16px"><div class="empty-sub">Сначала добавь друзей</div></div>';
    return;
  }
  picker.innerHTML = '';
  ids.forEach(id => {
    const f = state.friends[id];
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

  await withButtonBusy($('btn-confirm-create-group'), 'Создание…', async () => {
    try {
      const res = await authFetch(BACKEND_URL + '/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberIds: [...selectedGroupMembers] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showTransientNotice(data.error || 'Ошибка создания группы');
      closeCreateGroupModal();
      await loadGroups();
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      document.querySelector('[data-stab="groups"]')?.classList.add('active');
      $('dm-panel').style.display = 'none';
      $('groups-panel').style.display = '';
      if (data.group) openGroupChat(data.group.id);
    } catch (e) {
      if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
    }
  });
});

/* ============================================================================
 * GROUP INFO MODAL
 * ==========================================================================*/
function openGroupInfoModal(groupId) {
  const g = state.groups[groupId];
  if (!g) return;

  renderGroupAv($('group-info-avatar'), g);
  $('group-info-name').textContent = g.name;
  $('group-info-created').textContent = 'Создана ' + fmtDate(g.createdAt || Date.now());
  $('group-info-count').textContent = (g.members || []).length;

  const isOwner = isGroupOwner(g, state.me?.id);
  $('group-info-owner-actions').style.display = isOwner ? '' : 'none';

  renderGroupInfoMembers(g);
  $('group-info-modal').style.display = 'flex';
}

function renderGroupInfoMembers(g) {
  const list = $('group-info-members');
  list.innerHTML = '';
  const myId = state.me?.id;
  const iAmOwner = isGroupOwner(g, myId);

  (g.members || []).forEach(m => {
    const memberIsOwner = isGroupOwner(g, m.id);
    const el = document.createElement('div');
    el.className = 'group-member-item';
    el.innerHTML = `
      <div class="f-av" style="width:32px;height:32px;font-size:12px"></div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:13px">${esc(m.nickname)} ${memberIsOwner ? '<span class="owner-badge">👑</span>' : ''}</div>
        <div class="f-stat" style="font-size:11px">@${esc(m.id)}</div>
      </div>
      ${m.id !== myId && iAmOwner ? '<button class="btn-kick" title="Удалить из группы">✕</button>' : ''}`;

    const avEl = el.querySelector('.f-av');
    avEl.style.position = 'relative';
    renderAv(avEl, m.nickname, m.avatar);
    if (m.online) {
      const dot = document.createElement('div');
      dot.className = 'f-dot';
      avEl.appendChild(dot);
    }

    const kickBtn = el.querySelector('.btn-kick');
    if (kickBtn) {
      kickBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`Удалить ${m.nickname} из группы?`)) {
          socket.emit('kickGroupMember', { groupId: g.id, userId: m.id });
        }
      });
    }
    if (m.id !== myId) {
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
  if (!state.activeGroup) return;
  const g = state.groups[state.activeGroup];
  const isOwner = isGroupOwner(g, state.me?.id);
  const msg = isOwner
    ? 'Вы владелец группы. Группа будет УДАЛЁНА для всех. Продолжить?'
    : 'Покинуть группу?';
  if (!confirm(msg)) return;
  socket.emit('leaveGroup', state.activeGroup);
  closeGroupInfoModal();
});

/* ============================================================================
 * ADD MEMBERS MODAL
 * ==========================================================================*/
let selectedAddMembers = new Set();

$('btn-add-members').addEventListener('click', () => {
  if (!state.activeGroup || !state.groups[state.activeGroup]) return;
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
  const g = state.groups[state.activeGroup];
  if (!g) return;
  const memberIds = new Set((g.members || []).map(m => m.id));
  const candidates = Object.keys(state.friends).filter(id => !memberIds.has(id));

  if (!candidates.length) {
    picker.innerHTML = '<div class="empty-state" style="padding:16px"><div class="empty-sub">Все друзья уже в группе</div></div>';
    return;
  }
  picker.innerHTML = '';
  candidates.forEach(id => {
    const f = state.friends[id];
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
  if (!state.activeGroup || !selectedAddMembers.size) return;
  selectedAddMembers.forEach(userId => {
    socket.emit('addGroupMember', { groupId: state.activeGroup, userId });
  });
  closeAddMembersModal();
  showTransientNotice('Приглашения отправлены');
});

/* ============================================================================
 * MEMBERS PANEL (Discord-style right column)
 * ==========================================================================*/
function renderGroupMembersPanel(g) {
  if (!g) return;
  const countEl = $('gm-count');
  const list = $('group-members-list');
  if (!countEl || !list) return;

  countEl.textContent = (g.members || []).length;
  list.innerHTML = '';

  // Владелец сверху, потом онлайн, потом оффлайн, по алфавиту
  const sorted = [...(g.members || [])].sort((a, b) => {
    const aOwner = isGroupOwner(g, a.id);
    const bOwner = isGroupOwner(g, b.id);
    if (aOwner !== bOwner) return aOwner ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.nickname || '').localeCompare(b.nickname || '');
  });

  sorted.forEach(m => {
    const isOwner = isGroupOwner(g, m.id);
    const el = document.createElement('div');
    el.className = 'gm-item' + (m.online ? '' : ' offline');
    el.innerHTML = `
      <div class="gm-av"></div>
      <div class="gm-name">${esc(m.nickname)}</div>
      ${isOwner ? CROWN_SVG : ''}`;
    const avEl = el.querySelector('.gm-av');
    renderAv(avEl, m.nickname, m.avatar);
    if (m.online) {
      const dot = document.createElement('div');
      dot.className = 'f-dot';
      avEl.appendChild(dot);
    }
    if (m.id !== state.me?.id) el.addEventListener('click', () => showUserProfile(m.id));
    list.appendChild(el);
  });

  // Кнопка "Добавить участников" — только у владельца
  const inviteBtn = $('btn-invite-group');
  if (inviteBtn) inviteBtn.style.display = isGroupOwner(g, state.me?.id) ? '' : 'none';
}

$('btn-toggle-members').addEventListener('click', () => {
  $('group-members-panel').classList.toggle('hidden');
});

$('btn-invite-group').addEventListener('click', () => {
  if (!state.activeGroup || !state.groups[state.activeGroup]) return;
  selectedAddMembers = new Set();
  $('add-members-count').textContent = 'выбрано: 0';
  renderAddMembersPicker();
  $('add-members-modal').style.display = 'flex';
});

/* ============================================================================
 * MOBILE BACK BUTTONS
 * ==========================================================================*/
$('btn-back')?.addEventListener('click', goBackMobile);
$('btn-back-group')?.addEventListener('click', goBackMobile);

function goBackMobile() {
  state.activeFriend = null;
  state.activeGroup = null;
  document.querySelector('.sidebar')?.classList.remove('hidden');
  document.querySelector('.chat-main')?.classList.add('hidden');
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

/* ============================================================================
 * AUTO-LOGIN
 * ==========================================================================*/
(() => {
  const token = localStorage.getItem('chatapp_token');
  const cached = localStorage.getItem('chatapp_profile');
  if (token && cached) {
    try {
      state.me = JSON.parse(cached);
      enterApp(state.me);
    } catch (e) {
      localStorage.removeItem('chatapp_profile');
      document.documentElement.classList.remove('has-session');
    }
  } else {
    document.documentElement.classList.remove('has-session');
  }
})();

/* ============================================================================
 * SOCKET CONNECTION ERROR HANDLING
 * ==========================================================================*/
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
/* ============================================================================
 * CALLS (WebRTC: DM 1:1 + Group mesh)
 * ==========================================================================*/
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const callState = {
  active: false,
  callId: null,
  chatKey: null,
  isGroup: false,
  groupId: null,
  peerFriendId: null,   // for DM
  video: false,
  localStream: null,
  micOn: true,
  camOn: true,
  peers: Object.create(null), // peerId -> { pc, stream, pendingCandidates }
  pendingIncoming: null,      // { callId, chatKey, isGroup, groupId, video, from, fromNick }
  ringTimer: null,
};

function callPeerName(peerId) {
  if (callState.isGroup) {
    const g = state.groups[callState.groupId];
    const m = g?.members?.find(m => m.id === peerId);
    return m?.nickname || peerId;
  }
  const f = state.friends[peerId];
  return f?.nickname || (peerId === callState.peerFriendId ? callState.peerFriendName : peerId);
}

function callPeerAvatar(peerId) {
  if (callState.isGroup) {
    const g = state.groups[callState.groupId];
    const m = g?.members?.find(m => m.id === peerId);
    return m?.avatar || null;
  }
  const f = state.friends[peerId];
  return f?.avatar || null;
}

async function startCall({ toId, groupId, video }) {
  if (callState.active || callState.pendingIncoming) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  try {
    callState.localStream = await navigator.mediaDevices.getUserMedia({
      audio: RAW_AUDIO_CONSTRAINTS,
      video: !!video
    });
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    return;
  }
  callState.video = !!video;
  callState.isGroup = !!groupId;
  callState.groupId = groupId || null;
  callState.peerFriendId = toId || null;
  if (toId) callState.peerFriendName = state.friends[toId]?.nickname || toId;

  socket.emit('callStart', { toId, groupId, video: !!video });
  openCallOverlay('соединение…');
}

function openCallOverlay(statusText) {
  callState.active = true;
  const overlay = $('call-overlay');
  overlay.classList.toggle('voice-mode', !callState.video);
  overlay.classList.toggle('video-mode', callState.video);
  $('call-overlay-mode').textContent = callState.video ? 'ВИДЕОКАНАЛ' : 'ГОЛОСОВОЙ КАНАЛ';
  overlay.style.display = 'flex';
  $('call-overlay-title').textContent = callState.isGroup
    ? (state.groups[callState.groupId]?.name || 'Групповой звонок')
    : callPeerName(callState.peerFriendId);
  $('call-overlay-status').textContent = statusText || '';
  renderCallGrid();
}

function closeCallOverlay() {
  const overlay = $('call-overlay');
  overlay.style.display = 'none';
  overlay.classList.remove('voice-mode', 'video-mode');
  $('incoming-call-modal').style.display = 'none';
  clearTimeout(callState.ringTimer);

  if (callState.localStream) {
    callState.localStream.getTracks().forEach(t => t.stop());
  }
  Object.values(callState.peers).forEach(p => {
    try { p.pc.close(); } catch (e) {}
  });

  callState.active = false;
  callState.callId = null;
  callState.chatKey = null;
  callState.isGroup = false;
  callState.groupId = null;
  callState.peerFriendId = null;
  callState.video = false;
  callState.localStream = null;
  callState.micOn = true;
  callState.camOn = true;
  callState.peers = Object.create(null);
  callState.pendingIncoming = null;

  $('call-video-grid').innerHTML = '';
}

function renderCallGrid() {
  const grid = $('call-video-grid');
  grid.innerHTML = '';

  // Local tile
  grid.appendChild(makeCallTile('local', state.me?.nickname || 'Я', state.me?.avatar, callState.localStream, true));

  // Remote tiles
  for (const [peerId, p] of Object.entries(callState.peers)) {
    grid.appendChild(makeCallTile(peerId, callPeerName(peerId), callPeerAvatar(peerId), p.stream, false));
  }
}

function makeCallTile(id, nickname, avatarUrl, stream, isLocal) {
  const tile = document.createElement('div');
  const hasVideo = callState.video && stream && stream.getVideoTracks().some(t => t.enabled);
  tile.className = 'call-tile' + (isLocal ? ' local' : '') + (hasVideo ? '' : ' audio-only');
  tile.dataset.peer = id;

  if (stream) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true;
    video.srcObject = stream;
    tile.appendChild(video);
  }

  const avWrap = document.createElement('div');
  avWrap.className = 'call-tile-avatar';
  renderAv(avWrap, nickname, avatarUrl);
  tile.appendChild(avWrap);

  const label = document.createElement('div');
  label.className = 'call-tile-nick';
  label.textContent = isLocal ? `${nickname} (вы)` : nickname;
  tile.appendChild(label);

  return tile;
}

function createPeerConnection(peerId) {
  const existingPeer = callState.peers[peerId];
  if (existingPeer?.pc) return existingPeer.pc;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  callState.peers[peerId] = {
    pc,
    stream: null,
    pendingCandidates: []
  };

  if (callState.localStream) {
    callState.localStream.getTracks().forEach(track => pc.addTrack(track, callState.localStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('callSignal', { callId: callState.callId, to: peerId, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.ontrack = e => {
    const peer = callState.peers[peerId];
    if (!peer) return;
    peer.stream = e.streams[0];
    renderCallGrid();
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && callState.peers[peerId]) {
      // let peerLeft / cleanup handle full teardown; just refresh UI
    }
  };

  return pc;
}

async function connectToPeer(peerId, shouldOffer) {
  if (!peerId || peerId === state.me?.id || !callState.active) return null;
  const pc = createPeerConnection(peerId);
  if (shouldOffer && pc.signalingState === 'stable' && !pc.localDescription) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('callSignal', { callId: callState.callId, to: peerId, data: { type: 'offer', sdp: offer } });
  }
  return pc;
}

function teardownPeer(peerId) {
  const p = callState.peers[peerId];
  if (p?.pc) { try { p.pc.close(); } catch (e) {} }
  delete callState.peers[peerId];
  renderCallGrid();
}

/* ── Outgoing UI hooks ─────────────────────────────────────────────────── */
$('btn-call-audio').addEventListener('click', () => {
  if (state.activeFriend) startCall({ toId: state.activeFriend, video: false });
});
$('btn-call-video').addEventListener('click', () => {
  if (state.activeFriend) startCall({ toId: state.activeFriend, video: true });
});
$('btn-group-call-audio').addEventListener('click', () => {
  if (state.activeGroup) startCall({ groupId: state.activeGroup, video: false });
});
$('btn-group-call-video').addEventListener('click', () => {
  if (state.activeGroup) startCall({ groupId: state.activeGroup, video: true });
});

$('btn-call-hangup').addEventListener('click', () => {
  if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
  closeCallOverlay();
});

$('btn-call-toggle-mic').addEventListener('click', () => {
  if (!callState.localStream) return;
  callState.micOn = !callState.micOn;
  callState.localStream.getAudioTracks().forEach(t => { t.enabled = callState.micOn; });
  const micButton = $('btn-call-toggle-mic');
  micButton.classList.toggle('active-off', !callState.micOn);
  micButton.title = callState.micOn ? 'Выключить микрофон' : 'Включить микрофон';
  micButton.setAttribute('aria-label', micButton.title);
});

$('btn-call-toggle-cam').addEventListener('click', () => {
  if (!callState.localStream || !callState.video) return;
  callState.camOn = !callState.camOn;
  callState.localStream.getVideoTracks().forEach(t => { t.enabled = callState.camOn; });
  const camButton = $('btn-call-toggle-cam');
  camButton.classList.toggle('active-off', !callState.camOn);
  camButton.title = callState.camOn ? 'Выключить камеру' : 'Включить камеру';
  camButton.setAttribute('aria-label', camButton.title);
  renderCallGrid();
});

/* ── Incoming call UI ──────────────────────────────────────────────────── */
function showIncomingCall(info) {
  callState.pendingIncoming = info;
  const nick = info.isGroup
    ? (state.groups[info.groupId]?.name || 'Групповой звонок')
    : (info.fromNick || info.from);
  $('incoming-call-nick').textContent = nick;
  $('incoming-call-sub').textContent = info.isGroup
    ? `${info.fromNick || 'Кто-то'} начал(а) ${info.video ? 'видео' : 'аудио'}звонок`
    : `входящий ${info.video ? 'видео' : 'аудио'}звонок…`;
  const avEl = $('incoming-call-avatar');
  const avatarUrl = info.isGroup ? null : (state.friends[info.from]?.avatar || null);
  renderAv(avEl, nick, avatarUrl);
  $('incoming-call-modal').style.display = 'flex';
}

$('btn-call-accept').addEventListener('click', async () => {
  const info = callState.pendingIncoming;
  if (!info) return;
  $('incoming-call-modal').style.display = 'none';

  try {
    callState.localStream = await navigator.mediaDevices.getUserMedia({
      audio: RAW_AUDIO_CONSTRAINTS,
      video: !!info.video
    });
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    socket.emit('callReject', { callId: info.callId });
    callState.pendingIncoming = null;
    return;
  }

  callState.callId = info.callId;
  callState.chatKey = info.chatKey;
  callState.isGroup = info.isGroup;
  callState.groupId = info.groupId || null;
  callState.peerFriendId = info.isGroup ? null : info.from;
  callState.peerFriendName = info.fromNick;
  callState.video = !!info.video;
  callState.pendingIncoming = null;

  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: info.callId });
});

$('btn-call-decline').addEventListener('click', () => {
  const info = callState.pendingIncoming;
  if (!info) return;
  socket.emit('callReject', { callId: info.callId });
  callState.pendingIncoming = null;
  $('incoming-call-modal').style.display = 'none';
});

/* ── Server events ─────────────────────────────────────────────────────── */
socket.on('callStarted', ({ callId, chatKey }) => {
  callState.callId = callId;
  callState.chatKey = chatKey;
  $('call-overlay-status').textContent = 'ожидание ответа…';
  if (!callState.isGroup) {
    socket.emit('callJoin', { callId }); // initiator also joins as participant #1
  } else {
    socket.emit('callJoin', { callId });
  }
});

socket.on('incomingCall', (info) => {
  if (callState.active || callState.pendingIncoming) {
    // Busy — auto-decline group invites silently, or reject DM
    if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
    return;
  }
  showIncomingCall(info);
});

socket.on('callParticipants', async ({ callId, chatKey, video, participants }) => {
  if (!callState.active) return;
  callState.callId = callId;
  callState.chatKey = chatKey;
  callState.video = !!video;
  $('call-overlay-status').textContent = 'в звонке';
  for (const peerId of participants || []) {
    const shouldOffer = state.me?.id < peerId;
    try {
      await connectToPeer(peerId, shouldOffer);
    } catch (e) {
      console.error('Failed to connect to peer:', e);
      teardownPeer(peerId);
    }
  }
  renderCallGrid();
});

socket.on('peerJoined', async ({ peerId }) => {
  if (!callState.active || peerId === state.me?.id) return;
  $('call-overlay-status').textContent = 'в звонке';
  const shouldOffer = state.me?.id < peerId;
  try {
    await connectToPeer(peerId, shouldOffer);
  } catch (e) {
    console.error('Failed to connect to peer:', e);
    teardownPeer(peerId);
  }
  renderCallGrid();
});

socket.on('peerLeft', ({ peerId }) => {
  if (peerId === state.me?.id) return;
  teardownPeer(peerId);
  if (!callState.isGroup) {
    showTransientNotice('Собеседник завершил звонок');
    closeCallOverlay();
  }
});

socket.on('callRejected', ({ peerId }) => {
  if (!callState.isGroup) {
    showTransientNotice('Звонок отклонён');
    closeCallOverlay();
  }
});

socket.on('callError', ({ reason }) => {
  const messages = {
    offline: 'Пользователь не в сети',
    busy: 'Уже есть активный звонок в этом чате',
    not_friend: 'Вы не друзья',
    blocked: 'Действие недоступно',
    not_member: 'Вы не участник группы',
    not_found: 'Звонок уже завершён',
    forbidden: 'Недостаточно прав',
    server_error: 'Ошибка сервера'
  };
  showTransientNotice(messages[reason] || 'Ошибка звонка');
  if (callState.active && !Object.keys(callState.peers).length) closeCallOverlay();
});

socket.on('callSignal', async ({ callId, from, data }) => {
  if (!callState.active || callId !== callState.callId || !from || !data) return;
  let peer = callState.peers[from];
  if (!peer || !peer.pc) {
    await connectToPeer(from, false);
    peer = callState.peers[from];
  }
  try {
    const pc = peer.pc;
    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const candidate of peer.pendingCandidates) {
        await pc.addIceCandidate(candidate);
      }
      peer.pendingCandidates = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('callSignal', { callId: callState.callId, to: from, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const candidate of peer.pendingCandidates) {
        await pc.addIceCandidate(candidate);
      }
      peer.pendingCandidates = [];
    } else if (data.type === 'ice' && data.candidate) {
      const candidate = new RTCIceCandidate(data.candidate);
      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        peer.pendingCandidates.push(candidate);
      }
    }
  } catch (e) {
    console.error('callSignal error', e);
  }
});