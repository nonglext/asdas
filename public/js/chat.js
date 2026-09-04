/* ============================================================================
 * UI WIRING: password toggle / tabs / rail
 * ==========================================================================*/
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    const svg = btn.querySelector('svg');
    if (svg) svg.style.opacity = input.type === 'text' ? '0.5' : '1';
    btn.setAttribute('aria-label', input.type === 'text' ? 'Скрыть пароль' : 'Показать пароль');
  });
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab)?.classList.add('active');
    setErr('');
    // Фокус на первое поле активной вкладки
    $('tab-' + tab.dataset.tab)?.querySelector('input')?.focus();
  });
});

function switchSidebarTab(name) {
  const isGroups = name === 'groups';
  document.querySelectorAll('.sidebar-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.stab === name)
  );
  // Рельса слева (fallback для браузеров без :has)
  document.querySelectorAll('.rail-btn[data-rail]').forEach(b =>
    b.classList.toggle('active', b.dataset.rail === name)
  );
  setDisplay('dm-panel', isGroups ? 'none' : '');
  setDisplay('groups-panel', isGroups ? '' : 'none');
}

document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => switchSidebarTab(tab.dataset.stab));
});
switchSidebarTab('dm');

/* ============================================================================
 * REGISTER / LOGIN
 * ==========================================================================*/
async function withButtonBusy(btn, busyText, fn) {
  if (!btn) return fn();
  if (btn.disabled) return; // защита от двойного клика
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

on('btn-register', 'click', async () => {
  setErr('');
  const userId = ($('reg-id')?.value || '').trim().toLowerCase();
  const nickname = ($('reg-nick')?.value || '').trim() || userId;
  const password = $('reg-pw')?.value || '';

  if (!userId || userId.length < 3) return setErr('ID минимум 3 символа');
  if (!/^[a-z0-9_]+$/.test(userId)) return setErr('ID: только a-z, 0-9, _');
  if (!password || password.length < 8) return setErr('Пароль минимум 8 символов');

  await withButtonBusy($('btn-register'), 'Загрузка…', async () => {
    try {
      const res = await fetch(BACKEND_URL + '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, nickname, password }),
      });
      const data = await safeJson(res);
      if (!res.ok) return setErr(data.error || 'Ошибка регистрации');
      saveAndLogin(data.user, userId, data.token);
    } catch (e) {
      setErr('Ошибка сети');
    }
  });
});

on('btn-login', 'click', async () => {
  setErr('');
  const userId = ($('login-id')?.value || '').trim();
  const password = $('login-pw')?.value || '';
  if (!userId || !password) return setErr('Введите ID и пароль');

  await withButtonBusy($('btn-login'), 'Загрузка…', async () => {
    try {
      const res = await fetch(BACKEND_URL + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password }),
      });
      const data = await safeJson(res);
      if (!res.ok) return setErr(data.error || 'Ошибка входа');
      saveAndLogin(data.user, userId, data.token);
    } catch (e) {
      setErr('Ошибка сети');
    }
  });
});

['login-id', 'login-pw'].forEach(id =>
  on(id, 'keydown', e => { if (e.key === 'Enter') $('btn-login')?.click(); })
);
['reg-id', 'reg-nick', 'reg-pw'].forEach(id =>
  on(id, 'keydown', e => { if (e.key === 'Enter') $('btn-register')?.click(); })
);

on('btn-logout', 'click', () => forceLogoutToLogin());

function showChatPlaceholder() {
  setDisplay('chat-placeholder', 'flex');
  setDisplay('chat-window', 'none');
  setDisplay('group-chat-window', 'none');
  setDisplay('group-voice-bar', 'none');
}

function closeActiveChat() {
  state.activeFriend = null;
  state.activeGroup = null;
  document.querySelectorAll('.friend-item.active').forEach(el => el.classList.remove('active'));
  showChatPlaceholder();
}

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
on('search-input', 'input', () => {
  clearTimeout(searchTimer);
  const q = $('search-input').value.trim();
  if (!q) { closeDrop(); return; }
  searchTimer = setTimeout(() => doSearch(q), SEARCH_DEBOUNCE_MS);
});
on('search-input', 'blur', () => setTimeout(() => closeDrop(false), 200));
on('search-input', 'focus', () => {
  const q = $('search-input').value.trim();
  if (q) doSearch(q);
});
on('search-input', 'keydown', e => {
  if (e.key === 'Escape') { closeDrop(); e.target.blur(); }
  if (e.key === 'Enter') {
    // Enter открывает первый результат
    const first = $('search-results')?.querySelector('.s-item[data-uid]');
    if (first) first.click();
  }
});

