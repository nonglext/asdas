'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'public/js/calls.js'),'utf8');
const auth=fs.readFileSync(path.join(root,'public/js/auth-ui.js'),'utf8');
function clock(){
 let now=0, next=0; const timers=new Map();
 return {timers,setTimeout(fn,ms){const t={id:++next,unref(){}};timers.set(t,{fn,at:now+ms});return t},
 clearTimeout(t){timers.delete(t)}, tick(ms){const end=now+ms;for(;;){const first=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!first)break;const[t,v]=first;timers.delete(t);now=v.at;v.fn()}now=end}};
}
const gid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function serverHarness(){
 const time=clock(),events=[],all=new Map(),rooms=new Map();let serial=0;
 const emitter=(targets=[])=>({to(id){return emitter([...targets,id])},except(){return this},emit(event,payload){events.push({targets,event,payload})}});
 const io={to:id=>emitter([id]),sockets:{sockets:all,adapter:{rooms}}};
 const ctx=vm.createContext({io,console,Map,Set,Date,...time,crypto:{randomUUID:()=>`00000000-0000-0000-0000-${String(++serial).padStart(12,'0')}`},
 sockets:uid=>[...all.values()].filter(s=>s.user.id===uid),
 reject:(status,message,reason)=>{throw Object.assign(new Error(message),{status,reason})},
 dmAccess:async(uid,target)=>{if(!target||target==='blocked')throw new Error('forbidden')},membership:async(uid,g)=>{if(g!==gid)throw new Error('forbidden')},
 checkLimit:()=>{},startCallLimit:()=>true,typingLimit:()=>true,signalLimit:()=>true,
 uuidOK:x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x),idOK:x=>typeof x==='string',record:x=>!!x&&typeof x==='object',
 dmKey:(a,b)=>'dm:'+ [a,b].sort().join(':'),clientId:x=>x,Buffer});
 const code=server.slice(server.indexOf('const calls = new Map()'),server.indexOf('const ringTimer ='));
 vm.runInContext(code+';globalThis.api={calls,callsByChat,busyUser,leaveCall,attachCall,scheduleLeave,endCall};',ctx);
 const handlersCode=server.slice(server.indexOf("  on('callStart',"),server.indexOf('\n});\n\n// Additive migrations'));
 function socket(uid,sid=uid){
  const handlers={};const s={id:sid,user:{id:uid,nickname:uid},connected:true,activeCallKeys:new Set(),rooms:new Set(),
   emit:(event,payload)=>events.push({targets:[sid],event,payload}),to:id=>emitter([id]),
   join(room){this.rooms.add(room);if(!rooms.has(room))rooms.set(room,new Set());rooms.get(room).add(sid)},
   leave(room){this.rooms.delete(room);rooms.get(room)?.delete(sid)}};
  all.set(sid,s);ctx.s=s;ctx.onHandler=(e,shape,fn)=>handlers[e]=fn;
  vm.runInContext('((socket,uid,on)=>{'+handlersCode+'})(s,s.user.id,onHandler)',ctx);
  return {s,run:(e,p)=>handlers[e](p)};
 }
 return {time,events,socket,...ctx.api};
}
async function answered(h){const a=h.socket('alice'),b=h.socket('bob');await a.run('callStart',{toId:'bob',requestId:'req-a'});const c=[...h.calls.values()][0];await b.run('callJoin',{callId:c.callId});return {a,b,c}}
test('DM: leaving keeps the same session for both users beyond ten minutes',async()=>{
 const h=serverHarness(),{a,c}=await answered(h);await a.run('callLeave',{callId:c.callId});
 assert.deepEqual([...c.participants],['bob']);h.time.tick(600000);assert.equal(h.calls.get(c.callId),c);
 for(const uid of ['alice','bob']){const last=h.events.filter(x=>x.event==='dmVoiceState'&&x.targets.includes(uid)).at(-1);assert.equal(last.payload.callId,c.callId);assert.deepEqual([...last.payload.participants],['bob'])}
});
test('DM: leaver rejoins with callJoin, same ID and fresh peer announcement',async()=>{
 const h=serverHarness(),{a,c}=await answered(h);await a.run('callLeave',{callId:c.callId});await a.run('callJoin',{callId:c.callId});assert.equal(c.participants.size,2);assert.equal(c.peers.get('alice'),'alice');assert.equal(h.calls.size,1);
 assert.ok(h.events.some(x=>x.event==='callPeerJoined'&&x.payload.peerId==='alice'));
});
test('DM: ordinary call button also rejoins instead of returning busy or ringing again',async()=>{
 const h=serverHarness(),{a,c}=await answered(h);await a.run('callLeave',{callId:c.callId});const rings=h.events.filter(x=>x.event==='callIncoming').length;await a.run('callStart',{toId:'bob',requestId:'req-b'});
 assert.equal(h.calls.size,1);assert.equal(c.participants.size,2);assert.equal(h.events.filter(x=>x.event==='callIncoming').length,rings);const started=h.events.filter(x=>x.event==='callStarted').at(-1).payload;assert.equal(started.answered,true);assert.equal(started.requestId,'req-b');
});
test('DM: last departure closes the session and clears both summaries',async()=>{
 const h=serverHarness(),{a,b,c}=await answered(h);await a.run('callLeave',{callId:c.callId});await b.run('callLeave',{callId:c.callId});assert.equal(h.calls.size,0);assert.equal(h.callsByChat.size,0);
 for(const uid of ['alice','bob'])assert.equal(h.events.filter(x=>x.event==='dmVoiceState'&&x.targets.includes(uid)).at(-1).payload.callId,null);
});
test('DM: leaver is free to join another conversation, remaining user stays busy',async()=>{
 const h=serverHarness(),{a,c}=await answered(h);await a.run('callLeave',{callId:c.callId});assert.equal(h.busyUser('alice'),false);assert.equal(h.busyUser('bob'),true);await a.run('callStart',{toId:'carol'});assert.equal(h.calls.size,2);await assert.rejects(()=>a.run('callJoin',{callId:c.callId}),/Занято/);
});
test('Unanswered outgoing call still cancels immediately',async()=>{
 const h=serverHarness(),a=h.socket('alice');await a.run('callStart',{toId:'bob'});const c=[...h.calls.values()][0];await a.run('callLeave',{callId:c.callId});assert.equal(h.calls.size,0);assert.ok(h.events.some(x=>x.event==='callCancelled'));
});
test('Group: remaining participant is not evicted by a timer',async()=>{
 const h=serverHarness(),a=h.socket('alice'),b=h.socket('bob');await a.run('callStart',{groupId:gid});const c=[...h.calls.values()][0];await b.run('callJoin',{callId:c.callId});await a.run('callLeave',{callId:c.callId});h.time.tick(600000);assert.equal(h.calls.get(c.callId),c);assert.deepEqual([...c.participants],['bob']);
});
test('Group: empty transport expires safely and can be recreated',async()=>{
 const h=serverHarness(),a=h.socket('alice');await a.run('callStart',{groupId:gid});const c=[...h.calls.values()][0];await a.run('callLeave',{callId:c.callId});h.time.tick(61000);assert.equal(h.calls.size,0);await a.run('callStart',{groupId:gid});assert.equal(h.calls.size,1);assert.notEqual([...h.calls.keys()][0],c.callId);
});
test('Group: rejoining before empty cleanup cancels the cleanup',async()=>{
 const h=serverHarness(),a=h.socket('alice');await a.run('callStart',{groupId:gid});const c=[...h.calls.values()][0];await a.run('callLeave',{callId:c.callId});h.time.tick(30000);await a.run('callJoin',{callId:c.callId});h.time.tick(60000);assert.equal(h.calls.get(c.callId),c);
});
test('Unexpected disconnect grace removes only the missing participant',async()=>{
 const h=serverHarness(),{c}=await answered(h);c.peers.delete('alice');h.scheduleLeave(c,'alice');h.time.tick(61000);assert.equal(h.calls.get(c.callId),c);assert.deepEqual([...c.participants],['bob']);
});
test('Reconnect before grace replaces socket and cancels removal',async()=>{
 const h=serverHarness(),{c}=await answered(h);c.peers.delete('alice');h.scheduleLeave(c,'alice');const replacement=h.socket('alice','alice-2');await replacement.run('callJoin',{callId:c.callId,rejoin:true});h.time.tick(61000);assert.equal(c.peers.get('alice'),'alice-2');assert.equal(c.participants.size,2);
});
test('Old device cannot hang up the replacement device',async()=>{
 const h=serverHarness(),{a,c}=await answered(h);const replacement=h.socket('alice','alice-2');await replacement.run('callJoin',{callId:c.callId});await a.run('callLeave',{callId:c.callId});assert.equal(c.peers.get('alice'),'alice-2');assert.equal(c.participants.size,2);
});
test('Watching a DM rechecks access before exposing voice state',async()=>{
 const h=serverHarness(),{a,c}=await answered(h);await a.run('watchDmVoice',{peerId:'bob'});assert.equal(h.events.at(-1).payload.callId,c.callId);await assert.rejects(()=>a.run('watchDmVoice',{peerId:'blocked'}),/forbidden/);
});
function func(name,source=client){const re=new RegExp('(?:async )?function '+name+'\\(');const start=source.search(re);assert.ok(start>=0,name);const end=source.indexOf('\n}\n',start);return source.slice(start,end+2)}
function event(name,source=client){const start=source.indexOf("socket.on('"+name+"',");assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n});',start)+4)}
function clientHarness(){
 const time=clock(),sent=[],handlers={},buttons={},labels={},stops=[];
 const elements={'dm-voice-bar':{style:{}},'btn-rejoin-dm-voice':{}};
 const state={me:{id:'alice'},sessionRevision:0,seq:{profile:0},activeFriend:'bob',activeGroup:null,groups:{},friends:{bob:{nickname:'Bob'}},voiceRejoin:{},groupVoiceCalls:{},dmVoiceCalls:{}};
 const callState={active:false,callId:null,isGroup:false,peers:{},pendingIncoming:null,micOn:true,camOn:true};
 const stream={getTracks:()=>[{stop:()=>stops.push('mic')}],getAudioTracks:()=>[],getVideoTracks:()=>[]};
 const ctx=vm.createContext({state,callState,console,window:{},Object,Array,Date,Set,...time,clearInterval:()=>{},
 callStarting:false,pendingStartRequestId:null,startRequestSequence:0,screenShareNegotiationTimer:null,screenShareTrack:null,screenShareStream:null,screenShareStopping:false,
 socket:{connected:true,on:(e,f)=>handlers[e]=f,emit:(event,payload)=>sent.push({event,payload})},
 $:id=>elements[id]||null,on:(id,e,f)=>buttons[id]=f,setText:(id,t)=>labels[id]=t,setDisplay:()=>{},
 sfx:{leave(){},join(){},stopRing(){},startRing(){}},showTransientNotice(){},renderGroupsList(){},updateGroupVoiceBar(){},stopCallTimer(){},clearPeerWait(){},stopAllSpeakingMonitors(){},updateScreenShareUI(){},resetCallControls(){},closePeerConnection(){},
 renderCallGrid(){},callPeerName:()=> 'Bob',teardownPeer:id=>delete callState.peers[id],offerToParticipants:()=>{},dismissIncomingCall(){},
 openCallOverlay:()=>{callState.active=true},acquireLocalStream:async()=>stream,mediaErrorMessage:e=>e.message,CALL_RING_TIMEOUT_MS:90000});
 const names=['stopStream','callBusy','beginCallSession','startCall','startExistingCall','joinExistingGroupVoice','rememberGroupVoice','clearGroupVoiceRejoin','restoreGroupVoiceRejoin','hangupCall','closeCallOverlay','startPeerWait','updateDmVoiceBar','receiveDmVoice'];
 vm.runInContext(names.map(n=>func(n)).join('\n'),ctx);
 for(const e of ['callStarted','callJoined','callPeerLeft','callLeft','callError','callEnded','callCancelled','dmVoiceSnapshot'])vm.runInContext(event(e),ctx);
 handlers.dmVoiceState=ctx.receiveDmVoice;
 vm.runInContext(event('groupVoiceState',auth),ctx);
 ctx.window.clearGroupVoiceRejoin=ctx.clearGroupVoiceRejoin;
 ctx.window.rememberGroupVoice=ctx.rememberGroupVoice;
 return {ctx,state,callState,time,sent,handlers,elements,labels,stops,stream};
}
test('Client: leaving stops microphone, preserves DM rejoin entry, removes own participant badge',()=>{
 const h=clientHarness();Object.assign(h.callState,{active:true,callId:'room',peerFriendId:'bob',localStream:h.stream});h.state.dmVoiceCalls.bob={callId:'room',participants:['alice','bob']};h.ctx.hangupCall();assert.equal(h.callState.active,false);assert.equal(h.stops.length,1);assert.deepEqual([...h.state.dmVoiceCalls.bob.participants],['bob']);assert.equal(h.elements['dm-voice-bar'].style.display,'flex');assert.equal(h.elements['btn-rejoin-dm-voice'].disabled,false);assert.equal(h.sent[0].event,'callLeave');
});
test('Client: DM rejoin requests same call ID without ringing or callStart',async()=>{
 const h=clientHarness();h.state.dmVoiceCalls.bob={callId:'room',video:false,participants:['bob']};await h.ctx.startCall({toId:'bob',video:false});assert.equal(h.callState.callId,'room');assert.equal(h.callState.peerFriendId,'bob');assert.equal(h.callState.isGroup,false);assert.deepEqual(h.sent.map(x=>x.event),['callJoin']);
});
test('Client: waiting alone never creates a hangup timer',()=>{
 const h=clientHarness();Object.assign(h.callState,{active:true,callId:'room',peerFriendId:'bob'});h.handlers.callPeerLeft({callId:'room',peerId:'bob'});h.time.tick(600000);assert.equal(h.callState.active,true);assert.match(h.labels['call-overlay-status'],/ожидание/);assert.equal(h.sent.length,0);
});
test('Client: server null group state clears stale ID instead of resurrecting cache',()=>{
 const h=clientHarness();h.ctx.rememberGroupVoice(gid,'ended');h.handlers.groupVoiceState({groupId:gid,callId:null});assert.equal(h.state.groupVoiceCalls[gid],undefined);assert.equal(h.state.voiceRejoin[gid],undefined);
});
test('Client: group cache cannot delete a still-live room after a minute',()=>{
 const h=clientHarness();h.ctx.rememberGroupVoice(gid,'live');h.time.tick(600000);assert.equal(h.state.groupVoiceCalls[gid].callId,'live');
});
test('Client: cancelling before callStarted leaves the delayed server session',async()=>{
 const h=clientHarness();await h.ctx.startCall({toId:'bob'});const req=h.sent.find(x=>x.event==='callStart').payload.requestId;h.ctx.hangupCall();h.handlers.callStarted({callId:'late',requestId:req,participants:[]});assert.equal(h.sent.at(-1).event,'callLeave');assert.equal(h.sent.at(-1).payload.callId,'late');assert.equal(h.callState.active,false);
});
test('Client: late reply cannot hijack a newer start',async()=>{
 const h=clientHarness();await h.ctx.startCall({toId:'bob'});const old=h.sent.at(-1).payload.requestId;h.ctx.hangupCall();await h.ctx.startCall({toId:'carol'});const current=h.sent.at(-1).payload.requestId;h.handlers.callStarted({callId:'old-room',requestId:old});assert.equal(h.callState.callId,null);h.handlers.callStarted({callId:'new-room',requestId:current,participants:[]});assert.equal(h.callState.callId,'new-room');
});
test('Client: hangup during callJoin leaves a delayed joined session',()=>{
 const h=clientHarness();h.handlers.callJoined({callId:'late-join',participants:[]});assert.equal(h.sent[0].event,'callLeave');
});
test('Client: reconnect snapshot clears dead DM rooms and restores live rooms',()=>{
 const h=clientHarness();h.state.dmVoiceCalls.carol={callId:'dead'};h.handlers.dmVoiceSnapshot([{peerId:'bob',callId:'live',participants:['bob']}]);assert.equal(h.state.dmVoiceCalls.carol,undefined);assert.equal(h.state.dmVoiceCalls.bob.callId,'live');assert.equal(h.elements['dm-voice-bar'].style.display,'flex');h.handlers.dmVoiceSnapshot([]);assert.equal(h.elements['dm-voice-bar'].style.display,'none');
});
test('Client: delayed microphone permission after logout cannot start a new call',async()=>{
 const h=clientHarness();let resolve;h.ctx.acquireLocalStream=()=>new Promise(r=>resolve=r);const pending=h.ctx.startCall({toId:'bob'});h.state.sessionRevision++;resolve(h.stream);await pending;assert.equal(h.callState.active,false);assert.equal(h.sent.length,0);assert.equal(h.stops.length,1);
});
test('Client: ending a room while awaiting microphone permission aborts rejoin',async()=>{
 const h=clientHarness();h.state.dmVoiceCalls.bob={callId:'room',participants:['bob']};let resolve;h.ctx.acquireLocalStream=()=>new Promise(r=>resolve=r);const pending=h.ctx.startCall({toId:'bob'});delete h.state.dmVoiceCalls.bob;resolve(h.stream);await pending;assert.equal(h.sent.length,0);assert.equal(h.stops.length,1);
});
test('Client: transient signaling errors do not tear down live media',()=>{
 const h=clientHarness();Object.assign(h.callState,{active:true,callId:'room',localStream:h.stream});h.handlers.callError({event:'callSignal',reason:'rate_limited',callId:'room'});assert.equal(h.callState.active,true);assert.equal(h.stops.length,0);
});
test('Client: group removal explicitly stops local media',()=>{
 const h=clientHarness();Object.assign(h.callState,{active:true,callId:'room',isGroup:true,groupId:gid,localStream:h.stream});h.handlers.callLeft({callId:'room',reason:'kicked'});assert.equal(h.callState.active,false);assert.equal(h.stops.length,1);
});
test('Profile body ID exists exactly once; voice entry and cache version exist',()=>{
 const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');assert.equal((html.match(/id="profile-modal-body"/g)||[]).length,1);assert.match(html,/id="btn-rejoin-dm-voice"/);assert.doesNotMatch(html,/v=discord-3/);
});

