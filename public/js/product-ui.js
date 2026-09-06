'use strict';
// Shared by the new navigation entry points; the legacy observer remains local.
function syncMembersDisclosure() {
  const panel=document.getElementById('group-members-panel');
  document.getElementById('btn-toggle-members')?.setAttribute('aria-expanded',String(!!panel&&!panel.classList.contains('hidden')));
}
'use strict';
/* Product presentation module. Existing authentication, API, delivery, storage and
 * WebRTC implementations remain the source of truth. Loaded after their modules.
 * Overrides are deliberately contained here to keep the upstream files unchanged. */
(() => {
  const q = id => document.getElementById(id);
  const svg = (path, size = 24) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  const icons = {
    close: svg('<path d="m6 6 12 12M6 18 18 6"/>',16),
    more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    check: svg('<path d="m5 12 4 4L19 6"/>'),
    image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 3-3 6 6"/>'),
    discord: document.querySelector('.sidebar-tab[data-stab="dm"] svg').outerHTML,
  };
  let friendsTab = 'online';
  let renderScheduled = false;
  let currentAccount = null;
  let hiddenDms = new Set();
  let micMuted = false, deafened = false;
  let lastAttachmentUrl = new Map();
  function accountKey(suffix) { return `chatapp_product:${state.me?.id || 'guest'}:${suffix}`; }
  function syncAccount() {
    const id = state.me?.id || null;
    if (currentAccount === id) return;
    currentAccount = id;
    try { const raw = JSON.parse(storage.getItem(accountKey('hidden')) || '[]'); hiddenDms = new Set(Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : []); }
    catch { hiddenDms = new Set(); }
    micMuted = storage.getItem(accountKey('mic')) === 'off';
    deafened = storage.getItem(accountKey('audio')) === 'off';
    friendsTab = 'online';
    updateUserControls();
  }
  function saveHidden() { storage.setItem(accountKey('hidden'), JSON.stringify([...hiddenDms])); }
  function revealDm(id) { syncAccount(); if (hiddenDms.delete(id)) saveHidden(); }
  function hideDm(id) {
    syncAccount(); hiddenDms.add(id); saveHidden();
    if (state.activeFriend === id) showFriendsPage();
    renderFriendsList();
    const next = q('friends-list').querySelector('.friend-item') || document.querySelector('[data-stab="dm"]');
    next?.focus({preventScroll:true});
  }
  function scheduleFriends() {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => { renderScheduled = false; renderFriendsPage(); });
  }
  const originalAvatar = renderAv;
  renderAv = function(el, nickname, avatarUrl) {
    originalAvatar(el, nickname, avatarUrl);
    if (!el) return;
    const palette = ['var(--blurple)','var(--green)','var(--red)','var(--yellow)'];
    const hash = Array.from(String(nickname || '')).reduce((n,c) => (n * 31 + c.codePointAt(0)) >>> 0,0) % palette.length;
    el.style.background = palette[hash];
    el.style.color = hash === 3 ? 'var(--dark)' : 'var(--bright)';
  };
  renderAvWithDot = function(el, nickname, avatarUrl, online) {
    renderAv(el,nickname,avatarUrl);
    if (!el) return;
    el.style.position = 'relative'; el.style.overflow = 'visible';
    const dot = document.createElement('span');
    dot.className = 'f-dot' + (online ? '' : ' offline');
    dot.title = online ? 'В сети' : 'Не в сети';
    el.appendChild(dot);
  };
  renderGroupAv = function(el, group) {
    if (!el) return;
    el.replaceChildren();el.classList.add('group-av');
    const members = Array.isArray(group?.members) ? group.members.slice(0,3) : [];
    if (!members.length) { el.textContent = av(group?.name); return; }
    const grid = document.createElement('div');grid.className = `group-av-grid g${members.length}`;
    for (const member of members) {
      const cell = document.createElement('div');cell.className = 'group-av-cell';
      renderAv(cell,member.nickname || member.id,member.avatar);grid.appendChild(cell);
    }
    el.appendChild(grid);
  };
  buildFriendEl = function(id) {
    const f = state.friends[id]; if (!f) return null;
    const unread = state.unread[id] || 0;
    const el = document.createElement('div');
    el.className = 'friend-item' + (state.activeFriend === id ? ' active' : '') + (unread ? ' unread' : '');
    el.dataset.fid = id; el.setAttribute('role','listitem');
    const open = document.createElement('button');open.type='button';open.className='dm-open';
    open.setAttribute('aria-label',`Открыть переписку с ${f.nickname || id}${unread ? `, непрочитанных: ${unread}` : ''}`);
    open.innerHTML=`<span class="f-av" aria-hidden="true"></span><span class="f-info"><span class="f-nick">${esc(f.nickname || id)}</span></span>${unread ? `<span class="f-unread">${unread > 99 ? '99+' : unread}</span>` : ''}`;
    renderAvWithDot(open.querySelector('.f-av'), f.nickname || id, f.avatar, f.online);
    open.addEventListener('click',() => openChat(id));
    const close = document.createElement('button');close.type='button';close.className='dm-close';close.innerHTML=icons.close;
    close.title='Закрыть личное сообщение';close.setAttribute('aria-label',`Закрыть переписку с ${f.nickname || id}`);
    close.addEventListener('click',() => hideDm(id));
    el.append(open,close); return el;
  };
  renderFriendsList = function() {
    syncAccount(); const list=q('friends-list'); if(!list) return;
    const focusedId=document.activeElement?.closest('[data-fid]')?.dataset.fid;
    const wasClose=document.activeElement?.classList.contains('dm-close');
    const ids=sortedFriendIds().filter(id => !hiddenDms.has(id));
    list.replaceChildren();
    if (!ids.length) { const hint=document.createElement('div');hint.className='sidebar-note';hint.textContent='Начните беседу в разделе «Друзья».';list.appendChild(hint); }
    else for(const id of ids){ const el=buildFriendEl(id);if(el) list.appendChild(el); }
    if(focusedId) list.querySelector(`[data-fid="${CSS.escape(focusedId)}"] ${wasClose ? '.dm-close' : '.dm-open'}`)?.focus({preventScroll:true});
    updateTitleBadge();scheduleFriends();
  };
  refreshFriendItem = function(id) {
    syncAccount(); if(hiddenDms.has(id) && state.unread[id]) revealDm(id);
    const list=q('friends-list');if(!list) return;
    const old=list.querySelector(`[data-fid="${CSS.escape(id)}"]`);
    if(hiddenDms.has(id) || !state.friends[id]) { old?.remove(); scheduleFriends();return; }
    if(list.querySelector('.sidebar-note')) {renderFriendsList();return;}
    const fresh=buildFriendEl(id);
    if(old){const focused=old.contains(document.activeElement);old.replaceWith(fresh);if(focused)fresh.querySelector('.dm-open')?.focus({preventScroll:true});}
    else list.appendChild(fresh);
    updateTitleBadge();scheduleFriends();
  };
  const originalRequests = renderRequests;
  renderRequests = function(reqs) { originalRequests(reqs);scheduleFriends(); };
  const originalPlaceholder = showChatPlaceholder;
  showChatPlaceholder = function() {originalPlaceholder();scheduleFriends();syncNav();};
  const originalOpenChat = openChat;
  openChat = async function(id) {
    revealDm(id);closeTransientUI();
    switchSidebarTab('dm');
    const pending = originalOpenChat(id);
    syncNav();showMobileMain();
    return pending;
  };
  const originalOpenGroup = openGroupChat;
  openGroupChat = async function(id) {
    closeTransientUI();switchSidebarTab('groups');
    const pending=originalOpenGroup(id);
    syncNav();showMobileMain();
    q('group-members-panel')?.classList.add('hidden');syncMembersDisclosure();
    return pending;
  };
  function syncNav() {
    const dm=document.querySelector('[data-stab="dm"]');
    if(dm)dm.classList.toggle('active',!state.activeFriend && !state.activeGroup && q('groups-panel')?.style.display==='none');
  }
  function showMobileMain(){
    document.querySelector('.chat-main')?.classList.remove('hidden');
    if(innerWidth<=640){document.querySelector('.sidebar')?.classList.add('hidden');document.querySelector('.chat-main')?.classList.add('mobile-visible');}
  }
  function showFriendsPage(tab) {
    closeTransientUI();switchSidebarTab('dm');closeActiveChat();
    if(tab)friendsTab=tab;
    renderFriendsPage();syncNav();showMobileMain();
  }
  document.querySelector('[data-stab="dm"]').addEventListener('click',()=>showFriendsPage());
  q('btn-friends-back').addEventListener('click',()=>{
    document.querySelector('.sidebar').classList.remove('hidden');
    document.querySelector('.chat-main').classList.remove('mobile-visible');
  });
  for(const id of ['btn-back','btn-back-group'])q(id).addEventListener('click',()=>document.querySelector('.chat-main').classList.remove('mobile-visible'));
  window.addEventListener('resize',()=>{
    if(innerWidth>640){document.querySelector('.sidebar').classList.remove('hidden');document.querySelector('.chat-main').classList.remove('hidden','mobile-visible');}
    else if(state.activeFriend || state.activeGroup)showMobileMain();
    closeTransientUI();
  });
  function actionButton(label,icon,handler,cls=''){
    const b=document.createElement('button');b.type='button';b.className=cls;b.title=label;b.setAttribute('aria-label',label);b.innerHTML=icon;b.addEventListener('click',handler);return b;
  }
  function friendRow(id) {
    const f=state.friends[id],row=document.createElement('div');
    row.className='friend-row';row.dataset.friendId=id;row.setAttribute('role','listitem');
    row.innerHTML=`<div class="f-av" aria-hidden="true"></div><div class="friend-row-info"><span class="friend-row-name">${esc(f.nickname || id)}</span><span class="friend-row-status">${f.online ? 'В сети' : 'Не в сети'}</span></div><div class="friend-row-actions"></div>`;
    renderAvWithDot(row.querySelector('.f-av'),f.nickname||id,f.avatar,f.online);
    row.querySelector('.friend-row-actions').append(actionButton('Сообщение',icons.discord,()=>openChat(id)),actionButton('Другие действия',icons.more,e=>showFriendMenu(id,e.currentTarget)));
    row.addEventListener('dblclick',e=>{if(!e.target.closest('button'))openChat(id);});return row;
  }
  function pendingRow(request){
    const id=getReqId(request);if(!id)return null;
    const row=document.createElement('div');row.className='friend-row';row.setAttribute('role','listitem');
    const nick=request.nickname||id;
    row.innerHTML=`<div class="f-av" aria-hidden="true"></div><div class="friend-row-info"><span class="friend-row-name">${esc(nick)}</span><span class="friend-row-status">Входящая заявка · @${esc(id)}</span></div><div class="friend-row-actions"></div>`;
    renderAv(row.querySelector('.f-av'),nick,request.avatar);
    async function respond(accept){
      const buttons=[...row.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
      try{await socketRequest(accept?'acceptFriendRequest':'declineFriendRequest',id);removeFriendRequest(id);scheduleFriends();}
      catch(e){showTransientNotice(FRIEND_REQUEST_ERRORS[e.reason]||e.message);buttons.forEach(b=>b.disabled=false);}
    }
    row.querySelector('.friend-row-actions').append(actionButton('Принять заявку',icons.check,()=>respond(true),'accept'),actionButton('Отклонить заявку',icons.close,()=>respond(false),'reject'));return row;
  }
  function renderFriendsPage(){
    syncAccount();const directory=q('friends-directory');if(!directory)return;
    const reqs=(state.me?.friendRequests||[]).filter(r=>getReqId(r));
    q('pending-count').textContent=reqs.length?String(reqs.length):'';
    document.querySelectorAll('[data-friends-tab]').forEach(tab=>{const active=tab.dataset.friendsTab===friendsTab;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
    directory.setAttribute('aria-labelledby','friends-tab-'+friendsTab);
    q('friends-add').hidden=friendsTab!=='add';q('friends-results').hidden=friendsTab==='add';
    if(friendsTab==='add')return;
    const rows=q('friends-rows');const focused=document.activeElement;
    const focusedId=focused?.closest('[data-friend-id]')?.dataset.friendId;const actionIndex=focused?.parentElement?.classList.contains('friend-row-actions')?[...focused.parentElement.children].indexOf(focused):-1;
    rows.replaceChildren();
    if(friendsTab==='pending'){
      q('friends-count').textContent=`Ожидание · ${reqs.length}`;
      reqs.forEach(r=>{const row=pendingRow(r);if(row)rows.appendChild(row);});
    }else{
      const ids=Object.keys(state.friends).filter(id=>friendsTab==='all'||state.friends[id].online).sort((a,b)=>(state.friends[a].nickname||a).localeCompare(state.friends[b].nickname||b,'ru'));
      q('friends-count').textContent=`${friendsTab==='online'?'В сети':'Все друзья'} · ${ids.length}`;
      ids.forEach(id=>rows.appendChild(friendRow(id)));
    }
    if(!rows.children.length){const empty=document.createElement('p');empty.className='friends-empty';empty.textContent=friendsTab==='pending'?'Нет входящих запросов в друзья.':friendsTab==='online'?'Сейчас никто из друзей не в сети.':'Пока нет друзей. Добавьте друга по ID.';rows.appendChild(empty);}
    if(focusedId && actionIndex>=0)rows.querySelector(`[data-friend-id="${CSS.escape(focusedId)}"] .friend-row-actions`)?.children[actionIndex]?.focus({preventScroll:true});
  }
  const friendTabs=[...document.querySelectorAll('[data-friends-tab]')];
  friendTabs.forEach((tab,index)=>{
    tab.addEventListener('click',()=>{friendsTab=tab.dataset.friendsTab;renderFriendsPage();if(friendsTab==='add')q('add-friend-id').focus();});
    tab.addEventListener('keydown',e=>{let next;if(e.key==='ArrowRight')next=(index+1)%friendTabs.length;else if(e.key==='ArrowLeft')next=(index+friendTabs.length-1)%friendTabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=friendTabs.length-1;else return;e.preventDefault();friendTabs[next].click();friendTabs[next].focus();});
  });
  q('add-friend-form').addEventListener('submit',async e=>{
    e.preventDefault();const button=q('btn-add-by-id'),feedback=q('add-friend-feedback');if(button.disabled)return;
    const id=q('add-friend-id').value.trim().replace(/^@/,'').toLowerCase();
    feedback.classList.remove('error');feedback.textContent='';
    if(!ID_RE.test(id)){feedback.classList.add('error');feedback.textContent='ID: от 3 до 30 символов, латинские буквы, цифры и _.';return;}
    if(id===state.me?.id){feedback.classList.add('error');feedback.textContent='Нельзя добавить себя в друзья.';return;}
    button.disabled=true;button.setAttribute('aria-busy','true');
    try{const result=await socketRequest('sendFriendRequest',id);feedback.textContent=result.status==='friends'?'Пользователь уже в друзьях.':`Запрос дружбы отправлен @${id}.`;}
    catch(error){feedback.classList.add('error');feedback.textContent=FRIEND_REQUEST_ERRORS[error.reason]||error.message;}
    finally{button.disabled=false;button.removeAttribute('aria-busy');}
  });
  function placePopover(el,anchor,above=true){
    const r=anchor.getBoundingClientRect();const b=el.getBoundingClientRect();
    const x=Math.max(8,Math.min(innerWidth-b.width-8,r.right-b.width));
    let y=above?r.top-b.height-8:r.bottom+6;
    if(y<8)y=Math.min(r.bottom+8,innerHeight-b.height-8);
    el.style.left=x+'px';el.style.top=Math.max(8,Math.min(y,innerHeight-b.height-8))+'px';
  }
  function showFriendMenu(id,anchor){
    const menu=q('friend-menu');menu.replaceChildren();
    for(const [label,handler] of [['Сообщение',()=>openChat(id)],['Профиль',()=>showUserProfile(id)],['Скопировать ID',async()=>{try{await navigator.clipboard.writeText(id);showTransientNotice('ID скопирован');}catch{showTransientNotice('Не удалось скопировать ID');}}]]){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');button.addEventListener('click',()=>{menu.hidePopover();handler();});menu.appendChild(button);
    }
    menu.showPopover();placePopover(menu,anchor,false);menu.firstElementChild.focus();
    menu.onkeydown=e=>{const items=[...menu.children];const i=items.indexOf(document.activeElement);if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();items[(i+(e.key==='ArrowDown'?1:items.length-1))%items.length].focus();}if(e.key==='Escape')anchor.focus();};
  }
  /* Message grouping has a strict 7 minute forward-time window. */
  shouldGroupMsg = function(container,senderId,timeMs){
    const last=container.lastElementChild;if(!last||last.dataset.sender!==String(senderId))return false;
    const lastTime=Number(last.dataset.time);const delta=timeMs-lastTime;
    return Number.isFinite(lastTime)&&delta>=0&&delta<7*60*1000;
  };
  renderChatWelcome = function(box,{nick,avatar,group}){
    const w=document.createElement('div');w.className='chat-welcome';
    w.innerHTML=`<div class="chat-welcome-av" aria-hidden="true"></div><div class="chat-welcome-title">${esc(nick)}</div><div class="chat-welcome-sub">${group ? 'Это начало вашей переписки в группе '+esc(nick)+'.' : 'Это начало вашей личной переписки с @'+esc(nick)+'.'}</div>`;
    if(group)renderGroupAv(w.firstElementChild,group);else renderAv(w.firstElementChild,nick,avatar);box.appendChild(w);
  };
  updateGroupChatHeader=function(g){if(!g)return;renderGroupAv(q('group-chat-avatar'),g);setText('group-chat-name',g.name);setText('group-chat-members-count',`Участников: ${(g.members||[]).length}`);};
  const originalFormat=formatMsgText;
  formatMsgText=function(raw){
    const template=document.createElement('template');template.innerHTML=originalFormat(raw);
    const walker=document.createTreeWalker(template.content,NodeFilter.SHOW_TEXT);const nodes=[];
    while(walker.nextNode()){const n=walker.currentNode;if(!n.parentElement?.closest('a,code,pre'))nodes.push(n);}
    for(const node of nodes){
      const text=node.textContent,re=/(^|[^\p{L}\p{N}_@])@([a-z0-9_]{3,30})(?![a-z0-9_])/giu;let match,last=0;const frag=document.createDocumentFragment();let changed=false;
      while((match=re.exec(text))){const start=match.index+match[1].length;frag.appendChild(document.createTextNode(text.slice(last,start)));const mention=document.createElement('button');mention.type='button';mention.className='md-mention';mention.dataset.mention=match[2].toLowerCase();mention.textContent='@'+match[2];frag.appendChild(mention);last=start+match[2].length+1;changed=true;}
      if(changed){frag.appendChild(document.createTextNode(text.slice(last)));node.replaceWith(frag);}
    }
    return template.innerHTML;
  };
  document.addEventListener('click',e=>{const mention=e.target.closest('.md-mention');if(mention){if(mention.dataset.mention===state.me?.id)openEditProfileModal();else showUserProfile(mention.dataset.mention);}});
  document.addEventListener('error',event=>{
    const image=event.target;if(!(image instanceof HTMLImageElement)||!image.classList.contains('message-image'))return;
    const stub=document.createElement('div');stub.className='image-unavailable';stub.setAttribute('role','img');stub.setAttribute('aria-label','Изображение не загрузилось');stub.innerHTML=icons.image;image.replaceWith(stub);
  },true);
  /* Autosize and attachment previews never change delivery or retry semantics. */
  refreshComposer=function(group){
    const input=q(group?'group-msg-input':'msg-input'),button=q(group?'btn-group-send':'btn-send');
    if(input){delete input.dataset.sending;input.style.height='auto';input.style.height=Math.max(44,Math.min(input.scrollHeight,200))+'px';input.style.overflowY=input.scrollHeight>200?'auto':'hidden';}
    renderAttachmentPreview(group);
    const busy=!!retryMessages.get(composerKey(group))?.inFlight;
    if(button){button.disabled=busy;if(busy)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');}
  };
  const originalPreview=renderAttachmentPreview;
  renderAttachmentPreview=function(group){
    originalPreview(group);const box=q(group?'group-attach-preview':'msg-attach-preview');
    const file=composerAttachments.get(composerKey(group));const old=lastAttachmentUrl.get(group);
    if(old && old.file!==file){URL.revokeObjectURL(old.url);lastAttachmentUrl.delete(group);}
    if(!file||!box)return;
    let record=lastAttachmentUrl.get(group);if(!record){record={file,url:URL.createObjectURL(file)};lastAttachmentUrl.set(group,record);}
    const img=document.createElement('img');img.src=record.url;img.alt='Предпросмотр вложения';img.className='attachment-thumb';box.prepend(img);
  };
  for(const group of [false,true]){
    const pre=group?'group-':'';const input=q(group?'group-msg-input':'msg-input');
    q('btn-'+pre+'image-extra').addEventListener('click',()=>q(group?'group-image-input':'msg-image-input').click());
    q('btn-'+pre+'gif').addEventListener('click',()=>q(pre+'gif-input').click());
    q(pre+'gif-input').addEventListener('change',e=>{const file=e.target.files?.[0];if(file){setComposerAttachment(group,file);showTransientNotice('GIF будет отправлен как статичное изображение.');}e.target.value='';});
    q('btn-'+pre+'emoji').addEventListener('click',e=>showEmojiPicker(input,e.currentTarget));
  }
  function showEmojiPicker(input,anchor){
    const picker=q('emoji-picker');if(picker.matches(':popover-open')){picker.hidePopover();return;}
    picker.innerHTML='<h2>Эмодзи</h2><div class="emoji-grid"></div>';
    const entries=[['😀','Улыбка'],['😄','Радость'],['😁','Сияющая улыбка'],['😂','Смех'],['🤣','Очень смешно'],['😊','Смущение'],['🙂','Лёгкая улыбка'],['😉','Подмигивание'],['😍','Влюблённость'],['🥰','Нежность'],['😘','Поцелуй'],['😎','Круто'],['🤔','Думаю'],['🤨','Сомнение'],['😴','Сон'],['😢','Грусть'],['😭','Слёзы'],['😡','Злость'],['🤯','Шок'],['🥳','Праздник'],['🙃','Вверх ногами'],['👍','Нравится'],['👎','Не нравится'],['👋','Привет'],['👏','Аплодисменты'],['🙌','Ура'],['🙏','Спасибо'],['🤝','Договорились'],['❤️','Сердце'],['💜','Фиолетовое сердце'],['🔥','Огонь'],['🎉','Поздравление'],['✨','Искры'],['✅','Готово'],['💯','Сто процентов'],['🚀','Ракета'],['👀','Смотрю'],['💡','Идея'],['☕','Кофе'],['🎮','Игра'],['📷','Фото'],['🎵','Музыка']];
    const start=input.selectionStart,end=input.selectionEnd;
    for(const [emoji,label] of entries){const b=document.createElement('button');b.type='button';b.textContent=emoji;b.title=label;b.setAttribute('aria-label',label);b.addEventListener('click',()=>{if(input.value.length-(end-start)+emoji.length>MAX_MESSAGE_LENGTH)return;input.setRangeText(emoji,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));picker.hidePopover();input.focus();});picker.lastElementChild.appendChild(b);}
    picker.showPopover();placePopover(picker,anchor);picker.querySelector('button').focus();
    picker.onkeydown=e=>{const all=[...picker.querySelectorAll('button')],i=all.indexOf(document.activeElement);let n;if(e.key==='ArrowRight')n=i+1;else if(e.key==='ArrowLeft')n=i-1;else if(e.key==='ArrowDown')n=i+7;else if(e.key==='ArrowUp')n=i-7;else if(e.key==='Escape'){input.focus();return;}else return;e.preventDefault();all[(n+all.length)%all.length].focus();};
  }
  /* Account controls apply before tracks are published and to newly added audio. */
  function updateUserControls(){
    const mic=q('btn-user-mic'),audio=q('btn-user-deafen');if(!mic||!audio)return;
    mic.setAttribute('aria-pressed',String(micMuted||deafened));mic.title=micMuted||deafened?'Включить микрофон':'Выключить микрофон';mic.setAttribute('aria-label',mic.title);
    audio.setAttribute('aria-pressed',String(deafened));audio.title=deafened?'Включить звук':'Отключить звук';audio.setAttribute('aria-label',audio.title);
  }
  function applyAudioPreferences(){
    const enabled=!micMuted&&!deafened;
    callState.localStream?.getAudioTracks().forEach(track=>track.enabled=enabled);
    if(callState.localStream)callState.micOn=enabled;
    document.querySelectorAll('audio.call-tile-audio').forEach(audio=>audio.muted=deafened);
    updateUserControls();
    if(callState.active){renderCallGrid();broadcastMediaState();}
  }
  const originalBeginSession=beginCallSession;
  beginCallSession=function(options){originalBeginSession(options);syncAccount();const enabled=!micMuted&&!deafened;callState.localStream?.getAudioTracks().forEach(track=>track.enabled=enabled);callState.micOn=enabled;updateUserControls();};
  const originalTile=updateCallTile;
  updateCallTile=function(tile,info){originalTile(tile,info);const audio=tile.querySelector('audio.call-tile-audio');if(audio)audio.muted=deafened;};
  q('btn-user-mic').addEventListener('click',()=>{syncAccount();if(deafened)deafened=false;micMuted=!micMuted;storage.setItem(accountKey('mic'),micMuted?'off':'on');storage.setItem(accountKey('audio'),deafened?'off':'on');applyAudioPreferences();});
  q('btn-user-deafen').addEventListener('click',()=>{syncAccount();deafened=!deafened;storage.setItem(accountKey('audio'),deafened?'off':'on');applyAudioPreferences();});
  q('btn-call-toggle-mic')?.addEventListener('click',()=>{if(deafened){deafened=false;storage.setItem(accountKey('audio'),'on');}micMuted=!callState.micOn;storage.setItem(accountKey('mic'),micMuted?'off':'on');applyAudioPreferences();});
  /* Delayed tooltips, including dynamic message and call icons. */
  const tip=q('ui-tooltip');let tipTimer=null,tipTarget=null,descriptionBefore=null;
  function hideTooltip(){clearTimeout(tipTimer);if(tipTarget){if(descriptionBefore===null)tipTarget.removeAttribute('aria-describedby');else tipTarget.setAttribute('aria-describedby',descriptionBefore);}tipTarget=null;descriptionBefore=null;if(tip.matches(':popover-open'))tip.hidePopover();tip.hidden=true;}
  function showTooltip(target){
    hideTooltip();const label=target.getAttribute('title')||target.dataset.tooltip||target.getAttribute('aria-label');if(!label)return;
    if(target.hasAttribute('title')){target.dataset.tooltip=label;target.removeAttribute('title');}
    tipTimer=setTimeout(()=>{if(!target.isConnected)return;tipTarget=target;descriptionBefore=target.getAttribute('aria-describedby');target.setAttribute('aria-describedby',[descriptionBefore,'ui-tooltip'].filter(Boolean).join(' '));tip.textContent=label;tip.hidden=false;tip.showPopover();const r=target.getBoundingClientRect(),b=tip.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(innerWidth-b.width-8,r.left+r.width/2-b.width/2))+'px';tip.style.top=Math.max(4,r.top-b.height-9)+'px';},100);
  }
  document.addEventListener('pointerover',e=>{const t=e.target.closest('button[title],button[data-tooltip],.icon-btn[aria-label],.f-dot[title]');if(t&&!t.contains(e.relatedTarget))showTooltip(t);});
  document.addEventListener('pointerout',e=>{const t=e.target.closest('button,.f-dot');if(t&&!t.contains(e.relatedTarget))hideTooltip();});
  document.addEventListener('focusin',e=>{if(e.target.matches('button[title],button[data-tooltip]'))showTooltip(e.target);});
  document.addEventListener('focusout',hideTooltip);document.addEventListener('pointerdown',hideTooltip);document.addEventListener('scroll',hideTooltip,true);
  function closeTransientUI(){hideTooltip();for(const id of ['emoji-picker','friend-menu']){const el=q(id);if(el.matches(':popover-open'))el.hidePopover();}}
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hideTooltip();});
  window.addEventListener('storage',e=>{if(e.key===accountKey('hidden')){currentAccount=null;syncAccount();renderFriendsList();}});
  const originalLogout=forceLogoutToLogin;
  forceLogoutToLogin=function(...args){closeTransientUI();for(const record of lastAttachmentUrl.values())URL.revokeObjectURL(record.url);lastAttachmentUrl.clear();originalLogout(...args);currentAccount=null;hiddenDms.clear();q('friends-rows').replaceChildren();};
  // User-generated data is never seeded here. First render uses the restored account only.
  syncAccount();renderFriendsList();renderFriendsPage();
  if(state.me)renderAv(q('my-avatar'),state.me.nickname,state.me.avatar);
  q('group-members-panel')?.classList.add('hidden');
  window.productUI={showFriendsPage,renderFriendsPage,hideDm,revealDm,closeTransientUI};
})();
/* Keep existing call controls in sync when the sidebar changes audio state. */
(() => {
  for(const id of ['btn-user-mic','btn-user-deafen'])document.getElementById(id)?.addEventListener('click',()=>{if(callState.active)resetCallControls();});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&innerWidth<=1100){
      document.getElementById('group-members-panel')?.classList.add('hidden');
    }
  });
})();
(() => {
  // Sidebar destinations are navigation buttons, not ARIA tabs.
  const buttons=[...document.querySelectorAll('.sidebar-tab')];
  const update=()=>buttons.forEach(button=>{
    button.removeAttribute('aria-selected');
    if(button.classList.contains('active'))button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  const previous=switchSidebarTab;
  switchSidebarTab=function(name){previous(name);update();};
  const observer=new MutationObserver(update);
  buttons.forEach(button=>observer.observe(button,{attributes:true,attributeFilter:['class']}));
  update();
  // Clicking the muted microphone while deafened enables output first. If the
  // saved mic preference was already on, avoid toggling it back off afterwards.
  document.getElementById('btn-user-mic').addEventListener('click',event=>{
    const audio=document.getElementById('btn-user-deafen');
    if(audio.getAttribute('aria-pressed')!=='true')return;
    audio.click();
    if(event.currentTarget.getAttribute('aria-pressed')==='false')event.stopImmediatePropagation();
  },true);
})();