async function doSearch(q) {
  const drop = $('search-results');
  if (!drop) return;
  const requestSeq = ++state.seq.search;
  try {
    const res = await authFetch(BACKEND_URL + '/api/search?q=' + encodeURIComponent(q));
    if (requestSeq !== state.seq.search) return;
    if (!res.ok) throw new Error('search failed');
    const list = await res.json();
    if (requestSeq !== state.seq.search) return;
    drop.innerHTML = '';

    const visible = (Array.isArray(list) ? list : []).filter(u => u && u.id !== state.me?.id);
    if (!visible.length) {
      drop.innerHTML = '<div class="s-item" style="color:var(--text3);font-size:13px;cursor:default">Никого не найдено</div>';
      drop.classList.add('open');
      return;
    }

    visible.forEach(u => {
      const isFriend = !!state.me?.friends?.includes(u.id);
      const el = document.createElement('div');
      el.className = 's-item';
      el.dataset.uid = u.id; // нужен для отката кнопки в friendRequestError
      el.innerHTML = `
        <div class="s-mini-av"></div>
        <div style="flex:1;min-width:0">
          <div class="s-nick">${esc(u.nickname)}</div>
          <div class="s-id">@${esc(u.id)}</div>
        </div>
        <button class="btn-add" type="button" ${isFriend ? 'disabled' : ''}>${isFriend ? '✓ В друзьях' : 'Добавить'}</button>`;
      renderAv(el.querySelector('.s-mini-av'), u.nickname, u.avatar);

      const btn = el.querySelector('.btn-add');
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (isFriend || btn.disabled) return;
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
      drop.appendChild(el);
    });
    drop.classList.add('open');
  } catch (e) {
    if (e instanceof AuthError) return;
    if (requestSeq !== state.seq.search) return;
    drop.innerHTML = '<div class="s-item" style="color:var(--red);font-size:13px;cursor:default">Ошибка поиска</div>';
    drop.classList.add('open');
  }
}

function closeDrop(clearInput = true) {
  $('search-results')?.classList.remove('open');
  if (clearInput) {
    const input = $('search-input');
    if (input) input.value = '';
  }
}

/* ============================================================================
 * SOCKET EVENTS: profile / friends
 * ==========================================================================*/
socket.on('profile', profile => {
  if (!profile) return;
  state.me = { ...state.me, ...profile };
  localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
  state.unread = Object.assign(Object.create(null), profile.unreadCounts || {});
  state.groupUnread = Object.assign(Object.create(null), profile.groupUnreadCounts || {});
  renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
  setText('my-nick', state.me.nickname);
  setText('my-id', '@' + state.me.id);

  // Пересобираем карту друзей: убираем тех, кого больше нет, сохраняем известные данные
  const friendIds = profile.friends || [];
  const next = Object.create(null);
  friendIds.forEach(fId => {
    next[fId] = state.friends[fId] || { id: fId, nickname: fId, online: false };
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
    if (state.activeGroup) {
      if (state.groups[state.activeGroup]) openGroupChat(state.activeGroup);
      else closeActiveChat();
    }
  });
});

async function fetchNicknames(ids) {
  if (!ids.length) return;
  const results = await Promise.allSettled(
    ids.map(id =>
      authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(id)).then(async res => {
        if (!res.ok) throw new Error('not ok');
        return { id, data: await res.json() };
      })
    )
  );
  results.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const { id, data: u } = r.value;
    if (!state.friends[id]) return; // за время запроса перестал быть другом
    state.friends[id] = { ...state.friends[id], id, nickname: u.nickname || id, avatar: u.avatar || null, online: !!u.online, status: u.status || '' };
  });
  renderFriendsList();
  if (state.activeFriend && state.friends[state.activeFriend]) {
    const f = state.friends[state.activeFriend];
    renderAv($('chat-avatar'), f.nickname, f.avatar);
    setText('chat-nick', f.nickname);
    updateStatus(f.id, f.online);
  }
}

socket.on('friendRequest', req => {
  if (!state.me || !req) return;
  if (!state.me.friendRequests) state.me.friendRequests = [];
  const already = state.me.friendRequests.some(r => (r.id || r) === req.id);
  if (!already) {
    state.me.friendRequests.push({ id: req.id, nickname: req.nickname, avatar: req.avatar });
    renderRequests(state.me.friendRequests);
    showTransientNotice(`Заявка в друзья от ${req.nickname || req.id}`);
    sfx.friend();
  }
});

socket.on('requestSent', () => showTransientNotice('Заявка отправлена'));

socket.on('friendRequestError', ({ reason, targetId } = {}) => {
  const addBtn = $('btn-add-friend');
  if (addBtn && addBtn.style.display !== 'none') {
    addBtn.textContent = 'Добавить в друзья';
    addBtn.disabled = false;
  }
  if (targetId) {
    const row = document.querySelector(`.s-item[data-uid="${CSS.escape(targetId)}"] .btn-add`);
    if (row) {
      row.textContent = 'Добавить';
      row.disabled = false;
    }
  } else {
    document.querySelectorAll('#search-results .btn-add:disabled').forEach(btn => {
      if (btn.textContent === 'Отправлено') {
        btn.textContent = 'Добавить';
        btn.disabled = false;
      }
    });
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
    server_error: 'Ошибка сервера',
  };
  showTransientNotice(messages[reason] || 'Не удалось отправить заявку');
});

socket.on('requestDeclined', fromId => {
  if (state.me?.friendRequests) {
    state.me.friendRequests = state.me.friendRequests.filter(r => (r.id || r) !== fromId);
    renderRequests(state.me.friendRequests);
  }
});

