'use strict';

/* ============================================================================
 * CONFIG
 * ========================================================================== */

const BACKEND_URL = window.location.origin;
const BACKEND_ORIGIN = new URL(BACKEND_URL).origin;

const TOKEN_STORAGE_KEY = 'chatapp_token';
const USER_ID_STORAGE_KEY = 'chatapp_id';
const PROFILE_STORAGE_KEY = 'chatapp_profile';
const SOUNDS_STORAGE_KEY = 'chatapp_sounds';

const MAX_MESSAGE_LENGTH = 4000;
const MAX_AVATAR_SIZE = 10 * 1024 * 1024;

const ALLOWED_AVATAR_TYPES = Object.freeze([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MSG_GROUP_WINDOW_MS = 5 * 60 * 1000;
const CALL_RING_TIMEOUT_MS = 45 * 1000;
const SEARCH_DEBOUNCE_MS = 280;
const FETCH_TIMEOUT_MS = 60 * 1000;

const MEDIA_SESSION_REFRESH_MS = 40 * 60 * 1000;
const MEDIA_SESSION_RETRY_MS = 60 * 1000;

const RTC_CONFIG_CACHE_MS = 30 * 60 * 1000;
const RTC_CONFIG_RETRY_MS = 15 * 1000;

/*
 * Ограничения задаются как предпочтения, а не exact:
 * отсутствие стереомикрофона не должно ломать getUserMedia.
 *
 * Отключение обработки НЕ гарантирует побитово «чистый» звук:
 * браузер, устройство и Opus всё равно могут выполнять преобразования.
 *
 * Без echoCancellation для разговора лучше использовать наушники.
 */
const RAW_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: Object.freeze({ ideal: 2 }),
  sampleRate: Object.freeze({ ideal: 48000 }),
  sampleSize: Object.freeze({ ideal: 16 }),
});

const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun1.l.google.com:19302' }),
]);

function defaultIceServers() {
  return DEFAULT_ICE_SERVERS.map(server => ({ ...server }));
}

/*
 * Сам объект не заменяется: calls.js и interop-экспорты могут хранить ссылку.
 */
const RTC_CONFIG = {
  iceServers: defaultIceServers(),
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 0,
};

/* ============================================================================
 * STORAGE
 * ========================================================================== */

const storage = {
  memory: new Map(),
  pending: new Set(),

  getItem(key) {
    key = String(key);

    /*
     * Если запись/удаление не удались, дисковое значение устарело.
     * До успешной повторной записи используем локальное значение.
     */
    if (this.pending.has(key)) {
      return this.memory.get(key) ?? null;
    }

    try {
      const value = window.localStorage.getItem(key);
      this.memory.set(key, value);
      return value;
    } catch (_) {
      return this.memory.get(key) ?? null;
    }
  },

  setItem(key, value) {
    key = String(key);
    value = String(value);

    this.memory.set(key, value);

    try {
      window.localStorage.setItem(key, value);
      this.pending.delete(key);
    } catch (_) {
      this.pending.add(key);
    }
  },

  removeItem(key) {
    key = String(key);

    // Tombstone не даёт удалённому токену «воскреснуть» при ошибке localStorage.
    this.memory.set(key, null);

    try {
      window.localStorage.removeItem(key);
      this.pending.delete(key);
    } catch (_) {
      this.pending.add(key);
    }
  },

  flush() {
    for (const key of [...this.pending]) {
      try {
        const value = this.memory.get(key);

        if (value == null) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, value);
        }

        this.pending.delete(key);
      } catch (_) {
        // Хранилище всё ещё недоступно.
      }
    }
  },
};

// Снимок для обратной совместимости. Актуальное состояние: sfx.enabled().
const SOUNDS_ENABLED = storage.getItem(SOUNDS_STORAGE_KEY) !== 'off';

/* ============================================================================
 * STATIC SVG
 *
 * Эти строки статические. Пользовательские данные внутрь SVG не вставляются.
 * ========================================================================== */

const CROWN_SVG =
  '<svg class="gm-crown" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
  '<title>Владелец группы</title>' +
  '<path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/>' +
  '</svg>';

const TRASH_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<polyline points="3 6 5 6 21 6"/>' +
  '<path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/>' +
  '</svg>';

const MIC_OFF_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="1" y1="1" x2="23" y2="23"/>' +
  '<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>' +
  '<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>' +
  '<line x1="12" y1="19" x2="12" y2="23"/>' +
  '<line x1="8" y1="23" x2="16" y2="23"/>' +
  '</svg>';

const EMPTY_ICON_SVG =
  '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>' +
  '<circle cx="9" cy="7" r="4"/>' +
  '<path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>' +
  '</svg>';

/* ============================================================================
 * DOM HELPERS
 * ========================================================================== */

const $ = id => document.getElementById(id);

function whenDomReady(fn) {
  if (typeof fn !== 'function') return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

function on(id, event, handler, options) {
  const element = $(id);

  if (element) {
    element.addEventListener(event, handler, options);
    return element;
  }

  if (document.readyState === 'loading') {
    whenDomReady(() => on(id, event, handler, options));
    return null;
  }

  console.warn(`[ui] element #${id} not found`);
  return null;
}

function setText(id, text) {
  const element = $(id);
  if (element) element.textContent = String(text ?? '');
}

function setDisplay(id, value) {
  const element = $(id);
  if (element) element.style.display = value;
}

function coreElementVisible(element) {
  if (!element || element.hidden) return false;

  const style = getComputedStyle(element);

  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    element.getClientRects().length > 0;
}

function isAnyModalOpen() {
  return [...document.querySelectorAll(
    '.modal-overlay, [role="dialog"], [aria-modal="true"]',
  )].some(coreElementVisible);
}

/* ============================================================================
 * STATE
 * ========================================================================== */

class AuthError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}

class SessionChangedError extends Error {
  constructor(message = 'Сессия изменилась. Повторите действие') {
    super(message);
    this.name = 'SessionChangedError';
  }
}

const state = {
  me: null,
  sessionRevision: 0,

  activeFriend: null,
  activeGroup: null,
  infoGroupId: null,

  friends: Object.create(null),
  groups: Object.create(null),

  unread: Object.create(null),
  groupUnread: Object.create(null),

  groupVoiceCalls: Object.create(null),
  dmVoiceCalls: Object.create(null),
  voiceRejoin: Object.create(null),

  lastActivity: Object.create(null),
  groupLastActivity: Object.create(null),

  pendingDeleteId: null,

  seq: {
    chat: 0,
    groupChat: 0,
    profile: 0,
    search: 0,
  },

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
  camOn: false,

  peers: Object.create(null),
  pendingIncoming: null,

  ringTimer: null,
  incomingTimer: null,
};

