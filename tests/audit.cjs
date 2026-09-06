'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = (() => { try { return require('node:util'); } catch { return {}; } })();
const root = path.resolve(__dirname, '..');
test('group voice markup is conditional on a live callId', () => {
  const source = fs.readFileSync(path.join(root, 'public/js/chat-ui.js'), 'utf8');
  assert.match(source, /const voice = state\.groupVoiceCalls\[id\];/);
  assert.match(source, /voice\?\.callId/);
  assert.doesNotMatch(source, /state\.groupVoiceCalls\[id\] \|\| \{ callId: null/);
});
test('only the final reference stylesheet is shipped and cache versions agree', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.doesNotMatch(html, /discord-refactor\.css/);
  assert.match(html, /discord-reference\.css\?v=1\.6\.0/);
  assert.doesNotMatch(html, /discord-[0-9]+/);
  assert.equal(fs.existsSync(path.join(root, 'public/css/discord-refactor.css')), false);
});
test('package and VERSION agree', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim());
  assert.equal(pkg.version, '1.6.0');
});