socket.on('friendAdded', user => {
  if (!state.me || !user) return;
  state.friends[user.id] = { id: user.id, nickname: user.nickname || user.id, avatar: user.avatar || null, online: !!user.online };
  if (!state.me.friends) state.me.friends = [];
  if (!state.me.friends.includes(user.id)) state.me.friends.push(user.id);
  if (state.me.friendRequests) {
    state.me.friendRequests = state.me.friendRequests.filter(r => (r.id || r) !== user.id);
    renderRequests(state.me.friendRequests);
  }
  renderFriendsList();
  showTransientNotice(`${user.nickname || user.id} теперь у вас в друзьях`);
  sfx.friend();
  // Если открыт профиль этого пользователя — спрятать кнопку «Добавить»
  const addBtn = $('btn-add-friend');
  if (addBtn && $('profile-modal')?.style.display === 'flex' &&
      $('profile-modal-id')?.textContent === '@' + user.id) {
    addBtn.style.display = 'none';
  }
});

socket.on('friendRemoved', ({ id } = {}) => {
  if (!id) return;
  if (state.me?.friends) state.me.friends = state.me.friends.filter(fid => fid !== id);
  delete state.friends[id];
  delete state.unread[id];
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
    if (m && m.online !== online) { m.online = online; touched = true; }
  });
  if (touched) {
    renderGroupsList();
    const g = state.activeGroup && state.groups[state.activeGroup];
    if (g) {
      updateGroupChatHeader(g);
      renderGroupMembersPanel(g);
    }
  }
}

socket.on('friendOnline', u => setFriendPresence(typeof u === 'string' ? u : u?.id, true));
socket.on('friendOffline', u => setFriendPresence(typeof u === 'string' ? u : u?.id, false));

socket.on('newMessage', ({ chatWith, msg } = {}) => {
  if (!chatWith || !msg) return;
  state.lastActivity[chatWith] = getMsgTimeMs(msg);
  const isMine = msg.from === state.me?.id;
  if (state.activeFriend === chatWith) {
    appendMsg(msg, 'messages');
    if (document.visibilityState === 'visible') socket.emit('markRead', chatWith);
    else if (!isMine) sfx.message();
    // Порядок в списке (последняя активность) обновляем без «прыжка» выделения
    renderFriendsList();
  } else {
    state.unread[chatWith] = (state.unread[chatWith] || 0) + 1;
    renderFriendsList();
    updateTitleBadge();
    if (!isMine) sfx.message();
  }
});

// Удаление сообщения — работает и в DM, и в группах (оба используют .g-msg)
socket.on('messageDeleted', ({ messageId } = {}) => {
  if (!messageId) return;
  const wrap = document.querySelector(`[data-msgid="${CSS.escape(messageId)}"]`);
  if (!wrap) return;
  wrap.classList.add('deleted');
  wrap.querySelector('.msg-del-btn')?.remove();
  const text = wrap.querySelector('.g-msg-text');
  if (text) { text.textContent = 'Сообщение удалено'; text.classList.remove('jumbo'); }
});

socket.on('rateLimited', kind => {
  if (kind === 'sendMessage') showTransientNotice('Слишком много сообщений, подождите немного');
  else showTransientNotice('Слишком много действий, подождите');
});

socket.on('sendMessageError', ({ reason } = {}) => {
  const messages = {
    image_too_large: 'Изображение слишком большое',
    text_too_long: 'Сообщение слишком длинное',
    not_friends: 'Вы не друзья с этим пользователем',
    blocked: 'Невозможно отправить сообщение',
  };
  showTransientNotice(messages[reason] || 'Не удалось отправить сообщение');
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
  if (call && call.callId === callId) {
    call.participants = participants || call.participants;
    renderGroupsList();
    updateGroupVoiceBar(groupId);
  }
});

socket.on('groupUpdated', ({ groupId, name, avatar } = {}) => {
  const group = state.groups[groupId];
  if (!group) { loadGroups(); return; }
  if (typeof name === 'string') group.name = name;
  if (avatar !== undefined) group.avatar = avatar;
  refreshGroupItem(groupId);
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(group);
    renderGroupMembersPanel(group);
    const input = $('group-msg-input');
    if (input) input.placeholder = 'Написать в ' + group.name;
  }
  if (state.infoGroupId === groupId) openGroupInfoModal(groupId);
});

socket.on('newGroupMessage', ({ groupId, msg } = {}) => {
  if (!groupId || !msg) return;
  state.groupLastActivity[groupId] = getMsgTimeMs(msg);
  const isMine = msg.from === state.me?.id;
  if (state.activeGroup === groupId) {
    appendGroupMsg(msg);
    if (document.visibilityState === 'visible') socket.emit('markGroupRead', groupId);
    else if (!isMine) sfx.message();
    renderGroupsList();
  } else {
    state.groupUnread[groupId] = (state.groupUnread[groupId] || 0) + 1;
    renderGroupsList();
    updateTitleBadge();
    if (!isMine) sfx.message();
  }
});

socket.on('groupMemberJoined', ({ groupId, user } = {}) => {
  const g = state.groups[groupId];
  if (!g || !user) return;
  if (!g.members) g.members = [];
  if (!g.members.some(m => m.id === user.id)) g.members.push(user);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
    appendSystemMsg('group-messages', `${user.nickname || user.id} присоединился к группе`);
  }
  if (state.infoGroupId === groupId) renderGroupInfoMembers(g);
});

