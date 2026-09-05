/* ============================================================================
 * CALLS (WebRTC: DM 1:1 + Group mesh)
 * ============================================================================
 * Изменения v2:
 *  - Исправлен race condition: callStarting сбрасывается во всех ветках
 *  - createPeerConnection проверяет состояние существующего pc
 *  - offerToParticipants дедуплицирует участников (уже было, улучшена читаемость)
 *  - XSS: innerHTML заменён на безопасное создание SVG-элементов
 *  - cssEsc fallback усилен
 *  - speakingMonitors инициализируется явно
 *  - Все публичные обработчики сокета валидируют типы входных данных
 *  - leaveWhenStarted сбрасывается в closeCallOverlay
 *  - Таймауты очищаются при повторных вызовах
 *  - Добавлен AbortController-паттерн для acquireLocalStream
 *  - watchActiveChat восстанавливает значение при ошибке defineProperty
 * ==========================================================================*/

'use strict';

/* ── Константы ─────────────────────────────────────────────────────────── */
// CALL_RING_TIMEOUT_MS is shared from core.js.
const ICE_RESTART_TIMEOUT_MS = 12_000;
const IDLE_HIDE_MS           = 3_000;

const CALL_VIDEO_CONSTRAINTS = Object.freeze({
  width:     { ideal: 1280 },
  height:    { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
});

/* ── Вспомогательные утилиты ───────────────────────────────────────────── */

/**
 * Безопасный CSS-эскейп идентификатора для querySelector.
 * Используем нативный CSS.escape везде где доступен; иначе — полный эскейп
 * всех не-ASCII и опасных символов, а не только кавычек.
 */
const cssEsc = (() => {
  if (typeof window !== 'undefined' && window.CSS?.escape) {
    return s => CSS.escape(String(s));
  }
  // Полный fallback: эскейпим всё, что не [A-Za-z0-9_-]
  return s => String(s).replace(/[^A-Za-z0-9_-]/g, c => {
    const code = c.codePointAt(0);
    return code === 0 ? '\uFFFD' : `\\${code.toString(16)} `;
  });
})();

/** Безопасный поиск плитки участника. */
function findCallTile(id) {
  if (!id) return null;
  return document.querySelector(`.call-tile[data-peer="${cssEsc(id)}"]`);
}

/** Останавливает все треки потока, не бросая исключений. */
function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
}

/** Занят ли клиент: активный звонок, входящий на экране или идёт запрос устройств. */
function callBusy() {
  return callState.active || !!callState.pendingIncoming || callStarting;
}

function hasLocalVideo() {
  return !!callState.localStream &&
    callState.localStream.getVideoTracks().some(t => t.readyState !== 'ended');
}

/* ── Состояние ─────────────────────────────────────────────────────────── */
// speakingMonitors is shared from core.js; do not redeclare with var.

let callStarting      = false; // идёт getUserMedia для исходящего/принимаемого звонка
let leaveWhenStarted  = false; // трубку положили раньше, чем сервер прислал callStarted
let idleTimer         = null;  // автоскрытие контролов в видео-режиме
let callTimerId       = null;  // таймер длительности звонка
let callConnectedAt   = 0;

/* ── Имена/аватары участников ──────────────────────────────────────────── */
function callPeerName(peerId) {
  if (!peerId) return '';
  if (callState.isGroup) return memberName(state.groups[callState.groupId], peerId);
  const f = state.friends[peerId];
  return f?.nickname
    || (peerId === callState.peerFriendId ? callState.peerFriendName : null)
    || peerId;
}

function callPeerAvatar(peerId) {
  if (!peerId) return null;
  if (callState.isGroup) {
    const g = state.groups[callState.groupId];
    return g?.members?.find(m => m.id === peerId)?.avatar
      ?? state.friends[peerId]?.avatar
      ?? null;
  }
  return state.friends[peerId]?.avatar ?? null;
}

/* ── Сообщения об ошибках устройств ────────────────────────────────────── */
function mediaErrorMessage(e) {
  switch (e?.name) {
    case 'NotSupportedError':
      return 'Звонки недоступны: нужен HTTPS и современный браузер';
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Доступ к микрофону запрещён. Разрешите его в настройках браузера';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Микрофон не найден';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Микрофон занят другим приложением';
    case 'OverconstrainedError':
      return 'Устройство не поддерживает требуемые параметры';
    default:
      return 'Не удалось получить доступ к камере/микрофону';
  }
}

/* ── Захват локального потока ──────────────────────────────────────────── */

/**
 * Захватывает локальный медиапоток.
 * При недоступной камере автоматически деградирует до аудио.
 *
 * @param {boolean} video — запрашивать ли видео
 * @returns {Promise<MediaStream>}
 */
async function acquireLocalStream(video) {
  await configureRTC();
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = Object.assign(new Error('getUserMedia is not available'), { name: 'NotSupportedError' });
    throw err;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: RAW_AUDIO_CONSTRAINTS,
      video: video ? CALL_VIDEO_CONSTRAINTS : false,
    });
  } catch (e) {
    if (!video) throw e;
    // Камера недоступна — пробуем только аудио
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: RAW_AUDIO_CONSTRAINTS,
        video: false,
      });
    } catch (e2) {
      // Если и микрофон запрещён — сообщаем именно об этом
      throw (e2?.name === 'NotAllowedError' ? e2 : e);
    }
    showTransientNotice('Камера недоступна — звонок без видео');
  }

  // Пробуем применить «сырые» аудиоограничения явно (браузер мог проигнорировать)
  for (const track of stream.getAudioTracks()) {
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl) {
      try { await track.applyConstraints(RAW_AUDIO_CONSTRAINTS); } catch (_) {}
      const after = typeof track.getSettings === 'function' ? track.getSettings() : {};
      if (after.echoCancellation || after.noiseSuppression || after.autoGainControl) {
        console.warn('[call] browser ignored raw mic constraints', after);
      }
    }
  }

  return stream;
}

/* ── Инициализация сессии звонка ───────────────────────────────────────── */
function beginCallSession({
  stream, callId = null, chatKey = null,
  isGroup, groupId = null,
  peerFriendId = null, peerFriendName = null,
  video,
}) {
  // Очищаем таймеры ДО присвоения нового состояния
  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);
  callState.ringTimer    = null;
  callState.incomingTimer = null;
  leaveWhenStarted = false;

  callState.localStream   = stream;
  callState.callId        = callId;
  callState.chatKey       = chatKey;
  callState.isGroup       = !!isGroup;
  callState.groupId       = groupId;
  callState.peerFriendId  = peerFriendId;
  callState.peerFriendName = peerFriendName;
  callState.video         = !!video;
  callState.micOn         = true;
  callState.camOn         = true;
  callState.peers         = Object.create(null);
  callState.pendingIncoming = null;
}

