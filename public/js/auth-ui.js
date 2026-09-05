'use strict';

/* ============================================================================
 * CONSTANTS
 * ==========================================================================*/
const ID_RE = /^[a-z0-9_]+$/;
const ID_MIN_LEN = 3;
const PW_MIN_LEN = 8;
const SLOW_SERVER_HINT_MS = 6000;   // после этого показываем «Сервер запускается…»
const NICK_FETCH_CONCURRENCY = 6;
const SIDEBAR_TAB_KEY = 'chatapp_tab';

const AUTH_ERRORS = {
  invalid_credentials: 'Неверный ID или пароль',
  wrong_password: 'Неверный ID или пароль',
  not_found: 'Пользователь не найден',
  user_exists: 'Этот ID уже занят',
  already_exists: 'Этот ID уже занят',
  invalid_id: 'ID: только a-z, 0-9, _',
  weak_password: `Пароль минимум ${PW_MIN_LEN} символов`,
  rate_limited: 'Слишком много попыток, попробуйте позже',
  server_error: 'Ошибка сервера',
};

const FRIEND_REQUEST_ERRORS = {
  rate_limited: 'Слишком много заявок, попробуйте позже',
  not_found: 'Пользователь не найден',
  self: 'Нельзя добавить самого себя',
  already_friends: 'Вы уже друзья',
  already_sent: 'Заявка уже отправлена',
  blocked: 'Невозможно отправить заявку',
  limit_reached: 'Достигнут лимит заявок/друзей',
  target_limit_reached: 'У пользователя переполнен список заявок',
  server_error: 'Ошибка сервера',
};

const SEND_MESSAGE_ERRORS = {
  image_too_large: 'Изображение слишком большое',
  text_too_long: 'Сообщение слишком длинное',
  not_friends: 'Вы не друзья с этим пользователем',
  blocked: 'Невозможно отправить сообщение',
};

const GROUP_ERRORS = {
  not_found: 'Группа не найдена',
  not_member: 'Вы не участник группы',
  not_owner: 'Только владелец может это делать',
  limit_reached: 'Достигнут лимит участников',
  not_friends: 'Можно добавлять только друзей',
  already_member: 'Пользователь уже в группе',
  blocked: 'Невозможно добавить пользователя',
  rate_limited: 'Слишком много действий, подождите',
  text_too_long: 'Сообщение слишком длинное',
};

/* ============================================================================
 * SMALL HELPERS
 * ==========================================================================*/
const getReqId = r => (typeof r === 'string' ? r : r?.id);
const userIdOf = u => (typeof u === 'string' ? u : u?.id);

/** Человекочитаемое сообщение об ошибке: код → словарь, иначе текст сервера (если это текст), иначе fallback. */
function humanError(raw, dict, fallback) {
  if (!raw) return fallback;
  if (dict[raw]) return dict[raw];
  const looksLikeText = /\s|[а-яё]/i.test(String(raw)) && String(raw).length < 120;
  return looksLikeText ? String(raw) : fallback;
}

function bindEnterToButton(inputIds, buttonId) {
  inputIds.forEach(id =>
    on(id, 'keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        $(buttonId)?.click();
      }
    })
  );
}

function removeFriendRequest(fromId) {
  if (!state.me?.friendRequests) return;
  state.me.friendRequests = state.me.friendRequests.filter(r => getReqId(r) !== fromId);
  renderRequests(state.me.friendRequests);
}

function forgetGroup(groupId) {
  delete state.groups[groupId];
  delete state.groupUnread[groupId];
  delete state.groupVoiceCalls[groupId];
  delete state.groupLastActivity[groupId];
  renderGroupsList();
  updateTitleBadge();
  if (state.activeGroup === groupId) closeActiveChat();
  if (state.infoGroupId === groupId) closeGroupInfoModal();
  if (callState.active && callState.isGroup && callState.groupId === groupId) hangupCall();
}

function syncActiveGroupUI(group) {
  if (!group || state.activeGroup !== group.id) return;
  updateGroupChatHeader(group);
  renderGroupMembersPanel(group);
}

/* ============================================================================
 * UI WIRING: password toggle / tabs / rail
 * ==========================================================================*/
