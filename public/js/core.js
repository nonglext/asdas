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
const FETCH_TIMEOUT_MS = 60 * 1000;        // таймаут HTTP-запросов (0 — без таймаута)
const SOUNDS_STORAGE_KEY = 'chatapp_sounds';

// Обратная совместимость: в остальном коде может использоваться SOUNDS_ENABLED.
// Актуальное значение — sfx.enabled().
const SOUNDS_ENABLED = localStorage.getItem(SOUNDS_STORAGE_KEY) !== 'off';

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

/** Выполнить после готовности DOM (или сразу, если он уже готов). */
function whenDomReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

/**
 * Безопасная подписка: отсутствие элемента в HTML не роняет весь скрипт.
 * Если DOM ещё не загружен — подписка откладывается.
 */
function on(id, event, handler, options) {
  const el = $(id);
  if (el) {
    el.addEventListener(event, handler, options);
    return el;
  }
  if (document.readyState === 'loading') {
    whenDomReady(() => on(id, event, handler, options));
    return null;
  }
  console.warn(`[ui] element #${id} not found`);
  return null;
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
class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

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

/** Инвалидирует все «летящие» async-ответы (поиск, загрузка чата и т.д.). */
function bumpAllSeq() {
  for (const k of Object.keys(state.seq)) state.seq[k]++;
}

function resetState() {
  bumpAllSeq();
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

/** Остановить анализатор громкости (используется при выходе/завершении звонка). */
function stopSpeakingMonitor(id) {
  const m = speakingMonitors[id];
  if (!m) return;
  try { cancelAnimationFrame(m.raf); } catch (e) {}
  try { m.source?.disconnect(); } catch (e) {}
  try { m.analyser?.disconnect(); } catch (e) {}
  delete speakingMonitors[id];
}

/**
 * Жёсткий сброс состояния звонка без сетевых сообщений: таймеры, треки,
 * peer-соединения, мониторы речи. Не трогает UI — для этого closeCallOverlay().
 */
function resetCallState() {
  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);
  callState.ringTimer = null;
  callState.incomingTimer = null;

  for (const id of Object.keys(speakingMonitors)) stopSpeakingMonitor(id);

  for (const [peerId, peer] of Object.entries(callState.peers)) {
    try { peer.pc?.close(); } catch (e) {}
    try { peer.stream?.getTracks().forEach(t => t.stop()); } catch (e) {}
    delete callState.peers[peerId];
  }

  try { callState.localStream?.getTracks().forEach(t => t.stop()); } catch (e) {}

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
  callState.pendingIncoming = null;
}

/* ============================================================================
 * SOUNDS (Web Audio, без внешних файлов — как «блипы» Discord)
 * ==========================================================================*/
const sfx = (() => {
  let ctx = null;
  let ringTimer = null;
  let enabled = SOUNDS_ENABLED;

  function getCtx() {
    if (!enabled) return null;
    if (!ctx || ctx.state === 'closed') {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = AC ? new AC() : null;
      } catch (e) { ctx = null; }
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
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (e) {} };
    } catch (e) {}
  }

  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
  }

  function startRing(outgoing) {
    stopRing();
    const play = () => {
      if (!enabled) return;
      if (outgoing) {
        tone(440, 0, 1.0, 0.025);
      } else {
        tone(659, 0, 0.15, 0.07);
        tone(659, 0.2, 0.15, 0.07);
        tone(784, 0.4, 0.28, 0.07);
        tone(659, 0.75, 0.15, 0.06);
      }
    };
    play();
    ringTimer = setInterval(play, outgoing ? 3000 : 2200);
  }

  // Браузеры блокируют звук до первого жеста пользователя — «разблокируем» контекст заранее,
  // чтобы входящий рингтон сработал даже если пользователь давно не кликал.
  const unlock = () => { getCtx(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, unlock, { once: true, passive: true })
  );

  return {
    enabled: () => enabled,
    setEnabled(v) {
      enabled = !!v;
      localStorage.setItem(SOUNDS_STORAGE_KEY, enabled ? 'on' : 'off');
      if (!enabled) stopRing();
    },
    toggle() { this.setEnabled(!enabled); return enabled; },
    message() { tone(880, 0, 0.12, 0.05); tone(1175, 0.08, 0.18, 0.045); },
    friend()  { tone(659, 0, 0.12, 0.05); tone(880, 0.1, 0.2, 0.05); },
    join()    { tone(523, 0, 0.1, 0.06); tone(784, 0.1, 0.16, 0.06); },
    leave()   { tone(784, 0, 0.1, 0.06); tone(523, 0.1, 0.16, 0.06); },
    startRing,
    stopRing,
  };
})();

/* ============================================================================
 * SOCKET.IO
 * ==========================================================================*/
const socket = io(BACKEND_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
});

// Токен читается при КАЖДОМ (ре)коннекте — после перелогина не уйдёт устаревший.
socket.auth = cb => cb({ token: localStorage.getItem('chatapp_token') || '' });