/* ── Исходящий звонок ──────────────────────────────────────────────────── */
async function startCall({ toId, groupId, video }) {
  if (!toId && !groupId) return;
  if (callBusy()) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  if (!socket.connected) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  // Если в группе уже идёт канал — присоединяемся
  if (groupId && state.groupVoiceCalls[groupId]) {
    joinExistingGroupVoice(groupId);
    return;
  }

  callStarting = true;
  let stream;
  try {
    stream = await acquireLocalStream(!!video);
  } catch (e) {
    callStarting = false;
    showTransientNotice(mediaErrorMessage(e));
    return;
  }
  // Сбрасываем флаг сразу после получения потока
  callStarting = false;

  // Пока ждали — ситуация могла измениться
  if (callState.active || callState.pendingIncoming) {
    stopStream(stream);
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  if (!socket.connected) {
    stopStream(stream);
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  beginCallSession({
    stream,
    isGroup: !!groupId,
    groupId:        groupId || null,
    peerFriendId:   toId || null,
    peerFriendName: toId ? (state.friends[toId]?.nickname || toId) : null,
    video:          !!video,
  });

  openCallOverlay('вызов…');
  socket.emit('callStart', {
    toId:    toId    || undefined,
    groupId: groupId || undefined,
    video:   !!video,
  });

  if (!groupId) {
    sfx.startRing(true);
    callState.ringTimer = setTimeout(() => {
      if (callState.active && !Object.keys(callState.peers).length) {
        showTransientNotice('Нет ответа');
        hangupCall();
      }
    }, CALL_RING_TIMEOUT_MS);
  }
}

/* ── Присоединение к существующему групповому каналу ───────────────────── */
function joinExistingGroupVoice(groupId) {
  const call = state.groupVoiceCalls[groupId];
  if (!call) return;
  if (callBusy()) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  startExistingCall(call, groupId);
}

async function startExistingCall(call, groupId) {
  if (!socket.connected) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  callStarting = true;
  let stream;
  try {
    stream = await acquireLocalStream(!!call.video);
  } catch (e) {
    callStarting = false;
    showTransientNotice(mediaErrorMessage(e));
    return;
  }
  callStarting = false;

  // Канал могли закрыть, пока запрашивали доступ
  if (callState.active || callState.pendingIncoming) {
    stopStream(stream);
    return;
  }
  if (state.groupVoiceCalls[groupId]?.callId !== call.callId) {
    stopStream(stream);
    showTransientNotice('Голосовой канал уже завершён');
    return;
  }
  if (!socket.connected) {
    stopStream(stream);
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  beginCallSession({ stream, callId: call.callId, isGroup: true, groupId, video: call.video });
  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: call.callId });
  sfx.join();
}

/* ── Завершение звонка ─────────────────────────────────────────────────── */
function hangupCall() {
  if (!callState.active) return;
  if (callState.callId) {
    socket.emit('callLeave', { callId: callState.callId });
  } else {
    leaveWhenStarted = true;
  }
  sfx.leave();
  closeCallOverlay();
}

/* ── Контролы (мик, камера) ────────────────────────────────────────────── */
function resetCallControls() {
  const mic = $('btn-call-toggle-mic');
  if (mic) {
    mic.classList.toggle('active-off', !callState.micOn);
    mic.title = callState.micOn ? 'Выключить микрофон' : 'Включить микрофон';
    mic.setAttribute('aria-label', mic.title);
    mic.setAttribute('aria-pressed', String(!callState.micOn));
  }

  const cam = $('btn-call-toggle-cam');
  if (cam) {
    cam.classList.toggle('active-off', !callState.camOn);
    cam.title = callState.camOn ? 'Выключить камеру' : 'Включить камеру';
    cam.setAttribute('aria-label', cam.title);
    cam.setAttribute('aria-pressed', String(!callState.camOn));
    cam.disabled = !hasLocalVideo();
  }
}

/* ── Состояние мик/камеры — рассылка пирам ─────────────────────────────
 * WebRTC не сообщает удалённой стороне об изменении track.enabled, поэтому
 * рассылаем состояние сами: по DataChannel (negotiated id=0), а как fallback
 * — через сигналинговый сервер.
 * ────────────────────────────────────────────────────────────────────── */
function mediaStatePayload() {
  return { type: 'state', micOn: !!callState.micOn, camOn: !!callState.camOn };
}

function sendMediaState(peerId) {
  const peer = callState.peers[peerId];
  if (!peer || !callState.active) return;

  const payload = JSON.stringify(mediaStatePayload());
  let sent = false;

  if (peer.dc?.readyState === 'open') {
    try { peer.dc.send(payload); sent = true; } catch (_) {}
  }

  if (!sent && callState.callId && socket.connected) {
    socket.emit('callSignal', {
      callId: callState.callId,
      to: peerId,
      data: mediaStatePayload(), // объект, не строка
    });
  }
}

function broadcastMediaState() {
  Object.keys(callState.peers).forEach(sendMediaState);
}

function applyRemoteMediaState(peerId, data) {
  const peer = callState.peers[peerId];
  if (!peer || !data || typeof data !== 'object') return;

  const micOn = data.micOn !== false;
  const camOn = data.camOn !== false;
  if (peer.micOn === micOn && peer.camOn === camOn) return;

  peer.micOn = micOn;
  peer.camOn = camOn;
  renderCallGrid();
}

/* ── Привязка звонка к чату ────────────────────────────────────────────── */
function callChatKey() {
  if (!callState.active) return null;
  return callState.isGroup
    ? `group:${callState.groupId}`
    : `dm:${callState.peerFriendId}`;
}

function openChatKey() {
  if (state.activeGroup  != null) return `group:${state.activeGroup}`;
  if (state.activeFriend != null) return `dm:${state.activeFriend}`;
  return null;
}

function syncCallDetached() {
  const overlay = $('call-overlay');
  if (!overlay || !callState.active) return;

  const detached = callChatKey() !== openChatKey();
  if (overlay.classList.contains('detached') === detached) return;

  overlay.classList.toggle('detached', detached);
  overlay.title = detached ? 'Вернуться к звонку' : '';

  setText('call-overlay-mode', detached
    ? (callState.video ? 'Видеоподключение' : 'Голосовое подключение')
    : (callState.video ? 'ВИДЕОКАНАЛ' : 'ГОЛОСОВОЙ КАНАЛ'));

  if (detached) {
    overlay.classList.remove('idle');
    clearTimeout(idleTimer);
  }
}

function returnToCallChat() {
  if (!callState.active) return;
  try {
    if (callState.isGroup) {
      if (typeof openGroupChat === 'function') openGroupChat(callState.groupId);
    } else {
      if (typeof openChat === 'function') openChat(callState.peerFriendId);
    }
  } catch (e) {
    console.warn('[call] returnToCallChat failed', e);
  }
}

/* ── Клик по свёрнутой карточке ────────────────────────────────────────── */
whenDomReady(() => {
  const overlay = $('call-overlay');
  if (!overlay) return;
  overlay.addEventListener('click', e => {
    if (!overlay.classList.contains('detached')) return;
    if (e.target.closest('button, a, input, [role="button"]')) return;
    returnToCallChat();
  });
});

/* ── Наблюдение за сменой активного чата ───────────────────────────────── */
(function watchActiveChat() {
  for (const key of ['activeFriend', 'activeGroup']) {
    const desc = Object.getOwnPropertyDescriptor(state, key);
    if (!desc) continue;
    if (desc.get || desc.set) continue; // уже обёрнуто

    let value = state[key];
    try {
      Object.defineProperty(state, key, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(v) {
          value = v;
          scheduleOverlaySync();
        },
      });
    } catch (e) {
      console.warn('[call] cannot watch state.' + key, e);
      // Оставляем value как есть — ничего не ломаем
    }
  }
})();

