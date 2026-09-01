'use strict';

let me = null;
let activeFriend = null;
let friends = {};
let unread = {};
let pendingDeleteId = null;
let chatRequestSeq = 0; // счётчик для защиты openChat от гонки при быстром переключении чатов
let profileRequestSeq = 0; // защита showUserProfile от гонки при быстром переключении профилей

const MAX_MESSAGE_LENGTH = 4000;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // должно совпадать с лимитом multer на сервере
const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Раньше: const socket = io()  — без токена. Сервер (io.use в server.js) требует
// socket.handshake.auth.token и без него сразу рвёт соединение с 'Unauthorized'.
// Из-за этого ни одно событие (sendFriendRequest, sendMessage и т.д.) не доходило.
const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

function connectSocket() {
  const token = localStorage.getItem('chatapp_token');
  if (!token) return;
  socket.auth = { token };
  if (socket.connected) socket.disconnect();
  socket.connect();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function av(nick) { return nick ? nick[0].toUpperCase() : '?'; }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function setErr(msg) { $('auth-error').textContent = msg || ''; }

// Закрывает все модалки поверх экрана — используется при принудительном разлогине,
// чтобы истёкший токен (401 / socket 'connect_error') не оставлял модалку висящей
// поверх экрана входа (аудит, пункт 1).
function closeAllModals() {
  ['profile-modal', 'edit-profile-modal', 'blocked-users-modal', 'delete-confirm'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });
  pendingDeleteId = null;
}

function forceLogoutToLogin(message) {
  // Общий выход при истёкшем/невалидном токене — используется и REST-, и socket-путём,
  // чтобы поведение не расходилось (раньше так делал только socket 'connect_error').
  me = null; activeFriend = null; friends = {}; unread = {};
  if (socket.connected) socket.disconnect();
  localStorage.removeItem('chatapp_id');
  localStorage.removeItem('chatapp_pw');
  localStorage.removeItem('chatapp_token');
  localStorage.removeItem('chatapp_profile');
  document.documentElement.classList.remove('has-session');
  closeAllModals();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('auth-screen').classList.add('active');
  if (message) setErr(message);
}

// ─── Auth Fetch (всегда отправляет JWT-токен) ──────────────────────────────────
// Раньше 401 от REST-запросов (например, из-за истёкшего токена) никак не
// обрабатывался централизованно — только socket 'connect_error' мог разлогинить.
// Из-за этого REST-запросы могли молча падать с невнятной ошибкой, пока сокет
// ещё не переподключился. Теперь любой 401 сразу ведёт на экран входа.
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('chatapp_token');
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { 'Authorization': 'Bearer ' + token } : {})
    }
  });
  if (res.status === 401 && me) {
    forceLogoutToLogin('Сессия истекла, войдите снова');
  }
  return res;
}

// Render avatar: image or letter
function renderAv(el, nickname, avatarUrl) {
  if (avatarUrl) {
    el.textContent = '';
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => { el.textContent = av(nickname); };
    el.appendChild(img);
  } else {
    el.textContent = av(nickname);
  }
}

// ─── Password toggle ──────────────────────────────────────────────────────────
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.style.opacity = input.type === 'text' ? '0.5' : '1';
    }
  });
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    setErr('');
  });
});

// ─── Register ─────────────────────────────────────────────────────────────────
$('btn-register').addEventListener('click', async () => {
  setErr('');
  const userId   = $('reg-id').value.trim();
  const nickname = $('reg-nick').value.trim();
  const password = $('reg-pw').value;

  if (!userId || userId.length < 3) return setErr('ID минимум 3 символа');
  if (!/^[a-z0-9_]+$/.test(userId)) return setErr('ID: только a-z, 0-9, _');
  if (!nickname) return setErr('Введите никнейм');
  if (!password || password.length < 4) return setErr('Пароль минимум 4 символа');

  const btn = $('btn-register');
  btn.disabled = true; btn.textContent = 'Загрузка…';
  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, nickname, password })
    });
    const data = await res.json();
    if (!res.ok) return setErr(data.error || 'Ошибка регистрации');
    saveAndLogin(data.user, userId, password, data.token);
  } catch(e) {
    setErr('Ошибка сети');
  } finally {
    btn.disabled = false; btn.textContent = 'Зарегистрироваться';
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  setErr('');
  const userId   = $('login-id').value.trim();
  const password = $('login-pw').value;

  if (!userId || !password) return setErr('Введите ID и пароль');

  const btn = $('btn-login');
  btn.disabled = true; btn.textContent = 'Загрузка…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password })
    });
    const data = await res.json();
    if (!res.ok) return setErr(data.error || 'Ошибка входа');
    saveAndLogin(data.user, userId, password, data.token);
  } catch(e) {
    setErr('Ошибка сети');
  } finally {
    btn.disabled = false; btn.textContent = 'Войти';
  }
});

