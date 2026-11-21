'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { validCallSignal } = require('../lib/call-signal');
const root = path.resolve(__dirname, '..');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
test('signaling accepts WebRTC descriptions, ICE and typed media state only', () => {
  for (const type of ['offer', 'answer']) {
    assert.equal(validCallSignal({ type, sdp: { type, sdp: 'v=0\r\n' } }), true);
    assert.equal(validCallSignal({ type, sdp: { type: 'rollback', sdp: 'v=0' } }), false);
    assert.equal(validCallSignal({ type, sdp: { type, sdp: 'я'.repeat(31_000) } }), false);
  }
  assert.equal(validCallSignal({ type: 'ice', candidate: { candidate: '', sdpMLineIndex: 0 } }), true);
  for (const candidate of [{ candidate: 'x', sdpMid: {} }, { candidate: 'x', sdpMLineIndex: -1 }, { candidate: 'x', sdpMLineIndex: 0.5 }]) {
    assert.equal(validCallSignal({ type: 'ice', candidate }), false);
  }
  assert.equal(validCallSignal({ type: 'state', micOn: true, camOn: false, screenOn: false }), true);
  for (const data of [null, [], { type: 'unknown' }, { type: 'state', micOn: 'false' }]) assert.equal(validCallSignal(data), false);
});
test('authentication cache expires idle users and stays bounded', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cache = new Map();
  const context = vm.createContext({
    tokenUserCache: cache,
    TOKEN_USER_CACHE_LIMIT: 2,
    TOKEN_USER_CACHE_TTL: 30_000,
    Date,
  });
  for (const name of ['pruneUserCache', 'cacheVerifiedUser']) {
    vm.runInContext(extract(source, name), context);
  }
  context.cacheVerifiedUser({ id: 'alice' }, 1000);
  context.cacheVerifiedUser({ id: 'bob' }, 2000);
  context.cacheVerifiedUser({ id: 'carol' }, 3000);
  assert.equal(cache.size, 2);
  assert.equal(cache.has('alice'), false);
  context.cacheVerifiedUser({ id: 'bob', tokenVersion: 2 }, 4000);
  assert.equal(cache.get('bob').user.tokenVersion, 2);
  context.pruneUserCache(33_000);
  assert.equal(cache.has('carol'), false);
  assert.equal(cache.has('bob'), true);
  context.pruneUserCache(34_000);
  assert.equal(cache.size, 0);
});
test('voice defaults tolerate absent, corrupted and inaccessible preferences', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/core.js'), 'utf8');
  let raw = null;
  const ctx = vm.createContext({ localStorage: { getItem: () => raw }, DEFAULT_VOICE_THRESHOLD_DB: -48, VOICE_THRESHOLD_STORAGE_KEY: 'threshold', VOICE_PROCESSING_KEY: 'processing', RAW_AUDIO_CONSTRAINTS: { echoCancellation: false } });
  for (const name of ['getVoiceSpeakingThresholdDb', 'voiceProcessingEnabled', 'getCallAudioConstraints']) vm.runInContext(extract(source, name), ctx);
  for (const value of [null, '', ' ', 'invalid']) { raw = value; assert.equal(ctx.getVoiceSpeakingThresholdDb(), -48); }
  raw = '-54'; assert.equal(ctx.getVoiceSpeakingThresholdDb(), -54);
  raw = null; assert.equal(ctx.getCallAudioConstraints().echoCancellation, false);
  raw = 'true'; assert.equal(ctx.getCallAudioConstraints().echoCancellation, true);
  raw = 'false'; assert.equal(ctx.getCallAudioConstraints().echoCancellation, false);
  ctx.localStorage.getItem = () => { throw new Error('blocked'); };
  assert.equal(ctx.getVoiceSpeakingThresholdDb(), -48);
  assert.equal(ctx.getCallAudioConstraints().echoCancellation, false);
});
test('deafened users cannot accidentally transmit microphone audio', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/calls.js'), 'utf8');
  const track = { enabled: false };
  const callState = { active: true, deafened: true, micOn: false, localStream: { getAudioTracks: () => [track] } };
  const ctx = vm.createContext({ callState, isLiveTrack: () => true, showTransientNotice() {}, resetCallControls() {}, renderCallGrid() {}, broadcastMediaState() {} });
  vm.runInContext(extract(source, 'toggleMic'), ctx);
  ctx.toggleMic(); assert.equal(track.enabled, false); assert.equal(callState.micOn, false);
  callState.deafened = false; ctx.toggleMic(); assert.equal(track.enabled, true);
});
test('quality sampling discards a report from a removed peer', async () => {
  const source = fs.readFileSync(path.join(root, 'public/js/calls-plus.js'), 'utf8');
  let finish;
  const peer = { pc: { connectionState: 'connected', getStats: () => new Promise(resolve => { finish = resolve; }) } };
  const callState = { active: true, peers: { bob: peer } };
  const ctx = vm.createContext({ callState, cplPrevStats: new Map() });
  vm.runInContext('async ' + extract(source, 'cplSamplePeer'), ctx);
  const pending = ctx.cplSamplePeer('bob', peer);
  delete callState.peers.bob;
  finish(new Map());
  assert.equal(await pending, null);
  assert.equal(ctx.cplPrevStats.size, 0);
});
test('deafen mutes microphone intent even while its device is unavailable', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/calls-plus.js'), 'utf8');
  const callState = { active: true, micOn: true, deafened: false, localStream: { getAudioTracks: () => [] } };
  const ctx = vm.createContext({ callState, cplMicBeforeDeafen: null, resetCallControls() {}, renderCallGrid() {}, broadcastMediaState() {}, cplApplyDeafen() {}, showTransientNotice() {} });
  vm.runInContext(extract(source, 'cplToggleDeafen'), ctx);
  ctx.cplToggleDeafen(); assert.equal(callState.micOn, false);
  ctx.cplToggleDeafen(); assert.equal(callState.micOn, true);
  callState.micOn = false;
  ctx.cplToggleDeafen(); ctx.cplToggleDeafen(); assert.equal(callState.micOn, false);
});