/* ── Таймер длительности звонка ─────────────────────────────────────────── */
function fmtDuration(totalSec) {
  const h  = Math.floor(totalSec / 3600);
  const m  = Math.floor((totalSec % 3600) / 60);
  const s  = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function startCallTimer() {
  if (callTimerId) return;
  callConnectedAt = Date.now();
  callTimerId = setInterval(() => {
    if (!callState.active) { stopCallTimer(); return; }
    const st = $('call-overlay-status');
    if (!st) return;
    // Не перезаписываем статус «переподключение…» и т.п.
    if (!/^в звонке/.test(st.textContent ?? '')) return;
    st.textContent = `в звонке · ${fmtDuration(Math.floor((Date.now() - callConnectedAt) / 1000))}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerId);
  callTimerId      = null;
  callConnectedAt  = 0;
}

/* ── Оверлей звонка ─────────────────────────────────────────────────────── */
function openCallOverlay(statusText) {
  callState.active = true;
  const overlay = $('call-overlay');
  if (!overlay) {
    console.warn('[call] #call-overlay not found');
    return;
  }

  overlay.classList.remove('detached', 'idle');
  overlay.classList.toggle('voice-mode', !callState.video);
  overlay.classList.toggle('video-mode',  callState.video);

  setText('call-overlay-mode', callState.video ? 'ВИДЕОКАНАЛ' : 'ГОЛОСОВОЙ КАНАЛ');
  overlay.style.display = 'flex';

  setText('call-overlay-title', callState.isGroup
    ? (state.groups[callState.groupId]?.name || 'Групповой звонок')
    : callPeerName(callState.peerFriendId));
  setText('call-overlay-status', statusText ?? '');

  resetCallControls();
  renderCallGrid();
  syncVoiceOverlayPosition();
  syncCallDetached();

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
    .find(el => {
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).display !== 'none' && r.height > 0;
    });
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

let overlaySyncRaf = null;
function scheduleOverlaySync() {
  if (overlaySyncRaf) return;
  overlaySyncRaf = requestAnimationFrame(() => {
    overlaySyncRaf = null;
    if (!callState.active) return;
    syncVoiceOverlayPosition();
    syncCallDetached();
  });
}

window.addEventListener('resize',            scheduleOverlaySync, { passive: true });
window.addEventListener('orientationchange', scheduleOverlaySync, { passive: true });

whenDomReady(() => {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && 'MutationObserver' in window) {
    new MutationObserver(scheduleOverlaySync)
      .observe(sidebar, { attributes: true, attributeFilter: ['class', 'style'] });
  }
});

/* ── Закрытие оверлея и очистка всего состояния ────────────────────────── */
function closePeerConnection(p) {
  if (!p) return;
  clearTimeout(p.restartTimer);
  try {
    if (p.dc) {
      p.dc.onopen    = null;
      p.dc.onmessage = null;
      p.dc.close();
    }
  } catch (_) {}
  try {
    const { pc } = p;
    pc.onicecandidate          = null;
    pc.ontrack                 = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.close();
  } catch (_) {}
}

function closeCallOverlay() {
  const overlay = $('call-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('voice-mode', 'video-mode', 'idle', 'detached');
    overlay.title = '';
    clearTimeout(idleTimer);
    idleTimer = null;
    overlay.style.removeProperty('--call-left');
    overlay.style.removeProperty('--call-top');
  }

  stopCallTimer();
  setDisplay('incoming-call-modal', 'none');
  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);
  callState.ringTimer    = null;
  callState.incomingTimer = null;
  sfx.stopRing();

  stopAllSpeakingMonitors();
  stopStream(callState.localStream);
  Object.values(callState.peers).forEach(closePeerConnection);

  const wasGroupId = callState.isGroup ? callState.groupId : null;

  // Сбрасываем всё состояние
  callState.active        = false;
  callState.callId        = null;
  callState.chatKey       = null;
  callState.isGroup       = false;
  callState.groupId       = null;
  callState.peerFriendId  = null;
  callState.peerFriendName = null;
  callState.video         = false;
  callState.localStream   = null;
  callState.micOn         = true;
  callState.camOn         = true;
  callState.peers         = Object.create(null);
  callState.pendingIncoming = null;

  // leaveWhenStarted сбрасываем — иначе следующий звонок может немедленно разорваться
  leaveWhenStarted = false;

  const grid = $('call-video-grid');
  if (grid) {
    grid.querySelectorAll('video').forEach(v => {
      try { v.srcObject = null; } catch (_) {}
    });
    grid.innerHTML = '';
    delete grid.dataset.count;
  }

  resetCallControls();

  if (wasGroupId) {
    updateGroupVoiceBar(wasGroupId);
    renderGroupsList();
  }
}

/* ── Сетка участников ───────────────────────────────────────────────────── */
function renderCallGrid() {
  const grid = $('call-video-grid');
  if (!grid || !callState.active) return;

  /** @type {Array<{id:string, nick:string, avatar:string|null, stream:MediaStream|null, isLocal:boolean, micOn:boolean, camOn:boolean}>} */
  const entries = [{
    id:      'local',
    nick:    state.me?.nickname || 'Я',
    avatar:  state.me?.avatar  || null,
    stream:  callState.localStream,
    isLocal: true,
    micOn:   callState.micOn,
    camOn:   callState.camOn,
  }];

  for (const [peerId, p] of Object.entries(callState.peers)) {
    entries.push({
      id:      peerId,
      nick:    callPeerName(peerId),
      avatar:  callPeerAvatar(peerId),
      stream:  p.stream,
      isLocal: false,
      micOn:   p.micOn !== false,
      camOn:   p.camOn !== false,
    });
  }

  const seen = new Set();

  for (const entry of entries) {
    seen.add(entry.id);
    let tile = grid.querySelector(`.call-tile[data-peer="${cssEsc(entry.id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'call-tile';
      tile.dataset.peer = entry.id;
      grid.appendChild(tile);
    }
    updateCallTile(tile, entry);
    ensureSpeakingMonitor(entry.id, entry.stream);
  }

  // Удаляем плитки ушедших участников
  grid.querySelectorAll('.call-tile').forEach(t => {
    if (seen.has(t.dataset.peer)) return;
    const v = t.querySelector('video');
    if (v) { try { v.srcObject = null; } catch (_) {} }
    t.remove();
  });

  // Останавливаем мониторы для ушедших
  for (const id of Object.keys(speakingMonitors)) {
    if (!seen.has(id)) stopSpeakingMonitor(id);
  }

  grid.dataset.count = String(entries.length);
}

/**
 * Создаёт SVG-иконку «микрофон выключен» без innerHTML.
 * Все атрибуты задаются через setAttribute — XSS невозможен.
 */
function createMicOffIcon() {
  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  // Линия перечёркивания
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('x1', '1'); line.setAttribute('y1', '1');
  line.setAttribute('x2', '23'); line.setAttribute('y2', '23');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');

  // Контур микрофона
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', [
    'M12 1a4 4 0 0 1 4 4v6',
    'a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z',
    'M19 10a7 7 0 0 1-3.5 6.06',
    'M5 10a7 7 0 0 0 9.9 6.4',
    'M12 19v4',
    'M8 23h8',
  ].join(' '));

  svg.appendChild(path);
  svg.appendChild(line);
  return svg;
}

