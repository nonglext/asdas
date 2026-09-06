'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('group voice markup is conditional on a live callId',()=>{
 const source=read('public/js/chat-ui.js');
 assert.match(source,/const voice = state\.groupVoiceCalls\[id\];/);assert.match(source,/voice\?\.callId/);
 assert.doesNotMatch(source,/state\.groupVoiceCalls\[id\] \|\| \{ callId: null/);
});
test('product stylesheet is the final active layer and cache versions agree',()=>{
 const html=read('public/index.html'),version=JSON.parse(read('package.json')).version;
 assert.doesNotMatch(html,/discord-refactor\.css|discord-reference\.css|refined\.css/);
 const links=[...html.matchAll(/href="(\/css\/[^\"]+)"/g)].map(m=>m[1]);
 assert.equal(links.at(-1),`/css/product.css?v=${version}`);
 for(const m of html.matchAll(/(?:href|src)="\/(?:css|js)\/[^"?]+\?v=([^"&]+)/g))assert.equal(m[1],version);
 assert.ok(html.indexOf('/js/product-ui.js')>html.indexOf('/js/calls.js'));
 assert.equal(fs.existsSync(path.join(root,'public/css/product.css')),true);
});
test('package and VERSION agree',()=>{
 const pkg=JSON.parse(read('package.json'));assert.equal(pkg.version,read('VERSION').trim());
});
