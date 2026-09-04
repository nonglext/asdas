'use strict';

/* ============================================================================
 * CONFIG
 * ==========================================================================*/
const BACKEND_URL = "https://asdas-p7ht.onrender.com";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MSG_GROUP_WINDOW_MS = 5 * 60 * 1000; // группировка сообщений (5 минут)
const CALL_RING_TIMEOUT_MS = 45 * 1000;    // таймаут ожидания ответа
const SEARCH_DEBOUNCE_MS = 280;

// Отключаем браузерную обработку микрофона — в звонок идёт «сырой» поток.
const RAW_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
};

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const CROWN_SVG = '<svg class="gm-crown" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><title>Владелец группы</title><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>';
const TRASH_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>';
const MIC_OFF_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';

/* ============================================================================
 * DOM HELPERS
 * ==========================================================================*/
const $ = id => document.getElementById(id);

/** Безопасная подписка: отсутствие элемента в HTML не роняет весь скрипт. */
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  else console.warn(`[ui] element #${id} not found`);
  return el;
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setDisplay(id, value) {
  const el = $(id);
  if (el) el.style.display = value;
}

/* ============================================================================
 * STATE
 * ==========================================================================*/
class AuthError extends Error {}

const state = {
  me: null,
  activeFriend: null,
  activeGroup: null,
  infoGroupId: null,           // группа, открытая в модалке «инфо»
  friends: Object.create(null),
  groups: Object.create(null),
  unread: Object.create(null),
  groupUnread: Object.create(null),
  groupVoiceCalls: Object.create(null),
  pendingDeleteId: null,
  // Монотонные счётчики против устаревших async-ответов
  seq: { chat: 0, groupChat: 0, profile: 0, search: 0 },
  loggingOut: false,
};

const callState = {
  active: false,
  callId: null,
  chatKey: null,
  isGroup: false,
  groupId: null,
  peerFriendId: null,
  peerFriendName: null,
  video: false,
  localStream: null,
  micOn: true,
  camOn: true,
  peers: Object.create(null), // peerId -> { pc, stream, pendingCandidates }
  pendingIncoming: null,      // { callId, chatKey, isGroup, groupId, video, from, fromNick }
  ringTimer: null,            // таймаут исходящего DM-звонка
  incomingTimer: null,        // таймаут входящего звонка
};

const speakingMonitors = Object.create(null); // id -> { analyser, data, source, stream, raf }
let selectedGroupMembers = new Set();
let selectedAddMembers = new Set();
const BASE_TITLE = document.title || 'Chat';

function resetState() {
  state.me = null;
  state.activeFriend = null;
  state.activeGroup = null;
  state.infoGroupId = null;
  state.friends = Object.create(null);
  state.groups = Object.create(null);
  state.unread = Object.create(null);
  state.groupUnread = Object.create(null);
  state.groupVoiceCalls = Object.create(null);
  state.pendingDeleteId = null;
  selectedGroupMembers = new Set();
  selectedAddMembers = new Set();
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
  if (!nick) return '?';
  return String(nick).trim().charAt(0).toUpperCase() || '?';
}

function esc(s) {
  return String(s ?? '')
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

function msgTimeRaw(msg) {
  return msg.time || msg.timestamp || msg.createdAt || null;
}

function getMsgTimeMs(msg) {
  const t = new Date(msgTimeRaw(msg)).getTime();
  return isNaN(t) ? Date.now() : t;
}

async function safeJson(res) {
  return res.json().catch(() => ({}));
}

function setErr(msg) {
  setText('auth-error', msg || '');
}

function scrollMsgs(containerId) {
  const m = $(containerId);
  if (m) m.scrollTop = m.scrollHeight;
}

function placeholderHTML(text, isError = false) {
  return `<div class="msgs-placeholder" style="text-align:center;color:${isError ? 'var(--red)' : 'var(--text3)'};padding:24px;font-size:13px">${esc(text)}</div>`;
}

function clearMsgsPlaceholder(container) {
  container.querySelectorAll('.msgs-placeholder').forEach(el => el.remove());
}

const MODAL_IDS = [
  'profile-modal', 'edit-profile-modal', 'blocked-users-modal', 'delete-confirm',
  'create-group-modal', 'group-info-modal', 'add-members-modal',
];

function closeAllModals() {
  MODAL_IDS.forEach(id => setDisplay(id, 'none'));
  state.pendingDeleteId = null;
  state.infoGroupId = null;
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

function updateTitleBadge() {
  const total =
    Object.values(state.unread).reduce((a, b) => a + (b || 0), 0) +
    Object.values(state.groupUnread).reduce((a, b) => a + (b || 0), 0);
  document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}

/* ============================================================================
 * AUTH / SESSION
 * ==========================================================================*/
function forceLogoutToLogin(message) {
  if (state.loggingOut) return;
  state.loggingOut = true;
  try {
    if (callState.active || callState.pendingIncoming) {
      if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
      closeCallOverlay();
    }
    resetState();
    if (socket.connected) socket.disconnect();
    localStorage.removeItem('chatapp_id');
    localStorage.removeItem('chatapp_token');
    localStorage.removeItem('chatapp_profile');
    document.documentElement.classList.remove('has-session');
    closeAllModals();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $('auth-screen')?.classList.add('active');
    if (message) setErr(message);

    const fl = $('friends-list');
    if (fl) fl.innerHTML = emptyFriendsHTML();
    const rl = $('requests-list');
    if (rl) rl.innerHTML = '';
    setDisplay('requests-section', 'none');
    const gl = $('groups-list');
    if (gl) gl.innerHTML = emptyGroupsHTML();
    closeActiveChat();
    document.title = BASE_TITLE;
  } finally {
    state.loggingOut = false;
  }
}

/**
 * fetch() с bearer-токеном. На 401 при активной сессии выбрасывает AuthError,
 * чтобы вызывающий код не продолжил обрабатывать данные разлогиненной сессии.
 */
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('chatapp_token');
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  });
  if (res.status === 401 && state.me) {
    forceLogoutToLogin('Сессия истекла, войдите снова');
    throw new AuthError('Session expired');
  }
  return res;
}

function saveAndLogin(user, userId, token) {
  if (!user) return setErr('Некорректный ответ сервера');
  state.me = user;
  localStorage.setItem('chatapp_id', userId);
  if (token) localStorage.setItem('chatapp_token', token);
  localStorage.setItem('chatapp_profile', JSON.stringify(user));
  enterApp(user);
}

function enterApp(user) {
  renderAv($('my-avatar'), user.nickname, user.avatar);
  setText('my-nick', user.nickname);
  setText('my-id', '@' + user.id);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('app-screen')?.classList.add('active');
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
  const members = (group?.members || []).slice(0, 4);
  if (!members.length) { el.textContent = '#'; return; }
  const grid = document.createElement('div');
  grid.className = 'group-av-grid g' + members.length;
  members.forEach(m => {
    const cell = document.createElement('div');
    cell.className = 'group-av-cell';
    renderAv(cell, m.nickname, m.avatar);
    grid.appendChild(cell);
  });
  el.appendChild(grid);
}

/** Единственный источник истины «является ли участник владельцем группы». */
function isGroupOwner(group, userId) {
  if (!group || !userId) return false;
  if (group.ownerId) return group.ownerId === userId;
  const member = (group.members || []).find(m => m.id === userId);
  return member ? member.role === 'owner' : false;
}

const EMPTY_ICON_SVG = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>';

function emptyFriendsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">${EMPTY_ICON_SVG}</div>
    <div class="empty-title">Нет контактов</div>
    <div class="empty-sub">Найди кого-нибудь через поиск</div>
  </div>`;
}

function emptyGroupsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">${EMPTY_ICON_SVG}</div>
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
    $('tab-' + tab.dataset.tab)?.classList.add('active');
    setErr('');
  });
});

function switchSidebarTab(name) {
  const isGroups = name === 'groups';
  document.querySelectorAll('.sidebar-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.stab === name)
  );
  setDisplay('dm-panel', isGroups ? 'none' : '');
  setDisplay('groups-panel', isGroups ? '' : 'none');
}

document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => switchSidebarTab(tab.dataset.stab));
});

/* ============================================================================
 * REGISTER / LOGIN
 * ==========================================================================*/
async function withButtonBusy(btn, busyText, fn) {
  if (!btn) return fn();
  if (btn.disabled) return; // защита от двойного клика
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

on('btn-register', 'click', async () => {
  setErr('');
  const userId = ($('reg-id')?.value || '').trim().toLowerCase();
  const nickname = ($('reg-nick')?.value || '').trim();
  const password = $('reg-pw')?.value || '';

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
      const data = await safeJson(res);
      if (!res.ok) return setErr(data.error || 'Ошибка регистрации');
      saveAndLogin(data.user, userId, data.token);
    } catch (e) {
      setErr('Ошибка сети');
    }
  });
});

on('btn-login', 'click', async () => {
  setErr('');
  const userId = ($('login-id')?.value || '').trim();
  const password = $('login-pw')?.value || '';
  if (!userId || !password) return setErr('Введите ID и пароль');

  await withButtonBusy($('btn-login'), 'Загрузка…', async () => {
    try {
      const res = await fetch(BACKEND_URL + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password }),
      });
      const data = await safeJson(res);
      if (!res.ok) return setErr(data.error || 'Ошибка входа');
      saveAndLogin(data.user, userId, data.token);
    } catch (e) {
      setErr('Ошибка сети');
    }
  });
});

['login-id', 'login-pw'].forEach(id =>
  on(id, 'keydown', e => { if (e.key === 'Enter') $('btn-login')?.click(); })
);
['reg-id', 'reg-nick', 'reg-pw'].forEach(id =>
  on(id, 'keydown', e => { if (e.key === 'Enter') $('btn-register')?.click(); })
);

on('btn-logout', 'click', () => forceLogoutToLogin());

function showChatPlaceholder() {
  setDisplay('chat-placeholder', 'flex');
  setDisplay('chat-window', 'none');
  setDisplay('group-chat-window', 'none');
  setDisplay('group-voice-bar', 'none');
}

function closeActiveChat() {
  state.activeFriend = null;
  state.activeGroup = null;
  document.querySelectorAll('.friend-item.active').forEach(el => el.classList.remove('active'));
  showChatPlaceholder();
}

/* ============================================================================
 * ME CARD → EDIT PROFILE
 * ==========================================================================*/
on('me-card', 'click', e => {
  if (e.target.closest('#btn-logout')) return;
  if (state.me) openEditProfileModal();
});

/* ============================================================================
 * SEARCH
 * ==========================================================================*/
let searchTimer = null;
on('search-input', 'input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) { closeDrop(); return; }
  searchTimer = setTimeout(() => doSearch(q), SEARCH_DEBOUNCE_MS);
});
on('search-input', 'blur', () => setTimeout(() => closeDrop(false), 200));
on('search-input', 'focus', () => {
  const q = $('search-input').value.trim();
  if (q) doSearch(q);
});

async function doSearch(q) {
  const drop = $('search-results');
  if (!drop) return;
  const requestSeq = ++state.seq.search;
  try {
    const res = await authFetch(BACKEND_URL + '/api/search?q=' + encodeURIComponent(q));
    if (requestSeq !== state.seq.search) return;
    if (!res.ok) throw new Error('search failed');
    const list = await res.json();
    if (requestSeq !== state.seq.search) return;
    drop.innerHTML = '';

    const visible = (Array.isArray(list) ? list : []).filter(u => u && u.id !== state.me?.id);
    if (!visible.length) {
      drop.innerHTML = '<div class="s-item" style="color:var(--text3);font-size:13px">Никого не найдено</div>';
      drop.classList.add('open');
      return;
    }

    visible.forEach(u => {
      const isFriend = !!state.me?.friends?.includes(u.id);
      const el = document.createElement('div');
      el.className = 's-item';
      el.dataset.uid = u.id; // нужен для отката кнопки в friendRequestError
      el.innerHTML = `
        <div class="s-mini-av"></div>
        <div style="flex:1;min-width:0">
          <div class="s-nick">${esc(u.nickname)}</div>
          <div class="s-id">@${esc(u.id)}</div>
        </div>
        <button class="btn-add" type="button" ${isFriend ? 'disabled' : ''}>${isFriend ? '✓ Друг' : '+ Добавить'}</button>`;
      renderAv(el.querySelector('.s-mini-av'), u.nickname, u.avatar);

      const btn = el.querySelector('.btn-add');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (isFriend || btn.disabled) return;
        socket.emit('sendFriendRequest', u.id);
        btn.textContent = 'Отправлено';
        btn.disabled = true;
      });
      // mousedown раньше blur → не теряем клик из‑за закрытия дропдауна
      el.addEventListener('mousedown', e => e.preventDefault());
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
    if (requestSeq !== state.seq.search) return;
    drop.innerHTML = '<div class="s-item" style="color:var(--red);font-size:13px">Ошибка поиска</div>';
    drop.classList.add('open');
  }
}

function closeDrop(clearInput = true) {
  $('search-results')?.classList.remove('open');
  if (clearInput) {
    const input = $('search-input');
    if (input) input.value = '';
  }
}

/* ============================================================================
 * SOCKET EVENTS: profile / friends
 * ==========================================================================*/
socket.on('profile', profile => {
  if (!profile) return;
  state.me = { ...state.me, ...profile };
  localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
  state.unread = Object.assign(Object.create(null), profile.unreadCounts || {});
  state.groupUnread = Object.assign(Object.create(null), profile.groupUnreadCounts || {});
  renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
  setText('my-nick', state.me.nickname);
  setText('my-id', '@' + state.me.id);

  // Пересобираем карту друзей: убираем тех, кого больше нет, сохраняем известные данные
  const friendIds = profile.friends || [];
  const next = Object.create(null);
  friendIds.forEach(fId => {
    next[fId] = state.friends[fId] || { id: fId, nickname: fId, online: false };
  });
  state.friends = next;

  renderRequests(profile.friendRequests || []);
  renderFriendsList();
  fetchNicknames(friendIds);

  if (state.activeFriend) {
    if (state.friends[state.activeFriend]) openChat(state.activeFriend);
    else closeActiveChat();
  }
  loadGroups().then(() => {
    if (state.activeGroup) {
      if (state.groups[state.activeGroup]) openGroupChat(state.activeGroup);
      else closeActiveChat();
    }
  });
});

async function fetchNicknames(ids) {
  if (!ids.length) return;
  const results = await Promise.allSettled(
    ids.map(id =>
      authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(id)).then(async res => {
        if (!res.ok) throw new Error('not ok');
        return { id, data: await res.json() };
      })
    )
  );
  results.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const { id, data: u } = r.value;
    if (!state.friends[id]) return; // за время запроса перестал быть другом
    state.friends[id] = { ...state.friends[id], id, nickname: u.nickname || id, avatar: u.avatar || null, online: !!u.online };
  });
  renderFriendsList();
  if (state.activeFriend && state.friends[state.activeFriend]) {
    const f = state.friends[state.activeFriend];
    renderAv($('chat-avatar'), f.nickname, f.avatar);
    setText('chat-nick', f.nickname);
    updateStatus(f.id, f.online);
  }
}

socket.on('friendRequest', req => {
  if (!state.me || !req) return;
  if (!state.me.friendRequests) state.me.friendRequests = [];
  const already = state.me.friendRequests.some(r => (r.id || r) === req.id);
  if (!already) {
    state.me.friendRequests.push({ id: req.id, nickname: req.nickname, avatar: req.avatar });
    renderRequests(state.me.friendRequests);
    showTransientNotice(`Заявка в друзья от ${req.nickname || req.id}`);
  }
});

socket.on('requestSent', () => {});

socket.on('friendRequestError', ({ reason, targetId } = {}) => {
  const addBtn = $('btn-add-friend');
  if (addBtn && addBtn.style.display !== 'none') {
    addBtn.textContent = 'Добавить в друзья';
    addBtn.disabled = false;
  }
  if (targetId) {
    const row = document.querySelector(`.s-item[data-uid="${CSS.escape(targetId)}"] .btn-add`);
    if (row) {
      row.textContent = '+ Добавить';
      row.disabled = false;
    }
  } else {
    document.querySelectorAll('#search-results .btn-add:disabled').forEach(btn => {
      if (btn.textContent === 'Отправлено') {
        btn.textContent = '+ Добавить';
        btn.disabled = false;
      }
    });
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
  if (!state.me || !user) return;
  state.friends[user.id] = { id: user.id, nickname: user.nickname || user.id, avatar: user.avatar || null, online: !!user.online };
  if (!state.me.friends) state.me.friends = [];
  if (!state.me.friends.includes(user.id)) state.me.friends.push(user.id);
  if (state.me.friendRequests) {
    state.me.friendRequests = state.me.friendRequests.filter(r => (r.id || r) !== user.id);
    renderRequests(state.me.friendRequests);
  }
  renderFriendsList();
  // Если открыт профиль этого пользователя — спрятать кнопку «Добавить»
  const addBtn = $('btn-add-friend');
  if (addBtn && $('profile-modal')?.style.display === 'flex' &&
      $('profile-modal-id')?.textContent === '@' + user.id) {
    addBtn.style.display = 'none';
  }
});

socket.on('friendRemoved', ({ id } = {}) => {
  if (!id) return;
  if (state.me?.friends) state.me.friends = state.me.friends.filter(fid => fid !== id);
  delete state.friends[id];
  delete state.unread[id];
  renderFriendsList();
  if (state.activeFriend === id) closeActiveChat();
});

function setFriendPresence(id, online) {
  if (!id) return;
  if (state.friends[id]) {
    state.friends[id].online = online;
    updateStatus(id, online);
  }
  // Presence в группах — во ВСЕХ, а не только в открытой (иначе счётчик онлайн в списке врёт)
  let touched = false;
  Object.values(state.groups).forEach(g => {
    const m = (g.members || []).find(x => x.id === id);
    if (m && m.online !== online) { m.online = online; touched = true; }
  });
  if (touched) {
    renderGroupsList();
    const g = state.activeGroup && state.groups[state.activeGroup];
    if (g) {
      updateGroupChatHeader(g);
      renderGroupMembersPanel(g);
    }
  }
}

socket.on('friendOnline', u => setFriendPresence(typeof u === 'string' ? u : u?.id, true));
socket.on('friendOffline', u => setFriendPresence(typeof u === 'string' ? u : u?.id, false));

socket.on('newMessage', ({ chatWith, msg } = {}) => {
  if (!chatWith || !msg) return;
  if (state.activeFriend === chatWith) {
    appendMsg(msg, 'messages');
    if (document.visibilityState === 'visible') socket.emit('markRead', chatWith);
  } else {
    state.unread[chatWith] = (state.unread[chatWith] || 0) + 1;
    refreshFriendItem(chatWith);
    updateTitleBadge();
  }
});

// Удаление сообщения — работает и в DM, и в группах (оба используют .g-msg)
socket.on('messageDeleted', ({ messageId } = {}) => {
  if (!messageId) return;
  const wrap = document.querySelector(`[data-msgid="${CSS.escape(messageId)}"]`);
  if (!wrap) return;
  wrap.classList.add('deleted');
  wrap.querySelector('.msg-del-btn')?.remove();
  const text = wrap.querySelector('.g-msg-text');
  if (text) text.textContent = 'Сообщение удалено';
});

socket.on('rateLimited', kind => {
  if (kind === 'sendMessage') showTransientNotice('Слишком много сообщений, подождите немного');
  else showTransientNotice('Слишком много действий, подождите');
});

socket.on('sendMessageError', ({ reason } = {}) => {
  const messages = {
    image_too_large: 'Изображение слишком большое',
    text_too_long: 'Сообщение слишком длинное',
    not_friends: 'Вы не друзья с этим пользователем',
    blocked: 'Невозможно отправить сообщение',
  };
  showTransientNotice(messages[reason] || 'Не удалось отправить сообщение');
});

/* ============================================================================
 * SOCKET EVENTS: groups
 * ==========================================================================*/
socket.on('addedToGroup', ({ group } = {}) => {
  if (!group?.id) return;
  state.groups[group.id] = group;
  renderGroupsList();
  showTransientNotice(`Вас добавили в группу «${group.name}»`);
});

socket.on('groupVoiceState', ({ groupId, callId, video, participants } = {}) => {
  if (!groupId) return;
  if (!callId) delete state.groupVoiceCalls[groupId];
  else state.groupVoiceCalls[groupId] = { callId, video: !!video, participants: participants || [] };
  renderGroupsList();
  updateGroupVoiceBar(groupId);
});

socket.on('callStateChanged', ({ callId, groupId, participants } = {}) => {
  if (!groupId || !callId) return;
  const call = state.groupVoiceCalls[groupId];
  if (call && call.callId === callId) {
    call.participants = participants || call.participants;
    renderGroupsList();
    updateGroupVoiceBar(groupId);
  }
});

socket.on('groupUpdated', ({ groupId, name, avatar } = {}) => {
  const group = state.groups[groupId];
  if (!group) { loadGroups(); return; }
  if (typeof name === 'string') group.name = name;
  if (avatar !== undefined) group.avatar = avatar;
  refreshGroupItem(groupId);
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(group);
    renderGroupMembersPanel(group);
    const input = $('group-msg-input');
    if (input) input.placeholder = 'Написать в ' + group.name;
  }
  if (state.infoGroupId === groupId) openGroupInfoModal(groupId);
});

socket.on('newGroupMessage', ({ groupId, msg } = {}) => {
  if (!groupId || !msg) return;
  if (state.activeGroup === groupId) {
    appendGroupMsg(msg);
    if (document.visibilityState === 'visible') socket.emit('markGroupRead', groupId);
  } else {
    state.groupUnread[groupId] = (state.groupUnread[groupId] || 0) + 1;
    refreshGroupItem(groupId);
    updateTitleBadge();
  }
});

socket.on('groupMemberJoined', ({ groupId, user } = {}) => {
  const g = state.groups[groupId];
  if (!g || !user) return;
  if (!g.members) g.members = [];
  if (!g.members.some(m => m.id === user.id)) g.members.push(user);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
    showTransientNotice(`${user.nickname || user.id} присоединился к группе`);
  }
  if (state.infoGroupId === groupId) renderGroupInfoMembers(g);
});

socket.on('groupMemberLeft', ({ groupId, userId } = {}) => {
  const g = state.groups[groupId];
  if (!g) return;
  if (userId === state.me?.id) {
    // Нас исключили / мы вышли
    delete state.groups[groupId];
    delete state.groupUnread[groupId];
    delete state.groupVoiceCalls[groupId];
    renderGroupsList();
    if (state.activeGroup === groupId) closeActiveChat();
    if (state.infoGroupId === groupId) closeGroupInfoModal();
    if (callState.active && callState.isGroup && callState.groupId === groupId) hangupCall();
    showTransientNotice(`Вы больше не участник группы «${g.name}»`);
    return;
  }
  g.members = (g.members || []).filter(m => m.id !== userId);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
  }
  if (state.infoGroupId === groupId) renderGroupInfoMembers(g);
});

socket.on('groupDeleted', ({ groupId } = {}) => {
  if (!groupId) return;
  const name = state.groups[groupId]?.name;
  delete state.groups[groupId];
  delete state.groupUnread[groupId];
  delete state.groupVoiceCalls[groupId];
  renderGroupsList();
  updateTitleBadge();
  if (state.activeGroup === groupId) closeActiveChat();
  if (state.infoGroupId === groupId) closeGroupInfoModal();
  if (callState.active && callState.isGroup && callState.groupId === groupId) hangupCall();
  if (name) showTransientNotice(`Группа «${name}» удалена`);
});

socket.on('groupError', ({ reason } = {}) => {
  const messages = {
    not_found: 'Группа не найдена',
    not_member: 'Вы не участник группы',
    not_owner: 'Только владелец может это делать',
    limit_reached: 'Достигнут лимит участников',
    not_friends: 'Можно добавлять только друзей',
    already_member: 'Пользователь уже в группе',
    blocked: 'Невозможно добавить пользователя',
    rate_limited: 'Слишком много действий, подождите',
    text_too_long: 'Сообщение слишком длинное',
  };
  showTransientNotice(messages[reason] || 'Ошибка группы');
});

/* ============================================================================
 * RENDER: friend requests
 * ==========================================================================*/
function renderRequests(reqs) {
  const sec = $('requests-section');
  const list = $('requests-list');
  if (!sec || !list) return;
  if (!reqs || !reqs.length) {
    sec.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  sec.style.display = 'block';
  setText('req-badge', String(reqs.length));
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
        <button class="btn-ok" type="button" title="Принять">✓</button>
        <button class="btn-no" type="button" title="Отклонить">✕</button>
      </div>`;
    renderAv(el.querySelector('.f-av'), nick, r.avatar || null);
    el.querySelector('.btn-ok').onclick = e => { e.stopPropagation(); socket.emit('acceptFriendRequest', id); };
    el.querySelector('.btn-no').onclick = e => { e.stopPropagation(); socket.emit('declineFriendRequest', id); };
    el.addEventListener('click', () => showUserProfile(id));
    list.appendChild(el);
  });
}