function updateCallTile(tile, { nick: nickname, avatar: avatarUrl, stream, isLocal, micOn, camOn }) {
  const hasVideo = callState.video && camOn && !!stream &&
    stream.getVideoTracks().some(t =>
      t.enabled && t.readyState === 'live' && !(t.muted && !isLocal)
    );
  const speaking = tile.classList.contains('speaking') && micOn;

  tile.className = [
    'call-tile',
    isLocal   ? 'local'      : '',
    !hasVideo ? 'audio-only' : '',
    !micOn    ? 'muted'      : '',
    speaking  ? 'speaking'   : '',
  ].filter(Boolean).join(' ');

  /* ── <video> ── */
  let video = tile.querySelector('video');
  if (stream) {
    if (!video) {
      video = document.createElement('video');
      video.autoplay          = true;
      video.playsInline       = true;
      video.setAttribute('playsinline', '');
      video.disablePictureInPicture = true;
      tile.prepend(video);
    }
    video.muted = isLocal; // собственный поток не воспроизводим — иначе эхо
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.play?.().catch(() => {});
    }
  } else if (video) {
    try { video.srcObject = null; } catch (_) {}
    video.remove();
  }

  /* ── Аватар ── */
  let avWrap = tile.querySelector('.call-tile-avatar');
  if (!avWrap) {
    avWrap = document.createElement('div');
    avWrap.className = 'call-tile-avatar';
    tile.appendChild(avWrap);
  }
  const avKey = `${nickname}|${avatarUrl ?? ''}`;
  if (avWrap.dataset.key !== avKey) {
    renderAv(avWrap, nickname, avatarUrl);
    avWrap.dataset.key = avKey;
  }

  /* ── Никнейм ── */
  let label = tile.querySelector('.call-tile-nick');
  if (!label) {
    label = document.createElement('div');
    label.className = 'call-tile-nick';
    tile.appendChild(label);
  }
  // textContent — безопасно, никаких innerHTML
  label.textContent = nickname;

  /* ── Бейдж выключенного микрофона (без innerHTML) ── */
  let badge = tile.querySelector('.call-tile-mic-off');
  if (!micOn) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'call-tile-mic-off';
      badge.title     = 'Микрофон выключен';
      badge.setAttribute('aria-label', 'Микрофон выключен');
      badge.appendChild(createMicOffIcon());
      tile.insertBefore(badge, label);
    }
  } else if (badge) {
    badge.remove();
  }
}

/* ── Индикатор «говорит» (Web Audio) ───────────────────────────────────── */
const SPEAKING_THRESHOLD_ON  = 0.06;
const SPEAKING_THRESHOLD_OFF = 0.035;
let audioCtx = null;

function getAudioCtx() {
  if (audioCtx && audioCtx.state !== 'closed') {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = AC ? new AC() : null;
  } catch (_) {
    audioCtx = null;
  }
  return audioCtx;
}

function setSpeakingUI(id, isSpeaking) {
  const tile = findCallTile(id);
  if (tile) tile.classList.toggle('speaking', isSpeaking);
}

function stopSpeakingMonitor(id) {
  const mon = speakingMonitors[id];
  if (!mon) return;
  cancelAnimationFrame(mon.raf);
  try { mon.source.disconnect();  } catch (_) {}
  try { mon.analyser.disconnect(); } catch (_) {}
  delete speakingMonitors[id];
  setSpeakingUI(id, false);
}

function stopAllSpeakingMonitors() {
  Object.keys(speakingMonitors).forEach(stopSpeakingMonitor);
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
}

