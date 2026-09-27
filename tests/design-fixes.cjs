'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('settings search is connected to the navigation and has a no-results state', () => {
  const html = read('public/index.html');
  const js = read('public/js/settings.js');
  assert.match(html, /id="settings-search-input"/);
  assert.match(html, /id="settings-search-empty"/);
  assert.match(js, /settingsSearch\?\.addEventListener\('input'/);
  assert.match(js, /item\.hidden = Boolean\(query\)/);
});

test('mobile settings retain their section navigation', () => {
  const css = read('public/css/theme.css');
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.settings-sidebar \{ display: flex;/);
  assert.match(css, /\.settings-nav \{ display: flex; gap: 4px; overflow-x: auto;/);
  assert.match(css, /\.settings-nav \[hidden\][\s\S]*?display: none !important/);
});

test('touch actions are usable and narrow screens retain audio calls', () => {
  const css = read('public/css/theme.css');
  const mobile = read('public/css/style.css');
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?\.msg-action[\s\S]*?min-width: 44px; min-height: 44px;/);
  assert.doesNotMatch(mobile, /\.chat-head-actions \.icon-btn:not\(:last-child\) \{ display: none;/);
});

test('voice threshold explanation matches its scale', () => {
  const html = read('public/index.html');
  assert.match(html, /Ближе к −60 dB индикатор загорается от тихого голоса/);
});

test('configured database pool size is respected', () => {
  const db = read('server/database.js');
  assert.match(db, /max: intEnv\('DATABASE_POOL_MAX', 20, 1, 100\)/);
});

test('Render proxy configuration accepts one explicit hop, not true', () => {
  const server = read('server.js');
  assert.match(server, /app\.set\('trust proxy', hops\)/);
  assert.match(server, /Set TRUST_PROXY=1 on Render/);
  assert.match(server, /trustProxyRaw === 'true'/);
});