whenDomReady(() => {
  document.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      const svg = btn.querySelector('svg');
      if (svg) svg.style.opacity = show ? '0.5' : '1';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      input.focus({ preventScroll: true });
    });
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const content = $('tab-' + tab.dataset.tab);
      content?.classList.add('active');
      setErr('');
      content?.querySelector('input')?.focus();
    });
  });

  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => switchSidebarTab(tab.dataset.stab));
  });
  switchSidebarTab(localStorage.getItem(SIDEBAR_TAB_KEY) === 'groups' ? 'groups' : 'dm');

  // Автофокус на поле ID, если показан экран входа
  if (!document.documentElement.classList.contains('has-session')) {
    $('login-id')?.focus({ preventScroll: true });
  }
});

function switchSidebarTab(name) {
  const isGroups = name === 'groups';
  document.querySelectorAll('.sidebar-tab').forEach(t => {
    const active = t.dataset.stab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  // Рельса слева (fallback для браузеров без :has)
  document.querySelectorAll('.rail-btn[data-rail]').forEach(b => {
    const active = b.dataset.rail === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-current', active ? 'page' : 'false');
  });
  setDisplay('dm-panel', isGroups ? 'none' : '');
  setDisplay('groups-panel', isGroups ? '' : 'none');
  try { localStorage.setItem(SIDEBAR_TAB_KEY, isGroups ? 'groups' : 'dm'); } catch (e) {}
}

/* ============================================================================
 * REGISTER / LOGIN
 * ==========================================================================*/
async function withButtonBusy(btn, busyText, fn) {
  if (!btn) return fn();
  if (btn.disabled) return; // защита от двойного клика
  const original = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = busyText;
  // Render free-tier «просыпается» до ~50 с — объясняем, почему долго
  const slowTimer = setTimeout(() => { btn.textContent = 'Сервер запускается…'; }, SLOW_SERVER_HINT_MS);
  try {
    await fn();
  } finally {
    clearTimeout(slowTimer);
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = original;
  }
}

async function authRequest(path, body, fallbackError) {
  try {
    const res = await authFetch(BACKEND_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await safeJson(res);
    if (res.status === 429) return setErr(AUTH_ERRORS.rate_limited);
    if (!res.ok) return setErr(humanError(data?.error, AUTH_ERRORS, fallbackError));
    if (!data?.user || !data?.token) return setErr('Некорректный ответ сервера');
    saveAndLogin(data.user, data.user.id || body.userId, data.token);
  } catch (e) {
    if (e instanceof AuthError) return;
    setErr(e?.name === 'TimeoutError' ? 'Сервер не отвечает, попробуйте ещё раз' : 'Ошибка сети');
  }
}

on('btn-register', 'click', async () => {
  setErr('');
  const userId = ($('reg-id')?.value || '').trim().toLowerCase();
  const nickname = ($('reg-nick')?.value || '').trim() || userId;
  const password = $('reg-pw')?.value || '';

  if (userId.length < ID_MIN_LEN) return setErr(`ID минимум ${ID_MIN_LEN} символа`);
  if (!ID_RE.test(userId)) return setErr('ID: только a-z, 0-9, _');
  if (password.length < PW_MIN_LEN) return setErr(`Пароль минимум ${PW_MIN_LEN} символов`);

  await withButtonBusy($('btn-register'), 'Загрузка…', () =>
    authRequest('/api/register', { userId, nickname, password }, 'Ошибка регистрации')
  );
});

on('btn-login', 'click', async () => {
  setErr('');
  const userId = ($('login-id')?.value || '').trim().toLowerCase();
  const password = $('login-pw')?.value || '';
  if (!userId || !password) return setErr('Введите ID и пароль');

  await withButtonBusy($('btn-login'), 'Загрузка…', () =>
    authRequest('/api/login', { userId, password }, 'Ошибка входа')
  );
});

bindEnterToButton(['login-id', 'login-pw'], 'btn-login');
bindEnterToButton(['reg-id', 'reg-nick', 'reg-pw'], 'btn-register');

on('btn-logout', 'click', e => {
  e.stopPropagation();
  if (callState.active && !confirm('Идёт звонок. Выйти из аккаунта?')) return;
  forceLogoutToLogin();
});

function showChatPlaceholder() {
  setDisplay('chat-placeholder', 'flex');
  setDisplay('chat-window', 'none');
  setDisplay('group-chat-window', 'none');
  setDisplay('group-voice-bar', 'none');
}

function closeActiveChat() {
  state.activeFriend = null;
  state.activeGroup = null;
  state.pendingDeleteId = null;
  setDisplay('delete-confirm', 'none');
  document.querySelectorAll('.friend-item.active').forEach(el => el.classList.remove('active'));
  showChatPlaceholder();
}

/* ── Восстановление сессии при загрузке (идемпотентно) ─────────────────── */
whenDomReady(() => {
  if (state.me) return;
  const token = localStorage.getItem('chatapp_token');
  const raw = localStorage.getItem('chatapp_profile');
  if (!token || !raw) return;
  try {
    const profile = JSON.parse(raw);
    if (profile && profile.id) {
      state.me = profile;
      enterApp(profile);
    } else {
      throw new Error('bad profile');
    }
  } catch (e) {
    localStorage.removeItem('chatapp_profile');
    localStorage.removeItem('chatapp_token');
    document.documentElement.classList.remove('has-session');
  }
});

/* ============================================================================
 * ME CARD → EDIT PROFILE
 * ==========================================================================*/
on('me-card', 'click', e => {
  if (e.target.closest('#btn-logout')) return;
  if (state.me) openEditProfileModal();
});
on('me-card', 'keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === $('me-card')) {
    e.preventDefault();
    if (state.me) openEditProfileModal();
  }
});

/* ============================================================================
 * SEARCH
 * ==========================================================================*/
let searchTimer = null;
let searchAbort = null;

on('search-input', 'input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) return closeDrop();
  searchTimer = setTimeout(() => doSearch(q), SEARCH_DEBOUNCE_MS);
});
on('search-input', 'blur', () => setTimeout(() => {
  // не закрывать, если фокус ушёл внутрь дропдауна (стрелки)
  if (!$('search-results')?.contains(document.activeElement)) closeDrop(false);
}, 200));
on('search-input', 'focus', () => {
  const q = $('search-input').value.trim();
  if (q) doSearch(q);
});
on('search-input', 'keydown', e => {
  const drop = $('search-results');
  if (e.key === 'Escape') {
    closeDrop();
    e.target.blur();
  } else if (e.key === 'Enter') {
    drop?.querySelector('.s-item[data-uid]')?.click(); // Enter открывает первый результат
  } else if (e.key === 'ArrowDown' && drop?.classList.contains('open')) {
    e.preventDefault();
    drop.querySelector('.s-item[data-uid]')?.focus();
  }
});