['login-id','login-pw'].forEach(id => $(id).addEventListener('keydown', e => { if(e.key==='Enter') $('btn-login').click(); }));
['reg-id','reg-nick','reg-pw'].forEach(id => $(id).addEventListener('keydown', e => { if(e.key==='Enter') $('btn-register').click(); }));

function saveAndLogin(user, userId, password, token) {
  me = user;
  localStorage.setItem('chatapp_id', userId);
  // Раньше здесь же сохранялся пароль в открытом виде (chatapp_pw) и на каждой
  // перезагрузке страницы он заново отправлялся на /api/login — это и давало
  // "мигание" формы входа (страница ждала ответ сети, прежде чем показать чат),
  // а хранить пароль в localStorage в принципе небезопасно. Теперь храним только
  // токен и кэш профиля — вход при перезагрузке идёт по токену через сокет.
  localStorage.removeItem('chatapp_pw');
  if (token) localStorage.setItem('chatapp_token', token);
  localStorage.setItem('chatapp_profile', JSON.stringify(user));
  enterApp(user);
}

function enterApp(user) {
  renderAv($('my-avatar'), user.nickname, user.avatar);
  $('my-nick').textContent = user.nickname;
  $('my-id').textContent   = '@' + user.id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('app-screen').classList.add('active');
  connectSocket(); // было: socket.emit('auth', user.id) — сервер это событие не слушал
}

// ─── Logout ───────────────────────────────────────────────────────────────────
$('btn-logout').addEventListener('click', () => {
  forceLogoutToLogin();
  $('friends-list').innerHTML = emptyFriendsHTML();
  $('requests-list').innerHTML = '';
  $('requests-section').style.display = 'none';
  $('chat-window').style.display = 'none';
  $('chat-placeholder').style.display = '';
});

function emptyFriendsHTML() {
  return `<div class="empty-state">
    <div class="empty-icon">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
    </div>
    <div class="empty-title">Нет контактов</div>
    <div class="empty-sub">Найди кого-нибудь через поиск</div>
  </div>`;
}

// ─── Me card → open edit profile ─────────────────────────────────────────────
$('me-card').addEventListener('click', (e) => {
  if (e.target.closest('#btn-logout')) return;
  if (me) openEditProfileModal();
});

// ─── Search ───────────────────────────────────────────────────────────────────
let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) { closeDrop(); return; }
  searchTimer = setTimeout(() => doSearch(q), 280);
});
$('search-input').addEventListener('blur', () => setTimeout(closeDrop, 200));