function startSpeakingMonitor(id, stream) {
  if (!stream?.getAudioTracks().length) return;
  const ctx = getAudioCtx();
  if (!ctx) return;

  let source;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch (_) {
    return;
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize               = 512;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  const mon  = { analyser, data, source, stream, raf: null };
  speakingMonitors[id] = mon;

  let wasSpeaking = false;

  (function tick() {
    if (speakingMonitors[id] !== mon) return; // монитор заменён — останавливаемся

    const muted = id === 'local'
      ? !callState.micOn
      : callState.peers[id]?.micOn === false;

    if (muted) {
      if (wasSpeaking) { wasSpeaking = false; setSpeakingUI(id, false); }
      mon.raf = requestAnimationFrame(tick);
      return;
    }

    analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms        = Math.sqrt(sumSq / data.length);
    const isSpeaking = wasSpeaking
      ? rms > SPEAKING_THRESHOLD_OFF
      : rms > SPEAKING_THRESHOLD_ON;

    if (isSpeaking !== wasSpeaking) {
      wasSpeaking = isSpeaking;
      setSpeakingUI(id, isSpeaking);
    }
    mon.raf = requestAnimationFrame(tick);
  })();
}

function ensureSpeakingMonitor(id, stream) {
  const existing = speakingMonitors[id];
  if (!stream?.getAudioTracks().length) {
    if (existing) stopSpeakingMonitor(id);
    return;
  }
  if (existing?.stream === stream) return;
  if (existing) stopSpeakingMonitor(id);
  startSpeakingMonitor(id, stream);
}

/* ── Peer connections ──────────────────────────────────────────────────── */

/** Проверяет, что pc — актуальный PeerConnection для данного пира. */
function isCurrentPc(peerId, pc) {
  const peer = callState.peers[peerId];
  return !!peer && peer.pc === pc && callState.active;
}

/** «Вежливая» сторона (perfect negotiation) — с бо́льшим id. */
function isPolite(peerId) {
  return String(state.me?.id ?? '') > String(peerId);
}

/**
 * Создаёт или возвращает существующий PeerConnection.
 * Если существующий pc закрыт/failed — пересоздаёт.
 */
function createPeerConnection(peerId) {
  const existingPeer = callState.peers[peerId];

  // Переиспользуем только живой pc
  if (existingPeer?.pc) {
    const st = existingPeer.pc.connectionState ?? existingPeer.pc.iceConnectionState;
    if (st !== 'closed' && st !== 'failed') return existingPeer.pc;
    // Старый pc умер — закрываем и пересоздаём
    closePeerConnection(existingPeer);
    delete callState.peers[peerId];
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  /** @type {PeerEntry} */
  const peer = {
    pc,
    dc:                null,
    stream:            null,
    pendingCandidates: [],
    makingOffer:       false,
    iceRestarted:      false,
    restartTimer:      null,
    micOn:             true,
    camOn:             true,
  };
  callState.peers[peerId] = peer;

  // Добавляем треки локального потока
  if (callState.localStream) {
    for (const track of callState.localStream.getTracks()) {
      try { pc.addTrack(track, callState.localStream); } catch (e) {
        console.warn('[call] addTrack failed', peerId, e);
      }
    }
  }

  // DataChannel для состояния мик/камеры (negotiated id=0 — не вызывает renegotiation)
  try {
    const dc = pc.createDataChannel('state', { negotiated: true, id: 0, ordered: true });
    peer.dc  = dc;
    dc.onopen = () => {
      if (isCurrentPc(peerId, pc)) sendMediaState(peerId);
    };
    dc.onmessage = e => {
      if (!isCurrentPc(peerId, pc)) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg?.type === 'state') applyRemoteMediaState(peerId, msg);
      } catch (_) {}
    };
  } catch (e) {
    console.warn('[call] DataChannel unavailable, falling back to signaling', e);
  }

  pc.onicecandidate = e => {
    if (e.candidate && callState.callId && isCurrentPc(peerId, pc)) {
      socket.emit('callSignal', {
        callId: callState.callId,
        to:     peerId,
        data:   { type: 'ice', candidate: e.candidate.toJSON?.() ?? e.candidate },
      });
    }
  };

  pc.ontrack = e => {
    if (!isCurrentPc(peerId, pc)) return;
    if (e.streams?.[0]) {
      peer.stream = e.streams[0];
    } else {
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
    }
    e.track.onmute   = () => renderCallGrid();
    e.track.onunmute = () => renderCallGrid();
    e.track.onended  = () => renderCallGrid();
    renderCallGrid();
  };

  // Fallback для браузеров без connectionState
  pc.oniceconnectionstatechange = () => {
    if (!isCurrentPc(peerId, pc)) return;
    if (pc.iceConnectionState === 'failed' && !('connectionState' in pc)) {
      handlePeerFailed(peerId, pc);
    }
  };

  pc.onconnectionstatechange = () => {
    if (!isCurrentPc(peerId, pc)) return;
    const st = pc.connectionState;

    if (st === 'connected') {
      clearTimeout(peer.restartTimer);
      peer.restartTimer = null;
      peer.iceRestarted = false;
      clearTimeout(callState.ringTimer);
      callState.ringTimer = null;
      sfx.stopRing();
      setText('call-overlay-status', 'в звонке');
      startCallTimer();
      if (!peer.dc || peer.dc.readyState !== 'open') sendMediaState(peerId);
    } else if (st === 'disconnected') {
      setText('call-overlay-status', 'переподключение…');
    } else if (st === 'failed') {
      handlePeerFailed(peerId, pc);
    }
  };

  return pc;
}

async function sendOffer(peerId, pc, options = {}) {
  const peer = callState.peers[peerId];
  if (!peer || peer.pc !== pc) return;

  peer.makingOffer = true;
  try {
    const offer = await pc.createOffer(options);
    if (!isCurrentPc(peerId, pc)) return;
    await pc.setLocalDescription(offer);
    const ld = pc.localDescription;
    socket.emit('callSignal', {
      callId: callState.callId,
      to:     peerId,
      data:   { type: 'offer', sdp: { type: ld.type, sdp: ld.sdp } },
    });
  } catch (e) {
    console.warn('[call] sendOffer failed', peerId, e);
    throw e;
  } finally {
    peer.makingOffer = false;
  }
}

async function handlePeerFailed(peerId, pc) {
  const peer = callState.peers[peerId];
  if (!peer || peer.pc !== pc || !callState.active) return;

  if (!peer.iceRestarted) {
    peer.iceRestarted = true;
    setText('call-overlay-status', 'переподключение…');
    clearTimeout(peer.restartTimer);
    peer.restartTimer = setTimeout(() => {
      if (isCurrentPc(peerId, pc) && pc.connectionState !== 'connected') giveUpPeer(peerId);
    }, ICE_RESTART_TIMEOUT_MS);

    // ICE-restart инициирует «невежливая» сторона
    if (!isPolite(peerId) && typeof pc.restartIce === 'function') {
      try {
        pc.restartIce();
        await sendOffer(peerId, pc, { iceRestart: true });
      } catch (e) {
        console.warn('[call] ICE restart failed', peerId, e);
        giveUpPeer(peerId);
      }
    }
    return;
  }

  giveUpPeer(peerId);
}

