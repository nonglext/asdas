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
  openCallOverlay(groupId ? 'соединение…' : 'вызов…');

  if (!groupId) {
    sfx.startRing(true);
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
  sfx.join();
}

function hangupCall() {
  if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
  sfx.leave();
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
  sfx.stopRing();

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
      sfx.stopRing();
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

function toggleMic() {
  if (!callState.localStream) return;
  callState.micOn = !callState.micOn;
  callState.localStream.getAudioTracks().forEach(t => { t.enabled = callState.micOn; });
  const micButton = $('btn-call-toggle-mic');
  if (micButton) {
    micButton.classList.toggle('active-off', !callState.micOn);
    micButton.title = callState.micOn ? 'Выключить микрофон' : 'Включить микрофон';
    micButton.setAttribute('aria-label', micButton.title);
  }
  showTransientNotice(callState.micOn ? 'Микрофон включён' : 'Микрофон выключен');
  renderCallGrid();
}
on('btn-call-toggle-mic', 'click', toggleMic);

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

// Ctrl+Shift+M — мьют микрофона во время звонка (как в Discord)
document.addEventListener('keydown', e => {
  if (callState.active && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleMic();
  }
});

/* ── Incoming call UI ──────────────────────────────────────────────────── */
function dismissIncomingCall() {
  clearTimeout(callState.incomingTimer);
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
  const avatarUrl = info.isGroup ? null : (state.friends[info.from]?.avatar || null);
  if (info.isGroup) renderGroupAv($('incoming-call-avatar'), state.groups[info.groupId]);
  else renderAv($('incoming-call-avatar'), nick, avatarUrl);
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
  if (!info) return;
  setDisplay('incoming-call-modal', 'none');
  sfx.stopRing();

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
  sfx.stopRing();
  sfx.join();
  // Offer пришлёт сам вошедший — только готовим соединение и плитку
  createPeerConnection(peerId);
  setText('call-overlay-status', 'соединение…');
  renderCallGrid();
});

socket.on('callPeerLeft', ({ callId, peerId } = {}) => {
  if (!callState.active || callId !== callState.callId || !peerId) return;
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

Object.assign(window, { state, callState, socket, sfx, BACKEND_URL, RTC_CONFIG, MAX_AVATAR_SIZE, ALLOWED_AVATAR_TYPES, RAW_AUDIO_CONSTRAINTS, setText, setDisplay, showTransientNotice, authFetch, safeJson, on, closeActiveChat, isAnyModalOpen, openGroupChat, updateGroupVoiceBar, renderGroupsList, showUserProfile, openChat, renderFriendsList, renderGroupMembersPanel, updateTitleBadge, closeProfileModal, closeGroupInfoModal, closeAddMembersModal, closeCreateGroupModal, refreshGroupItem, openGroupInfoModal, closeAllModals, openEditProfileModal, closeEditProfileModal, openBlockedUsersModal, closeBlockedUsersModal });