async function doSearch(q) {
  try {
    const res = await authFetch('/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error();
    const list = await res.json();
    const drop = $('search-results');
    drop.innerHTML = '';

    if (!list || !list.length) {
      drop.innerHTML = '<div class="s-item" style="color:var(--text3);font-size:13px">Никого не найдено</div>';
      drop.classList.add('open'); return;
    }

    list.forEach(u => {
      if (u.id === me?.id) return;
      const isFriend = me?.friends?.includes(u.id);
      const el = document.createElement('div');
      el.className = 's-item';
      el.innerHTML = `
        <div class="s-mini-av"></div>
        <div style="flex:1;min-width:0">
          <div class="s-nick">${esc(u.nickname)}</div>
          <div class="s-id">@${esc(u.id)}</div>
        </div>
        <button class="btn-add" ${isFriend?'disabled':''}>${isFriend?'✓ Друг':'+ Добавить'}</button>`;

      renderAv(el.querySelector('.s-mini-av'), u.nickname, u.avatar);

      el.querySelector('.btn-add').addEventListener('click', e => {
        e.stopPropagation();
        if (!isFriend) {
          socket.emit('sendFriendRequest', u.id);
          const btn = el.querySelector('.btn-add');
          btn.textContent = 'Отправлено'; btn.disabled = true;
        }
      });
      el.addEventListener('click', () => {
        if (isFriend) openChat(u.id);
        else showUserProfile(u.id);
        closeDrop();
      });
      drop.appendChild(el);
    });
    drop.classList.add('open');
  } catch(e) {
    $('search-results').innerHTML = '<div class="s-item" style="color:var(--red);font-size:13px">Ошибка поиска</div>';
    $('search-results').classList.add('open');
  }
}
function closeDrop() { $('search-results').classList.remove('open'); $('search-input').value = ''; }

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('profile', profile => {
  me = { ...me, ...profile };
  localStorage.setItem('chatapp_profile', JSON.stringify(me));
  unread = { ...(profile.unreadCounts || {}) }; // раньше не подтягивались — не было бейджей после захода/реконнекта
  renderAv($('my-avatar'), me.nickname, me.avatar);
  $('my-nick').textContent = me.nickname;
  (profile.friends || []).forEach(fId => {
    if (!friends[fId]) friends[fId] = { id: fId, nickname: fId, online: false };
  });
  renderRequests(profile.friendRequests || []);
  renderFriendsList();
  fetchNicknames(profile.friends || []);
  // Если чат был открыт в момент дисконнекта — переоткрываем, чтобы подтянуть
  // возможные messageDeleted/новые сообщения, пропущенные во время оффлайна (аудит, пункт 1)
  if (activeFriend) openChat(activeFriend);
});

async function fetchNicknames(ids) {
  // Раньше запросы шли последовательно (await в цикле) — при большом списке друзей
  // это N последовательных round-trip'ов подряд. Грузим параллельно.
  const results = await Promise.allSettled(
    ids.map(id => authFetch('/api/profile/' + encodeURIComponent(id)).then(async res => {
      if (!res.ok) throw new Error('not ok');
      return { id, data: await res.json() };
    }))
  );
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      const { id, data: u } = r.value;
      friends[id] = { id, nickname: u.nickname, avatar: u.avatar, online: u.online };
    }
  });
  renderFriendsList();
}