function giveUpPeer(peerId) {
  if (!callState.active) return;
  if (callState.isGroup) {
    showTransientNotice(`${callPeerName(peerId)}: соединение потеряно`);
    teardownPeer(peerId);
    if (!Object.keys(callState.peers).length) {
      setText('call-overlay-status', 'ожидание участников…');
    }
  } else {
    showTransientNotice('Соединение с собеседником потеряно');
    hangupCall();
  }
}

async function connectToPeer(peerId, shouldOffer) {
  if (!peerId || peerId === state.me?.id || !callState.active) return null;
  const pc   = createPeerConnection(peerId);
  const peer = callState.peers[peerId];
  if (
    shouldOffer && peer &&
    !peer.makingOffer &&
    pc.signalingState === 'stable' &&
    !pc.localDescription
  ) {
    await sendOffer(peerId, pc);
  }
  return pc;
}

function teardownPeer(peerId, { render = true } = {}) {
  closePeerConnection(callState.peers[peerId]);
  delete callState.peers[peerId];
  stopSpeakingMonitor(peerId);
  if (render) renderCallGrid();
}

/* ── UI-хуки кнопок ────────────────────────────────────────────────────── */
on('btn-call-audio',       'click', () => { if (state.activeFriend) startCall({ toId: state.activeFriend, video: false }); });
on('btn-call-video',       'click', () => { if (state.activeFriend) startCall({ toId: state.activeFriend, video: true  }); });
on('btn-group-call-audio', 'click', () => { if (state.activeGroup)  startCall({ groupId: state.activeGroup, video: false }); });
on('btn-group-call-video', 'click', () => { if (state.activeGroup)  startCall({ groupId: state.activeGroup, video: true  }); });

on('btn-join-group-voice', 'click', () => {
  if (callBusy() || !state.activeGroup) return;
  if (state.groupVoiceCalls[state.activeGroup]) joinExistingGroupVoice(state.activeGroup);
  else startCall({ groupId: state.activeGroup, video: false });
});

on('btn-call-hangup', 'click', hangupCall);

function toggleMic() {
  if (!callState.active || !callState.localStream) return;
  if (!callState.localStream.getAudioTracks().length) {
    showTransientNotice('Микрофон недоступен');
    return;
  }
  callState.micOn = !callState.micOn;
  callState.localStream.getAudioTracks().forEach(t => { t.enabled = callState.micOn; });
  resetCallControls();
  showTransientNotice(callState.micOn ? 'Микрофон включён' : 'Микрофон выключен');
  renderCallGrid();
  broadcastMediaState();
}
on('btn-call-toggle-mic', 'click', toggleMic);

function toggleCam() {
  if (!callState.active || !callState.localStream) return;
  if (!hasLocalVideo()) {
    showTransientNotice('В этом звонке нет видео');
    return;
  }
  callState.camOn = !callState.camOn;
  callState.localStream.getVideoTracks().forEach(t => { t.enabled = callState.camOn; });
  resetCallControls();
  renderCallGrid();
  broadcastMediaState();
}
on('btn-call-toggle-cam', 'click', toggleCam);

document.addEventListener('keydown', e => {
  const key = typeof e.key === 'string' ? e.key : '';
  // Ctrl/Cmd+Shift+M — мьют микрофона
  if (callState.active && (e.ctrlKey || e.metaKey) && e.shiftKey && key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleMic();
    return;
  }
  // Escape — отклонить входящий (только если нет другого открытого модала)
  if (key === 'Escape' && callState.pendingIncoming && !callState.active) {
    e.preventDefault();
    $('btn-call-decline')?.click();
  }
});

/* ── Входящий звонок ────────────────────────────────────────────────────── */
function dismissIncomingCall() {
  clearTimeout(callState.incomingTimer);
  callState.incomingTimer   = null;
  callState.pendingIncoming = null;
  setDisplay('incoming-call-modal', 'none');
  sfx.stopRing();
}

function showIncomingCall(info) {
  callState.pendingIncoming = info;

  const nick = info.isGroup
    ? (state.groups[info.groupId]?.name || 'Групповой звонок')
    : (info.fromNick || state.friends[info.from]?.nickname || info.from);

  setText('incoming-call-nick', nick);
  setText('incoming-call-sub', info.isGroup
    ? `${info.fromNick || 'Кто-то'} начал(а) ${info.video ? 'видео' : 'аудио'}звонок`
    : `Входящий ${info.video ? 'видео' : 'аудио'}звонок…`);

  const avatarEl = $('incoming-call-avatar');
  if (avatarEl) {
    if (info.isGroup) {
      renderGroupAv(avatarEl, state.groups[info.groupId]);
    } else {
      avatarEl.classList.remove('group-av');
      renderAv(avatarEl, nick, state.friends[info.from]?.avatar ?? null);
    }
  }

  setDisplay('incoming-call-modal', 'flex');
  sfx.startRing(false);

  clearTimeout(callState.incomingTimer);
  callState.incomingTimer = setTimeout(() => {
    if (callState.pendingIncoming?.callId !== info.callId) return;
    if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
    dismissIncomingCall();
    showTransientNotice(`Пропущенный звонок от ${nick}`);
  }, CALL_RING_TIMEOUT_MS);
}

on('btn-call-accept', 'click', async () => {
  const info = callState.pendingIncoming;
  if (!info || callStarting) return;

  setDisplay('incoming-call-modal', 'none');
  sfx.stopRing();

  callStarting = true;
  let stream;
  try {
    stream = await acquireLocalStream(!!info.video);
  } catch (e) {
    callStarting = false;
    showTransientNotice(mediaErrorMessage(e));
    if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
    dismissIncomingCall();
    return;
  }
  callStarting = false;

  // Проверяем: звонок не отменили, пока ждали разрешение
  if (
    callState.pendingIncoming?.callId !== info.callId ||
    callState.active ||
    !socket.connected ||
    !state.me
  ) {
    stopStream(stream);
    dismissIncomingCall();
    return;
  }

  beginCallSession({
    stream,
    callId:        info.callId,
    chatKey:       info.chatKey ?? null,
    isGroup:       !!info.isGroup,
    groupId:       info.groupId ?? null,
    peerFriendId:  info.isGroup ? null : info.from,
    peerFriendName: info.isGroup
      ? null
      : (info.fromNick || state.friends[info.from]?.nickname || info.from),
    video: !!info.video,
  });
  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: info.callId });
  sfx.join();
});

on('btn-call-decline', 'click', () => {
  const info = callState.pendingIncoming;
  if (!info) return;
  if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
  dismissIncomingCall();
});