socket.on('groupMemberLeft', ({ groupId, userId } = {}) => {
  const g = state.groups[groupId];
  if (!g) return;
  if (userId === state.me?.id) {
    // Нас исключили / мы вышли
    delete state.groups[groupId];
    delete state.groupUnread[groupId];
    delete state.groupVoiceCalls[groupId];
    renderGroupsList();
    if (state.activeGroup === groupId) closeActiveChat();
    if (state.infoGroupId === groupId) closeGroupInfoModal();
    if (callState.active && callState.isGroup && callState.groupId === groupId) hangupCall();
    showTransientNotice(`Вы больше не участник группы «${g.name}»`);
    return;
  }
  const left = (g.members || []).find(m => m.id === userId);
  g.members = (g.members || []).filter(m => m.id !== userId);
  renderGroupsList();
  if (state.activeGroup === groupId) {
    updateGroupChatHeader(g);
    renderGroupMembersPanel(g);
    if (left) appendSystemMsg('group-messages', `${left.nickname || userId} покинул(а) группу`);
  }
  if (state.infoGroupId === groupId) renderGroupInfoMembers(g);
});

socket.on('groupDeleted', ({ groupId } = {}) => {
  if (!groupId) return;
  const name = state.groups[groupId]?.name;
  delete state.groups[groupId];
  delete state.groupUnread[groupId];
  delete state.groupVoiceCalls[groupId];
  renderGroupsList();
  updateTitleBadge();
  if (state.activeGroup === groupId) closeActiveChat();
  if (state.infoGroupId === groupId) closeGroupInfoModal();
  if (callState.active && callState.isGroup && callState.groupId === groupId) hangupCall();
  if (name) showTransientNotice(`Группа «${name}» удалена`);
});

socket.on('groupError', ({ reason } = {}) => {
  const messages = {
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
  showTransientNotice(messages[reason] || 'Ошибка группы');
});

/* ============================================================================
 * RENDER: friend requests
 * ==========================================================================*/
function renderRequests(reqs) {
  const sec = $('requests-section');
  const list = $('requests-list');
  if (!sec || !list) return;
  if (!reqs || !reqs.length) {
    sec.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  sec.style.display = 'block';
  setText('req-badge', String(reqs.length));
  list.innerHTML = '';
  reqs.forEach(r => {
    const id = r.id || r;
    const nick = r.nickname || id;
    const el = document.createElement('div');
    el.className = 'req-card';
    el.innerHTML = `
      <div class="f-av"></div>
      <div style="flex:1;min-width:0">
        <div class="req-nick">${esc(nick)}</div>
        <div class="req-id">Входящая заявка · @${esc(id)}</div>
      </div>
      <div class="req-btns">
        <button class="btn-ok" type="button" title="Принять">✓</button>
        <button class="btn-no" type="button" title="Отклонить">✕</button>
      </div>`;
    renderAv(el.querySelector('.f-av'), nick, r.avatar || null);
    el.querySelector('.btn-ok').onclick = e => { e.stopPropagation(); socket.emit('acceptFriendRequest', id); };
    el.querySelector('.btn-no').onclick = e => { e.stopPropagation(); socket.emit('declineFriendRequest', id); };
    el.addEventListener('click', () => showUserProfile(id));
    list.appendChild(el);
  });
}

/* ============================================================================
 * RENDER: friends list
 * ==========================================================================*/
function sortedFriendIds() {
  return Object.keys(state.friends).sort((a, b) => {
    const ua = state.unread[a] || 0, ub = state.unread[b] || 0;
    if (!!ua !== !!ub) return ua ? -1 : 1;                       // непрочитанные выше
    const la = state.lastActivity[a] || 0, lb = state.lastActivity[b] || 0;
    if (la !== lb) return lb - la;                                // недавняя активность выше
    const oa = !!state.friends[a].online, ob = !!state.friends[b].online;
    if (oa !== ob) return oa ? -1 : 1;                           // онлайн выше
    return (state.friends[a].nickname || a).localeCompare(state.friends[b].nickname || b, 'ru');
  });
}

function renderFriendsList() {
  const list = $('friends-list');
  if (!list) return;
  const ids = sortedFriendIds();
  if (!ids.length) {
    list.innerHTML = emptyFriendsHTML();
    updateTitleBadge();
    return;
  }
  list.innerHTML = '';
  ids.forEach(id => {
    const el = buildFriendEl(id);
    if (el) list.appendChild(el);
  });
  updateTitleBadge();
}

function buildFriendEl(id) {
  const f = state.friends[id];
  if (!f) return null;
  const u = state.unread[id] || 0;

  const el = document.createElement('div');
  el.className = 'friend-item' + (state.activeFriend === id ? ' active' : '');
  el.dataset.fid = id;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const sub = f.online ? (f.status ? f.status : 'В сети') : 'Не в сети';
  el.innerHTML = `
    <div class="f-av"></div>
    <div class="f-info">
      <div class="f-nick">${esc(f.nickname)}</div>
      <div class="f-stat ${f.online ? 'on' : ''}">${esc(sub)}</div>
    </div>
    ${u ? `<div class="f-unread">${u > 99 ? '99+' : u}</div>` : ''}`;

  renderAvWithDot(el.querySelector('.f-av'), f.nickname, f.avatar, f.online);

  el.onclick = () => openChat(id);
  el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(id); } };
  return el;
}

