/* ============================================================================
 * CALLS (WebRTC: DM 1:1 + Group mesh)
 * ==========================================================================*/
let callStarting = false;       // идёт getUserMedia для исходящего/принимаемого звонка
let leaveWhenStarted = false;   // трубку положили раньше, чем сервер прислал callStarted
const ICE_RESTART_TIMEOUT_MS = 12 * 1000;

const CALL_VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
};

const cssEsc = s => (window.CSS && typeof CSS.escape === 'function')
  ? CSS.escape(String(s))
  : String(s).replace(/["\\]/g, '\\$&');

function findCallTile(id) {
  return document.querySelector(`.call-tile[data-peer="${cssEsc(id)}"]`);
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
}

/** Занят ли клиент: активный звонок, входящий на экране или идёт запрос доступа к устройствам. */
function callBusy() {
  return callState.active || !!callState.pendingIncoming || callStarting;
}

function hasLocalVideo() {
  return !!callState.localStream && callState.localStream.getVideoTracks().length > 0;
}

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

/** Захват локального потока. При недоступной камере — fallback на аудио. */
async function acquireLocalStream(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('getUserMedia is not available');
    err.name = 'NotSupportedError';
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
    // Камера недоступна/запрещена — пробуем только аудио. Если и оно не удалось — отдаём исходную ошибку.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS, video: false });
    } catch (e2) {
      throw (e2?.name === 'NotAllowedError' ? e2 : e);
    }
    showTransientNotice('Камера недоступна — звонок без видео');
  }

  // Браузер мог проигнорировать «сырые» ограничения — пробуем применить их явно.
  for (const track of stream.getAudioTracks()) {
    const s = typeof track.getSettings === 'function' ? track.getSettings() : {};
    if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) {
      try { await track.applyConstraints(RAW_AUDIO_CONSTRAINTS); } catch (e) {}
      const after = typeof track.getSettings === 'function' ? track.getSettings() : {};
      if (after.echoCancellation || after.noiseSuppression || after.autoGainControl) {
        console.warn('[call] browser did not apply raw microphone constraints', after);
      }
    }
  }
  return stream;
}

function beginCallSession({ stream, callId = null, chatKey = null, isGroup, groupId = null, peerFriendId = null, peerFriendName = null, video }) {
  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);
  callState.ringTimer = null;
  callState.incomingTimer = null;
  leaveWhenStarted = false;

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
}

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
  // Если в группе уже идёт канал — присоединяемся, а не создаём новый (иначе 'busy')
  if (groupId && state.groupVoiceCalls[groupId]) {
    joinExistingGroupVoice(groupId);
    return;
  }

  callStarting = true;
  let stream;
  try {
    stream = await acquireLocalStream(video);
  } catch (e) {
    callStarting = false;
    showTransientNotice(mediaErrorMessage(e));
    return;
  }
  callStarting = false;

  // Пока ждали разрешение, ситуация могла измениться
  if (callState.active || callState.pendingIncoming || !socket.connected) {
    stopStream(stream);
    showTransientNotice(socket.connected ? 'Уже есть активный звонок' : 'Нет соединения с сервером');
    return;
  }

  beginCallSession({
    stream,
    isGroup: !!groupId,
    groupId: groupId || null,
    peerFriendId: toId || null,
    peerFriendName: toId ? (state.friends[toId]?.nickname || toId) : null,
    video,
  });
  openCallOverlay(groupId ? 'соединение…' : 'вызов…');
  socket.emit('callStart', { toId, groupId, video: !!video });

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
    stream = await acquireLocalStream(call.video);
  } catch (e) {
    callStarting = false;
    showTransientNotice(mediaErrorMessage(e));
    return;
  }
  callStarting = false;

  // Канал могли закрыть, пока запрашивали доступ
  if (callState.active || callState.pendingIncoming || state.groupVoiceCalls[groupId]?.callId !== call.callId) {
    stopStream(stream);
    if (!callState.active) showTransientNotice('Голосовой канал уже завершён');
    return;
  }

  beginCallSession({ stream, callId: call.callId, isGroup: true, groupId, video: call.video });
  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: call.callId });
  sfx.join();
}

function hangupCall() {
  if (!callState.active) return;
  if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
  else leaveWhenStarted = true; // callStarted ещё не пришёл — отменим, как только придёт
  sfx.leave();
  closeCallOverlay();
}

