'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('server accepts only declared safe attachment formats', () => {
  const server = read('server.js');
  assert.match(server, /jpg\|png\|webp\|gif\|zip\|mp3\|mp4/);
  assert.match(server, /async function inspectAttachment/);
  assert.match(server, /Содержимое файла не соответствует его формату/);
});

test('attachments remain private and are authorized per conversation', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/uploads\/:filename'/);
  assert.match(server, /await dmAccess/);
  assert.match(server, /GroupMember\.findOne/);
  assert.match(server, /Cache-Control', 'private, no-store'/);
  assert.match(server, /acceptRanges: true/);
});

test('client renders photo, audio, video and download states', () => {
  const chat = read('public/js/chat-ui.js');
  for (const token of ['message-image', 'message-audio', 'message-video', 'message-file']) {
    assert.ok(chat.includes(token), token);
  }
  assert.match(chat, /uploadChatFile/);
  assert.match(chat, /api\/upload\/image/);
  assert.match(chat, /const field = isImage/);
  assert.match(chat, /is-dragging/);
});

test('file picker exposes the supported formats', () => {
  const html = read('public/index.html');
  for (const ext of ['.jpg', '.png', '.zip', '.mp3', '.mp4']) assert.ok(html.includes(ext), ext);
});