socket.on('friendRequest', req => {
  if (!me) return;
  if (!me.friendRequests) me.friendRequests = [];
  // Защита от дублей: сервер может повторно прислать это событие при реконнекте,
  // а актуальный список заявок уже приходит в 'profile' — без проверки заявка
  // могла задвоиться в UI (аудит, пункт 3).
  const already = me.friendRequests.some(r => (r.id || r) === req.id);
  if (!already) {
    me.friendRequests.push({ id: req.id, nickname: req.nickname });
    renderRequests(me.friendRequests);
  }
});
socket.on('requestSent', () => {});
socket.on('friendRequestError', ({ reason }) => {
  // Раньше эта ошибка вообще не обрабатывалась на клиенте — кнопка "Запрос отправлен"
  // так и оставалась disabled, даже если сервер реально не создал заявку.
  const addBtn = $('btn-add-friend');
  if (addBtn && addBtn.style.display !== 'none') {
    addBtn.textContent = 'Добавить в друзья';
    addBtn.disabled = false;
  }
  const messages = {
    rate_limited: 'Слишком много заявок, попробуйте позже',
    not_found: 'Пользователь не найден',
    self: 'Нельзя добавить самого себя',
    already_friends: 'Вы уже друзья',
    already_sent: 'Заявка уже отправлена',
    blocked: 'Невозможно отправить заявку',
    limit_reached: 'Достигнут лимит заявок/друзей',
    target_limit_reached: 'У пользователя переполнен список заявок',
    server_error: 'Ошибка сервера'
  };
  alert(messages[reason] || 'Не удалось отправить заявку');
});
socket.on('requestDeclined', fromId => {
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id||r) !== fromId);
    renderRequests(me.friendRequests);
  }
});
socket.on('friendAdded', user => {
  friends[user.id] = { id: user.id, nickname: user.nickname, avatar: user.avatar, online: user.online };
  if (!me.friends) me.friends = [];
  if (!me.friends.includes(user.id)) me.friends.push(user.id);
  if (me.friendRequests) {
    me.friendRequests = me.friendRequests.filter(r => (r.id||r) !== user.id);
    renderRequests(me.friendRequests);
  }
  renderFriendsList();
});
socket.on('friendRemoved', ({ id }) => {
  // Приходит, когда собеседник нас заблокировал (или иначе разорвал дружбу) —
  // раньше это обновлялось только на его стороне, а у нас список друзей
  // "протухал" молча, из-за чего повторная заявка потом отклонялась как already_friends.
  if (me?.friends) me.friends = me.friends.filter(fid => fid !== id);
  delete friends[id];
  delete unread[id];
  renderFriendsList();
  if (activeFriend === id) {
    activeFriend = null;
    $('chat-placeholder').style.display = 'flex';
    $('chat-window').style.display = 'none';
  }
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
socket.on('messageDeleted', ({ messageId, chatWith }) => {
  const wrap = document.querySelector(`[data-msgid="${CSS.escape(messageId)}"]`);
  if (wrap) {
    const bubble = wrap.querySelector('.msg');
    if (bubble) {
      bubble.classList.add('deleted-msg');
      bubble.innerHTML = '<em>Сообщение удалено</em>';
    }
    const delBtn = wrap.querySelector('.msg-del-btn');
    if (delBtn) delBtn.remove();
  }
});
// Раньше сервер эмитил 'rateLimited' при спаме сообщений, а клиент это событие
// вообще не слушал — пользователь просто не понимал, почему сообщение "зависло".
socket.on('rateLimited', (kind) => {
  if (kind === 'sendMessage') {
    showTransientNotice('Слишком много сообщений, подождите немного');
  }
});
// Новое серверное событие (лимит размера картинки в sendMessage) — раньше клиент
// его не обрабатывал вовсе, сообщение просто пропадало без объяснения.
socket.on('sendMessageError', ({ reason }) => {
  if (reason === 'image_too_large') {
    showTransientNotice('Изображение слишком большое');
  } else {
    showTransientNotice('Не удалось отправить сообщение');
  }
});

function showTransientNotice(text) {
  // Лёгкий неблокирующий тост вместо alert() — не прерывает набор текста в поле ввода.
  // Стилизация — через класс .transient-notice в styles.css, а не inline (см. аудит стиля, пункт 5).
  let el = $('transient-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'transient-notice';
    el.className = 'transient-notice';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.classList.remove('show'); }, 2500);
}

// ─── Render ───────────────────────────────────────────────────────────────────
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
      <div class="f-av" style="width:34px;height:34px;font-size:13px"></div>
      <div style="flex:1;min-width:0">
        <div class="req-nick">${esc(nick)}</div>
        <div class="req-id">@${esc(id)}</div>
      </div>
      <div class="req-btns">
        <button class="btn-ok">✓</button>
        <button class="btn-no">✕</button>
      </div>`;
    renderAv(el.querySelector('.f-av'), nick, null);
    el.querySelector('.btn-ok').onclick = () => socket.emit('acceptFriendRequest', id);
    el.querySelector('.btn-no').onclick = () => socket.emit('declineFriendRequest', id);
    list.appendChild(el);
  });
}

function renderFriendsList() {
  const list = $('friends-list');
  const ids = Object.keys(friends);
  if (!ids.length) { list.innerHTML = emptyFriendsHTML(); return; }
  list.innerHTML = '';
  ids.forEach(id => buildFriendEl(id));
}

function buildFriendEl(id) {
  // Раньше здесь искался старый DOM-узел для "переиспользования", но оба места
  // вызова (renderFriendsList — после innerHTML='', refreshFriendItem — после
  // old.remove()) уже гарантированно его удаляют, так что `old` всегда был null
  // и ветка переиспользования никогда не срабатывала (аудит, пункт 4). Убрали
  // мёртвый код — элемент всегда создаётся заново, поведение не изменилось.
  const f = friends[id]; if (!f) return;
  const list = $('friends-list');
  const u = unread[id]||0;

  const el = document.createElement('div');
  el.className = 'friend-item' + (activeFriend===id?' active':'');
  el.dataset.fid = id;
  el.innerHTML = `
    <div class="f-av">${f.online?'<div class="f-dot"></div>':''}</div>
    <div class="f-info">
      <div class="f-nick">${esc(f.nickname)}</div>
      <div class="f-stat ${f.online?'on':''}">${f.online?'● онлайн':'офлайн'}</div>
    </div>
    ${u?`<div class="f-unread">${u}</div>`:''}`;

  const avEl = el.querySelector('.f-av');
  // prepend letter/img before dot
  const dot = avEl.querySelector('.f-dot');
  const span = document.createElement('span');
  span.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:50%';
  if (f.avatar) {
    const img = document.createElement('img');
    img.src = f.avatar;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover';
    img.onerror = () => { span.textContent = av(f.nickname); };
    span.appendChild(img);
  } else {
    span.textContent = av(f.nickname);
  }
  avEl.style.position = 'relative';
  avEl.insertBefore(span, dot);

  el.onclick = () => openChat(id);
  list.appendChild(el);
}

function refreshFriendItem(id) {
  const list = $('friends-list');
  const old = list.querySelector(`[data-fid="${CSS.escape(id)}"]`);
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

// ─── Chat ─────────────────────────────────────────────────────────────────────
async function openChat(id) {
  if (!me || !id) return;
  activeFriend = id;
  unread[id] = 0;
  document.querySelectorAll('.friend-item').forEach(el => el.classList.toggle('active', el.dataset.fid===id));
  refreshFriendItem(id);

  const f = friends[id]||{id, nickname: id, online: false};
  renderAv($('chat-avatar'), f.nickname, f.avatar);
  $('chat-nick').textContent   = f.nickname;
  $('chat-status').textContent = f.online ? '● онлайн' : 'офлайн';
  $('chat-status').className   = 'chat-head-status' + (f.online?' on':'');

  $('chat-placeholder').style.display = 'none';
  $('chat-window').style.display = 'flex';

  // Mobile: show chat panel
  if (window.innerWidth <= 640) {
    document.querySelector('.sidebar').classList.add('hidden');
    document.querySelector('.chat-main').classList.remove('hidden');
  }

  $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Загрузка…</div>';

  // Защита от гонки: если пользователь быстро переключился на другой чат,
  // ответ на более старый запрос не должен перезаписать уже открытый новый чат
  // (раньше при быстром клике по двум друзьям подряд могла отрисоваться чужая история).
  const requestSeq = ++chatRequestSeq;

  try {
    const res = await authFetch(`/api/messages/${me.id}/${id}`);
    if (requestSeq !== chatRequestSeq) return; // чат уже сменился — этот ответ устарел
    if (!res.ok) throw new Error();
    const history = await res.json();
    if (requestSeq !== chatRequestSeq) return;
    $('messages').innerHTML = '';
    if (!history || !history.length) {
      $('messages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:24px;font-size:13px">Напишите первым! 👋</div>';
    } else {
      history.forEach(m => appendMsg(m, false));
    }
    scrollMsgs();
  } catch(e) {
    if (requestSeq !== chatRequestSeq) return;
    $('messages').innerHTML = '<div style="text-align:center;color:var(--red);padding:24px;font-size:13px">Ошибка загрузки</div>';
  }
  socket.emit('markRead', id);
  $('msg-input').focus();
}

function appendMsg(msg, doScroll=true) {
  if (!me) return;
  const isMine = msg.from === me.id;
  const isDeleted = msg.deleted;
  const msgId = msg._id || msg.id || '';

  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + (isMine ? 'mine' : 'theirs');
  if (msgId) wrap.dataset.msgid = msgId;

  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (isMine ? 'mine' : 'theirs') + (isDeleted ? ' deleted-msg' : '');

  if (isDeleted) {
    bubble.innerHTML = '<em>Сообщение удалено</em>';
  } else {
    bubble.innerHTML = `${esc(msg.text || '')}<div class="msg-time">${fmtTime(msg.time || msg.timestamp || msg.createdAt)}</div>`;
  }

  wrap.appendChild(bubble);

  // Delete button (only for own non-deleted messages)
  if (isMine && !isDeleted && msgId) {
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-del-btn';
    delBtn.title = 'Удалить';
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>`;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteConfirm(msgId);
    });
    wrap.appendChild(delBtn);
  }

  $('messages').appendChild(wrap);
  if (doScroll) scrollMsgs();
}