// Обновляет одну строку НА МЕСТЕ (без перестановки в конец списка)
function refreshFriendItem(id) {
  const list = $('friends-list');
  if (!list) return;
  if (list.querySelector('.empty-state')) { renderFriendsList(); return; }
  const old = list.querySelector(`[data-fid="${CSS.escape(id)}"]`);
  const fresh = buildFriendEl(id);
  if (!fresh) { old?.remove(); if (!list.children.length) renderFriendsList(); return; }
  if (old) old.replaceWith(fresh);
  else list.appendChild(fresh);
}

function updateStatus(id, online) {
  refreshFriendItem(id);
  if (state.activeFriend === id) {
    const st = $('chat-status');
    if (st) {
      st.textContent = online ? 'В сети' : 'Не в сети';
      st.className = 'chat-head-status' + (online ? ' on' : '');
    }
  }
}

/* ============================================================================
 * RENDER: groups list
 * ==========================================================================*/
async function loadGroups() {
  try {
    const res = await authFetch(BACKEND_URL + '/api/groups');
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;
    const next = Object.create(null);
    list.forEach(g => { if (g?.id) next[g.id] = g; });
    state.groups = next;
    renderGroupsList();
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Не удалось загрузить группы');
  }
}

function sortedGroupIds() {
  return Object.keys(state.groups).sort((a, b) => {
    const ua = state.groupUnread[a] || 0, ub = state.groupUnread[b] || 0;
    if (!!ua !== !!ub) return ua ? -1 : 1;
    const la = state.groupLastActivity[a] || 0, lb = state.groupLastActivity[b] || 0;
    if (la !== lb) return lb - la;
    return (state.groups[a].name || '').localeCompare(state.groups[b].name || '', 'ru');
  });
}

function renderGroupsList() {
  const list = $('groups-list');
  if (!list) return;
  const ids = sortedGroupIds();
  if (!ids.length) {
    list.innerHTML = emptyGroupsHTML();
    updateTitleBadge();
    return;
  }
  list.innerHTML = '';
  ids.forEach(id => {
    const el = buildGroupEl(id);
    if (el) list.appendChild(el);
  });
  updateTitleBadge();
}

function memberName(g, peerId) {
  if (peerId === state.me?.id) return state.me.nickname || peerId;
  return g?.members?.find(m => m.id === peerId)?.nickname || state.friends[peerId]?.nickname || peerId;
}

function buildGroupEl(id) {
  const g = state.groups[id];
  if (!g) return null;
  const u = state.groupUnread[id] || 0;
  const members = g.members || [];
  const onlineCount = members.filter(m => m.online).length;
  const voice = state.groupVoiceCalls[id];
  const voiceMembers = voice ? voice.participants.map(pid => memberName(g, pid)) : [];
  const inThisCall = voice && callState.active && callState.callId === voice.callId;

  const el = document.createElement('div');
  el.className = 'friend-item group-item' + (state.activeGroup === id ? ' active' : '');
  el.dataset.gid = id;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.innerHTML = `
    <div class="f-av group-av-slot"></div>
    <div class="f-info">
      <div class="f-nick">${esc(g.name)}</div>
      <div class="f-stat">${plural(members.length, 'участник', 'участника', 'участников')} · ${onlineCount} в сети</div>
    </div>
    ${u ? `<div class="f-unread">${u > 99 ? '99+' : u}</div>` : ''}
    ${voice ? `<div class="group-voice-channel" data-voice-group="${esc(id)}">
      <div class="group-voice-channel-head">
        <span class="group-voice-channel-icon">🔊</span>
        <span class="group-voice-channel-name">Голосовой канал</span>
        <span class="group-voice-channel-count">${voice.participants.length}</span>
      </div>
      <div class="group-voice-channel-members">${voiceMembers.length
        ? voiceMembers.map(name => `<span class="group-voice-member"><i></i>${esc(name)}</span>`).join('')
        : '<span class="group-voice-member empty">Канал активен</span>'}</div>
      <button class="group-voice-channel-join" type="button" ${inThisCall || callState.active ? 'disabled' : ''}>${inThisCall ? 'Вы в канале' : 'Войти'}</button>
    </div>` : ''}`;

  renderGroupAv(el.querySelector('.group-av-slot'), g);
  el.onclick = () => openGroupChat(id);
  el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGroupChat(id); } };
  const joinButton = el.querySelector('.group-voice-channel-join');
  if (joinButton) {
    joinButton.onclick = event => {
      event.stopPropagation();
      joinExistingGroupVoice(id);
    };
  }
  return el;
}

function refreshGroupItem(id) {
  const list = $('groups-list');
  if (!list) return;
  if (list.querySelector('.empty-state')) { renderGroupsList(); return; }
  const old = list.querySelector(`[data-gid="${CSS.escape(id)}"]`);
  const fresh = buildGroupEl(id);
  if (!fresh) { old?.remove(); if (!list.children.length) renderGroupsList(); return; }
  if (old) old.replaceWith(fresh);
  else list.appendChild(fresh);
}

/* ============================================================================
 * MOBILE VIEW HELPER
 * ==========================================================================*/
function enterMobileChatView(backBtnId) {
  if (window.innerWidth > 640) return;
  document.querySelector('.sidebar')?.classList.add('hidden');
  document.querySelector('.chat-main')?.classList.remove('hidden');
  setDisplay(backBtnId, '');
}