/* ============================================================================
 * RENDER: friends list
 * ==========================================================================*/
function renderFriendsList() {
  const list = $('friends-list');
  if (!list) return;
  const ids = Object.keys(state.friends);
  if (!ids.length) {
    list.innerHTML = emptyFriendsHTML();
    updateTitleBadge();
    return;
  }
  list.innerHTML = '';
  ids.forEach(id => {
    const el = buildFriendEl(id);
    if (el) list.appendChild(el);
  });
  updateTitleBadge();
}

function buildFriendEl(id) {
  const f = state.friends[id];
  if (!f) return null;
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
    ${u ? `<div class="f-unread">${u > 99 ? '99+' : u}</div>` : ''}`;

  const avEl = el.querySelector('.f-av');
  avEl.style.position = 'relative';
  renderAv(avEl, f.nickname, f.avatar);
  if (f.online) {
    const dot = document.createElement('div');
    dot.className = 'f-dot';
    avEl.appendChild(dot);
  }

  el.onclick = () => openChat(id);
  return el;
}

// Обновляет одну строку НА МЕСТЕ (без перестановки в конец списка)
function refreshFriendItem(id) {
  const list = $('friends-list');
  if (!list) return;
  if (list.querySelector('.empty-state')) { renderFriendsList(); return; }
  const old = list.querySelector(`[data-fid="${CSS.escape(id)}"]`);
  const fresh = buildFriendEl(id);
  if (!fresh) { old?.remove(); if (!list.children.length) renderFriendsList(); return; }
  if (old) old.replaceWith(fresh);
  else list.appendChild(fresh);
}

function updateStatus(id, online) {
  refreshFriendItem(id);
  if (state.activeFriend === id) {
    const st = $('chat-status');
    if (st) {
      st.textContent = online ? '● онлайн' : 'офлайн';
      st.className = 'chat-head-status' + (online ? ' on' : '');
    }
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
    if (!Array.isArray(list)) return;
    const next = Object.create(null);
    list.forEach(g => { if (g?.id) next[g.id] = g; });
    state.groups = next;
    renderGroupsList();
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Не удалось загрузить группы');
  }
}

function renderGroupsList() {
  const list = $('groups-list');
  if (!list) return;
  const ids = Object.keys(state.groups);
  if (!ids.length) {
    list.innerHTML = emptyGroupsHTML();
    updateTitleBadge();
    return;
  }
  list.innerHTML = '';
  ids.forEach(id => {
    const el = buildGroupEl(id);
    if (el) list.appendChild(el);
  });
  updateTitleBadge();
}

function memberName(g, peerId) {
  if (peerId === state.me?.id) return state.me.nickname || peerId;
  return g?.members?.find(m => m.id === peerId)?.nickname || state.friends[peerId]?.nickname || peerId;
}

function buildGroupEl(id) {
  const g = state.groups[id];
  if (!g) return null;
  const u = state.groupUnread[id] || 0;
  const members = g.members || [];
  const onlineCount = members.filter(m => m.online).length;
  const voice = state.groupVoiceCalls[id];
  const voiceMembers = voice ? voice.participants.map(pid => memberName(g, pid)) : [];
  const inThisCall = voice && callState.active && callState.callId === voice.callId;

  const el = document.createElement('div');
  el.className = 'friend-item group-item' + (state.activeGroup === id ? ' active' : '');
  el.dataset.gid = id;
  el.innerHTML = `
    <div class="f-av group-av-slot"></div>
    <div class="f-info">
      <div class="f-nick">${esc(g.name)}</div>
      <div class="f-stat">${members.length} уч. · ${onlineCount} онлайн</div>
    </div>
    ${u ? `<div class="f-unread">${u > 99 ? '99+' : u}</div>` : ''}
    ${voice ? `<div class="group-voice-channel" data-voice-group="${esc(id)}">
      <div class="group-voice-channel-head">
        <span class="group-voice-channel-icon">♫</span>
        <span class="group-voice-channel-name">Голосовой канал</span>
        <span class="group-voice-channel-count">${voice.participants.length}</span>
      </div>
      <div class="group-voice-channel-members">${voiceMembers.length
        ? voiceMembers.map(name => `<span class="group-voice-member"><i></i>${esc(name)}</span>`).join('')
        : '<span class="group-voice-member empty">Канал активен</span>'}</div>
      <button class="group-voice-channel-join" type="button" ${inThisCall || callState.active ? 'disabled' : ''}>${inThisCall ? 'Вы в канале' : 'Войти'}</button>
    </div>` : ''}`;

  renderGroupAv(el.querySelector('.group-av-slot'), g);
  el.onclick = () => openGroupChat(id);
  const joinButton = el.querySelector('.group-voice-channel-join');
  if (joinButton) {
    joinButton.onclick = event => {
      event.stopPropagation();
      joinExistingGroupVoice(id);
    };
  }
  return el;
}

function refreshGroupItem(id) {
  const list = $('groups-list');
  if (!list) return;
  if (list.querySelector('.empty-state')) { renderGroupsList(); return; }
  const old = list.querySelector(`[data-gid="${CSS.escape(id)}"]`);
  const fresh = buildGroupEl(id);
  if (!fresh) { old?.remove(); if (!list.children.length) renderGroupsList(); return; }
  if (old) old.replaceWith(fresh);
  else list.appendChild(fresh);
}

/* ============================================================================
 * MOBILE VIEW HELPER
 * ==========================================================================*/
function enterMobileChatView(backBtnId) {
  if (window.innerWidth > 640) return;
  document.querySelector('.sidebar')?.classList.add('hidden');
  document.querySelector('.chat-main')?.classList.remove('hidden');
  setDisplay(backBtnId, '');
}

/* ============================================================================
 * DM CHAT
 * ==========================================================================*/
async function openChat(id) {
  if (!state.me || !id) return;
  const prevGroup = state.activeGroup;
  state.activeFriend = id;
  state.activeGroup = null;
  state.unread[id] = 0;
  updateTitleBadge();

  document.querySelectorAll('.friend-item').forEach(el =>
    el.classList.toggle('active', el.dataset.fid === id)
  );
  refreshFriendItem(id);
  if (prevGroup) refreshGroupItem(prevGroup);

  const f = state.friends[id] || { id, nickname: id, online: false };
  renderAv($('chat-avatar'), f.nickname, f.avatar);
  setText('chat-nick', f.nickname);
  const st = $('chat-status');
  if (st) {
    st.textContent = f.online ? '● онлайн' : 'офлайн';
    st.className = 'chat-head-status' + (f.online ? ' on' : '');
  }

  setDisplay('chat-placeholder', 'none');
  setDisplay('group-chat-window', 'none');
  setDisplay('group-voice-bar', 'none');
  setDisplay('chat-window', 'flex');

  enterMobileChatView('btn-back');
  syncVoiceOverlayPosition();

  const box = $('messages');
  if (!box) return;
  box.innerHTML = placeholderHTML('Загрузка…');

  const requestSeq = ++state.seq.chat;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(state.me.id)}/${encodeURIComponent(id)}`);
    if (requestSeq !== state.seq.chat) return;
    if (!res.ok) throw new Error('history failed');
    const history = await res.json();
    if (requestSeq !== state.seq.chat) return;
    box.innerHTML = '';
    if (!Array.isArray(history) || !history.length) {
      box.innerHTML = placeholderHTML('Напишите первым! 👋');
    } else {
      history.forEach(m => appendMsg(m, 'messages', false));
    }
    scrollMsgs('messages');
  } catch (e) {
    if (requestSeq !== state.seq.chat) return;
    if (e instanceof AuthError) return;
    box.innerHTML = placeholderHTML('Ошибка загрузки', true);
  }
  socket.emit('markRead', id);
  $('msg-input')?.focus();
}