// Навигация стрелками по результатам
on('search-results', 'keydown', e => {
  const items = [...$('search-results').querySelectorAll('.s-item[data-uid]')];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) $('search-input')?.focus(); else items[i - 1].focus(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); items[i].click(); }
  else if (e.key === 'Escape') { closeDrop(); }
});

function renderSearchNotice(drop, text, isError = false) {
  drop.innerHTML = `<div class="s-empty"${isError ? ' style="color:var(--text-danger)"' : ''}>${esc(text)}</div>`;
  drop.classList.add('open');
  $('search-input')?.setAttribute('aria-expanded', 'true');
}

function buildSearchItem(u) {
  const isFriend = !!state.me?.friends?.includes(u.id);
  const el = document.createElement('div');
  el.className = 's-item';
  el.dataset.uid = u.id; // нужен для отката кнопки в friendRequestError
  el.setAttribute('role', 'option');
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="s-mini-av"></div>
    <div style="flex:1;min-width:0">
      <div class="s-nick">${esc(u.nickname)}</div>
      <div class="s-id">@${esc(u.id)}</div>
    </div>
    <button class="btn-add" type="button" ${isFriend ? 'disabled' : ''}>${isFriend ? '✓ В друзьях' : 'Добавить'}</button>`;
  renderAvWithDot(el.querySelector('.s-mini-av'), u.nickname, u.avatar, !!u.online);

  const btn = el.querySelector('.btn-add');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (isFriend || btn.disabled) return;
    if (!socket.connected) return showTransientNotice('Нет соединения с сервером');
    socket.emit('sendFriendRequest', u.id);
    btn.textContent = 'Отправлено';
    btn.disabled = true;
  });
  // mousedown раньше blur → не теряем клик из‑за закрытия дропдауна
  el.addEventListener('mousedown', e => e.preventDefault());
  el.addEventListener('click', () => {
    if (isFriend) openChat(u.id);
    else showUserProfile(u.id);
    closeDrop();
  });
  return el;
}

async function doSearch(q) {
  const drop = $('search-results');
  if (!drop) return;

  searchAbort?.abort();
  searchAbort = new AbortController();
  const { signal } = searchAbort;
  const requestSeq = ++state.seq.search;
  const stale = () => requestSeq !== state.seq.search;

  try {
    const res = await authFetch(BACKEND_URL + '/api/search?q=' + encodeURIComponent(q), { signal });
    if (stale()) return;
    if (res.status === 429) return renderSearchNotice(drop, 'Слишком часто, подождите');
    if (!res.ok) throw new Error('search failed');
    const list = await res.json();
    if (stale()) return;

    const visible = (Array.isArray(list) ? list : []).filter(u => u && u.id && u.id !== state.me?.id);
    if (!visible.length) return renderSearchNotice(drop, 'Никого не найдено');

    drop.innerHTML = '';
    visible.forEach(u => drop.appendChild(buildSearchItem(u)));
    drop.classList.add('open');
    $('search-input')?.setAttribute('aria-expanded', 'true');
  } catch (e) {
    if (e?.name === 'AbortError' || e instanceof AuthError || stale()) return;
    renderSearchNotice(drop, 'Ошибка поиска', true);
  }
}

function closeDrop(clearInput = true) {
  $('search-results')?.classList.remove('open');
  $('search-input')?.setAttribute('aria-expanded', 'false');
  if (clearInput) {
    const input = $('search-input');
    if (input) input.value = '';
  }
}

/* ============================================================================
 * SOCKET: connection / auth errors
 * ==========================================================================*/
socket.on('connect_error', err => {
  const msg = String(err?.message || err?.data?.message || '').toLowerCase();
  if (state.me && /unauthori|invalid token|jwt|auth|expired|forbidden/.test(msg)) {
    forceLogoutToLogin('Сессия истекла, войдите снова');
  }
});

/* ============================================================================
 * SOCKET EVENTS: profile / friends
 * ==========================================================================*/
socket.on('profile', profile => {
  if (!profile) return;
  state.me = { ...state.me, ...profile };
  try { localStorage.setItem('chatapp_profile', JSON.stringify(state.me)); } catch (e) {}
  state.unread = Object.assign(Object.create(null), profile.unreadCounts || {});
  state.groupUnread = Object.assign(Object.create(null), profile.groupUnreadCounts || {});

  renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
  setText('my-nick', state.me.nickname || state.me.id);
  setText('my-id', '@' + state.me.id);

  // Пересобираем карту друзей: убираем тех, кого больше нет, сохраняем известные данные
  const friendIds = profile.friends || [];
  const next = Object.create(null);
  friendIds.forEach(id => {
    next[id] = state.friends[id] || { id, nickname: id, online: false };
  });
  state.friends = next;

  renderRequests(profile.friendRequests || []);
  renderFriendsList();
  fetchNicknames(friendIds);

  if (state.activeFriend) {
    if (state.friends[state.activeFriend]) openChat(state.activeFriend);
    else closeActiveChat();
  }
  loadGroups().then(() => {
    if (!state.activeGroup) return;
    if (state.groups[state.activeGroup]) openGroupChat(state.activeGroup);
    else closeActiveChat();
  });
});

let nickFetchInFlight = null;
async function fetchNicknames(ids) {
  if (!ids?.length) return;
  if (nickFetchInFlight) { await nickFetchInFlight; }

  const queue = [...new Set(ids)];
  const run = async () => {
    let touched = false;
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        if (!state.friends[id]) continue; // перестал быть другом
        try {
          const res = await authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(id));
          if (!res.ok) continue;
          const u = await res.json();
          if (!state.friends[id]) continue;
          state.friends[id] = {
            ...state.friends[id],
            id,
            nickname: u.nickname || id,
            avatar: u.avatar || null,
            online: !!u.online,
            status: u.status || '',
          };
          touched = true;
        } catch (e) {
          if (e instanceof AuthError) return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(NICK_FETCH_CONCURRENCY, queue.length) }, worker));
    if (!touched) return;

    renderFriendsList();
    const f = state.activeFriend && state.friends[state.activeFriend];
    if (f) {
      renderAv($('chat-avatar'), f.nickname, f.avatar);
      setText('chat-nick', f.nickname);
      updateStatus(f.id, f.online);
    }
  };

  nickFetchInFlight = run().finally(() => { nickFetchInFlight = null; });
  return nickFetchInFlight;
}

socket.on('friendRequest', req => {
  if (!state.me || !req?.id) return;
  state.me.friendRequests ??= [];
  if (state.me.friendRequests.some(r => getReqId(r) === req.id)) return;
  state.me.friendRequests.push({ id: req.id, nickname: req.nickname, avatar: req.avatar });
  renderRequests(state.me.friendRequests);
  showTransientNotice(`Заявка в друзья от ${req.nickname || req.id}`);
  sfx.friend();
});

socket.on('requestSent', () => showTransientNotice('Заявка отправлена'));

socket.on('friendRequestError', ({ reason, targetId } = {}) => {
  const addBtn = $('btn-add-friend');
  if (addBtn && addBtn.style.display !== 'none') {
    addBtn.textContent = 'Добавить в друзья';
    addBtn.disabled = false;
  }

  const resetBtn = btn => {
    btn.textContent = 'Добавить';
    btn.disabled = false;
  };
  if (targetId) {
    const row = document.querySelector(`.s-item[data-uid="${CSS.escape(targetId)}"] .btn-add`);
    if (row) resetBtn(row);
  } else {
    document
      .querySelectorAll('#search-results .btn-add:disabled')
      .forEach(btn => btn.textContent === 'Отправлено' && resetBtn(btn));
  }

  showTransientNotice(FRIEND_REQUEST_ERRORS[reason] || 'Не удалось отправить заявку');
});

socket.on('requestDeclined', fromId => removeFriendRequest(userIdOf(fromId)));

socket.on('friendAdded', user => {
  if (!state.me || !user?.id) return;
  state.friends[user.id] = {
    ...(state.friends[user.id] || {}),
    id: user.id,
    nickname: user.nickname || user.id,
    avatar: user.avatar || null,
    online: !!user.online,
  };
  state.me.friends ??= [];
  if (!state.me.friends.includes(user.id)) state.me.friends.push(user.id);
  removeFriendRequest(user.id);
  renderFriendsList();
  showTransientNotice(`${user.nickname || user.id} теперь у вас в друзьях`);
  sfx.friend();

  // Если открыт профиль этого пользователя — спрятать кнопку «Добавить»
  const addBtn = $('btn-add-friend');
  const profileOpen = $('profile-modal')?.style.display === 'flex';
  const sameUser = $('profile-modal-id')?.textContent === '@' + user.id;
  if (addBtn && profileOpen && sameUser) addBtn.style.display = 'none';

  // В открытом поиске — обновить кнопку
  const row = document.querySelector(`.s-item[data-uid="${CSS.escape(user.id)}"] .btn-add`);
  if (row) { row.textContent = '✓ В друзьях'; row.disabled = true; }
});

socket.on('friendRemoved', ({ id } = {}) => {
  if (!id) return;
  if (state.me?.friends) state.me.friends = state.me.friends.filter(fid => fid !== id);
  delete state.friends[id];
  delete state.unread[id];
  delete state.lastActivity[id];
  renderFriendsList();
  if (state.activeFriend === id) closeActiveChat();
});

function setFriendPresence(id, online) {
  if (!id) return;
  if (state.friends[id]) {
    state.friends[id].online = online;
    updateStatus(id, online);
  }
  // Presence в группах — во ВСЕХ, а не только в открытой (иначе счётчик онлайн в списке врёт)
  let touched = false;
  Object.values(state.groups).forEach(g => {
    const m = (g.members || []).find(x => x.id === id);
    if (m && m.online !== online) {
      m.online = online;
      touched = true;
    }
  });
  if (touched) {
    renderGroupsList();
    syncActiveGroupUI(state.activeGroup && state.groups[state.activeGroup]);
  }
}

socket.on('friendOnline', u => setFriendPresence(userIdOf(u), true));
socket.on('friendOffline', u => setFriendPresence(userIdOf(u), false));

socket.on('newMessage', ({ chatWith, msg } = {}) => {
  if (!chatWith || !msg) return;
  state.lastActivity[chatWith] = getMsgTimeMs(msg);
  const isMine = msg.from === state.me?.id;
  const visible = document.visibilityState === 'visible';

  if (state.activeFriend === chatWith) {
    appendMsg(msg, 'messages');
    if (visible) {
      socket.emit('markRead', chatWith);
    } else if (!isMine) {
      // Вкладка скрыта: считаем непрочитанным, прочитаем при возврате (visibilitychange)
      state.unread[chatWith] = (state.unread[chatWith] || 0) + 1;
      updateTitleBadge();
      sfx.message();
    }
  } else {
    if (!isMine) {
      state.unread[chatWith] = (state.unread[chatWith] || 0) + 1;
      sfx.message();
    }
    updateTitleBadge();
  }
  // Порядок в списке (последняя активность)
  renderFriendsList();
});

// Вернулись на вкладку — отмечаем прочитанным то, что пришло в активный чат, пока нас не было
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !socket.connected || !state.me) return;
  if (state.activeFriend && state.unread[state.activeFriend]) {
    socket.emit('markRead', state.activeFriend);
    state.unread[state.activeFriend] = 0;
    refreshFriendItem(state.activeFriend);
  }
  if (state.activeGroup && state.groupUnread[state.activeGroup]) {
    socket.emit('markGroupRead', state.activeGroup);
    state.groupUnread[state.activeGroup] = 0;
    refreshGroupItem(state.activeGroup);
  }
  updateTitleBadge();
});

// Удаление сообщения — работает и в DM, и в группах (оба используют .g-msg)
socket.on('messageDeleted', ({ messageId } = {}) => {
  if (!messageId) return;
  const wrap = document.querySelector(`[data-msgid="${CSS.escape(String(messageId))}"]`);
  if (!wrap) return;
  wrap.classList.add('deleted');
  wrap.querySelector('.msg-del-btn')?.remove();
  const text = wrap.querySelector('.g-msg-text');
  if (text) {
    text.textContent = 'Сообщение удалено';
    text.classList.remove('jumbo');
  }
  if (state.pendingDeleteId === messageId) {
    state.pendingDeleteId = null;
    setDisplay('delete-confirm', 'none');
  }
});

socket.on('rateLimited', kind => {
  showTransientNotice(
    kind === 'sendMessage'
      ? 'Слишком много сообщений, подождите немного'
      : 'Слишком много действий, подождите'
  );
});

socket.on('sendMessageError', ({ reason } = {}) => {
  showTransientNotice(SEND_MESSAGE_ERRORS[reason] || 'Не удалось отправить сообщение');
});

/* ============================================================================
 * SOCKET EVENTS: groups
 * ==========================================================================*/
socket.on('addedToGroup', ({ group } = {}) => {
  if (!group?.id) return;
  state.groups[group.id] = group;
  state.groupLastActivity[group.id] = Date.now();
  renderGroupsList();
  showTransientNotice(`Вас добавили в группу «${group.name}»`);
  sfx.friend();
});

socket.on('groupVoiceState', ({ groupId, callId, video, participants } = {}) => {
  if (!groupId) return;
  if (!callId) delete state.groupVoiceCalls[groupId];
  else state.groupVoiceCalls[groupId] = { callId, video: !!video, participants: participants || [] };
  renderGroupsList();
  updateGroupVoiceBar(groupId);
});

socket.on('callStateChanged', ({ callId, groupId, participants } = {}) => {
  if (!groupId || !callId) return;
  const call = state.groupVoiceCalls[groupId];
  if (!call || call.callId !== callId) return;
  call.participants = participants || call.participants;
  renderGroupsList();
  updateGroupVoiceBar(groupId);
});

socket.on('groupUpdated', ({ groupId, name, avatar } = {}) => {
  const group = state.groups[groupId];
  if (!group) return void loadGroups();
  if (typeof name === 'string') group.name = name;
  if (avatar !== undefined) group.avatar = avatar;
  refreshGroupItem(groupId);
  if (state.activeGroup === groupId) {
    syncActiveGroupUI(group);
    const input = $('group-msg-input');
    if (input) input.placeholder = 'Написать в ' + group.name;
  }
  if (state.infoGroupId === groupId) openGroupInfoModal(groupId);
});

socket.on('newGroupMessage', ({ groupId, msg } = {}) => {
  if (!groupId || !msg) return;
  state.groupLastActivity[groupId] = getMsgTimeMs(msg);
  const isMine = msg.from === state.me?.id;
  const visible = document.visibilityState === 'visible';

  if (state.activeGroup === groupId) {
    appendGroupMsg(msg);
    if (visible) {
      socket.emit('markGroupRead', groupId);
    } else if (!isMine) {
      state.groupUnread[groupId] = (state.groupUnread[groupId] || 0) + 1;
      updateTitleBadge();
      sfx.message();
    }
  } else {
    if (!isMine) {
      state.groupUnread[groupId] = (state.groupUnread[groupId] || 0) + 1;
      sfx.message();
    }
    updateTitleBadge();
  }
  renderGroupsList();
});

socket.on('groupMemberJoined', ({ groupId, user } = {}) => {
  const g = state.groups[groupId];
  if (!g || !user?.id) return;
  g.members ??= [];
  if (!g.members.some(m => m.id === user.id)) g.members.push(user);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    syncActiveGroupUI(g);
    appendSystemMsg('group-messages', `${user.nickname || user.id} присоединился к группе`);
  }
  if (state.infoGroupId === groupId) renderGroupInfoMembers(g);
});

socket.on('groupMemberLeft', ({ groupId, userId } = {}) => {
  const g = state.groups[groupId];
  if (!g || !userId) return;

  if (userId === state.me?.id) {
    // Нас исключили / мы вышли
    const name = g.name;
    forgetGroup(groupId);
    showTransientNotice(`Вы больше не участник группы «${name}»`);
    return;
  }

  const left = (g.members || []).find(m => m.id === userId);
  g.members = (g.members || []).filter(m => m.id !== userId);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    syncActiveGroupUI(g);
    if (left) appendSystemMsg('group-messages', `${left.nickname || userId} покинул(а) группу`);
  }
  if (state.infoGroupId === groupId) renderGroupInfoMembers(g);
});

socket.on('groupDeleted', ({ groupId } = {}) => {
  if (!groupId) return;
  const name = state.groups[groupId]?.name;
  forgetGroup(groupId);
  if (name) showTransientNotice(`Группа «${name}» удалена`);
});

socket.on('groupError', ({ reason } = {}) => {
  showTransientNotice(GROUP_ERRORS[reason] || 'Ошибка группы');
});

/* ============================================================================
 * RENDER: friend requests
 * ==========================================================================*/
function renderRequests(reqs) {
  const sec = $('requests-section');
  const list = $('requests-list');
  if (!sec || !list) return;

  if (!reqs?.length) {
    sec.style.display = 'none';
    list.innerHTML = '';
    setText('req-badge', '');
    return;
  }

  sec.style.display = 'block';
  setText('req-badge', String(reqs.length));
  list.innerHTML = '';

  reqs.forEach(r => {
    const id = getReqId(r);
    if (!id) return;
    const nick = r.nickname || id;
    const el = document.createElement('div');
    el.className = 'req-card';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="f-av"></div>
      <div class="req-info">
        <div class="req-nick">${esc(nick)}</div>
        <div class="req-id">Входящая заявка · @${esc(id)}</div>
      </div>
      <div class="req-btns">
        <button class="btn-ok" type="button" title="Принять" aria-label="Принять заявку от ${esc(nick)}">✓</button>
        <button class="btn-no" type="button" title="Отклонить" aria-label="Отклонить заявку от ${esc(nick)}">✕</button>
      </div>`;
    renderAv(el.querySelector('.f-av'), nick, r.avatar || null);

    const guard = fn => e => {
      e.stopPropagation();
      if (!socket.connected) return showTransientNotice('Нет соединения с сервером');
      e.currentTarget.disabled = true;
      fn();
    };
    el.querySelector('.btn-ok').addEventListener('click', guard(() => socket.emit('acceptFriendRequest', id)));
    el.querySelector('.btn-no').addEventListener('click', guard(() => socket.emit('declineFriendRequest', id)));
    el.addEventListener('click', () => showUserProfile(id));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showUserProfile(id); }
    });
    list.appendChild(el);
  });
}

