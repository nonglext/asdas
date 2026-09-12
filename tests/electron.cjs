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
