
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['server.js', ...['public/js', 'lib'].flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => dir + '/' + f))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked: ${files.length} files`);