/* ============================================================================
 * RENDER: friends list
 * ==========================================================================*/
function sortedFriendIds() {
  const unread = id => (state.unread[id] ? 1 : 0);
  const activity = id => state.lastActivity[id] || 0;
  const online = id => (state.friends[id]?.online ? 1 : 0);
  const nick = id => state.friends[id]?.nickname || id;

  return Object.keys(state.friends).sort(
    (a, b) =>
      unread(b) - unread(a) ||          // непрочитанные выше
      activity(b) - activity(a) ||      // недавняя активность выше
      online(b) - online(a) ||          // онлайн выше
      nick(a).localeCompare(nick(b), 'ru')
  );
}

function renderFriendsList() {
  const list = $('friends-list');
  if (!list) return;
  const ids = sortedFriendIds();
  const focusedId = document.activeElement?.closest?.('.friend-item')?.dataset.fid;

  if (!ids.length) {
    list.innerHTML = emptyFriendsHTML();
  } else {
    const frag = document.createDocumentFragment();
    ids.forEach(id => {
      const el = buildFriendEl(id);
      if (el) frag.appendChild(el);
    });
    list.innerHTML = '';
    list.appendChild(frag);
    // Не терять фокус клавиатуры при перерисовке
    if (focusedId) list.querySelector(`[data-fid="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }
  updateTitleBadge();
}

function buildFriendEl(id) {
  const f = state.friends[id];
  if (!f) return null;
  const unread = state.unread[id] || 0;
  const sub = f.online ? f.status || 'В сети' : 'Не в сети';

  const el = document.createElement('div');
  el.className = 'friend-item'
    + (state.activeFriend === id ? ' active' : '')
    + (unread ? ' unread' : '');
  el.dataset.fid = id;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `${f.nickname}${unread ? `, ${plural(unread, 'новое сообщение', 'новых сообщения', 'новых сообщений')}` : ''}`);
  el.innerHTML = `
    <div class="f-av"></div>
    <div class="f-info">
      <div class="f-nick">${esc(f.nickname)}</div>
      <div class="f-stat ${f.online ? 'on' : ''}">${esc(sub)}</div>
    </div>
    ${unread ? `<div class="f-unread">${unread > 99 ? '99+' : unread}</div>` : ''}`;

  renderAvWithDot(el.querySelector('.f-av'), f.nickname, f.avatar, f.online);

  el.addEventListener('click', () => openChat(id));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openChat(id);
    }
  });
  return el;
}

// Обновляет одну строку НА МЕСТЕ (без перестановки в конец списка)
function refreshFriendItem(id) {
  const list = $('friends-list');
  if (!list) return;
  if (list.querySelector('.empty-state')) return renderFriendsList();

  const old = list.querySelector(`[data-fid="${CSS.escape(id)}"]`);
  const fresh = buildFriendEl(id);
  if (!fresh) {
    old?.remove();
    if (!list.children.length) renderFriendsList();
    return;
  }
  if (old) {
    const hadFocus = document.activeElement === old;
    old.replaceWith(fresh);
    if (hadFocus) fresh.focus({ preventScroll: true });
  } else {
    list.appendChild(fresh);
  }
  updateTitleBadge();
}

function updateStatus(id, online) {
  refreshFriendItem(id);
  if (state.activeFriend !== id) return;
  const st = $('chat-status');
  if (!st) return;
  st.textContent = online ? 'В сети' : 'Не в сети';
  st.className = 'chat-head-status' + (online ? ' on' : '');
}