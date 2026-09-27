'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('settings gear and accessible theme dialog are present', () => {
  const html = read('public/index.html');
  assert.match(html, /id="btn-settings"/);
  assert.match(html, /id="settings-modal" role="dialog"/);
  assert.match(html, /name="app-theme" type="radio" value="gray"/);
  assert.match(html, /name="app-theme" type="radio" value="white"/);
});

test('theme is restored before the interface paints', () => {
  const guard = read('public/js/runtime-guard.js');
  assert.match(guard, /chatapp_theme/);
  assert.match(guard, /document\.documentElement\.dataset\.theme/);
});

test('gray and white themes have explicit visual states', () => {
  const css = read('public/css/theme.css');
  assert.match(css, /:root\[data-theme="gray"\]/);
  assert.match(css, /:has\(input:checked\)/);
  assert.match(css, /\.preview-gray/);
  assert.match(css, /\.preview-white/);
});
