/* ============================================================================
 * DELETE MESSAGE
 * ==========================================================================*/
function openDeleteConfirm(msgId) {
  state.pendingDeleteId = msgId;
  setDisplay('delete-confirm', 'flex');
}
function closeDeleteConfirm() {
  state.pendingDeleteId = null;
  setDisplay('delete-confirm', 'none');
}
window.closeDeleteConfirm = closeDeleteConfirm;

on('delete-confirm', 'click', e => {
  if (e.target === $('delete-confirm')) closeDeleteConfirm();
});

async function deleteMessage(idToDelete) {
  if (!idToDelete || !state.me) return;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/messages/${encodeURIComponent(idToDelete)}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await safeJson(res);
      showTransientNotice(d.error || 'Ошибка удаления');
    }
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
}

on('btn-confirm-delete', 'click', () => {
  if (!state.pendingDeleteId) return;
  const id = state.pendingDeleteId;
  closeDeleteConfirm();
  deleteMessage(id);
});

/* ============================================================================
 * PROFILE: view other user
 * ==========================================================================*/
on('chat-head-click', 'click', () => {
  if (state.activeFriend) showUserProfile(state.activeFriend);
});

async function showUserProfile(userId) {
  if (!userId) return;
  const requestSeq = ++state.seq.profile;
  try {
    const res = await authFetch(BACKEND_URL + '/api/profile/' + encodeURIComponent(userId));
    if (requestSeq !== state.seq.profile) return;
    if (!res.ok) {
      showTransientNotice(res.status === 404 ? 'Пользователь не найден' : 'Не удалось загрузить профиль');
      return;
    }
    const u = await res.json();
    if (requestSeq !== state.seq.profile) return;

    renderAvWithDot($('profile-modal-avatar'), u.nickname, u.avatar, !!u.online);
    setText('profile-modal-nick', u.nickname);
    setText('profile-modal-id', '@' + u.id);

    const onlineBadge = $('profile-modal-online');
    if (onlineBadge) {
      onlineBadge.textContent = u.online ? 'В сети' : 'Не в сети';
      onlineBadge.className = 'modal-online-badge ' + (u.online ? 'online' : 'offline');
    }

    if (u.status) {
      setText('profile-modal-status', u.status);
      setDisplay('profile-modal-status-row', '');
    } else {
      setDisplay('profile-modal-status-row', 'none');
    }
    if (u.bio) {
      setText('profile-modal-bio', u.bio);
      setDisplay('profile-modal-bio-row', '');
    } else {
      setDisplay('profile-modal-bio-row', 'none');
    }
    setDisplay('profile-modal-body', (u.status || u.bio) ? '' : 'none');

    const isFriend = !!state.me?.friends?.includes(userId);
    const isMe = userId === state.me?.id;

    const addBtn = $('btn-add-friend');
    if (addBtn) {
      addBtn.textContent = isFriend ? 'Написать' : 'Добавить в друзья';
      addBtn.disabled = false;
      addBtn.style.display = isMe ? 'none' : '';
      addBtn.onclick = isFriend
        ? () => { closeProfileModal(); openChat(userId); }
        : () => {
            socket.emit('sendFriendRequest', userId);
            addBtn.textContent = 'Запрос отправлен';
            addBtn.disabled = true;
          };
    }

    const blockBtn = $('btn-block-user');
    if (blockBtn) {
      const isBlocked = !!state.me?.blockedUsers?.includes(userId);
      blockBtn.style.display = isMe ? 'none' : '';
      blockBtn.disabled = false;
      blockBtn.className = 'btn-secondary btn-block' + (isBlocked ? '' : ' btn-danger-outline');
      blockBtn.textContent = isBlocked ? 'Разблокировать' : 'Заблокировать';
      blockBtn.onclick = () => (isBlocked ? performUnblock(userId) : performBlock(userId));
    }

    setDisplay('profile-modal', 'flex');
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Не удалось загрузить профиль');
  }
}

async function performUnblock(userId) {
  if (!state.me) return;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/unblock`, { method: 'POST' });
    if (!res.ok) return showTransientNotice('Ошибка разблокировки');
    state.me.blockedUsers = (state.me.blockedUsers || []).filter(id => id !== userId);
    showUserProfile(userId);
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
}

async function performBlock(userId) {
  if (!state.me) return;
  if (!confirm(`Заблокировать @${userId}?`)) return;
  try {
    const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/block`, { method: 'POST' });
    if (!res.ok) {
      const d = await safeJson(res);
      return showTransientNotice(d.error || 'Ошибка блокировки');
    }
    if (!state.me.blockedUsers) state.me.blockedUsers = [];
    if (!state.me.blockedUsers.includes(userId)) state.me.blockedUsers = [...state.me.blockedUsers, userId];
    if (state.me.friends) state.me.friends = state.me.friends.filter(id => id !== userId);
    delete state.friends[userId];
    delete state.unread[userId];
    renderFriendsList();
    if (state.activeFriend === userId) closeActiveChat();
    showUserProfile(userId);
  } catch (e) {
    if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
  }
}

function closeProfileModal() { setDisplay('profile-modal', 'none'); }
window.closeProfileModal = closeProfileModal;

on('profile-modal', 'click', e => {
  if (e.target === $('profile-modal')) closeProfileModal();
});

/* ============================================================================
 * PROFILE: edit own
 * ==========================================================================*/
function openEditProfileModal() {
  if (!state.me) return;
  renderAv($('edit-avatar'), state.me.nickname, state.me.avatar);
  const nick = $('edit-nick'); if (nick) nick.value = state.me.nickname || '';
  const st = $('edit-status'); if (st) st.value = state.me.status || '';
  const bio = $('edit-bio'); if (bio) bio.value = state.me.bio || '';
  setDisplay('edit-profile-modal', 'flex');
}
function closeEditProfileModal() { setDisplay('edit-profile-modal', 'none'); }
window.closeEditProfileModal = closeEditProfileModal;

on('edit-profile-modal', 'click', e => {
  if (e.target === $('edit-profile-modal')) closeEditProfileModal();
});

on('avatar-input', 'change', async e => {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file || !state.me) return;
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
    showTransientNotice('Разрешены только изображения (jpeg, png, webp, gif)');
    input.value = '';
    return;
  }
  if (file.size > MAX_AVATAR_SIZE) {
    showTransientNotice('Файл слишком большой (максимум 5MB)');
    input.value = '';
    return;
  }
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const res = await authFetch(BACKEND_URL + '/api/upload/avatar', { method: 'POST', body: formData });
    if (!res.ok) {
      const d = await safeJson(res);
      showTransientNotice(d.error || 'Ошибка загрузки аватара');
      return;
    }
    const data = await res.json();
    state.me.avatar = data.avatar;
    localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
    renderAv($('edit-avatar'), state.me.nickname, state.me.avatar);
    renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
    showTransientNotice('Аватар обновлён');
  } catch (err) {
    if (!(err instanceof AuthError)) showTransientNotice('Ошибка сети');
  } finally {
    input.value = '';
  }
});

