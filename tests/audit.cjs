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
test('exactly one presentation layer is shipped, with no competing override sheets', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /theme\.css\?v=1\.7\.0/);
  for (const gone of ['refined.css', 'discord-reference.css', 'discord-refactor.css']) {
    assert.doesNotMatch(html, new RegExp(gone.replace('.', '\\.')), gone + ' still linked');
    assert.equal(fs.existsSync(path.join(root, 'public/css', gone)), false, gone + ' still present');
  }
  const sheets = [...html.matchAll(/href="\/css\/([^"?]+)/g)].map(m => m[1]);
  assert.deepEqual(sheets, ['base.css', 'layout.css', 'chat.css', 'calls-responsive.css', 'style.css', 'theme.css']);
});
test('package and VERSION agree', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim());
  assert.equal(pkg.version, '1.7.0');
});
