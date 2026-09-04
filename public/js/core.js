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
const SOUNDS_ENABLED = localStorage.getItem('chatapp_sounds') !== 'off'; // localStorage.setItem('chatapp_sounds','off') — выключить

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
const TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>';
const MIC_OFF_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const EMPTY_ICON_SVG = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>';

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

function isAnyModalOpen() {
  return [...document.querySelectorAll('.modal-overlay')].some(m => m.style.display === 'flex');
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
  lastActivity: Object.create(null),      // friendId -> ts последнего сообщения (сортировка как в Discord)
  groupLastActivity: Object.create(null), // groupId -> ts
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
  state.lastActivity = Object.create(null);
  state.groupLastActivity = Object.create(null);
  state.pendingDeleteId = null;
  selectedGroupMembers = new Set();
  selectedAddMembers = new Set();
}

/* ============================================================================
 * SOUNDS (Web Audio, без внешних файлов — как «блипы» Discord)
 * ==========================================================================*/
const sfx = (() => {
  let ctx = null;
  let ringTimer = null;

  function getCtx() {
    if (!SOUNDS_ENABLED) return null;
    if (!ctx || ctx.state === 'closed') {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(freq, start, dur, gain = 0.07, type = 'sine') {
    const c = getCtx();
    if (!c) return;
    try {
      const t0 = c.currentTime + start;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    } catch (e) {}
  }

  return {
    message() { tone(880, 0, 0.12, 0.05); tone(1175, 0.08, 0.18, 0.045); },
    friend()  { tone(659, 0, 0.12, 0.05); tone(880, 0.1, 0.2, 0.05); },
    join()    { tone(523, 0, 0.1, 0.06); tone(784, 0.1, 0.16, 0.06); },
    leave()   { tone(784, 0, 0.1, 0.06); tone(523, 0.1, 0.16, 0.06); },
    startRing(outgoing) {
      this.stopRing();
      const play = () => {
        if (outgoing) { tone(440, 0, 1.0, 0.025); }
        else { tone(659, 0, 0.15, 0.07); tone(659, 0.2, 0.15, 0.07); tone(784, 0.4, 0.28, 0.07); tone(659, 0.75, 0.15, 0.06); }
      };
      play();
      ringTimer = setInterval(play, outgoing ? 3000 : 2200);
    },
    stopRing() { clearInterval(ringTimer); ringTimer = null; },
  };
})();

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

function dayKey(ms) { return new Date(ms).toDateString(); }

function dayOffset(ms) {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  const t = new Date();   t.setHours(0, 0, 0, 0);
  return Math.round((t - d) / 86400000);
}

/** Подпись разделителя дня: «Сегодня», «Вчера», «12 марта 2024 г.» */
function fmtDayLabel(ms) {
  const off = dayOffset(ms);
  if (off === 0) return 'Сегодня';
  if (off === 1) return 'Вчера';
  return fmtDate(ms);
}

/** Время в шапке сообщения как в Discord: «Сегодня, в 14:32» */
function fmtMsgTime(ms) {
  const off = dayOffset(ms);
  const t = fmtTime(ms);
  if (off === 0) return `Сегодня, в ${t}`;
  if (off === 1) return `Вчера, в ${t}`;
  return `${new Date(ms).toLocaleDateString('ru')} ${t}`;
}

function msgTimeRaw(msg) {
  return msg.time || msg.timestamp || msg.createdAt || null;
}

function getMsgTimeMs(msg) {
  const t = new Date(msgTimeRaw(msg)).getTime();
  return isNaN(t) ? Date.now() : t;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
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

function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
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

/** Полоска «Переподключение…» сверху, как в Discord */
function setConnBanner(show, text) {
  let el = $('conn-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'conn-banner';
    el.className = 'conn-banner';
    document.body.appendChild(el);
  }
  el.textContent = text || '';
  el.classList.toggle('show', !!show);
}

function updateTitleBadge() {
  const total =
    Object.values(state.unread).reduce((a, b) => a + (b || 0), 0) +
    Object.values(state.groupUnread).reduce((a, b) => a + (b || 0), 0);
  document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}

/* ============================================================================
 * TEXT FORMATTING (упрощённый Discord‑markdown поверх экранированного текста)
 *   **bold** *italic* __underline__ ~~strike~~ `code` ```block``` ||spoiler|| ссылки
 * ==========================================================================*/
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s)+$/u;

function formatMsgText(raw) {
  let s = esc(raw);
  const stash = [];
  const keep = html => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };

  s = s.replace(/```(?:[a-z0-9]*\n)?([\s\S]+?)```/gi, (_, c) => keep(`<pre class="md-pre"><code>${c.replace(/^\n+|\n+$/g, '')}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code class="md-code">${c}</code>`));
  s = s.replace(URL_RE, (_, u) => keep(`<a href="${u}" target="_blank" rel="noopener noreferrer" class="md-link">${u}</a>`));

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="md-spoiler" tabindex="0" title="Показать спойлер">$1</span>');

  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  return s;
}

function isJumboEmoji(text) {
  if (!text || text.length > 40) return false;
  try { return EMOJI_ONLY_RE.test(text); } catch (e) { return false; }
}

// Раскрытие спойлеров кликом (делегирование)
['messages', 'group-messages'].forEach(id => on(id, 'click', e => {
  const sp = e.target.closest('.md-spoiler');
  if (sp) sp.classList.add('revealed');
}));

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
    sfx.stopRing();
    resetState();
    if (socket.connected) socket.disconnect();
    localStorage.removeItem('chatapp_id');
    localStorage.removeItem('chatapp_token');
    localStorage.removeItem('chatapp_profile');
    document.documentElement.classList.remove('has-session');
    closeAllModals();
    setConnBanner(false);
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

/** Аватар + точка онлайн-статуса (Discord‑style) */
function renderAvWithDot(el, nickname, avatarUrl, online) {
  renderAv(el, nickname, avatarUrl);
  if (!el) return;
  el.style.position = 'relative';
  el.style.overflow = 'visible';
  if (online) {
    const dot = document.createElement('div');
    dot.className = 'f-dot';
    el.appendChild(dot);
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

function emptyFriendsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">${EMPTY_ICON_SVG}</div>
    <div class="empty-title">Здесь пока пусто</div>
    <div class="empty-sub">Найди друзей через поиск сверху</div>
  </div>`;
}

function emptyGroupsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">${EMPTY_ICON_SVG}</div>
    <div class="empty-title">Нет групп</div>
    <div class="empty-sub">Создай группу кнопкой +</div>
  </div>`;
}