on('btn-save-profile', 'click', async () => {
  if (!state.me) return;
  const nickname = ($('edit-nick')?.value || '').trim();
  const status = ($('edit-status')?.value || '').trim();
  const bio = ($('edit-bio')?.value || '').trim();
  if (!nickname) return showTransientNotice('Никнейм не может быть пустым');

  await withButtonBusy($('btn-save-profile'), 'Сохранение…', async () => {
    try {
      const res = await authFetch(BACKEND_URL + '/api/profile/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, status, bio }),
      });
      const data = await safeJson(res);
      if (!res.ok) return showTransientNotice(data.error || 'Ошибка сохранения');
      const u = data.user || {};
      state.me.nickname = u.nickname ?? nickname;
      state.me.status = u.status ?? status;
      state.me.bio = u.bio ?? bio;
      localStorage.setItem('chatapp_profile', JSON.stringify(state.me));
      setText('my-nick', state.me.nickname);
      renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
      closeEditProfileModal();
      showTransientNotice('Профиль сохранён');
    } catch (e) {
      if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
    }
  });
});

/* ============================================================================
 * BLOCKED USERS
 * ==========================================================================*/
on('btn-open-blocked', 'click', () => {
  closeEditProfileModal();
  openBlockedUsersModal();
});

async function openBlockedUsersModal() {
  if (!state.me) return;
  setDisplay('blocked-users-modal', 'flex');
  const list = $('blocked-users-list');
  if (!list) return;
  list.innerHTML = '<div class="blocked-users-empty">Загрузка…</div>';
  try {
    const res = await authFetch(BACKEND_URL + '/api/users/blocked');
    if (!res.ok) throw new Error('failed');
    const users = await res.json();
    state.me.blockedUsers = (Array.isArray(users) ? users : []).map(u => u.id);
    renderBlockedUsersList(users);
  } catch (e) {
    if (e instanceof AuthError) return;
    list.innerHTML = '<div class="blocked-users-empty" style="color:var(--red)">Ошибка загрузки</div>';
  }
}
function closeBlockedUsersModal() { setDisplay('blocked-users-modal', 'none'); }
window.closeBlockedUsersModal = closeBlockedUsersModal;

on('blocked-users-modal', 'click', e => {
  if (e.target === $('blocked-users-modal')) closeBlockedUsersModal();
});

function renderBlockedUsersList(users) {
  const list = $('blocked-users-list');
  if (!list) return;
  list.innerHTML = '';
  if (!Array.isArray(users) || !users.length) {
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
      <button class="btn-unblock" type="button">Разблокировать</button>`;
    renderAv(el.querySelector('.f-av'), u.nickname, u.avatar);
    const btn = el.querySelector('.btn-unblock');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await authFetch(`${BACKEND_URL}/api/users/${encodeURIComponent(u.id)}/unblock`, { method: 'POST' });
        if (!res.ok) { btn.disabled = false; return showTransientNotice('Ошибка разблокировки'); }
        if (state.me?.blockedUsers) state.me.blockedUsers = state.me.blockedUsers.filter(id => id !== u.id);
        el.remove();
        if (!list.children.length) {
          list.innerHTML = '<div class="blocked-users-empty">Нет заблокированных пользователей</div>';
        }
      } catch (e) {
        btn.disabled = false;
        if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
      }
    });
    list.appendChild(el);
  });
}

/* ============================================================================
 * SHARED PICKER (создание группы / добавление участников)
 * ==========================================================================*/
function renderPicker({ pickerId, countId, ids, selected, emptyText, onChange }) {
  const picker = $(pickerId);
  if (!picker) return;
  if (!ids.length) {
    picker.innerHTML = `<div class="empty-state" style="padding:16px"><div class="empty-sub">${esc(emptyText)}</div></div>`;
    return;
  }
  picker.innerHTML = '';
  // Онлайн сверху
  const sortedIds = [...ids].sort((a, b) => {
    const oa = !!state.friends[a]?.online, ob = !!state.friends[b]?.online;
    if (oa !== ob) return oa ? -1 : 1;
    return (state.friends[a]?.nickname || a).localeCompare(state.friends[b]?.nickname || b, 'ru');
  });
  sortedIds.forEach(id => {
    const f = state.friends[id];
    if (!f) return;
    const isSel = selected.has(id);
    const el = document.createElement('div');
    el.className = 'picker-item' + (isSel ? ' selected' : '');
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(isSel));
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="f-av"></div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:14px;color:var(--text)">${esc(f.nickname)}</div>
        <div class="f-stat" style="font-size:12px">@${esc(id)}</div>
      </div>
      <div class="picker-check">${isSel ? '✓' : ''}</div>`;
    renderAvWithDot(el.querySelector('.f-av'), f.nickname, f.avatar, f.online);
    const toggle = () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      setText(countId, 'выбрано: ' + selected.size);
      el.classList.toggle('selected', selected.has(id));
      el.setAttribute('aria-checked', String(selected.has(id)));
      el.querySelector('.picker-check').textContent = selected.has(id) ? '✓' : '';
      if (onChange) onChange();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    picker.appendChild(el);
  });
}

/* ============================================================================
 * CREATE GROUP MODAL
 * ==========================================================================*/
on('btn-create-group', 'click', () => {
  if (!state.me) return;
  selectedGroupMembers = new Set();
  const nameInput = $('group-name-input');
  if (nameInput) nameInput.value = '';
  setText('group-selected-count', 'выбрано: 0');
  renderGroupFriendsPicker();
  setDisplay('create-group-modal', 'flex');
  nameInput?.focus();
});

function closeCreateGroupModal() { setDisplay('create-group-modal', 'none'); }
window.closeCreateGroupModal = closeCreateGroupModal;

on('create-group-modal', 'click', e => {
  if (e.target === $('create-group-modal')) closeCreateGroupModal();
});

function renderGroupFriendsPicker() {
  renderPicker({
    pickerId: 'group-friends-picker',
    countId: 'group-selected-count',
    ids: Object.keys(state.friends),
    selected: selectedGroupMembers,
    emptyText: 'Сначала добавь друзей',
  });
}

on('group-name-input', 'keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('btn-confirm-create-group')?.click(); }
});