const speakingMonitors = Object.create(null);

let selectedGroupMembers = new Set();
let selectedAddMembers = new Set();

const BASE_TITLE = document.title || 'Chat';

let mediaSessionTimer = null;
let mediaSessionPromise = null;
let mediaSessionGeneration = 0;

let rtcConfigPromise = null;
let rtcConfigAt = 0;
let rtcConfigExpiresAt = 0;
let rtcConfigSessionKey = null;
let rtcConfigGeneration = 0;

const activeAuthRequests = new Set();

function coreSessionSnapshot() {
  return {
    revision: state.sessionRevision,
    userId: state.me?.id ?? null,
    token: storage.getItem(TOKEN_STORAGE_KEY),
  };
}

function coreSessionMatches(snapshot) {
  return state.sessionRevision === snapshot.revision &&
    (state.me?.id ?? null) === snapshot.userId &&
    storage.getItem(TOKEN_STORAGE_KEY) === snapshot.token;
}

function bumpAllSeq() {
  for (const key of Object.keys(state.seq)) {
    state.seq[key]++;
  }
}

function abortActiveAuthRequests() {
  for (const controller of activeAuthRequests) {
    try {
      controller.abort();
    } catch (_) {}
  }

  activeAuthRequests.clear();
}

function invalidateMediaSessionRefresh() {
  mediaSessionGeneration++;

  clearTimeout(mediaSessionTimer);

  mediaSessionTimer = null;
  mediaSessionPromise = null;
}

function invalidateRTCConfig() {
  rtcConfigGeneration++;

  rtcConfigPromise = null;
  rtcConfigAt = 0;
  rtcConfigExpiresAt = 0;
  rtcConfigSessionKey = null;

  RTC_CONFIG.iceServers = defaultIceServers();
  RTC_CONFIG.iceTransportPolicy = 'all';
  RTC_CONFIG.iceCandidatePoolSize = 0;

  window.__chatappRtc = {
    relayConfigured: false,
    relayRequired: false,
    relayError: null,
    configError: false,
    policy: 'all',
  };
}

/*
 * Не объявляем stopSpeakingMonitor второй раз.
 * Полная реализация этой функции находится в calls.js.
 */
function coreStopSpeakingMonitor(id) {
  const monitor = speakingMonitors[id];
  if (!monitor) return;

  try {
    cancelAnimationFrame(monitor.raf);
  } catch (_) {}

  try {
    monitor.source?.disconnect();
  } catch (_) {}

  try {
    monitor.analyser?.disconnect();
  } catch (_) {}

  delete speakingMonitors[id];
}

function coreStopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;

  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch (_) {}
  }
}

/*
 * Полная очистка без callLeave.
 *
 * Если calls.js загружен, делегируем ему очистку, включая ожидающий
 * getUserMedia, демонстрацию экрана и его приватные таймеры.
 *
 * Резервная очистка работает и без calls.js.
 */
function resetCallState() {
  try {
    if (typeof window.closeCallOverlay === 'function') {
      window.closeCallOverlay();
    } else if (typeof closeCallOverlay === 'function') {
      closeCallOverlay();
    }
  } catch (error) {
    console.warn('[call] full cleanup failed; using fallback', error);
  }

  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);

  callState.ringTimer = null;
  callState.incomingTimer = null;

  for (const id of Object.keys(speakingMonitors)) {
    coreStopSpeakingMonitor(id);
  }

  for (const peer of Object.values(callState.peers || {})) {
    clearTimeout(peer?.restartTimer);
    clearTimeout(peer?.disconnectTimer);

    try {
      if (peer.dc) {
        peer.dc.onopen = null;
        peer.dc.onmessage = null;
        peer.dc.onerror = null;
        peer.dc.onclose = null;
        peer.dc.close();
      }
    } catch (_) {}

    try {
      if (peer.pc) {
        peer.pc.onicecandidate = null;
        peer.pc.ontrack = null;
        peer.pc.onnegotiationneeded = null;
        peer.pc.onsignalingstatechange = null;
        peer.pc.onconnectionstatechange = null;
        peer.pc.oniceconnectionstatechange = null;
        peer.pc.close();
      }
    } catch (_) {}

    coreStopStream(peer?.stream);
  }

  coreStopStream(callState.localStream);

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
  callState.camOn = false;
  callState.pendingIncoming = null;
  callState.peers = Object.create(null);

  try {
    sfx.stopRing();
  } catch (_) {}

  const overlay = $('call-overlay');

  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('voice-mode', 'video-mode', 'idle', 'detached');
    overlay.title = '';
  }

  setDisplay('incoming-call-modal', 'none');

  const grid = $('call-video-grid');

  if (grid) {
    for (const element of grid.querySelectorAll('video, audio')) {
      try {
        element.pause();
        element.srcObject = null;
      } catch (_) {}
    }

    grid.replaceChildren();
    delete grid.dataset.count;
  }
}

function resetState() {
  // Сначала делаем старые асинхронные операции неактуальными.
  state.sessionRevision++;
  bumpAllSeq();

  abortActiveAuthRequests();
  invalidateMediaSessionRefresh();
  invalidateRTCConfig();

  resetCallState();

  for (const entry of Object.values(state.voiceRejoin || {})) {
    clearTimeout(entry?.timer);
  }

  /*
   * Эти коллекции принадлежат другим файлам.
   * try защищает и от отсутствия переменной, и от её TDZ.
   */
  try {
    if (typeof composerDrafts !== 'undefined') composerDrafts.clear();
  } catch (_) {}

  try {
    if (typeof retryMessages !== 'undefined') retryMessages.clear();
  } catch (_) {}

  state.me = null;
  state.activeFriend = null;
  state.activeGroup = null;
  state.infoGroupId = null;

  state.friends = Object.create(null);
  state.groups = Object.create(null);

  state.unread = Object.create(null);
  state.groupUnread = Object.create(null);

  state.groupVoiceCalls = Object.create(null);
  state.dmVoiceCalls = Object.create(null);
  state.voiceRejoin = Object.create(null);

  state.lastActivity = Object.create(null);
  state.groupLastActivity = Object.create(null);

  state.pendingDeleteId = null;

  selectedGroupMembers = new Set();
  selectedAddMembers = new Set();

  document.title = BASE_TITLE;
}