function connectSocket() {
  const token = localStorage.getItem('chatapp_token');
  if (!token) return;
  if (socket.connected) socket.disconnect();
  socket.connect();
}

/* ============================================================================
 * GENERIC HELPERS
 * ==========================================================================*/
/** Первая «буква» ника с учётом эмодзи и суррогатных пар. */
function av(nick) {
  if (!nick) return '?';
  const first = Array.from(String(nick).trim())[0];
  return first ? first.toUpperCase() : '?';
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
  return msg?.time || msg?.timestamp || msg?.createdAt || null;
}

function getMsgTimeMs(msg) {
  const t = new Date(msgTimeRaw(msg)).getTime();
  return isNaN(t) ? Date.now() : t;
}

function plural(n, one, few, many) {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  const m10 = a % 10, m100 = a % 100;
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
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
}

function placeholderHTML(text, isError = false) {
  return `<div class="msgs-placeholder" style="text-align:center;color:${isError ? 'var(--red)' : 'var(--text3)'};padding:24px;font-size:13px">${esc(text)}</div>`;
}

function clearMsgsPlaceholder(container) {
  if (!container) return;
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
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
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
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text || '';
  el.classList.toggle('show', !!show);
}

function updateTitleBadge() {
  const sum = obj => Object.values(obj).reduce((a, b) => a + (Number(b) || 0), 0);
  const total = sum(state.unread) + sum(state.groupUnread);
  document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}

/* ============================================================================
 * TEXT FORMATTING (упрощённый Discord‑markdown поверх экранированного текста)
 *   **bold** *italic* __underline__ ~~strike~~ `code` ```block``` ||spoiler|| ссылки
 * ==========================================================================*/
const URL_RE = /https?:\/\/[^\s<]+/g;
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3|\s)+$/u;
// Плейсхолдер из Private Use Area: не встречается в пользовательском тексте.
const STASH_OPEN = '\uE000', STASH_CLOSE = '\uE001';
const STASH_RE = /\uE000(\d+)\uE001/g;

/**
 * Отделяет от URL «хвост» (пунктуацию, экранированные кавычки, несбалансированные скобки),
 * который на самом деле не относится к ссылке.
 */