/* ============================================================================
 * MESSAGE LIST HELPERS: приветствие, разделители дат/новых, системные строки
 * ==========================================================================*/
function resetMsgContainer(box) {
  box.innerHTML = '';
  delete box.dataset.lastDay;
  delete box.dataset.hasNewDivider;
}

/** «Это начало вашей истории…» — блок в самом верху (как в Discord) */
function renderChatWelcome(box, { nick, avatar, group, sub }) {
  const w = document.createElement('div');
  w.className = 'chat-welcome';
  w.innerHTML = `
    <div class="chat-welcome-av ${group ? 'group-av' : ''}"></div>
    <div class="chat-welcome-title">${esc(nick)}</div>
    <div class="chat-welcome-sub">${sub}</div>`;
  const avEl = w.querySelector('.chat-welcome-av');
  if (group) renderGroupAv(avEl, group);
  else renderAv(avEl, nick, avatar);
  box.appendChild(w);
}

function ensureDateDivider(container, timeMs) {
  const key = dayKey(timeMs);
  if (container.dataset.lastDay === key) return;
  container.dataset.lastDay = key;
  const d = document.createElement('div');
  d.className = 'msg-divider';
  d.innerHTML = `<span>${esc(fmtDayLabel(timeMs))}</span>`;
  container.appendChild(d);
}

function appendNewMessagesDivider(container) {
  if (container.dataset.hasNewDivider) return;
  container.dataset.hasNewDivider = '1';
  const d = document.createElement('div');
  d.className = 'msg-divider new';
  d.innerHTML = '<span>Новые сообщения</span>';
  container.appendChild(d);
}

/** Системное сообщение («X присоединился») — курсивная строка без аватара */
function appendSystemMsg(containerId, text) {
  const container = $(containerId);
  if (!container) return;
  const stick = isNearBottom(container);
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.innerHTML = `<span class="msg-system-icon">→</span><span>${esc(text)}</span><span class="msg-system-time">${esc(fmtTime(Date.now()))}</span>`;
  container.appendChild(el);
  if (stick) scrollMsgs(containerId);
}

/* ============================================================================
 * DM CHAT
 * ==========================================================================*/