/* ============================================================================
 * SOUNDS
 * ========================================================================== */

const sfx = (() => {
  let context = null;
  let ringTimer = null;
  let enabled = SOUNDS_ENABLED;

  const activeTones = new Set();

  function getCtx() {
    if (!enabled) return null;

    if (!context || context.state === 'closed') {
      try {
        const AudioContextClass =
          window.AudioContext || window.webkitAudioContext;

        context = AudioContextClass
          ? new AudioContextClass()
          : null;
      } catch (_) {
        context = null;
      }
    }

    if (context?.state === 'suspended') {
      context.resume().catch(() => {});
    }

    return context;
  }

  function stopTones(group = null) {
    for (const entry of [...activeTones]) {
      if (group && entry.group !== group) continue;

      try {
        entry.oscillator.stop();
      } catch (_) {}

      try {
        entry.oscillator.disconnect();
        entry.gain.disconnect();
      } catch (_) {}

      activeTones.delete(entry);
    }
  }

  function tone(
    frequency,
    start,
    duration,
    volume = 0.07,
    type = 'sine',
    group = 'effect',
  ) {
    const ctx = getCtx();

    // Не ставим звуки в очередь в заблокированном контексте.
    if (!ctx || ctx.state !== 'running') return;

    let oscillator;
    let gainNode;

    try {
      const startAt = ctx.currentTime + Math.max(0, start);
      const length = Math.max(0.03, duration);
      const peak = Math.max(0.0002, Math.min(1, volume));

      oscillator = ctx.createOscillator();
      gainNode = ctx.createGain();

      oscillator.type = type;
      oscillator.frequency.value = frequency;

      gainNode.gain.setValueAtTime(0.0001, startAt);
      gainNode.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + length);

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      const entry = {
        oscillator,
        gain: gainNode,
        group,
      };

      activeTones.add(entry);

      oscillator.onended = () => {
        activeTones.delete(entry);

        try {
          oscillator.disconnect();
          gainNode.disconnect();
        } catch (_) {}
      };

      oscillator.start(startAt);
      oscillator.stop(startAt + length + 0.03);
    } catch (_) {
      try {
        oscillator?.disconnect();
        gainNode?.disconnect();
      } catch (_) {}
    }
  }

  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;

    // Останавливаем также уже начатые и запланированные ноты рингтона.
    stopTones('ring');
  }

  function startRing(outgoing = false) {
    stopRing();

    if (!enabled) return;

    const play = () => {
      if (!enabled) return;

      if (outgoing) {
        tone(440, 0, 1, 0.025, 'sine', 'ring');
      } else {
        tone(659, 0, 0.15, 0.07, 'sine', 'ring');
        tone(659, 0.2, 0.15, 0.07, 'sine', 'ring');
        tone(784, 0.4, 0.28, 0.07, 'sine', 'ring');
        tone(659, 0.75, 0.15, 0.06, 'sine', 'ring');
      }
    };

    play();
    ringTimer = setInterval(play, outgoing ? 3000 : 2200);
  }

  function setEnabled(value, persist = true) {
    enabled = !!value;

    if (persist) {
      storage.setItem(SOUNDS_STORAGE_KEY, enabled ? 'on' : 'off');
    }

    if (!enabled) {
      stopRing();
      stopTones();
    } else {
      getCtx();
    }

    return enabled;
  }

  /*
   * Не once: первый жест мог произойти, когда звуки были отключены,
   * или браузер позднее снова приостановил AudioContext.
   */
  const unlock = () => {
    if (enabled && (!context || context.state !== 'running')) {
      getCtx();
    }
  };

  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('keydown', unlock, { passive: true });

  return {
    enabled: () => enabled,

    setEnabled(value) {
      return setEnabled(value, true);
    },

    syncEnabled(value) {
      return setEnabled(value, false);
    },

    toggle() {
      return setEnabled(!enabled, true);
    },

    message() {
      tone(880, 0, 0.12, 0.05);
      tone(1175, 0.08, 0.18, 0.045);
    },

    friend() {
      tone(659, 0, 0.12, 0.05);
      tone(880, 0.1, 0.2, 0.05);
    },

    join() {
      tone(523, 0, 0.1, 0.06);
      tone(784, 0.1, 0.16, 0.06);
    },

    leave() {
      tone(784, 0, 0.1, 0.06);
      tone(523, 0.1, 0.16, 0.06);
    },

    startRing,
    stopRing,

    stopAll() {
      stopRing();
      stopTones();
    },
  };
})();

/* ============================================================================
 * SOCKET.IO
 * ========================================================================== */

const socket = io(BACKEND_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling'],

  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,

  timeout: 20000,
});

// Токен перечитывается перед каждым новым соединением.
socket.auth = callback => {
  callback({
    token: storage.getItem(TOKEN_STORAGE_KEY) || '',
  });
};

function connectSocket() {
  const token = storage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return;

  /*
   * Явный reconnect нужен при входе с другим токеном,
   * даже если старый сокет ещё подключён.
   */
  socket.disconnect();
  socket.connect();
}

function socketRequest(event, payload, timeout = 15000) {
  if (typeof event !== 'string' || !event) {
    return Promise.reject(new TypeError('Некорректное имя события'));
  }

  if (!socket.connected) {
    return Promise.reject(
      new Error('Нет соединения с сервером. Дождитесь переподключения'),
    );
  }

  const snapshot = coreSessionSnapshot();
  const socketId = socket.id;

  const timeoutMs = Number.isFinite(timeout)
    ? Math.max(1000, Math.min(timeout, 120000))
    : 15000;

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;

      socket.off('disconnect', onDisconnect);

      if (error) reject(error);
      else resolve(result);
    };

    const onDisconnect = () => {
      finish(new Error('Соединение прервано. Повторите действие'));
    };

    socket.once('disconnect', onDisconnect);

    try {
      socket.timeout(timeoutMs).emit(event, payload, (error, result) => {
        if (settled) return;

        if (!coreSessionMatches(snapshot) || socket.id !== socketId) {
          finish(new SessionChangedError());
          return;
        }

        if (error) {
          finish(new Error('Нет подтверждения от сервера. Повторите попытку'));
          return;
        }

        if (
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          result.ok !== true
        ) {
          const responseError = new Error(
            typeof result?.error === 'string'
              ? result.error
              : 'Ошибка сервера',
          );

          if (typeof result?.reason === 'string') {
            responseError.reason = result.reason;
          }

          finish(responseError);
          return;
        }

        finish(null, result);
      });
    } catch (error) {
      finish(error);
    }
  });
}

