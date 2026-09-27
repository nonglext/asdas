'use strict';

/* ============================================================================
 * calls-plus.js · ChatApp 2.0
 *
 * «Заглушить всех» (deafen), громкость каждого собеседника, индикатор
 * качества связи по WebRTC-статистике, полноэкранный режим звонка и
 * горячие клавиши. Поверх calls.js, без вмешательства в сигналинг.
 * ========================================================================== */

const CPL_VOLUME_KEY = 'chatapp_peer_volume';
const CPL_STATS_MS = 2000;

let cplMicBeforeDeafen = null;
let cplStatsTimer = null;
const cplPrevStats = new Map();
const cplQuality = new Map();

function cplReadVolumes() {
  try {
    const value = JSON.parse(localStorage.getItem(CPL_VOLUME_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function callsPlusVolume(peerId) {
  if (!peerId) return 1;

  const value = Number(cplReadVolumes()[peerId]);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function cplSaveVolume(peerId, value) {
  const volumes = cplReadVolumes();

  if (value >= 0.999) delete volumes[peerId];
  else volumes[peerId] = Math.round(value * 100) / 100;

  try { localStorage.setItem(CPL_VOLUME_KEY, JSON.stringify(volumes)); } catch (_) {}
}

window.callsPlusVolume = callsPlusVolume;

/* ── Deafen ──────────────────────────────────────────────────────────────── */

function cplApplyDeafen() {
  const deafened = !!callState.deafened;

  document.querySelectorAll('#call-video-grid audio.call-tile-audio').forEach(audio => {
    audio.muted = deafened;
  });

  const button = document.getElementById('btn-call-deafen');

  if (button) {
    button.classList.toggle('active-off', deafened);
    button.setAttribute('aria-pressed', String(deafened));
    button.title = deafened ? 'Включить звук (Ctrl+Shift+D)' : 'Заглушить всех (Ctrl+Shift+D)';
    button.setAttribute('aria-label', deafened ? 'Включить звук' : 'Заглушить всех');
    button.disabled = !callState.active;
  }

  document.getElementById('call-overlay')?.classList.toggle('is-deafened', deafened);
}

function cplToggleDeafen() {
  if (!callState.active) return;

  callState.deafened = !callState.deafened;

  const tracks = callState.localStream?.getAudioTracks?.().filter(track => track.readyState === 'live') || [];

  // Как в Discord: заглушив собеседников, вы и сами замолкаете.
  if (callState.deafened) {
    cplMicBeforeDeafen = !!callState.micOn;
    if (callState.micOn && tracks.length && typeof toggleMic === 'function') toggleMic();
  } else if (cplMicBeforeDeafen && !callState.micOn && tracks.length && typeof toggleMic === 'function') {
    toggleMic();
    cplMicBeforeDeafen = null;
  }

  cplApplyDeafen();

  if (typeof showTransientNotice === 'function') {
    showTransientNotice(callState.deafened ? 'Звук собеседников выключен' : 'Звук собеседников включён');
  }
}

function callsPlusReset() {
  cplMicBeforeDeafen = null;
  cplPrevStats.clear();
  cplQuality.clear();
  clearInterval(cplStatsTimer);
  cplStatsTimer = null;

  const chip = document.getElementById('call-quality');
  if (chip) chip.hidden = true;

  document.getElementById('call-overlay')?.classList.remove('is-deafened');
  setTimeout(cplApplyDeafen, 0);
}

window.callsPlusReset = callsPlusReset;

/* ── Тайлы: качество и громкость ─────────────────────────────────────────── */

const CPL_QUALITY_TEXT = {
  good: 'Отличная связь',
  fair: 'Связь нестабильна',
  poor: 'Плохая связь',
};

function cplQualityBars(level) {
  const bars = document.createElement('span');
  bars.className = `q-bars q-${level}`;
  bars.setAttribute('aria-hidden', 'true');
  bars.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  return bars;
}

function cplRenderTileQuality(tile, peerId) {
  const info = cplQuality.get(peerId);
  let badge = tile.querySelector(':scope > .call-tile-quality');

  if (!info) {
    badge?.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'call-tile-quality';
    tile.appendChild(badge);
  }

  const key = `${info.level}:${info.rtt}:${info.loss}`;
  if (badge.dataset.key === key) return;
  badge.dataset.key = key;

  const details = [
    info.rtt != null ? `пинг ${info.rtt} мс` : '',
    info.loss != null ? `потери ${info.loss}%` : '',
    info.relay ? 'через TURN' : '',
  ].filter(Boolean).join(' · ');

  badge.title = `${CPL_QUALITY_TEXT[info.level]}${details ? ` · ${details}` : ''}`;
  badge.setAttribute('aria-label', badge.title);
  badge.replaceChildren(cplQualityBars(info.level));
}

function cplRenderTileVolume(tile, entry) {
  let control = tile.querySelector(':scope > .call-tile-volume');

  if (entry.isLocal || !entry.peerId) {
    control?.remove();
    return;
  }

  if (!control) {
    control = document.createElement('label');
    control.className = 'call-tile-volume';

    const icon = document.createElement('span');
    icon.className = 'call-tile-volume-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>';

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '5';

    range.addEventListener('input', () => {
      const peerId = control.dataset.peerId;
      const value = Number(range.value) / 100;
      const audio = tile.querySelector('audio.call-tile-audio');

      if (audio) audio.volume = value;
      cplSaveVolume(peerId, value);
      control.classList.toggle('is-muted', value === 0);
      range.style.setProperty('--fill', `${range.value}%`);
    });

    ['pointerdown', 'click', 'dblclick'].forEach(type => {
      control.addEventListener(type, event => event.stopPropagation());
    });

    control.append(icon, range);
    tile.appendChild(control);
  }

  const range = control.querySelector('input');
  const value = Math.round(callsPlusVolume(entry.peerId) * 100);

  control.dataset.peerId = entry.peerId;
  range.setAttribute('aria-label', `Громкость: ${entry.nick}`);

  if (document.activeElement !== range) {
    range.value = String(value);
    range.style.setProperty('--fill', `${value}%`);
    control.classList.toggle('is-muted', value === 0);
  }
}

function callsPlusDecorateTile(tile, entry) {
  if (entry.peerId) cplRenderTileQuality(tile, entry.peerId);
  cplRenderTileVolume(tile, entry);
  ensureStatsLoop();
}

window.callsPlusDecorateTile = callsPlusDecorateTile;

/* ── WebRTC-статистика ───────────────────────────────────────────────────── */

function cplLevel(rtt, loss) {
  if ((rtt != null && rtt > 450) || (loss != null && loss > 8)) return 'poor';
  if ((rtt != null && rtt > 220) || (loss != null && loss > 3)) return 'fair';
  return 'good';
}

async function cplSamplePeer(peerId, peer) {
  const pc = peer?.pc;
  if (!pc || pc.connectionState === 'closed' || typeof pc.getStats !== 'function') return null;

  const report = await pc.getStats();
  let rtt = null;
  let received = 0;
  let lost = 0;
  let relay = false;
  const pairs = new Map();
  const candidates = new Map();

  report.forEach(stat => {
    if (stat.type === 'candidate-pair') pairs.set(stat.id, stat);
    if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') candidates.set(stat.id, stat);

    if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
      received += Number(stat.packetsReceived) || 0;
      lost += Math.max(0, Number(stat.packetsLost) || 0);
    }

    if (stat.type === 'remote-inbound-rtp' && Number.isFinite(stat.roundTripTime) && rtt == null) {
      rtt = Math.round(stat.roundTripTime * 1000);
    }
  });

  for (const pair of pairs.values()) {
    const selected = pair.nominated && pair.state === 'succeeded';
    if (!selected) continue;

    if (Number.isFinite(pair.currentRoundTripTime)) rtt = Math.round(pair.currentRoundTripTime * 1000);
    relay = candidates.get(pair.localCandidateId)?.candidateType === 'relay';
    break;
  }

  const previous = cplPrevStats.get(peerId);
  cplPrevStats.set(peerId, { received, lost });

  let loss = null;

  if (previous) {
    const deltaReceived = received - previous.received;
    const deltaLost = lost - previous.lost;
    const total = deltaReceived + deltaLost;
    if (total > 20) loss = Math.round((Math.max(0, deltaLost) / total) * 1000) / 10;
  }

  if (rtt == null && loss == null) return null;

  return { rtt, loss, relay, level: cplLevel(rtt, loss) };
}

async function cplCollectStats() {
  if (!callState.active) {
    callsPlusReset();
    return;
  }

  const peers = Object.entries(callState.peers || {});
  const alive = new Set(peers.map(([id]) => id));

  for (const id of [...cplQuality.keys()]) {
    if (!alive.has(id)) {
      cplQuality.delete(id);
      cplPrevStats.delete(id);
    }
  }

  await Promise.all(peers.map(async ([peerId, peer]) => {
    try {
      const info = await cplSamplePeer(peerId, peer);
      if (info) cplQuality.set(peerId, info);
    } catch (_) {}
  }));

  for (const [peerId] of peers) {
    const tile = typeof findCallTile === 'function' ? findCallTile(`peer:${peerId}`) : null;
    if (tile) cplRenderTileQuality(tile, peerId);
  }

  cplRenderQualityChip();
}

function cplRenderQualityChip() {
  const chip = document.getElementById('call-quality');
  if (!chip) return;

  const values = [...cplQuality.values()];

  if (!values.length) {
    chip.hidden = true;
    return;
  }

  const order = { good: 0, fair: 1, poor: 2 };
  const worst = values.reduce((a, b) => (order[b.level] > order[a.level] ? b : a));
  const rtts = values.map(value => value.rtt).filter(value => value != null);
  const ping = rtts.length ? Math.max(...rtts) : null;

  chip.hidden = false;
  chip.dataset.level = worst.level;
  chip.title = `${CPL_QUALITY_TEXT[worst.level]}${ping != null ? ` · пинг ${ping} мс` : ''}${worst.loss != null ? ` · потери ${worst.loss}%` : ''}`;
  chip.setAttribute('aria-label', chip.title);
  chip.replaceChildren(
    cplQualityBars(worst.level),
    Object.assign(document.createElement('span'), {
      className: 'call-quality-text',
      textContent: ping != null ? `${ping} мс` : CPL_QUALITY_TEXT[worst.level],
    }),
  );
}

function ensureStatsLoop() {
  if (cplStatsTimer || !callState.active) return;

  cplStatsTimer = setInterval(() => {
    void cplCollectStats();
  }, CPL_STATS_MS);
}

/* ── Полноэкранный режим ─────────────────────────────────────────────────── */

function cplSyncFullscreen() {
  const button = document.getElementById('btn-call-fullscreen');
  const overlay = document.getElementById('call-overlay');
  if (!button || !overlay) return;

  const active = document.fullscreenElement === overlay;

  button.setAttribute('aria-pressed', String(active));
  button.title = active ? 'Выйти из полноэкранного режима (F)' : 'Во весь экран (F)';
  button.setAttribute('aria-label', active ? 'Выйти из полноэкранного режима' : 'Во весь экран');
  button.hidden = !document.fullscreenEnabled;
  overlay.classList.toggle('is-fullscreen', active);
}

async function cplToggleFullscreen() {
  const overlay = document.getElementById('call-overlay');
  if (!overlay || !callState.active || !document.fullscreenEnabled) return;

  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await overlay.requestFullscreen();
  } catch (_) {
    if (typeof showTransientNotice === 'function') showTransientNotice('Полноэкранный режим недоступен');
  }
}

document.addEventListener('fullscreenchange', cplSyncFullscreen);

/* ── Кнопки и клавиши ────────────────────────────────────────────────────── */

on('btn-call-deafen', 'click', cplToggleDeafen);
on('btn-call-fullscreen', 'click', () => void cplToggleFullscreen());

document.addEventListener('keydown', event => {
  if (event.repeat || !callState.active) return;

  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  const typing = event.target instanceof Element &&
    event.target.closest('input, textarea, select, [contenteditable="true"]');

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (key === 'd' || event.code === 'KeyD')) {
    event.preventDefault();
    cplToggleDeafen();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (key === 'e' || event.code === 'KeyE')) {
    event.preventDefault();
    if (typeof toggleCam === 'function') toggleCam();
    return;
  }

  if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && (key === 'f' || event.code === 'KeyF')) {
    const overlay = document.getElementById('call-overlay');
    if (overlay && overlay.style.display !== 'none' && !overlay.classList.contains('detached')) {
      event.preventDefault();
      void cplToggleFullscreen();
    }
  }
});

whenDomReady(() => {
  cplApplyDeafen();
  cplSyncFullscreen();

  const overlay = document.getElementById('call-overlay');

  if (overlay && 'MutationObserver' in window) {
    new MutationObserver(() => {
      cplApplyDeafen();
      cplSyncFullscreen();
      if (callState.active) ensureStatsLoop();
    }).observe(overlay, { attributes: true, attributeFilter: ['style', 'class'] });
  }
});