on('btn-confirm-create-group', 'click', async () => {
  const name = ($('group-name-input')?.value || '').trim();
  if (!name || name.length < 2) return showTransientNotice('Название минимум 2 символа');
  if (selectedGroupMembers.size < 1) return showTransientNotice('Выберите хотя бы одного друга');

  await withButtonBusy($('btn-confirm-create-group'), 'Создание…', async () => {
    try {
      const res = await authFetch(BACKEND_URL + '/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, memberIds: [...selectedGroupMembers] }),
      });
      const data = await safeJson(res);
      if (!res.ok) return showTransientNotice(data.error || 'Ошибка создания группы');
      closeCreateGroupModal();
      if (data.group?.id) {
        state.groups[data.group.id] = data.group;
        state.groupLastActivity[data.group.id] = Date.now();
      }
      await loadGroups();
      switchSidebarTab('groups');
      if (data.group?.id && state.groups[data.group.id]) openGroupChat(data.group.id);
    } catch (e) {
      if (!(e instanceof AuthError)) showTransientNotice('Ошибка сети');
    }
  });
});

/* ============================================================================
 * GROUP INFO MODAL
 * ==========================================================================*/
function openGroupInfoModal(groupId) {
  const g = state.groups[groupId];
  if (!g) return;
  state.infoGroupId = groupId;

  renderGroupAv($('group-info-avatar'), g);
  setText('group-info-name', g.name);
  setText('group-info-created', 'Создана ' + fmtDate(g.createdAt || Date.now()));
  setText('group-info-count', String((g.members || []).length));

  const isOwner = isGroupOwner(g, state.me?.id);
  setDisplay('group-info-owner-actions', isOwner ? '' : 'none');
  const leaveBtn = $('btn-leave-group');
  if (leaveBtn) leaveBtn.textContent = isOwner ? 'Удалить группу' : 'Покинуть группу';

  renderGroupInfoMembers(g);
  setDisplay('group-info-modal', 'flex');
}

function renderGroupInfoMembers(g) {
  const list = $('group-info-members');
  if (!list) return;
  list.innerHTML = '';
  const myId = state.me?.id;
  const iAmOwner = isGroupOwner(g, myId);
  setText('group-info-count', String((g.members || []).length));

  const sorted = [...(g.members || [])].sort((a, b) => {
    const ao = isGroupOwner(g, a.id), bo = isGroupOwner(g, b.id);
    if (ao !== bo) return ao ? -1 : 1;
    if (!!a.online !== !!b.online) return a.online ? -1 : 1;
    return (a.nickname || '').localeCompare(b.nickname || '', 'ru');
  });

  sorted.forEach(m => {
    const memberIsOwner = isGroupOwner(g, m.id);
    const el = document.createElement('div');
    el.className = 'group-member-item';
    el.innerHTML = `
      <div class="f-av"></div>
      <div style="flex:1;min-width:0">
        <div class="f-nick" style="font-size:14px;color:var(--text)">${esc(m.nickname)}${m.id === myId ? ' <span class="f-stat" style="display:inline">(вы)</span>' : ''} ${memberIsOwner ? '<span class="owner-badge" title="Владелец">👑</span>' : ''}</div>
        <div class="f-stat" style="font-size:12px">@${esc(m.id)} · ${m.online ? 'В сети' : 'Не в сети'}</div>
      </div>
      ${m.id !== myId && iAmOwner ? '<button class="btn-kick" type="button" title="Удалить из группы">✕</button>' : ''}`;

    renderAvWithDot(el.querySelector('.f-av'), m.nickname, m.avatar, m.online);

    const kickBtn = el.querySelector('.btn-kick');
    if (kickBtn) {
      kickBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`Удалить ${m.nickname} из группы?`)) {
          socket.emit('kickGroupMember', { groupId: g.id, userId: m.id });
        }
      });
    }
    if (m.id !== myId) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        closeGroupInfoModal();
        showUserProfile(m.id);
      });
    }
    list.appendChild(el);
  });
}

function closeGroupInfoModal() {
  state.infoGroupId = null;
  setDisplay('group-info-modal', 'none');
}
window.closeGroupInfoModal = closeGroupInfoModal;

on('group-info-modal', 'click', e => {
  if (e.target === $('group-info-modal')) closeGroupInfoModal();
});

on('btn-leave-group', 'click', () => {
  const groupId = state.infoGroupId || state.activeGroup;
  const g = groupId && state.groups[groupId];
  if (!g) return;
  const isOwner = isGroupOwner(g, state.me?.id);
  const msg = isOwner
    ? 'Вы владелец группы. Группа будет УДАЛЕНА для всех. Продолжить?'
    : 'Покинуть группу?';
  if (!confirm(msg)) return;
  socket.emit('leaveGroup', groupId);
  closeGroupInfoModal();
});

/* ============================================================================
 * ADD MEMBERS MODAL
 * ==========================================================================*/
function openAddMembersModal() {
  const groupId = state.infoGroupId || state.activeGroup;
  if (!groupId || !state.groups[groupId]) return;
  selectedAddMembers = new Set();
  setText('add-members-count', 'выбрано: 0');
  renderAddMembersPicker(groupId);
  $('add-members-modal').dataset.gid = groupId;
  setDisplay('add-members-modal', 'flex');
}

on('btn-add-members', 'click', () => {
  const gid = state.infoGroupId;
  closeGroupInfoModal();
  state.infoGroupId = gid; // сохраняем контекст для picker
  openAddMembersModal();
  state.infoGroupId = null;
});

on('btn-invite-group', 'click', openAddMembersModal);

function closeAddMembersModal() { setDisplay('add-members-modal', 'none'); }
window.closeAddMembersModal = closeAddMembersModal;

on('add-members-modal', 'click', e => {
  if (e.target === $('add-members-modal')) closeAddMembersModal();
});

function renderAddMembersPicker(groupId) {
  const g = state.groups[groupId];
  if (!g) return;
  const memberIds = new Set((g.members || []).map(m => m.id));
  renderPicker({
    pickerId: 'add-members-picker',
    countId: 'add-members-count',
    ids: Object.keys(state.friends).filter(id => !memberIds.has(id)),
    selected: selectedAddMembers,
    emptyText: 'Все друзья уже в группе',
  });
}

on('btn-confirm-add-members', 'click', () => {
  const groupId = $('add-members-modal')?.dataset.gid || state.activeGroup;
  if (!groupId || !selectedAddMembers.size) return;
  selectedAddMembers.forEach(userId => {
    socket.emit('addGroupMember', { groupId, userId });
  });
  closeAddMembersModal();
  showTransientNotice('Приглашения отправлены');
});

/* ============================================================================
 * MEMBERS PANEL (правая колонка) — секции «В СЕТИ» / «НЕ В СЕТИ» как в Discord
 * ==========================================================================*/