/* ============================================================================
 * GENERIC HELPERS
 * ========================================================================== */

let nicknameSegmenter = null;

try {
  if (typeof Intl.Segmenter === 'function') {
    nicknameSegmenter = new Intl.Segmenter('ru', {
      granularity: 'grapheme',
    });
  }
} catch (_) {}

/** Первый графемный кластер: сохраняет составные эмодзи там, где есть Segmenter. */
function av(nickname) {
  const text = String(nickname ?? '').trim();
  if (!text) return '?';

  if (nicknameSegmenter) {
    const first = nicknameSegmenter.segment(text)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment.toUpperCase();
  }

  return Array.from(text)[0]?.toUpperCase() || '?';
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function coreDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return null;

  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);

  return Number.isFinite(date.getTime()) ? date : null;
}

function fmtTime(value) {
  const date = coreDate(value);
  if (!date) return '';

  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDate(value) {
  const date = coreDate(value);
  if (!date) return '';

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function dayKey(value) {
  const date = coreDate(value);
  if (!date) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function coreCalendarDayNumber(date) {
  /*
   * Сравниваем локальные календарные даты через UTC.
   * Переход на летнее/зимнее время не создаёт сутки длиной 23/25 часов.
   */
  const normalized = new Date(0);

  normalized.setUTCFullYear(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );

  normalized.setUTCHours(0, 0, 0, 0);

  return normalized.getTime() / 86400000;
}

function dayOffset(value) {
  const date = coreDate(value);
  if (!date) return NaN;

  return coreCalendarDayNumber(new Date()) - coreCalendarDayNumber(date);
}

function fmtDayLabel(value) {
  const offset = dayOffset(value);

  if (offset === 0) return 'Сегодня';
  if (offset === 1) return 'Вчера';

  return fmtDate(value);
}

function fmtMsgTime(value) {
  const date = coreDate(value);
  if (!date) return '';

  const offset = dayOffset(date);
  const time = fmtTime(date);

  if (offset === 0) return `Сегодня, в ${time}`;
  if (offset === 1) return `Вчера, в ${time}`;

  return `${date.toLocaleDateString('ru-RU')} ${time}`;
}

function msgTimeRaw(message) {
  return message?.time ??
    message?.timestamp ??
    message?.createdAt ??
    null;
}

/*
 * Одинаковое сообщение без времени получает стабильный fallback,
 * а не новое Date.now() при каждой сортировке.
 */
const messageTimeFallbacks = new WeakMap();

function getMsgTimeMs(message) {
  const date = coreDate(msgTimeRaw(message));
  if (date) return date.getTime();

  if (message && typeof message === 'object') {
    if (!messageTimeFallbacks.has(message)) {
      messageTimeFallbacks.set(message, Date.now());
    }

    return messageTimeFallbacks.get(message);
  }

  return Date.now();
}

function plural(number, one, few, many) {
  const numeric = Number(number);
  const value = Number.isFinite(numeric) ? numeric : 0;
  const absolute = Math.abs(Math.trunc(value));

  const mod10 = absolute % 10;
  const mod100 = absolute % 100;

  if (mod10 === 1 && mod100 !== 11) return `${value} ${one}`;

  if (
    mod10 >= 2 &&
    mod10 <= 4 &&
    (mod100 < 10 || mod100 >= 20)
  ) {
    return `${value} ${few}`;
  }

  return `${value} ${many}`;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    // Отмену не превращаем в успешный пустой ответ.
    if (
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError' ||
      error?.name === 'SessionChangedError'
    ) {
      throw error;
    }

    return {};
  }
}

function setErr(message) {
  setText('auth-error', message || '');
}

function scrollMsgs(containerId) {
  const container = $(containerId);
  if (container) container.scrollTop = container.scrollHeight;
}

function isNearBottom(container) {
  if (!container) return true;

  return container.scrollHeight -
    container.scrollTop -
    container.clientHeight < 120;
}

function placeholderHTML(text, isError = false) {
  const color = isError ? 'var(--red)' : 'var(--text3)';

  return `<div class="msgs-placeholder" style="text-align:center;color:${color};padding:24px;font-size:13px">${esc(text)}</div>`;
}

function clearMsgsPlaceholder(container) {
  container?.querySelectorAll('.msgs-placeholder')
    .forEach(element => element.remove());
}

const MODAL_IDS = [
  'profile-modal',
  'edit-profile-modal',
  'blocked-users-modal',
  'delete-confirm',
  'create-group-modal',
  'group-info-modal',
  'add-members-modal',
];

function closeAllModals() {
  try {
    window.discardPendingAvatar?.();
  } catch (_) {}

  MODAL_IDS.forEach(id => setDisplay(id, 'none'));

  state.pendingDeleteId = null;
  state.infoGroupId = null;
}

let noticeTimer = null;
let noticeSequence = 0;

function showTransientNotice(text) {
  const sequence = ++noticeSequence;
  const message = String(text ?? '');

  const show = () => {
    if (sequence !== noticeSequence) return;

    let element = $('transient-notice');

    if (!element) {
      element = document.createElement('div');
      element.id = 'transient-notice';
      element.className = 'transient-notice';
      element.setAttribute('role', 'status');
      element.setAttribute('aria-live', 'polite');
      element.setAttribute('aria-atomic', 'true');

      document.body.appendChild(element);
    }

    clearTimeout(noticeTimer);

    element.textContent = message;
    element.classList.add('show');

    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      element.classList.remove('show');
    }, 3000);
  };

  if (document.body) show();
  else whenDomReady(show);
}

let connectionBannerSequence = 0;

function setConnBanner(show, text = '') {
  const sequence = ++connectionBannerSequence;

  const update = () => {
    if (sequence !== connectionBannerSequence) return;

    let element = $('conn-banner');

    if (!element) {
      if (!show) return;

      element = document.createElement('div');
      element.id = 'conn-banner';
      element.className = 'conn-banner';
      element.setAttribute('role', 'status');
      element.setAttribute('aria-live', 'polite');

      document.body.appendChild(element);
    }

    element.textContent = String(text ?? '');
    element.classList.toggle('show', !!show);
  };

  if (document.body) update();
  else whenDomReady(update);
}

function updateTitleBadge() {
  const sum = object => Object.values(object || {}).reduce((total, value) => {
    const number = Number(value);

    return total + (
      Number.isFinite(number)
        ? Math.max(0, Math.trunc(number))
        : 0
    );
  }, 0);

  const total = sum(state.unread) + sum(state.groupUnread);

  document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}

