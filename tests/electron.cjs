'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('Electron uses isolated preload and a local server process', () => {
  const main = read('electron/main.cjs');
  const preload = read('electron/preload.cjs');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.doesNotMatch(main, /fork\(/);
  assert.match(main, /asdas-p7ht\.onrender\.com/);
  assert.doesNotMatch(preload, /electron-titlebar/);
  assert.match(main, /frame: true/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setDisplayMediaRequestHandler/);
  assert.match(main, /request\.securityOrigin/);
  assert.match(main, /callback\(null\)/);
  assert.doesNotMatch(main, /request\.webContents/);
  assert.doesNotMatch(main, /callback\(\{\}\)/);
  assert.match(main, /mainWindow\.on\('close'/);
});
test('Electron package commands and desktop docs exist', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, 'electron/main.cjs');
  assert.equal(pkg.scripts.electron, 'electron .');
  assert.ok(pkg.devDependencies.electron);
  assert.match(read('ELECTRON.md'), /npm run electron/);
  assert.match(read('ELECTRON.md'), /локальный сервер.*не запускаются/);
});


test('screen sharing uses a floating overlay so the chat remains usable', () => {
  const calls = read('public/js/calls.js');
  const css = read('public/css/calls-responsive.css');
  assert.match(calls, /screen-share-mini/);
  assert.match(css, /\.call-overlay\.screen-share-mini:not\(\.detached\)/);
  assert.match(css, /inset: var\(--call-top/);
  assert.match(css, /background: oklch\(12%/);
  assert.match(css, /grid-template-rows: minmax\(0, 1fr\)/);
});


test('Electron provides a sandboxed source picker and safe display chooser', () => {
  const main = read('electron/main.cjs');
  const picker = read('electron/picker-preload.cjs');
  const html = read('electron/source-picker.html');
  assert.match(main, /desktopCapturer\.getSources/);
  assert.match(main, /openSourcePicker/);
  assert.match(main, /callback\(null\)/);
  assert.match(main, /modal: true/);
  assert.match(main, /picker-preload\.cjs/);
  assert.match(picker, /contextBridge\.exposeInMainWorld/);
  assert.match(html, /sourcePicker\.select/);
  assert.match(html, /Escape/);
});

test('security and call controls are present', () => {
  const server = read('server.js');
  const calls = read('public/js/calls.js');
  const css = read('public/css/calls-responsive.css');
  const pkg = JSON.parse(read('package.json'));
  assert.match(server, /Permissions-Policy/);
  assert.match(server, /registerIpRate/);
  assert.deepEqual(pkg.overrides.qs, '^6.16.0');
  assert.equal(pkg.overrides.uuid, '11.1.1');
  assert.doesNotMatch(calls, /btn-call-raise-hand/);
  assert.doesNotMatch(read('public/index.html'), /Поднять руку|btn-call-raise-hand/);
  assert.match(calls, /getByteFrequencyData/);
  assert.match(calls, /setInterval\(tick, 100\)/);
  assert.match(css, /\.call-tile\.is-speaking/);
});
