/* ============================================================================
 * CALLS — WebRTC DM + group mesh
 *
 * Зависимости из core.js / UI:
 *   state, callState, socket, sfx, speakingMonitors
 *   RTC_CONFIG, RAW_AUDIO_CONSTRAINTS, CALL_RING_TIMEOUT_MS
 *   configureRTC, $, on, whenDomReady, setText, setDisplay
 *   showTransientNotice, renderAv, renderGroupAv, memberName
 *   updateGroupVoiceBar, renderGroupsList, openChat, openGroupChat
 *
 * Этот файл ЗАМЕНЯЕТ предыдущую реализацию, а не подключается рядом с ней.
 * ========================================================================== */

'use strict';

/* ── Константы ─────────────────────────────────────────────────────────── */

const ICE_RESTART_TIMEOUT_MS = 12_000;
const CALL_START_ACK_TIMEOUT_MS = 20_000;
const CALL_JOIN_ACK_TIMEOUT_MS = 20_000;
const CALL_SOCKET_GRACE_MS = 16_000;
const IDLE_HIDE_MS = 3_000;

const MAX_PENDING_ICE = 256;
const MAX_SIGNAL_SDP_LENGTH = 1_000_000;
const MAX_STATE_MESSAGE_LENGTH = 4096;
const AUDIO_MAX_BITRATE = 128_000;

const SPEAKING_THRESHOLD_ON = 0.06;
const SPEAKING_THRESHOLD_OFF = 0.035;

const CALL_VIDEO_CONSTRAINTS = Object.freeze({
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
});

/* ── Локальное состояние ───────────────────────────────────────────────── */

let callStarting = false;
let pendingMediaOperation = null;
let mediaOperationSequence = 0;
let callSessionSequence = 0;

let pendingStartRequestId = null;
let pendingJoinRequestId = null;
let requestSequence = 0;

let startAckTimer = null;
let joinAckTimer = null;
let callReconnectTimer = null;

let idleTimer = null;
let callTimerId = null;
let callConnectedAt = 0;
let overlaySyncRaf = null;
let gridRenderRaf = null;

let screenShareStream = null;
let screenShareTrack = null;
let screenShareStarting = false;
let screenShareStopping = false;
let screenShareSequence = 0;

let audioCtx = null;

callState.peers ||= Object.create(null);
state.dmVoiceCalls ||= Object.create(null);
state.groupVoiceCalls ||= Object.create(null);
state.voiceRejoin ||= Object.create(null);

/* speakingMonitors объявляется в core.js — здесь не переобъявляем. */

/* ── Общие утилиты ─────────────────────────────────────────────────────── */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512;
}

function uniqueIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(isId))]
    : [];
}

function newCallRequestId(prefix) {
  const uuid = window.crypto?.randomUUID?.();
  return uuid
    ? `${prefix}-${uuid}`
    : `${prefix}-${Date.now()}-${++requestSequence}`;
}

function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;

  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch (_) {}
  }
}

function isLiveTrack(track) {
  return !!track && track.readyState === 'live';
}

function localCameraTrack() {
  return callState.localStream
    ?.getVideoTracks()
    .find(isLiveTrack) || null;
}

function hasLocalVideo() {
  return !!localCameraTrack();
}

function currentOutgoingVideoTrack() {
  return isLiveTrack(screenShareTrack)
    ? screenShareTrack
    : localCameraTrack();
}

function callBusy() {
  return !!(
    callState.active ||
    callState.pendingIncoming ||
    callStarting
  );
}

function callPeerName(peerId) {
  if (!peerId) return '';

  if (callState.isGroup) {
    const group = state.groups[callState.groupId];
    return group ? memberName(group, peerId) : peerId;
  }

  return state.friends[peerId]?.nickname ||
    (peerId === callState.peerFriendId
      ? callState.peerFriendName
      : null) ||
    peerId;
}

function callPeerAvatar(peerId) {
  if (!peerId) return null;

  if (callState.isGroup) {
    const group = state.groups[callState.groupId];
    return group?.members?.find(member => member.id === peerId)?.avatar ??
      state.friends[peerId]?.avatar ??
      null;
  }

  return state.friends[peerId]?.avatar ?? null;
}

/*
 * Не подставляем ID в CSS-селектор: это одновременно убирает необходимость
 * в CSS.escape fallback и корректно работает с произвольными строковыми ID.
 */
function findCallTile(id, root = $('call-video-grid')) {
  if (!root) return null;

  for (const tile of root.querySelectorAll('.call-tile')) {
    if (tile.dataset.peer === String(id)) return tile;
  }

  return null;
}

function safeCallSound(method, ...args) {
  try {
    const result = sfx?.[method]?.(...args);
    if (result?.catch) result.catch(() => {});
  } catch (_) {}
}

function emitCall(event, payload) {
  if (!socket.connected) return false;
  socket.emit(event, payload);
  return true;
}

function currentSessionMatches(session) {
  return callState.active && callSessionSequence === session;
}

function captureCallSession() {
  return callSessionSequence;
}

function scheduleCallGrid() {
  if (gridRenderRaf !== null) return;

  gridRenderRaf = requestAnimationFrame(() => {
    gridRenderRaf = null;
    renderCallGrid();
  });
}

/*
 * Socket.IO не ожидает Promise обработчика. Обёртка ловит как синхронные
 * исключения, так и отклонённые Promise.
 */
function onCallSocket(event, handler) {
  socket.on(event, payload => {
    if (!isRecord(payload)) return;

    try {
      Promise.resolve(handler(payload)).catch(error => {
        console.warn(`[call] ${event} failed`, error);
      });
    } catch (error) {
      console.warn(`[call] ${event} failed`, error);
    }
  });
}

/* ── Захват устройств с логической отменой ─────────────────────────────── */

function abortError() {
  return new DOMException('Operation cancelled', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/*
 * getUserMedia/getDisplayMedia не принимают AbortSignal как универсальный
 * браузерный механизм отмены.
 *
 * Мы отменяем ожидание, а если разрешение придёт позднее — сразу останавливаем
 * полученные треки. Сам браузерный диалог программно закрыть нельзя.
 */
function acquireAbortableMedia(factory, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    let request;

    try {
      request = factory();
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
      return;
    }

    Promise.resolve(request).then(
      stream => {
        if (settled || signal?.aborted) {
          stopStream(stream);
          return;
        }

        settled = true;
        cleanup();
        resolve(stream);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function mediaErrorMessage(error) {
  switch (error?.name) {
    case 'NotSupportedError':
      return 'Звонки недоступны: нужен HTTPS и современный браузер';

    case 'NotAllowedError':
    case 'SecurityError':
      return 'Доступ к устройствам запрещён. Проверьте разрешения браузера';

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Микрофон не найден';

    case 'NotReadableError':
    case 'TrackStartError':
      return 'Устройство занято или недоступно';

    case 'OverconstrainedError':
      return 'Устройство не поддерживает требуемые параметры';

    default:
      return 'Не удалось получить доступ к камере или микрофону';
  }
}

async function acquireLocalStream(video, { signal } = {}) {
  throwIfAborted(signal);

  await configureRTC();

  throwIfAborted(signal);

  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(
      new Error('getUserMedia is unavailable'),
      { name: 'NotSupportedError' },
    );
  }

  const getStream = withVideo => acquireAbortableMedia(
    () => navigator.mediaDevices.getUserMedia({
      audio: RAW_AUDIO_CONSTRAINTS,
      video: withVideo ? CALL_VIDEO_CONSTRAINTS : false,
    }),
    signal,
  );

  let stream;

  try {
    stream = await getStream(!!video);
  } catch (error) {
    if (error?.name === 'AbortError' || !video) throw error;

    throwIfAborted(signal);

    // При проблемах с камерой пробуем сохранить возможность аудиозвонка.
    stream = await getStream(false);

    if (!signal?.aborted) {
      showTransientNotice('Камера недоступна — звонок без видео');
    }
  }

  if (signal?.aborted) {
    stopStream(stream);
    throw abortError();
  }

  if (!stream.getAudioTracks().some(isLiveTrack)) {
    stopStream(stream);
    throw Object.assign(
      new Error('No live microphone track'),
      { name: 'NotFoundError' },
    );
  }

  return stream;
}

function beginMediaOperation(kind, incomingCallId = null) {
  if (pendingMediaOperation) return null;

  const operation = {
    id: ++mediaOperationSequence,
    kind,
    incomingCallId,
    controller: new AbortController(),
    userId: state.me?.id,
    revision: state.sessionRevision,
  };

  pendingMediaOperation = operation;
  callStarting = true;

  return operation;
}

function isCurrentMediaOperation(operation) {
  return pendingMediaOperation === operation &&
    !operation.controller.signal.aborted &&
    !!state.me &&
    state.me.id === operation.userId &&
    state.sessionRevision === operation.revision;
}

function finishMediaOperation(operation) {
  if (pendingMediaOperation !== operation) return;

  pendingMediaOperation = null;
  callStarting = false;
  updateDmVoiceBar();
}

function cancelMediaOperation() {
  const operation = pendingMediaOperation;

  pendingMediaOperation = null;
  callStarting = false;

  operation?.controller.abort();
}

/* ── Инициализация звонка ──────────────────────────────────────────────── */

function clearCallAckTimers() {
  clearTimeout(startAckTimer);
  clearTimeout(joinAckTimer);
  startAckTimer = null;
  joinAckTimer = null;
}

function beginCallSession({
  stream,
  callId = null,
  chatKey = null,
  isGroup = false,
  groupId = null,
  peerFriendId = null,
  peerFriendName = null,
}) {
  clearCallAckTimers();

  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);

  callState.ringTimer = null;
  callState.incomingTimer = null;

  pendingStartRequestId = null;
  pendingJoinRequestId = null;

  callSessionSequence++;

  callState.localStream = stream;
  callState.callId = callId;
  callState.chatKey = chatKey;

  callState.isGroup = !!isGroup;
  callState.groupId = groupId;
  callState.peerFriendId = peerFriendId;
  callState.peerFriendName = peerFriendName;

  callState.video = stream.getVideoTracks().some(isLiveTrack);
  callState.micOn = true;
  callState.camOn = callState.video;

  callState.peers = Object.create(null);
  callState.pendingIncoming = null;

  setDisplay('incoming-call-modal', 'none');
  safeCallSound('stopRing');

  const session = captureCallSession();

  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (!currentSessionMatches(session)) return;

      if (track.kind === 'audio') {
        callState.micOn = stream.getAudioTracks().some(isLiveTrack);
        if (!callState.micOn) {
          showTransientNotice('Микрофон отключён или недоступен');
        }
      } else {
        callState.camOn = !!localCameraTrack() && callState.camOn;
      }

      refreshCallMediaUI();
      broadcastMediaState();
    });
  }
}

function armOutgoingRingTimeout() {
  clearTimeout(callState.ringTimer);

  const session = captureCallSession();

  callState.ringTimer = setTimeout(() => {
    callState.ringTimer = null;

    if (!currentSessionMatches(session)) return;
    if (Object.keys(callState.peers).length) return;

    showTransientNotice('Нет ответа');
    hangupCall();
  }, CALL_RING_TIMEOUT_MS);
}

function stopOutgoingRing() {
  clearTimeout(callState.ringTimer);
  callState.ringTimer = null;
  safeCallSound('stopRing');
}