function resetCallControls() {
  const mic = $('btn-call-toggle-mic');
  if (mic) {
    mic.classList.toggle('active-off', !callState.micOn);
    mic.title = callState.micOn ? 'Выключить микрофон' : 'Включить микрофон';
    mic.setAttribute('aria-label', mic.title);
  }
  const cam = $('btn-call-toggle-cam');
  if (cam) {
    cam.classList.toggle('active-off', !callState.camOn);
    cam.title = callState.camOn ? 'Выключить камеру' : 'Включить камеру';
    cam.setAttribute('aria-label', cam.title);
    cam.disabled = !hasLocalVideo();
  }
}

function openCallOverlay(statusText) {
  callState.active = true;
  const overlay = $('call-overlay');
  if (!overlay) {
    console.warn('[call] #call-overlay not found');
    return;
  }
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

// Оверлей должен следовать за раскладкой: ресайз, поворот, скрытие сайдбара
let overlaySyncRaf = null;
function scheduleOverlaySync() {
  if (overlaySyncRaf || !callState.active) return;
  overlaySyncRaf = requestAnimationFrame(() => {
    overlaySyncRaf = null;
    syncVoiceOverlayPosition();
  });
}
window.addEventListener('resize', scheduleOverlaySync);
window.addEventListener('orientationchange', scheduleOverlaySync);
whenDomReady(() => {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && 'MutationObserver' in window) {
    new MutationObserver(scheduleOverlaySync)
      .observe(sidebar, { attributes: true, attributeFilter: ['class', 'style'] });
  }
});

