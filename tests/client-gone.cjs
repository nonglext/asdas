'use strict';
// Регрессия 2.0.9: clientGone() не должна считать клиента отключившимся
// только потому, что тело запроса уже прочитано (req.destroyed === true).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const match = source.match(/function clientGone\(req, res\) \{[\s\S]*?\n\}/);

test('clientGone найден в server.js', () => {
  assert.ok(match, 'clientGone not found');
});

test('clientGone не зависит от req.destroyed', () => {
  assert.doesNotMatch(match[0].replace(/\/\/.*$/gm, ''), /req\.destroyed/);
});

test('после чтения тела POST клиент не считается отключившимся', async () => {
  const clientGone = new Function(`${match[0]}; return clientGone;`)();
  const seen = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => setImmediate(() => {
        const gone = clientGone(req, res);
        res.end('ok');
        resolve(gone);
      }));
    }).listen(0, async () => {
      try {
        await fetch(`http://127.0.0.1:${server.address().port}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"a":1}'
        });
      } catch (error) { reject(error); }
      server.close();
    });
  });
  assert.equal(seen, false);
});