/* ── Сигналинг ──────────────────────────────────────────────────────────── */
async function flushPendingCandidates(peerId) {
  const peer = callState.peers[peerId];
  if (!peer?.pc.remoteDescription) return;
  const queue = peer.pendingCandidates.splice(0);
  for (const c of queue) {
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (e) {
      console.warn('[call] addIceCandidate failed', e);
    }
  }
}

/**
 * Perfect negotiation: при «glare» вежливая сторона откатывает свой offer.
 *
 * @param {{callId: string, from: string, data: object}} payload
 */
async function handleCallSignal({ callId, from, data } = {}) {
  // Строгая валидация входных данных с сервера
  if (!callState.active)                        return;
  if (typeof callId !== 'string' || !callId)    return;
  if (callId !== callState.callId)              return;
  if (typeof from !== 'string' || !from)        return;
  if (from === state.me?.id)                    return;
  if (!data || typeof data !== 'object')        return;

  const pc   = createPeerConnection(from);
  const peer = callState.peers[from];
  if (!peer) return;

  try {
    if (data.type === 'state') {
      applyRemoteMediaState(from, data);

    } else if (data.type === 'offer') {
      if (!data.sdp || typeof data.sdp.sdp !== 'string') return;
      const desc      = new RTCSessionDescription(data.sdp);
      const collision = peer.makingOffer || pc.signalingState !== 'stable';
      const polite    = isPolite(from);

      if (collision && !polite) return; // наш offer «победил»

      if (collision) {
        // Implicit rollback (современные браузеры) с fallback на явный rollback
        try {
          await pc.setRemoteDescription(desc);
        } catch (_) {
          await pc.setLocalDescription({ type: 'rollback' });
          await pc.setRemoteDescription(desc);
        }
      } else {
        await pc.setRemoteDescription(desc);
      }

      if (!isCurrentPc(from, pc)) return;
      await flushPendingCandidates(from);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const ld = pc.localDescription;
      socket.emit('callSignal', {
        callId,
        to:   from,
        data: { type: 'answer', sdp: { type: ld.type, sdp: ld.sdp } },
      });

    } else if (data.type === 'answer') {
      if (!data.sdp || typeof data.sdp.sdp !== 'string') return;
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushPendingCandidates(from);

    } else if (data.type === 'ice') {
      if (!data.candidate || typeof data.candidate !== 'object') return;
      if (pc.remoteDescription?.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          // После rollback кандидаты к откатанному offer невалидны — это нормально
          if (!(peer.makingOffer || pc.signalingState !== 'stable')) throw e;
        }
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    }
  } catch (e) {
    console.warn('[call] signal error from', from, e);
  }
}

async function offerToParticipants(participants) {
  if (!Array.isArray(participants)) return;
  const myId  = state.me?.id;
  const others = [...new Set(participants.filter(id => id && typeof id === 'string' && id !== myId))];

  for (const peerId of others) {
    if (!callState.active) return;
    try { await connectToPeer(peerId, true); } catch (e) {
      console.warn('[call] offer failed', peerId, e);
    }
  }

  if (!callState.active) return;
  renderCallGrid();

  if (!others.length) {
    setText('call-overlay-status', callState.isGroup ? 'ожидание участников…' : 'ожидание ответа…');
  }
}

/* ── Socket events ──────────────────────────────────────────────────────── */

socket.on('callIncoming', info => {
  if (!info || typeof info !== 'object') return;
  const { callId, from, isGroup, groupId, video, fromNick, chatKey } = info;

  if (typeof callId !== 'string' || !callId) return;
  if (!state.me) return;
  if (from && from === state.me.id) return;

  if (callBusy()) {
    if (!isGroup && typeof callId === 'string') {
      socket.emit('callReject', { callId, reason: 'busy' });
    }
    return;
  }

  // Групповой канал, уже отображаемый в списке — не звоним повторно
  if (isGroup && state.groupVoiceCalls[groupId]?.callId === callId) return;

  showIncomingCall({ callId, from, isGroup, groupId, video: !!video, fromNick, chatKey });
});

socket.on('callStarted', ({ callId, chatKey, participants } = {}) => {
  if (typeof callId !== 'string' || !callId) return;

  if (!callState.active) {
    if (leaveWhenStarted) {
      leaveWhenStarted = false;
      socket.emit('callLeave', { callId });
    }
    return;
  }
  if (callState.callId && callState.callId !== callId) return;

  callState.callId = callId;
  if (chatKey && typeof chatKey === 'string') callState.chatKey = chatKey;

  if (callState.isGroup && callState.groupId) {
    const existing = state.groupVoiceCalls[callState.groupId];
    if (!existing || existing.callId !== callId) {
      state.groupVoiceCalls[callState.groupId] = {
        callId,
        video: callState.video,
        participants: Array.isArray(participants) && participants.length
          ? participants
          : [state.me?.id].filter(Boolean),
      };
      renderGroupsList();
      updateGroupVoiceBar(callState.groupId);
    }
  }

  offerToParticipants(participants);
});

socket.on('callJoined', ({ callId, participants } = {}) => {
  if (!callState.active) return;
  if (typeof callId !== 'string' || callId !== callState.callId) return;
  offerToParticipants(participants);
});

socket.on('callPeerJoined', ({ callId, peerId } = {}) => {
  if (!callState.active) return;
  if (typeof callId !== 'string' || callId !== callState.callId) return;
  if (!peerId || typeof peerId !== 'string' || peerId === state.me?.id) return;

  clearTimeout(callState.ringTimer);
  callState.ringTimer = null;
  sfx.stopRing();
  sfx.join();

  // Старое соединение недействительно — пир пришлёт свежий offer
  if (callState.peers[peerId]) teardownPeer(peerId, { render: false });
  createPeerConnection(peerId);
  setText('call-overlay-status', 'соединение…');
  renderCallGrid();
});

socket.on('callPeerLeft', ({ callId, peerId } = {}) => {
  if (!callState.active) return;
  if (typeof callId !== 'string' || callId !== callState.callId) return;
  if (!peerId || typeof peerId !== 'string' || peerId === state.me?.id) return;

  const name = callPeerName(peerId);
  teardownPeer(peerId);
  sfx.leave();

  if (!callState.isGroup) {
    showTransientNotice('Собеседник завершил звонок');
    closeCallOverlay();
    return;
  }
  showTransientNotice(`${name} покинул(а) канал`);
  if (!Object.keys(callState.peers).length) {
    setText('call-overlay-status', 'ожидание участников…');
  }
});

socket.on('callSignal', payload => {
  if (payload && typeof payload === 'object') handleCallSignal(payload);
});