function requestCallJoin({ rejoin = false } = {}) {
  if (!callState.active || !isId(callState.callId)) return;

  clearTimeout(joinAckTimer);

  const session = captureCallSession();
  const callId = callState.callId;
  const requestId = newCallRequestId('join');

  pendingJoinRequestId = requestId;

  emitCall('callJoin', { callId, requestId, rejoin });

  joinAckTimer = setTimeout(() => {
    if (!currentSessionMatches(session)) return;
    if (pendingJoinRequestId !== requestId) return;

    showTransientNotice('Сервер не подтвердил подключение к звонку');
    hangupCall();
  }, CALL_JOIN_ACK_TIMEOUT_MS);
}

async function startCall({ toId, groupId, video = false } = {}) {
  if ((!isId(toId) && !isId(groupId)) || (toId && groupId)) return;

  if (!state.me) return;

  if (callBusy()) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }

  if (!socket.connected) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  const existing = groupId
    ? state.groupVoiceCalls[groupId]
    : state.dmVoiceCalls[toId];

  if (existing?.callId) {
    await startExistingCall(existing, groupId || null, toId || null);
    return;
  }

  const operation = beginMediaOperation('start');
  if (!operation) return;

  let stream = null;

  try {
    stream = await acquireLocalStream(!!video, {
      signal: operation.controller.signal,
    });

    if (!isCurrentMediaOperation(operation)) return;
    if (callState.active || callState.pendingIncoming) return;

    if (!socket.connected) {
      showTransientNotice('Нет соединения с сервером');
      return;
    }

    if (!$('call-overlay')) {
      throw new Error('#call-overlay not found');
    }

    beginCallSession({
      stream,
      isGroup: !!groupId,
      groupId: groupId || null,
      peerFriendId: toId || null,
      peerFriendName: toId
        ? state.friends[toId]?.nickname || toId
        : null,
    });

    // Владение потоком передано callState.
    stream = null;

    openCallOverlay('вызов…');

    const session = captureCallSession();
    const requestId = newCallRequestId('start');

    pendingStartRequestId = requestId;

    emitCall('callStart', {
      requestId,
      toId: toId || undefined,
      groupId: groupId || undefined,
      video: hasLocalVideo(),
    });

    startAckTimer = setTimeout(() => {
      if (!currentSessionMatches(session)) return;
      if (pendingStartRequestId !== requestId) return;

      showTransientNotice('Сервер не подтвердил начало звонка');
      hangupCall();
    }, CALL_START_ACK_TIMEOUT_MS);

    if (!groupId) {
      safeCallSound('startRing', true);
      armOutgoingRingTimeout();
    }
  } catch (error) {
    if (error?.name !== 'AbortError' && isCurrentMediaOperation(operation)) {
      console.warn('[call] start failed', error);
      showTransientNotice(mediaErrorMessage(error));
    }
  } finally {
    stopStream(stream);
    finishMediaOperation(operation);
  }
}

function joinExistingGroupVoice(groupId) {
  if (!isId(groupId)) return;

  const room = state.groupVoiceCalls[groupId];
  if (!room) return;

  return startExistingCall(room, groupId);
}

async function startExistingCall(room, groupId = null, peerId = null) {
  if (!isRecord(room) || !isId(room.callId)) return;
  if ((!isId(groupId) && !isId(peerId)) || (groupId && peerId)) return;

  if (callBusy()) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }

  if (!socket.connected || !state.me) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  const operation = beginMediaOperation('join');
  if (!operation) return;

  const expectedCallId = room.callId;
  let stream = null;

  try {
    stream = await acquireLocalStream(!!room.video, {
      signal: operation.controller.signal,
    });

    if (!isCurrentMediaOperation(operation)) return;
    if (callState.active || callState.pendingIncoming) return;

    const currentRoom = groupId
      ? state.groupVoiceCalls[groupId]
      : state.dmVoiceCalls[peerId];

    if (currentRoom?.callId !== expectedCallId) {
      showTransientNotice('Голосовой канал уже завершён');
      return;
    }

    if (!socket.connected) {
      showTransientNotice('Нет соединения с сервером');
      return;
    }

    if (!$('call-overlay')) {
      throw new Error('#call-overlay not found');
    }

    beginCallSession({
      stream,
      callId: expectedCallId,
      isGroup: !!groupId,
      groupId,
      peerFriendId: peerId,
      peerFriendName: peerId
        ? state.friends[peerId]?.nickname || peerId
        : null,
    });

    stream = null;

    openCallOverlay('соединение…');
    requestCallJoin();
    safeCallSound('join');
  } catch (error) {
    if (error?.name !== 'AbortError' && isCurrentMediaOperation(operation)) {
      showTransientNotice(mediaErrorMessage(error));
    }
  } finally {
    stopStream(stream);
    finishMediaOperation(operation);
  }
}

/* ── Кэш группового канала ─────────────────────────────────────────────── */

/*
 * Кэш не создаёт новую комнату: состояние комнат подтверждает сервер.
 */
function rememberGroupVoice(groupId, callId, video = false) {
  if (!isId(groupId) || !isId(callId)) return;
  if (state.groupVoiceCalls[groupId]?.callId !== callId) return;

  clearTimeout(state.voiceRejoin[groupId]?.timer);

  state.voiceRejoin[groupId] = {
    callId,
    video: !!video,
  };
}

function clearGroupVoiceRejoin(groupId, callId = null) {
  const entry = state.voiceRejoin[groupId];
  if (!entry || (callId && entry.callId !== callId)) return;

  clearTimeout(entry.timer);
  delete state.voiceRejoin[groupId];
}

function restoreGroupVoiceRejoin(groupId) {
  return state.groupVoiceCalls[groupId] || null;
}

/* ── Завершение и очистка ──────────────────────────────────────────────── */

function releaseMediaElements(root) {
  if (!root) return;

  for (const element of root.querySelectorAll('video, audio')) {
    try {
      element.pause();
      element.srcObject = null;
    } catch (_) {}
  }
}

function closePeerConnection(peer) {
  if (!peer) return;

  clearTimeout(peer.restartTimer);
  clearTimeout(peer.disconnectTimer);

  if (peer.stream) {
    for (const track of peer.stream.getTracks()) {
      track.onmute = null;
      track.onunmute = null;
      track.onended = null;
    }
  }

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
    const pc = peer.pc;

    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onnegotiationneeded = null;
    pc.onsignalingstatechange = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;

    pc.close();
  } catch (_) {}

  stopStream(peer.stream);
}

function closeCallOverlay() {
  // Инвалидация выполняется ДО любой очистки и последующих await.
  callSessionSequence++;
  screenShareSequence++;

  cancelMediaOperation();
  clearCallAckTimers();

  clearTimeout(callReconnectTimer);
  callReconnectTimer = null;

  clearTimeout(idleTimer);
  idleTimer = null;

  if (gridRenderRaf !== null) {
    cancelAnimationFrame(gridRenderRaf);
    gridRenderRaf = null;
  }

  stopCallTimer();
  clearPeerWait();

  clearTimeout(callState.incomingTimer);
  callState.incomingTimer = null;

  stopOutgoingRing();
  stopAllSpeakingMonitors();

  pendingStartRequestId = null;
  pendingJoinRequestId = null;

  const previousGroupId = callState.isGroup ? callState.groupId : null;

  const oldScreenTrack = screenShareTrack;
  screenShareTrack = null;

  if (oldScreenTrack) oldScreenTrack.onended = null;

  stopStream(screenShareStream);
  screenShareStream = null;
  screenShareStarting = false;
  screenShareStopping = false;

  stopStream(callState.localStream);
  Object.values(callState.peers).forEach(closePeerConnection);

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
  callState.peers = Object.create(null);
  callState.pendingIncoming = null;

  const overlay = $('call-overlay');

  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('voice-mode', 'video-mode', 'idle', 'detached');
    overlay.style.removeProperty('--call-left');
    overlay.style.removeProperty('--call-top');
    overlay.title = '';
  }

  setDisplay('incoming-call-modal', 'none');

  const grid = $('call-video-grid');

  if (grid) {
    releaseMediaElements(grid);
    grid.replaceChildren();
    delete grid.dataset.count;
  }

  resetCallControls();
  updateScreenShareUI();
  updateDmVoiceBar();

  updateGroupVoiceBar(state.activeGroup || previousGroupId);
  renderGroupsList();
}

function hangupCall() {
  if (!callState.active) {
    if (callStarting) {
      cancelMediaOperation();
      if (callState.pendingIncoming) dismissIncomingCall();
      updateDmVoiceBar();
    }
    return;
  }

  const callId = callState.callId;
  const groupId = callState.isGroup ? callState.groupId : null;
  const peerId = callState.peerFriendId;

  if (groupId && callId) {
    rememberGroupVoice(groupId, callId, callState.video);
  }

  if (isId(callId)) {
    emitCall('callLeave', { callId });
  }

  const room = groupId
    ? state.groupVoiceCalls[groupId]
    : state.dmVoiceCalls[peerId];

  if (room?.callId === callId) {
    room.participants = uniqueIds(room.participants)
      .filter(id => id !== state.me?.id);
  }

  safeCallSound('leave');
  closeCallOverlay();
}

/* ── Кнопки микрофона / камеры ─────────────────────────────────────────── */

function resetCallControls() {
  const mic = $('btn-call-toggle-mic');

  if (mic) {
    mic.classList.toggle('active-off', !callState.micOn);
    mic.title = callState.micOn
      ? 'Выключить микрофон'
      : 'Включить микрофон';

    mic.setAttribute('aria-label', mic.title);
    mic.setAttribute('aria-pressed', String(!callState.micOn));
    mic.disabled = !callState.active ||
      !callState.localStream?.getAudioTracks().some(isLiveTrack);
  }

  const cam = $('btn-call-toggle-cam');

  if (cam) {
    cam.classList.toggle('active-off', !callState.camOn);
    cam.title = callState.camOn
      ? 'Выключить камеру'
      : 'Включить камеру';

    cam.setAttribute('aria-label', cam.title);
    cam.setAttribute('aria-pressed', String(!callState.camOn));
    cam.disabled = !callState.active || !hasLocalVideo();
  }
}

function toggleMic() {
  if (!callState.active || !callState.localStream) return;

  const tracks = callState.localStream.getAudioTracks().filter(isLiveTrack);

  if (!tracks.length) {
    showTransientNotice('Микрофон недоступен');
    return;
  }

  callState.micOn = !callState.micOn;

  for (const track of tracks) track.enabled = callState.micOn;

  resetCallControls();
  renderCallGrid();
  broadcastMediaState();

  showTransientNotice(
    callState.micOn ? 'Микрофон включён' : 'Микрофон выключен',
  );
}

function toggleCam() {
  if (!callState.active || !hasLocalVideo()) {
    showTransientNotice('В этом звонке нет доступной камеры');
    return;
  }

  callState.camOn = !callState.camOn;

  for (const track of callState.localStream.getVideoTracks()) {
    track.enabled = callState.camOn;
  }

  refreshCallMediaUI();
  broadcastMediaState();
}

/* ── Состояние медиа ───────────────────────────────────────────────────── */