/* ============================================================================
 * MESSAGE RENDERING (Discord-style, с группировкой подряд идущих сообщений)
 * ==========================================================================*/
function shouldGroupMsg(container, senderId, timeMs) {
  const last = container.lastElementChild;
  if (!last || !last.dataset || last.dataset.sender === undefined) return false;
  if (last.dataset.sender !== String(senderId)) return false;
  const lastTime = parseInt(last.dataset.time || '0', 10);
  if (!lastTime) return false;
  return Math.abs(timeMs - lastTime) < MSG_GROUP_WINDOW_MS;
}

/**
 * Универсальный рендер сообщения.
 * ctx: { senderNick, senderAvatar, isOwner }
 */
function appendChatMsg(msg, containerId, ctx, doScroll = true) {
  if (!state.me || !msg) return;
  const container = $(containerId);
  if (!container) return;

  const msgId = msg._id || msg.id || '';
  // Дедупликация (история + realtime могут пересечься)
  if (msgId && container.querySelector(`[data-msgid="${CSS.escape(msgId)}"]`)) return;

  clearMsgsPlaceholder(container);

  const senderId = msg.from;
  const isMine = senderId === state.me.id;
  const isDeleted = !!msg.deleted;
  const timeMs = getMsgTimeMs(msg);
  const timeStr = fmtTime(msgTimeRaw(msg));
  const grouped = shouldGroupMsg(container, senderId, timeMs);

  const wrap = document.createElement('div');
  wrap.className = 'g-msg' + (isMine ? ' mine' : '') + (isDeleted ? ' deleted' : '') + (grouped ? ' grouped' : '');
  if (msgId) wrap.dataset.msgid = msgId;
  wrap.dataset.sender = senderId;
  wrap.dataset.time = String(timeMs);

  if (grouped) {
    const slot = document.createElement('div');
    slot.className = 'g-msg-av-slot';
    slot.innerHTML = `<span class="g-msg-hover-time">${esc(timeStr)}</span>`;
    wrap.appendChild(slot);
  } else {
    const avEl = document.createElement('div');
    avEl.className = 'g-msg-av';
    renderAv(avEl, ctx.senderNick, ctx.senderAvatar);
    if (!isMine) {
      avEl.style.cursor = 'pointer';
      avEl.addEventListener('click', () => showUserProfile(senderId));
    }
    wrap.appendChild(avEl);
  }

  const body = document.createElement('div');
  body.className = 'g-msg-body';

  if (!grouped) {
    const head = document.createElement('div');
    head.className = 'g-msg-head';
    head.innerHTML = `
      <span class="g-msg-nick">${esc(ctx.senderNick)}</span>
      ${ctx.isOwner ? CROWN_SVG : ''}
      <span class="g-msg-time">${esc(timeStr)}</span>`;
    body.appendChild(head);
  }

  const text = document.createElement('div');
  text.className = 'g-msg-text';
  text.textContent = isDeleted ? 'Сообщение удалено' : (msg.text || '');
  body.appendChild(text);
  wrap.appendChild(body);

  if (isMine && !isDeleted && msgId) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'msg-del-btn';
    delBtn.title = 'Удалить';
    delBtn.innerHTML = TRASH_SVG;
    delBtn.addEventListener('click', e => { e.stopPropagation(); openDeleteConfirm(msgId); });
    wrap.appendChild(delBtn);
  }

  container.appendChild(wrap);
  if (doScroll) scrollMsgs(containerId);
}

function appendMsg(msg, containerId, doScroll = true) {
  if (!state.me || !msg) return;
  const isMine = msg.from === state.me.id;
  const friend = state.friends[msg.from];
  appendChatMsg(msg, containerId, {
    senderNick: isMine ? state.me.nickname : (friend?.nickname || msg.from),
    senderAvatar: isMine ? state.me.avatar : (friend?.avatar || null),
    isOwner: false,
  }, doScroll);
}

function appendGroupMsg(msg, doScroll = true) {
  if (!state.me || !msg) return;
  const g = state.groups[state.activeGroup];
  const isMine = msg.from === state.me.id;
  const sender = g?.members?.find(m => m.id === msg.from);
  appendChatMsg(msg, 'group-messages', {
    senderNick: sender?.nickname || (isMine ? state.me.nickname : msg.from),
    senderAvatar: sender?.avatar || (isMine ? state.me.avatar : null),
    isOwner: isGroupOwner(g, msg.from),
  }, doScroll);
}

/* ============================================================================
 * GROUP CHAT
 * ==========================================================================*/
async function openGroupChat(groupId) {
  if (!state.me || !groupId || !state.groups[groupId]) return;
  const prevFriend = state.activeFriend;
  state.activeGroup = groupId;
  state.activeFriend = null;
  state.groupUnread[groupId] = 0;
  updateTitleBadge();

  document.querySelectorAll('.friend-item').forEach(el =>
    el.classList.toggle('active', el.dataset.gid === groupId)
  );
  refreshGroupItem(groupId);
  if (prevFriend) refreshFriendItem(prevFriend);

  const g = state.groups[groupId];
  updateGroupChatHeader(g);
  renderGroupMembersPanel(g);
  const input = $('group-msg-input');
  if (input) input.placeholder = 'Написать в ' + g.name;

  setDisplay('chat-placeholder', 'none');
  setDisplay('chat-window', 'none');
  setDisplay('group-chat-window', 'flex');
  socket.emit('watchGroupVoice', { groupId });
  updateGroupVoiceBar(groupId);

  enterMobileChatView('btn-back-group');
  syncVoiceOverlayPosition();

  const box = $('group-messages');
  if (!box) return;
  box.innerHTML = placeholderHTML('Загрузка…');

  const requestSeq = ++state.seq.groupChat;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/groups/${encodeURIComponent(groupId)}/messages`);
    if (requestSeq !== state.seq.groupChat) return;
    if (!res.ok) throw new Error('history failed');
    const history = await res.json();
    if (requestSeq !== state.seq.groupChat) return;
    box.innerHTML = '';
    if (!Array.isArray(history) || !history.length) {
      box.innerHTML = placeholderHTML('Начните общение в группе! 👋');
    } else {
      history.forEach(m => appendGroupMsg(m, false));
    }
    scrollMsgs('group-messages');
  } catch (e) {
    if (requestSeq !== state.seq.groupChat) return;
    if (e instanceof AuthError) return;
    box.innerHTML = placeholderHTML('Ошибка загрузки', true);
  }
  socket.emit('markGroupRead', groupId);
  input?.focus();
}

function updateGroupVoiceBar(groupId) {
  const bar = $('group-voice-bar');
  if (!bar) return;
  const isCurrent = !!groupId && state.activeGroup === groupId;
  bar.style.display = isCurrent ? 'flex' : 'none';
  if (!isCurrent) return;

  const call = state.groupVoiceCalls[groupId];
  const g = state.groups[groupId];
  setText('group-voice-count', call
    ? `${call.participants.length} в голосовом канале`
    : 'Голосовой канал · никто не подключён');

  const members = $('group-voice-members');
  if (members) {
    members.innerHTML = '';
    (call?.participants || []).forEach(peerId => {
      const member = g?.members?.find(item => item.id === peerId) || (peerId === state.me?.id ? state.me : null);
      const nick = member?.nickname || peerId;
      const avatar = document.createElement('div');
      avatar.className = 'group-voice-member-avatar';
      avatar.title = nick;
      if (member?.avatar) {
        avatar.style.backgroundImage = `url("${String(member.avatar).replace(/["\\]/g, '\\$&')}")`;
      } else {
        avatar.textContent = av(nick);
      }
      members.appendChild(avatar);
    });
  }

  const join = $('btn-join-group-voice');
  if (join) {
    const inThis = !!(callState.active && call && callState.callId === call.callId);
    join.textContent = inThis ? 'Вы в канале' : call ? 'Войти' : 'Подключиться';
    join.disabled = inThis || callState.active;
  }
}

function updateGroupChatHeader(g) {
  if (!g) return;
  renderGroupAv($('group-chat-avatar'), g);
  setText('group-chat-name', g.name);
  const members = g.members || [];
  const onlineCount = members.filter(m => m.online).length;
  setText('group-chat-members-count', `${members.length} участников · ${onlineCount} онлайн`);
}