function splitUrlTail(u) {
  let tail = '';
  for (;;) {
    let m;
    if ((m = u.match(/(?:&(?:gt|quot|#39|amp);)+$/))) {         // &gt; &quot; &#39; &amp;
      u = u.slice(0, -m[0].length); tail = m[0] + tail; continue;
    }
    if ((m = u.match(/[.,;:!?'"]+$/))) {                          // обычная пунктуация
      u = u.slice(0, -m[0].length); tail = m[0] + tail; continue;
    }
    if (u.endsWith(')') || u.endsWith(']')) {                     // несбалансированная скобка
      const open = u.endsWith(')') ? '(' : '[';
      const close = u.slice(-1);
      const opens = u.split(open).length - 1;
      const closes = u.split(close).length - 1;
      if (closes > opens) { u = u.slice(0, -1); tail = close + tail; continue; }
    }
    break;
  }
  return [u, tail];
}

function formatMsgText(raw) {
  let s = esc(raw);
  const stash = [];
  const keep = html => { stash.push(html); return `${STASH_OPEN}${stash.length - 1}${STASH_CLOSE}`; };

  s = s.replace(/```(?:[a-z0-9]*\n)?([\s\S]+?)```/gi, (_, c) =>
    keep(`<pre class="md-pre"><code>${c.replace(/^\n+|\n+$/g, '')}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code class="md-code">${c}</code>`));
  s = s.replace(URL_RE, m => {
    const [u, tail] = splitUrlTail(m);
    if (!/^https?:\/\/[^/]+/i.test(u)) return m;
    return keep(`<a href="${u}" target="_blank" rel="noopener noreferrer nofollow" class="md-link">${u}</a>`) + tail;
  });

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="md-spoiler" tabindex="0" role="button" title="Показать спойлер">$1</span>');

  // Переносы строк вне <pre> (внутри <pre> текст уже в stash и не затронется)
  s = s.replace(/\n/g, '<br>');

  s = s.replace(STASH_RE, (_, i) => stash[+i]);
  return s;
}

function isJumboEmoji(text) {
  if (!text || text.length > 40) return false;
  try { return EMOJI_ONLY_RE.test(text); } catch (e) { return false; }
}

// Раскрытие спойлеров кликом и с клавиатуры (делегирование)
['messages', 'group-messages'].forEach(id => {
  on(id, 'click', e => {
    const sp = e.target.closest('.md-spoiler');
    if (sp) sp.classList.add('revealed');
  });
  on(id, 'keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const sp = e.target.closest('.md-spoiler');
    if (sp) { e.preventDefault(); sp.classList.add('revealed'); }
  });
});

/* ============================================================================
 * AUTH / SESSION
 * ==========================================================================*/
function forceLogoutToLogin(message) {
  if (state.loggingOut) return;
  state.loggingOut = true;
  try {
    if (callState.active || callState.pendingIncoming) {
      if (callState.callId && socket.connected) {
        try { socket.emit('callLeave', { callId: callState.callId }); } catch (e) {}
      }
      try { closeCallOverlay(); } catch (e) { console.warn('[call] closeCallOverlay failed', e); }
    }
    sfx.stopRing();
    resetCallState();
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
    setErr(message || '');

    const fl = $('friends-list');
    if (fl) fl.innerHTML = emptyFriendsHTML();
    const rl = $('requests-list');
    if (rl) rl.innerHTML = '';
    setDisplay('requests-section', 'none');
    const gl = $('groups-list');
    if (gl) gl.innerHTML = emptyGroupsHTML();
    try { closeActiveChat(); } catch (e) { console.warn('[chat] closeActiveChat failed', e); }
    document.title = BASE_TITLE;
  } finally {
    state.loggingOut = false;
  }
}

/**
 * fetch() с bearer-токеном и таймаутом. На 401 при активной сессии выбрасывает AuthError,
 * чтобы вызывающий код не продолжил обрабатывать данные разлогиненной сессии.
 * options.timeoutMs — переопределить таймаут (0 — отключить). Если передан options.signal,
 * собственный таймаут не ставится.
 */
async function authFetch(url, options = {}) {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...fetchOptions } = options;
  const token = localStorage.getItem('chatapp_token');

  let controller = null, timer = null;
  if (!fetchOptions.signal && timeoutMs > 0 && typeof AbortController !== 'undefined') {
    controller = new AbortController();
    fetchOptions.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      headers: {
        ...(fetchOptions.headers || {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    });
    if (res.status === 401 && state.me) {
      forceLogoutToLogin('Сессия истекла, войдите снова');
      throw new AuthError('Session expired');
    }
    return res;
  } catch (e) {
    if (e?.name === 'AbortError' && controller) {
      const err = new Error('Превышено время ожидания ответа сервера');
      err.name = 'TimeoutError';
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function saveAndLogin(user, userId, token) {
  if (!user || typeof user !== 'object') return setErr('Некорректный ответ сервера');
  const id = userId ?? user.id;
  if (!id) return setErr('Некорректный ответ сервера: нет идентификатора пользователя');
  const finalToken = token || localStorage.getItem('chatapp_token');
  if (!finalToken) return setErr('Некорректный ответ сервера: нет токена');

  state.me = user;
  localStorage.setItem('chatapp_id', String(id));
  localStorage.setItem('chatapp_token', finalToken);
  localStorage.setItem('chatapp_profile', JSON.stringify(user));
  setErr('');
  enterApp(user);
}

function enterApp(user) {
  state.loggingOut = false;
  renderAv($('my-avatar'), user.nickname, user.avatar);
  setText('my-nick', user.nickname || '');
  setText('my-id', user.id ? '@' + user.id : '');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('app-screen')?.classList.add('active');
  document.documentElement.classList.add('has-session');
  updateTitleBadge();
  connectSocket();
  loadGroups();
}

/* ============================================================================
 * AVATAR RENDERING
 * ==========================================================================*/
/** Относительные пути вида «/uploads/x.png» отдаются с бэкенда, а не с текущего origin. */
function avatarSrc(url) {
  if (!url) return '';
  const u = String(url);
  if (/^(?:https?:)?\/\//i.test(u) || /^(?:data|blob):/i.test(u)) return u;
  if (u.startsWith('/')) return BACKEND_URL.replace(/\/+$/, '') + u;
  return u;
}

function renderAv(el, nickname, avatarUrl) {
  if (!el) return;
  el.textContent = '';
  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarSrc(avatarUrl);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
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
  if (el.style.position !== 'relative') el.style.position = 'relative';
  if (el.style.overflow !== 'visible') el.style.overflow = 'visible';
  if (online) {
    const dot = document.createElement('div');
    dot.className = 'f-dot';
    dot.title = 'В сети';
    el.appendChild(dot);
  }
}

// Аватар группы — сетка из лиц участников (как в Discord)
function renderGroupAv(el, group) {
  if (!el) return;
  el.textContent = '';
  el.classList.add('group-av');
  el.classList.remove('g1', 'g2', 'g3', 'g4');
  const members = (Array.isArray(group?.members) ? group.members : []).slice(0, 4);
  if (!members.length) { el.textContent = '#'; return; }
  const grid = document.createElement('div');
  grid.className = 'group-av-grid g' + members.length;
  members.forEach(m => {
    const cell = document.createElement('div');
    cell.className = 'group-av-cell';
    renderAv(cell, m?.nickname, m?.avatar);
    grid.appendChild(cell);
  });
  el.appendChild(grid);
}

/** Единственный источник истины «является ли участник владельцем группы». */
function isGroupOwner(group, userId) {
  if (!group || !userId) return false;
  if (group.ownerId != null) return String(group.ownerId) === String(userId);
  const member = (group.members || []).find(m => String(m?.id) === String(userId));
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