function mediaStatePayload() {
  return {
    type: 'state',
    micOn: !!callState.micOn,
    camOn: !!callState.camOn && hasLocalVideo(),
    screenOn: isLiveTrack(screenShareTrack),
  };
}

function sendMediaState(peerId) {
  const peer = callState.peers[peerId];

  if (!peer || !callState.active) return;

  const data = mediaStatePayload();

  if (peer.dc?.readyState === 'open') {
    try {
      peer.dc.send(JSON.stringify(data));
      return;
    } catch (_) {}
  }

  if (isId(callState.callId)) {
    emitCall('callSignal', {
      callId: callState.callId,
      to: peerId,
      data,
    });
  }
}

function broadcastMediaState() {
  Object.keys(callState.peers).forEach(sendMediaState);
}

function applyRemoteMediaState(peerId, data) {
  const peer = callState.peers[peerId];

  if (!peer || !isRecord(data)) return;
  if (typeof data.micOn !== 'boolean') return;
  if (typeof data.camOn !== 'boolean') return;
  if (data.screenOn !== undefined && typeof data.screenOn !== 'boolean') return;

  const screenOn = data.screenOn === true;

  if (
    peer.micOn === data.micOn &&
    peer.camOn === data.camOn &&
    peer.screenOn === screenOn
  ) {
    return;
  }

  peer.micOn = data.micOn;
  peer.camOn = data.camOn;
  peer.screenOn = screenOn;

  scheduleCallGrid();
}

/* ── Демонстрация экрана ───────────────────────────────────────────────── */

function screenShareSupported() {
  return !!navigator.mediaDevices?.getDisplayMedia;
}

function updateScreenShareUI() {
  const button = $('btn-call-share-screen');
  if (!button) return;

  const enabled = isLiveTrack(screenShareTrack);
  const busy = screenShareStarting || screenShareStopping;

  button.classList.toggle('active-off', enabled);
  button.classList.toggle('screen-sharing', enabled);

  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-busy', String(busy));

  button.title = enabled
    ? 'Остановить демонстрацию экрана'
    : 'Поделиться экраном';

  button.setAttribute('aria-label', button.title);

  button.disabled = !callState.active ||
    busy ||
    (!screenShareSupported() && !enabled);
}

/*
 * Ссылка на videoSender хранится явно.
 * После replaceTrack(null) у sender нет track, а свойства sender.kind
 * в стандартном RTCRtpSender вообще нет.
 */
async function setPeerVideoTrack(peerId, track, stream) {
  const peer = callState.peers[peerId];
  if (!peer) return;

  await enqueuePeerOperation(peerId, peer, async () => {
    if (!isCurrentPc(peerId, peer.pc)) return;

    if (peer.videoSender) {
      try {
        await peer.videoSender.replaceTrack(track);
        return;
      } catch (error) {
        if (!isCurrentPc(peerId, peer.pc)) return;

        /*
         * replaceTrack может отказать, если замена требует renegotiation.
         * В таком случае удаляем старую отправку и добавляем новую.
         */
        if (error?.name !== 'InvalidModificationError') throw error;

        try {
          peer.pc.removeTrack(peer.videoSender);
        } catch (_) {}

        peer.videoSender = null;
      }
    }

    if (track) {
      peer.videoSender = stream
        ? peer.pc.addTrack(track, stream)
        : peer.pc.addTrack(track);

      requestPeerNegotiation(peerId, peer);
    }
  });
}

async function synchronizeOutgoingVideo(session) {
  if (!currentSessionMatches(session)) return;

  const track = currentOutgoingVideoTrack();
  const stream = track === screenShareTrack
    ? screenShareStream
    : callState.localStream;

  const results = await Promise.allSettled(
    Object.keys(callState.peers).map(peerId =>
      setPeerVideoTrack(peerId, track, stream),
    ),
  );

  if (!currentSessionMatches(session)) return;

  const failures = results.filter(result => result.status === 'rejected');

  if (failures.length) {
    console.warn('[call] video update failed', failures);
    showTransientNotice('Не всем участникам удалось обновить видеопоток');
  }
}

async function startScreenShare() {
  if (
    !callState.active ||
    screenShareTrack ||
    screenShareStarting ||
    screenShareStopping
  ) {
    return;
  }

  if (!screenShareSupported()) {
    showTransientNotice('Демонстрация экрана недоступна в этом браузере');
    return;
  }

  const session = captureCallSession();
  const operation = ++screenShareSequence;

  screenShareStarting = true;
  updateScreenShareUI();

  let stream = null;

  try {
    /*
     * Вызов идёт непосредственно из пользовательского действия:
     * перед getDisplayMedia нет await, теряющего user activation.
     */
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });

    if (
      !currentSessionMatches(session) ||
      operation !== screenShareSequence
    ) {
      return;
    }

    const track = stream.getVideoTracks().find(isLiveTrack);

    if (!track) {
      showTransientNotice('Источник экрана не найден');
      return;
    }

    screenShareStream = stream;
    screenShareTrack = track;
    stream = null;

    track.onended = () => {
      if (
        currentSessionMatches(session) &&
        screenShareTrack === track
      ) {
        stopScreenShare({ silent: true }).catch(error => {
          console.warn('[call] screen stop failed', error);
        });
      }
    };

    refreshCallMediaUI();
    broadcastMediaState();

    await synchronizeOutgoingVideo(session);

    if (
      !currentSessionMatches(session) ||
      operation !== screenShareSequence ||
      screenShareTrack !== track
    ) {
      return;
    }

    showTransientNotice('Демонстрация экрана включена');
  } catch (error) {
    if (
      currentSessionMatches(session) &&
      operation === screenShareSequence &&
      !['AbortError', 'NotAllowedError'].includes(error?.name)
    ) {
      console.warn('[call] screen capture failed', error);
      showTransientNotice('Не удалось начать демонстрацию экрана');
    }
  } finally {
    stopStream(stream);

    if (operation === screenShareSequence) {
      screenShareStarting = false;
      updateScreenShareUI();
    }
  }
}

async function stopScreenShare({ silent = false } = {}) {
  if (screenShareStopping) return;
  if (!screenShareTrack && !screenShareStream) return;

  const session = captureCallSession();
  const operation = ++screenShareSequence;

  screenShareStarting = false;
  screenShareStopping = true;

  const oldTrack = screenShareTrack;
  const oldStream = screenShareStream;

  screenShareTrack = null;
  screenShareStream = null;

  if (oldTrack) oldTrack.onended = null;
  stopStream(oldStream);

  try {
    refreshCallMediaUI();
    broadcastMediaState();

    await synchronizeOutgoingVideo(session);

    if (!currentSessionMatches(session)) return;
    if (operation !== screenShareSequence) return;

    if (!silent) {
      showTransientNotice('Демонстрация остановлена, звонок продолжается');
    }
  } finally {
    if (operation === screenShareSequence) {
      screenShareStopping = false;
      updateScreenShareUI();
    }
  }
}

async function toggleScreenShare() {
  if (!callState.active || screenShareStarting || screenShareStopping) return;

  if (screenShareTrack) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function renegotiateAllPeers() {
  await Promise.allSettled(
    Object.entries(callState.peers).map(([peerId, peer]) =>
      sendOffer(peerId, peer.pc),
    ),
  );
}

/* ── Привязка оверлея к чату ───────────────────────────────────────────── */

function callChatKey() {
  if (!callState.active) return null;

  return callState.isGroup
    ? `group:${callState.groupId}`
    : `dm:${callState.peerFriendId}`;
}

function openChatKey() {
  if (state.activeGroup != null) return `group:${state.activeGroup}`;
  if (state.activeFriend != null) return `dm:${state.activeFriend}`;

  return null;
}

function updateCallVisualMode() {
  const overlay = $('call-overlay');
  if (!overlay || !callState.active) return;

  const localScreen = isLiveTrack(screenShareTrack);
  const localCamera = !!localCameraTrack() && callState.camOn;

  let remoteVideo = false;
  let remoteScreen = false;

  for (const peer of Object.values(callState.peers)) {
    const liveVideo = peer.stream?.getVideoTracks().some(track =>
      track.readyState === 'live' && !track.muted,
    );

    if (!liveVideo) continue;

    if (peer.screenOn) remoteScreen = true;
    if (peer.screenOn || peer.camOn) remoteVideo = true;
  }

  const screenVisible = localScreen || remoteScreen;
  const videoVisible = screenVisible || localCamera || remoteVideo;

  // video описывает локальную отправку, а не только вид оверлея.
  callState.video = localScreen || !!localCameraTrack();

  overlay.classList.toggle('voice-mode', !videoVisible);
  overlay.classList.toggle('video-mode', videoVisible);

  const detached = overlay.classList.contains('detached');

  setText(
    'call-overlay-mode',
    screenVisible
      ? (detached ? 'Демонстрация экрана' : 'ДЕМОНСТРАЦИЯ ЭКРАНА')
      : videoVisible
        ? (detached ? 'Видеоподключение' : 'ВИДЕОКАНАЛ')
        : (detached ? 'Голосовое подключение' : 'ГОЛОСОВОЙ КАНАЛ'),
  );

  if (!videoVisible || detached) {
    clearTimeout(idleTimer);
    idleTimer = null;
    overlay.classList.remove('idle');
  }
}

function refreshCallMediaUI() {
  resetCallControls();
  updateScreenShareUI();
  renderCallGrid();
  updateCallVisualMode();
}

function syncCallDetached() {
  const overlay = $('call-overlay');
  if (!overlay || !callState.active) return;

  const detached = callChatKey() !== openChatKey();

  overlay.classList.toggle('detached', detached);
  overlay.title = detached ? 'Вернуться к звонку' : '';

  updateCallVisualMode();
}

function returnToCallChat() {
  if (!callState.active) return;

  try {
    if (callState.isGroup) {
      if (typeof openGroupChat === 'function') {
        openGroupChat(callState.groupId);
      }
    } else if (typeof openChat === 'function') {
      openChat(callState.peerFriendId);
    }
  } catch (error) {
    console.warn('[call] cannot open call chat', error);
  }
}

function syncVoiceOverlayPosition() {
  const overlay = $('call-overlay');
  if (!overlay || !callState.active) return;

  const sidebar = document.querySelector('.sidebar');

  const chatWindow = [...document.querySelectorAll('.chat-window')]
    .find(element => {
      const rect = element.getBoundingClientRect();
      return getComputedStyle(element).display !== 'none' && rect.height > 0;
    });

  const header = chatWindow?.querySelector('.chat-head');
  const top = header?.getBoundingClientRect().bottom || 0;

  overlay.style.setProperty('--call-top', `${Math.max(0, top)}px`);

  if (window.innerWidth <= 640 || !sidebar) {
    overlay.style.setProperty('--call-left', '0px');
    return;
  }

  const rect = sidebar.getBoundingClientRect();
  const visible = rect.width > 0 &&
    getComputedStyle(sidebar).display !== 'none' &&
    !sidebar.classList.contains('hidden');

  overlay.style.setProperty('--call-left', visible ? `${rect.right}px` : '0px');
}

function scheduleOverlaySync() {
  if (overlaySyncRaf !== null) return;

  overlaySyncRaf = requestAnimationFrame(() => {
    overlaySyncRaf = null;

    updateDmVoiceBar();

    if (!callState.active) return;

    syncVoiceOverlayPosition();
    syncCallDetached();
  });
}

(function watchActiveChat() {
  for (const key of ['activeFriend', 'activeGroup']) {
    const descriptor = Object.getOwnPropertyDescriptor(state, key);

    if (
      !descriptor ||
      !descriptor.configurable ||
      descriptor.get ||
      descriptor.set ||
      descriptor.writable === false
    ) {
      continue;
    }

    let value = descriptor.value;

    try {
      Object.defineProperty(state, key, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get() {
          return value;
        },
        set(next) {
          if (Object.is(next, value)) return;
          value = next;
          scheduleOverlaySync();
        },
      });
    } catch (error) {
      // defineProperty атомарен: при ошибке старое свойство сохраняется.
      console.warn(`[call] cannot watch state.${key}`, error);
    }
  }
})();