on('group-chat-head-click', 'click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});
on('btn-group-info', 'click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});

/* ============================================================================
 * SEND MESSAGES
 * ==========================================================================*/
on('btn-send', 'click', sendMsg);
on('msg-input', 'keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

function sendMsg() {
  const input = $('msg-input');
  if (!input) return;
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

on('btn-group-send', 'click', sendGroupMsg);
on('group-msg-input', 'keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGroupMsg(); }
});

function sendGroupMsg() {
  const input = $('group-msg-input');
  if (!input) return;
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
  setDisplay('delete-confirm', 'flex');
}
function closeDeleteConfirm() {
  state.pendingDeleteId = null;
  setDisplay('delete-confirm', 'none');
}
window.closeDeleteConfirm = closeDeleteConfirm;

on('delete-confirm', 'click', e => {
  if (e.target === $('delete-confirm')) closeDeleteConfirm();
});

on('btn-confirm-delete', 'click', async () => {
  if (!state.pendingDeleteId || !state.me) return;
  const idToDelete = state.pendingDeleteId;
  closeDeleteConfirm();
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(idToDelete)}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await safeJson(res);
      showTransientNotice(d.error || 'Ошибка удаления');
    }
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
});

/* ============================================================================
 * PROFILE: view other user
 * ==========================================================================*/
on('chat-head-click', 'click', () => {
  if (state.activeFriend) showUserProfile(state.activeFriend);
});

async function showUserProfile(userId) {
  if (!userId) return;
  const requestSeq = ++state.seq.profile;
  try {
    const res = await authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(userId));
    if (requestSeq !== state.seq.profile) return;
    if (!res.ok) {
      showTransientNotice(res.status === 404 ? 'Пользователь не найден' : 'Не удалось загрузить профиль');
      return;
    }
    const u = await res.json();
    if (requestSeq !== state.seq.profile) return;

    renderAv($('profile-modal-avatar'), u.nickname, u.avatar);
    setText('profile-modal-nick', u.nickname);
    setText('profile-modal-id', '@' + u.id);

    const onlineBadge = $('profile-modal-online');
    if (onlineBadge) {
      onlineBadge.textContent = u.online ? '● онлайн' : 'офлайн';
      onlineBadge.className = 'modal-online-badge ' + (u.online ? 'online' : 'offline');
    }

    if (u.status) {
      setText('profile-modal-status', u.status);
      setDisplay('profile-modal-status-row', '');
    } else {
      setDisplay('profile-modal-status-row', 'none');
    }
    if (u.bio) {
      setText('profile-modal-bio', u.bio);
      setDisplay('profile-modal-bio-row', '');
    } else {
      setDisplay('profile-modal-bio-row', 'none');
    }

    const isFriend = !!state.me?.friends?.includes(userId);
    const isMe = userId === state.me?.id;

    const addBtn = $('btn-add-friend');
    if (addBtn) {
      addBtn.textContent = 'Добавить в друзья';
      addBtn.disabled = false;
      addBtn.style.display = (isFriend || isMe) ? 'none' : '';
      addBtn.onclick = (!isFriend && !isMe) ? () => {
        socket.emit('sendFriendRequest', userId);
        addBtn.textContent = 'Запрос отправлен';
        addBtn.disabled = true;
      } : null;
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

    setDisplay('profile-modal', 'flex');
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Не удалось загрузить профиль');
  }
}

async function performUnblock(userId) {
  if (!state.me) return;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/unblock`, { method: 'POST' });
    if (!res.ok) return showTransientNotice('Ошибка разблокировки');
    state.me.blockedUsers = (state.me.blockedUsers || []).filter(id => id !== userId);
    showUserProfile(userId);
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
}

async function performBlock(userId) {
  if (!state.me) return;
  if (!confirm(`Заблокировать @${userId}?`)) return;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' });
    if (!res.ok) {
      const d = await safeJson(res);
      return showTransientNotice(d.error || 'Ошибка блокировки');
    }
    if (!state.me.blockedUsers) state.me.blockedUsers = [];
    if (!state.me.blockedUsers.includes(userId)) state.me.blockedUsers = [...state.me.blockedUsers, userId];
    if (state.me.friends) state.me.friends = state.me.friends.filter(id => id !== userId);
    delete state.friends[userId];
    delete state.unread[userId];
    renderFriendsList();
    if (state.activeFriend === userId) closeActiveChat();
    showUserProfile(userId);
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
}

function closeProfileModal() { setDisplay('profile-modal', 'none'); }
window.closeProfileModal = closeProfileModal;

on('profile-modal', 'click', e => {
  if (e.target === $('profile-modal')) closeProfileModal();
});

/* ============================================================================
 * PROFILE: edit own
 * ==========================================================================*/
function openEditProfileModal() {
  if (!state.me) return;
  renderAv($('edit-avatar'), state.me.nickname, state.me.avatar);
  const nick = $('edit-nick'); if (nick) nick.value = state.me.nickname || '';
  const st = $('edit-status'); if (st) st.value = state.me.status || '';
  const bio = $('edit-bio'); if (bio) bio.value = state.me.bio || '';
  setDisplay('edit-profile-modal', 'flex');
}
function closeEditProfileModal() { setDisplay('edit-profile-modal', 'none'); }
window.closeEditProfileModal = closeEditProfileModal;

on('edit-profile-modal', 'click', e => {
  if (e.target === $('edit-profile-modal')) closeEditProfileModal();
});

on('avatar-input', 'change', async e => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file || !state.me) return;
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    showTransientNotice('Разрешены только изображения (jpeg, png, webp, gif)');
    input.value = '';
    return;
  }
  if (file.size > MAX_AVATAR_SIZE) {
    showTransientNotice('Файл слишком большой (максимум 5MB)');
    input.value = '';
    return;
  }
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const res = await authFetch(BACKEND_URL + '/api/upload/avatar', { method: 'POST', body: formData });
    if (!res.ok) {
      const d = await safeJson(res);
      showTransientNotice(d.error || 'Ошибка загрузки аватара');
      return;
    }
    const data = await res.json();
    state.me.avatar = data.avatar;
    localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
    renderAv($('edit-avatar'), state.me.nickname, state.me.avatar);
    renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
    showTransientNotice('Аватар обновлён');
  } catch (err) {
    if (!(err instanceof AuthError)) showTransientNotice('Ошибка сети');
  } finally {
    input.value = '';
  }
});

on('btn-save-profile', 'click', async () => {
  if (!state.me) return;
  const nickname = ($('edit-nick')?.value || '').trim();
  const status = ($('edit-status')?.value || '').trim();
  const bio = ($('edit-bio')?.value || '').trim();
  if (!nickname) return showTransientNotice('Никнейм не может быть пустым');

  await withButtonBusy($('btn-save-profile'), 'Сохранение…', async () => {
    try {
      const res = await authFetch(BACKEND_URL + '/api/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, status, bio }),
      });
      const data = await safeJson(res);
      if (!res.ok) return showTransientNotice(data.error || 'Ошибка сохранения');
      const u = data.user || {};
      state.me.nickname = u.nickname ?? nickname;
      state.me.status = u.status ?? status;
      state.me.bio = u.bio ?? bio;
      localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
      setText('my-nick', state.me.nickname);
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
on('btn-open-blocked', 'click', () => {
  closeEditProfileModal();
  openBlockedUsersModal();
});

async function openBlockedUsersModal() {
  if (!state.me) return;
  setDisplay('blocked-users-modal', 'flex');
  const list = $('blocked-users-list');
  if (!list) return;
  list.innerHTML = '<div class="blocked-users-empty">Загрузка…</div>';
  try {
    const res = await authFetch(BACKEND_URL + '/api/users/blocked');
    if (!res.ok) throw new Error('failed');
    const users = await res.json();
    state.me.blockedUsers = (Array.isArray(users) ? users : []).map(u => u.id);
    renderBlockedUsersList(users);
  } catch (e) {
    if (e instanceof AuthError) return;
    list.innerHTML = '<div class="blocked-users-empty" style="color:var(--red)">Ошибка загрузки</div>';
  }
}
function closeBlockedUsersModal() { setDisplay('blocked-users-modal', 'none'); }
window.closeBlockedUsersModal = closeBlockedUsersModal;

on('blocked-users-modal', 'click', e => {
  if (e.target === $('blocked-users-modal')) closeBlockedUsersModal();
});

function renderBlockedUsersList(users) {
  const list = $('blocked-users-list');
  if (!list) return;
  list.innerHTML = '';
  if (!Array.isArray(users) || !users.length) {
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
      <button class="btn-unblock" type="button">Разблокировать</button>`;
    renderAv(el.querySelector('.f-av'), u.nickname, u.avatar);
    const btn = el.querySelector('.btn-unblock');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(u.id)}/unblock`, { method: 'POST' });
        if (!res.ok) { btn.disabled = false; return showTransientNotice('Ошибка разблокировки'); }
        if (state.me?.blockedUsers) state.me.blockedUsers = state.me.blockedUsers.filter(id => id !== u.id);
        el.remove();
        if (!list.children.length) {
          list.innerHTML = '<div class="blocked-users-empty">Нет заблокированных пользователей</div>';
        }
      } catch (e) {
        btn.disabled = false;
        if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
      }
    });
    list.appendChild(el);
  });
}

/* ============================================================================
 * SHARED PICKER (создание группы / добавление участников)
 * ==========================================================================*/
function renderPicker({ pickerId, countId, ids, selected, emptyText, onChange }) {
  const picker = $(pickerId);
  if (!picker) return;
  if (!ids.length) {
    picker.innerHTML = `<div class="empty-state" style="padding:16px"><div class="empty-sub">${esc(emptyText)}</div></div>`;
    return;
  }
  picker.innerHTML = '';
  ids.forEach(id => {
    const f = state.friends[id];
    if (!f) return;
    const isSel = selected.has(id);
    const el = document.createElement('div');
    el.className = 'picker-item' + (isSel ? ' selected' : '');
    el.innerHTML = `
      <div class="f-av" style="width:32px;height:32px;font-size:12px"></div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:13px">${esc(f.nickname)}</div>
        <div class="f-stat" style="font-size:11px">@${esc(id)}</div>
      </div>
      <div class="picker-check">${isSel ? '✓' : ''}</div>`;
    renderAv(el.querySelector('.f-av'), f.nickname, f.avatar);
    el.addEventListener('click', () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      setText(countId, 'выбрано: ' + selected.size);
      // Точечное обновление вместо полного ререндера
      el.classList.toggle('selected', selected.has(id));
      el.querySelector('.picker-check').textContent = selected.has(id) ? '✓' : '';
      if (onChange) onChange();
    });
    picker.appendChild(el);
  });
}

/* ============================================================================
 * CREATE GROUP MODAL
 * ==========================================================================*/
on('btn-create-group', 'click', () => {
  if (!state.me) return;
  selectedGroupMembers = new Set();
  const nameInput = $('group-name-input');
  if (nameInput) nameInput.value = '';
  setText('group-selected-count', 'выбрано: 0');
  renderGroupFriendsPicker();
  setDisplay('create-group-modal', 'flex');
  nameInput?.focus();
});

function closeCreateGroupModal() { setDisplay('create-group-modal', 'none'); }
window.closeCreateGroupModal = closeCreateGroupModal;

on('create-group-modal', 'click', e => {
  if (e.target === $('create-group-modal')) closeCreateGroupModal();
});

function renderGroupFriendsPicker() {
  renderPicker({
    pickerId: 'group-friends-picker',
    countId: 'group-selected-count',
    ids: Object.keys(state.friends),
    selected: selectedGroupMembers,
    emptyText: 'Сначала добавь друзей',
  });
}

on('group-name-input', 'keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('btn-confirm-create-group')?.click(); }
});

on('btn-confirm-create-group', 'click', async () => {
  const name = ($('group-name-input')?.value || '').trim();
  if (!name || name.length < 2) return showTransientNotice('Название минимум 2 символа');
  if (selectedGroupMembers.size < 1) return showTransientNotice('Выберите хотя бы одного друга');

  await withButtonBusy($('btn-confirm-create-group'), 'Создание…', async () => {
    try {
      const res = await authFetch(BACKEND_URL + '/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberIds: [...selectedGroupMembers] }),
      });
      const data = await safeJson(res);
      if (!res.ok) return showTransientNotice(data.error || 'Ошибка создания группы');
      closeCreateGroupModal();
      if (data.group?.id) state.groups[data.group.id] = data.group;
      await loadGroups();
      switchSidebarTab('groups');
      if (data.group?.id && state.groups[data.group.id]) openGroupChat(data.group.id);
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
  state.infoGroupId = groupId;

  renderGroupAv($('group-info-avatar'), g);
  setText('group-info-name', g.name);
  setText('group-info-created', 'Создана ' + fmtDate(g.createdAt || Date.now()));
  setText('group-info-count', String((g.members || []).length));

  const isOwner = isGroupOwner(g, state.me?.id);
  setDisplay('group-info-owner-actions', isOwner ? '' : 'none');
  const leaveBtn = $('btn-leave-group');
  if (leaveBtn) leaveBtn.textContent = isOwner ? 'Удалить группу' : 'Покинуть группу';

  renderGroupInfoMembers(g);
  setDisplay('group-info-modal', 'flex');
}

function renderGroupInfoMembers(g) {
  const list = $('group-info-members');
  if (!list) return;
  list.innerHTML = '';
  const myId = state.me?.id;
  const iAmOwner = isGroupOwner(g, myId);
  setText('group-info-count', String((g.members || []).length));

  (g.members || []).forEach(m => {
    const memberIsOwner = isGroupOwner(g, m.id);
    const el = document.createElement('div');
    el.className = 'group-member-item';
    el.innerHTML = `
      <div class="f-av" style="width:32px;height:32px;font-size:12px"></div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:13px">${esc(m.nickname)} ${memberIsOwner ? '<span class="owner-badge" title="Владелец">👑</span>' : ''}</div>
        <div class="f-stat" style="font-size:11px">@${esc(m.id)}</div>
      </div>
      ${m.id !== myId && iAmOwner ? '<button class="btn-kick" type="button" title="Удалить из группы">✕</button>' : ''}`;

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

function closeGroupInfoModal() {
  state.infoGroupId = null;
  setDisplay('group-info-modal', 'none');
}
window.closeGroupInfoModal = closeGroupInfoModal;

on('group-info-modal', 'click', e => {
  if (e.target === $('group-info-modal')) closeGroupInfoModal();
});

on('btn-leave-group', 'click', () => {
  const groupId = state.infoGroupId || state.activeGroup;
  const g = groupId && state.groups[groupId];
  if (!g) return;
  const isOwner = isGroupOwner(g, state.me?.id);
  const msg = isOwner
    ? 'Вы владелец группы. Группа будет УДАЛЕНА для всех. Продолжить?'
    : 'Покинуть группу?';
  if (!confirm(msg)) return;
  socket.emit('leaveGroup', groupId);
  closeGroupInfoModal();
});

/* ============================================================================
 * ADD MEMBERS MODAL
 * ==========================================================================*/
function openAddMembersModal() {
  const groupId = state.infoGroupId || state.activeGroup;
  if (!groupId || !state.groups[groupId]) return;
  selectedAddMembers = new Set();
  setText('add-members-count', 'выбрано: 0');
  renderAddMembersPicker(groupId);
  $('add-members-modal').dataset.gid = groupId;
  setDisplay('add-members-modal', 'flex');
}

on('btn-add-members', 'click', () => {
  const gid = state.infoGroupId;
  closeGroupInfoModal();
  state.infoGroupId = gid; // сохраняем контекст для picker
  openAddMembersModal();
  state.infoGroupId = null;
});

on('btn-invite-group', 'click', openAddMembersModal);

function closeAddMembersModal() { setDisplay('add-members-modal', 'none'); }
window.closeAddMembersModal = closeAddMembersModal;

on('add-members-modal', 'click', e => {
  if (e.target === $('add-members-modal')) closeAddMembersModal();
});

function renderAddMembersPicker(groupId) {
  const g = state.groups[groupId];
  if (!g) return;
  const memberIds = new Set((g.members || []).map(m => m.id));
  renderPicker({
    pickerId: 'add-members-picker',
    countId: 'add-members-count',
    ids: Object.keys(state.friends).filter(id => !memberIds.has(id)),
    selected: selectedAddMembers,
    emptyText: 'Все друзья уже в группе',
  });
}

on('btn-confirm-add-members', 'click', () => {
  const groupId = $('add-members-modal')?.dataset.gid || state.activeGroup;
  if (!groupId || !selectedAddMembers.size) return;
  selectedAddMembers.forEach(userId => {
    socket.emit('addGroupMember', { groupId, userId });
  });
  closeAddMembersModal();
  showTransientNotice('Приглашения отправлены');
});

/* ============================================================================
 * MEMBERS PANEL (правая колонка)
 * ==========================================================================*/
function renderGroupMembersPanel(g) {
  if (!g) return;
  const countEl = $('gm-count');
  const list = $('group-members-list');
  if (!countEl || !list) return;

  countEl.textContent = (g.members || []).length;
  list.innerHTML = '';

  // Владелец сверху, потом онлайн, потом офлайн, по алфавиту
  const sorted = [...(g.members || [])].sort((a, b) => {
    const aOwner = isGroupOwner(g, a.id);
    const bOwner = isGroupOwner(g, b.id);
    if (aOwner !== bOwner) return aOwner ? -1 : 1;
    if (!!a.online !== !!b.online) return a.online ? -1 : 1;
    return (a.nickname || '').localeCompare(b.nickname || '', 'ru');
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

  setDisplay('btn-invite-group', isGroupOwner(g, state.me?.id) ? '' : 'none');
}

on('btn-toggle-members', 'click', () => {
  $('group-members-panel')?.classList.toggle('hidden');
});

/* ============================================================================
 * MOBILE BACK BUTTONS / RESIZE / KEYBOARD
 * ==========================================================================*/
on('btn-back', 'click', goBackMobile);
on('btn-back-group', 'click', goBackMobile);

function goBackMobile() {
  const prevFriend = state.activeFriend;
  const prevGroup = state.activeGroup;
  closeActiveChat();
  document.querySelector('.sidebar')?.classList.remove('hidden');
  document.querySelector('.chat-main')?.classList.add('hidden');
  if (prevFriend) refreshFriendItem(prevFriend);
  if (prevGroup) refreshGroupItem(prevGroup);
}

window.addEventListener('resize', () => {
  syncVoiceOverlayPosition();
  if (window.innerWidth > 640) {
    document.querySelector('.sidebar')?.classList.remove('hidden');
    document.querySelector('.chat-main')?.classList.remove('hidden');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeAllModals();
    closeDrop(false);
  }
});

// При возврате на вкладку помечаем открытый чат прочитанным
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me) return;
  if (state.activeFriend) socket.emit('markRead', state.activeFriend);
  if (state.activeGroup) socket.emit('markGroupRead', state.activeGroup);
});

/* ============================================================================
 * AUTO-LOGIN
 * ==========================================================================*/
(() => {
  const token = localStorage.getItem('chatapp_token');
  const cached = localStorage.getItem('chatapp_profile');
  if (token && cached) {
    try {
      const me = JSON.parse(cached);
      if (!me || !me.id) throw new Error('bad cache');
      state.me = me;
      enterApp(me);
      return;
    } catch (e) {
      localStorage.removeItem('chatapp_profile');
    }
  }
  document.documentElement.classList.remove('has-session');
})();

/* ============================================================================
 * SOCKET CONNECTION ERROR HANDLING
 * ==========================================================================*/
let lastConnNoticeAt = 0;
socket.on('connect_error', err => {
  console.error('Socket error:', err);
  if (err?.message === 'Unauthorized') {
    forceLogoutToLogin('Сессия истекла, войдите снова');
    return;
  }
  // Не спамим уведомлением на каждую попытку реконнекта
  const now = Date.now();
  if (now - lastConnNoticeAt > 15000) {
    lastConnNoticeAt = now;
    showTransientNotice('Нет соединения с сервером');
  }
});

socket.on('connect', () => {
  lastConnNoticeAt = 0;
});

socket.on('disconnect', reason => {
  console.warn('Socket disconnected:', reason);
  if (reason === 'io client disconnect') return;
  showTransientNotice('Соединение потеряно, переподключение…');
  // Сигнальный канал потерян — сервер удалит нас из звонка; завершаем локально.
  if (callState.active || callState.pendingIncoming) closeCallOverlay();
});

window.addEventListener('beforeunload', () => {
  if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
});

/* ============================================================================
 * CALLS (WebRTC: DM 1:1 + Group mesh)
 * ==========================================================================*/
function callPeerName(peerId) {
  if (callState.isGroup) return memberName(state.groups[callState.groupId], peerId);
  const f = state.friends[peerId];
  return f?.nickname || (peerId === callState.peerFriendId ? callState.peerFriendName : null) || peerId;
}

function callPeerAvatar(peerId) {
  if (callState.isGroup) {
    const g = state.groups[callState.groupId];
    return g?.members?.find(m => m.id === peerId)?.avatar || state.friends[peerId]?.avatar || null;
  }
  return state.friends[peerId]?.avatar || null;
}

/** Захват локального потока. При недоступной камере — fallback на аудио. */
async function acquireLocalStream(video) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS, video: !!video });
  } catch (e) {
    if (!video) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS, video: false });
    showTransientNotice('Камера недоступна — звонок без видео');
  }
  stream.getAudioTracks().forEach(track => {
    const s = typeof track.getSettings === 'function' ? track.getSettings() : {};
    if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) {
      console.warn('Browser did not apply raw microphone constraints', s);
    }
  });
  return stream;
}

function beginCallSession({ stream, callId = null, chatKey = null, isGroup, groupId = null, peerFriendId = null, peerFriendName = null, video }) {
  callState.localStream = stream;
  callState.callId = callId;
  callState.chatKey = chatKey;
  callState.isGroup = !!isGroup;
  callState.groupId = groupId;
  callState.peerFriendId = peerFriendId;
  callState.peerFriendName = peerFriendName;
  callState.video = !!video;
  callState.micOn = true;
  callState.camOn = true;
  callState.peers = Object.create(null);
  callState.pendingIncoming = null;
  clearTimeout(callState.incomingTimer);
}

async function startCall({ toId, groupId, video }) {
  if (callState.active || callState.pendingIncoming) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  // Если в группе уже идёт канал — присоединяемся, а не создаём новый (иначе 'busy')
  if (groupId && state.groupVoiceCalls[groupId]) {
    joinExistingGroupVoice(groupId);
    return;
  }
  let stream;
  try {
    stream = await acquireLocalStream(video);
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    return;
  }
  beginCallSession({
    stream, isGroup: !!groupId, groupId: groupId || null,
    peerFriendId: toId || null,
    peerFriendName: toId ? (state.friends[toId]?.nickname || toId) : null,
    video,
  });
  socket.emit('callStart', { toId, groupId, video: !!video });
  openCallOverlay('соединение…');

  if (!groupId) {
    clearTimeout(callState.ringTimer);
    callState.ringTimer = setTimeout(() => {
      if (callState.active && !Object.keys(callState.peers).length) {
        showTransientNotice('Нет ответа');
        hangupCall();
      }
    }, CALL_RING_TIMEOUT_MS);
  }
}

function joinExistingGroupVoice(groupId) {
  const call = state.groupVoiceCalls[groupId];
  if (!call) return;
  if (callState.active || callState.pendingIncoming) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  startExistingCall(call, groupId);
}

async function startExistingCall(call, groupId) {
  let stream;
  try {
    stream = await acquireLocalStream(call.video);
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    return;
  }
  beginCallSession({ stream, callId: call.callId, isGroup: true, groupId, video: call.video });
  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: call.callId });
}

function hangupCall() {
  if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
  closeCallOverlay();
}

function resetCallControls() {
  const mic = $('btn-call-toggle-mic');
  if (mic) {
    mic.classList.remove('active-off');
    mic.title = 'Выключить микрофон';
    mic.setAttribute('aria-label', mic.title);
  }
  const cam = $('btn-call-toggle-cam');
  if (cam) {
    cam.classList.remove('active-off');
    cam.title = 'Выключить камеру';
    cam.setAttribute('aria-label', cam.title);
    cam.disabled = !callState.video;
  }
}

function openCallOverlay(statusText) {
  callState.active = true;
  const overlay = $('call-overlay');
  if (!overlay) return;
  overlay.classList.toggle('voice-mode', !callState.video);
  overlay.classList.toggle('video-mode', callState.video);
  setText('call-overlay-mode', callState.video ? 'ВИДЕОКАНАЛ' : 'ГОЛОСОВОЙ КАНАЛ');
  overlay.style.display = 'flex';
  syncVoiceOverlayPosition();
  setText('call-overlay-title', callState.isGroup
    ? (state.groups[callState.groupId]?.name || 'Групповой звонок')
    : callPeerName(callState.peerFriendId));
  setText('call-overlay-status', statusText || '');
  resetCallControls();
  renderCallGrid();
  if (callState.isGroup) {
    updateGroupVoiceBar(callState.groupId);
    renderGroupsList();
  }
}

function syncVoiceOverlayPosition() {
  const overlay = $('call-overlay');
  const sidebar = document.querySelector('.sidebar');
  if (!overlay || !sidebar || overlay.style.display === 'none') return;

  const chatWindow = [...document.querySelectorAll('.chat-window')]
    .find(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
  const chatHead = chatWindow?.querySelector('.chat-head');
  const top = chatHead ? chatHead.getBoundingClientRect().bottom : 0;
  overlay.style.setProperty('--call-top', `${Math.max(0, top)}px`);
  if (window.innerWidth <= 640) {
    overlay.style.setProperty('--call-left', '0px');
    return;
  }
  const rect = sidebar.getBoundingClientRect();
  const sidebarVisible = rect.width > 0 && !sidebar.classList.contains('hidden');
  overlay.style.setProperty('--call-left', sidebarVisible ? `${rect.right}px` : '0px');
}

function closeCallOverlay() {
  const overlay = $('call-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('voice-mode', 'video-mode');
    overlay.style.removeProperty('--call-left');
    overlay.style.removeProperty('--call-top');
  }
  setDisplay('incoming-call-modal', 'none');
  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);

  stopAllSpeakingMonitors();

  if (callState.localStream) {
    callState.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  }
  Object.values(callState.peers).forEach(p => {
    try { p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.close(); } catch (e) {}
  });

  const wasGroupId = callState.isGroup ? callState.groupId : null;

  callState.active = false;
  callState.callId = null;
  callState.chatKey = null;
  callState.isGroup = false;
  callState.groupId = null;
  callState.peerFriendId = null;
  callState.peerFriendName = null;
  callState.video = false;
  callState.localStream = null;
  callState.micOn = true;
  callState.camOn = true;
  callState.peers = Object.create(null);
  callState.pendingIncoming = null;

  const grid = $('call-video-grid');
  if (grid) grid.innerHTML = '';
  resetCallControls();

  if (wasGroupId) {
    updateGroupVoiceBar(wasGroupId);
    renderGroupsList();
  }
}

/* ── Сетка участников: инкрементальное обновление (без пересоздания <video>) ── */
function renderCallGrid() {
  const grid = $('call-video-grid');
  if (!grid || !callState.active) return;

  const entries = [{ id: 'local', nick: state.me?.nickname || 'Я', avatar: state.me?.avatar || null, stream: callState.localStream, isLocal: true }];
  for (const [peerId, p] of Object.entries(callState.peers)) {
    entries.push({ id: peerId, nick: callPeerName(peerId), avatar: callPeerAvatar(peerId), stream: p.stream, isLocal: false });
  }

  const seen = new Set();
  entries.forEach(({ id, nick, avatar, stream, isLocal }) => {
    seen.add(id);
    let tile = grid.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.dataset.peer = id;
      grid.appendChild(tile);
    }
    updateCallTile(tile, nick, avatar, stream, isLocal);
    ensureSpeakingMonitor(id, stream);
  });

  grid.querySelectorAll('.call-tile').forEach(t => { if (!seen.has(t.dataset.peer)) t.remove(); });
  Object.keys(speakingMonitors).forEach(id => { if (!seen.has(id)) stopSpeakingMonitor(id); });

  const cnt = Object.keys(callState.peers).length;
  grid.dataset.count = String(cnt + 1);
}

function updateCallTile(tile, nickname, avatarUrl, stream, isLocal) {
  const hasVideo = callState.video && !!stream &&
    stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live' && !(t.muted && !isLocal));
  const speaking = tile.classList.contains('speaking');
  tile.className = 'call-tile' + (isLocal ? ' local' : '') + (hasVideo ? '' : ' audio-only') + (speaking ? ' speaking' : '');

  let video = tile.querySelector('video');
  if (stream) {
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      tile.prepend(video);
    }
    video.muted = isLocal;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.play?.().catch(() => {});
    }
  } else if (video) {
    video.srcObject = null;
    video.remove();
  }

  let avWrap = tile.querySelector('.call-tile-avatar');
  if (!avWrap) {
    avWrap = document.createElement('div');
    avWrap.className = 'call-tile-avatar';
    tile.appendChild(avWrap);
  }
  const avKey = `${nickname}|${avatarUrl || ''}`;
  if (avWrap.dataset.key !== avKey) {
    renderAv(avWrap, nickname, avatarUrl);
    avWrap.dataset.key = avKey;
  }

  let label = tile.querySelector('.call-tile-nick');
  if (!label) {
    label = document.createElement('div');
    label.className = 'call-tile-nick';
    tile.appendChild(label);
  }
  label.textContent = nickname;

  // Бейдж выключенного микрофона — только у себя (чужой статус достоверно неизвестен)
  let badge = tile.querySelector('.call-tile-mic-off');
  if (isLocal && !callState.micOn) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'call-tile-mic-off';
      badge.title = 'Микрофон выключен';
      badge.innerHTML = MIC_OFF_SVG;
      tile.insertBefore(badge, label);
    }
  } else if (badge) {
    badge.remove();
  }
}

/* ── Индикатор «говорит сейчас» (Web Audio, один общий AudioContext) ────── */
const SPEAKING_THRESHOLD_ON = 0.06;
const SPEAKING_THRESHOLD_OFF = 0.035;
let audioCtx = null;

function getAudioCtx() {
  if (audioCtx && audioCtx.state !== 'closed') {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    audioCtx = null;
  }
  return audioCtx;
}

function setSpeakingUI(id, isSpeaking) {
  const tile = document.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`);
  if (tile) tile.classList.toggle('speaking', isSpeaking);
}