/* ============================================================================
 * TEXT FORMATTING
 * ========================================================================== */

const URL_RE = /https?:\/\/[^\s<>"'\uE000\uE001]+/gi;

const STASH_OPEN = '\uE000';
const STASH_CLOSE = '\uE001';
const STASH_RE = /\uE000(\d+)\uE001/g;

/*
 * Динамическая компиляция: браузер без Unicode property escapes
 * не должен падать при разборе всего core.js.
 */
let EMOJI_ONLY_RE = null;

try {
  EMOJI_ONLY_RE = new RegExp(
    '^(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}|' +
    '\\p{Emoji_Modifier}|[0-9#*]\\uFE0F?\\u20E3|' +
    '\\uFE0F|\\u200D|\\s)+$',
    'u',
  );
} catch (_) {}

/** Отделяет пунктуацию от URL в исходном, ещё не экранированном тексте. */
function splitUrlTail(value) {
  let url = value;
  let tail = '';

  for (;;) {
    const punctuation = url.match(/[.,;:!?'"]+$/);

    if (punctuation) {
      url = url.slice(0, -punctuation[0].length);
      tail = punctuation[0] + tail;
      continue;
    }

    const close = url.slice(-1);
    const open = close === ')'
      ? '('
      : close === ']'
        ? '['
        : close === '}'
          ? '{'
          : null;

    if (open) {
      const opens = url.split(open).length - 1;
      const closes = url.split(close).length - 1;

      if (closes > opens) {
        url = url.slice(0, -1);
        tail = close + tail;
        continue;
      }
    }

    break;
  }

  return [url, tail];
}

function coreSafeMessageUrl(value) {
  try {
    const url = new URL(value);

    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (!url.hostname || url.username || url.password) return '';

    return url.href;
  } catch (_) {
    return '';
  }
}

function formatMsgText(raw) {
  /*
   * Служебные маркеры удаляем из входного текста ДО создания stash.
   * Пользователь не может подставить ссылку на внутренний HTML-фрагмент.
   */
  let text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\uE000\uE001]/g, '');

  const stash = [];

  const keep = html => {
    const index = stash.push(html) - 1;
    return `${STASH_OPEN}${index}${STASH_CLOSE}`;
  };

  /*
   * Один проход для block/inline code:
   * более поздний шаблон не захватывает ранее созданные HTML-фрагменты.
   */
  text = text.replace(
    /```(?:[a-z0-9_+-]*\n)?([\s\S]*?)```|`([^`\n]+)`/gi,
    (match, block, inline) => {
      if (block !== undefined) {
        const content = block.replace(/^\n+|\n+$/g, '');
        return keep(
          `<pre class="md-pre"><code>${esc(content)}</code></pre>`,
        );
      }

      return keep(`<code class="md-code">${esc(inline)}</code>`);
    },
  );

  text = text.replace(URL_RE, match => {
    const [urlText, tail] = splitUrlTail(match);
    const href = coreSafeMessageUrl(urlText);

    if (!href) return match;

    return keep(
      `<a href="${esc(href)}" target="_blank" ` +
      'rel="noopener noreferrer nofollow" class="md-link">' +
      `${esc(urlText)}</a>`,
    ) + tail;
  });

  // Весь оставшийся пользовательский текст экранируется.
  text = esc(text);

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  text = text.replace(
    /\|\|([^|\n]+)\|\|/g,
    '<span class="md-spoiler" tabindex="0" role="button" ' +
    'aria-expanded="false" title="Показать спойлер">$1</span>',
  );

  text = text.replace(/\n/g, '<br>');

  return text.replace(STASH_RE, (match, index) => {
    return stash[Number(index)] ?? '';
  });
}

function isJumboEmoji(text) {
  if (typeof text !== 'string' || !EMOJI_ONLY_RE) return false;

  const value = text.trim();

  if (!value || value.length > 40) return false;
  if (/^[\s\uFE0F\u200D]+$/u.test(value)) return false;

  return EMOJI_ONLY_RE.test(value);
}

function revealSpoiler(element) {
  element.classList.add('revealed');
  element.setAttribute('aria-expanded', 'true');
  element.title = 'Спойлер раскрыт';
}

for (const id of ['messages', 'group-messages']) {
  on(id, 'click', event => {
    if (!(event.target instanceof Element)) return;

    const spoiler = event.target.closest('.md-spoiler');
    if (!spoiler) return;

    // Первый клик раскрывает спойлер, а не переходит по скрытой ссылке.
    if (!spoiler.classList.contains('revealed')) {
      event.preventDefault();
      revealSpoiler(spoiler);
    }
  });

  on(id, 'keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof Element)) return;

    const spoiler = event.target.closest('.md-spoiler');
    if (!spoiler || spoiler.classList.contains('revealed')) return;

    event.preventDefault();
    revealSpoiler(spoiler);
  });
}

/* ============================================================================
 * AUTH / SESSION
 * ========================================================================== */

function forceLogoutToLogin(message = '') {
  if (state.loggingOut) return;

  state.loggingOut = true;

  try {
    if (
      callState.active &&
      callState.callId &&
      socket.connected
    ) {
      try {
        socket.emit('callLeave', { callId: callState.callId });
      } catch (_) {}
    }

    /*
     * Отключаем сокет до очистки состояния, чтобы не принимать новые
     * события старого пользователя.
     */
    socket.disconnect();

    // Удаляем токен даже если одна из последующих UI-функций завершится ошибкой.
    storage.removeItem(USER_ID_STORAGE_KEY);
    storage.removeItem(TOKEN_STORAGE_KEY);
    storage.removeItem(PROFILE_STORAGE_KEY);

    sfx.stopAll();
    resetState();

    clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeSequence++;

    $('transient-notice')?.classList.remove('show');

    document.documentElement.classList.remove('has-session');

    closeAllModals();
    setConnBanner(false);

    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.remove('active');
    });

    $('auth-screen')?.classList.add('active');
    setErr(message);

    const friendsList = $('friends-list');
    if (friendsList) friendsList.innerHTML = emptyFriendsHTML();

    const requestsList = $('requests-list');
    if (requestsList) requestsList.replaceChildren();

    setDisplay('requests-section', 'none');

    const groupsList = $('groups-list');
    if (groupsList) groupsList.innerHTML = emptyGroupsHTML();

    try {
      if (typeof closeActiveChat === 'function') closeActiveChat();
    } catch (error) {
      console.warn('[chat] closeActiveChat failed', error);
    }

    document.title = BASE_TITLE;
  } finally {
    state.loggingOut = false;
  }
}

function coreTimeoutError() {
  const error = new Error('Превышено время ожидания ответа сервера');
  error.name = 'TimeoutError';
  return error;
}

/**
 * Авторизованный same-origin fetch.
 *
 * - timeoutMs: 0 отключает собственный таймаут;
 * - внешний signal и таймаут работают одновременно;
 * - смена сессии отменяет запрос;
 * - запросы на другой origin и URL с логином/паролем запрещены;
 * - редиректы по умолчанию запрещены для авторизованного API;
 * - timeout покрывает ожидание Response, не последующее чтение тела.
 *
 * После await response.json() вызывающий код всё равно должен проверять
 * свой seq/sessionRevision, если далее обновляет UI.
 */
async function authFetch(url, options = {}) {
  const {
    timeoutMs = FETCH_TIMEOUT_MS,
    signal: externalSignal,
    ...fetchOptions
  } = options;

  const destination = new URL(url, `${BACKEND_URL}/`);

  if (
    destination.origin !== BACKEND_ORIGIN ||
    !['http:', 'https:'].includes(destination.protocol) ||
    destination.username ||
    destination.password
  ) {
    throw new TypeError(
      'Авторизованные запросы разрешены только к серверу приложения',
    );
  }

  const snapshot = coreSessionSnapshot();
  const headers = new Headers(fetchOptions.headers || {});

  // Не оставляем случайный чужой Authorization из options.
  headers.delete('Authorization');

  if (snapshot.token) {
    headers.set('Authorization', `Bearer ${snapshot.token}`);
  }

  const controller = new AbortController();

  let timer = null;
  let timedOut = false;

  const forwardAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason);
    }
  };

  if (externalSignal?.aborted) {
    forwardAbort();
  } else {
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const duration = Number(timeoutMs);

  if (
    Number.isFinite(duration) &&
    duration > 0 &&
    !controller.signal.aborted
  ) {
    timer = setTimeout(() => {
      if (controller.signal.aborted) return;

      timedOut = true;
      controller.abort();
    }, Math.min(duration, 2147483647));
  }

  activeAuthRequests.add(controller);

  try {
    const response = await fetch(destination.href, {
      ...fetchOptions,

      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',

      headers,
      signal: controller.signal,
    });

    if (!coreSessionMatches(snapshot)) {
      throw new SessionChangedError();
    }

    if (
      response.status === 401 &&
      state.me &&
      snapshot.token
    ) {
      forceLogoutToLogin('Сессия истекла, войдите снова');
      throw new AuthError('Session expired');
    }

    return response;
  } catch (error) {
    if (error instanceof AuthError) throw error;

    if (!coreSessionMatches(snapshot)) {
      throw new SessionChangedError();
    }

    if (timedOut) throw coreTimeoutError();

    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
    activeAuthRequests.delete(controller);
  }
}

function saveAndLogin(user, userId, token) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    setErr('Некорректный ответ сервера');
    return;
  }

  const rawId = userId ?? user.id;

  if (
    !['string', 'number'].includes(typeof rawId) ||
    !String(rawId).trim()
  ) {
    setErr('Некорректный ответ сервера: нет идентификатора пользователя');
    return;
  }

  const id = String(rawId).trim();

  if (user.id != null && String(user.id) !== id) {
    setErr('Некорректный ответ сервера: идентификаторы не совпадают');
    return;
  }

  const storedId = storage.getItem(USER_ID_STORAGE_KEY);

  const mayReuseStoredToken =
    String(state.me?.id ?? storedId ?? '') === id;

  const finalToken = (
    typeof token === 'string' && token.trim()
      ? token
      : mayReuseStoredToken
        ? storage.getItem(TOKEN_STORAGE_KEY)
        : null
  );

  if (typeof finalToken !== 'string' || !finalToken.trim()) {
    setErr('Некорректный ответ сервера: нет токена');
    return;
  }

  const normalizedUser = {
    ...user,
    id,
  };

  let serialized;

  try {
    serialized = JSON.stringify(normalizedUser);
  } catch (_) {
    setErr('Некорректные данные профиля');
    return;
  }

  if (callState.active && callState.callId && socket.connected) {
    try {
      socket.emit('callLeave', { callId: callState.callId });
    } catch (_) {}
  }

  socket.disconnect();
  resetState();

  state.me = normalizedUser;

  storage.setItem(USER_ID_STORAGE_KEY, id);
  storage.setItem(TOKEN_STORAGE_KEY, finalToken);
  storage.setItem(PROFILE_STORAGE_KEY, serialized);

  setErr('');
  enterApp(normalizedUser);
}

function coreRunOptionalTask(label, task) {
  try {
    Promise.resolve(task()).catch(error => {
      if (
        error instanceof AuthError ||
        error instanceof SessionChangedError ||
        error?.name === 'AbortError'
      ) {
        return;
      }

      console.warn(`[app] ${label} failed`, error);
    });
  } catch (error) {
    console.warn(`[app] ${label} failed`, error);
  }
}

function enterApp(user) {
  if (!user || typeof user !== 'object' || user.id == null) {
    setErr('Не удалось открыть профиль');
    return;
  }

  state.loggingOut = false;
  state.me = user;

  renderAv($('my-avatar'), user.nickname, user.avatar);
  setText('my-nick', user.nickname || '');
  setText('my-id', user.id ? `@${user.id}` : '');

  document.querySelectorAll('.screen').forEach(screen => {
    screen.classList.remove('active');
  });

  $('app-screen')?.classList.add('active');
  document.documentElement.classList.add('has-session');

  updateTitleBadge();
  connectSocket();

  coreRunOptionalTask('loadGroups', () => {
    if (typeof loadGroups === 'function') return loadGroups();
  });

  coreRunOptionalTask('refreshMediaSession', refreshMediaSession);
}

/* ============================================================================
 * AVATAR RENDERING
 * ========================================================================== */

const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9._-]{1,120}$/;

function avatarSrc(value) {
  if (typeof value !== 'string') return '';

  const source = value.trim();
  if (!source || source.length > 8192) return '';

  try {
    const url = new URL(source, `${BACKEND_URL}/`);

    if (url.protocol === 'blob:') {
      // Предпросмотр разрешён только для blob нашего origin.
      return url.origin === BACKEND_ORIGIN ? url.href : '';
    }

    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';

    if (url.origin === BACKEND_ORIGIN) {
      if (!UPLOAD_PATH_RE.test(url.pathname)) return '';
    }

    return url.href;
  } catch (_) {
    return '';
  }
}

function renderAv(element, nickname, avatarUrl) {
  if (!element) return;

  element.replaceChildren();

  const source = avatarSrc(avatarUrl);

  if (!source) {
    element.textContent = av(nickname);
    return;
  }

  const image = document.createElement('img');

  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.draggable = false;
  image.referrerPolicy = 'no-referrer';

  image.onerror = () => {
    image.onerror = null;

    // Не удаляем соседнюю точку онлайн-статуса.
    if (image.parentNode === element) {
      image.replaceWith(document.createTextNode(av(nickname)));
    }
  };

  image.src = source;
  element.appendChild(image);
}

function renderAvWithDot(element, nickname, avatarUrl, online) {
  if (!element) return;

  renderAv(element, nickname, avatarUrl);

  element.style.position = 'relative';
  element.style.overflow = 'visible';

  if (online) {
    const dot = document.createElement('div');
    dot.className = 'f-dot';
    dot.title = 'В сети';
    dot.setAttribute('aria-label', 'В сети');

    element.appendChild(dot);
  }
}

function renderGroupAv(element, group) {
  if (!element) return;

  element.replaceChildren();
  element.classList.add('group-av');
  element.classList.remove('g1', 'g2', 'g3', 'g4');

  const members = (
    Array.isArray(group?.members)
      ? group.members.filter(member =>
        member && typeof member === 'object',
      )
      : []
  ).slice(0, 4);

  if (!members.length) {
    element.textContent = '#';
    return;
  }

  const grid = document.createElement('div');
  grid.className = `group-av-grid g${members.length}`;

  for (const member of members) {
    const cell = document.createElement('div');
    cell.className = 'group-av-cell';

    renderAv(cell, member.nickname, member.avatar);
    grid.appendChild(cell);
  }

  element.appendChild(grid);
}

function isGroupOwner(group, userId) {
  if (!group || userId == null) return false;

  if (group.ownerId != null) {
    return String(group.ownerId) === String(userId);
  }

  const members = Array.isArray(group.members) ? group.members : [];

  const member = members.find(item =>
    item?.id != null && String(item.id) === String(userId),
  );

  return member?.role === 'owner';
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

/* ============================================================================
 * MEDIA SESSION COOKIE
 * ========================================================================== */

function refreshMediaSession() {
  if (mediaSessionPromise) return mediaSessionPromise;

  clearTimeout(mediaSessionTimer);
  mediaSessionTimer = null;

  const snapshot = coreSessionSnapshot();

  if (!state.me || !snapshot.token) return Promise.resolve();

  const generation = mediaSessionGeneration;

  let task;

  task = (async () => {
    let nextDelay = MEDIA_SESSION_RETRY_MS;

    try {
      const response = await authFetch(`${BACKEND_URL}/api/me`, {
        timeoutMs: 15000,
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`Media session refresh: HTTP ${response.status}`);
      }

      nextDelay = MEDIA_SESSION_REFRESH_MS;
    } catch (error) {
      if (
        error instanceof AuthError ||
        error instanceof SessionChangedError
      ) {
        return;
      }

      console.warn('[session] media cookie refresh failed', error);
    } finally {
      if (mediaSessionPromise === task) {
        mediaSessionPromise = null;
      }

      if (
        generation === mediaSessionGeneration &&
        coreSessionMatches(snapshot) &&
        state.me
      ) {
        clearTimeout(mediaSessionTimer);

        mediaSessionTimer = setTimeout(() => {
          mediaSessionTimer = null;
          coreRunOptionalTask('refreshMediaSession', refreshMediaSession);
        }, nextDelay);
      }
    }
  })();

  mediaSessionPromise = task;
  return task;
}

/* ============================================================================
 * RTC CONFIG
 * ========================================================================== */

function coreValidIceUrl(value) {
  if (typeof value !== 'string') return false;
  if (!value || value.length > 2048) return false;
  if (/[\s\u0000-\u001F\u007F]/.test(value)) return false;

  return /^(stun|stuns|turn|turns):[^/?#]+(?:\?transport=(?:udp|tcp))?$/i
    .test(value);
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) return [];

  const result = [];

  for (const server of value.slice(0, 32)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      continue;
    }

    const candidates = Array.isArray(server.urls)
      ? server.urls
      : [server.urls];

    let urls = [...new Set(
      candidates.slice(0, 16).filter(coreValidIceUrl),
    )];

    if (!urls.length) continue;

    const hasCredentials =
      typeof server.username === 'string' &&
      server.username.length > 0 &&
      server.username.length <= 4096 &&
      typeof server.credential === 'string' &&
      server.credential.length > 0 &&
      server.credential.length <= 8192;

    /*
     * Для TURN используем стандартные username + password.
     * Неполная конфигурация TURN не должна ломать STUN из той же записи.
     */
    if (!hasCredentials) {
      urls = urls.filter(url => !/^turns?:/i.test(url));
    }

    if (!urls.length) continue;

    const entry = {
      urls: urls.length === 1 ? urls[0] : urls,
    };

    if (urls.some(url => /^turns?:/i.test(url))) {
      entry.username = server.username;
      entry.credential = server.credential;
    }

    result.push(entry);
  }

  return result;
}

function coreHasTurnServer(servers) {
  return servers.some(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

    return urls.some(url => /^turns?:/i.test(url)) &&
      typeof server.username === 'string' &&
      typeof server.credential === 'string';
  });
}

function coreRtcCacheLifetime(config) {
  let lifetime = RTC_CONFIG_CACHE_MS;

  /*
   * Необязательные серверные поля:
   * ttlSeconds / expiresIn — оставшийся срок в секундах;
   * expiresAt — ISO, Unix seconds или Unix milliseconds.
   */
  const ttlSeconds = Number(config.ttlSeconds ?? config.expiresIn);

  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    lifetime = Math.min(lifetime, ttlSeconds * 1000);
  }

  if (config.expiresAt != null) {
    let expiresAt;

    if (typeof config.expiresAt === 'number') {
      expiresAt = config.expiresAt < 1e12
        ? config.expiresAt * 1000
        : config.expiresAt;
    } else {
      expiresAt = Date.parse(config.expiresAt);
    }

    if (Number.isFinite(expiresAt)) {
      lifetime = Math.min(lifetime, expiresAt - Date.now());
    }
  }

  // Обновляем до истечения временных TURN credentials.
  return Math.max(0, lifetime - Math.min(60000, lifetime * 0.1));
}

function configureRTC({ force = false } = {}) {
  const snapshot = coreSessionSnapshot();

  const sessionKey = JSON.stringify([
    snapshot.revision,
    snapshot.userId,
    snapshot.token,
  ]);

  if (rtcConfigSessionKey !== sessionKey) {
    invalidateRTCConfig();
    rtcConfigSessionKey = sessionKey;
  }

  // Одновременные запросы устройств используют один HTTP-запрос.
  if (rtcConfigPromise) return rtcConfigPromise;

  if (!force && Date.now() < rtcConfigExpiresAt) {
    return Promise.resolve(RTC_CONFIG);
  }

  const generation = rtcConfigGeneration;
  const previousPolicy = RTC_CONFIG.iceTransportPolicy;
  const previouslyRequired = window.__chatappRtc?.relayRequired === true;

  let task;

  task = (async () => {
    try {
      const response = await authFetch(`${BACKEND_URL}/api/rtc-config`, {
        timeoutMs: 8000,
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`RTC config: HTTP ${response.status}`);
      }

      const config = await response.json();

      if (
        generation !== rtcConfigGeneration ||
        !coreSessionMatches(snapshot)
      ) {
        throw new SessionChangedError();
      }

      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError('Некорректная конфигурация WebRTC');
      }

      const servers = normalizeIceServers(config.iceServers);
      const relayConfigured = coreHasTurnServer(servers);

      const relayRequired = config.relayRequired === true ||
        config.iceTransportPolicy === 'relay';

      const policy = relayRequired ? 'relay' : 'all';

      const poolSize = (
        Number.isInteger(config.iceCandidatePoolSize) &&
        config.iceCandidatePoolSize >= 0 &&
        config.iceCandidatePoolSize <= 16
      )
        ? config.iceCandidatePoolSize
        : 0;

      /*
       * relay-only не понижаем до all, даже если TURN отсутствует:
       * это может быть не просто оптимизация, а требование приватности.
       */
      RTC_CONFIG.iceServers = servers.length
        ? servers
        : policy === 'relay'
          ? []
          : defaultIceServers();

      RTC_CONFIG.iceTransportPolicy = policy;
      RTC_CONFIG.iceCandidatePoolSize = poolSize;

      const missingRequiredRelay = relayRequired && !relayConfigured;

      window.__chatappRtc = {
        relayConfigured,
        relayRequired,
        relayError: typeof config.relayError === 'string'
          ? config.relayError
          : missingRequiredRelay
            ? 'Сервер требует TURN, но не вернул рабочие параметры TURN'
            : null,
        configError: missingRequiredRelay,
        policy,
      };

      rtcConfigAt = Date.now();

      rtcConfigExpiresAt = rtcConfigAt + (
        missingRequiredRelay
          ? RTC_CONFIG_RETRY_MS
          : coreRtcCacheLifetime(config)
      );

      return RTC_CONFIG;
    } catch (error) {
      if (
        generation !== rtcConfigGeneration ||
        !coreSessionMatches(snapshot)
      ) {
        throw new SessionChangedError();
      }

      if (
        error instanceof AuthError ||
        error instanceof SessionChangedError
      ) {
        throw error;
      }

      const policy = previousPolicy === 'relay' || previouslyRequired
        ? 'relay'
        : 'all';

      RTC_CONFIG.iceServers = policy === 'relay'
        ? []
        : defaultIceServers();

      RTC_CONFIG.iceTransportPolicy = policy;
      RTC_CONFIG.iceCandidatePoolSize = 0;

      window.__chatappRtc = {
        relayConfigured: false,
        relayRequired: policy === 'relay',
        relayError: error?.message || 'Не удалось получить RTC-конфигурацию',
        configError: true,
        policy,
      };

      rtcConfigAt = Date.now();
      rtcConfigExpiresAt = rtcConfigAt + RTC_CONFIG_RETRY_MS;

      console.warn('[rtc] configuration unavailable', error);

      /*
       * При all остаётся STUN fallback.
       * При relay соединение без TURN не заработает — UI может показать
       * window.__chatappRtc.relayError.
       */
      return RTC_CONFIG;
    } finally {
      if (
        generation === rtcConfigGeneration &&
        rtcConfigPromise === task
      ) {
        rtcConfigPromise = null;
      }
    }
  })();

  rtcConfigPromise = task;
  return task;
}

/* ============================================================================
 * CROSS-TAB / LIFECYCLE
 * ========================================================================== */

window.addEventListener('storage', event => {
  try {
    if (event.storageArea !== window.localStorage) return;
  } catch (_) {
    return;
  }

  if (event.key === null) {
    // localStorage.clear() в другой вкладке.
    for (const key of [...storage.memory.keys()]) {
      if (!storage.pending.has(key)) storage.memory.delete(key);
    }

    if (state.me && !storage.pending.has(TOKEN_STORAGE_KEY)) {
      forceLogoutToLogin('Сессия завершена в другой вкладке');
    }

    return;
  }

  const previousValue = storage.memory.get(event.key);

  if (!storage.pending.has(event.key)) {
    storage.memory.set(event.key, event.newValue);
  }

  if (
    event.key === SOUNDS_STORAGE_KEY &&
    !storage.pending.has(SOUNDS_STORAGE_KEY)
  ) {
    sfx.syncEnabled(event.newValue !== 'off');
  }

  if (
    event.key === TOKEN_STORAGE_KEY &&
    state.me &&
    !storage.pending.has(TOKEN_STORAGE_KEY) &&
    previousValue !== event.newValue
  ) {
    /*
     * Не удаляем новый токен, установленный другой вкладкой.
     * При перезагрузке стандартный код восстановления проверит его.
     */
    socket.disconnect();
    resetState();
    window.location.reload();
  }
});

window.addEventListener('online', () => {
  storage.flush();

  if (state.me && storage.getItem(TOKEN_STORAGE_KEY)) {
    coreRunOptionalTask('refreshMediaSession', refreshMediaSession);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;

  storage.flush();

  if (
    state.me &&
    !mediaSessionPromise &&
    !mediaSessionTimer
  ) {
    coreRunOptionalTask('refreshMediaSession', refreshMediaSession);
  }
});

window.addEventListener('pagehide', () => {
  sfx.stopAll();
});

/* ============================================================================
 * INITIAL RTC DIAGNOSTICS
 * ========================================================================== */

window.__chatappRtc = {
  relayConfigured: false,
  relayRequired: false,
  relayError: null,
  configError: false,
  policy: RTC_CONFIG.iceTransportPolicy,
};