/* ── Таймер и статус ───────────────────────────────────────────────────── */

function fmtDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(remainder).padStart(2, '0');

  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function startCallTimer() {
  if (callTimerId !== null) return;

  callConnectedAt = Date.now();

  callTimerId = setInterval(() => {
    if (!callState.active) {
      stopCallTimer();
      return;
    }

    const status = $('call-overlay-status');
    if (!status || !/^в звонке/.test(status.textContent || '')) return;

    status.textContent =
      `в звонке · ${fmtDuration((Date.now() - callConnectedAt) / 1000)}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerId);
  callTimerId = null;
  callConnectedAt = 0;
}

// Совместимость с внешними UI-хуками.
function clearPeerWait() {}

function startPeerWait() {
  if (!callState.active || Object.keys(callState.peers).length) return;

  stopOutgoingRing();
  setText('call-overlay-status', 'ожидание участников · можно оставаться в войсе');
}

function openCallOverlay(statusText = '') {
  callState.active = true;

  const overlay = $('call-overlay');

  if (!overlay) {
    console.error('[call] #call-overlay not found');
    closeCallOverlay();
    return;
  }

  overlay.classList.remove('detached', 'idle');
  overlay.style.display = 'flex';

  setText(
    'call-overlay-title',
    callState.isGroup
      ? state.groups[callState.groupId]?.name || 'Групповой звонок'
      : callPeerName(callState.peerFriendId),
  );

  setText('call-overlay-status', statusText);

  refreshCallMediaUI();
  syncVoiceOverlayPosition();
  syncCallDetached();

  updateDmVoiceBar();
  updateGroupVoiceBar(state.activeGroup);
  renderGroupsList();
}

/* ── Сетка участников ──────────────────────────────────────────────────── */

function createMicOffIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(namespace, 'path');

  path.setAttribute(
    'd',
    'M9 5a3 3 0 0 1 6 0v4M9 9v3a3 3 0 0 0 5.1 2.1' +
    'M5 10v2a7 7 0 0 0 12 4.9M19 10v2a7 7 0 0 1-.5 2.6' +
    'M12 19v3M8 22h8M2 2l20 20',
  );

  svg.appendChild(path);
  return svg;
}

function tryPlayCallMedia(element) {
  try {
    const result = element.play();

    if (result?.then) {
      result.then(
        () => {
          delete element.dataset.playPending;
        },
        () => {
          if (element.srcObject) element.dataset.playPending = '1';
        },
      );
    }
  } catch (_) {
    element.dataset.playPending = '1';
  }
}

function updateCallTile(tile, entry) {
  const {
    nick,
    avatar,
    stream,
    isLocal,
    micOn,
    camOn,
    screenOn,
  } = entry;

  const hasVideo = !!stream &&
    (screenOn || camOn) &&
    stream.getVideoTracks().some(track =>
      track.enabled &&
      track.readyState === 'live' &&
      (isLocal || !track.muted),
    );

  const speaking = micOn && tile.classList.contains('speaking');

  tile.className = [
    'call-tile',
    isLocal ? 'local' : '',
    !hasVideo ? 'audio-only' : '',
    !micOn ? 'muted' : '',
    speaking ? 'speaking' : '',
    screenOn ? 'screen-sharing' : '',
  ].filter(Boolean).join(' ');

  let video = tile.querySelector('video');

  if (hasVideo) {
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.disablePictureInPicture = true;
      video.setAttribute('playsinline', '');

      tile.prepend(video);
    }

    video.muted = true;

    if (video.srcObject !== stream) {
      video.srcObject = stream;
      tryPlayCallMedia(video);
    } else if (video.paused) {
      tryPlayCallMedia(video);
    }
  } else if (video) {
    try {
      video.pause();
      video.srcObject = null;
    } catch (_) {}

    video.remove();
  }

  const hasAudio = !isLocal &&
    !!stream &&
    stream.getAudioTracks().some(isLiveTrack);

  let audio = tile.querySelector('audio.call-tile-audio');

  if (hasAudio) {
    if (!audio) {
      audio = document.createElement('audio');
      audio.className = 'call-tile-audio';
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');

      tile.prepend(audio);
    }

    audio.setAttribute('aria-label', `Аудио ${nick}`);
    audio.muted = false;
    audio.volume = 1;

    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
      tryPlayCallMedia(audio);
    } else if (audio.paused) {
      tryPlayCallMedia(audio);
    }
  } else if (audio) {
    try {
      audio.pause();
      audio.srcObject = null;
    } catch (_) {}

    audio.remove();
  }

  let avatarWrap = tile.querySelector('.call-tile-avatar');

  if (!avatarWrap) {
    avatarWrap = document.createElement('div');
    avatarWrap.className = 'call-tile-avatar';
    tile.appendChild(avatarWrap);
  }

  const avatarKey = JSON.stringify([nick, avatar ?? null]);

  if (avatarWrap.dataset.key !== avatarKey) {
    renderAv(avatarWrap, nick, avatar);
    avatarWrap.dataset.key = avatarKey;
  }

  let label = tile.querySelector('.call-tile-nick');

  if (!label) {
    label = document.createElement('div');
    label.className = 'call-tile-nick';
    tile.appendChild(label);
  }

  label.textContent = nick;

  let badge = tile.querySelector('.call-tile-mic-off');

  if (!micOn && !badge) {
    badge = document.createElement('div');
    badge.className = 'call-tile-mic-off';
    badge.title = 'Микрофон выключен';
    badge.setAttribute('aria-label', badge.title);
    badge.appendChild(createMicOffIcon());

    tile.insertBefore(badge, label);
  } else if (micOn && badge) {
    badge.remove();
  }
}

function renderCallGrid() {
  const grid = $('call-video-grid');
  if (!grid || !callState.active) return;

  const entries = [{
    // Отдельное пространство ID не конфликтует с пользовательским ID "local".
    id: 'local',
    nick: state.me?.nickname || 'Я',
    avatar: state.me?.avatar || null,
    stream: screenShareStream || callState.localStream,
    monitorStream: callState.localStream,
    isLocal: true,
    micOn: !!callState.micOn,
    camOn: !!callState.camOn,
    screenOn: isLiveTrack(screenShareTrack),
  }];

  for (const [peerId, peer] of Object.entries(callState.peers)) {
    entries.push({
      id: `peer:${peerId}`,
      peerId,
      nick: callPeerName(peerId),
      avatar: callPeerAvatar(peerId),
      stream: peer.stream,
      monitorStream: peer.stream,
      isLocal: false,
      micOn: peer.micOn,
      camOn: peer.camOn,
      screenOn: peer.screenOn,
    });
  }

  const seen = new Set();

  for (const entry of entries) {
    seen.add(entry.id);

    let tile = findCallTile(entry.id, grid);

    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'call-tile';
      tile.dataset.peer = entry.id;
      grid.appendChild(tile);
    }

    updateCallTile(tile, entry);
    ensureSpeakingMonitor(entry.id, entry.monitorStream);
  }

  for (const tile of grid.querySelectorAll('.call-tile')) {
    if (seen.has(tile.dataset.peer)) continue;

    releaseMediaElements(tile);
    tile.remove();
  }

  for (const id of Object.keys(speakingMonitors)) {
    if (!seen.has(id)) stopSpeakingMonitor(id);
  }

  grid.dataset.count = String(entries.length);
  updateCallVisualMode();
}

/* ── Web Audio: индикатор речи ─────────────────────────────────────────── */

function getAudioCtx() {
  if (audioCtx && audioCtx.state !== 'closed') {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    return audioCtx;
  }

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = AudioContextClass ? new AudioContextClass() : null;
  } catch (_) {
    audioCtx = null;
  }

  return audioCtx;
}

function setSpeakingUI(id, speaking) {
  findCallTile(id)?.classList.toggle('speaking', speaking);
}

function stopSpeakingMonitor(id) {
  const monitor = speakingMonitors[id];
  if (!monitor) return;

  cancelAnimationFrame(monitor.raf);

  try {
    monitor.source.disconnect();
  } catch (_) {}

  try {
    monitor.analyser.disconnect();
  } catch (_) {}

  delete speakingMonitors[id];
  setSpeakingUI(id, false);
}

function stopAllSpeakingMonitors() {
  Object.keys(speakingMonitors).forEach(stopSpeakingMonitor);

  const previousContext = audioCtx;
  audioCtx = null;

  if (previousContext && previousContext.state !== 'closed') {
    try {
      previousContext.close().catch(() => {});
    } catch (_) {}
  }
}

function startSpeakingMonitor(id, stream) {
  const track = stream?.getAudioTracks().find(isLiveTrack);
  if (!track) return;

  const context = getAudioCtx();
  if (!context) return;

  let source;
  let analyser;

  try {
    // Один конкретный живой трек: нет зависимости от порядка треков в stream.
    source = context.createMediaStreamSource(new MediaStream([track]));
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
  } catch (_) {
    try {
      source?.disconnect();
    } catch (_) {}
    return;
  }

  const data = new Uint8Array(analyser.fftSize);

  const monitor = {
    source,
    analyser,
    data,
    stream,
    track,
    raf: null,
  };

  speakingMonitors[id] = monitor;

  let wasSpeaking = false;

  const tick = () => {
    if (speakingMonitors[id] !== monitor) return;

    const peerId = id.startsWith('peer:') ? id.slice(5) : null;
    const muted = id === 'local'
      ? !callState.micOn
      : !callState.peers[peerId] || callState.peers[peerId].micOn === false;

    let speaking = false;

    if (!muted && track.readyState === 'live' && !document.hidden) {
      analyser.getByteTimeDomainData(data);

      let sum = 0;

      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / data.length);

      speaking = rms > (
        wasSpeaking ? SPEAKING_THRESHOLD_OFF : SPEAKING_THRESHOLD_ON
      );
    }

    if (speaking !== wasSpeaking) {
      wasSpeaking = speaking;
      setSpeakingUI(id, speaking);
    }

    monitor.raf = requestAnimationFrame(tick);
  };

  tick();
}

function ensureSpeakingMonitor(id, stream) {
  const existing = speakingMonitors[id];
  const track = stream?.getAudioTracks().find(isLiveTrack);

  if (!track) {
    if (existing) stopSpeakingMonitor(id);
    return;
  }

  if (existing?.track === track) return;

  if (existing) stopSpeakingMonitor(id);

  startSpeakingMonitor(id, stream);
}

/* ── WebRTC и последовательные переговоры ──────────────────────────────── */

function isCurrentPc(peerId, pc) {
  const peer = callState.peers[peerId];

  return !!peer &&
    peer.pc === pc &&
    callState.active &&
    peer.session === callSessionSequence &&
    pc.signalingState !== 'closed';
}

function isPolite(peerId) {
  return String(state.me?.id || '') > String(peerId);
}

function peerConnectionStatus(pc) {
  return pc.connectionState || pc.iceConnectionState;
}

function peerIsConnected(pc) {
  return ['connected', 'completed'].includes(peerConnectionStatus(pc));
}

function enqueuePeerOperation(peerId, peer, operation) {
  const task = peer.queue.then(async () => {
    if (!isCurrentPc(peerId, peer.pc)) return;
    return operation();
  });

  // Очередь остаётся пригодной для следующей операции после ошибки.
  peer.queue = task.catch(error => {
    if (isCurrentPc(peerId, peer.pc)) {
      console.warn('[call] peer operation failed', peerId, error);
    }
  });

  return task;
}

async function applyAudioBitrate(pc) {
  if (pc.signalingState === 'closed') return;

  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'audio') continue;

    try {
      const parameters = sender.getParameters();

      // Не создаём encodings вручную: некоторые браузеры запрещают их изменение.
      if (!parameters.encodings?.length) continue;

      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = AUDIO_MAX_BITRATE;
      }

      await sender.setParameters(parameters);
    } catch (_) {
      // Ограничение битрейта — оптимизация, а не условие работы звонка.
    }
  }
}

function requestPeerNegotiation(peerId, peer, { iceRestart = false } = {}) {
  if (!isCurrentPc(peerId, peer.pc)) return;

  peer.needsNegotiation = true;
  peer.needsIceRestart ||= iceRestart;

  pumpPeerNegotiation(peerId, peer);
}

function pumpPeerNegotiation(peerId, peer) {
  if (!isCurrentPc(peerId, peer.pc)) return;
  if (peer.offerQueued || !peer.needsNegotiation) return;
  if (!socket.connected || !isId(callState.callId)) return;
  if (peer.pc.signalingState !== 'stable') return;

  peer.offerQueued = true;

  enqueuePeerOperation(peerId, peer, async () => {
    if (!socket.connected || !isId(callState.callId)) return;
    if (peer.pc.signalingState !== 'stable') return;
    if (!peer.needsNegotiation) return;

    const pc = peer.pc;
    const callId = callState.callId;
    const iceRestart = peer.needsIceRestart;

    peer.needsNegotiation = false;
    peer.needsIceRestart = false;
    peer.makingOffer = true;

    try {
      const offer = await pc.createOffer(
        iceRestart ? { iceRestart: true } : undefined,
      );

      if (!isCurrentPc(peerId, pc)) return;

      await pc.setLocalDescription(offer);

      if (!isCurrentPc(peerId, pc)) return;
      if (callState.callId !== callId) return;

      const description = pc.localDescription;

      emitCall('callSignal', {
        callId,
        to: peerId,
        data: {
          type: 'offer',
          sdp: {
            type: description.type,
            sdp: description.sdp,
          },
        },
      });

      await applyAudioBitrate(pc);
    } finally {
      peer.makingOffer = false;
    }
  }).catch(error => {
    if (isCurrentPc(peerId, peer.pc)) {
      console.warn('[call] offer failed', peerId, error);
    }
  }).finally(() => {
    peer.offerQueued = false;

    if (
      isCurrentPc(peerId, peer.pc) &&
      peer.needsNegotiation &&
      peer.pc.signalingState === 'stable'
    ) {
      pumpPeerNegotiation(peerId, peer);
    }
  });
}

async function sendOffer(peerId, pc, options = {}) {
  const peer = callState.peers[peerId];

  if (!peer || peer.pc !== pc) return;

  requestPeerNegotiation(peerId, peer, {
    iceRestart: options.iceRestart === true,
  });

  await peer.queue;
}

function createPeerConnection(peerId) {
  if (!isId(peerId) || peerId === state.me?.id || !callState.active) return null;

  const existing = callState.peers[peerId];

  /*
   * failed не означает closed: оставляем PC для ICE restart.
   * Иначе приходящий restart-offer мог бы уничтожить восстанавливаемый PC.
   */
  if (existing && existing.pc.signalingState !== 'closed') {
    return existing.pc;
  }

  if (existing) {
    closePeerConnection(existing);
    stopSpeakingMonitor(`peer:${peerId}`);
    delete callState.peers[peerId];
  }

  const pc = new RTCPeerConnection({ ...RTC_CONFIG });

  const peer = {
    pc,
    session: captureCallSession(),
    queue: Promise.resolve(),

    dc: null,
    stream: new MediaStream(),
    videoSender: null,

    pendingCandidates: [],
    makingOffer: false,
    ignoreOffer: false,
    offerQueued: false,
    needsNegotiation: false,
    needsIceRestart: false,

    iceRestarted: false,
    restartTimer: null,
    disconnectTimer: null,

    micOn: true,
    camOn: true,
    screenOn: false,
    lastConnectionState: null,
  };

  callState.peers[peerId] = peer;

  pc.onnegotiationneeded = () => {
    requestPeerNegotiation(peerId, peer);
  };

  pc.onsignalingstatechange = () => {
    if (!isCurrentPc(peerId, pc)) return;

    if (pc.signalingState === 'stable') {
      pumpPeerNegotiation(peerId, peer);
    }
  };

  for (const track of callState.localStream?.getAudioTracks() || []) {
    if (isLiveTrack(track)) pc.addTrack(track, callState.localStream);
  }

  const videoTrack = currentOutgoingVideoTrack();

  if (videoTrack) {
    const videoStream = videoTrack === screenShareTrack
      ? screenShareStream
      : callState.localStream;

    peer.videoSender = videoStream
      ? pc.addTrack(videoTrack, videoStream)
      : pc.addTrack(videoTrack);
  }

  try {
    const dc = pc.createDataChannel('state', {
      negotiated: true,
      id: 0,
      ordered: true,
    });

    peer.dc = dc;

    dc.onopen = () => {
      if (isCurrentPc(peerId, pc)) sendMediaState(peerId);
    };

    dc.onmessage = event => {
      if (!isCurrentPc(peerId, pc)) return;
      if (typeof event.data !== 'string') return;
      if (event.data.length > MAX_STATE_MESSAGE_LENGTH) return;

      try {
        const message = JSON.parse(event.data);

        if (isRecord(message) && message.type === 'state') {
          applyRemoteMediaState(peerId, message);
        }
      } catch (_) {}
    };

    dc.onerror = () => {
      if (isCurrentPc(peerId, pc)) sendMediaState(peerId);
    };
  } catch (error) {
    console.warn('[call] DataChannel unavailable', error);
  }

  pc.onicecandidate = event => {
    if (!event.candidate || !isCurrentPc(peerId, pc)) return;
    if (!isId(callState.callId)) return;

    emitCall('callSignal', {
      callId: callState.callId,
      to: peerId,
      data: {
        type: 'ice',
        candidate: event.candidate.toJSON(),
      },
    });
  };

  pc.ontrack = event => {
    if (!isCurrentPc(peerId, pc)) return;

    const track = event.track;

    if (!peer.stream.getTracks().includes(track)) {
      peer.stream.addTrack(track);
    }

    const refresh = () => {
      if (isCurrentPc(peerId, pc)) scheduleCallGrid();
    };

    track.onmute = refresh;
    track.onunmute = refresh;

    track.onended = () => {
      if (!isCurrentPc(peerId, pc)) return;

      try {
        peer.stream.removeTrack(track);
      } catch (_) {}

      scheduleCallGrid();
    };

    scheduleCallGrid();
  };

  const updateConnection = () => {
    if (!isCurrentPc(peerId, pc)) return;

    const status = peerConnectionStatus(pc);

    // Некоторые браузеры присылают оба события для одного перехода.
    if (peer.lastConnectionState === status) return;
    peer.lastConnectionState = status;

    if (peerIsConnected(pc)) {
      clearTimeout(peer.restartTimer);
      clearTimeout(peer.disconnectTimer);

      peer.restartTimer = null;
      peer.disconnectTimer = null;
      peer.iceRestarted = false;

      stopOutgoingRing();

      setText('call-overlay-status', 'в звонке');
      startCallTimer();
      sendMediaState(peerId);

      applyAudioBitrate(pc).catch(() => {});
      scheduleCallGrid();
      return;
    }

    if (status === 'disconnected') {
      setText('call-overlay-status', 'переподключение…');

      clearTimeout(peer.disconnectTimer);

      peer.disconnectTimer = setTimeout(() => {
        if (!isCurrentPc(peerId, pc) || peerIsConnected(pc)) return;
        handlePeerFailed(peerId, pc);
      }, 2500);

      return;
    }

    if (status === 'failed') {
      handlePeerFailed(peerId, pc);
    }
  };

  pc.onconnectionstatechange = updateConnection;
  pc.oniceconnectionstatechange = updateConnection;

  return pc;
}

async function connectToPeer(peerId, shouldOffer = true) {
  if (!isId(peerId) || peerId === state.me?.id || !callState.active) return null;

  const pc = createPeerConnection(peerId);
  if (!pc) return null;

  if (shouldOffer && !pc.localDescription) {
    await sendOffer(peerId, pc);
  }

  return pc;
}

function handlePeerFailed(peerId, pc) {
  const peer = callState.peers[peerId];

  if (!peer || !isCurrentPc(peerId, pc)) return;
  if (peerIsConnected(pc)) return;

  // Повторное failed во время текущего restart не завершает его досрочно.
  if (peer.iceRestarted) return;

  peer.iceRestarted = true;
  setText('call-overlay-status', 'переподключение…');

  clearTimeout(peer.restartTimer);

  peer.restartTimer = setTimeout(() => {
    if (!isCurrentPc(peerId, pc) || peerIsConnected(pc)) return;
    giveUpPeer(peerId, pc);
  }, ICE_RESTART_TIMEOUT_MS);

  /*
   * Обе стороны могут инициировать восстановление:
   * конфликт offer разрешается perfect negotiation.
   */
  requestPeerNegotiation(peerId, peer, { iceRestart: true });
}

function giveUpPeer(peerId, expectedPc = null) {
  const peer = callState.peers[peerId];

  if (!callState.active || !peer) return;
  if (expectedPc && peer.pc !== expectedPc) return;

  if (callState.isGroup) {
    showTransientNotice(`${callPeerName(peerId)}: соединение потеряно`);
    teardownPeer(peerId);

    if (!Object.keys(callState.peers).length) startPeerWait();
  } else {
    showTransientNotice(
      window.__chatappRtc?.relayRequired &&
      !window.__chatappRtc?.relayConfigured
        ? 'Соединение не установлено. Проверьте настройку TURN'
        : 'Соединение с собеседником потеряно',
    );

    hangupCall();
  }
}

function teardownPeer(peerId, { render = true } = {}) {
  const peer = callState.peers[peerId];

  // Сначала делаем асинхронные обработчики старого PC неактуальными.
  delete callState.peers[peerId];

  closePeerConnection(peer);
  stopSpeakingMonitor(`peer:${peerId}`);

  if (render) renderCallGrid();
}

async function flushPeerCandidates(peerId, peer) {
  if (!isCurrentPc(peerId, peer.pc) || !peer.pc.remoteDescription) return;

  const candidates = peer.pendingCandidates.splice(0);

  for (const candidate of candidates) {
    if (!isCurrentPc(peerId, peer.pc)) return;

    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (error) {
      if (!peer.ignoreOffer) {
        console.warn('[call] queued ICE rejected', peerId, error);
      }
    }
  }
}

function validSessionDescription(data, expectedType) {
  return isRecord(data) &&
    data.type === expectedType &&
    typeof data.sdp === 'string' &&
    data.sdp.length > 0 &&
    data.sdp.length <= MAX_SIGNAL_SDP_LENGTH;
}

function validIceCandidate(candidate) {
  return isRecord(candidate) &&
    typeof candidate.candidate === 'string' &&
    candidate.candidate.length <= 16_384 &&
    (candidate.sdpMid == null || typeof candidate.sdpMid === 'string') &&
    (
      candidate.sdpMLineIndex == null ||
      (
        Number.isInteger(candidate.sdpMLineIndex) &&
        candidate.sdpMLineIndex >= 0
      )
    );
}

async function handleCallSignal(payload) {
  if (!isRecord(payload)) return;

  const { callId, from, data } = payload;

  if (!callState.active || !isId(callId) || callId !== callState.callId) return;
  if (!isId(from) || from === state.me?.id || !isRecord(data)) return;

  if (!['state', 'offer', 'answer', 'ice'].includes(data.type)) return;

  if (data.type === 'state') {
    // Одно сообщение состояния не создаёт дорогостоящий PeerConnection.
    applyRemoteMediaState(from, data);
    return;
  }

  if (
    ['offer', 'answer'].includes(data.type) &&
    !validSessionDescription(data.sdp, data.type)
  ) {
    return;
  }

  if (data.type === 'ice' && !validIceCandidate(data.candidate)) return;

  /*
   * Авторизацию участника комнаты ОБЯЗАТЕЛЬНО проверяет сервер.
   * Клиентская проверка callId не заменяет серверную авторизацию.
   */
  let peer = callState.peers[from];

  // Answer без существующего локального offer не имеет смысла.
  if (!peer && data.type === 'answer') return;

  const pc = peer?.pc || createPeerConnection(from);
  if (!pc) return;

  peer = callState.peers[from];

  await enqueuePeerOperation(from, peer, async () => {
    if (callState.callId !== callId) return;

    if (data.type === 'offer') {
      const collision =
        peer.makingOffer ||
        pc.signalingState !== 'stable';

      peer.ignoreOffer = collision && !isPolite(from);

      if (peer.ignoreOffer) return;

      if (collision) {
        try {
          // Современный WebRTC выполняет implicit rollback.
          await pc.setRemoteDescription(data.sdp);
        } catch (error) {
          if (!isCurrentPc(from, pc)) return;

          if (pc.signalingState !== 'have-local-offer') throw error;

          await pc.setLocalDescription({ type: 'rollback' });

          if (!isCurrentPc(from, pc)) return;
          await pc.setRemoteDescription(data.sdp);
        }
      } else {
        await pc.setRemoteDescription(data.sdp);
      }

      if (!isCurrentPc(from, pc)) return;

      peer.ignoreOffer = false;
      await flushPeerCandidates(from, peer);

      if (!isCurrentPc(from, pc)) return;

      const answer = await pc.createAnswer();

      if (!isCurrentPc(from, pc)) return;

      await pc.setLocalDescription(answer);

      if (!isCurrentPc(from, pc) || callState.callId !== callId) return;

      const description = pc.localDescription;

      emitCall('callSignal', {
        callId,
        to: from,
        data: {
          type: 'answer',
          sdp: {
            type: description.type,
            sdp: description.sdp,
          },
        },
      });

      sendMediaState(from);
      await applyAudioBitrate(pc);

      // Локальные изменения, накопленные во время glare, не теряются.
      pumpPeerNegotiation(from, peer);
      return;
    }

    if (data.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;

      await pc.setRemoteDescription(data.sdp);

      if (!isCurrentPc(from, pc)) return;

      peer.ignoreOffer = false;

      await flushPeerCandidates(from, peer);

      if (!isCurrentPc(from, pc)) return;

      sendMediaState(from);
      await applyAudioBitrate(pc);
      pumpPeerNegotiation(from, peer);
      return;
    }

    if (data.type === 'ice') {
      if (peer.ignoreOffer) return;

      if (!pc.remoteDescription) {
        if (peer.pendingCandidates.length < MAX_PENDING_ICE) {
          peer.pendingCandidates.push(data.candidate);
        }
        return;
      }

      try {
        await pc.addIceCandidate(data.candidate);
      } catch (error) {
        if (!peer.ignoreOffer) {
          console.warn('[call] ICE rejected', from, error);
        }
      }
    }
  });
}

async function offerToParticipants(participants) {
  if (!Array.isArray(participants)) return;

  const session = captureCallSession();
  const others = uniqueIds(participants)
    .filter(id => id !== state.me?.id);

  await Promise.allSettled(
    others.map(async peerId => {
      if (!currentSessionMatches(session)) return;
      await connectToPeer(peerId, true);
    }),
  );

  if (!currentSessionMatches(session)) return;

  renderCallGrid();

  if (!others.length) {
    setText(
      'call-overlay-status',
      callState.isGroup ? 'ожидание участников…' : 'ожидание ответа…',
    );
  }
}

/* ── Входящий звонок ───────────────────────────────────────────────────── */

function dismissIncomingCall(expectedCallId = null) {
  const incoming = callState.pendingIncoming;

  if (expectedCallId && incoming?.callId !== expectedCallId) return;

  if (
    incoming &&
    pendingMediaOperation?.kind === 'accept' &&
    pendingMediaOperation.incomingCallId === incoming.callId
  ) {
    cancelMediaOperation();
  }

  clearTimeout(callState.incomingTimer);

  callState.incomingTimer = null;
  callState.pendingIncoming = null;

  setDisplay('incoming-call-modal', 'none');
  safeCallSound('stopRing');
}

function showIncomingCall(info) {
  clearTimeout(callState.incomingTimer);

  callState.pendingIncoming = info;

  const nickname = info.isGroup
    ? state.groups[info.groupId]?.name || 'Групповой звонок'
    : info.fromNick || state.friends[info.from]?.nickname || info.from;

  setText('incoming-call-nick', nickname);

  setText(
    'incoming-call-sub',
    info.isGroup
      ? `${info.fromNick || 'Участник'} начал(а) ${info.video ? 'видео' : 'аудио'}звонок`
      : `Входящий ${info.video ? 'видео' : 'аудио'}звонок…`,
  );

  const avatar = $('incoming-call-avatar');

  if (avatar) {
    if (info.isGroup && state.groups[info.groupId]) {
      renderGroupAv(avatar, state.groups[info.groupId]);
    } else {
      avatar.classList.remove('group-av');
      renderAv(
        avatar,
        nickname,
        info.isGroup ? null : state.friends[info.from]?.avatar ?? null,
      );
    }
  }

  setDisplay('incoming-call-modal', 'flex');
  safeCallSound('startRing', false);

  callState.incomingTimer = setTimeout(() => {
    if (callState.pendingIncoming !== info) return;

    if (!info.isGroup) {
      emitCall('callReject', { callId: info.callId });
    }

    dismissIncomingCall(info.callId);
    showTransientNotice(`Пропущенный звонок от ${nickname}`);
  }, CALL_RING_TIMEOUT_MS);
}

async function acceptIncomingCall() {
  const info = callState.pendingIncoming;

  if (!info || callStarting || callState.active) return;

  if (!socket.connected || !state.me) {
    dismissIncomingCall(info.callId);
    return;
  }

  const operation = beginMediaOperation('accept', info.callId);
  if (!operation) return;

  /*
   * После нажатия "Принять" таймер рингтона больше не отменяет запрос
   * разрешения на устройства. Отмена сервером всё ещё обрабатывается.
   */
  clearTimeout(callState.incomingTimer);
  callState.incomingTimer = null;

  setDisplay('incoming-call-modal', 'none');
  safeCallSound('stopRing');

  let stream = null;

  try {
    stream = await acquireLocalStream(!!info.video, {
      signal: operation.controller.signal,
    });

    if (!isCurrentMediaOperation(operation)) return;
    if (callState.pendingIncoming !== info || callState.active) return;

    if (!socket.connected) {
      dismissIncomingCall(info.callId);
      return;
    }

    if (!$('call-overlay')) {
      throw new Error('#call-overlay not found');
    }

    beginCallSession({
      stream,
      callId: info.callId,
      chatKey: info.chatKey,
      isGroup: info.isGroup,
      groupId: info.groupId,
      peerFriendId: info.isGroup ? null : info.from,
      peerFriendName: info.isGroup
        ? null
        : info.fromNick || state.friends[info.from]?.nickname || info.from,
    });

    stream = null;

    openCallOverlay('соединение…');
    requestCallJoin();
    safeCallSound('join');
  } catch (error) {
    if (error?.name !== 'AbortError' && isCurrentMediaOperation(operation)) {
      showTransientNotice(mediaErrorMessage(error));

      if (!info.isGroup) {
        emitCall('callReject', { callId: info.callId });
      }

      dismissIncomingCall(info.callId);
    }
  } finally {
    stopStream(stream);
    finishMediaOperation(operation);
  }
}

function declineIncomingCall() {
  const info = callState.pendingIncoming;
  if (!info) return;

  if (!info.isGroup) {
    emitCall('callReject', { callId: info.callId });
  }

  dismissIncomingCall(info.callId);
}

/* ── DM voice bar ──────────────────────────────────────────────────────── */

function updateDmVoiceBar() {
  const bar = $('dm-voice-bar');
  if (!bar) return;

  const peerId = state.activeFriend;
  const room = peerId ? state.dmVoiceCalls[peerId] : null;
  const visible = !!(peerId && !state.activeGroup && room);

  bar.style.display = visible ? 'flex' : 'none';
  if (!visible) return;

  const inRoom = callState.active && callState.callId === room.callId;
  const others = uniqueIds(room.participants)
    .filter(id => id !== state.me?.id);

  setText(
    'dm-voice-status',
    inRoom
      ? 'Вы подключены'
      : others.length
        ? 'Собеседник в войсе, можно вернуться'
        : 'Ожидание участников',
  );

  const button = $('btn-rejoin-dm-voice');

  if (button) {
    button.textContent = inRoom ? 'Вы в войсе' : 'Вернуться в войс';
    button.disabled = callBusy() || !socket.connected;
  }
}

function receiveDmVoice(info, { render = true } = {}) {
  if (!isRecord(info) || !isId(info.peerId)) return;

  if (isId(info.callId)) {
    state.dmVoiceCalls[info.peerId] = {
      callId: info.callId,
      video: info.video === true,
      participants: uniqueIds(info.participants),
    };

    /*
     * Наличие комнаты ещё не означает, что собеседник ответил.
     * Не отменяем таймер исходящего вызова только из-за dmVoiceState.
     */
  } else if (info.callId == null || info.callId === '') {
    delete state.dmVoiceCalls[info.peerId];
  }

  if (render) updateDmVoiceBar();
}

/* ── Socket events ─────────────────────────────────────────────────────── */

onCallSocket('dmVoiceState', receiveDmVoice);

socket.on('dmVoiceSnapshot', rooms => {
  if (!Array.isArray(rooms)) return;

  state.dmVoiceCalls = Object.create(null);

  for (const room of rooms) {
    receiveDmVoice(room, { render: false });
  }

  updateDmVoiceBar();
});

onCallSocket('callIncoming', info => {
  if (!state.me || !isId(info.callId) || !isId(info.from)) return;
  if (info.from === state.me.id) return;
  if (info.isGroup !== undefined && typeof info.isGroup !== 'boolean') return;
  if (info.video !== undefined && typeof info.video !== 'boolean') return;

  const isGroup = info.isGroup === true;

  if (isGroup && !isId(info.groupId)) return;
  if (info.fromNick != null && typeof info.fromNick !== 'string') return;
  if (info.chatKey != null && typeof info.chatKey !== 'string') return;

  if (callState.pendingIncoming?.callId === info.callId) return;
  if (callState.active && callState.callId === info.callId) return;

  if (callBusy()) {
    if (!isGroup) {
      emitCall('callReject', {
        callId: info.callId,
        reason: 'busy',
      });
    }
    return;
  }

  if (
    isGroup &&
    state.groupVoiceCalls[info.groupId]?.callId === info.callId
  ) {
    return;
  }

  showIncomingCall({
    callId: info.callId,
    from: info.from,
    fromNick: info.fromNick || null,
    isGroup,
    groupId: isGroup ? info.groupId : null,
    video: info.video === true,
    chatKey: info.chatKey || null,
  });
});

onCallSocket('callStarted', async payload => {
  const {
    callId,
    requestId,
    participants,
    chatKey,
    answered,
  } = payload;

  if (!isId(callId)) return;
  if (requestId !== undefined && !isId(requestId)) return;

  const belongsToCurrentStart =
    callState.active &&
    !!pendingStartRequestId &&
    !callState.callId &&
    (
      requestId === undefined ||
      requestId === pendingStartRequestId
    );

  if (!belongsToCurrentStart) {
    // Повторный ACK текущего звонка не требует выхода.
    if (callState.callId !== callId) {
      emitCall('callLeave', { callId, requestId });
    }
    return;
  }

  pendingStartRequestId = null;

  clearTimeout(startAckTimer);
  startAckTimer = null;

  callState.callId = callId;

  if (typeof chatKey === 'string') callState.chatKey = chatKey;

  if (answered === true || callState.isGroup) stopOutgoingRing();

  if (callState.isGroup && callState.groupId) {
    state.groupVoiceCalls[callState.groupId] = {
      callId,
      video: callState.video,
      participants: uniqueIds(
        Array.isArray(participants) ? participants : [state.me?.id],
      ),
    };

    rememberGroupVoice(callState.groupId, callId, callState.video);
    renderGroupsList();
    updateGroupVoiceBar(callState.groupId);
  }

  await offerToParticipants(participants);

  for (const [peerId, peer] of Object.entries(callState.peers)) {
    pumpPeerNegotiation(peerId, peer);
  }
});

onCallSocket('callJoined', async payload => {
  const { callId, participants, requestId } = payload;

  if (!isId(callId)) return;
  if (requestId !== undefined && !isId(requestId)) return;

  if (!callState.active || callState.callId !== callId) {
    emitCall('callLeave', { callId, requestId });
    return;
  }

  if (
    requestId !== undefined &&
    pendingJoinRequestId !== null &&
    requestId !== pendingJoinRequestId
  ) {
    return;
  }

  // Повторный ACK не должен пересоздавать переговоры с уже подключёнными.
  if (requestId !== undefined && pendingJoinRequestId === null) return;

  pendingJoinRequestId = null;

  clearTimeout(joinAckTimer);
  joinAckTimer = null;

  stopOutgoingRing();

  await offerToParticipants(participants);
});

onCallSocket('callLeft', ({ callId, reason }) => {
  if (!isId(callId)) return;
  if (reason != null && typeof reason !== 'string') return;

  // Запоздалый ACK обычного выхода не закрывает повторный вход.
  if (reason === 'left') return;
  if (!callState.active || callState.callId !== callId) return;

  closeCallOverlay();

  if (reason === 'kicked' || reason === 'left_group') {
    showTransientNotice('Доступ к голосовому каналу закрыт');
  }
});

onCallSocket('callPeerJoined', async ({ callId, peerId }) => {
  if (!isId(callId) || !isId(peerId)) return;
  if (!callState.active || callId !== callState.callId) return;
  if (peerId === state.me?.id) return;

  stopOutgoingRing();

  const existing = callState.peers[peerId];

  /*
   * Если offer уже пришёл раньше события callPeerJoined, не уничтожаем PC.
   * При настоящем повторном входе сервер должен сначала прислать
   * callPeerLeft/callPeerReconnecting.
   */
  if (!existing) {
    safeCallSound('join');
    createPeerConnection(peerId);
    setText('call-overlay-status', 'соединение…');
  }

  renderCallGrid();

  const peer = callState.peers[peerId];

  if (peer && !peer.pc.localDescription) {
    await sendOffer(peerId, peer.pc);
  }
});

onCallSocket('callPeerLeft', ({ callId, peerId }) => {
  if (!isId(callId) || !isId(peerId)) return;
  if (!callState.active || callId !== callState.callId) return;
  if (peerId === state.me?.id) return;

  const existed = !!callState.peers[peerId];
  const nickname = callPeerName(peerId);

  teardownPeer(peerId);

  if (existed) {
    safeCallSound('leave');

    showTransientNotice(
      callState.isGroup
        ? `${nickname} покинул(а) канал`
        : `${nickname} вышел(а). Можно вернуться в этот войс`,
    );
  }

  if (!Object.keys(callState.peers).length) startPeerWait();
});

onCallSocket('callPeerReconnecting', ({ callId, peerId }) => {
  if (!isId(callId) || !isId(peerId)) return;
  if (!callState.active || callId !== callState.callId) return;
  if (peerId === state.me?.id) return;

  /*
   * Сервер сообщает о пересборке соединения удалённой стороны.
   * Сбрасываем именно её PC, а не весь mesh.
   */
  if (callState.peers[peerId]) teardownPeer(peerId);

  setText('call-overlay-status', 'участник переподключается…');
});

onCallSocket('callSignal', handleCallSignal);

onCallSocket('callRejected', ({ callId, reason }) => {
  if (!isId(callId)) return;
  if (!callState.active || callId !== callState.callId) return;
  if (callState.isGroup) return;

  showTransientNotice(
    reason === 'busy'
      ? 'Собеседник занят'
      : 'Собеседник отклонил звонок',
  );

  closeCallOverlay();
});

onCallSocket('callCancelled', ({ callId, reason }) => {
  if (!isId(callId)) return;

  const incoming = callState.pendingIncoming;
  if (!incoming || incoming.callId !== callId) return;

  const nickname = incoming.isGroup
    ? state.groups[incoming.groupId]?.name || 'группы'
    : incoming.fromNick ||
      state.friends[incoming.from]?.nickname ||
      incoming.from;

  dismissIncomingCall(callId);

  if (reason !== 'answered_elsewhere') {
    showTransientNotice(`Пропущенный звонок от ${nickname}`);
  }
});

onCallSocket('callEnded', ({ callId, reason }) => {
  if (!isId(callId)) return;
  if (reason != null && typeof reason !== 'string') return;

  if (callState.pendingIncoming?.callId === callId) {
    dismissIncomingCall(callId);
  }

  if (reason !== 'replaced_device') {
    for (const [peerId, room] of Object.entries(state.dmVoiceCalls)) {
      if (room?.callId === callId) delete state.dmVoiceCalls[peerId];
    }

    for (const [groupId, room] of Object.entries(state.groupVoiceCalls)) {
      if (room?.callId !== callId) continue;

      clearGroupVoiceRejoin(groupId, callId);
      delete state.groupVoiceCalls[groupId];
      updateGroupVoiceBar(groupId);
    }

    renderGroupsList();
    updateDmVoiceBar();
  }

  if (!callState.active || callState.callId !== callId) return;

  const messages = {
    timeout: 'Нет ответа',
    ended: 'Звонок завершён',
    group_deleted: 'Группа удалена — звонок завершён',
    kicked: 'Вы исключены из группы — звонок завершён',
    server_error: 'Звонок прерван из-за ошибки сервера',
    replaced_device: 'Звонок продолжен на другом устройстве',
  };

  showTransientNotice(
    Object.hasOwn(messages, reason)
      ? messages[reason]
      : 'Звонок завершён',
  );

  safeCallSound('leave');
  closeCallOverlay();
});

onCallSocket('callError', payload => {
  const { reason, callId, event, requestId } = payload;

  if (typeof reason !== 'string') return;
  if (callId !== undefined && !isId(callId)) return;
  if (requestId !== undefined && !isId(requestId)) return;
  if (event !== undefined && typeof event !== 'string') return;

  if (
    ['watchGroupVoice', 'watchDmVoice', 'callSignal', 'callLeave']
      .includes(event)
  ) {
    return;
  }

  if (
    requestId !== undefined &&
    requestId !== pendingStartRequestId &&
    requestId !== pendingJoinRequestId
  ) {
    return;
  }

  if (
    callId &&
    callState.callId &&
    callId !== callState.callId &&
    callState.pendingIncoming?.callId !== callId
  ) {
    return;
  }

  if (reason === 'not_found' && callId) {
    for (const [peerId, room] of Object.entries(state.dmVoiceCalls)) {
      if (room?.callId === callId) delete state.dmVoiceCalls[peerId];
    }

    for (const [groupId, room] of Object.entries(state.groupVoiceCalls)) {
      if (room?.callId !== callId) continue;

      clearGroupVoiceRejoin(groupId, callId);
      delete state.groupVoiceCalls[groupId];
      updateGroupVoiceBar(groupId);
    }

    renderGroupsList();
    updateDmVoiceBar();
  }

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

  showTransientNotice(
    Object.hasOwn(messages, reason)
      ? messages[reason]
      : 'Ошибка звонка',
  );

  /*
   * Ошибка без requestId/callId не должна произвольно закрывать давно
   * установленный звонок. Завершаем только коррелированную операцию.
   */
  const matchesPendingRequest =
    !!requestId &&
    (
      requestId === pendingStartRequestId ||
      requestId === pendingJoinRequestId
    );

  const matchesCurrentCall =
    !!callId && callId === callState.callId;

  const legacyPendingStart =
    !requestId &&
    !callId &&
    !!pendingStartRequestId &&
    (!event || event === 'callStart');

  if (matchesPendingRequest || matchesCurrentCall || legacyPendingStart) {
    if (callState.active) {
      // Выходим и локально, и на сервере, если членство уже создано.
      hangupCall();
    } else {
      cancelMediaOperation();
    }
  }

  if (callId && callState.pendingIncoming?.callId === callId) {
    dismissIncomingCall(callId);
  }
});

/* ── Реконнект сокета ───────────────────────────────────────────────────── */

socket.on('disconnect', () => {
  clearTimeout(callReconnectTimer);
  callReconnectTimer = null;

  // Старое разрешение на устройства не должно запускать звонок после reconnect.
  if (pendingMediaOperation) cancelMediaOperation();

  if (callState.pendingIncoming) dismissIncomingCall();

  updateDmVoiceBar();

  if (!callState.active) return;

  const session = captureCallSession();

  setText('call-overlay-status', 'переподключение…');

  callReconnectTimer = setTimeout(() => {
    if (!currentSessionMatches(session) || socket.connected) return;

    showTransientNotice('Звонок завершён: соединение не восстановилось');
    closeCallOverlay();
  }, CALL_SOCKET_GRACE_MS);
});

socket.on('connect', () => {
  clearTimeout(callReconnectTimer);
  callReconnectTimer = null;

  if (isId(state.activeFriend)) {
    emitCall('watchDmVoice', { peerId: state.activeFriend });
  }

  updateDmVoiceBar();

  if (!callState.active) return;

  if (!isId(callState.callId)) {
    /*
     * Сервер ещё не подтвердил callStart. Не запускаем второй callStart:
     * ждём коррелированный ACK или установленный таймаут.
     */
    return;
  }

  for (const peerId of Object.keys(callState.peers)) {
    teardownPeer(peerId, { render: false });
  }

  renderCallGrid();
  setText('call-overlay-status', 'соединение…');
  requestCallJoin({ rejoin: true });
});

onCallSocket('groupMemberLeft', ({ groupId, userId }) => {
  if (!isId(groupId) || !isId(userId)) return;
  if (!callState.active || !callState.isGroup) return;
  if (callState.groupId !== groupId) return;

  if (userId === state.me?.id) {
    hangupCall();
    showTransientNotice('Вы покинули группу');
    return;
  }

  if (callState.peers[userId]) teardownPeer(userId);
});

/* ── UI events ─────────────────────────────────────────────────────────── */

function runCallAction(action) {
  try {
    Promise.resolve(action()).catch(error => {
      console.warn('[call] UI action failed', error);
    });
  } catch (error) {
    console.warn('[call] UI action failed', error);
  }
}

on('btn-call-audio', 'click', () => {
  if (state.activeFriend) {
    runCallAction(() =>
      startCall({ toId: state.activeFriend, video: false }),
    );
  }
});

on('btn-call-video', 'click', () => {
  if (state.activeFriend) {
    runCallAction(() =>
      startCall({ toId: state.activeFriend, video: true }),
    );
  }
});

on('btn-group-call-audio', 'click', () => {
  if (state.activeGroup) {
    runCallAction(() =>
      startCall({ groupId: state.activeGroup, video: false }),
    );
  }
});

on('btn-group-call-video', 'click', () => {
  if (state.activeGroup) {
    runCallAction(() =>
      startCall({ groupId: state.activeGroup, video: true }),
    );
  }
});

on('btn-join-group-voice', 'click', () => {
  if (callBusy() || !state.activeGroup) return;

  runCallAction(() => {
    if (state.groupVoiceCalls[state.activeGroup]) {
      return joinExistingGroupVoice(state.activeGroup);
    }

    return startCall({
      groupId: state.activeGroup,
      video: false,
    });
  });
});

on('btn-rejoin-dm-voice', 'click', () => {
  if (callBusy() || !state.activeFriend) return;

  runCallAction(() =>
    startCall({ toId: state.activeFriend, video: false }),
  );
});

on('btn-call-hangup', 'click', hangupCall);
on('btn-call-toggle-mic', 'click', toggleMic);
on('btn-call-toggle-cam', 'click', toggleCam);

on('btn-call-share-screen', 'click', () => {
  runCallAction(toggleScreenShare);
});

on('btn-call-accept', 'click', () => {
  runCallAction(acceptIncomingCall);
});

on('btn-call-decline', 'click', declineIncomingCall);

document.addEventListener('keydown', event => {
  if (event.repeat) return;

  const key = typeof event.key === 'string'
    ? event.key.toLowerCase()
    : '';

  if (
    callState.active &&
    (event.ctrlKey || event.metaKey) &&
    event.shiftKey &&
    key === 'm'
  ) {
    event.preventDefault();
    toggleMic();
    return;
  }

  if (
    key === 'escape' &&
    callState.pendingIncoming &&
    !callState.active
  ) {
    const otherVisibleModal = [...document.querySelectorAll(
      '.modal, [role="dialog"], [aria-modal="true"]',
    )].some(element => {
      if (
        element.id === 'incoming-call-modal' ||
        element.closest('#incoming-call-modal')
      ) {
        return false;
      }

      return getComputedStyle(element).display !== 'none' &&
        element.getClientRects().length > 0;
    });

    if (!otherVisibleModal) {
      event.preventDefault();
      declineIncomingCall();
    }
  }
});

/*
 * Разблокировка autoplay после жеста пользователя.
 * Отказ play() не означает неисправность WebRTC.
 */
function unlockCallAudio() {
  if (!callState.active) return;

  if (audioCtx?.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }

  const grid = $('call-video-grid');
  if (!grid) return;

  for (const element of grid.querySelectorAll(
    'audio[data-play-pending="1"], video[data-play-pending="1"]',
  )) {
    tryPlayCallMedia(element);
  }
}

document.addEventListener('pointerdown', unlockCallAudio, { passive: true });
document.addEventListener('keydown', unlockCallAudio);

/* ── Позиционирование и idle ───────────────────────────────────────────── */

function pokeCallIdle() {
  const overlay = $('call-overlay');

  if (!overlay || !callState.active) return;
  if (!overlay.classList.contains('video-mode')) return;
  if (overlay.classList.contains('detached')) return;

  clearTimeout(idleTimer);
  overlay.classList.remove('idle');

  const session = captureCallSession();

  idleTimer = setTimeout(() => {
    idleTimer = null;

    if (!currentSessionMatches(session)) return;
    if (overlay.classList.contains('detached')) return;
    if (!overlay.classList.contains('video-mode')) return;

    // Не прячем контролы, пока пользователь работает с ними с клавиатуры.
    if (
      overlay.contains(document.activeElement) &&
      document.activeElement?.matches(
        'button, a, input, select, textarea, [role="button"]',
      )
    ) {
      return;
    }

    overlay.classList.add('idle');
  }, IDLE_HIDE_MS);
}

for (const event of ['mousemove', 'pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(event, pokeCallIdle, { passive: true });
}

window.addEventListener('resize', scheduleOverlaySync, { passive: true });
window.addEventListener('orientationchange', scheduleOverlaySync, {
  passive: true,
});

whenDomReady(() => {
  const overlay = $('call-overlay');

  overlay?.addEventListener('click', event => {
    if (!overlay.classList.contains('detached')) return;
    if (!(event.target instanceof Element)) return;

    if (event.target.closest('button, a, input, [role="button"]')) return;

    returnToCallChat();
  });

  const sidebar = document.querySelector('.sidebar');

  if (sidebar && 'MutationObserver' in window) {
    new MutationObserver(scheduleOverlaySync).observe(sidebar, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleOverlaySync);

    if (sidebar) observer.observe(sidebar);

    for (const header of document.querySelectorAll('.chat-head')) {
      observer.observe(header);
    }
  }

  const status = $('call-overlay-status');

  if (status && 'MutationObserver' in window) {
    const updateBusy = () => {
      const busy = /вызов|соединение|переподключение|ожидание/i
        .test(status.textContent || '');

      if (busy) {
        status.setAttribute('data-busy', '1');
      } else {
        status.removeAttribute('data-busy');
      }
    };

    new MutationObserver(updateBusy).observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    updateBusy();
  }

  resetCallControls();
  updateScreenShareUI();
  updateDmVoiceBar();
});

/* ── Уход со страницы ──────────────────────────────────────────────────── */

window.addEventListener('pagehide', () => {
  /*
   * socket.emit при закрытии страницы — best effort.
   * Сервер всё равно должен чистить членство по disconnect/TTL.
   */
  if (callState.active && isId(callState.callId)) {
    try {
      emitCall('callLeave', { callId: callState.callId });
    } catch (_) {}
  }

  if (
    callState.active ||
    callStarting ||
    callState.pendingIncoming ||
    screenShareStarting
  ) {
    closeCallOverlay();
  }
});

/* ── Глобальные ошибки ─────────────────────────────────────────────────── */

window.addEventListener('unhandledrejection', event => {
  if (
    typeof AuthError !== 'undefined' &&
    event.reason instanceof AuthError
  ) {
    event.preventDefault();
    return;
  }

  console.error('[app] Unhandled rejection:', event.reason);
});

window.addEventListener('error', event => {
  console.error('[app] Uncaught error:', event.error ?? event.message);
});

/* ── Экспорты для существующего UI ─────────────────────────────────────── */

Object.assign(window, {
  state,
  callState,
  socket,
  sfx,

  startCall,
  startExistingCall,
  joinExistingGroupVoice,
  hangupCall,
  closeCallOverlay,

  toggleMic,
  toggleCam,
  toggleScreenShare,
  startScreenShare,
  stopScreenShare,

  broadcastMediaState,
  renderCallGrid,
  resetCallControls,
  updateScreenShareUI,
  updateDmVoiceBar,

  rememberGroupVoice,
  clearGroupVoiceRejoin,
  restoreGroupVoiceRejoin,

  syncVoiceOverlayPosition,
  syncCallDetached,
  returnToCallChat,
  scheduleOverlaySync,
  clearPeerWait,

  setText,
  setDisplay,
  showTransientNotice,
  on,

  RTC_CONFIG,
  RAW_AUDIO_CONSTRAINTS,
});

/*
 * Сохраняем дополнительные interop-экспорты исходного файла.
 * Отсутствие одного символа не мешает экспортировать остальные.
 */
const callInteropExports = [
  ['BACKEND_URL', () => BACKEND_URL],
  ['MAX_AVATAR_SIZE', () => MAX_AVATAR_SIZE],
  ['ALLOWED_AVATAR_TYPES', () => ALLOWED_AVATAR_TYPES],
  ['authFetch', () => authFetch],
  ['safeJson', () => safeJson],
  ['isAnyModalOpen', () => isAnyModalOpen],
  ['updateTitleBadge', () => updateTitleBadge],
  ['closeAllModals', () => closeAllModals],

  ['closeActiveChat', () => closeActiveChat],
  ['openGroupChat', () => openGroupChat],
  ['updateGroupVoiceBar', () => updateGroupVoiceBar],
  ['renderGroupsList', () => renderGroupsList],
  ['showUserProfile', () => showUserProfile],
  ['openChat', () => openChat],
  ['renderFriendsList', () => renderFriendsList],
  ['renderGroupMembersPanel', () => renderGroupMembersPanel],
  ['closeProfileModal', () => closeProfileModal],
  ['closeGroupInfoModal', () => closeGroupInfoModal],
  ['closeAddMembersModal', () => closeAddMembersModal],
  ['closeCreateGroupModal', () => closeCreateGroupModal],
  ['refreshGroupItem', () => refreshGroupItem],
  ['openGroupInfoModal', () => openGroupInfoModal],
  ['openEditProfileModal', () => openEditProfileModal],
  ['closeEditProfileModal', () => closeEditProfileModal],
  ['openBlockedUsersModal', () => openBlockedUsersModal],
  ['closeBlockedUsersModal', () => closeBlockedUsersModal],
];

for (const [name, getter] of callInteropExports) {
  try {
    const value = getter();
    if (value !== undefined) window[name] = value;
  } catch (_) {
    // Необязательная функция другого UI-модуля отсутствует.
  }
}