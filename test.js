'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { friendAction } = require('./lib/friend-policy');
const user = (id, extra={}) => ({id, friends:[], friendRequests:[], blockedUsers:[], ...extra});
for (const [name, me, other, expected] of [
 ['new request',user('alice'),user('bob'),'request'],
 ['repeat request is idempotent',user('alice'),user('bob',{friendRequests:['alice']}),'pending'],
 ['crossed requests become friendship',user('alice',{friendRequests:['bob']}),user('bob'),'accept'],
 ['both pending requests become friendship',user('alice',{friendRequests:['bob']}),user('bob',{friendRequests:['alice']}),'accept'],
 ['existing friendship is success',user('alice',{friends:['bob']}),user('bob',{friends:['alice']}),'friends'],
 ['self request rejected',user('alice'),user('alice'),'self'],
 ['missing target rejected',user('alice'),null,'not_found'],
 ['target block hides account',user('alice'),user('bob',{blockedUsers:['alice']}),'not_found'],
 ['own block honored',user('alice',{blockedUsers:['bob']}),user('bob'),'blocked'],
 ['friend limit honored',user('alice',{friends:Array(500).fill('x')}),user('bob'),'limit_reached'],
 ['pending limit honored',user('alice'),user('bob',{friendRequests:Array(200).fill('x')}),'target_limit_reached'],
]) test(name,()=>{const result=friendAction(me,other); assert.equal(result.reason||result.action,expected)});
test('policy does not mutate accounts',()=>{const me=user('alice'),other=user('bob'); const before=JSON.stringify([me,other]);friendAction(me,other);assert.equal(JSON.stringify([me,other]),before)});
const server=fs.readFileSync(__dirname+'/server.js','utf8');
const eventCode=server.slice(server.indexOf('function installEvent('),server.indexOf('async function sendMessage('));
class ApiError extends Error {constructor(status,message,reason='bad_request'){super(message);this.status=status;this.reason=reason}}
function harness(opts={}) {
 const pendingEvents=new Map(), errors=[], handlers={};
 const socket={ user:user('alice'),connected:true,authToken:'test',on:(e,fn)=>handlers[e]=fn,disconnect(){this.connected=false} };
 const sandbox={ApiError,record:x=>!!x&&typeof x==='object'&&!Array.isArray(x),idOK:x=>typeof x==='string'&&/^[a-z0-9_]{3,30}$/.test(x),uuidOK:x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x),socketError:(...args)=>errors.push(args.at(-1)),pendingEvents,eventLimit:()=>opts.limit!==false,serial:fn=>Promise.resolve().then(fn),verifyToken:async()=>opts.auth===false?null:{user:user('alice')},socket,handler:opts.handler|| (async()=>({status:'pending'}))};
 vm.runInNewContext(eventCode+";installEvent(socket,'sendFriendRequest','userId',handler)",sandbox);
 return {socket,pendingEvents,errors,run:(...args)=>handlers.sendFriendRequest(...args)};
}
test('socket acknowledgement confirms handler completion',async()=>{const h=harness();const value=await new Promise(r=>h.run('bob',r));assert.equal(value.ok,true);assert.equal(value.status,'pending');await new Promise(setImmediate);assert.equal(h.pendingEvents.size,0)});
test('socket validates payload and acknowledges rejection',async()=>{const h=harness();const value=await new Promise(r=>h.run({id:'bob'},r));assert.equal(value.ok,false);assert.equal(value.reason,'bad_request');assert.equal(h.pendingEvents.size,0)});
test('rate limit acknowledges failure instead of timing out',async()=>{const h=harness({limit:false});const value=await new Promise(r=>h.run('bob',r));assert.equal(value.reason,'rate_limited')});
test('database failure is acknowledged without leaking details',async()=>{const h=harness({handler:async()=>{throw new Error('secret database url')}});const value=await new Promise(r=>h.run('bob',r));assert.equal(value.reason,'server_error');assert.ok(!value.error.includes('secret'));await new Promise(setImmediate);assert.equal(h.pendingEvents.size,0)});
test('expired session receives an explicit error',async()=>{const h=harness({auth:false});const value=await new Promise(r=>h.run('bob',r));assert.equal(value.reason,'unauthorized');assert.equal(h.socket.connected,false)});
test('legacy clients without acknowledgements remain supported',async()=>{const h=harness();h.run('bob');await new Promise(setImmediate);assert.equal(h.errors.length,0);assert.equal(h.pendingEvents.size,0)});
test('inline script execution disabled by CSP',()=>{const html=fs.readFileSync(__dirname+'/public/index.html','utf8').replace(/<!--[\s\S]*?-->/g,'');assert.doesNotMatch(html,/<script\s*>|\sonclick=/);assert.match(server,/scriptSrcAttr: \["'none'"\]/)});
test('all local script and stylesheet references resolve',()=>{const html=fs.readFileSync(__dirname+'/public/index.html','utf8').replace(/<!--[\s\S]*?-->/g,'');for(const match of html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"?]+)"/g))assert.ok(fs.existsSync(__dirname+'/public'+match[1]),match[1])});
