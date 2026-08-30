'use strict';

let me = null;
let activeFriend = null;
let friends = {};
let unread = {};

const socket = io();
const $ = id => document.getElementById(id);

// ── Helpers ──────────────────────────────────────────────────────
function av(nick) { return nick ? nick[0].toUpperCase() : '?'; }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function setErr(msg) { $('auth-error').textContent = msg || ''; }

// ── Password toggle ──────────────────────────────────────────────
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '👁' : '🙈';
  });
});

// ── Tabs ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    setErr('');
  });
});

// ── Register ─────────────────────────────────────────────────────
$('btn-register').addEventListener('click', async () => {
  setErr('');
  const userId   = $('reg-id').value.trim();
  const nickname = $('reg-nick').value.trim();
  const password = $('reg-pw').value;
  const res = await fetch('/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, nickname, password })
  });
  const data = await res.json();
  if (!res.ok) return setErr(data.error);
  saveAndLogin(data.user, userId, password);
});

// ── Login ────────────────────────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  setErr('');
  const userId   = $('login-id').value.trim();
  const password = $('login-pw').value;
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password })
  });
  const data = await res.json();
  if (!res.ok) return setErr(data.error);
  saveAndLogin(data.user, userId, password);
});

['login-id','login-pw'].forEach(id => $(id).addEventListener('keydown', e => { if(e.key==='Enter') $('btn-login').click(); }));
['reg-id','reg-nick','reg-pw'].forEach(id => $(id).addEventListener('keydown', e => { if(e.key==='Enter') $('btn-register').click(); }));

function saveAndLogin(user, userId, password) {
  me = user;
  localStorage.setItem('chatapp_id', userId);
  localStorage.setItem('chatapp_pw', password);
  enterApp(user);
}

function enterApp(user) {
  $('my-avatar').textContent = av(user.nickname);
  $('my-nick').textContent   = user.nickname;
  $('my-id').textContent     = '@' + user.id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('app-screen').classList.add('active');
  socket.emit('auth', user.id);
}

// ── Logout ───────────────────────────────────────────────────────
$('btn-logout').addEventListener('click', () => {
  me = null; activeFriend = null; friends = {}; unread = {};
  localStorage.removeItem('chatapp_id');
  localStorage.removeItem('chatapp_pw');
  $('friends-list').innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><div>Пока нет друзей</div><div class="empty-sub">Найди кого-нибудь через поиск</div></div>';
  $('requests-list').innerHTML = '';
  $('requests-section').style.display = 'none';
  $('chat-window').style.display = 'none';
  $('chat-placeholder').style.display = 'flex';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('auth-screen').classList.add('active');
});

// ── Search ───────────────────────────────────────────────────────
let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) { closeDrop(); return; }
  searchTimer = setTimeout(() => doSearch(q), 280);
});
$('search-input').addEventListener('blur', () => setTimeout(closeDrop, 200));

async function doSearch(q) {
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  const list = await res.json();
  const drop = $('search-results');
  drop.innerHTML = '';

  if (!list.length) {
    drop.innerHTML = '<div class="s-item" style="color:var(--text2);font-size:13px">Никого не найдено</div>';
    drop.classList.add('open'); return;
  }

  list.forEach(u => {
    if (u.id === me?.id) return;
    const isFriend = me?.friends?.includes(u.id);
    const el = document.createElement('div');
    el.className = 's-item';
    el.innerHTML = `
      <div class="s-mini-av">${av(u.nickname)}</div>
      <div style="flex:1;min-width:0">
        <div class="s-nick">${esc(u.nickname)}</div>
        <div class="s-id">@${esc(u.id)}</div>
      </div>
      <button class="btn-add" ${isFriend?'disabled':''}>${isFriend?'✓ Друг':'+ Добавить'}</button>`;

    el.querySelector('.btn-add').addEventListener('click', e => {
      e.stopPropagation();
      if (!isFriend) {
        socket.emit('sendFriendRequest', u.id);
        const btn = el.querySelector('.btn-add');
        btn.textContent = 'Отправлено'; btn.disabled = true;
      }
    });
    el.addEventListener('click', () => { if (isFriend) openChat(u.id); closeDrop(); });
    drop.appendChild(el);
  });
  drop.classList.add('open');
}
function closeDrop() { $('search-results').classList.remove('open'); }

// ── Socket events ─────────────────────────────────────────────────
socket.on('profile', profile => {
  me = { ...me, ...profile };
  (profile.friends || []).forEach(fId => {
    if (!friends[fId]) friends[fId] = { id: fId, nickname: fId, online: false };
  });
  renderRequests(profile.friendRequests || []);
  renderFriendsList();
  fetchNicknames(profile.friends || []);
});

async function fetchNicknames(ids) {
  for (const id of ids) {
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(id));
      const results = await res.json();
      const found = results.find(u => u.id === id);
      if (found) friends[id] = { id, nickname: found.nickname, online: found.online };
    } catch(e) {}
  }
  renderFriendsList();
}