function renderGroupMembersPanel(g) {
  if (!g) return;
  const countEl = $('gm-count');
  const list = $('group-members-list');
  if (!countEl || !list) return;

  countEl.textContent = (g.members || []).length;
  list.innerHTML = '';

  // Владелец сверху, потом по алфавиту
  const byName = (a, b) => {
    const aOwner = isGroupOwner(g, a.id);
    const bOwner = isGroupOwner(g, b.id);
    if (aOwner !== bOwner) return aOwner ? -1 : 1;
    return (a.nickname || '').localeCompare(b.nickname || '', 'ru');
  };
  const online = (g.members || []).filter(m => m.online).sort(byName);
  const offline = (g.members || []).filter(m => !m.online).sort(byName);

  const addSection = (label, arr) => {
    if (!arr.length) return;
    const h = document.createElement('div');
    h.className = 'gm-section';
    h.textContent = `${label} — ${arr.length}`;
    list.appendChild(h);
    arr.forEach(m => {
      const isOwner = isGroupOwner(g, m.id);
      const el = document.createElement('div');
      el.className = 'gm-item' + (m.online ? '' : ' offline');
      el.title = `@${m.id}`;
      el.innerHTML = `
        <div class="gm-av"></div>
        <div class="gm-name">${esc(m.nickname)}</div>
        ${isOwner ? CROWN_SVG : ''}`;
      renderAvWithDot(el.querySelector('.gm-av'), m.nickname, m.avatar, m.online);
      if (m.id !== state.me?.id) el.addEventListener('click', () => showUserProfile(m.id));
      else el.addEventListener('click', () => openEditProfileModal());
      list.appendChild(el);
    });
  };
  addSection('В сети', online);
  addSection('Не в сети', offline);

  setDisplay('btn-invite-group', isGroupOwner(g, state.me?.id) ? '' : 'none');
}

on('btn-toggle-members', 'click', () => {
  $('group-members-panel')?.classList.toggle('hidden');
  syncVoiceOverlayPosition();
});

/* ============================================================================
 * MOBILE BACK BUTTONS / RESIZE / KEYBOARD
 * ==========================================================================*/
on('btn-back', 'click', goBackMobile);
on('btn-back-group', 'click', goBackMobile);

function goBackMobile() {
  const prevFriend = state.activeFriend;
  const prevGroup = state.activeGroup;
  closeActiveChat();
  document.querySelector('.sidebar')?.classList.remove('hidden');
  document.querySelector('.chat-main')?.classList.add('hidden');
  if (prevFriend) refreshFriendItem(prevFriend);
  if (prevGroup) refreshGroupItem(prevGroup);
}

window.addEventListener('resize', () => {
  syncVoiceOverlayPosition();
  if (window.innerWidth > 640) {
    document.querySelector('.sidebar')?.classList.remove('hidden');
    document.querySelector('.chat-main')?.classList.remove('hidden');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (isAnyModalOpen() || $('delete-confirm')?.style.display === 'flex') {
      closeAllModals();
      return;
    }
    closeDrop(false);
    // Escape в открытом чате — прокрутка в самый низ (как в Discord)
    if (state.activeFriend) scrollMsgs('messages');
    if (state.activeGroup) scrollMsgs('group-messages');
  }
  // Ctrl/Cmd+K — фокус на поиск
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('search-input')?.focus();
  }
});

// При возврате на вкладку помечаем открытый чат прочитанным
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me) return;
  if (state.activeFriend) socket.emit('markRead', state.activeFriend);
  if (state.activeGroup) socket.emit('markGroupRead', state.activeGroup);
});

/* ============================================================================
 * AUTO-LOGIN
 * ==========================================================================*/
(() => {
  const token = localStorage.getItem('chatapp_token');
  const cached = localStorage.getItem('chatapp_profile');
  if (token && cached) {
    try {
      const me = JSON.parse(cached);
      if (!me || !me.id) throw new Error('bad cache');
      state.me = me;
      enterApp(me);
      return;
    } catch (e) {
      localStorage.removeItem('chatapp_profile');
    }
  }
  document.documentElement.classList.remove('has-session');
  $('login-id')?.focus();
})();

/* ============================================================================
 * SOCKET CONNECTION ERROR HANDLING
 * ==========================================================================*/
let lastConnNoticeAt = 0;
socket.on('connect_error', err => {
  console.error('Socket error:', err);
  if (err?.message === 'Unauthorized') {
    forceLogoutToLogin('Сессия истекла, войдите снова');
    return;
  }
  setConnBanner(true, 'Нет соединения с сервером — повторная попытка…');
  const now = Date.now();
  if (now - lastConnNoticeAt > 15000) {
    lastConnNoticeAt = now;
  }
});

socket.on('connect', () => {
  lastConnNoticeAt = 0;
  setConnBanner(false);
});

socket.on('disconnect', reason => {
  console.warn('Socket disconnected:', reason);
  if (reason === 'io client disconnect') return;
  setConnBanner(true, 'Соединение потеряно — переподключение…');
  // Сигнальный канал потерян — сервер удалит нас из звонка; завершаем локально.
  if (callState.active || callState.pendingIncoming) closeCallOverlay();
});

window.addEventListener('beforeunload', () => {
  if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
});

/* ============================================================================
 * CALLS (WebRTC: DM 1:1 + Group mesh)
 * ==========================================================================*/
function callPeerName(peerId) {
  if (callState.isGroup) return memberName(state.groups[callState.groupId], peerId);
  const f = state.friends[peerId];
  return f?.nickname || (peerId === callState.peerFriendId ? callState.peerFriendName : null) || peerId;
}

function callPeerAvatar(peerId) {
  if (callState.isGroup) {
    const g = state.groups[callState.groupId];
    return g?.members?.find(m => m.id === peerId)?.avatar || state.friends[peerId]?.avatar || null;
  }
  return state.friends[peerId]?.avatar || null;
}

/** Захват локального потока. При недоступной камере — fallback на аудио. */
async function acquireLocalStream(video) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS, video: !!video });
  } catch (e) {
    if (!video) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO_CONSTRAINTS, video: false });
    showTransientNotice('Камера недоступна — звонок без видео');
  }
  stream.getAudioTracks().forEach(track => {
    const s = typeof track.getSettings === 'function' ? track.getSettings() : {};
    if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) {
      console.warn('Browser did not apply raw microphone constraints', s);
    }
  });
  return stream;
}

function beginCallSession({ stream, callId = null, chatKey = null, isGroup, groupId = null, peerFriendId = null, peerFriendName = null, video }) {
  callState.localStream = stream;
  callState.callId = callId;
  callState.chatKey = chatKey;
  callState.isGroup = !!isGroup;
  callState.groupId = groupId;
  callState.peerFriendId = peerFriendId;
  callState.peerFriendName = peerFriendName;
  callState.video = !!video;
  callState.micOn = true;
  callState.camOn = true;
  callState.peers = Object.create(null);
  callState.pendingIncoming = null;
  clearTimeout(callState.incomingTimer);
}