test('Server: delayed cancellation cannot remove a newer start in the same group',async()=>{
 const h=serverHarness(),a=h.socket('alice');await a.run('callStart',{groupId:gid,requestId:'old'});const c=[...h.calls.values()][0];await a.run('callStart',{groupId:gid,requestId:'new'});await a.run('callLeave',{callId:c.callId,requestId:'old'});assert.equal(c.participants.has('alice'),true);await a.run('callLeave',{callId:c.callId,requestId:'new'});assert.equal(c.participants.has('alice'),false);
});
test('Client: late manual-leave acknowledgement cannot close a rejoin',()=>{
 const h=clientHarness();Object.assign(h.callState,{active:true,callId:'room',localStream:h.stream});h.handlers.callLeft({callId:'room',reason:'left'});assert.equal(h.callState.active,true);assert.equal(h.stops.length,0);
});
test('Client: ending another group session cannot erase current voice state',()=>{
 const h=clientHarness();h.state.groupVoiceCalls.old={callId:'old-room',participants:[]};h.state.groupVoiceCalls.current={callId:'current-room',participants:['alice']};Object.assign(h.callState,{active:true,callId:'current-room',isGroup:true,groupId:'current'});h.handlers.callEnded({callId:'old-room',reason:'timeout'});assert.equal(h.state.groupVoiceCalls.old,undefined);assert.equal(h.state.groupVoiceCalls.current.callId,'current-room');assert.equal(h.callState.active,true);
});
test('Client: background group broadcast does not hide current voice bar',()=>{
 const source=fs.readFileSync(path.join(root,'public/js/chat-ui.js'),'utf8');const bar={style:{}},join={};const ctx=vm.createContext({state:{activeGroup:gid,groupVoiceCalls:{},groups:{}},callState:{active:false},$:id=>id==='group-voice-bar'?bar:id==='btn-join-group-voice'?join:null,setText(){},plural:n=>String(n)});vm.runInContext(func('updateGroupVoiceBar',source),ctx);ctx.updateGroupVoiceBar('another-group');assert.equal(bar.style.display,'flex');assert.equal(join.disabled,false);
});
test('Client: missing DM session is removed instead of offering a broken rejoin',()=>{
 const h=clientHarness();h.state.dmVoiceCalls.bob={callId:'dead',participants:['bob']};Object.assign(h.callState,{active:true,callId:'dead',localStream:h.stream});h.handlers.callError({event:'callJoin',callId:'dead',reason:'not_found'});assert.equal(h.state.dmVoiceCalls.bob,undefined);assert.equal(h.callState.active,false);
});