socket.on('friendRequest', req => {
  if (!me) return;
  if (!me.friendRequests) me.friendRequests = [];
  me.friendRequests.push({ id: req.id, nickname: req.nickname });
  renderRequests(me.friendRequests);
});
socket.on('requestSent', () => {});
socket.on('requestDeclined', fromId => {
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id||r) !== fromId);
    renderRequests(me.friendRequests);
  }
});
socket.on('friendAdded', user => {
  friends[user.id] = { id: user.id, nickname: user.nickname, online: user.online };
  if (!me.friends) me.friends = [];
  if (!me.friends.includes(user.id)) me.friends.push(user.id);
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id||r) !== user.id);
    renderRequests(me.friendRequests);
  }
  renderFriendsList();
});
socket.on('friendOnline', u => {
  if (friends[u.id]) { friends[u.id].online = true; updateStatus(u.id, true); }
});
socket.on('friendOffline', id => {
  if (friends[id]) { friends[id].online = false; updateStatus(id, false); }
});
socket.on('newMessage', ({ chatWith, msg }) => {
  if (activeFriend === chatWith) { appendMsg(msg); scrollMsgs(); }
  else { unread[chatWith] = (unread[chatWith]||0) + 1; refreshFriendItem(chatWith); }
});

// ── Render ───────────────────────────────────────────────────────
function renderRequests(reqs) {
  const sec = $('requests-section');
  const list = $('requests-list');
  if (!reqs || !reqs.length) { sec.style.display = 'none'; list.innerHTML = ''; return; }
  sec.style.display = 'block';
  $('req-badge').textContent = reqs.length;
  list.innerHTML = '';
  reqs.forEach(r => {
    const id = r.id||r, nick = r.nickname||id;
    const el = document.createElement('div');
    el.className = 'req-card';
    el.innerHTML = `
      <div class="f-av" style="width:32px;height:32px;font-size:13px">${av(nick)}</div>
      <div style="flex:1;min-width:0">
        <div class="req-nick">${esc(nick)}</div>
        <div class="req-id">@${esc(id)}</div>
      </div>
      <div class="req-btns">
        <button class="btn-ok">✓</button>
        <button class="btn-no">✕</button>
      </div>`;
    el.querySelector('.btn-ok').onclick = () => socket.emit('acceptFriendRequest', id);
    el.querySelector('.btn-no').onclick = () => socket.emit('declineFriendRequest', id);
    list.appendChild(el);
  });
}

function renderFriendsList() {
  const list = $('friends-list');
  const ids = Object.keys(friends);
  if (!ids.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><div>Пока нет друзей</div><div class="empty-sub">Найди кого-нибудь через поиск</div></div>';
    return;
  }
  list.innerHTML = '';
  ids.forEach(id => buildFriendEl(id));
}

function buildFriendEl(id) {
  const f = friends[id]; if (!f) return;
  const list = $('friends-list');
  const old = list.querySelector(`[data-fid="${id}"]`);
  const u = unread[id]||0;

  const el = old || document.createElement('div');
  el.className = 'friend-item' + (activeFriend===id?' active':'');
  el.dataset.fid = id;
  el.innerHTML = `
    <div class="f-av">${av(f.nickname)}${f.online?'<div class="f-dot"></div>':''}</div>
    <div class="f-info">
      <div class="f-nick">${esc(f.nickname)}</div>
      <div class="f-stat ${f.online?'on':''}">${f.online?'● онлайн':'офлайн'}</div>
    </div>
    ${u?`<div class="f-unread">${u}</div>`:''}`;
  el.onclick = () => openChat(id);
  if (!old) list.appendChild(el);
}

function refreshFriendItem(id) {
  const list = $('friends-list');
  const old = list.querySelector(`[data-fid="${id}"]`);
  if (old) old.remove();
  buildFriendEl(id);
}

function updateStatus(id, online) {
  refreshFriendItem(id);
  if (activeFriend === id) {
    $('chat-status').textContent = online ? '● онлайн' : 'офлайн';
    $('chat-status').className = 'chat-head-status' + (online ? ' on' : '');
  }
}

// ── Chat ─────────────────────────────────────────────────────────
async function openChat(id) {
  activeFriend = id;
  unread[id] = 0;
  document.querySelectorAll('.friend-item').forEach(el => el.classList.toggle('active', el.dataset.fid===id));
  refreshFriendItem(id);

  const f = friends[id]||{id,nickname:id,online:false};
  $('chat-avatar').textContent = av(f.nickname);
  $('chat-nick').textContent   = f.nickname;
  $('chat-status').textContent = f.online ? '● онлайн' : 'офлайн';
  $('chat-status').className   = 'chat-head-status' + (f.online?' on':'');

  $('chat-placeholder').style.display = 'none';
  $('chat-window').style.display = 'flex';

  const res = await fetch(`/api/messages/${me.id}/${id}`);
  const history = await res.json();
  $('messages').innerHTML = '';
  history.forEach(m => appendMsg(m, false));
  scrollMsgs();
  $('msg-input').focus();
}

function appendMsg(msg, doScroll=true) {
  const isMine = msg.from === me.id;
  const el = document.createElement('div');
  el.className = 'msg ' + (isMine?'mine':'theirs');
  el.innerHTML = `${esc(msg.text)}<div class="msg-time">${fmtTime(msg.time)}</div>`;
  $('messages').appendChild(el);
  if (doScroll) scrollMsgs();
}

function scrollMsgs() { const m=$('messages'); m.scrollTop=m.scrollHeight; }

$('btn-send').onclick = sendMsg;
$('msg-input').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();} });

function sendMsg() {
  const text = $('msg-input').value.trim();
  if (!text || !activeFriend) return;
  socket.emit('sendMessage', { toId: activeFriend, text });
  $('msg-input').value = '';
}

// ── Auto-login ───────────────────────────────────────────────────
(async () => {
  const savedId = localStorage.getItem('chatapp_id');
  const savedPw = localStorage.getItem('chatapp_pw');
  if (savedId && savedPw) {
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: savedId, password: savedPw })
      });
      if (res.ok) { const d = await res.json(); me = d.user; enterApp(d.user); }
    } catch(e) {}
  }
})();