async function startCall({ toId, groupId, video }) {
  if (callState.active || callState.pendingIncoming) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  // Если в группе уже идёт канал — присоединяемся, а не создаём новый (иначе 'busy')
  if (groupId && state.groupVoiceCalls[groupId]) {
    joinExistingGroupVoice(groupId);
    return;
  }
  let stream;
  try {
    stream = await acquireLocalStream(video);
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    return;
  }
  beginCallSession({
    stream, isGroup: !!groupId, groupId: groupId || null,
    peerFriendId: toId || null,
    peerFriendName: toId ? (state.friends[toId]?.nickname || toId) : null,
    video,
  });
  socket.emit('callStart', { toId, groupId, video: !!video });
  openCallOverlay(groupId ? 'соединение…' : 'вызов…');

  if (!groupId) {
    sfx.startRing(true);
    clearTimeout(callState.ringTimer);
    callState.ringTimer = setTimeout(() => {
      if (callState.active && !Object.keys(callState.peers).length) {
        showTransientNotice('Нет ответа');
        hangupCall();
      }
    }, CALL_RING_TIMEOUT_MS);
  }
}

function joinExistingGroupVoice(groupId) {
  const call = state.groupVoiceCalls[groupId];
  if (!call) return;
  if (callState.active || callState.pendingIncoming) {
    showTransientNotice('Уже есть активный звонок');
    return;
  }
  startExistingCall(call, groupId);
}

async function startExistingCall(call, groupId) {
  let stream;
  try {
    stream = await acquireLocalStream(call.video);
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    return;
  }
  beginCallSession({ stream, callId: call.callId, isGroup: true, groupId, video: call.video });
  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: call.callId });
  sfx.join();
}

function hangupCall() {
  if (callState.callId) socket.emit('callLeave', { callId: callState.callId });
  sfx.leave();
  closeCallOverlay();
}

function resetCallControls() {
  const mic = $('btn-call-toggle-mic');
  if (mic) {
    mic.classList.remove('active-off');
    mic.title = 'Выключить микрофон';
    mic.setAttribute('aria-label', mic.title);
  }
  const cam = $('btn-call-toggle-cam');
  if (cam) {
    cam.classList.remove('active-off');
    cam.title = 'Выключить камеру';
    cam.setAttribute('aria-label', cam.title);
    cam.disabled = !callState.video;
  }
}

function openCallOverlay(statusText) {
  callState.active = true;
  const overlay = $('call-overlay');
  if (!overlay) return;
  overlay.classList.toggle('voice-mode', !callState.video);
  overlay.classList.toggle('video-mode', callState.video);
  setText('call-overlay-mode', callState.video ? 'ВИДЕОКАНАЛ' : 'ГОЛОСОВОЙ КАНАЛ');
  overlay.style.display = 'flex';
  syncVoiceOverlayPosition();
  setText('call-overlay-title', callState.isGroup
    ? (state.groups[callState.groupId]?.name || 'Групповой звонок')
    : callPeerName(callState.peerFriendId));
  setText('call-overlay-status', statusText || '');
  resetCallControls();
  renderCallGrid();
  if (callState.isGroup) {
    updateGroupVoiceBar(callState.groupId);
    renderGroupsList();
  }
}

function syncVoiceOverlayPosition() {
  const overlay = $('call-overlay');
  const sidebar = document.querySelector('.sidebar');
  if (!overlay || !sidebar || overlay.style.display === 'none') return;

  const chatWindow = [...document.querySelectorAll('.chat-window')]
    .find(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
  const chatHead = chatWindow?.querySelector('.chat-head');
  const top = chatHead ? chatHead.getBoundingClientRect().bottom : 0;
  overlay.style.setProperty('--call-top', `${Math.max(0, top)}px`);
  if (window.innerWidth <= 640) {
    overlay.style.setProperty('--call-left', '0px');
    return;
  }
  const rect = sidebar.getBoundingClientRect();
  const sidebarVisible = rect.width > 0 && !sidebar.classList.contains('hidden');
  overlay.style.setProperty('--call-left', sidebarVisible ? `${rect.right}px` : '0px');
}

function closeCallOverlay() {
  const overlay = $('call-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('voice-mode', 'video-mode');
    overlay.style.removeProperty('--call-left');
    overlay.style.removeProperty('--call-top');
  }
  setDisplay('incoming-call-modal', 'none');
  clearTimeout(callState.ringTimer);
  clearTimeout(callState.incomingTimer);
  sfx.stopRing();

  stopAllSpeakingMonitors();

  if (callState.localStream) {
    callState.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  }
  Object.values(callState.peers).forEach(p => {
    try { p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.close(); } catch (e) {}
  });

  const wasGroupId = callState.isGroup ? callState.groupId : null;

  callState.active = false;
  callState.callId = null;
  callState.chatKey = null;
  callState.isGroup = false;
  callState.groupId = null;
  callState.peerFriendId = null;
  callState.peerFriendName = null;
  callState.video = false;
  callState.localStream = null;
  callState.micOn = true;
  callState.camOn = true;
  callState.peers = Object.create(null);
  callState.pendingIncoming = null;

  const grid = $('call-video-grid');
  if (grid) grid.innerHTML = '';
  resetCallControls();

  if (wasGroupId) {
    updateGroupVoiceBar(wasGroupId);
    renderGroupsList();
  }
}

/* ── Сетка участников: инкрементальное обновление (без пересоздания <video>) ── */
function renderCallGrid() {
  const grid = $('call-video-grid');
  if (!grid || !callState.active) return;

  const entries = [{ id: 'local', nick: state.me?.nickname || 'Я', avatar: state.me?.avatar || null, stream: callState.localStream, isLocal: true }];
  for (const [peerId, p] of Object.entries(callState.peers)) {
    entries.push({ id: peerId, nick: callPeerName(peerId), avatar: callPeerAvatar(peerId), stream: p.stream, isLocal: false });
  }

  const seen = new Set();
  entries.forEach(({ id, nick, avatar, stream, isLocal }) => {
    seen.add(id);
    let tile = grid.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.dataset.peer = id;
      grid.appendChild(tile);
    }
    updateCallTile(tile, nick, avatar, stream, isLocal);
    ensureSpeakingMonitor(id, stream);
  });

  grid.querySelectorAll('.call-tile').forEach(t => { if (!seen.has(t.dataset.peer)) t.remove(); });
  Object.keys(speakingMonitors).forEach(id => { if (!seen.has(id)) stopSpeakingMonitor(id); });

  const cnt = Object.keys(callState.peers).length;
  grid.dataset.count = String(cnt + 1);
}

