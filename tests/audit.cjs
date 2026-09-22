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
  assert.match(html, /theme\.css\?v=\d+\.\d+\.\d+/);
  for (const gone of ['refined.css', 'discord-reference.css', 'discord-refactor.css']) {
    assert.doesNotMatch(html, new RegExp(gone.replace('.', '\\.')), gone + ' still linked');
    assert.equal(fs.existsSync(path.join(root, 'public/css', gone)), false, gone + ' still present');
  }
  const sheets = [...html.matchAll(/href="\/css\/([^"?]+)/g)].map(m => m[1]);
  assert.deepEqual(sheets, ['base.css', 'layout.css', 'chat.css', 'calls-responsive.css', 'style.css', 'theme.css']);
});
test('package, VERSION and asset cache-busting all agree', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim());

  // Hard-coding the number here meant every release broke this test for no
  // reason. What actually matters is that no asset keeps a stale ?v= tag,
  // because a half-updated cache is what breaks clients after a deploy.
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const tags = [...html.matchAll(/(?:href|src)="\/(?:css|js)\/[^"?]+\?v=([^"]+)"/g)].map(m => m[1]);

  assert.ok(tags.length > 0, 'expected versioned asset links in index.html');
  assert.deepEqual([...new Set(tags)], [pkg.version]);
});

test('voice threshold setting is wired to the speaking indicator', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'public/js/settings.js'), 'utf8');
  const calls = fs.readFileSync(path.join(root, 'public/js/calls.js'), 'utf8');
  assert.match(html, /data-settings-section=\"voice\"/);
  assert.match(html, /id=\"voice-threshold\"/);
  assert.match(settings, /saveVoiceSpeakingThresholdDb/);
  assert.match(calls, /getVoiceSpeakingThresholdDb/);
});

test('every data-action in index.html has a handler', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public/js/document-actions.js'), 'utf8');
  for (const [, name] of html.matchAll(/data-action="([^"]+)"/g)) {
    assert.ok(js.includes(`[data-action="${name}"]`), `нет обработчика для data-action="${name}"`);
  }
});
test('Render trusts one proxy hop without disabling rate limiter validation', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(server, /process\.env\.RENDER === 'true'/);
  assert.match(server, /app\.set\('trust proxy', 1\)/);
  assert.match(server, /app\.set\('trust proxy', Number\(trustProxyRaw\)\)/);
  assert.match(render, /key: TRUST_PROXY\s+value: "1"/);
  assert.doesNotMatch(server, /skip:\s*\(req,\s*res\)/);
});