function closeCallOverlay() {
  const overlay = $('call-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('voice-mode', 'video-mode');
    overlay.classList.remove('voice-mode', 'video-mode', 'idle');
    clearTimeout(idleTimer);
    overlay.style.removeProperty('--call-left');
    overlay.style.removeProperty('--call-top');
  }
  setDisplay('incoming-call-modal', 'none');
  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);
  callState.ringTimer = null;
  callState.incomingTimer = null;
  sfx.stopRing();

  stopAllSpeakingMonitors();
  stopStream(callState.localStream);

  Object.values(callState.peers).forEach(p => {
    clearTimeout(p.restartTimer);
    try {
      p.pc.onicecandidate = null;
      p.pc.ontrack = null;
      p.pc.onconnectionstatechange = null;
      p.pc.oniceconnectionstatechange = null;
      p.pc.close();
    } catch (e) {}
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
  if (grid) {
    grid.querySelectorAll('video').forEach(v => { try { v.srcObject = null; } catch (e) {} });
    grid.innerHTML = '';
    delete grid.dataset.count;
  }
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

  const entries = [{
    id: 'local',
    nick: state.me?.nickname || 'Я',
    avatar: state.me?.avatar || null,
    stream: callState.localStream,
    isLocal: true,
  }];
  for (const [peerId, p] of Object.entries(callState.peers)) {
    entries.push({ id: peerId, nick: callPeerName(peerId), avatar: callPeerAvatar(peerId), stream: p.stream, isLocal: false });
  }

  const seen = new Set();
  entries.forEach(({ id, nick, avatar, stream, isLocal }) => {
    seen.add(id);
    let tile = grid.querySelector(`.call-tile[data-peer="${cssEsc(id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'call-tile';
      tile.dataset.peer = id;
      grid.appendChild(tile);
    }
    updateCallTile(tile, nick, avatar, stream, isLocal);
    ensureSpeakingMonitor(id, stream);
  });

  grid.querySelectorAll('.call-tile').forEach(t => {
    if (seen.has(t.dataset.peer)) return;
    const v = t.querySelector('video');
    if (v) { try { v.srcObject = null; } catch (e) {} }
    t.remove();
  });
  Object.keys(speakingMonitors).forEach(id => { if (!seen.has(id)) stopSpeakingMonitor(id); });

  grid.dataset.count = String(entries.length);
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
      video.setAttribute('playsinline', '');
      video.disablePictureInPicture = true;
      tile.prepend(video);
    }
    video.muted = isLocal; // свой поток не воспроизводим — иначе эхо
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
  label.textContent = isLocal ? `${nickname} (вы)` : nickname;

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
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = AC ? new AC() : null;
  } catch (e) {
    audioCtx = null;
  }
  return audioCtx;
}

function setSpeakingUI(id, isSpeaking) {
  const tile = findCallTile(id);
  if (tile) tile.classList.toggle('speaking', isSpeaking);
}

// Переопределяет одноимённую функцию из первой части файла (function hoisting — побеждает последняя).
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
    // Свой выключенный микрофон не «говорит»
    if (id === 'local' && !callState.micOn) {
      if (wasSpeaking) { wasSpeaking = false; setSpeakingUI(id, false); }
      mon.raf = requestAnimationFrame(tick);
      return;
    }
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
function isCurrentPc(peerId, pc) {
  const peer = callState.peers[peerId];
  return !!peer && peer.pc === pc && callState.active;
}

/** «Вежливая» сторона (perfect negotiation) — с бо́льшим id: при коллизии откатывает свой offer. */
function isPolite(peerId) {
  return String(state.me?.id ?? '') > String(peerId);
}

function createPeerConnection(peerId) {
  const existingPeer = callState.peers[peerId];
  if (existingPeer?.pc) return existingPeer.pc;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = { pc, stream: null, pendingCandidates: [], makingOffer: false, iceRestarted: false, restartTimer: null };
  callState.peers[peerId] = peer;

  if (callState.localStream) {
    callState.localStream.getTracks().forEach(track => pc.addTrack(track, callState.localStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate && callState.callId && isCurrentPc(peerId, pc)) {
      socket.emit('callSignal', { callId: callState.callId, to: peerId, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.ontrack = e => {
    if (!isCurrentPc(peerId, pc)) return;
    if (e.streams && e.streams[0]) {
      peer.stream = e.streams[0];
    } else {
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
    }
    // Перерисовка при (раз)мьюте/завершении удалённого трека — иначе плитка залипает в audio-only
    e.track.onmute = e.track.onunmute = e.track.onended = () => renderCallGrid();
    renderCallGrid();
  };

  pc.oniceconnectionstatechange = () => {
    if (!isCurrentPc(peerId, pc)) return;
    // Fallback для браузеров без connectionState
    if (pc.iceConnectionState === 'failed' && !('connectionState' in pc)) handlePeerFailed(peerId, pc);
  };

  pc.onconnectionstatechange = () => {
    if (!isCurrentPc(peerId, pc)) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(peer.restartTimer);
      peer.restartTimer = null;
      peer.iceRestarted = false;
      clearTimeout(callState.ringTimer);
      sfx.stopRing();
      setText('call-overlay-status', 'в звонке');
    } else if (st === 'disconnected') {
      setText('call-overlay-status', 'переподключение…');
    } else if (st === 'failed') {
      handlePeerFailed(peerId, pc);
    }
  };

  return pc;
}

async function sendOffer(peerId, pc, options) {
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
      to: peerId,
      data: { type: 'offer', sdp: { type: ld.type, sdp: ld.sdp } },
    });
  } finally {
    peer.makingOffer = false;
  }
}

/** Соединение упало: одна попытка ICE-restart, затем разрыв. */
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

    // Restart инициирует «невежливая» сторона — вежливая примет её offer без коллизии
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
    if (!Object.keys(callState.peers).length) setText('call-overlay-status', 'ожидание участников…');
  } else {
    showTransientNotice('Соединение с собеседником потеряно');
    hangupCall();
  }
}

async function connectToPeer(peerId, shouldOffer) {
  if (!peerId || peerId === state.me?.id || !callState.active) return null;
  const pc = createPeerConnection(peerId);
  const peer = callState.peers[peerId];
  if (shouldOffer && peer && !peer.makingOffer && pc.signalingState === 'stable' && !pc.localDescription) {
    await sendOffer(peerId, pc);
  }
  return pc;
}

function teardownPeer(peerId, { render = true } = {}) {
  const p = callState.peers[peerId];
  if (p) {
    clearTimeout(p.restartTimer);
    try {
      p.pc.onicecandidate = null;
      p.pc.ontrack = null;
      p.pc.onconnectionstatechange = null;
      p.pc.oniceconnectionstatechange = null;
      p.pc.close();
    } catch (e) {}
  }
  delete callState.peers[peerId];
  stopSpeakingMonitor(peerId);
  if (render) renderCallGrid();
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
}
on('btn-call-toggle-cam', 'click', toggleCam);

// Ctrl+Shift+M — мьют микрофона во время звонка (как в Discord); Escape — отклонить входящий
document.addEventListener('keydown', e => {
  const key = typeof e.key === 'string' ? e.key : '';
  if (callState.active && (e.ctrlKey || e.metaKey) && e.shiftKey && key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleMic();
    return;
  }
  if (key === 'Escape' && callState.pendingIncoming && !callState.active) {
    e.preventDefault();
    $('btn-call-decline')?.click();
  }
});

/* ── Incoming call UI ──────────────────────────────────────────────────── */
function dismissIncomingCall() {
  clearTimeout(callState.incomingTimer);
  callState.incomingTimer = null;
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
      avatarEl.classList.remove('group-av'); // мог остаться от прошлого группового входящего
      renderAv(avatarEl, nick, state.friends[info.from]?.avatar || null);
    }
  }

  setDisplay('incoming-call-modal', 'flex');
  sfx.startRing(false);

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
  if (!info || callStarting) return;
  setDisplay('incoming-call-modal', 'none');
  sfx.stopRing();

  callStarting = true;
  let stream;
  try {
    stream = await acquireLocalStream(info.video);
  } catch (e) {
    callStarting = false;
    showTransientNotice(mediaErrorMessage(e));
    if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
    dismissIncomingCall();
    return;
  }
  callStarting = false;

  // Пока запрашивали разрешение, звонок могли отменить / завершить / разлогиниться
  if (callState.pendingIncoming?.callId !== info.callId || callState.active || !socket.connected || !state.me) {
    stopStream(stream);
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
  sfx.join();
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
 * Обработка SDP/ICE по схеме perfect negotiation: при «glare» (оба одновременно
 * отправили offer) «вежливый» пир (с бо́льшим id) откатывает свой offer и принимает чужой.
 */
async function handleCallSignal({ callId, from, data } = {}) {
  if (!callState.active || !callId || callId !== callState.callId) return;
  if (!from || !data || from === state.me?.id) return;

  const pc = createPeerConnection(from);
  const peer = callState.peers[from];
  if (!peer) return;

  try {
    if (data.type === 'offer') {
      if (!data.sdp) return;
      const desc = new RTCSessionDescription(data.sdp);
      const collision = peer.makingOffer || pc.signalingState !== 'stable';
      const polite = isPolite(from);
      if (collision && !polite) return; // наш offer «победил», чужой игнорируем

      if (collision) {
        try {
          await pc.setRemoteDescription(desc); // implicit rollback (современные браузеры)
        } catch (e) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(desc),
          ]);
        }
      } else {
        await pc.setRemoteDescription(desc);
      }
      if (!isCurrentPc(from, pc)) return;
      await flushPendingCandidates(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const ld = pc.localDescription;
      socket.emit('callSignal', { callId, to: from, data: { type: 'answer', sdp: { type: ld.type, sdp: ld.sdp } } });
    } else if (data.type === 'answer') {
      if (!data.sdp || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushPendingCandidates(from);
    } else if (data.type === 'ice' && data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          // После rollback кандидаты к откатанному offer'у невалидны — это нормально
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

/** Новый участник инициирует offer ко всем, кто уже в звонке. */
async function offerToParticipants(participants) {
  const others = [...new Set((participants || []).filter(id => id && id !== state.me?.id))];
  for (const peerId of others) {
    if (!callState.active) return;
    try { await connectToPeer(peerId, true); } catch (e) { console.warn('[call] offer failed', peerId, e); }
  }
  if (!callState.active) return;
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
  if (!info?.callId || !state.me) return;
  if (info.from && info.from === state.me.id) return;
  if (callBusy()) {
    if (!info.isGroup) socket.emit('callReject', { callId: info.callId, reason: 'busy' });
    return;
  }
  // Групповой канал, который уже отображается в списке, не звонит повторно
  if (info.isGroup && state.groupVoiceCalls[info.groupId]?.callId === info.callId) return;
  showIncomingCall(info);
});

socket.on('callStarted', ({ callId, chatKey, participants } = {}) => {
  if (!callId) return;
  // Трубку положили раньше, чем сервер создал звонок — отменяем его сейчас
  if (!callState.active) {
    if (leaveWhenStarted) {
      leaveWhenStarted = false;
      socket.emit('callLeave', { callId });
    }
    return;
  }
  if (callState.callId && callState.callId !== callId) return;
  callState.callId = callId;
  if (chatKey) callState.chatKey = chatKey;
  if (callState.isGroup && callState.groupId) {
    const existing = state.groupVoiceCalls[callState.groupId];
    if (!existing || existing.callId !== callId) {
      state.groupVoiceCalls[callState.groupId] = {
        callId,
        video: callState.video,
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
  callState.ringTimer = null;
  sfx.stopRing();
  sfx.join();
  // Пир (пере)вошёл — старое соединение недействительно, он пришлёт свежий offer
  if (callState.peers[peerId]) teardownPeer(peerId, { render: false });
  createPeerConnection(peerId);
  setText('call-overlay-status', 'соединение…');
  renderCallGrid();
});

socket.on('callPeerLeft', ({ callId, peerId } = {}) => {
  if (!callState.active || callId !== callState.callId || !peerId || peerId === state.me?.id) return;
  const name = callPeerName(peerId);
  teardownPeer(peerId);
  sfx.leave();
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
    const inc = callState.pendingIncoming;
    const nick = inc.isGroup
      ? (state.groups[inc.groupId]?.name || 'группы')
      : (inc.fromNick || state.friends[inc.from]?.nickname || inc.from);
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
    sfx.leave();
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
  leaveWhenStarted = false;
  // Если сессия запущена локально, но сервер отказал — сворачиваем оверлей
  if (callState.active) closeCallOverlay();
  else if (callState.pendingIncoming) dismissIncomingCall();
});

/* ── Реконнект сокета во время звонка ─────────────────────────────────── */
socket.on('disconnect', () => {
  if (callState.pendingIncoming) dismissIncomingCall(); // ответить всё равно не сможем
  if (callState.active) setText('call-overlay-status', 'переподключение…');
});

socket.on('connect', () => {
  if (!callState.active || !callState.callId) return;
  // Пересобираем mesh с нуля: старые соединения могли пережить разрыв, но сигналинг для них потерян.
  // Другие участники получат callPeerJoined и будут ждать наш свежий offer.
  Object.keys(callState.peers).forEach(id => teardownPeer(id, { render: false }));
  renderCallGrid();
  setText('call-overlay-status', 'соединение…');
  socket.emit('callJoin', { callId: callState.callId });
});

/* ── Дополнительная защита: смена участников группы во время звонка ───── */
socket.on('groupMemberLeft', ({ groupId, userId } = {}) => {
  if (!callState.active || !callState.isGroup || callState.groupId !== groupId) return;
  if (userId && userId !== state.me?.id && callState.peers[userId]) teardownPeer(userId);
});

// Закрытие/перезагрузка вкладки — уведомляем сервер, чтобы собеседник не ждал таймаута
window.addEventListener('pagehide', () => {
  if (callState.active && callState.callId && socket.connected) {
    try { socket.emit('callLeave', { callId: callState.callId }); } catch (e) {}
  }
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

/* ============================================================================
 * DEBUG / INTEROP EXPORTS
 * ==========================================================================*/
Object.assign(window, {
  state, callState, socket, sfx, BACKEND_URL, RTC_CONFIG, MAX_AVATAR_SIZE, ALLOWED_AVATAR_TYPES,
  RAW_AUDIO_CONSTRAINTS, setText, setDisplay, showTransientNotice, authFetch, safeJson, on,
  isAnyModalOpen, updateTitleBadge, closeAllModals, syncVoiceOverlayPosition, hangupCall, toggleMic, toggleCam,
});

/* ── Автоскрытие контролов в видео-режиме + пульс статуса ─────────────── */
let idleTimer = null;
function pokeCallIdle() {
  const overlay = $('call-overlay');
  if (!overlay || !callState.active || !callState.video) return;
  overlay.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => overlay.classList.add('idle'), 3000);
}
['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, pokeCallIdle, { passive: true })
);

// Пульс статуса, пока идёт вызов/соединение
whenDomReady(() => {
  const st = $('call-overlay-status');
  if (!st || !('MutationObserver' in window)) return;
  new MutationObserver(() => {
    const busy = /вызов|соединение|переподключение|ожидание/i.test(st.textContent || '');
    if (busy) st.setAttribute('data-busy', '1'); else st.removeAttribute('data-busy');
  }).observe(st, { childList: true, characterData: true, subtree: true });
});

// UI-функции из средней части файла — экспортируем те, что определены, без падения скрипта
try {
  Object.assign(window, {
    closeActiveChat, openGroupChat, updateGroupVoiceBar, renderGroupsList, showUserProfile, openChat,
    renderFriendsList, renderGroupMembersPanel, closeProfileModal, closeGroupInfoModal, closeAddMembersModal,
    closeCreateGroupModal, refreshGroupItem, openGroupInfoModal, openEditProfileModal, closeEditProfileModal,
    openBlockedUsersModal, closeBlockedUsersModal,
  });
} catch (e) {
  console.warn('[exports] some UI functions are not defined:', e.message);
}