function stopSpeakingMonitor(id) {
  const mon = speakingMonitors[id];
  if (!mon) return;
  cancelAnimationFrame(mon.raf);
  try { mon.source.disconnect(); } catch (e) {}
  try { mon.analyser.disconnect(); } catch (e) {}
  delete speakingMonitors[id];
  setSpeakingUI(id, false);
}

function stopAllSpeakingMonitors() {
  Object.keys(speakingMonitors).forEach(stopSpeakingMonitor);
  if (audioCtx) {
    try { audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
}

function startSpeakingMonitor(id, stream) {
  if (!stream || !stream.getAudioTracks().length) return;
  const ctx = getAudioCtx();
  if (!ctx) return;

  let source;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch (e) {
    return;
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const mon = { analyser, data, source, stream, raf: null };
  speakingMonitors[id] = mon;

  let wasSpeaking = false;
  (function tick() {
    if (speakingMonitors[id] !== mon) return;
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    // Гистерезис: включаем выше ON, выключаем ниже OFF
    const isSpeaking = wasSpeaking ? rms > SPEAKING_THRESHOLD_OFF : rms > SPEAKING_THRESHOLD_ON;
    if (isSpeaking !== wasSpeaking) {
      wasSpeaking = isSpeaking;
      setSpeakingUI(id, isSpeaking);
    }
    mon.raf = requestAnimationFrame(tick);
  })();
}

function ensureSpeakingMonitor(id, stream) {
  const existing = speakingMonitors[id];
  if (!stream || !stream.getAudioTracks().length) {
    if (existing) stopSpeakingMonitor(id);
    return;
  }
  if (existing && existing.stream === stream) return;
  if (existing) stopSpeakingMonitor(id);
  startSpeakingMonitor(id, stream);
}

/* ── Peer connections ──────────────────────────────────────────────────── */
function createPeerConnection(peerId) {
  const existingPeer = callState.peers[peerId];
  if (existingPeer?.pc) return existingPeer.pc;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  callState.peers[peerId] = { pc, stream: null, pendingCandidates: [] };

  if (callState.localStream) {
    callState.localStream.getTracks().forEach(track => pc.addTrack(track, callState.localStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate && callState.callId) {
      socket.emit('callSignal', { callId: callState.callId, to: peerId, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.ontrack = e => {
    const peer = callState.peers[peerId];
    if (!peer) return;
    if (e.streams && e.streams[0]) {
      peer.stream = e.streams[0];
    } else {
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
    }
    // Перерисовка при (раз)мьюте удалённого трека — иначе плитка залипает в audio-only
    e.track.onmute = e.track.onunmute = () => renderCallGrid();
    renderCallGrid();
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (!callState.peers[peerId] || callState.peers[peerId].pc !== pc) return;
    if (st === 'connected') {
      setText('call-overlay-status', 'в звонке');
    } else if (st === 'failed') {
      if (callState.isGroup) {
        teardownPeer(peerId);
      } else {
        showTransientNotice('Соединение с собеседником потеряно');
        hangupCall();
      }
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
on('btn-call-audio', 'click', () => {
  if (state.activeFriend) startCall({ toId: state.activeFriend, video: false });
});
on('btn-call-video', 'click', () => {
  if (state.activeFriend) startCall({ toId: state.activeFriend, video: true });
});
on('btn-group-call-audio', 'click', () => {
  if (state.activeGroup) startCall({ groupId: state.activeGroup, video: false });
});
on('btn-group-call-video', 'click', () => {
  if (state.activeGroup) startCall({ groupId: state.activeGroup, video: true });
});
on('btn-join-group-voice', 'click', () => {
  if (callState.active || !state.activeGroup) return;
  if (state.groupVoiceCalls[state.activeGroup]) joinExistingGroupVoice(state.activeGroup);
  else startCall({ groupId: state.activeGroup, video: false });
});

on('btn-call-hangup', 'click', hangupCall);

on('btn-call-toggle-mic', 'click', () => {
  if (!callState.localStream) return;
  callState.micOn = !callState.micOn;
  callState.localStream.getAudioTracks().forEach(t => { t.enabled = callState.micOn; });
  const micButton = $('btn-call-toggle-mic');
  micButton.classList.toggle('active-off', !callState.micOn);
  micButton.title = callState.micOn ? 'Выключить микрофон' : 'Включить микрофон';
  micButton.setAttribute('aria-label', micButton.title);
  renderCallGrid();
});

on('btn-call-toggle-cam', 'click', () => {
  if (!callState.localStream) return;
  if (!callState.video || !callState.localStream.getVideoTracks().length) {
    showTransientNotice('В этом звонке нет видео');
    return;
  }
  callState.camOn = !callState.camOn;
  callState.localStream.getVideoTracks().forEach(t => { t.enabled = callState.camOn; });
  const camButton = $('btn-call-toggle-cam');
  camButton.classList.toggle('active-off', !callState.camOn);
  camButton.title = callState.camOn ? 'Выключить камеру' : 'Включить камеру';
  camButton.setAttribute('aria-label', camButton.title);
  renderCallGrid();
});

/* ── Incoming call UI ──────────────────────────────────────────────────── */
function dismissIncomingCall() {
  clearTimeout(callState.incomingTimer);
  callState.pendingIncoming = null;
  setDisplay('incoming-call-modal', 'none');
}

function showIncomingCall(info) {
  callState.pendingIncoming = info;
  const nick = info.isGroup
    ? (state.groups[info.groupId]?.name || 'Групповой звонок')
    : (info.fromNick || state.friends[info.from]?.nickname || info.from);
  setText('incoming-call-nick', nick);
  setText('incoming-call-sub', info.isGroup
    ? `${info.fromNick || 'Кто-то'} начал(а) ${info.video ? 'видео' : 'аудио'}звонок`
    : `входящий ${info.video ? 'видео' : 'аудио'}звонок…`);
  const avatarUrl = info.isGroup ? null : (state.friends[info.from]?.avatar || null);
  renderAv($('incoming-call-avatar'), nick, avatarUrl);
  setDisplay('incoming-call-modal', 'flex');

  clearTimeout(callState.incomingTimer);
  callState.incomingTimer = setTimeout(() => {
    if (callState.pendingIncoming?.callId === info.callId) {
      if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
      dismissIncomingCall();
      showTransientNotice(`Пропущенный звонок от ${nick}`);
    }
  }, CALL_RING_TIMEOUT_MS);
}

on('btn-call-accept', 'click', async () => {
  const info = callState.pendingIncoming;
  if (!info) return;
  setDisplay('incoming-call-modal', 'none');

  let stream;
  try {
    stream = await acquireLocalStream(info.video);
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    socket.emit('callReject', { callId: info.callId });
    dismissIncomingCall();
    return;
  }
  // Пока запрашивали разрешение, звонок могли отменить / завершить
  if (callState.pendingIncoming?.callId !== info.callId || callState.active) {
    stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    dismissIncomingCall();
    return;
  }

  beginCallSession({
    stream,
    callId: info.callId,
    chatKey: info.chatKey || null,
    isGroup: !!info.isGroup,
    groupId: info.groupId || null,
    peerFriendId: info.isGroup ? null : info.from,
    peerFriendName: info.isGroup ? null : (info.fromNick || state.friends[info.from]?.nickname || info.from),
    video: info.video,
  });
  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: info.callId });
});

on('btn-call-decline', 'click', () => {
  const info = callState.pendingIncoming;
  if (!info) return;
  if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
  dismissIncomingCall();
});

/* ── Signaling helpers ─────────────────────────────────────────────────── */
async function flushPendingCandidates(peerId) {
  const peer = callState.peers[peerId];
  if (!peer || !peer.pc.remoteDescription) return;
  const queue = peer.pendingCandidates.splice(0);
  for (const c of queue) {
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('addIceCandidate failed', e); }
  }
}

/**
 * Обработка SDP/ICE. Разрешение «glare» (оба одновременно отправили offer)
 * по схеме perfect negotiation: «вежливый» пир (с бо́льшим id) откатывает свой offer.
 */
async function handleCallSignal({ callId, from, data } = {}) {
  if (!callState.active || !callId || callId !== callState.callId) return;
  if (!from || !data || from === state.me?.id) return;

  const pc = createPeerConnection(from);
  const peer = callState.peers[from];
  if (!peer) return;

  try {
    if (data.type === 'offer') {
      const collision = pc.signalingState !== 'stable' || !!pc.localDescription;
      const polite = String(state.me?.id) > String(from);
      if (collision && !polite) return; // наш offer «победил», чужой игнорируем
      if (collision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(new RTCSessionDescription(data.sdp)),
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      }
      await flushPendingCandidates(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('callSignal', { callId, to: from, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushPendingCandidates(from);
    } else if (data.type === 'ice' && data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    }
  } catch (e) {
    console.warn('[call] signal error from', from, e);
  }
}

/** Новый участник инициирует offer ко всем, кто уже в звонке. */
async function offerToParticipants(participants) {
  const others = (participants || []).filter(id => id && id !== state.me?.id);
  for (const peerId of others) {
    try { await connectToPeer(peerId, true); } catch (e) { console.warn('[call] offer failed', peerId, e); }
  }
  renderCallGrid();
  if (!others.length) {
    setText('call-overlay-status', callState.isGroup ? 'ожидание участников…' : 'ожидание ответа…');
  }
}

/* ── Socket events: calls ──────────────────────────────────────────────
 * Ожидаемый протокол сервера:
 *  callIncoming    { callId, chatKey, isGroup, groupId, video, from, fromNick }
 *  callStarted     { callId, chatKey, participants }   — ответ инициатору на callStart
 *  callJoined      { callId, participants }            — ответ на callJoin
 *  callPeerJoined  { callId, peerId }
 *  callPeerLeft    { callId, peerId }
 *  callSignal      { callId, from, data }
 *  callRejected    { callId, by, reason }              — DM: собеседник отклонил / занят
 *  callCancelled   { callId }                          — инициатор отменил до ответа
 *  callEnded       { callId, reason }
 *  callError       { reason }
 * ────────────────────────────────────────────────────────────────────── */
socket.on('callIncoming', info => {
  if (!info?.callId) return;
  const busy = callState.active || callState.pendingIncoming;
  if (busy) {
    if (!info.isGroup) socket.emit('callReject', { callId: info.callId, reason: 'busy' });
    return;
  }
  // Групповой канал, который уже отображается в списке, не звонит повторно
  if (info.isGroup && state.groupVoiceCalls[info.groupId]?.callId === info.callId) return;
  showIncomingCall(info);
});

socket.on('callStarted', ({ callId, chatKey, participants } = {}) => {
  if (!callState.active || !callId) return;
  if (callState.callId && callState.callId !== callId) return;
  callState.callId = callId;
  if (chatKey) callState.chatKey = chatKey;
  if (callState.isGroup && callState.groupId) {
    const existing = state.groupVoiceCalls[callState.groupId];
    if (!existing || existing.callId !== callId) {
      state.groupVoiceCalls[callState.groupId] = {
        callId, video: callState.video,
        participants: participants && participants.length ? participants : [state.me?.id].filter(Boolean),
      };
      renderGroupsList();
      updateGroupVoiceBar(callState.groupId);
    }
  }
  offerToParticipants(participants);
});

socket.on('callJoined', ({ callId, participants } = {}) => {
  if (!callState.active || !callId || callId !== callState.callId) return;
  offerToParticipants(participants);
});

socket.on('callPeerJoined', ({ callId, peerId } = {}) => {
  if (!callState.active || callId !== callState.callId || !peerId || peerId === state.me?.id) return;
  clearTimeout(callState.ringTimer);
  // Offer пришлёт сам вошедший — только готовим соединение и плитку
  createPeerConnection(peerId);
  setText('call-overlay-status', 'соединение…');
  renderCallGrid();
});

socket.on('callPeerLeft', ({ callId, peerId } = {}) => {
  if (!callState.active || callId !== callState.callId || !peerId) return;
  const name = callPeerName(peerId);
  teardownPeer(peerId);
  if (!callState.isGroup) {
    showTransientNotice('Собеседник завершил звонок');
    closeCallOverlay();
    return;
  }
  showTransientNotice(`${name} покинул(а) канал`);
  if (!Object.keys(callState.peers).length) setText('call-overlay-status', 'ожидание участников…');
});

socket.on('callSignal', payload => { handleCallSignal(payload); });

socket.on('callRejected', ({ callId, reason } = {}) => {
  if (!callState.active || callId !== callState.callId) return;
  if (callState.isGroup) return;
  showTransientNotice(reason === 'busy' ? 'Собеседник занят' : 'Собеседник отклонил звонок');
  closeCallOverlay();
});

socket.on('callCancelled', ({ callId } = {}) => {
  if (!callId) return;
  if (callState.pendingIncoming?.callId === callId) {
    const nick = callState.pendingIncoming.isGroup
      ? (state.groups[callState.pendingIncoming.groupId]?.name || 'группы')
      : (callState.pendingIncoming.fromNick || callState.pendingIncoming.from);
    dismissIncomingCall();
    showTransientNotice(`Пропущенный звонок от ${nick}`);
  }
});

socket.on('callEnded', ({ callId, reason } = {}) => {
  if (!callId) return;
  if (callState.pendingIncoming?.callId === callId) {
    dismissIncomingCall();
    return;
  }
  if (callState.active && callState.callId === callId) {
    const messages = {
      timeout: 'Нет ответа',
      ended: 'Звонок завершён',
      group_deleted: 'Группа удалена — звонок завершён',
      kicked: 'Вы исключены из группы — звонок завершён',
      server_error: 'Звонок прерван из-за ошибки сервера',
    };
    showTransientNotice(messages[reason] || 'Звонок завершён');
    closeCallOverlay();
  }
});

socket.on('callError', ({ reason } = {}) => {
  const messages = {
    busy: 'Собеседник уже в звонке',
    offline: 'Пользователь не в сети',
    not_found: 'Звонок не найден или уже завершён',
    not_friends: 'Звонить можно только друзьям',
    not_member: 'Вы не участник группы',
    blocked: 'Невозможно позвонить этому пользователю',
    limit_reached: 'Достигнут лимит участников звонка',
    rate_limited: 'Слишком много действий, подождите',
    server_error: 'Ошибка сервера',
  };
  showTransientNotice(messages[reason] || 'Ошибка звонка');
  // Если сессия запущена локально, но сервер отказал — сворачиваем оверлей
  if (callState.active) closeCallOverlay();
  else if (callState.pendingIncoming) dismissIncomingCall();
});

/* ── Дополнительная защита: смена участников группы во время звонка ───── */
socket.on('groupMemberLeft', ({ groupId, userId } = {}) => {
  if (!callState.active || !callState.isGroup || callState.groupId !== groupId) return;
  if (userId && userId !== state.me?.id && callState.peers[userId]) teardownPeer(userId);
});

/* ============================================================================
 * GLOBAL ERROR GUARDS
 * ==========================================================================*/
window.addEventListener('unhandledrejection', e => {
  if (e.reason instanceof AuthError) { e.preventDefault(); return; }
  console.error('Unhandled rejection:', e.reason);
});

window.addEventListener('error', e => {
  console.error('Uncaught error:', e.error || e.message);
});
  