'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const core=read('public/js/core.js');
const storageCode=core.slice(core.indexOf('const storage ='),core.indexOf('const MAX_MESSAGE_LENGTH'));
function storageHarness(){
 const disk=new Map();let failRead=false,failWrite=false,failRemove=false;
 const ctx={window:{localStorage:{getItem:k=>{if(failRead)throw Error('read');return disk.get(k)??null},setItem:(k,v)=>{if(failWrite)throw Error('quota');disk.set(k,v)},removeItem:k=>{if(failRemove)throw Error('denied');disk.delete(k)}}}};
 vm.runInNewContext(storageCode+';globalThis.store=storage;',ctx);
 return{store:ctx.store,disk,readFails:v=>failRead=v,writeFails:v=>failWrite=v,removeFails:v=>failRemove=v};
}
test('storage: failed writes win over stale readable localStorage',()=>{const h=storageHarness();h.disk.set('token','old');h.writeFails(true);h.store.setItem('token','new');assert.equal(h.store.getItem('token'),'new')});
test('storage: failed removal does not resurrect an old token in this session',()=>{const h=storageHarness();h.disk.set('token','old');h.removeFails(true);h.store.removeItem('token');assert.equal(h.store.getItem('token'),null)});
test('storage: successful reads warm the fallback cache',()=>{const h=storageHarness();h.disk.set('token','value');assert.equal(h.store.getItem('token'),'value');h.readFails(true);assert.equal(h.store.getItem('token'),'value')});
test('storage: healthy reads reflect changes made by another tab',()=>{const h=storageHarness();h.store.setItem('key','one');h.disk.set('key','two');assert.equal(h.store.getItem('key'),'two')});
test('storage: successful later write clears a failed-write tombstone',()=>{const h=storageHarness();h.writeFails(true);h.store.setItem('key','one');h.writeFails(false);h.store.setItem('key','two');h.disk.set('key','three');assert.equal(h.store.getItem('key'),'three');assert.equal(h.store.pending.size,0)});
const fetchCode=core.slice(core.indexOf('async function authFetch('),core.indexOf('function saveAndLogin('));
function fetchHarness(){
 const calls=[];const ctx={URL,Headers,AbortController,setTimeout,clearTimeout,TypeError,Error,BACKEND_URL:'https://chat.example',FETCH_TIMEOUT_MS:1000,storage:{getItem:()=> 'secret-token'},state:{me:{id:'alice'}},AuthError:class extends Error{},forceLogoutToLogin:()=>{ctx.loggedOut=true},fetch:async(...args)=>{calls.push(args);return{status:200}}};
 vm.runInNewContext(fetchCode+';globalThis.run=authFetch;',ctx);return{ctx,calls};
}
test('authorized fetch: Headers objects keep custom headers',async()=>{const{ctx,calls}=fetchHarness();await ctx.run('/api/me',{headers:new Headers({'X-Request-Test':'kept'})});assert.equal(calls[0][1].headers.get('X-Request-Test'),'kept');assert.equal(calls[0][1].headers.get('Authorization'),'Bearer secret-token')});
test('authorized fetch: tuple header arrays are supported',async()=>{const{ctx,calls}=fetchHarness();await ctx.run('/api/me',{headers:[['Content-Type','application/json']]});assert.equal(calls[0][1].headers.get('Content-Type'),'application/json')});
test('authorized fetch: credentials are not sent to another origin',async()=>{const{ctx,calls}=fetchHarness();await assert.rejects(()=>ctx.run('https://other.example/api/me'),/серверу приложения/);assert.equal(calls.length,0)});
test('authorized fetch: protocol-relative foreign URLs are rejected',async()=>{const{ctx,calls}=fetchHarness();await assert.rejects(()=>ctx.run('//other.example/api/me'));assert.equal(calls.length,0)});
test('authorized fetch: expired sessions still trigger logout',async()=>{const{ctx}=fetchHarness();ctx.fetch=async()=>({status:401});await assert.rejects(()=>ctx.run('/api/me'));assert.equal(ctx.loggedOut,true)});
function runtimeHarness(running=true){
 const events={}, nodes=new Map(), removed=[];
 function element(){return{children:[],setAttribute(){},addEventListener(){},append(...x){this.children.push(...x)},appendChild(x){this.children.push(x);nodes.set(x.id,x)},remove(){nodes.delete(this.id)}}}
 const app={classList:{contains:()=>running}};nodes.set('app-screen',app);nodes.set('auth-error',{textContent:''});
 const ctx={HTMLScriptElement:class{},window:{addEventListener:(name,fn)=>events[name]=fn},document:{readyState:'complete',documentElement:{classList:{remove:x=>removed.push(x)}},getElementById:id=>nodes.get(id),createElement:element,body:element()}};
 vm.runInNewContext(read('public/js/runtime-guard.js'),ctx);return{events,nodes,removed,ctx};
}
test('runtime guard: an exception in chat does not expose login or clear session',()=>{const h=runtimeHarness();h.events.error({message:'boom'});assert.deepEqual(h.removed,[]);assert.ok(h.nodes.has('runtime-notice'))});
test('runtime guard: repeated errors produce one notice',()=>{const h=runtimeHarness();h.events.error({message:'one'});h.events.error({message:'two'});assert.equal(h.ctx.document.body.children.length,1)});
test('runtime guard: boot failure restores a visible error at login',()=>{const h=runtimeHarness(false);h.events.error({message:'boot failed'});assert.deepEqual(h.removed,['has-session']);assert.match(h.nodes.get('auth-error').textContent,/Не удалось загрузить/)});
test('runtime guard: a failed image and an expected abort do not report a crash',()=>{const h=runtimeHarness();h.events.error({target:{}});h.events.unhandledrejection({reason:{name:'AbortError'}});assert.equal(h.ctx.document.body.children.length,0)});
test('runtime guard: unhandled promise failures are reported',()=>{const h=runtimeHarness();h.events.unhandledrejection({reason:Error('bad')});assert.ok(h.nodes.has('runtime-notice'))});
test('avatar fallback: a failed image preserves the presence indicator',()=>{
 const code=core.slice(core.indexOf('function renderAv('),core.indexOf('/** Аватар +'));
 const children=[],el={children,appendChild(x){x.parentNode=this;children.push(x)}};let image;
 const ctx={document:{createElement:()=>image={replaceWith(node){children.splice(children.indexOf(this),1,node)}},createTextNode:text=>({text})},avatarSrc:x=>x,av:()=> 'AB'};
 vm.runInNewContext(code+';globalThis.render=renderAv;',ctx);ctx.render(el,'Alice','/bad.webp');const dot={className:'f-dot'};children.push(dot);image.onerror();assert.equal(children[0].text,'AB');assert.equal(children[1],dot);
});
test('UI: message profile controls support keyboard activation',()=>{const t=read('public/js/chat-ui.js');assert.match(t,/avEl\.tabIndex = 0/);assert.match(t,/nickEl\.tabIndex = 0/);assert.match(t,/nickEl\.addEventListener\('keydown'/)});
test('UI: IME confirmation does not activate search results',()=>{assert.match(read('public/js/auth-ui.js'),/on\('search-input', 'keydown', e => \{\s*if \(e\.isComposing\) return/)});
const theme=read('public/css/theme.css');
test('UI: theme keeps offline and online status visually distinct',()=>{
 assert.match(theme,/\.chat-head-status \{[^}]*color: var\(--text3\)/);
 assert.match(theme,/\.chat-head-status\.on \{[^}]*color: var\(--text-positive\)/);
});
test('UI: grouped and regular message rows share one avatar column',()=>{
 const av=theme.match(/\.g-msg-av \{([^}]*)\}/)[1], slot=theme.match(/\.g-msg-av-slot \{([^}]*)\}/)[1];
 assert.match(av,/width: 38px/);assert.match(slot,/width: 38px/);
 assert.doesNotMatch(theme,/\.g-msg-av[^{]*\{[^}]*margin-left: -/);
});
test('UI: theme is the only sheet defining the palette',()=>{
 assert.match(theme,/--accent:/);
 assert.equal(read('public/css/layout.css').includes('--accent:'),false);
 assert.equal(read('public/css/chat.css').includes('--accent:'),false);
});
test('UI: no coloured side-stripe accents survive on message rows',()=>{
 assert.match(theme,/\.g-msg\.mention \{[^}]*box-shadow: none/);
});
test('security: avatar sources are restricted to uploads, http\(s\) and local previews',()=>{
 const start=core.indexOf('const UPLOAD_PATH_RE'),end=core.indexOf('function renderAv(');
 const ctx={BACKEND_URL:'https://chat.example',URL};
 vm.runInNewContext(core.slice(start,end)+';globalThis.src=avatarSrc;',ctx);
 assert.equal(ctx.src('/uploads/abc-123.webp'),'https://chat.example/uploads/abc-123.webp');
 assert.equal(ctx.src('blob:https://chat.example/1234'),'blob:https://chat.example/1234');
 for(const bad of ['javascript:alert(1)','JaVaScRiPt:alert(1)','data:image/svg+xml,<svg onload=alert(1)>',
                   'vbscript:msgbox','/etc/passwd','/uploads/../../server.js','https://chat.example/api/me'])
  assert.equal(ctx.src(bad),'',bad+' must not reach an img src');
 assert.equal(ctx.src('https://cdn.example/pic.png'),'https://cdn.example/pic.png');
});
test('security: the chat welcome block never builds HTML from user text',()=>{
 const chat=read('public/js/chat-ui.js');
 const fn=chat.slice(chat.indexOf('function renderChatWelcome('),chat.indexOf('function ensureDateDivider('));
 assert.doesNotMatch(fn,/innerHTML/);
 assert.match(fn,/title\.textContent/);
 assert.match(fn,/subEl\.textContent/);
 assert.doesNotMatch(chat,/sub: `[^`]*<b>/);
});
test('security: voice member avatars are rendered as nodes, not injected into CSS',()=>{
 const chat=read('public/js/chat-ui.js');
 assert.doesNotMatch(chat,/style\.backgroundImage/);
 assert.match(chat,/renderAv\(avatar, nick, member\?\.avatar \|\| null\)/);
});
test('profile: choosing an avatar only previews it; upload happens on save',()=>{
 const chat=read('public/js/chat-ui.js');
 const change=chat.slice(chat.indexOf("on('avatar-input', 'change'"),chat.indexOf("on('btn-avatar-remove'"));
 assert.doesNotMatch(change,/authFetch|upload\/avatar/);
 assert.match(change,/URL\.createObjectURL/);
 const save=chat.slice(chat.indexOf("on('btn-save-profile', 'click'"));
 assert.match(save,/if \(pendingAvatar\.file\) nextAvatar = await uploadPendingAvatar\(\)/);
 assert.match(chat,/function discardPendingAvatar/);
 assert.match(chat,/revokeObjectURL/);
 assert.match(read('public/js/core.js'),/window\.discardPendingAvatar\?\.\(\)/);
 assert.match(read('public/index.html'),/id="avatar-pending-hint"/);
});
test('release: all cache-busted local assets match package version',()=>{const version=JSON.parse(read('package.json')).version;const html=read('public/index.html');for(const m of html.matchAll(/(?:href|src)="\/(?:css|js)\/[^"?]+\?v=([^"&]+)/g))assert.equal(m[1],version);assert.ok(read('public/js/app.js').includes(`const VERSION = '${version}'`))});
test('release: initial search combobox has a declared collapsed state',()=>{assert.match(read('public/index.html'),/role="combobox" aria-expanded="false"/)});
function modalHarness(){
 let document,observer;
 function el(role){return{isConnected:true,style:{display:'none',zIndex:''},inert:false,attrs:role?{role}:{},children:[],getClientRects(){return this.style.display==='none'||(this.parent&&!this.parent.getClientRects().length)?[]:[{}]},querySelectorAll(){return this.children},contains(x){return this===x||this.children.includes(x)},closest(){return this.inert||this.parent?.inert?{}:null},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},hasAttribute(k){return k in this.attrs},focus(){document.activeElement=this}}}
 const first=el('dialog'),second=el('alertdialog'),screen=el(),trigger=el(),firstButton=el(),secondButton=el();
 trigger.style.display=firstButton.style.display=secondButton.style.display='block';first.children=[firstButton];second.children=[secondButton];firstButton.parent=first;secondButton.parent=second;
 const events={};document={activeElement:trigger,querySelectorAll:s=>s==='.screen'?[screen]:[first,second],addEventListener:(k,f)=>events[k]=f};
 const ctx={document,getComputedStyle:x=>({display:x.style.display,visibility:'visible'}),MutationObserver:class{constructor(fn){observer=fn}observe(){}}};
 vm.runInNewContext(read('public/js/accessibility.js'),ctx);
 return{first,second,screen,trigger,firstButton,secondButton,document,sync:()=>observer(),events};
}
test('dialogs: incoming calls preserve alertdialog semantics',()=>{const h=modalHarness();h.second.style.display='flex';h.sync();assert.equal(h.second.attrs.role,'alertdialog');assert.equal(h.second.attrs['aria-modal'],'true')});
test('dialogs: later-opened earlier DOM sibling becomes topmost and isolates its sibling',()=>{const h=modalHarness();h.second.style.display='flex';h.sync();h.first.style.display='flex';h.sync();assert.equal(h.first.attrs['aria-modal'],'true');assert.equal(h.second.inert,true);assert.equal(h.first.style.zIndex,'calc(var(--z-modal) + 1)');assert.equal(h.document.activeElement,h.firstButton)});
test('dialogs: closing the top dialog returns focus to its opener',()=>{const h=modalHarness();h.first.style.display='flex';h.sync();h.second.style.display='flex';h.sync();h.second.style.display='none';h.sync();assert.equal(h.document.activeElement,h.firstButton);assert.equal(h.first.inert,false)});
test('dialogs: closing all dialogs restores original workspace focus',()=>{const h=modalHarness();h.first.style.display='flex';h.sync();h.second.style.display='flex';h.sync();h.first.style.display=h.second.style.display='none';h.sync();assert.equal(h.document.activeElement,h.trigger);assert.equal(h.screen.inert,false)});
test('dialogs: Tab wraps within active dialog',()=>{const h=modalHarness();h.first.style.display='flex';h.sync();let prevented=false;h.events.keydown({key:'Tab',preventDefault(){prevented=true}});assert.equal(prevented,true);assert.equal(h.document.activeElement,h.firstButton)});