function scrollMsgs() { const m = $('messages'); m.scrollTop = m.scrollHeight; }

// ─── Delete message ───────────────────────────────────────────────────────────
function openDeleteConfirm(msgId) {
  pendingDeleteId = msgId;
  $('delete-confirm').style.display = 'flex';
}
function closeDeleteConfirm() {
  pendingDeleteId = null;
  $('delete-confirm').style.display = 'none';
}
$('btn-confirm-delete').addEventListener('click', async () => {
  if (!pendingDeleteId || !me) return;
  // Важно: сохраняем id ДО closeDeleteConfirm() — она обнуляет pendingDeleteId,
  // а он читался прямо в шаблонной строке fetch ниже. Из-за этого запрос уходил
  // на DELETE /api/messages/null → "Некорректный ID сообщения" (см. скриншоты).
  const idToDelete = pendingDeleteId;
  closeDeleteConfirm();
  try {
    const res = await authFetch(`/api/messages/${idToDelete}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error || 'Ошибка удаления');
    }
  } catch(e) {
    alert('Ошибка сети');
  }
});

// ─── Send message ─────────────────────────────────────────────────────────────
$('btn-send').onclick = sendMsg;
$('msg-input').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } });

function sendMsg() {
  const text = $('msg-input').value.trim();
  if (!text || !activeFriend) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    return;
  }
  socket.emit('sendMessage', { toId: activeFriend, text });
  $('msg-input').value = '';
  $('msg-input').focus();
}

// ─── Profile: view other user ─────────────────────────────────────────────────
$('chat-head-click').addEventListener('click', () => {
  if (activeFriend) showUserProfile(activeFriend);
});

async function showUserProfile(userId) {
  // Защита от гонки, аналогично openChat: быстрые клики по разным профилям подряд
  // не должны дать более старому ответу перезаписать уже открытый новый профиль
  // (аудит, пункт 5).
  const requestSeq = ++profileRequestSeq;
  try {
    const res = await authFetch('/api/profile/' + encodeURIComponent(userId));
    if (requestSeq !== profileRequestSeq) return;
    if (!res.ok) return;
    const u = await res.json();
    if (requestSeq !== profileRequestSeq) return;

    renderAv($('profile-modal-avatar'), u.nickname, u.avatar);
    $('profile-modal-nick').textContent = u.nickname;
    $('profile-modal-id').textContent   = '@' + u.id;

    const onlineBadge = $('profile-modal-online');
    onlineBadge.textContent = u.online ? '● онлайн' : 'офлайн';
    onlineBadge.className   = 'modal-online-badge ' + (u.online ? 'online' : 'offline');

    const statusRow = $('profile-modal-status-row');
    const bioRow    = $('profile-modal-bio-row');
    if (u.status) {
      $('profile-modal-status').textContent = u.status;
      statusRow.style.display = '';
    } else { statusRow.style.display = 'none'; }
    if (u.bio) {
      $('profile-modal-bio').textContent = u.bio;
      bioRow.style.display = '';
    } else { bioRow.style.display = 'none'; }

    const addBtn = $('btn-add-friend');
    const isFriend = me?.friends?.includes(userId);
    const isMe = userId === me?.id;
    // Кнопка — один и тот же DOM-элемент для всех профилей, поэтому её текст/disabled
    // нужно сбрасывать при каждом открытии модалки, иначе после первого клика "Добавить"
    // она навсегда остаётся "Запрос отправлен" + disabled для любого другого пользователя
    // (в т.ч. после блокировки/разблокировки и попытки добавить снова).
    addBtn.textContent = 'Добавить в друзья';
    addBtn.disabled = false;
    addBtn.style.display = (isFriend || isMe) ? 'none' : '';
    if (!isFriend && !isMe) {
      addBtn.onclick = () => {
        socket.emit('sendFriendRequest', userId);
        addBtn.textContent = 'Запрос отправлен';
        addBtn.disabled = true;
      };
    }

    const blockBtn = $('btn-block-user');
    if (blockBtn) {
      const isBlocked = !!me?.blockedUsers?.includes(userId);
      blockBtn.style.display = isMe ? 'none' : '';
      blockBtn.disabled = false;
      blockBtn.className = 'btn-secondary' + (isBlocked ? '' : ' btn-danger-outline');
      blockBtn.textContent = isBlocked ? 'Разблокировать' : 'Заблокировать';
      // Раньше после успешной блокировки кнопка вешала onclick, который просто
      // заново вызывал showUserProfile(userId) — это не разблокировало пользователя,
      // а лишь перерисовывало модалку. Реальный unblock срабатывал только со
      // второго клика, когда уже отрабатывала ветка isBlocked ниже. Теперь both
      // ветки (block/unblock) используют один и тот же обработчик performUnblock/
      // performBlock, назначенный один раз (аудит, пункт 2).
      blockBtn.onclick = () => isBlocked ? performUnblock(userId) : performBlock(userId);
    }

    $('profile-modal').style.display = 'flex';
  } catch(e) {}
}

async function performUnblock(userId) {
  try {
    const res = await authFetch(`/api/users/${encodeURIComponent(userId)}/unblock`, { method: 'POST' });
    if (!res.ok) return alert('Ошибка разблокировки');
    if (me.blockedUsers) me.blockedUsers = me.blockedUsers.filter(id => id !== userId);
    showUserProfile(userId); // перерисовать модалку с обновлённым состоянием кнопки
  } catch (e) { alert('Ошибка сети'); }
}

async function performBlock(userId) {
  if (!confirm(`Заблокировать @${userId}?`)) return;
  try {
    const res = await authFetch(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return alert(d.error || 'Ошибка блокировки');
    }
    if (!me.blockedUsers) me.blockedUsers = [];
    if (!me.blockedUsers.includes(userId)) me.blockedUsers = [...me.blockedUsers, userId];
    if (me.friends) me.friends = me.friends.filter(id => id !== userId);
    delete friends[userId];
    delete unread[userId];
    renderFriendsList();
    if (activeFriend === userId) {
      activeFriend = null;
      $('chat-placeholder').style.display = 'flex';
      $('chat-window').style.display = 'none';
    }
    showUserProfile(userId); // перерисовать модалку с кнопкой "Разблокировать"
  } catch (e) { alert('Ошибка сети'); }
}

function closeProfileModal() { $('profile-modal').style.display = 'none'; }
window.closeProfileModal = closeProfileModal;

// Click outside to close
$('profile-modal').addEventListener('click', e => {
  if (e.target === $('profile-modal')) closeProfileModal();
});

// ─── Profile: edit own ────────────────────────────────────────────────────────
function openEditProfileModal() {
  if (!me) return;
  renderAv($('edit-avatar'), me.nickname, me.avatar);
  $('edit-nick').value   = me.nickname || '';
  $('edit-status').value = me.status || '';
  $('edit-bio').value    = me.bio || '';
  $('edit-profile-modal').style.display = 'flex';
}
function closeEditProfileModal() { $('edit-profile-modal').style.display = 'none'; }
window.closeEditProfileModal = closeEditProfileModal;

$('edit-profile-modal').addEventListener('click', e => {
  if (e.target === $('edit-profile-modal')) closeEditProfileModal();
});

// Avatar upload
$('avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !me) return;

  // Быстрая проверка на клиенте — раньше о слишком большом/неподходящем файле
  // узнавали только после полной отправки на сервер и ответа 400/413.
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    alert('Разрешены только изображения (jpeg, png, webp, gif)');
    e.target.value = '';
    return;
  }
  if (file.size > MAX_AVATAR_SIZE) {
    alert('Файл слишком большой (максимум 5MB)');
    e.target.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const res = await authFetch('/api/upload/avatar', { method: 'POST', body: formData });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return alert(d.error || 'Ошибка загрузки аватара');
    }
    const data = await res.json();
    me.avatar = data.avatar;
    localStorage.setItem('chatapp_profile', JSON.stringify(me));
    renderAv($('edit-avatar'), me.nickname, me.avatar);
    renderAv($('my-avatar'), me.nickname, me.avatar);
  } catch(e) { alert('Ошибка сети'); }
  e.target.value = '';
});

// Save profile
$('btn-save-profile').addEventListener('click', async () => {
  if (!me) return;
  const nickname = $('edit-nick').value.trim();
  const status   = $('edit-status').value.trim();
  const bio      = $('edit-bio').value.trim();

  const btn = $('btn-save-profile');
  btn.disabled = true; btn.textContent = 'Сохранение…';
  try {
    const res = await authFetch('/api/profile/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, status, bio })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || 'Ошибка сохранения');
    me.nickname = data.user.nickname;
    me.status   = data.user.status;
    me.bio      = data.user.bio;
    localStorage.setItem('chatapp_profile', JSON.stringify(me));
    $('my-nick').textContent = me.nickname;
    renderAv($('my-avatar'), me.nickname, me.avatar);
    closeEditProfileModal();
  } catch(e) { alert('Ошибка сети'); }
  finally { btn.disabled = false; btn.textContent = 'Сохранить'; }
});

// ─── Blocked users list (как в Discord) ───────────────────────────────────────
$('btn-open-blocked')?.addEventListener('click', () => {
  closeEditProfileModal();
  openBlockedUsersModal();
});

async function openBlockedUsersModal() {
  $('blocked-users-modal').style.display = 'flex';
  const list = $('blocked-users-list');
  list.innerHTML = '<div class="blocked-users-empty">Загрузка…</div>';
  try {
    const res = await authFetch('/api/users/blocked');
    if (!res.ok) throw new Error();
    const users = await res.json();
    me.blockedUsers = users.map(u => u.id); // держим в актуальном состоянии
    renderBlockedUsersList(users);
  } catch (e) {
    list.innerHTML = '<div class="blocked-users-empty" style="color:var(--red)">Ошибка загрузки</div>';
  }
}
function closeBlockedUsersModal() { $('blocked-users-modal').style.display = 'none'; }
window.closeBlockedUsersModal = closeBlockedUsersModal;

$('blocked-users-modal').addEventListener('click', e => {
  if (e.target === $('blocked-users-modal')) closeBlockedUsersModal();
});

function renderBlockedUsersList(users) {
  const list = $('blocked-users-list');
  list.innerHTML = '';
  if (!users || !users.length) {
    list.innerHTML = '<div class="blocked-users-empty">Нет заблокированных пользователей</div>';
    return;
  }
  users.forEach(u => {
    const el = document.createElement('div');
    el.className = 'blocked-user-item';
    el.dataset.uid = u.id;
    el.innerHTML = `
      <div class="f-av"></div>
      <div class="f-info">
        <div class="blocked-user-nick">${esc(u.nickname)}</div>
        <div class="blocked-user-id">@${esc(u.id)}</div>
      </div>
      <button class="btn-unblock">Разблокировать</button>`;
    renderAv(el.querySelector('.f-av'), u.nickname, u.avatar);
    el.querySelector('.btn-unblock').addEventListener('click', async () => {
      try {
        const res = await authFetch(`/api/users/${encodeURIComponent(u.id)}/unblock`, { method: 'POST' });
        if (!res.ok) return alert('Ошибка разблокировки');
        if (me.blockedUsers) me.blockedUsers = me.blockedUsers.filter(id => id !== u.id);
        el.remove();
        if (!list.children.length) {
          list.innerHTML = '<div class="blocked-users-empty">Нет заблокированных пользователей</div>';
        }
      } catch (e) { alert('Ошибка сети'); }
    });
    list.appendChild(el);
  });
}

// ─── Mobile back button ───────────────────────────────────────────────────────
$('btn-back')?.addEventListener('click', () => {
  // Раньше только сбрасывался activeFriend и переключались .sidebar/.chat-main,
  // но #chat-window/#chat-placeholder и .active-класс в списке друзей не
  // приводились в порядок — при возврате на десктопную ширину было видно
  // рассинхронизированное состояние (аудит, пункт 6).
  activeFriend = null;
  document.querySelector('.sidebar').classList.remove('hidden');
  document.querySelector('.chat-main').classList.add('hidden');
  document.querySelectorAll('.friend-item').forEach(el => el.classList.remove('active'));
  $('chat-window').style.display = 'none';
  $('chat-placeholder').style.display = 'flex';
});

// Handle resize
window.addEventListener('resize', () => {
  if (window.innerWidth > 640) {
    document.querySelector('.sidebar')?.classList.remove('hidden');
    document.querySelector('.chat-main')?.classList.remove('hidden');
  }
});

// ─── Auto-login ───────────────────────────────────────────────────────────────
// Раньше при каждой загрузке страницы отправлялся POST /api/login с сохранённым
// паролем, и пока не приходил ответ — на экране было видно форму входа/регистрации
// (мигание). Теперь если есть токен и кэшированный профиль — сразу открываем
// приложение и подключаем сокет; сокет сам провалидирует токен и досинхронизирует
// актуальные данные через событие 'profile'. Если токен невалиден — сработает
// уже существующий обработчик socket.on('connect_error').
(() => {
  const token = localStorage.getItem('chatapp_token');
  const cached = localStorage.getItem('chatapp_profile');
  if (token && cached) {
    try {
      me = JSON.parse(cached);
      enterApp(me);
    } catch (e) {
      localStorage.removeItem('chatapp_profile');
      document.documentElement.classList.remove('has-session');
    }
  } else {
    document.documentElement.classList.remove('has-session');
  }
})();

// ─── Socket error handling ────────────────────────────────────────────────────
socket.on('connect_error', err => {
  console.error('Socket error:', err);
  if (err.message === 'Unauthorized') {
    forceLogoutToLogin('Сессия истекла, войдите снова');
  } else {
    showTransientNotice('Нет соединения с сервером');
  }
});
socket.on('disconnect', reason => {
  console.warn('Socket disconnected:', reason);
  if (reason !== 'io client disconnect') {
    showTransientNotice('Соединение потеряно, переподключение…');
  }
});