function updateCallTile(tile, nickname, avatarUrl, stream, isLocal) {
  const hasVideo = callState.video && !!stream &&
    stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live' && !(t.muted && !isLocal));
  const speaking = tile.classList.contains('speaking');
  tile.className = 'call-tile' + (isLocal ? ' local' : '') + (hasVideo ? '' : ' audio-only') + (speaking ? ' speaking' : '');

  let video = tile.querySelector('video');
  if (stream) {
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      tile.prepend(video);
    }
    video.muted = isLocal;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      video.play?.().catch(() => {});
    }
  } else if (video) {
    video.srcObject = null;
    video.remove();
  }

  let avWrap = tile.querySelector('.call-tile-avatar');
  if (!avWrap) {
    avWrap = document.createElement('div');
    avWrap.className = 'call-tile-avatar';
    tile.appendChild(avWrap);
  }
  const avKey = `${nickname}|${avatarUrl || ''}`;
  if (avWrap.dataset.key !== avKey) {
    renderAv(avWrap, nickname, avatarUrl);
    avWrap.dataset.key = avKey;
  }

  let label = tile.querySelector('.call-tile-nick');
  if (!label) {
    label = document.createElement('div');
    label.className = 'call-tile-nick';
    tile.appendChild(label);
  }
  label.textContent = isLocal ? `${nickname} (вы)` : nickname;

  // Бейдж выключенного микрофона — только у себя (чужой статус достоверно неизвестен)
  let badge = tile.querySelector('.call-tile-mic-off');
  if (isLocal && !callState.micOn) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'call-tile-mic-off';
      badge.title = 'Микрофон выключен';
      badge.innerHTML = MIC_OFF_SVG;
      tile.insertBefore(badge, label);
    }
  } else if (badge) {
    badge.remove();
  }
}

/* ── Индикатор «говорит сейчас» (Web Audio, один общий AudioContext) ────── */
const SPEAKING_THRESHOLD_ON = 0.06;
const SPEAKING_THRESHOLD_OFF = 0.035;
let audioCtx = null;

function getAudioCtx() {
  if (audioCtx && audioCtx.state !== 'closed') {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    audioCtx = null;
  }
  return audioCtx;
}

function setSpeakingUI(id, isSpeaking) {
  const tile = document.querySelector(`.call-tile[data-peer="${CSS.escape(id)}"]`);
  if (tile) tile.classList.toggle('speaking', isSpeaking);
}

function stopSpeakingMonitor(id) {
  const mon = speakingMonitors[id];
  if (!mon) return;
  cancelAnimationFrame(mon.raf);
  try { mon.source.disconnect(); } catch (e) {}
  try { mon.analyser.disconnect(); } catch (e) {}
  delete speakingMonitors[id];
  setSpeakingUI(id, false);
}

