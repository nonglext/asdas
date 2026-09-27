'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('password settings use the existing secure backend route', () => {
  const js = read('public/js/settings.js');
  const html = read('public/index.html');
  assert.match(js, /api\/password\/change/);
  assert.match(js, /currentPassword, newPassword/);
  assert.match(js, /newPassword !== confirmPassword/);
  assert.match(html, /id="current-password"/);
  assert.match(html, /id="new-password"/);
  assert.match(html, /id="confirm-password"/);
});
test('account page has no placeholder edit buttons', () => {
  const html = read('public/index.html');
  const panel = html.slice(html.indexOf('data-settings-panel="account"'), html.indexOf('data-settings-panel="security"'));
  assert.doesNotMatch(panel, />Изменить</);
});
