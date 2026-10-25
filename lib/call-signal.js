'use strict';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value, max) => value == null || (typeof value === 'string' && value.length <= max);

// Validate before relaying: room membership alone does not make a payload safe.
function validCallSignal(data) {
  if (!record(data)) return false;
  if (data.type === 'offer' || data.type === 'answer') {
    return record(data.sdp) && data.sdp.type === data.type &&
      typeof data.sdp.sdp === 'string' && data.sdp.sdp.length > 0 &&
      Buffer.byteLength(data.sdp.sdp) <= 60_000;
  }
  if (data.type === 'ice') {
    const candidate = data.candidate;
    return record(candidate) && typeof candidate.candidate === 'string' &&
      candidate.candidate.length <= 16_384 &&
      optionalString(candidate.sdpMid, 256) &&
      optionalString(candidate.usernameFragment, 256) &&
      (candidate.sdpMLineIndex == null ||
        (Number.isInteger(candidate.sdpMLineIndex) && candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex <= 65535));
  }
  if (data.type === 'state') {
    return ['micOn', 'camOn', 'screenOn'].every(key => typeof data[key] === 'boolean');
  }
  return false;
}

module.exports = { validCallSignal };