function stopAllSpeakingMonitors() {
  Object.keys(speakingMonitors).forEach(stopSpeakingMonitor);
  if (audioCtx) {
    try { audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }
}

function startSpeakingMonitor(id, stream) {
  if (!stream || !stream.getAudioTracks().length) return;
  const ctx = getAudioCtx();
  if (!ctx) return;

  let source;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch (e) {
    return;
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const mon = { analyser, data, source, stream, raf: null };
  speakingMonitors[id] = mon;

  let wasSpeaking = false;
  (function tick() {
    if (speakingMonitors[id] !== mon) return;
    // Свой выключенный микрофон не «говорит»
    if (id === 'local' && !callState.micOn) {
      if (wasSpeaking) { wasSpeaking = false; setSpeakingUI(id, false); }
      mon.raf = requestAnimationFrame(tick);
      return;
    }
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    // Гистерезис: включаем выше ON, выключаем ниже OFF
    const isSpeaking = wasSpeaking ? rms > SPEAKING_THRESHOLD_OFF : rms > SPEAKING_THRESHOLD_ON;
    if (isSpeaking !== wasSpeaking) {
      wasSpeaking = isSpeaking;
      setSpeakingUI(id, isSpeaking);
    }
    mon.raf = requestAnimationFrame(tick);
  })();
}

function ensureSpeakingMonitor(id, stream) {
  const existing = speakingMonitors[id];
  if (!stream || !stream.getAudioTracks().length) {
    if (existing) stopSpeakingMonitor(id);
    return;
  }
  if (existing && existing.stream === stream) return;
  if (existing) stopSpeakingMonitor(id);
  startSpeakingMonitor(id, stream);
}

/* ── Peer connections ──────────────────────────────────────────────────── */
function createPeerConnection(peerId) {
  const existingPeer = callState.peers[peerId];
  if (existingPeer?.pc) return existingPeer.pc;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  callState.peers[peerId] = { pc, stream: null, pendingCandidates: [] };

  if (callState.localStream) {
    callState.localStream.getTracks().forEach(track => pc.addTrack(track, callState.localStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate && callState.callId) {
      socket.emit('callSignal', { callId: callState.callId, to: peerId, data: { type: 'ice', candidate: e.candidate } });
    }
  };

  pc.ontrack = e => {
    const peer = callState.peers[peerId];
    if (!peer) return;
    if (e.streams && e.streams[0]) {
      peer.stream = e.streams[0];
    } else {
      if (!peer.stream) peer.stream = new MediaStream();
      peer.stream.addTrack(e.track);
    }
    // Перерисовка при (раз)мьюте удалённого трека — иначе плитка залипает в audio-only
    e.track.onmute = e.track.onunmute = () => renderCallGrid();
    renderCallGrid();
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (!callState.peers[peerId] || callState.peers[peerId].pc !== pc) return;
    if (st === 'connected') {
      sfx.stopRing();
      setText('call-overlay-status', 'в звонке');
    } else if (st === 'failed') {
      if (callState.isGroup) {
        teardownPeer(peerId);
      } else {
        showTransientNotice('Соединение с собеседником потеряно');
        hangupCall();
      }
    }
  };

  return pc;
}

async function connectToPeer(peerId, shouldOffer) {
  if (!peerId || peerId === state.me?.id || !callState.active) return null;
  const pc = createPeerConnection(peerId);
  if (shouldOffer && pc.signalingState === 'stable' && !pc.localDescription) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('callSignal', { callId: callState.callId, to: peerId, data: { type: 'offer', sdp: offer } });
  }
  return pc;
}

function teardownPeer(peerId) {
  const p = callState.peers[peerId];
  if (p?.pc) { try { p.pc.close(); } catch (e) {} }
  delete callState.peers[peerId];
  renderCallGrid();
}

/* ── Outgoing UI hooks ─────────────────────────────────────────────────── */
on('btn-call-audio', 'click', () => {
  if (state.activeFriend) startCall({ toId: state.activeFriend, video: false });
});
on('btn-call-video', 'click', () => {
  if (state.activeFriend) startCall({ toId: state.activeFriend, video: true });
});
on('btn-group-call-audio', 'click', () => {
  if (state.activeGroup) startCall({ groupId: state.activeGroup, video: false });
});
on('btn-group-call-video', 'click', () => {
  if (state.activeGroup) startCall({ groupId: state.activeGroup, video: true });
});
on('btn-join-group-voice', 'click', () => {
  if (callState.active || !state.activeGroup) return;
  if (state.groupVoiceCalls[state.activeGroup]) joinExistingGroupVoice(state.activeGroup);
  else startCall({ groupId: state.activeGroup, video: false });
});

on('btn-call-hangup', 'click', hangupCall);

function toggleMic() {
  if (!callState.localStream) return;
  callState.micOn = !callState.micOn;
  callState.localStream.getAudioTracks().forEach(t => { t.enabled = callState.micOn; });
  const micButton = $('btn-call-toggle-mic');
  if (micButton) {
    micButton.classList.toggle('active-off', !callState.micOn);
    micButton.title = callState.micOn ? 'Выключить микрофон' : 'Включить микрофон';
    micButton.setAttribute('aria-label', micButton.title);
  }
  showTransientNotice(callState.micOn ? 'Микрофон включён' : 'Микрофон выключен');
  renderCallGrid();
}
on('btn-call-toggle-mic', 'click', toggleMic);

on('btn-call-toggle-cam', 'click', () => {
  if (!callState.localStream) return;
  if (!callState.video || !callState.localStream.getVideoTracks().length) {
    showTransientNotice('В этом звонке нет видео');
    return;
  }
  callState.camOn = !callState.camOn;
  callState.localStream.getVideoTracks().forEach(t => { t.enabled = callState.camOn; });
  const camButton = $('btn-call-toggle-cam');
  camButton.classList.toggle('active-off', !callState.camOn);
  camButton.title = callState.camOn ? 'Выключить камеру' : 'Включить камеру';
  camButton.setAttribute('aria-label', camButton.title);
  renderCallGrid();
});

// Ctrl+Shift+M — мьют микрофона во время звонка (как в Discord)
document.addEventListener('keydown', e => {
  if (callState.active && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleMic();
  }
});

/* ── Incoming call UI ──────────────────────────────────────────────────── */
function dismissIncomingCall() {
  clearTimeout(callState.incomingTimer);
  callState.pendingIncoming = null;
  setDisplay('incoming-call-modal', 'none');
  sfx.stopRing();
}

function showIncomingCall(info) {
  callState.pendingIncoming = info;
  const nick = info.isGroup
    ? (state.groups[info.groupId]?.name || 'Групповой звонок')
    : (info.fromNick || state.friends[info.from]?.nickname || info.from);
  setText('incoming-call-nick', nick);
  setText('incoming-call-sub', info.isGroup
    ? `${info.fromNick || 'Кто-то'} начал(а) ${info.video ? 'видео' : 'аудио'}звонок`
    : `Входящий ${info.video ? 'видео' : 'аудио'}звонок…`);
  const avatarUrl = info.isGroup ? null : (state.friends[info.from]?.avatar || null);
  if (info.isGroup) renderGroupAv($('incoming-call-avatar'), state.groups[info.groupId]);
  else renderAv($('incoming-call-avatar'), nick, avatarUrl);
  setDisplay('incoming-call-modal', 'flex');
  sfx.startRing(false);

  clearTimeout(callState.incomingTimer);
  callState.incomingTimer = setTimeout(() => {
    if (callState.pendingIncoming?.callId === info.callId) {
      if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
      dismissIncomingCall();
      showTransientNotice(`Пропущенный звонок от ${nick}`);
    }
  }, CALL_RING_TIMEOUT_MS);
}

on('btn-call-accept', 'click', async () => {
  const info = callState.pendingIncoming;
  if (!info) return;
  setDisplay('incoming-call-modal', 'none');
  sfx.stopRing();

  let stream;
  try {
    stream = await acquireLocalStream(info.video);
  } catch (e) {
    showTransientNotice('Не удалось получить доступ к камере/микрофону');
    socket.emit('callReject', { callId: info.callId });
    dismissIncomingCall();
    return;
  }
  // Пока запрашивали разрешение, звонок могли отменить / завершить
  if (callState.pendingIncoming?.callId !== info.callId || callState.active) {
    stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    dismissIncomingCall();
    return;
  }

  beginCallSession({
    stream,
    callId: info.callId,
    chatKey: info.chatKey || null,
    isGroup: !!info.isGroup,
    groupId: info.groupId || null,
    peerFriendId: info.isGroup ? null : info.from,
    peerFriendName: info.isGroup ? null : (info.fromNick || state.friends[info.from]?.nickname || info.from),
    video: info.video,
  });
  openCallOverlay('соединение…');
  socket.emit('callJoin', { callId: info.callId });
  sfx.join();
});

on('btn-call-decline', 'click', () => {
  const info = callState.pendingIncoming;
  if (!info) return;
  if (!info.isGroup) socket.emit('callReject', { callId: info.callId });
  dismissIncomingCall();
});

/* ── Signaling helpers ─────────────────────────────────────────────────── */
async function flushPendingCandidates(peerId) {
  const peer = callState.peers[peerId];
  if (!peer || !peer.pc.remoteDescription) return;
  const queue = peer.pendingCandidates.splice(0);
  for (const c of queue) {
    try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn('addIceCandidate failed', e); }
  }
}

/**
 * Обработка SDP/ICE. Разрешение «glare» (оба одновременно отправили offer)
 * по схеме perfect negotiation: «вежливый» пир (с бо́льшим id) откатывает свой offer.
 */
async function handleCallSignal({ callId, from, data } = {}) {
  if (!callState.active || !callId || callId !== callState.callId) return;
  if (!from || !data || from === state.me?.id) return;

  const pc = createPeerConnection(from);
  const peer = callState.peers[from];
  if (!peer) return;

  try {
    if (data.type === 'offer') {
      const collision = pc.signalingState !== 'stable' || !!pc.localDescription;
      const polite = String(state.me?.id) > String(from);
      if (collision && !polite) return; // наш offer «победил», чужой игнорируем
      if (collision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(new RTCSessionDescription(data.sdp)),
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      }
      await flushPendingCandidates(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('callSignal', { callId, to: from, data: { type: 'answer', sdp: answer } });
    } else if (data.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushPendingCandidates(from);
    } else if (data.type === 'ice' && data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } else {
        peer.pendingCandidates.push(data.candidate);
      }
    }
  } catch (e) {
    console.warn('[call] signal error from', from, e);
  }
}

/** Новый участник инициирует offer ко всем, кто уже в звонке. */
async function offerToParticipants(participants) {
  const others = (participants || []).filter(id => id && id !== state.me?.id);
  for (const peerId of others) {
    try { await connectToPeer(peerId, true); } catch (e) { console.warn('[call] offer failed', peerId, e); }
  }
  renderCallGrid();
  if (!others.length) {
    setText('call-overlay-status', callState.isGroup ? 'ожидание участников…' : 'ожидание ответа…');
  }
}

/* ── Socket events: calls ──────────────────────────────────────────────
 * Ожидаемый протокол сервера:
 *  callIncoming    { callId, chatKey, isGroup, groupId, video, from, fromNick }
 *  callStarted     { callId, chatKey, participants }   — ответ инициатору на callStart
 *  callJoined      { callId, participants }            — ответ на callJoin
 *  callPeerJoined  { callId, peerId }
 *  callPeerLeft    { callId, peerId }
 *  callSignal      { callId, from, data }
 *  callRejected    { callId, by, reason }              — DM: собеседник отклонил / занят
 *  callCancelled   { callId }                          — инициатор отменил до ответа
 *  callEnded       { callId, reason }
 *  callError       { reason }
 * ────────────────────────────────────────────────────────────────────── */
socket.on('callIncoming', info => {
  if (!info?.callId) return;
  const busy = callState.active || callState.pendingIncoming;
  if (busy) {
    if (!info.isGroup) socket.emit('callReject', { callId: info.callId, reason: 'busy' });
    return;
  }
  // Групповой канал, который уже отображается в списке, не звонит повторно
  if (info.isGroup && state.groupVoiceCalls[info.groupId]?.callId === info.callId) return;
  showIncomingCall(info);
});

socket.on('callStarted', ({ callId, chatKey, participants } = {}) => {
  if (!callState.active || !callId) return;
  if (callState.callId && callState.callId !== callId) return;
  callState.callId = callId;
  if (chatKey) callState.chatKey = chatKey;
  if (callState.isGroup && callState.groupId) {
    const existing = state.groupVoiceCalls[callState.groupId];
    if (!existing || existing.callId !== callId) {
      state.groupVoiceCalls[callState.groupId] = {
        callId, video: callState.video,
        participants: participants && participants.length ? participants : [state.me?.id].filter(Boolean),
      };
      renderGroupsList();
      updateGroupVoiceBar(callState.groupId);
    }
  }
  offerToParticipants(participants);
});

socket.on('callJoined', ({ callId, participants } = {}) => {
  if (!callState.active || !callId || callId !== callState.callId) return;
  offerToParticipants(participants);
});

socket.on('callPeerJoined', ({ callId, peerId } = {}) => {
  if (!callState.active || callId !== callState.callId || !peerId || peerId === state.me?.id) return;
  clearTimeout(callState.ringTimer);
  sfx.stopRing();
  sfx.join();
  // Offer пришлёт сам вошедший — только готовим соединение и плитку
  createPeerConnection(peerId);
  setText('call-overlay-status', 'соединение…');
  renderCallGrid();
});

socket.on('callPeerLeft', ({ callId, peerId } = {}) => {
  if (!callState.active || callId !== callState.callId || !peerId) return;
  const name = callPeerName(peerId);
  teardownPeer(peerId);
  sfx.leave();
  if (!callState.isGroup) {
    showTransientNotice('Собеседник завершил звонок');
    closeCallOverlay();
    return;
  }
  showTransientNotice(`${name} покинул(а) канал`);
  if (!Object.keys(callState.peers).length) setText('call-overlay-status', 'ожидание участников…');
});

socket.on('callSignal', payload => { handleCallSignal(payload); });

socket.on('callRejected', ({ callId, reason } = {}) => {
  if (!callState.active || callId !== callState.callId) return;
  if (callState.isGroup) return;
  showTransientNotice(reason === 'busy' ? 'Собеседник занят' : 'Собеседник отклонил звонок');
  closeCallOverlay();
});

socket.on('callCancelled', ({ callId } = {}) => {
  if (!callId) return;
  if (callState.pendingIncoming?.callId === callId) {
    const nick = callState.pendingIncoming.isGroup
      ? (state.groups[callState.pendingIncoming.groupId]?.name || 'группы')
      : (callState.pendingIncoming.fromNick || callState.pendingIncoming.from);
    dismissIncomingCall();
    showTransientNotice(`Пропущенный звонок от ${nick}`);
  }
});

socket.on('callEnded', ({ callId, reason } = {}) => {
  if (!callId) return;
  if (callState.pendingIncoming?.callId === callId) {
    dismissIncomingCall();
    return;
  }
  if (callState.active && callState.callId === callId) {
    const messages = {
      timeout: 'Нет ответа',
      ended: 'Звонок завершён',
      group_deleted: 'Группа удалена — звонок завершён',
      kicked: 'Вы исключены из группы — звонок завершён',
      server_error: 'Звонок прерван из-за ошибки сервера',
    };
    showTransientNotice(messages[reason] || 'Звонок завершён');
    closeCallOverlay();
  }
});

socket.on('callError', ({ reason } = {}) => {
  const messages = {
    busy: 'Собеседник уже в звонке',
    offline: 'Пользователь не в сети',
    not_found: 'Звонок не найден или уже завершён',
    not_friends: 'Звонить можно только друзьям',
    not_member: 'Вы не участник группы',
    blocked: 'Невозможно позвонить этому пользователю',
    limit_reached: 'Достигнут лимит участников звонка',
    rate_limited: 'Слишком много действий, подождите',
    server_error: 'Ошибка сервера',
  };
  showTransientNotice(messages[reason] || 'Ошибка звонка');
  // Если сессия запущена локально, но сервер отказал — сворачиваем оверлей
  if (callState.active) closeCallOverlay();
  else if (callState.pendingIncoming) dismissIncomingCall();
});

/* ── Дополнительная защита: смена участников группы во время звонка ───── */
socket.on('groupMemberLeft', ({ groupId, userId } = {}) => {
  if (!callState.active || !callState.isGroup || callState.groupId !== groupId) return;
  if (userId && userId !== state.me?.id && callState.peers[userId]) teardownPeer(userId);
});

/* ============================================================================
 * GLOBAL ERROR GUARDS
 * ==========================================================================*/
window.addEventListener('unhandledrejection', e => {
  if (e.reason instanceof AuthError) { e.preventDefault(); return; }
  console.error('Unhandled rejection:', e.reason);
});

window.addEventListener('error', e => {
  console.error('Uncaught error:', e.error || e.message);
});

Object.assign(window, { state, callState, socket, sfx, BACKEND_URL, RTC_CONFIG, MAX_AVATAR_SIZE, ALLOWED_AVATAR_TYPES, RAW_AUDIO_CONSTRAINTS, setText, setDisplay, showTransientNotice, authFetch, safeJson, on, closeActiveChat, isAnyModalOpen, openGroupChat, updateGroupVoiceBar, renderGroupsList, showUserProfile, openChat, renderFriendsList, renderGroupMembersPanel, updateTitleBadge, closeProfileModal, closeGroupInfoModal, closeAddMembersModal, closeCreateGroupModal, refreshGroupItem, openGroupInfoModal, closeAllModals, openEditProfileModal, closeEditProfileModal, openBlockedUsersModal, closeBlockedUsersModal });