async function openChat(id) {
  if (!state.me || !id) return;
  const prevGroup = state.activeGroup;
  const unreadBefore = state.unread[id] || 0;
  state.activeFriend = id;
  state.activeGroup = null;
  state.unread[id] = 0;
  updateTitleBadge();

  document.querySelectorAll('.friend-item').forEach(el =>
    el.classList.toggle('active', el.dataset.fid === id)
  );
  refreshFriendItem(id);
  if (prevGroup) refreshGroupItem(prevGroup);

  const f = state.friends[id] || { id, nickname: id, online: false };
  renderAv($('chat-avatar'), f.nickname, f.avatar);
  setText('chat-nick', f.nickname);
  const st = $('chat-status');
  if (st) {
    st.textContent = f.online ? 'В сети' : 'Не в сети';
    st.className = 'chat-head-status' + (f.online ? ' on' : '');
  }
  const input = $('msg-input');
  if (input) input.placeholder = `Написать @${f.nickname}`;

  setDisplay('chat-placeholder', 'none');
  setDisplay('group-chat-window', 'none');
  setDisplay('group-voice-bar', 'none');
  setDisplay('chat-window', 'flex');

  enterMobileChatView('btn-back');
  syncVoiceOverlayPosition();

  const box = $('messages');
  if (!box) return;
  resetMsgContainer(box);
  box.innerHTML = placeholderHTML('Загрузка…');

  const requestSeq = ++state.seq.chat;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(state.me.id)}/${encodeURIComponent(id)}`);
    if (requestSeq !== state.seq.chat) return;
    if (!res.ok) throw new Error('history failed');
    const history = await res.json();
    if (requestSeq !== state.seq.chat) return;
    resetMsgContainer(box);
    renderChatWelcome(box, {
      nick: f.nickname, avatar: f.avatar,
      sub: `Это начало вашей истории личных сообщений с <b>@${esc(f.id)}</b>.`,
    });
    if (Array.isArray(history) && history.length) {
      const firstNewIdx = unreadBefore > 0 ? Math.max(0, history.length - unreadBefore) : -1;
      history.forEach((m, i) => {
        if (i === firstNewIdx && m.from !== state.me.id) appendNewMessagesDivider(box);
        appendMsg(m, 'messages', false);
      });
      const last = history[history.length - 1];
      if (last) state.lastActivity[id] = Math.max(state.lastActivity[id] || 0, getMsgTimeMs(last));
    }
    scrollMsgs('messages');
  } catch (e) {
    if (requestSeq !== state.seq.chat) return;
    if (e instanceof AuthError) return;
    box.innerHTML = placeholderHTML('Ошибка загрузки', true);
  }
  socket.emit('markRead', id);
  if (window.innerWidth > 640) input?.focus();
}

/* ============================================================================
 * MESSAGE RENDERING (Discord-style, с группировкой подряд идущих сообщений)
 * ==========================================================================*/
function shouldGroupMsg(container, senderId, timeMs) {
  const last = container.lastElementChild;
  if (!last || !last.dataset || last.dataset.sender === undefined) return false;
  if (last.dataset.sender !== String(senderId)) return false;
  const lastTime = parseInt(last.dataset.time || '0', 10);
  if (!lastTime) return false;
  return Math.abs(timeMs - lastTime) < MSG_GROUP_WINDOW_MS;
}

/**
 * Универсальный рендер сообщения.
 * ctx: { senderNick, senderAvatar, isOwner }
 */
function appendChatMsg(msg, containerId, ctx, doScroll = true) {
  if (!state.me || !msg) return;
  const container = $(containerId);
  if (!container) return;

  const msgId = msg._id || msg.id || '';
  // Дедупликация (история + realtime могут пересечься)
  if (msgId && container.querySelector(`[data-msgid="${CSS.escape(msgId)}"]`)) return;

  const stick = doScroll ? isNearBottom(container) : false;
  clearMsgsPlaceholder(container);

  const senderId = msg.from;
  const isMine = senderId === state.me.id;
  const isDeleted = !!msg.deleted;
  const timeMs = getMsgTimeMs(msg);
  const timeStr = fmtTime(timeMs);

  ensureDateDivider(container, timeMs);
  const grouped = shouldGroupMsg(container, senderId, timeMs);

  const wrap = document.createElement('div');
  wrap.className = 'g-msg' + (isMine ? ' mine' : '') + (isDeleted ? ' deleted' : '') + (grouped ? ' grouped' : '');
  if (msgId) wrap.dataset.msgid = msgId;
  wrap.dataset.sender = senderId;
  wrap.dataset.time = String(timeMs);

  if (grouped) {
    const slot = document.createElement('div');
    slot.className = 'g-msg-av-slot';
    slot.innerHTML = `<span class="g-msg-hover-time">${esc(timeStr)}</span>`;
    wrap.appendChild(slot);
  } else {
    const avEl = document.createElement('div');
    avEl.className = 'g-msg-av';
    renderAv(avEl, ctx.senderNick, ctx.senderAvatar);
    if (!isMine) {
      avEl.classList.add('clickable');
      avEl.setAttribute('role', 'button');
      avEl.addEventListener('click', () => showUserProfile(senderId));
    }
    wrap.appendChild(avEl);
  }

  const body = document.createElement('div');
  body.className = 'g-msg-body';

  if (!grouped) {
    const head = document.createElement('div');
    head.className = 'g-msg-head';
    head.innerHTML = `
      <span class="g-msg-nick">${esc(ctx.senderNick)}</span>
      ${ctx.isOwner ? CROWN_SVG : ''}
      <span class="g-msg-time" title="${esc(new Date(timeMs).toLocaleString('ru'))}">${esc(fmtMsgTime(timeMs))}</span>`;
    const nickEl = head.querySelector('.g-msg-nick');
    if (!isMine) nickEl.addEventListener('click', () => showUserProfile(senderId));
    else nickEl.addEventListener('click', () => openEditProfileModal());
    body.appendChild(head);
  }

  const text = document.createElement('div');
  text.className = 'g-msg-text';
  if (isDeleted) {
    text.textContent = 'Сообщение удалено';
  } else {
    const raw = msg.text || '';
    text.innerHTML = formatMsgText(raw);
    if (isJumboEmoji(raw)) text.classList.add('jumbo');
  }
  body.appendChild(text);
  wrap.appendChild(body);

  if (isMine && !isDeleted && msgId) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'msg-del-btn';
    delBtn.title = 'Удалить';
    delBtn.setAttribute('aria-label', 'Удалить сообщение');
    delBtn.innerHTML = TRASH_SVG;
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Shift+клик — мгновенное удаление без подтверждения (как в Discord)
      if (e.shiftKey) deleteMessage(msgId);
      else openDeleteConfirm(msgId);
    });
    wrap.appendChild(delBtn);
  }

  container.appendChild(wrap);
  if (doScroll && (stick || isMine)) scrollMsgs(containerId);
}

function appendMsg(msg, containerId, doScroll = true) {
  if (!state.me || !msg) return;
  const isMine = msg.from === state.me.id;
  const friend = state.friends[msg.from];
  appendChatMsg(msg, containerId, {
    senderNick: isMine ? state.me.nickname : (friend?.nickname || msg.from),
    senderAvatar: isMine ? state.me.avatar : (friend?.avatar || null),
    isOwner: false,
  }, doScroll);
}

function appendGroupMsg(msg, doScroll = true) {
  if (!state.me || !msg) return;
  const g = state.groups[state.activeGroup];
  const isMine = msg.from === state.me.id;
  const sender = g?.members?.find(m => m.id === msg.from);
  appendChatMsg(msg, 'group-messages', {
    senderNick: sender?.nickname || (isMine ? state.me.nickname : msg.from),
    senderAvatar: sender?.avatar || (isMine ? state.me.avatar : null),
    isOwner: isGroupOwner(g, msg.from),
  }, doScroll);
}

/* ============================================================================
 * GROUP CHAT
 * ==========================================================================*/
async function openGroupChat(groupId) {
  if (!state.me || !groupId || !state.groups[groupId]) return;
  const prevFriend = state.activeFriend;
  const unreadBefore = state.groupUnread[groupId] || 0;
  state.activeGroup = groupId;
  state.activeFriend = null;
  state.groupUnread[groupId] = 0;
  updateTitleBadge();

  document.querySelectorAll('.friend-item').forEach(el =>
    el.classList.toggle('active', el.dataset.gid === groupId)
  );
  refreshGroupItem(groupId);
  if (prevFriend) refreshFriendItem(prevFriend);

  const g = state.groups[groupId];
  updateGroupChatHeader(g);
  renderGroupMembersPanel(g);
  const input = $('group-msg-input');
  if (input) input.placeholder = 'Написать в ' + g.name;

  setDisplay('chat-placeholder', 'none');
  setDisplay('chat-window', 'none');
  setDisplay('group-chat-window', 'flex');
  socket.emit('watchGroupVoice', { groupId });
  updateGroupVoiceBar(groupId);

  enterMobileChatView('btn-back-group');
  syncVoiceOverlayPosition();

  const box = $('group-messages');
  if (!box) return;
  resetMsgContainer(box);
  box.innerHTML = placeholderHTML('Загрузка…');

  const requestSeq = ++state.seq.groupChat;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/groups/${encodeURIComponent(groupId)}/messages`);
    if (requestSeq !== state.seq.groupChat) return;
    if (!res.ok) throw new Error('history failed');
    const history = await res.json();
    if (requestSeq !== state.seq.groupChat) return;
    resetMsgContainer(box);
    renderChatWelcome(box, {
      nick: g.name, group: g,
      sub: `Добро пожаловать в начало группы <b>${esc(g.name)}</b>.`,
    });
    if (Array.isArray(history) && history.length) {
      const firstNewIdx = unreadBefore > 0 ? Math.max(0, history.length - unreadBefore) : -1;
      history.forEach((m, i) => {
        if (i === firstNewIdx && m.from !== state.me.id) appendNewMessagesDivider(box);
        appendGroupMsg(m, false);
      });
      const last = history[history.length - 1];
      if (last) state.groupLastActivity[groupId] = Math.max(state.groupLastActivity[groupId] || 0, getMsgTimeMs(last));
    }
    scrollMsgs('group-messages');
  } catch (e) {
    if (requestSeq !== state.seq.groupChat) return;
    if (e instanceof AuthError) return;
    box.innerHTML = placeholderHTML('Ошибка загрузки', true);
  }
  socket.emit('markGroupRead', groupId);
  if (window.innerWidth > 640) input?.focus();
}

