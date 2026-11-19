'use strict';
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root=path.resolve(__dirname,'../public');
const screenshotDir=path.resolve(__dirname,'../test-results');fs.mkdirSync(screenshotDir,{recursive:true});
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==','base64');
const me={id:'alice',nickname:'Алекс',friends:['bob','carol'],friendRequests:[],blockedUsers:[],status:'На связи'};
const bob={id:'bob',nickname:'Макс',friends:['alice'],friendRequests:[],blockedUsers:[],online:true};
const carol={...bob,id:'carol',nickname:'Саша'};
const group={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'Планы на выходные',ownerId:'alice',members:[me,bob,carol]};
const mock=`window.__sent=[];window.__connections=0;window.__response={ok:true,status:'pending'};window.io=function(){const handlers={};const s={connected:false,auth:null,on(e,f){(handlers[e]??=[]).push(f);return s},once(e,f){const once=(p)=>{s.off(e,once);f(p)};return s.on(e,once)},off(e,f){if(handlers[e])handlers[e]=handlers[e].filter(x=>x!==f);return s},fire(e,p){for(const f of handlers[e]||[])f(p)},connect(){s.connected=true;window.__connections++;setTimeout(()=>{s.fire('connect');s.fire('profile',${JSON.stringify(me)})},10);return s},disconnect(){s.connected=false;return s},emit(e,p,cb){window.__sent.push({event:e,payload:p});if(cb)setTimeout(()=>cb(null,window.__response),window.__ackDelay||30);return s},timeout(){return s},io:{on(){}}};window.__socket=s;return s}`;
const server=http.createServer((req,res)=>{let pathname=new URL(req.url,'http://local').pathname;
 if(pathname.startsWith('/uploads/')){res.setHeader('Content-Type','image/png');return res.end(PNG)}
 if(pathname==='/socket.io/socket.io.js'){res.setHeader('Content-Type','text/javascript');return res.end(mock)}
 if(pathname==='/')pathname='/index.html';const file=path.join(root,pathname);if(!file.startsWith(root+path.sep)){res.statusCode=403;return res.end()}
 const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';res.setHeader('Content-Type',type);
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'");
 fs.readFile(file,(e,b)=>{if(e){res.statusCode=404;res.end('not found')}else res.end(b)});
});
const tests=[];async function check(name,fn){await fn();tests.push(name);console.log('PASS',name)}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({channel:'chromium',headless:true,args:['--no-sandbox']});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let historyDelay=0, searchDelay=0;
 const messages=Array.from({length:50},(_,i)=>({_id:`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`,from:i%2?'alice':'bob',text:i===49?'В 19:00 созвонимся?':`Сообщение ${i+1}`,time:new Date(Date.UTC(2026,8,5,12,i)).toISOString()}));
 await page.route('**/api/**',async route=>{const u=new URL(route.request().url());let data={};
  if(u.pathname==='/api/upload/avatar'){await page.evaluate(()=>{window.__avatarUploads=(window.__avatarUploads||0)+1});data={success:true,avatar:'/uploads/11111111-1111-1111-1111-111111111111.webp'}}
  else if(u.pathname==='/api/upload/image')data={success:true,url:'/uploads/22222222-2222-2222-2222-222222222222.webp'};
  else if(u.pathname==='/api/login'||u.pathname==='/api/register')data={user:me,token:'test-token'};
  else if(u.pathname==='/api/me')data=me;
  else if(u.pathname==='/api/groups')data=[group];
  else if(u.pathname==='/api/search'){if(searchDelay)await new Promise(r=>setTimeout(r,searchDelay));data=[{id:'david',nickname:'Даня',online:true}]}
  else if(u.pathname==='/api/profile/update')data={success:true,user:{...me,...route.request().postDataJSON()}};
  else if(u.pathname.startsWith('/api/profile/'))data=u.pathname.endsWith('bob')?bob:carol;
  else if(u.pathname.endsWith('/messages')||u.pathname.startsWith('/api/messages/')){if(historyDelay)await new Promise(r=>setTimeout(r,historyDelay));data=u.searchParams.has('before')?[{_id:'00000000-0000-0000-0000-000000000000',from:'bob',text:'Самое первое сообщение',time:'2026-09-04T12:00:00.000Z'}]:messages}
  await route.fulfill({json:data});
 });
 await page.goto(origin);await page.waitForLoadState('load');
 await check('clean initial boot',async()=>assert.deepEqual(errors,[]));
 await check('noise suppression stays disabled',async()=>assert.equal(await page.evaluate(()=>getCallAudioConstraints().noiseSuppression),false));
 await check('dark theme and no desktop overflow',async()=>{assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'dark');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))});
 await page.screenshot({path:path.join(screenshotDir,'auth-desktop.png'),fullPage:true});
 await page.fill('#login-id','alice');await page.fill('#login-pw','password123');await page.click('#btn-login');await page.waitForSelector('#app-screen.active');await page.waitForTimeout(200);
 await check('single connection after login',async()=>assert.equal(await page.evaluate(()=>window.__connections),1));


 await check('profile cards and settings fit desktop and mobile',async()=>{
   for(const width of [390,1440]) {
     await page.setViewportSize({width,height:900});
     await page.evaluate(()=>showUserProfile('bob'));
     await page.waitForSelector('#profile-modal',{state:'visible'});
     await page.waitForTimeout(350);
     const geometry=await page.locator('#profile-modal .modal-box').evaluate(el=>({fits:el.scrollWidth<=el.clientWidth,legacy:getComputedStyle(el.querySelector('.modal-profile-header'),'::before').content}));
     assert.equal(geometry.fits,true);assert.equal(geometry.legacy,'none');
     await page.screenshot({path:path.join(screenshotDir,'profile-view-'+width+'.png')});
     await page.keyboard.press('Escape');
     await page.evaluate(()=>openGroupInfoModal('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
     await page.waitForTimeout(350);
     assert.ok(await page.locator('#group-info-modal .modal-box').evaluate(el=>el.scrollWidth<=el.clientWidth));
     await page.screenshot({path:path.join(screenshotDir,'group-info-'+width+'.png')});
     await page.keyboard.press('Escape');
     await page.evaluate(()=>{state.me.bio='Очень длинное описание '.repeat(30);openSettings()});
     await page.waitForTimeout(250);
     assert.ok(await page.locator('.settings-shell').evaluate(el=>el.scrollWidth<=el.clientWidth));
     assert.equal(await page.locator('#settings-user-avatar').evaluate(el=>getComputedStyle(el).justifyContent),'center');
     await page.screenshot({path:path.join(screenshotDir,'settings-account-'+width+'.png')});
     await page.keyboard.press('Escape');
   }
   await page.setViewportSize({width:1440,height:1000});
 });
 await check('microphone check responds to audio level, threshold and mute', async()=>{
   await page.click('#btn-settings');
   await page.click('[data-settings-section="voice"]');
   await page.evaluate(()=>{
     const constraintsOverride = async () => {
       const ctx = new AudioContext();
       const oscillator = ctx.createOscillator();
       const gain = ctx.createGain();
       const dest = ctx.createMediaStreamDestination();
       gain.gain.value = .04472;
       oscillator.connect(gain).connect(dest);
       oscillator.start();
       await ctx.resume();
       window.voiceFixture = {ctx, track:dest.stream.getAudioTracks()[0]};
       return dest.stream;
     };
     window.oldGetUserMedia = navigator.mediaDevices.getUserMedia;
     navigator.mediaDevices.getUserMedia = constraintsOverride;
   });
   try {
     await page.click('#voice-check-toggle');
     await page.waitForFunction(()=>{
       const value = document.getElementById('voice-meter-value').textContent;
       return /−(29|30|31) dBFS/.test(value) && document.getElementById('voice-meter').classList.contains('is-active');
     });
     await page.screenshot({path:path.join(screenshotDir,'settings-voice-desktop.png'),animations:'disabled'});
     await page.locator('#voice-threshold').fill('-20');
     await page.waitForFunction(()=>!document.getElementById('voice-meter').classList.contains('is-active'));
     await page.locator('#voice-threshold').fill('-48');
     await page.waitForFunction(()=>document.getElementById('voice-meter').classList.contains('is-active'));
     await page.evaluate(()=>{voiceFixture.track.enabled=false});
     await page.waitForFunction(()=>document.getElementById('voice-meter-value').textContent==='—' && !document.getElementById('voice-meter').classList.contains('is-active'));
     await page.setViewportSize({width:390,height:700});
     assert.ok(await page.locator('.settings-shell').evaluate(el=>el.scrollWidth<=el.clientWidth));
     await page.screenshot({path:path.join(screenshotDir,'settings-voice-mobile.png'),animations:'disabled'});
     await page.keyboard.press('Escape');
     await page.waitForFunction(()=>voiceFixture.track.readyState==='ended');
   } finally {
     await page.evaluate(async()=>{
       navigator.mediaDevices.getUserMedia=window.oldGetUserMedia;
       if(window.voiceFixture) await voiceFixture.ctx.close();
     });
     await page.setViewportSize({width:1440,height:1000});
   }
 });
 await check('settings navigation and profile customization work', async()=>{
   await page.click('#btn-settings');
   await page.click('.settings-subitem[data-settings-section="account"]');
   assert.equal(await page.locator('[data-settings-section="account"].active').count(),2);
   await page.fill('#settings-search-input','пароль');
   await page.press('#settings-search-input','Enter');
   assert.equal(await page.locator('[data-settings-panel="security"]').isVisible(),true);
   await page.fill('#settings-search-input','');
   await page.click('.settings-nav-item[data-settings-section="account"]');
   await page.click('#btn-settings-profile');
   assert.equal(await page.locator('#settings-modal').isVisible(),false);
   await page.click('[data-profile-colors="#176b87,#64ccc5"]');
   assert.equal(await page.inputValue('#edit-profile-color'),'#176b87');
   await page.fill('#edit-nick','Новое имя');
   await page.fill('#edit-pronouns','она / её');
   await page.fill('#edit-bio','<script>текст</script>');
   await page.locator('#edit-profile-color').fill('#123456');
   assert.equal(await page.locator('#profile-preview-name').textContent(),'Новое имя');
   assert.equal(await page.locator('#profile-preview-bio script').count(),0);
   assert.match(await page.locator('#profile-preview-banner').getAttribute('style'),/18, 52, 86/);
   await page.click('#btn-save-profile');
   await page.waitForFunction(()=>document.getElementById('edit-profile-modal').style.display==='none');
   await page.evaluate(()=>openEditProfileModal());
   assert.equal(await page.inputValue('#edit-pronouns'),'она / её');
   assert.equal(await page.inputValue('#edit-profile-color'),'#123456');
   await page.waitForTimeout(400);
   await page.screenshot({path:path.join(screenshotDir,'profile-customization.png'),fullPage:true});
   await page.setViewportSize({width:390,height:844});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:path.join(screenshotDir,'profile-mobile.png'),fullPage:true});
   await page.keyboard.press('Escape');
   assert.equal(await page.locator('#edit-profile-modal').isVisible(),false);
   await page.setViewportSize({width:1440,height:1000});
 });
 await check('voice latency badge does not overlap the avatar', async()=>{
   const result = await page.evaluate(()=>{
     const overlay=document.createElement('div');overlay.className='call-overlay voice-mode';overlay.style.cssText='display:block;position:fixed;top:100px;left:100px';
     const tile=document.createElement('div');tile.className='call-tile';overlay.append(tile);document.body.append(overlay);
     cplQuality.set('layout-test',{level:'good',rtt:42,loss:0});cplRenderTileQuality(tile,'layout-test');
     const badge=tile.querySelector('.call-tile-quality');const result={text:badge.textContent,separate:badge.getBoundingClientRect().bottom<=tile.getBoundingClientRect().top};
     overlay.remove();cplQuality.delete('layout-test');return result;
   });assert.equal(result.separate,true);assert.match(result.text,/42 мс/);
 });
 await page.evaluate(()=>openEditProfileModal());
 await page.setInputFiles('#avatar-input',{name:'avatar.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(6*1024*1024,7)});
 await page.waitForTimeout(120);
 await check('choosing an avatar only previews it locally',async()=>{
  assert.match(await page.locator('#avatar-pending-hint').textContent(),/после нажатия/);
  assert.equal(await page.evaluate(()=>document.querySelector('#my-avatar img')),null);
  assert.equal(await page.evaluate(()=>window.__avatarUploads||0),0);
 });
 await check('a decodable image shows a local blob preview before saving',async()=>{
  await page.setInputFiles('#avatar-input',{name:'tiny.png',mimeType:'image/png',buffer:PNG});
  await page.waitForTimeout(150);
  assert.match(await page.evaluate(()=>document.querySelector('#edit-avatar img')?.src||''),/^blob:/);
  assert.equal(await page.evaluate(()=>window.__avatarUploads||0),0);
 });
 await check('cancelling the dialog drops the chosen avatar',async()=>{
  await page.keyboard.press('Escape');await page.waitForTimeout(80);
  await page.evaluate(()=>openEditProfileModal());await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>document.querySelector('#edit-avatar img')),null);
  assert.equal(await page.evaluate(()=>window.__avatarUploads||0),0);
 });
 await check('Save changes uploads the avatar and applies it everywhere',async()=>{
  await page.setInputFiles('#avatar-input',{name:'avatar.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(6*1024*1024,7)});
  await page.waitForTimeout(120);
  await page.click('#btn-save-profile');
  await page.waitForFunction(()=>document.getElementById('edit-profile-modal').style.display==='none');
  assert.equal(await page.evaluate(()=>window.__avatarUploads),1);
  assert.match(await page.evaluate(()=>document.querySelector('#my-avatar img')?.src||''),/11111111-1111-1111-1111-111111111111/);
 });
 await page.evaluate(()=>openChat('bob'));await page.waitForTimeout(100);
 await check('screen sharing stays compact when changing chats', async()=>{
   await page.evaluate(()=>{
     callState.active=true; callState.peerFriendId='bob'; callState.isGroup=false; screenShareTrack={readyState:'live'};
     const overlay=document.getElementById('call-overlay');
     overlay.style.display='flex'; overlay.classList.add('video-mode','screen-share-mini');
     syncVoiceOverlayPosition();
   });
   try {
     const result=await page.evaluate(()=>{
       const overlay=document.getElementById('call-overlay');
       const activeHeight=overlay.getBoundingClientRect().height;
       state.activeFriend='carol'; syncCallDetached();
       const detached=overlay.classList.contains('detached');
       const detachedWidth=overlay.getBoundingClientRect().width;
       return {activeHeight,detached,detachedWidth,active:callState.active};
     });
     assert.ok(result.activeHeight<=420, JSON.stringify(result));
     assert.equal(result.detached,true);
     assert.ok(result.detachedWidth<=300, JSON.stringify(result));
     assert.equal(result.active,true);
   } finally {
     await page.evaluate(()=>{
       callState.active=false; screenShareTrack=null; state.activeFriend='bob';
       const overlay=document.getElementById('call-overlay');
       overlay.style.display='none'; overlay.classList.remove('video-mode','screen-share-mini','detached');
     });
   }
 });
 await check('profile badge is shown only for rock account ID', async()=>{
   await page.route('**/api/profile/{rock,nongl}', route=>{
     const id=new URL(route.request().url()).pathname.split('/').pop();
     return route.fulfill({json:{id,nickname:'Одинаковое имя',online:true}});
   });
   await page.evaluate(()=>showUserProfile('rock'));
   await page.waitForFunction(()=>document.querySelector('#profile-modal-id').textContent==='@rock');
   assert.equal(await page.locator('#profile-admin-badge').isVisible(),true);
   await page.evaluate(()=>showUserProfile('nongl'));
   await page.waitForFunction(()=>document.querySelector('#profile-modal-id').textContent==='@nongl');
   assert.equal(await page.locator('#profile-admin-badge').isVisible(),false);
   await page.keyboard.press('Escape');
 });
 await check('two screen share tiles use the available width', async()=>{
   const sizes = await page.evaluate(()=>{
     const overlay=document.getElementById('call-overlay');
     const grid=document.getElementById('call-video-grid');
     overlay.style.display='flex'; overlay.classList.add('screen-share-mini');
     grid.dataset.count='2';
     const tiles=Array.from({length:2},()=>{const tile=document.createElement('div');tile.className='call-tile';grid.append(tile);return tile;});
     const box=grid.getBoundingClientRect();
     const first=tiles[0].getBoundingClientRect(); const last=tiles[1].getBoundingClientRect();
     const result={left:first.left-box.left,right:box.right-last.right,width:box.width};
     tiles.forEach(tile=>tile.remove()); overlay.style.display='none'; overlay.classList.remove('screen-share-mini'); delete grid.dataset.count;
     return result;
   });
   assert.ok(sizes.left < 50 && sizes.right < 50, JSON.stringify(sizes));
 });
 await check('screen share can be collapsed while the message input remains accessible', async()=>{
   await page.evaluate(()=>{
     callState.active = true;
     const overlay = document.getElementById('call-overlay');
     overlay.style.display = 'flex';
     overlay.classList.add('screen-share-mini');
     document.getElementById('btn-call-compact').hidden = false;
   });
   try {
     await page.click('#btn-call-compact');
     assert.equal(await page.getAttribute('#btn-call-compact','aria-pressed'),'true');
     await page.click('#msg-input');
     assert.equal(await page.evaluate(()=>document.activeElement.id),'msg-input');
     assert.equal(await page.evaluate(()=>callState.active),true);
     await page.click('#btn-call-compact');
     assert.equal(await page.getAttribute('#btn-call-compact','aria-pressed'),'false');
   } finally {
     await page.evaluate(()=>{
       callState.active = false;
       const overlay = document.getElementById('call-overlay');
       overlay.style.display = 'none';
       overlay.classList.remove('screen-share-mini','call-compact');
     });
   }
 });
 await check('consecutive short messages stay compact', async()=>{
   const heights = await page.evaluate(()=>{
     const container = document.querySelector('#messages');
     const rows = Array.from({length: 12},()=>{
       const row = document.createElement('div');
       row.className = 'g-msg grouped';
       row.innerHTML = '<div class="g-msg-av-slot"><span class="g-msg-hover-time">12:03</span></div><div class="g-msg-body"><div class="g-msg-text">Сообщение</div></div>';
       container.append(row);
       return row;
     });
     const result = rows.map(row=>row.getBoundingClientRect().height);
     rows.forEach(row=>row.remove());
     return result;
   });
   assert.ok(heights.every(height=>height <= 28), `Grouped row heights: ${heights}`);
 });
 await page.setInputFiles('#msg-image-input',{name:'photo.png',mimeType:'image/png',buffer:Buffer.from('png')});
 await page.waitForSelector('#msg-attach-preview.show');
 await page.click('#btn-send');await page.waitForFunction(()=>__sent.some(x=>x.event==='sendMessage'&&x.payload.toId==='bob'));
 await check('PNG attachment sends in a DM',async()=>{const sent=await page.evaluate(()=>__sent.find(x=>x.event==='sendMessage'&&x.payload.toId==='bob'));assert.equal(sent.payload.image,'/uploads/22222222-2222-2222-2222-222222222222.webp')});
 await page.evaluate(()=>openGroupChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));await page.waitForTimeout(150);
 await page.setInputFiles('#group-image-input',{name:'group.jpg',mimeType:'image/jpeg',buffer:Buffer.from('jpg')});
 await page.waitForSelector('#group-attach-preview.show');
 await page.click('#btn-group-send');await page.waitForTimeout(100);
 await check('JPG attachment sends in a group',async()=>{const sent=await page.evaluate(()=>__sent.find(x=>x.event==='groupMessage'));assert.equal(sent.payload.image,'/uploads/22222222-2222-2222-2222-222222222222.webp')});
 await page.evaluate(()=>openEditProfileModal());
 await page.setInputFiles('#avatar-input',{name:'avatar-700kb.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(700*1024,7)});
 await page.waitForTimeout(120);
 await check('700 KB JPG avatar is not rejected by the client limit',async()=>assert.equal(await page.locator('#avatar-pending-hint').isVisible(),true));
 await page.keyboard.press('Escape');
 await page.evaluate(()=>openChat('bob'));await page.waitForTimeout(100);
 await page.evaluate(()=>{
   const dt=new DataTransfer();
   dt.items.add(new File([new Uint8Array(16)],'clipboard-screenshot.png',{type:'image/png'}));
   document.querySelector('#msg-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
 });
 await page.waitForSelector('#msg-attach-preview.show');
 await check('Ctrl+V screenshot attaches in a DM',async()=>assert.match(await page.locator('#transient-notice').textContent(),/Файл добавлен к сообщению/));
 await page.click('#btn-send');await page.waitForTimeout(120);
 await page.evaluate(()=>openGroupChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));await page.waitForTimeout(120);
 await page.evaluate(()=>{
   const dt=new DataTransfer();
   dt.items.add(new File([new Uint8Array(16)],'clipboard-screenshot.png',{type:'image/png'}));
   document.querySelector('#group-msg-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
 });
 await page.waitForSelector('#group-attach-preview.show');
 await check('Ctrl+V screenshot attaches in a group',async()=>assert.match(await page.locator('#transient-notice').textContent(),/Файл добавлен/));
 await page.click('#btn-group-send');await page.waitForTimeout(120);
 await page.fill('#search-input','@david');await page.waitForSelector('.s-item .btn-add');await page.click('.s-item .btn-add');await page.waitForTimeout(100);
 await check('friend addition waits for ack and shows success',async()=>{assert.equal(await page.locator('.s-item .btn-add').textContent(),'Заявка отправлена');const sent=await page.evaluate(()=>__sent.find(x=>x.event==='sendFriendRequest'));assert.equal(sent.payload,'david')});
 await page.evaluate(()=>{__response={ok:false,reason:'blocked',error:'Заблокирован'};sentFriendRequests.delete('david');closeDrop();});
 await page.fill('#search-input','david');await page.waitForSelector('.s-item .btn-add');await page.click('.s-item .btn-add');await page.waitForTimeout(100);
 await check('friend errors restore the button and explain reason',async()=>{assert.equal(await page.locator('.s-item .btn-add').isDisabled(),false);assert.match(await page.locator('#transient-notice').textContent(),/Невозможно/)});
 await page.evaluate(()=>{__response={ok:true,status:'friends'};});await page.click('.s-item .btn-add');await page.waitForTimeout(100);
 await check('cross-request success has a friends state',async()=>assert.equal(await page.locator('.s-item .btn-add').textContent(),'✓ В друзьях'));
 await page.evaluate(()=>closeDrop());await page.evaluate(()=>openChat('bob'));await page.waitForSelector('#messages .history-more');
 await check('first history page renders 50 messages',async()=>assert.equal(await page.locator('#messages [data-msgid]').count(),50));
 await page.click('#messages .history-more');await page.waitForSelector('[data-msgid="00000000-0000-0000-0000-000000000000"]');
 await check('cursor pagination preserves existing messages',async()=>assert.equal(await page.locator('#messages [data-msgid]').count(),51));
 await page.evaluate(()=>{__socket.connected=false});await page.fill('#msg-input','Не потеряй меня');await page.keyboard.press('Enter');
 await check('disconnected send preserves text',async()=>assert.equal(await page.inputValue('#msg-input'),'Не потеряй меня'));
 await page.evaluate(()=>{__socket.connected=true;__response={ok:false,reason:'busy',error:'Сервер занят'};refreshComposer(false)});await page.click('#btn-send');await page.waitForTimeout(100);
 await check('rejected send preserves text',async()=>assert.equal(await page.inputValue('#msg-input'),'Не потеряй меня'));
 await page.evaluate(()=>{__response={ok:true};__ackDelay=180});await page.click('#btn-send');
 await check('send retains a retry attempt until acknowledgement',async()=>{assert.equal(await page.inputValue('#msg-input'),'');assert.equal(await page.evaluate(()=>retryMessages.get('dm:bob')?.text),'Не потеряй меня')});
 await page.waitForTimeout(240);
 await check('confirmed send clears text and retries reuse id',async()=>{assert.equal(await page.inputValue('#msg-input'),'');const s=await page.evaluate(()=>__sent.filter(x=>x.event==='sendMessage'));assert.equal(s.at(-1).payload.clientId,s.at(-2).payload.clientId)});
 await page.fill('#msg-input','Черновик Максу');await page.evaluate(()=>openChat('carol'));assert.equal(await page.inputValue('#msg-input'),'');await page.fill('#msg-input','Черновик Саше');await page.evaluate(()=>openChat('bob'));
 await check('drafts stay with their conversation',async()=>assert.equal(await page.inputValue('#msg-input'),'Черновик Максу'));
 await check('message formatting escapes HTML and marker injection',async()=>{const result=await page.evaluate(()=>formatMsgText('<img src=x onerror=alert(1)>\uE000123\uE001 **привет**'));assert.ok(!result.includes('<img'));assert.ok(!result.includes('undefined'));assert.ok(result.includes('<strong>привет</strong>'))});
 await page.evaluate(()=>openEditProfileModal());await page.waitForTimeout(100);
 await check('dialog traps background interaction',async()=>{assert.equal(await page.evaluate(()=>document.querySelector('#app-screen').inert),true);assert.equal(await page.locator('#edit-profile-modal').getAttribute('aria-modal'),'true')});
 await page.keyboard.press('Escape');await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>document.querySelector('#app-screen').inert),false);
 historyDelay=250;
 await page.evaluate(()=>{openChat('bob');setTimeout(()=>__socket.fire('newMessage',{chatWith:'bob',msg:{_id:'live-during-load',from:'bob',text:'Пришло во время загрузки',time:'2026-09-06T01:00:00.000Z'}}),80)});await page.waitForTimeout(400);
 await check('realtime messages survive initial history response',async()=>assert.equal(await page.locator('[data-msgid="live-during-load"]').count(),1));
 historyDelay=0;
 await page.evaluate(()=>{openChat('bob');openGroupChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')});await page.waitForTimeout(200);
 await check('switching DM to group rejects stale requests',async()=>assert.equal(await page.evaluate(()=>state.activeGroup),'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
 await page.evaluate(()=>openChat('bob'));await page.waitForTimeout(150);await page.evaluate(()=>{document.activeElement?.blur();document.querySelector('#transient-notice')?.classList.remove('show');scrollMsgs('messages')});await page.screenshot({path:path.join(screenshotDir,'chat-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
 await check('mobile chat has no horizontal overflow',async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)));
 await page.screenshot({path:path.join(screenshotDir,'chat-mobile.png'),fullPage:true});
 await page.click('#btn-back');await page.waitForTimeout(100);
 await check('mobile back returns to conversations',async()=>assert.equal(await page.locator('.sidebar').isVisible(),true));
 searchDelay=180;await page.fill('#search-input','david');await page.waitForTimeout(300);await page.fill('#search-input','');await page.waitForTimeout(250);
 await check('cleared search cannot reopen from stale response',async()=>assert.equal(await page.locator('#search-results').evaluate(e=>e.classList.contains('open')),false));
 await check('no runtime errors through UI scenarios',async()=>assert.deepEqual(errors,[]));
 await page.reload();await page.waitForTimeout(300);
 await check('session restoration opens one socket',async()=>{assert.equal(await page.evaluate(()=>__connections),1);assert.equal(await page.locator('#app-screen').evaluate(e=>e.classList.contains('active')),true)});
 const blocked=await browser.newPage();const storageErrors=[];blocked.on('pageerror',e=>storageErrors.push(e.message));
 await blocked.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}}));await blocked.goto(origin);await blocked.waitForLoadState('load');
 await check('storage denial does not crash login screen',async()=>assert.deepEqual(storageErrors,[]));await blocked.close();
 await page.setViewportSize({width:1440,height:900});
 await check('inactive screens do not participate in layout',async()=>{
   assert.equal(await page.locator('#auth-screen').evaluate(el=>{document.documentElement.classList.remove('has-session');const d=getComputedStyle(el).display;document.documentElement.classList.add('has-session');return d}),'none');
 });
 await check('rail sits beside conversation column, footer remains visible',async()=>{
   const rail=await page.locator('.guild-rail').boundingBox(), side=await page.locator('.sidebar-inner').boundingBox(), footer=await page.locator('.sidebar-footer').boundingBox();
   assert.ok(Math.abs(rail.y-side.y)<2);assert.ok(side.x>=rail.x+rail.width-1);assert.ok(footer.y+footer.height<=901);assert.ok(side.height>800);
 });
 await page.route('**/api/search?**',async route=>{
   const q=new URL(route.request().url()).searchParams.get('q');
   if(q==='old'){await new Promise(r=>setTimeout(r,120));return route.fulfill({json:[{id:'old_user',nickname:'Old result'}]}).catch(()=>{})}
   if(q==='error')return route.fulfill({status:500,json:{error:'Ошибка <тест> & "кавычки"'}});
   return route.fulfill({json:[{id:'new_user',nickname:'New result'}]});
 });
 await page.fill('#search-input','old');await page.waitForRequest(r=>r.url().includes('/api/search?q=old'));
 await page.fill('#search-input','new');await page.waitForTimeout(170);
 await check('old search stays closed during new-query debounce',async()=>assert.equal(await page.locator('#search-results').evaluate(el=>el.classList.contains('open')),false));
 await page.waitForSelector('.s-item[data-uid="new_user"]');
 await page.fill('#search-input','error');await page.waitForSelector('.s-empty');
 await check('search error text is escaped once',async()=>assert.equal(await page.locator('.s-empty').textContent(),'Ошибка <тест> & "кавычки"'));
 await page.evaluate(()=>{closeDrop();openChat('bob')});await page.waitForTimeout(160);
 await page.focus('#btn-call-audio');
 await page.evaluate(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true})));
 await check('typing shortcut does not steal button focus',async()=>assert.equal(await page.evaluate(()=>document.activeElement.id),'btn-call-audio'));
 for(const width of [320,390,640,768,1024,1440]) {
   await page.setViewportSize({width,height:844});await page.evaluate(()=>openGroupChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));await page.waitForTimeout(100);
   await check(`group chat fits ${width}px viewport`,async()=>{
     const composer=await page.locator('#group-msg-input').boundingBox();const send=await page.locator('#btn-group-send').boundingBox();
     assert.ok(composer.width>80);assert.ok(send.x+send.width<=width+1);assert.ok(send.y+send.height<=845);
     const actions=await page.locator('#btn-toggle-members').boundingBox();assert.ok(actions.x+actions.width<=width+1);
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   });
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 await check('reduced motion disables decorative transitions',async()=>assert.equal(await page.locator('.rail-btn').first().evaluate(el=>getComputedStyle(el).transitionDuration),'0s'));
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{
   callState.active=true;callState.callId='screen-test';callState.isGroup=false;callState.video=false;
   const local=new MediaStream(), remote=new MediaStream();
   Object.defineProperty(remote,'getVideoTracks',{value:()=>[{enabled:true,readyState:'live',muted:false}]});
   Object.defineProperty(remote,'getAudioTracks',{value:()=>[]});
   callState.localStream=local;
   callState.peers={bob:{stream:remote,micOn:true,camOn:true}};
   renderCallGrid();
 });
 await check('remote screen share renders for an audio-only viewer',async()=>{
   assert.equal(await page.locator('#call-overlay').evaluate(el=>el.classList.contains('voice-mode')),false);
   assert.equal(await page.locator('#call-video-grid .call-tile[data-peer="bob"].audio-only').count(),0);
   assert.equal(await page.locator('#call-video-grid video').count(),1);
 });
 await page.evaluate(()=>{__socket.fire('callPeerLeft',{callId:'screen-test',peerId:'bob'});});
 await check('leaving peer keeps the voice room open',async()=>{
   assert.equal(await page.evaluate(()=>callState.active),true);
   assert.match(await page.locator('#call-overlay-status').textContent(),/ожидание участников/);
 });
 await page.evaluate(()=>hangupCall());
 await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>{openGroupChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');document.activeElement?.blur()});await page.waitForTimeout(200);
 await page.screenshot({path:path.join(screenshotDir,'group-desktop.png')});
 const authPage=await browser.newPage({viewport:{width:390,height:480}});await authPage.goto(origin);await authPage.waitForLoadState('load');await authPage.click('[data-action="nav-register"]');
 await check('registration remains reachable on short screens',async()=>{
   await authPage.locator('#btn-register').scrollIntoViewIfNeeded();const button=await authPage.locator('#btn-register').boundingBox();assert.ok(button.y>=0&&button.y+button.height<=481);
   assert.equal(await authPage.locator('#app-screen').isVisible(),false);
 });
 await authPage.close();
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>openChat('bob'));await page.waitForTimeout(150);
 await page.keyboard.press('Control+k');
 await check('mobile quick search reveals and focuses sidebar',async()=>{
   assert.equal(await page.locator('.sidebar').isVisible(),true);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'search-input');
 });
 await page.setViewportSize({width:1440,height:900});
 await page.evaluate(()=>{openChat('bob');__response={ok:true};__ackDelay=50});await page.waitForTimeout(150);
 await page.fill('#msg-input','Первая строка');await page.keyboard.press('End');await page.keyboard.press('Shift+Enter');await page.keyboard.type('Second line');
 await check('Shift+Enter creates a newline without sending',async()=>{
   assert.equal(await page.inputValue('#msg-input'),'Первая строка\nSecond line');
 });
 await page.evaluate(()=>{__ackDelay=700});
 await page.click('#btn-send');await page.evaluate(()=>openChat('carol'));await page.waitForTimeout(120);
 await page.fill('#msg-input','Другому другу');
 await check('pending delivery does not disable another conversation',async()=>{
   assert.equal(await page.locator('#btn-send').isDisabled(),false);
 });
 await page.click('#btn-send');await page.waitForTimeout(850);
 await check('independent conversations both receive acknowledgement',async()=>{
   assert.equal(await page.inputValue('#msg-input'),'');
   assert.ok(await page.evaluate(()=>__sent.some(x=>x.event==='sendMessage'&&x.payload.toId==='carol'&&x.payload.text==='Другому другу')));
 });
 await page.evaluate(()=>{openChat('bob');__ackDelay=300});await page.waitForTimeout(150);
 await page.fill('#msg-input','Отправляемое');await page.click('#btn-send');await page.fill('#msg-input','Следующий черновик');
 await page.waitForTimeout(400);
 await check('typing during acknowledgement preserves the newer draft',async()=>{
   assert.equal(await page.inputValue('#msg-input'),'Следующий черновик');
 });
 await page.evaluate(()=>openEditProfileModal());await page.waitForTimeout(80);
 const modalFocus=await page.evaluate(()=>document.activeElement.id);
 await page.keyboard.press('Control+k');
 await check('quick search does not steal focus from a dialog',async()=>assert.equal(await page.evaluate(()=>document.activeElement.id),modalFocus));
 await page.keyboard.press('Escape');
 await page.evaluate(()=>openGroupChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));await page.waitForTimeout(100);
 await page.evaluate(()=>{
   state.groupVoiceCalls['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']={callId:'retained-voice',video:false,participants:[]};
   updateGroupVoiceBar('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
 });
 await check('empty group voice stays visible with a join action',async()=>{
   assert.equal(await page.locator('#group-voice-bar').isVisible(),true);
   assert.equal(await page.locator('#btn-join-group-voice').isDisabled(),false);
   assert.equal(await page.locator('#btn-join-group-voice').textContent(),'Присоединиться');
 });
 await page.evaluate(()=>{
   window.__response={ok:true};window.__socket.connected=true;
   const audio = new AudioContext(); const stream = audio.createMediaStreamDestination().stream;
   Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>stream}});
 });
 await page.click('#btn-join-group-voice');await page.waitForTimeout(100);
 await check('join action reuses the retained voice call',async()=>{
   const joined=await page.evaluate(()=>__sent.find(x=>x.event==='callJoin'&&x.payload.callId==='retained-voice'));
   assert.ok(joined);
 });
 await page.evaluate(()=>{
   callState.active=true;callState.callId='manual-leave-test';callState.isGroup=true;callState.groupId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
   callState.localStream={getTracks:()=>[],getAudioTracks:()=>[],getVideoTracks:()=>[]};
   updateGroupVoiceBar('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
 });
 await page.evaluate(()=>hangupCall());
 await check('manual voice exit sends leave and keeps the channel rejoinable',async()=>{
   assert.ok(await page.evaluate(()=>__sent.some(x=>x.event==='callLeave'&&x.payload.callId==='manual-leave-test')));
   assert.equal(await page.evaluate(()=>callState.active),false);
   assert.equal(await page.locator('#btn-join-group-voice').isDisabled(),false);
 });
 await page.evaluate(()=>{
   window.rememberGroupVoice('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','retained-after-exit',false);
   __socket.fire('groupVoiceState',{groupId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',callId:null});
 });
 // A voice entry is conditional on a live callId, not a permanent fake channel.
 await check('ended session clears its ID and removes the inactive voice entry',async()=>{
   assert.equal(await page.evaluate(()=>state.groupVoiceCalls['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']?.callId),undefined);
   assert.equal(await page.locator('.group-voice-channel').count(),0);
   assert.equal(await page.locator('#group-voice-bar').isVisible(),false);
 });
 await page.click('#btn-toggle-members');
 await check('members button exposes actual expanded state',async()=>assert.equal(await page.locator('#btn-toggle-members').getAttribute('aria-expanded'),String(!(await page.locator('#group-members-panel').evaluate(el=>el.classList.contains('hidden'))))));
 await page.evaluate(()=>{__ackDelay=500;openChat('bob')});await page.waitForTimeout(100);
 await page.fill('#msg-input','Старый сеанс');await page.click('#btn-send');
 await page.evaluate(()=>{forceLogoutToLogin();state.me={id:'alice',nickname:'Алекс'};composerDrafts.set('dm:bob','Новый сеанс');retryMessages.set('dm:bob',{text:'Новый сеанс',clientId:'new-session'});});
 await page.waitForTimeout(600);
 await check('old acknowledgement cannot mutate a new login with the same user ID',async()=>{
   assert.equal(await page.evaluate(()=>retryMessages.get('dm:bob')?.clientId),'new-session');
   assert.equal(await page.evaluate(()=>composerDrafts.get('dm:bob')),'Новый сеанс');
 });
 await check('no runtime errors in redesign regressions',async()=>assert.deepEqual(errors,[]));

 console.log(JSON.stringify({passed:tests.length,tests},null,2));
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