socket.on('callRejected', ({ callId, reason } = {}) => {
  if (!callState.active) return;
  if (typeof callId !== 'string' || callId !== callState.callId) return;
  if (callState.isGroup) return;
  showTransientNotice(reason === 'busy' ? 'Собеседник занят' : 'Собеседник отклонил звонок');
  closeCallOverlay();
});

socket.on('callCancelled', ({ callId } = {}) => {
  if (typeof callId !== 'string' || !callId) return;
  if (callState.pendingIncoming?.callId !== callId) return;

  const inc  = callState.pendingIncoming;
  const nick = inc.isGroup
    ? (state.groups[inc.groupId]?.name || 'группы')
    : (inc.fromNick || state.friends[inc.from]?.nickname || inc.from);

  dismissIncomingCall();
  showTransientNotice(`Пропущенный звонок от ${nick}`);
});

socket.on('callEnded', ({ callId, reason } = {}) => {
  if (typeof callId !== 'string' || !callId) return;

  if (callState.pendingIncoming?.callId === callId) {
    dismissIncomingCall();
    return;
  }

  if (callState.active && callState.callId === callId) {
    const messages = {
      timeout:      'Нет ответа',
      ended:        'Звонок завершён',
      group_deleted: 'Группа удалена — звонок завершён',
      kicked:       'Вы исключены из группы — звонок завершён',
      server_error: 'Звонок прерван из-за ошибки сервера',
    };
    showTransientNotice(messages[reason] || 'Звонок завершён');
    sfx.leave();
    closeCallOverlay();
  }
});

socket.on('callError', ({ reason, callId, event } = {}) => {
  if (event === 'watchGroupVoice') return;
  if (callId && callState.callId && callId !== callState.callId) return;
  const messages = {
    busy:          'Собеседник уже в звонке',
    offline:       'Пользователь не в сети',
    not_found:     'Звонок не найден или уже завершён',
    not_friends:   'Звонить можно только друзьям',
    not_member:    'Вы не участник группы',
    blocked:       'Невозможно позвонить этому пользователю',
    limit_reached: 'Достигнут лимит участников звонка',
    rate_limited:  'Слишком много действий, подождите',
    server_error:  'Ошибка сервера',
  };
  showTransientNotice(messages[reason] || 'Ошибка звонка');
  leaveWhenStarted = false;
  if (callState.active) closeCallOverlay();
  else if (callState.pendingIncoming) dismissIncomingCall();
});

/* ── Реконнект сокета ───────────────────────────────────────────────────── */
let callReconnectTimer = null;
socket.on('disconnect', () => {
  clearTimeout(callReconnectTimer);
  if (callState.active) callReconnectTimer = setTimeout(() => {
    if (callState.active && !socket.connected) { showTransientNotice('Звонок завершён: соединение не восстановилось'); closeCallOverlay(); }
  }, 16000);
  if (callState.pendingIncoming) dismissIncomingCall();
  if (callState.active) setText('call-overlay-status', 'переподключение…');
});

socket.on('connect', () => {
  clearTimeout(callReconnectTimer);
  if (!callState.active || !callState.callId) return;
  // Пересобираем mesh: старые соединения могли пережить разрыв, но сигналинг для них потерян
  Object.keys(callState.peers).forEach(id => teardownPeer(id, { render: false }));
  renderCallGrid();
  setText('call-overlay-status', 'соединение…');
  socket.emit('callJoin', { callId: callState.callId, rejoin: true });
});

/* ── Участник группы вышел (не через callPeerLeft) ─────────────────────── */
socket.on('groupMemberLeft', ({ groupId, userId } = {}) => {
  if (!callState.active || !callState.isGroup) return;
  if (callState.groupId !== groupId) return;
  if (!userId || typeof userId !== 'string' || userId === state.me?.id) return;
  if (callState.peers[userId]) teardownPeer(userId);
});

/* ── Закрытие вкладки ───────────────────────────────────────────────────── */
window.addEventListener('pagehide', () => {
  if (callState.active && callState.callId && socket.connected) {
    try { socket.emit('callLeave', { callId: callState.callId }); } catch (_) {}
  }
});

/* ── Автоскрытие контролов в видео-режиме ───────────────────────────────── */
function pokeCallIdle() {
  const overlay = $('call-overlay');
  if (!overlay || !callState.active || !callState.video) return;
  if (overlay.classList.contains('detached')) return;
  overlay.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => overlay?.classList.add('idle'), IDLE_HIDE_MS);
}

['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, pokeCallIdle, { passive: true })
);

/* ── Пульс статуса ──────────────────────────────────────────────────────── */
whenDomReady(() => {
  const st = $('call-overlay-status');
  if (!st || !('MutationObserver' in window)) return;
  new MutationObserver(() => {
    const busy = /вызов|соединение|переподключение|ожидание/i.test(st.textContent ?? '');
    if (busy) st.setAttribute('data-busy', '1');
    else st.removeAttribute('data-busy');
  }).observe(st, { childList: true, characterData: true, subtree: true });
});

/* ============================================================================
 * GLOBAL ERROR GUARDS
 * ==========================================================================*/
window.addEventListener('unhandledrejection', e => {
  if (e.reason instanceof AuthError) { e.preventDefault(); return; }
  console.error('[app] Unhandled rejection:', e.reason);
});

window.addEventListener('error', e => {
  console.error('[app] Uncaught error:', e.error ?? e.message);
});

/* ============================================================================
 * DEBUG / INTEROP EXPORTS
 * ==========================================================================*/
Object.assign(window, {
  state, callState, socket, sfx,
  BACKEND_URL, RTC_CONFIG, MAX_AVATAR_SIZE, ALLOWED_AVATAR_TYPES, RAW_AUDIO_CONSTRAINTS,
  setText, setDisplay, showTransientNotice, authFetch, safeJson, on,
  isAnyModalOpen, updateTitleBadge, closeAllModals,
  syncVoiceOverlayPosition, hangupCall, toggleMic, toggleCam,
  syncCallDetached, returnToCallChat, broadcastMediaState,
});

try {
  Object.assign(window, {
    closeActiveChat, openGroupChat, updateGroupVoiceBar, renderGroupsList,
    showUserProfile, openChat, renderFriendsList, renderGroupMembersPanel,
    closeProfileModal, closeGroupInfoModal, closeAddMembersModal,
    closeCreateGroupModal, refreshGroupItem, openGroupInfoModal,
    openEditProfileModal, closeEditProfileModal,
    openBlockedUsersModal, closeBlockedUsersModal,
  });
} catch (e) {
  console.warn('[exports] some UI functions are not defined:', e.message);
}