function updateGroupVoiceBar(groupId) {
  const bar = $('group-voice-bar');
  if (!bar) return;
  const isCurrent = !!groupId && state.activeGroup === groupId;
  bar.style.display = isCurrent ? 'flex' : 'none';
  if (!isCurrent) return;

  const call = state.groupVoiceCalls[groupId];
  const g = state.groups[groupId];
  setText('group-voice-count', call
    ? `${plural(call.participants.length, 'участник', 'участника', 'участников')} в голосовом канале`
    : 'Никто не подключён');

  const members = $('group-voice-members');
  if (members) {
    members.innerHTML = '';
    (call?.participants || []).forEach(peerId => {
      const member = g?.members?.find(item => item.id === peerId) || (peerId === state.me?.id ? state.me : null);
      const nick = member?.nickname || peerId;
      const avatar = document.createElement('div');
      avatar.className = 'group-voice-member-avatar';
      avatar.title = nick;
      if (member?.avatar) {
        avatar.style.backgroundImage = `url("${String(member.avatar).replace(/["\\]/g, '\\$&')}")`;
      } else {
        avatar.textContent = av(nick);
      }
      members.appendChild(avatar);
    });
  }

  const join = $('btn-join-group-voice');
  if (join) {
    const inThis = !!(callState.active && call && callState.callId === call.callId);
    join.textContent = inThis ? 'Вы в канале' : call ? 'Присоединиться' : 'Подключиться';
    join.disabled = inThis || callState.active;
  }
}

function updateGroupChatHeader(g) {
  if (!g) return;
  renderGroupAv($('group-chat-avatar'), g);
  setText('group-chat-name', g.name);
  const members = g.members || [];
  const onlineCount = members.filter(m => m.online).length;
  setText('group-chat-members-count', `${plural(members.length, 'участник', 'участника', 'участников')} · ${onlineCount} в сети`);
}

on('group-chat-head-click', 'click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});
on('btn-group-info', 'click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});

/* ============================================================================
 * SEND MESSAGES
 * ==========================================================================*/
on('btn-send', 'click', sendMsg);
on('msg-input', 'keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

function sendMsg() {
  const input = $('msg-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !state.activeFriend) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    return;
  }
  socket.emit('sendMessage', { toId: state.activeFriend, text });
  state.lastActivity[state.activeFriend] = Date.now();
  input.value = '';
  input.focus();
}

on('btn-group-send', 'click', sendGroupMsg);
on('group-msg-input', 'keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGroupMsg(); }
});

function sendGroupMsg() {
  const input = $('group-msg-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !state.activeGroup) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
    return;
  }
  socket.emit('groupMessage', { groupId: state.activeGroup, text });
  state.groupLastActivity[state.activeGroup] = Date.now();
  input.value = '';
  input.focus();
}

// Как в Discord: начал печатать где угодно — фокус уходит в поле ввода
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (isAnyModalOpen()) return;
  const inputId = state.activeFriend ? 'msg-input' : state.activeGroup ? 'group-msg-input' : null;
  if (inputId) $(inputId)?.focus();
});

