'use strict';

/* ============================================================================
 * LOCAL STATE / HELPERS
 * ========================================================================== */

const composerDrafts = new Map();
const retryMessages = new Map();
const composerAttachments = new Map();

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif)$/i;

const pendingAvatar = {
  file: null,
  previewUrl: null,
  remove: false,
};

let uiSessionRevision = state.sessionRevision;
let groupsLoadSequence = 0;
let groupsLoadController = null;
let profileLoadController = null;
let profileVisibleUserId = null;
let profileModalSequence = 0;
let editProfileSequence = 0;
let profileSaveOperation = null;
let blockedLoadSequence = 0;
let blockedLoadController = null;
let blockedUsersCache = [];

let createGroupSequence = 0;
let createGroupOperation = null;
let addMembersSequence = 0;

const uiHistoryOperations = new Set();
const uiDeleteOperations = new Map();
const uiBlockOperations = new Map();

function uiRecord(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function uiId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const id = String(value);
  return id && id.length <= 512 ? id : '';
}

function uiIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(uiId).filter(Boolean))];
}

function uiMembers(group) {
  if (!Array.isArray(group?.members)) return [];

  const seen = new Set();

  return group.members.filter(member => {
    if (!uiRecord(member)) return false;
    const id = uiId(member.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function uiUnread(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function uiSnapshot() {
  return {
    revision: state.sessionRevision,
    userId: state.me?.id,
  };
}

function uiCurrent(snapshot) {
  return !!state.me &&
    state.sessionRevision === snapshot.revision &&
    state.me.id === snapshot.userId;
}

function uiSilentError(error) {
  return error?.name === 'AuthError' ||
    error?.name === 'SessionChangedError' ||
    error?.name === 'AbortError';
}

function uiErrorText(data, fallback) {
  return typeof data?.error === 'string' ? data.error : fallback;
}

function uiRun(action) {
  try {
    Promise.resolve(action()).catch(error => {
      if (!uiSilentError(error)) {
        console.warn('[ui] action failed', error);
        showTransientNotice(error?.message || 'Не удалось выполнить действие');
      }
    });
  } catch (error) {
    if (!uiSilentError(error)) {
      console.warn('[ui] action failed', error);
      showTransientNotice(error?.message || 'Не удалось выполнить действие');
    }
  }
}

function uiNode(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text ?? '');
  return element;
}

function uiActivate(element, action) {
  element.setAttribute('role', 'button');
  element.tabIndex = 0;

  element.addEventListener('click', event => {
    uiRun(() => action(event));
  });

  element.addEventListener('keydown', event => {
    if (event.target !== element || event.repeat) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;

    event.preventDefault();
    element.click();
  });
}

function uiCallBusy() {
  if (typeof callBusy === 'function') return callBusy();

  return !!(
    callState.active ||
    callState.pendingIncoming
  );
}

function uiSyncOverlay() {
  if (typeof scheduleOverlaySync === 'function') {
    scheduleOverlaySync();
  } else if (typeof syncVoiceOverlayPosition === 'function') {
    syncVoiceOverlayPosition();
  }
}

function uiMessageId(message) {
  return uiId(message?._id ?? message?.id);
}

function uiFindMessage(container, id) {
  if (!id) return null;

  for (const element of container.querySelectorAll('.g-msg[data-msgid]')) {
    if (element.dataset.msgid === id) return element;
  }

  return null;
}

function uiValidMessage(message) {
  return uiRecord(message) && !!uiId(message.from);
}

function uiSortMessages(messages) {
  return messages.sort((a, b) =>
    getMsgTimeMs(a) - getMsgTimeMs(b) ||
    uiMessageId(a).localeCompare(uiMessageId(b)),
  );
}

function uiUniqueMessages(messages) {
  const known = new Map();
  const anonymous = [];

  for (const message of messages) {
    if (!uiValidMessage(message)) continue;

    const id = uiMessageId(message);

    if (id) known.set(id, message);
    else anonymous.push(message);
  }

  return uiSortMessages([...known.values(), ...anonymous]);
}

function uiUploadUrl(value) {
  if (typeof value !== 'string') return '';

  try {
    const parsed = new URL(value, BACKEND_URL);
    if (parsed.origin !== new URL(BACKEND_URL).origin) return '';
    if (parsed.username || parsed.password) return '';
    if (!/^\/uploads\/[A-Za-z0-9._-]{1,120}$/.test(parsed.pathname)) return '';

    return avatarSrc(value);
  } catch (_) {
    return '';
  }
}

function uiClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();

  if (window.crypto?.getRandomValues) {
    const values = new Uint32Array(4);
    window.crypto.getRandomValues(values);
    return [...values].map(value => value.toString(16).padStart(8, '0')).join('');
  }

  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uiEnsureSession() {
  if (uiSessionRevision !== state.sessionRevision) {
    resetChatUiState();
  }
}

function resetChatUiState() {
  uiSessionRevision = state.sessionRevision;

  groupsLoadSequence++;
  profileModalSequence++;
  blockedLoadSequence++;
  editProfileSequence++;
  createGroupSequence++;
  addMembersSequence++;

  groupsLoadController?.abort();
  profileLoadController?.abort();
  blockedLoadController?.abort();

  groupsLoadController = null;
  profileLoadController = null;
  blockedLoadController = null;

  for (const operation of uiHistoryOperations) {
    operation.cancelled = true;
    operation.controller?.abort();
  }

  uiHistoryOperations.clear();
  uiDeleteOperations.clear();
  uiBlockOperations.clear();

  composerDrafts.clear();
  retryMessages.clear();
  composerAttachments.clear();

  profileVisibleUserId = null;
  blockedUsersCache = [];
  profileSaveOperation = null;
  createGroupOperation = null;

  releaseAvatarPreview();
  syncAvatarPendingUi();
  uiSetProfileSaving(false);

  for (const id of ['messages', 'group-messages']) {
    const box = $(id);
    if (!box) continue;

    box._historyOperation = null;
    box._loadingHistory = false;
    box._historyReady = false;
    box._liveMessages = new Map();
    box._liveAnonymous = [];
  }

  for (const id of ['msg-input', 'group-msg-input']) {
    const input = $(id);
    if (input) input.value = '';
  }

  for (const id of ['msg-attach-preview', 'group-attach-preview']) {
    const box = $(id);
    box?.replaceChildren();
    box?.classList.remove('show');
  }

  const createButton = $('btn-confirm-create-group');
  if (createButton) {
    createButton.disabled = false;
    createButton.removeAttribute('aria-busy');
    createButton.textContent = 'Создать';
  }
}

window.resetChatUiState = resetChatUiState;

/* ============================================================================
 * GROUPS LIST
 * ========================================================================== */

async function loadGroups() {
  uiEnsureSession();
  if (!state.me) return false;

  const snapshot = uiSnapshot();
  const sequence = ++groupsLoadSequence;
  const before = new Map(Object.entries(state.groups));

  groupsLoadController?.abort();
  const controller = new AbortController();
  groupsLoadController = controller;

  try {
    const response = await authFetch(`${BACKEND_URL}/api/groups`, {
      signal: controller.signal,
    });

    if (!response.ok) throw new Error('Не удалось загрузить группы');

    const data = await response.json();

    if (!uiCurrent(snapshot) || sequence !== groupsLoadSequence) return false;
    if (!Array.isArray(data)) throw new Error('Некорректный список групп');

    const next = Object.create(null);

    for (const group of data) {
      if (!uiRecord(group)) continue;

      const id = uiId(group.id);
      if (!id) continue;

      next[id] = {
        ...group,
        id,
        name: typeof group.name === 'string' ? group.name : id,
        members: uiMembers(group),
      };
    }

    /*
     * Не затираем группы, добавленные/заменённые socket-обработчиками
     * во время HTTP-запроса. Для строгой синхронизации серверу нужны
     * версии записей; сравнение ссылок не обнаруживает мутации in-place.
     */
    for (const [id, group] of Object.entries(state.groups)) {
      if (!before.has(id) || before.get(id) !== group) next[id] = group;
    }

    for (const id of before.keys()) {
      if (!Object.prototype.hasOwnProperty.call(state.groups, id)) {
        delete next[id];
      }
    }

    state.groups = next;

    renderGroupsList();

    if (state.activeGroup && state.groups[state.activeGroup]) {
      updateGroupChatHeader(state.groups[state.activeGroup]);
      renderGroupMembersPanel(state.groups[state.activeGroup]);
    }

    return true;
  } catch (error) {
    if (
      uiCurrent(snapshot) &&
      sequence === groupsLoadSequence &&
      !uiSilentError(error)
    ) {
      showTransientNotice('Не удалось загрузить группы');
    }

    return false;
  } finally {
    if (groupsLoadController === controller) groupsLoadController = null;
  }
}

function sortedGroupIds() {
  return Object.keys(state.groups).sort((a, b) => {
    const aUnread = uiUnread(state.groupUnread[a]);
    const bUnread = uiUnread(state.groupUnread[b]);

    if (!!aUnread !== !!bUnread) return aUnread ? -1 : 1;

    const aActivity = Number(state.groupLastActivity[a]) || 0;
    const bActivity = Number(state.groupLastActivity[b]) || 0;

    if (aActivity !== bActivity) return bActivity - aActivity;

    return String(state.groups[a]?.name || a)
      .localeCompare(String(state.groups[b]?.name || b), 'ru') ||
      a.localeCompare(b);
  });
}

function renderGroupsList() {
  const list = $('groups-list');
  if (!list) return;

  const ids = sortedGroupIds();
  const focused = document.activeElement;
  const focusedItem = focused?.closest?.('.group-item');
  const focusId = focusedItem?.dataset.gid;
  const focusJoin = focused?.classList?.contains('group-voice-channel-join');

  if (!ids.length) {
    list.innerHTML = emptyGroupsHTML();
    updateTitleBadge();
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const id of ids) {
    const element = buildGroupEl(id);
    if (element) fragment.appendChild(element);
  }

  list.replaceChildren(fragment);

  if (focusId && focusedItem && !focusedItem.isConnected) {
    const item = [...list.children].find(el => el.dataset.gid === focusId);
    const target = focusJoin
      ? item?.querySelector('.group-voice-channel-join')
      : item;

    if (target && !target.disabled) target.focus({ preventScroll: true });
  }

  updateTitleBadge();
}

function memberName(group, peerId) {
  const id = uiId(peerId);
  if (!id) return '';

  if (id === String(state.me?.id)) return state.me?.nickname || id;

  return uiMembers(group).find(member => String(member.id) === id)?.nickname ||
    state.friends[id]?.nickname ||
    id;
}

function buildGroupEl(id) {
  const group = state.groups[id];
  if (!group) return null;

  const unread = uiUnread(state.groupUnread[id]);
  const members = uiMembers(group);
  const onlineCount = members.filter(member => member.online === true).length;

  const voice = state.groupVoiceCalls[id];
  const participants = uiIds(voice?.participants);
  const inCall = !!voice?.callId &&
    callState.active &&
    callState.callId === voice.callId;

  const element = uiNode(
    'div',
    `friend-item group-item${state.activeGroup === id ? ' active' : ''}`,
  );

  element.dataset.gid = id;
  element.setAttribute('role', 'button');
  element.tabIndex = 0;
  element.setAttribute('aria-label', `Группа: ${group.name || id}`);

  const avatar = uiNode('div', 'f-av group-av-slot');
  const info = uiNode('div', 'f-info');

  info.append(
    uiNode('div', 'f-nick', group.name || id),
    uiNode(
      'div',
      'f-stat',
      `${plural(members.length, 'участник', 'участника', 'участников')} · ${onlineCount} в сети`,
    ),
  );

  element.append(avatar, info);
  renderGroupAv(avatar, group);

  if (unread) {
    element.appendChild(uiNode('div', 'f-unread', unread > 99 ? '99+' : unread));
  }

  if (uiId(voice?.callId)) {
    const channel = uiNode('div', 'group-voice-channel');
    channel.dataset.voiceGroup = id;

    const head = uiNode('div', 'group-voice-channel-head');

    head.append(
      uiNode('span', 'group-voice-channel-icon', '🔊'),
      uiNode('span', 'group-voice-channel-name', 'Голосовой канал'),
      uiNode('span', 'group-voice-channel-count', participants.length),
    );

    const voiceMembers = uiNode('div', 'group-voice-channel-members');

    for (const peerId of participants) {
      const member = uiNode('span', 'group-voice-member');
      member.append(
        uiNode('i'),
        document.createTextNode(memberName(group, peerId)),
      );
      voiceMembers.appendChild(member);
    }

    if (!participants.length) {
      voiceMembers.appendChild(
        uiNode('span', 'group-voice-member empty', 'Никто не подключён'),
      );
    }

    const join = uiNode(
      'button',
      'group-voice-channel-join',
      inCall ? 'Вы в канале' : 'Войти',
    );

    join.type = 'button';
    join.disabled = inCall || uiCallBusy() || !socket.connected;

    join.addEventListener('click', event => {
      event.stopPropagation();

      if (uiCallBusy() || !socket.connected) return;

      uiRun(() => {
        if (state.groupVoiceCalls[id]?.callId) {
          return joinExistingGroupVoice(id);
        }
        return startCall({ groupId: id, video: false });
      });
    });

    channel.append(head, voiceMembers, join);
    element.appendChild(channel);
  }

  element.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('button')) return;
    uiRun(() => openGroupChat(id));
  });

  element.addEventListener('keydown', event => {
    if (event.target !== element || event.repeat) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;

    event.preventDefault();
    uiRun(() => openGroupChat(id));
  });

  return element;
}

function refreshGroupItem() {
  // Изменение активности/unread может менять позицию, не только содержимое.
  renderGroupsList();
}

/* ============================================================================
 * MOBILE / MESSAGE LIST HELPERS
 * ========================================================================== */

function enterMobileChatView(backButtonId) {
  if (window.innerWidth > 640) return;

  document.querySelector('.sidebar')?.classList.add('hidden');
  document.querySelector('.chat-main')?.classList.remove('hidden');
  setDisplay(backButtonId, '');
}

function resetMsgContainer(box) {
  if (!box) return;

  box.replaceChildren();
  delete box.dataset.lastDay;
  delete box.dataset.hasNewDivider;
}

function renderChatWelcome(box, { nick, avatar, group, sub, strong } = {}) {
  if (!box) return;

  const welcome = uiNode('div', 'chat-welcome');
  const avatarElement = uiNode(
    'div',
    `chat-welcome-av${group ? ' group-av' : ''}`,
  );

  avatarElement.setAttribute('aria-hidden', 'true');

  const subtitle = uiNode('div', 'chat-welcome-sub', sub || '');

  if (strong) {
    subtitle.append(
      uiNode('b', '', strong),
      document.createTextNode('.'),
    );
  }

  welcome.append(
    avatarElement,
    uiNode('div', 'chat-welcome-title', nick || ''),
    subtitle,
  );

  if (group) renderGroupAv(avatarElement, group);
  else renderAv(avatarElement, nick, avatar);

  box.appendChild(welcome);
}

function ensureDateDivider(container, timeMs) {
  const key = dayKey(timeMs);
  if (!key || container.dataset.lastDay === key) return;

  container.dataset.lastDay = key;

  const divider = uiNode('div', 'msg-divider');
  divider.dataset.day = key;
  divider.appendChild(uiNode('span', '', fmtDayLabel(timeMs)));
  container.appendChild(divider);
}

function appendNewMessagesDivider(container) {
  if (container.dataset.hasNewDivider) return;

  container.dataset.hasNewDivider = '1';

  const divider = uiNode('div', 'msg-divider new');
  divider.appendChild(uiNode('span', '', 'Новые сообщения'));
  container.appendChild(divider);
}

function appendSystemMsg(containerId, text) {
  const container = $(containerId);
  if (!container) return;

  const stick = isNearBottom(container);
  const now = Date.now();

  clearMsgsPlaceholder(container);
  ensureDateDivider(container, now);

  const element = uiNode('div', 'msg-system');
  element.append(
    uiNode('span', 'msg-system-icon', '→'),
    uiNode('span', '', text),
    uiNode('span', 'msg-system-time', fmtTime(now)),
  );

  container.appendChild(element);

  if (stick) scrollMsgs(containerId);
}

function uiCancelHistory(box) {
  const operation = box?._historyOperation;

  if (operation) {
    operation.cancelled = true;
    operation.controller?.abort();
    uiHistoryOperations.delete(operation);
  }

  if (box) {
    box._historyOperation = null;
    box._loadingHistory = false;
  }
}

function uiInitializeConversation(box, key) {
  uiCancelHistory(box);

  box._conversationKey = key;
  box._historyReady = false;
  box._loadingHistory = false;
  box._liveMessages = new Map();
  box._liveAnonymous = [];

  resetMsgContainer(box);
  box.innerHTML = placeholderHTML('Загрузка…');
}

function uiMarkRead(group, target) {
  if (!socket.connected || document.visibilityState !== 'visible') return;

  const box = $(group ? 'group-messages' : 'messages');
  if (!box?._historyReady || box._loadingHistory) return;
  if (!isNearBottom(box)) return;

  socket.emit(group ? 'markGroupRead' : 'markRead', target);
}

/* ============================================================================
 * DM CHAT
 * ========================================================================== */

async function openChat(value) {
  uiEnsureSession();

  const id = uiId(value);
  if (!state.me || !id) return;

  saveComposerDraft();

  state.seq.groupChat++;
  uiCancelHistory($('group-messages'));

  const requestSeq = ++state.seq.chat;
  const snapshot = uiSnapshot();
  const previousGroup = state.activeGroup;
  const unreadBefore = uiUnread(state.unread[id]);

  state.activeFriend = id;
  state.activeGroup = null;

  document.querySelectorAll('.friend-item').forEach(element => {
    element.classList.toggle('active', element.dataset.fid === id);
  });

  refreshFriendItem(id);
  if (previousGroup) refreshGroupItem(previousGroup);

  const friend = state.friends[id] || {
    id,
    nickname: id,
    online: false,
  };

  renderAv($('chat-avatar'), friend.nickname, friend.avatar);
  setText('chat-nick', friend.nickname);

  const status = $('chat-status');

  if (status) {
    status.textContent = friend.online ? 'В сети' : 'Не в сети';
    status.className = `chat-head-status${friend.online ? ' on' : ''}`;
  }

  const input = $('msg-input');

  if (input) {
    input.placeholder = `Написать @${friend.nickname || id}`;
    input.value = composerDrafts.get(`dm:${id}`) || '';
  }

  setDisplay('chat-placeholder', 'none');
  setDisplay('group-chat-window', 'none');
  setDisplay('group-voice-bar', 'none');
  setDisplay('chat-window', 'flex');

  window.updateDmVoiceBar?.();

  if (socket.connected) socket.emit('watchDmVoice', { peerId: id });

  enterMobileChatView('btn-back');
  refreshComposer(false);
  uiSyncOverlay();

  const box = $('messages');
  if (!box) return;

  uiInitializeConversation(box, `dm:${id}`);

  const loaded = await loadConversationHistory(
    box,
    `${BACKEND_URL}/api/messages/${encodeURIComponent(snapshot.userId)}/${encodeURIComponent(id)}`,
    {
      nick: friend.nickname,
      avatar: friend.avatar,
      sub: 'Это начало личной переписки с ',
      strong: `@${friend.id || id}`,
    },
    message => appendMsg(message, 'messages', false),
    'chat',
    requestSeq,
    unreadBefore,
  );

  if (
    !uiCurrent(snapshot) ||
    requestSeq !== state.seq.chat ||
    state.activeFriend !== id
  ) {
    return;
  }

  if (loaded && document.visibilityState === 'visible') {
    state.unread[id] = 0;
    refreshFriendItem(id);
    updateTitleBadge();
    uiMarkRead(false, id);
  }

  if (
    window.innerWidth > 640 &&
    !isAnyModalOpen() &&
    (!document.activeElement ||
      document.activeElement === document.body ||
      document.activeElement.closest?.('.friend-item'))
  ) {
    input?.focus();
  }
}

/* ============================================================================
 * MESSAGE RENDERING
 * ========================================================================== */

function shouldGroupMsg(container, senderId, timeMs) {
  const last = container.lastElementChild;

  if (!last?.classList.contains('g-msg')) return false;
  if (last.dataset.sender !== String(senderId)) return false;

  const previousTime = Number(last.dataset.time);
  if (!Number.isFinite(previousTime)) return false;

  const difference = timeMs - previousTime;
  return difference >= 0 && difference < MSG_GROUP_WINDOW_MS;
}

function appendChatMsg(msg, containerId, ctx = {}, doScroll = true) {
  if (!state.me || !uiValidMessage(msg)) return;

  const container = $(containerId);
  if (!container) return;

  const messageId = uiMessageId(msg);

  /*
   * Сохраняем realtime отдельно, включая сообщения без server ID.
   * На успешной загрузке они будут объединены с историей.
   */
  if (container._loadingHistory) {
    container._liveMessages ||= new Map();
    container._liveAnonymous ||= [];

    if (messageId) container._liveMessages.set(messageId, msg);
    else if (!container._liveAnonymous.includes(msg)) {
      container._liveAnonymous.push(msg);
    }
  }

  const previous = messageId ? uiFindMessage(container, messageId) : null;

  if (previous) {
    // Удаление, пришедшее раньше истории, не должно восстановить текст.
    if (msg.deleted) uiApplyDeletedMessage(messageId);
    return;
  }

  const stick = doScroll && isNearBottom(container);
  const senderId = uiId(msg.from);
  const isMine = senderId === String(state.me.id);
  const deleted = msg.deleted === true;
  const timeMs = getMsgTimeMs(msg);
  const nickname = String(ctx.senderNick || senderId);

  clearMsgsPlaceholder(container);
  ensureDateDivider(container, timeMs);

  const grouped = shouldGroupMsg(container, senderId, timeMs);
  const wrap = uiNode(
    'div',
    `g-msg${isMine ? ' mine' : ''}${deleted ? ' deleted' : ''}${grouped ? ' grouped' : ''}`,
  );

  if (messageId) wrap.dataset.msgid = messageId;

  wrap.dataset.sender = senderId;
  wrap.dataset.time = String(timeMs);

  if (grouped) {
    const slot = uiNode('div', 'g-msg-av-slot');
    slot.appendChild(uiNode('span', 'g-msg-hover-time', fmtTime(timeMs)));
    wrap.appendChild(slot);
  } else {
    const avatar = uiNode('div', 'g-msg-av');
    renderAv(avatar, nickname, ctx.senderAvatar);

    if (!isMine) {
      avatar.classList.add('clickable');
      avatar.setAttribute('aria-label', `Профиль: ${nickname}`);
      uiActivate(avatar, () => showUserProfile(senderId));
    }

    wrap.appendChild(avatar);
  }

  const body = uiNode('div', 'g-msg-body');

  if (!grouped) {
    const head = uiNode('div', 'g-msg-head');
    const nickElement = uiNode('span', 'g-msg-nick', nickname);

    nickElement.setAttribute('aria-label', `Профиль: ${nickname}`);

    uiActivate(
      nickElement,
      () => isMine ? openEditProfileModal() : showUserProfile(senderId),
    );

    head.appendChild(nickElement);

    if (ctx.isOwner) {
      const crown = uiNode('span');
      crown.innerHTML = CROWN_SVG; // Статическая разметка.
      head.append(...crown.childNodes);
    }

    const time = uiNode('span', 'g-msg-time', fmtMsgTime(timeMs));
    time.title = new Date(timeMs).toLocaleString('ru-RU');

    head.appendChild(time);
    body.appendChild(head);
  }

  const text = uiNode('div', 'g-msg-text');

  if (deleted) {
    text.textContent = 'Сообщение удалено';
  } else {
    const raw = typeof msg.text === 'string' ? msg.text : '';

    // formatMsgText экранирует пользовательские данные.
    text.innerHTML = formatMsgText(raw);
    text.classList.toggle('jumbo', isJumboEmoji(raw));
  }

  body.appendChild(text);

  const imageSource = !deleted ? uiUploadUrl(msg.image) : '';

  if (imageSource) {
    const image = uiNode('img', 'message-image');
    image.alt = 'Изображение в сообщении';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';

    const adjustScroll = () => {
      if (!wrap.isConnected || !doScroll) return;

      /*
       * Не тянем пользователя вниз, если он успел прокрутить историю.
       */
      if (isNearBottom(container)) scrollMsgs(containerId);
    };

    image.addEventListener('load', adjustScroll, { once: true });

    image.addEventListener('error', () => {
      if (!image.isConnected) return;
      image.replaceWith(document.createTextNode('Изображение недоступно'));
      adjustScroll();
    }, { once: true });

    image.src = imageSource;
    body.appendChild(image);
  }

  wrap.appendChild(body);

  if (isMine && !deleted && messageId) {
    const button = uiNode('button', 'msg-del-btn');
    button.type = 'button';
    button.title = 'Удалить';
    button.setAttribute('aria-label', 'Удалить сообщение');
    button.innerHTML = TRASH_SVG;

    button.addEventListener('click', event => {
      event.stopPropagation();
      openDeleteConfirm(messageId);
    });

    wrap.appendChild(button);
  }

  container.appendChild(wrap);

  if (doScroll && (stick || isMine)) scrollMsgs(containerId);
}

function appendMsg(msg, containerId = 'messages', doScroll = true) {
  if (!state.me || !uiValidMessage(msg)) return;

  const senderId = uiId(msg.from);
  const isMine = senderId === String(state.me.id);
  const friend = state.friends[senderId];

  appendChatMsg(msg, containerId, {
    senderNick: isMine ? state.me.nickname : friend?.nickname || senderId,
    senderAvatar: isMine ? state.me.avatar : friend?.avatar || null,
    isOwner: false,
  }, doScroll);
}

function appendGroupMsg(msg, doScroll = true) {
  if (!state.me || !uiValidMessage(msg)) return;

  const group = state.groups[state.activeGroup];
  const senderId = uiId(msg.from);
  const isMine = senderId === String(state.me.id);
  const sender = uiMembers(group).find(member => String(member.id) === senderId);

  appendChatMsg(msg, 'group-messages', {
    senderNick: sender?.nickname ||
      (isMine ? state.me.nickname : state.friends[senderId]?.nickname || senderId),
    senderAvatar: sender?.avatar ??
      (isMine ? state.me.avatar : state.friends[senderId]?.avatar ?? null),
    isOwner: isGroupOwner(group, senderId),
  }, doScroll);
}

/* ============================================================================
 * GROUP CHAT
 * ========================================================================== */

async function openGroupChat(value) {
  uiEnsureSession();

  const groupId = uiId(value);
  if (!state.me || !groupId || !state.groups[groupId]) return;

  saveComposerDraft();

  state.seq.chat++;
  uiCancelHistory($('messages'));

  const requestSeq = ++state.seq.groupChat;
  const snapshot = uiSnapshot();
  const previousFriend = state.activeFriend;
  const unreadBefore = uiUnread(state.groupUnread[groupId]);

  state.activeGroup = groupId;
  state.activeFriend = null;

  document.querySelectorAll('.friend-item').forEach(element => {
    element.classList.toggle('active', element.dataset.gid === groupId);
  });

  refreshGroupItem(groupId);
  if (previousFriend) refreshFriendItem(previousFriend);

  const group = state.groups[groupId];

  updateGroupChatHeader(group);
  renderGroupMembersPanel(group);

  const input = $('group-msg-input');

  if (input) {
    input.placeholder = `Написать в ${group.name || groupId}`;
    input.value = composerDrafts.get(`group:${groupId}`) || '';
  }

  setDisplay('chat-placeholder', 'none');
  setDisplay('chat-window', 'none');
  setDisplay('dm-voice-bar', 'none');
  setDisplay('group-chat-window', 'flex');

  if (socket.connected) socket.emit('watchGroupVoice', { groupId });

  updateGroupVoiceBar(groupId);
  enterMobileChatView('btn-back-group');
  refreshComposer(true);
  uiSyncOverlay();

  const box = $('group-messages');
  if (!box) return;

  uiInitializeConversation(box, `group:${groupId}`);

  const loaded = await loadConversationHistory(
    box,
    `${BACKEND_URL}/api/groups/${encodeURIComponent(groupId)}/messages`,
    {
      nick: group.name,
      group,
      sub: 'Это начало общего разговора. Всё, что здесь пишут, видят все участники.',
    },
    message => appendGroupMsg(message, false),
    'groupChat',
    requestSeq,
    unreadBefore,
  );

  if (
    !uiCurrent(snapshot) ||
    requestSeq !== state.seq.groupChat ||
    state.activeGroup !== groupId
  ) {
    return;
  }

  if (loaded && document.visibilityState === 'visible') {
    state.groupUnread[groupId] = 0;
    refreshGroupItem(groupId);
    updateTitleBadge();
    uiMarkRead(true, groupId);
  }

  if (
    window.innerWidth > 640 &&
    !isAnyModalOpen() &&
    (!document.activeElement ||
      document.activeElement === document.body ||
      document.activeElement.closest?.('.friend-item'))
  ) {
    input?.focus();
  }
}

function updateGroupVoiceBar() {
  const bar = $('group-voice-bar');
  if (!bar) return;

  const groupId = state.activeGroup;
  const call = groupId ? state.groupVoiceCalls[groupId] : null;
  const visible = !!(groupId && uiId(call?.callId));

  bar.style.display = visible ? 'flex' : 'none';
  if (!visible) return;

  const group = state.groups[groupId];
  const participants = uiIds(call.participants);

  setText(
    'group-voice-count',
    participants.length
      ? `${plural(participants.length, 'участник', 'участника', 'участников')} в голосовом канале`
      : 'Канал ждёт участников',
  );

  const container = $('group-voice-members');

  if (container) {
    container.replaceChildren();

    for (const peerId of participants) {
      const member = uiMembers(group)
        .find(item => String(item.id) === peerId) ||
        (peerId === String(state.me?.id) ? state.me : state.friends[peerId]);

      const nickname = member?.nickname || peerId;
      const avatar = uiNode('div', 'group-voice-member-avatar');
      avatar.title = nickname;

      renderAv(avatar, nickname, member?.avatar || null);
      container.appendChild(avatar);
    }
  }

  const join = $('btn-join-group-voice');

  if (join) {
    const inCall = callState.active && callState.callId === call.callId;

    join.textContent = inCall ? 'Вы в канале' : 'Присоединиться';
    join.disabled = inCall || uiCallBusy() || !socket.connected;
  }
}

function updateGroupChatHeader(group) {
  if (!group) return;

  renderGroupAv($('group-chat-avatar'), group);
  setText('group-chat-name', group.name || group.id);

  const members = uiMembers(group);
  const online = members.filter(member => member.online === true).length;

  setText(
    'group-chat-members-count',
    `${plural(members.length, 'участник', 'участника', 'участников')} · ${online} в сети`,
  );
}

on('group-chat-head-click', 'click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});

on('btn-group-info', 'click', () => {
  if (state.activeGroup) openGroupInfoModal(state.activeGroup);
});

/* ============================================================================
 * SEND / DELETE MESSAGE
 * ========================================================================== */

function sendMsg() {
  return sendComposer(false);
}

function sendGroupMsg() {
  return sendComposer(true);
}

on('btn-send', 'click', () => uiRun(sendMsg));
on('btn-group-send', 'click', () => uiRun(sendGroupMsg));

for (const group of [false, true]) {
  on(group ? 'group-msg-input' : 'msg-input', 'keydown', event => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      !event.repeat
    ) {
      event.preventDefault();
      uiRun(() => sendComposer(group));
    }
  });
}

document.addEventListener('keydown', event => {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    typeof event.key !== 'string' ||
    event.key.length !== 1 ||
    !state.me
  ) {
    return;
  }

  const active = document.activeElement;

  if (
    active?.isContentEditable ||
    active?.closest?.(
      'input, textarea, select, button, a, [role="button"], ' +
      '[role="checkbox"], [role="option"], [role="dialog"], [role="alertdialog"]',
    )
  ) {
    return;
  }

  if (isAnyModalOpen() || callState.pendingIncoming) return;

  const id = state.activeFriend
    ? 'msg-input'
    : state.activeGroup
      ? 'group-msg-input'
      : null;

  const input = id ? $(id) : null;

  if (input && !input.disabled && !input.readOnly) input.focus();
});

function openDeleteConfirm(value) {
  const id = uiId(value);
  if (!id || !state.me) return;

  state.pendingDeleteId = id;
  setDisplay('delete-confirm', 'flex');
}

function closeDeleteConfirm() {
  state.pendingDeleteId = null;
  setDisplay('delete-confirm', 'none');
}

function uiApplyDeletedMessage(id) {
  for (const containerId of ['messages', 'group-messages']) {
    const container = $(containerId);
    if (!container) continue;

    const element = uiFindMessage(container, id);

    if (element) {
      element.classList.add('deleted');
      element.querySelector('.msg-del-btn')?.remove();
      element.querySelectorAll('.message-image').forEach(image => image.remove());

      const text = element.querySelector('.g-msg-text');

      if (text) {
        text.classList.remove('jumbo');
        text.textContent = 'Сообщение удалено';
      }
    }

    const buffered = container._liveMessages?.get(id);
    if (buffered) container._liveMessages.set(id, { ...buffered, deleted: true });
  }
}

async function deleteMessage(value) {
  const id = uiId(value);
  if (!id || !state.me || uiDeleteOperations.has(id)) return;

  const snapshot = uiSnapshot();
  const operation = {};
  uiDeleteOperations.set(id, operation);

  try {
    const response = await authFetch(
      `${BACKEND_URL}/api/messages/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );

    if (!response.ok) {
      const data = await safeJson(response);
      if (!uiCurrent(snapshot)) return;
      throw new Error(uiErrorText(data, 'Ошибка удаления'));
    }

    if (uiCurrent(snapshot)) uiApplyDeletedMessage(id);
  } catch (error) {
    if (uiCurrent(snapshot) && !uiSilentError(error)) {
      showTransientNotice(error.message || 'Ошибка сети');
    }
  } finally {
    if (uiDeleteOperations.get(id) === operation) uiDeleteOperations.delete(id);
  }
}

on('delete-confirm', 'click', event => {
  if (event.target === $('delete-confirm')) closeDeleteConfirm();
});

on('btn-confirm-delete', 'click', () => {
  const id = state.pendingDeleteId;
  if (!id) return;

  closeDeleteConfirm();
  uiRun(() => deleteMessage(id));
});

/* ============================================================================
 * PROFILE: VIEW / BLOCK
 * ========================================================================== */

on('chat-head-click', 'click', () => {
  if (state.activeFriend) uiRun(() => showUserProfile(state.activeFriend));
});

async function showUserProfile(value) {
  uiEnsureSession();

  const userId = uiId(value);
  if (!userId || !state.me) return;

  const snapshot = uiSnapshot();
  const sequence = ++state.seq.profile;
  const modalSequence = ++profileModalSequence;

  profileVisibleUserId = userId;

  profileLoadController?.abort();
  const controller = new AbortController();
  profileLoadController = controller;

  const current = () =>
    uiCurrent(snapshot) &&
    sequence === state.seq.profile &&
    modalSequence === profileModalSequence &&
    profileVisibleUserId === userId;

  try {
    const response = await authFetch(
      `${BACKEND_URL}/api/profile/${encodeURIComponent(userId)}`,
      { signal: controller.signal },
    );

    if (!current()) return;

    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'Пользователь не найден'
          : 'Не удалось загрузить профиль',
      );
    }

    const user = await response.json();
    if (!current()) return;

    if (!uiRecord(user) || uiId(user.id) !== userId) {
      throw new Error('Некорректный профиль');
    }

    renderAvWithDot(
      $('profile-modal-avatar'),
      user.nickname,
      user.avatar,
      user.online === true,
    );

    setText('profile-modal-nick', user.nickname || userId);
    setText('profile-modal-id', `@${userId}`);

    const badge = $('profile-modal-online');

    if (badge) {
      badge.textContent = user.online ? 'В сети' : 'Не в сети';
      badge.className = `modal-online-badge ${user.online ? 'online' : 'offline'}`;
    }

    const status = typeof user.status === 'string' ? user.status : '';
    const bio = typeof user.bio === 'string' ? user.bio : '';

    setText('profile-modal-status', status);
    setText('profile-modal-bio', bio);
    setDisplay('profile-modal-status-row', status ? '' : 'none');
    setDisplay('profile-modal-bio-row', bio ? '' : 'none');
    setDisplay('profile-modal-body', status || bio ? '' : 'none');

    const isFriend = !!state.friends[userId] ||
      uiIds(state.me.friends).includes(userId);

    const isMe = userId === String(state.me.id);
    const isBlocked = uiIds(state.me.blockedUsers).includes(userId);

    const addButton = $('btn-add-friend');

    if (addButton) {
      addButton.textContent = isFriend ? 'Написать' : 'Добавить в друзья';
      addButton.disabled = isBlocked;
      addButton.style.display = isMe ? 'none' : '';

      addButton.onclick = () => {
        if (!current()) return;

        if (isFriend) {
          closeProfileModal();
          uiRun(() => openChat(userId));
        } else {
          uiRun(() => requestFriend(userId, addButton));
        }
      };
    }

    const blockButton = $('btn-block-user');

    if (blockButton) {
      blockButton.style.display = isMe ? 'none' : '';
      blockButton.disabled = uiBlockOperations.has(userId);
      blockButton.className =
        `btn-secondary btn-block${isBlocked ? '' : ' btn-danger-outline'}`;

      blockButton.textContent = isBlocked ? 'Разблокировать' : 'Заблокировать';

      blockButton.onclick = () => {
        if (!current()) return;

        uiRun(() => isBlocked
          ? performUnblock(userId)
          : performBlock(userId));
      };
    }

    setDisplay('profile-modal', 'flex');
  } catch (error) {
    if (current() && !uiSilentError(error)) {
      showTransientNotice(error.message || 'Не удалось загрузить профиль');
    }
  } finally {
    if (profileLoadController === controller) profileLoadController = null;
  }
}

async function uiChangeBlocked(value, blocked) {
  const userId = uiId(value);

  if (
    !state.me ||
    !userId ||
    userId === String(state.me.id) ||
    uiBlockOperations.has(userId)
  ) {
    return false;
  }

  const snapshot = uiSnapshot();
  const operation = {};
  uiBlockOperations.set(userId, operation);

  try {
    const response = await authFetch(
      `${BACKEND_URL}/api/users/${encodeURIComponent(userId)}/${blocked ? 'block' : 'unblock'}`,
      { method: 'POST' },
    );

    if (!response.ok) {
      const data = await safeJson(response);
      if (!uiCurrent(snapshot)) return false;

      throw new Error(uiErrorText(
        data,
        blocked ? 'Ошибка блокировки' : 'Ошибка разблокировки',
      ));
    }

    if (!uiCurrent(snapshot)) return false;

    const ids = new Set(uiIds(state.me.blockedUsers));

    if (blocked) ids.add(userId);
    else ids.delete(userId);

    state.me.blockedUsers = [...ids];

    if (blocked) {
      state.me.friends = uiIds(state.me.friends).filter(id => id !== userId);

      delete state.friends[userId];
      delete state.unread[userId];
      delete state.dmVoiceCalls[userId];

      composerDrafts.delete(`dm:${userId}`);
      composerAttachments.delete(`dm:${userId}`);
      retryMessages.delete(`dm:${userId}`);

      if (
        callState.active &&
        !callState.isGroup &&
        callState.peerFriendId === userId
      ) {
        if (typeof hangupCall === 'function') hangupCall();
      }

      renderFriendsList();
      updateTitleBadge();

      if (state.activeFriend === userId) closeActiveChat();
    }

    storage.setItem('chatapp_profile', JSON.stringify(state.me));

    if (!blocked) {
      blockedUsersCache = blockedUsersCache.filter(user => uiId(user.id) !== userId);
    }

    return true;
  } finally {
    if (uiBlockOperations.get(userId) === operation) {
      uiBlockOperations.delete(userId);
    }
  }
}

async function performUnblock(userId) {
  const snapshot = uiSnapshot();

  try {
    if (!await uiChangeBlocked(userId, false)) return;

    if (uiCurrent(snapshot) && profileVisibleUserId === String(userId)) {
      await showUserProfile(userId);
    }
  } catch (error) {
    if (uiCurrent(snapshot) && !uiSilentError(error)) {
      showTransientNotice(error.message || 'Ошибка сети');
    }
  }
}

async function performBlock(userId) {
  if (!state.me || !uiId(userId)) return;
  if (!confirm(`Заблокировать @${userId}?`)) return;

  const snapshot = uiSnapshot();

  try {
    if (!await uiChangeBlocked(userId, true)) return;

    if (uiCurrent(snapshot) && profileVisibleUserId === String(userId)) {
      await showUserProfile(userId);
    }
  } catch (error) {
    if (uiCurrent(snapshot) && !uiSilentError(error)) {
      showTransientNotice(error.message || 'Ошибка сети');
    }
  }
}

function closeProfileModal() {
  state.seq.profile++;
  profileModalSequence++;
  profileVisibleUserId = null;

  profileLoadController?.abort();
  profileLoadController = null;

  setDisplay('profile-modal', 'none');
}

on('profile-modal', 'click', event => {
  if (event.target === $('profile-modal')) closeProfileModal();
});

/* ============================================================================
 * PROFILE: EDIT / AVATAR
 * ========================================================================== */

function releaseAvatarPreview() {
  if (pendingAvatar.previewUrl) {
    try {
      URL.revokeObjectURL(pendingAvatar.previewUrl);
    } catch (_) {}
  }

  pendingAvatar.file = null;
  pendingAvatar.previewUrl = null;
  pendingAvatar.remove = false;
}

function syncAvatarPendingUi() {
  const dirty = !!pendingAvatar.file || pendingAvatar.remove;
  const hint = $('avatar-pending-hint');

  if (hint) {
    hint.textContent = pendingAvatar.remove
      ? 'Аватар будет удалён после нажатия «Сохранить изменения».'
      : 'Новое фото применится после нажатия «Сохранить изменения».';

    hint.hidden = !dirty;
  }

  const reset = $('btn-avatar-reset');
  if (reset) reset.hidden = !dirty;

  const remove = $('btn-avatar-remove');

  if (remove) {
    remove.hidden = pendingAvatar.remove ||
      (!state.me?.avatar && !pendingAvatar.file);
  }

  $('edit-profile-modal')?.classList.toggle('avatar-dirty', dirty);
}

function discardPendingAvatar() {
  const hadChanges = !!pendingAvatar.file || pendingAvatar.remove;

  releaseAvatarPreview();

  const input = $('avatar-input');
  if (input) input.value = '';

  if (state.me) renderAv($('edit-avatar'), state.me.nickname, state.me.avatar);

  syncAvatarPendingUi();
  return hadChanges;
}

function uiSetProfileSaving(saving) {
  for (const id of [
    'edit-nick',
    'edit-status',
    'edit-bio',
    'avatar-input',
    'btn-avatar-remove',
    'btn-avatar-reset',
    'btn-save-profile',
  ]) {
    const element = $(id);
    if (element) element.disabled = saving;
  }

  const button = $('btn-save-profile');

  if (button) {
    if (saving) {
      button.dataset.idleText ||= button.textContent;
      button.textContent = 'Сохранение…';
      button.setAttribute('aria-busy', 'true');
    } else {
      button.textContent = button.dataset.idleText || 'Сохранить изменения';
      button.removeAttribute('aria-busy');
    }
  }
}

function openEditProfileModal() {
  uiEnsureSession();
  if (!state.me) return;

  editProfileSequence++;

  discardPendingAvatar();

  const nickname = $('edit-nick');
  const status = $('edit-status');
  const bio = $('edit-bio');

  if (nickname) nickname.value = state.me.nickname || '';
  if (status) status.value = state.me.status || '';
  if (bio) bio.value = state.me.bio || '';

  uiSetProfileSaving(!!profileSaveOperation);
  setDisplay('edit-profile-modal', 'flex');
}

function closeEditProfileModal() {
  editProfileSequence++;
  discardPendingAvatar();
  setDisplay('edit-profile-modal', 'none');
}

on('edit-profile-modal', 'click', event => {
  if (event.target === $('edit-profile-modal')) closeEditProfileModal();
});

function isSupportedImage(file) {
  if (!file || typeof file.size !== 'number' || file.size <= 0) return false;

  const mime = String(file.type || '').toLowerCase();

  if (IMAGE_MIME_TYPES.has(mime)) return true;

  // Расширение используем только если браузер не определил MIME.
  return (!mime || mime === 'application/octet-stream') &&
    IMAGE_EXTENSIONS.test(String(file.name || ''));
}

function normalizeImageFile(file, fallbackName = 'image.png') {
  if (!file) return null;

  const extension = String(file.name || fallbackName)
    .toLowerCase()
    .match(/\.(jpe?g|png|webp|gif)$/)?.[1] || 'png';

  const inferred = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  }[extension];

  const type = String(file.type || '').toLowerCase();

  const mime = !type || type === 'application/octet-stream'
    ? inferred
    : type === 'image/jpg'
      ? 'image/jpeg'
      : type;

  if (typeof File === 'function' && mime !== type) {
    try {
      return new File([file], file.name || fallbackName, {
        type: mime,
        lastModified: file.lastModified || Date.now(),
      });
    } catch (_) {}
  }

  return file;
}

on('avatar-input', 'change', event => {
  const input = event.target;
  const file = input.files?.[0];

  input.value = '';

  if (!file || !state.me || profileSaveOperation) return;

  if (!isSupportedImage(file)) {
    showTransientNotice('Разрешены только JPG, PNG, WEBP или GIF');
    return;
  }

  if (file.size > MAX_AVATAR_SIZE) {
    showTransientNotice(
      `Файл слишком большой: максимум ${Math.round(MAX_AVATAR_SIZE / 1024 / 1024)} МБ`,
    );
    return;
  }

  let preview;

  try {
    preview = URL.createObjectURL(file);
  } catch (_) {
    showTransientNotice('Не удалось открыть изображение');
    return;
  }

  releaseAvatarPreview();

  pendingAvatar.file = file;
  pendingAvatar.previewUrl = preview;

  renderAv($('edit-avatar'), state.me.nickname, preview);
  syncAvatarPendingUi();
});

on('btn-avatar-remove', 'click', () => {
  if (!state.me || profileSaveOperation) return;

  releaseAvatarPreview();
  pendingAvatar.remove = true;

  renderAv($('edit-avatar'), state.me.nickname, null);
  syncAvatarPendingUi();
});

on('btn-avatar-reset', 'click', () => {
  if (profileSaveOperation) return;

  if (discardPendingAvatar()) {
    showTransientNotice('Изменения аватара отменены');
  }
});

async function uploadPendingAvatar(file = pendingAvatar.file) {
  if (!isSupportedImage(file)) throw new Error('Выберите изображение');
  if (file.size > MAX_AVATAR_SIZE) throw new Error('Изображение слишком большое');

  const normalized = normalizeImageFile(file, 'avatar.png');
  const form = new FormData();

  form.append('avatar', normalized, normalized.name || 'avatar.png');

  const response = await authFetch(`${BACKEND_URL}/api/upload/avatar`, {
    method: 'POST',
    body: form,
  });

  const data = await safeJson(response);

  if (!response.ok) {
    throw new Error(uiErrorText(data, 'Не удалось загрузить аватар'));
  }

  if (!uiUploadUrl(data?.avatar)) {
    throw new Error('Сервер вернул некорректный адрес аватара');
  }

  return data.avatar;
}

async function uiSaveProfile() {
  if (!state.me || profileSaveOperation) return;

  const nickname = ($('edit-nick')?.value || '').trim();
  const status = ($('edit-status')?.value || '').trim();
  const bio = ($('edit-bio')?.value || '').trim();

  if (!nickname) {
    showTransientNotice('Никнейм не может быть пустым');
    return;
  }

  const snapshot = uiSnapshot();
  const operation = {
    modalSequence: editProfileSequence,
    file: pendingAvatar.file,
    removeAvatar: pendingAvatar.remove,
  };

  profileSaveOperation = operation;
  uiSetProfileSaving(true);

  try {
    let uploadedAvatar = null;

    if (operation.file) {
      uploadedAvatar = await uploadPendingAvatar(operation.file);
      if (!uiCurrent(snapshot)) return;
    }

    const payload = { nickname, status, bio };

    if (operation.removeAvatar) payload.avatar = null;
    else if (uploadedAvatar) payload.avatar = uploadedAvatar;

    const response = await authFetch(`${BACKEND_URL}/api/profile/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await safeJson(response);
    if (!uiCurrent(snapshot)) return;

    if (!response.ok) {
      throw new Error(uiErrorText(data, 'Ошибка сохранения'));
    }

    const user = uiRecord(data?.user) ? data.user : {};

    if (user.id != null && String(user.id) !== String(state.me.id)) {
      throw new Error('Сервер вернул профиль другого пользователя');
    }

    state.me.nickname = typeof user.nickname === 'string' ? user.nickname : nickname;
    state.me.status = typeof user.status === 'string' ? user.status : status;
    state.me.bio = typeof user.bio === 'string' ? user.bio : bio;

    if (Object.prototype.hasOwnProperty.call(user, 'avatar')) {
      state.me.avatar = typeof user.avatar === 'string' ? user.avatar : null;
    } else if (operation.removeAvatar) {
      state.me.avatar = null;
    } else if (uploadedAvatar) {
      state.me.avatar = uploadedAvatar;
    }

    storage.setItem('chatapp_profile', JSON.stringify(state.me));

    setText('my-nick', state.me.nickname);
    renderAv($('my-avatar'), state.me.nickname, state.me.avatar);

    if (operation.modalSequence === editProfileSequence) {
      closeEditProfileModal();
    }

    if (typeof renderCallGrid === 'function') renderCallGrid();

    showTransientNotice('Профиль сохранён');
  } catch (error) {
    if (uiCurrent(snapshot) && !uiSilentError(error)) {
      showTransientNotice(error.message || 'Ошибка сети');
    }
  } finally {
    if (profileSaveOperation === operation) {
      profileSaveOperation = null;
      uiSetProfileSaving(false);
    }
  }
}

on('btn-save-profile', 'click', () => uiRun(uiSaveProfile));

/* ============================================================================
 * BLOCKED USERS
 * ========================================================================== */

on('btn-open-blocked', 'click', () => {
  closeEditProfileModal();
  uiRun(openBlockedUsersModal);
});

async function openBlockedUsersModal() {
  uiEnsureSession();
  if (!state.me) return;

  const snapshot = uiSnapshot();
  const sequence = ++blockedLoadSequence;

  blockedLoadController?.abort();
  const controller = new AbortController();
  blockedLoadController = controller;

  setDisplay('blocked-users-modal', 'flex');

  const list = $('blocked-users-list');
  if (!list) return;

  list.replaceChildren(uiNode('div', 'blocked-users-empty', 'Загрузка…'));

  try {
    const response = await authFetch(`${BACKEND_URL}/api/users/blocked`, {
      signal: controller.signal,
    });

    if (!response.ok) throw new Error('Ошибка загрузки');

    const users = await response.json();

    if (!uiCurrent(snapshot) || sequence !== blockedLoadSequence) return;
    if (!Array.isArray(users)) throw new Error('Некорректный список пользователей');

    blockedUsersCache = users.filter(user => uiRecord(user) && uiId(user.id));
    state.me.blockedUsers = uiIds(blockedUsersCache.map(user => user.id));

    renderBlockedUsersList(blockedUsersCache);
  } catch (error) {
    if (
      uiCurrent(snapshot) &&
      sequence === blockedLoadSequence &&
      !uiSilentError(error)
    ) {
      const message = uiNode('div', 'blocked-users-empty', 'Ошибка загрузки');
      message.style.color = 'var(--red)';
      list.replaceChildren(message);
    }
  } finally {
    if (blockedLoadController === controller) blockedLoadController = null;
  }
}

function closeBlockedUsersModal() {
  blockedLoadSequence++;
  blockedLoadController?.abort();
  blockedLoadController = null;

  setDisplay('blocked-users-modal', 'none');
}

on('blocked-users-modal', 'click', event => {
  if (event.target === $('blocked-users-modal')) closeBlockedUsersModal();
});

function renderBlockedUsersList(users) {
  const list = $('blocked-users-list');
  if (!list) return;

  list.replaceChildren();

  const valid = Array.isArray(users)
    ? users.filter(user => uiRecord(user) && uiId(user.id))
    : [];

  if (!valid.length) {
    list.appendChild(
      uiNode('div', 'blocked-users-empty', 'Нет заблокированных пользователей'),
    );
    return;
  }

  for (const user of valid) {
    const id = uiId(user.id);
    const item = uiNode('div', 'blocked-user-item');
    item.dataset.uid = id;

    const avatar = uiNode('div', 'f-av');
    const info = uiNode('div', 'f-info');
    const button = uiNode('button', 'btn-unblock', 'Разблокировать');

    button.type = 'button';

    info.append(
      uiNode('div', 'blocked-user-nick', user.nickname || id),
      uiNode('div', 'blocked-user-id', `@${id}`),
    );

    renderAv(avatar, user.nickname || id, user.avatar);
    item.append(avatar, info, button);

    button.addEventListener('click', () => {
      if (button.disabled) return;

      const snapshot = uiSnapshot();
      const sequence = blockedLoadSequence;

      button.disabled = true;

      uiRun(async () => {
        try {
          const success = await uiChangeBlocked(id, false);

          if (
            success &&
            uiCurrent(snapshot) &&
            sequence === blockedLoadSequence
          ) {
            renderBlockedUsersList(blockedUsersCache);
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    });

    list.appendChild(item);
  }
}

/* ============================================================================
 * SHARED PICKER
 * ========================================================================== */

function renderPicker({
  pickerId,
  countId,
  ids,
  selected,
  emptyText,
  onChange,
}) {
  const picker = $(pickerId);
  if (!picker || !(selected instanceof Set)) return;

  const available = uiIds(ids).filter(id => !!state.friends[id]);
  const allowed = new Set(available);

  for (const id of [...selected]) {
    if (!allowed.has(id)) selected.delete(id);
  }

  setText(countId, `выбрано: ${selected.size}`);
  picker.replaceChildren();

  if (!available.length) {
    const empty = uiNode('div', 'empty-state');
    empty.style.padding = '16px';
    empty.appendChild(uiNode('div', 'empty-sub', emptyText));
    picker.appendChild(empty);
    return;
  }

  available.sort((a, b) => {
    const aOnline = !!state.friends[a]?.online;
    const bOnline = !!state.friends[b]?.online;

    if (aOnline !== bOnline) return aOnline ? -1 : 1;

    return String(state.friends[a]?.nickname || a)
      .localeCompare(String(state.friends[b]?.nickname || b), 'ru');
  });

  for (const id of available) {
    const friend = state.friends[id];
    const item = uiNode(
      'div',
      `picker-item${selected.has(id) ? ' selected' : ''}`,
    );

    item.setAttribute('role', 'checkbox');
    item.setAttribute('aria-checked', String(selected.has(id)));
    item.tabIndex = 0;

    const avatar = uiNode('div', 'f-av');
    const info = uiNode('div');
    info.style.flex = '1';
    info.style.minWidth = '0';

    info.append(
      uiNode('div', 'f-nick', friend.nickname || id),
      uiNode('div', 'f-stat', `@${id}`),
    );

    const check = uiNode('div', 'picker-check', selected.has(id) ? '✓' : '');

    renderAvWithDot(avatar, friend.nickname, friend.avatar, friend.online);
    item.append(avatar, info, check);

    const toggle = () => {
      if (!state.friends[id]) return;

      if (selected.has(id)) selected.delete(id);
      else selected.add(id);

      const checked = selected.has(id);

      setText(countId, `выбрано: ${selected.size}`);
      item.classList.toggle('selected', checked);
      item.setAttribute('aria-checked', String(checked));
      check.textContent = checked ? '✓' : '';

      if (typeof onChange === 'function') onChange();
    };

    item.addEventListener('click', toggle);

    item.addEventListener('keydown', event => {
      if (event.repeat || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      toggle();
    });

    picker.appendChild(item);
  }
}

/* ============================================================================
 * CREATE GROUP
 * ========================================================================== */

on('btn-create-group', 'click', () => {
  uiEnsureSession();
  if (!state.me) return;

  if (createGroupOperation) {
    showTransientNotice('Группа уже создаётся');
    return;
  }

  createGroupSequence++;
  selectedGroupMembers = new Set();

  const nameInput = $('group-name-input');
  if (nameInput) nameInput.value = '';

  renderGroupFriendsPicker();
  setDisplay('create-group-modal', 'flex');
  nameInput?.focus();
});

function closeCreateGroupModal() {
  createGroupSequence++;
  setDisplay('create-group-modal', 'none');
}

on('create-group-modal', 'click', event => {
  if (event.target === $('create-group-modal')) closeCreateGroupModal();
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

on('group-name-input', 'keydown', event => {
  if (event.key === 'Enter' && !event.isComposing && !event.repeat) {
    event.preventDefault();
    $('btn-confirm-create-group')?.click();
  }
});

async function uiCreateGroup() {
  if (!state.me || createGroupOperation) return;

  const name = ($('group-name-input')?.value || '').trim();
  const memberIds = [...selectedGroupMembers].filter(id => state.friends[id]);

  if (name.length < 2) {
    showTransientNotice('Название минимум 2 символа');
    return;
  }

  if (!memberIds.length) {
    showTransientNotice('Выберите хотя бы одного друга');
    return;
  }

  const snapshot = uiSnapshot();
  const operation = {
    sequence: createGroupSequence,
    chatSequence: state.seq.chat,
    groupChatSequence: state.seq.groupChat,
  };

  createGroupOperation = operation;

  const button = $('btn-confirm-create-group');
  const originalText = button?.textContent;

  if (button) {
    button.disabled = true;
    button.textContent = 'Создание…';
    button.setAttribute('aria-busy', 'true');
  }

  try {
    const response = await authFetch(`${BACKEND_URL}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, memberIds }),
    });

    const data = await safeJson(response);
    if (!uiCurrent(snapshot)) return;

    if (!response.ok) {
      throw new Error(uiErrorText(data, 'Ошибка создания группы'));
    }

    const group = data?.group;
    const id = uiId(group?.id);

    if (uiRecord(group) && id) {
      state.groups[id] = { ...group, id, members: uiMembers(group) };
      state.groupLastActivity[id] = Date.now();
      renderGroupsList();
    } else {
      await loadGroups();
    }

    if (!uiCurrent(snapshot)) return;

    const modalUnchanged = operation.sequence === createGroupSequence;
    const chatUnchanged =
      operation.chatSequence === state.seq.chat &&
      operation.groupChatSequence === state.seq.groupChat;

    if (modalUnchanged) closeCreateGroupModal();

    if (modalUnchanged && chatUnchanged && id && state.groups[id]) {
      switchSidebarTab('groups');
      await openGroupChat(id);
    } else {
      showTransientNotice('Группа создана');
    }
  } catch (error) {
    if (uiCurrent(snapshot) && !uiSilentError(error)) {
      showTransientNotice(error.message || 'Ошибка сети');
    }
  } finally {
    if (createGroupOperation === operation) {
      createGroupOperation = null;

      if (button) {
        button.disabled = false;
        button.textContent = originalText || 'Создать';
        button.removeAttribute('aria-busy');
      }
    }
  }
}

on('btn-confirm-create-group', 'click', () => uiRun(uiCreateGroup));

/* ============================================================================
 * GROUP INFO / MEMBERS
 * ========================================================================== */

function openGroupInfoModal(value) {
  const groupId = uiId(value);
  const group = state.groups[groupId];

  if (!state.me || !group) return;

  state.infoGroupId = groupId;

  renderGroupAv($('group-info-avatar'), group);
  setText('group-info-name', group.name || groupId);

  const created = fmtDate(group.createdAt);
  setText('group-info-created', created ? `Создана ${created}` : '');

  const isOwner = isGroupOwner(group, state.me.id);
  setDisplay('group-info-owner-actions', isOwner ? '' : 'none');

  const leave = $('btn-leave-group');
  if (leave) leave.textContent = isOwner ? 'Удалить группу' : 'Покинуть группу';

  renderGroupInfoMembers(group);
  setDisplay('group-info-modal', 'flex');
}

function renderGroupInfoMembers(group) {
  const list = $('group-info-members');
  if (!list) return;

  const members = uiMembers(group);
  const myId = String(state.me?.id || '');
  const owner = isGroupOwner(group, myId);

  setText('group-info-count', members.length);
  list.replaceChildren();

  members.sort((a, b) => {
    const aOwner = isGroupOwner(group, a.id);
    const bOwner = isGroupOwner(group, b.id);

    if (aOwner !== bOwner) return aOwner ? -1 : 1;
    if (!!a.online !== !!b.online) return a.online ? -1 : 1;

    return String(a.nickname || a.id).localeCompare(String(b.nickname || b.id), 'ru');
  });

  for (const member of members) {
    const memberId = uiId(member.id);
    const memberOwner = isGroupOwner(group, memberId);
    const item = uiNode('div', 'group-member-item');

    const avatar = uiNode('div', 'f-av');
    const info = uiNode('div');

    info.style.flex = '1';
    info.style.minWidth = '0';

    const nickname = uiNode('div', 'f-nick', member.nickname || memberId);

    if (memberId === myId) {
      nickname.appendChild(uiNode('span', 'f-stat', ' (вы)'));
    }

    if (memberOwner) {
      const badge = uiNode('span', 'owner-badge', ' 👑');
      badge.title = 'Владелец';
      nickname.appendChild(badge);
    }

    info.append(
      nickname,
      uiNode(
        'div',
        'f-stat',
        `@${memberId} · ${member.online ? 'В сети' : 'Не в сети'}`,
      ),
    );

    renderAvWithDot(avatar, member.nickname, member.avatar, member.online);
    item.append(avatar, info);

    if (memberId !== myId && owner && !memberOwner) {
      const kick = uiNode('button', 'btn-kick', '✕');
      kick.type = 'button';
      kick.title = 'Удалить из группы';
      kick.setAttribute('aria-label', `Удалить ${member.nickname || memberId}`);

      kick.addEventListener('click', event => {
        event.stopPropagation();

        if (!socket.connected) {
          showTransientNotice('Нет соединения с сервером');
          return;
        }

        const currentGroup = state.groups[group.id];

        if (!currentGroup || !isGroupOwner(currentGroup, state.me?.id)) return;
        if (!confirm(`Удалить ${member.nickname || memberId} из группы?`)) return;

        socket.emit('kickGroupMember', {
          groupId: group.id,
          userId: memberId,
        });
      });

      item.appendChild(kick);
    }

    if (memberId !== myId) {
      info.style.cursor = 'pointer';

      uiActivate(info, () => {
        closeGroupInfoModal();
        return showUserProfile(memberId);
      });
    }

    list.appendChild(item);
  }
}

function closeGroupInfoModal() {
  state.infoGroupId = null;
  setDisplay('group-info-modal', 'none');
}

on('group-info-modal', 'click', event => {
  if (event.target === $('group-info-modal')) closeGroupInfoModal();
});

on('btn-leave-group', 'click', () => {
  const groupId = state.infoGroupId || state.activeGroup;
  const group = state.groups[groupId];

  if (!state.me || !group) return;

  if (!socket.connected) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  const message = isGroupOwner(group, state.me.id)
    ? 'Вы владелец. Группа будет удалена для всех участников. Продолжить?'
    : 'Покинуть группу?';

  if (!confirm(message)) return;

  socket.emit('leaveGroup', groupId);
  closeGroupInfoModal();
});

/* ============================================================================
 * ADD MEMBERS
 * ========================================================================== */

function openAddMembersModal(value) {
  const explicit = typeof value === 'string' ? value : null;
  const groupId = explicit || state.infoGroupId || state.activeGroup;
  const group = state.groups[groupId];
  const modal = $('add-members-modal');

  if (!state.me || !group || !modal) return;
  if (!isGroupOwner(group, state.me.id)) return;

  addMembersSequence++;
  selectedAddMembers = new Set();

  modal.dataset.gid = groupId;

  renderAddMembersPicker(groupId);
  setDisplay('add-members-modal', 'flex');
}

on('btn-add-members', 'click', () => {
  const groupId = state.infoGroupId;
  closeGroupInfoModal();

  if (groupId) openAddMembersModal(groupId);
});

on('btn-invite-group', 'click', () => openAddMembersModal());

function closeAddMembersModal() {
  addMembersSequence++;
  setDisplay('add-members-modal', 'none');

  const modal = $('add-members-modal');
  if (modal) delete modal.dataset.gid;

  selectedAddMembers.clear();
}

on('add-members-modal', 'click', event => {
  if (event.target === $('add-members-modal')) closeAddMembersModal();
});

function renderAddMembersPicker(groupId) {
  const group = state.groups[groupId];
  if (!group) return;

  const existing = new Set(uiMembers(group).map(member => uiId(member.id)));

  renderPicker({
    pickerId: 'add-members-picker',
    countId: 'add-members-count',
    ids: Object.keys(state.friends).filter(id => !existing.has(id)),
    selected: selectedAddMembers,
    emptyText: 'Все друзья уже в группе',
  });
}

on('btn-confirm-add-members', 'click', () => {
  const groupId = $('add-members-modal')?.dataset.gid;
  const group = state.groups[groupId];

  if (!state.me || !group || !isGroupOwner(group, state.me.id)) return;

  if (!socket.connected) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  const existing = new Set(uiMembers(group).map(member => uiId(member.id)));
  const ids = [...selectedAddMembers]
    .filter(id => state.friends[id] && !existing.has(id));

  if (!ids.length) return;

  for (const userId of ids) {
    socket.emit('addGroupMember', { groupId, userId });
  }

  closeAddMembersModal();

  // emit без ACK не является подтверждением успешного добавления.
  showTransientNotice('Запросы на добавление отправлены');
});

/* ============================================================================
 * RIGHT MEMBERS PANEL
 * ========================================================================== */

function renderGroupMembersPanel(group) {
  const list = $('group-members-list');
  if (!list) return;

  list.replaceChildren();

  if (!group) {
    setText('gm-count', '0');
    setDisplay('btn-invite-group', 'none');
    return;
  }

  const members = uiMembers(group);
  setText('gm-count', members.length);

  const byName = (a, b) => {
    const aOwner = isGroupOwner(group, a.id);
    const bOwner = isGroupOwner(group, b.id);

    if (aOwner !== bOwner) return aOwner ? -1 : 1;

    return String(a.nickname || a.id)
      .localeCompare(String(b.nickname || b.id), 'ru');
  };

  const addSection = (label, sectionMembers) => {
    if (!sectionMembers.length) return;

    list.appendChild(
      uiNode('div', 'gm-section', `${label} — ${sectionMembers.length}`),
    );

    for (const member of sectionMembers) {
      const id = uiId(member.id);
      const item = uiNode('div', `gm-item${member.online ? '' : ' offline'}`);
      item.title = `@${id}`;

      const avatar = uiNode('div', 'gm-av');

      renderAvWithDot(avatar, member.nickname, member.avatar, member.online);

      item.append(
        avatar,
        uiNode('div', 'gm-name', member.nickname || id),
      );

      if (isGroupOwner(group, id)) {
        const crown = uiNode('span');
        crown.innerHTML = CROWN_SVG;
        item.append(...crown.childNodes);
      }

      uiActivate(item, () => id === String(state.me?.id)
        ? openEditProfileModal()
        : showUserProfile(id));

      list.appendChild(item);
    }
  };

  addSection('В сети', members.filter(member => member.online).sort(byName));
  addSection('Не в сети', members.filter(member => !member.online).sort(byName));

  setDisplay(
    'btn-invite-group',
    isGroupOwner(group, state.me?.id) ? '' : 'none',
  );
}

on('btn-toggle-members', 'click', () => {
  $('group-members-panel')?.classList.toggle('hidden');
  uiSyncOverlay();
});

/* ============================================================================
 * MOBILE / KEYBOARD / CONNECTION
 * ========================================================================== */

function goBackMobile() {
  saveComposerDraft();

  const previousFriend = state.activeFriend;
  const previousGroup = state.activeGroup;

  state.seq.chat++;
  state.seq.groupChat++;

  uiCancelHistory($('messages'));
  uiCancelHistory($('group-messages'));

  closeActiveChat();

  document.querySelector('.sidebar')?.classList.remove('hidden');
  document.querySelector('.chat-main')?.classList.add('hidden');

  if (previousFriend) refreshFriendItem(previousFriend);
  if (previousGroup) refreshGroupItem(previousGroup);

  uiSyncOverlay();
}

on('btn-back', 'click', goBackMobile);
on('btn-back-group', 'click', goBackMobile);

window.addEventListener('resize', () => {
  uiSyncOverlay();

  if (window.innerWidth > 640) {
    document.querySelector('.sidebar')?.classList.remove('hidden');
    document.querySelector('.chat-main')?.classList.remove('hidden');
  }

  if (state.activeFriend) refreshComposer(false);
  if (state.activeGroup) refreshComposer(true);
});

function uiCloseVisibleModals() {
  closeProfileModal();
  closeEditProfileModal();
  closeBlockedUsersModal();
  closeDeleteConfirm();
  closeCreateGroupModal();
  closeGroupInfoModal();
  closeAddMembersModal();
  closeAllModals();
}

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing) return;

  const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';

  if (key === 'escape') {
    // Входящий звонок обрабатывает calls.js.
    if (callState.pendingIncoming) return;

    if (isAnyModalOpen() || $('delete-confirm')?.style.display === 'flex') {
      event.preventDefault();
      uiCloseVisibleModals();
      return;
    }

    if (typeof closeDrop === 'function') closeDrop(false);

    if (state.activeFriend) scrollMsgs('messages');
    if (state.activeGroup) scrollMsgs('group-messages');
  }

  if ((event.ctrlKey || event.metaKey) && key === 'k') {
    event.preventDefault();
    if (!isAnyModalOpen()) openQuickSearch();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me) return;

  uiEnsureSession();

  if (state.activeFriend) uiMarkRead(false, state.activeFriend);
  if (state.activeGroup) uiMarkRead(true, state.activeGroup);
});

socket.on('connect_error', error => {
  if (!state.me || state.loggingOut) return;

  console.warn('[socket] connection error', error);

  /*
   * Не выходим из аккаунта только по строке ошибки сокета:
   * она может относиться к предыдущему handshake.
   * Текущую сессию проверяет авторизованный HTTP-запрос.
   */
  if (
    error?.message === 'Unauthorized' ||
    error?.data?.code === 'UNAUTHORIZED'
  ) {
    uiRun(async () => {
      try {
        await authFetch(`${BACKEND_URL}/api/me`, {
          timeoutMs: 10000,
          cache: 'no-store',
        });
      } catch (requestError) {
        if (!uiSilentError(requestError)) {
          setConnBanner(true, 'Не удалось проверить сессию — повторная попытка…');
        }
      }
    });

    return;
  }

  setConnBanner(true, 'Нет соединения с сервером — повторная попытка…');
});

socket.on('connect', () => {
  if (!state.me) return;

  setConnBanner(false);
  renderGroupsList();
  updateGroupVoiceBar();
  window.updateDmVoiceBar?.();

  refreshComposer(false);
  refreshComposer(true);
});

socket.on('disconnect', reason => {
  if (reason === 'io client disconnect' || !state.me || state.loggingOut) return;

  setConnBanner(true, 'Соединение потеряно — переподключение…');
  renderGroupsList();
  updateGroupVoiceBar();

  refreshComposer(false);
  refreshComposer(true);

  // WebRTC и таймер восстановления принадлежат calls.js.
});

/* ============================================================================
 * COMPOSER / ATTACHMENTS
 * ========================================================================== */

function composerKey(group) {
  const target = group ? state.activeGroup : state.activeFriend;
  return target ? `${group ? 'group' : 'dm'}:${target}` : null;
}

function attachmentKey(group) {
  return composerKey(group);
}

function fileToken(file) {
  return file
    ? `${file.name}:${file.size}:${file.lastModified}:${file.type}`
    : '';
}

function saveComposerDraft() {
  uiEnsureSession();

  if (state.activeFriend) {
    composerDrafts.set(
      `dm:${state.activeFriend}`,
      $('msg-input')?.value || '',
    );
  }

  if (state.activeGroup) {
    composerDrafts.set(
      `group:${state.activeGroup}`,
      $('group-msg-input')?.value || '',
    );
  }
}

function renderAttachmentPreview(group) {
  const key = attachmentKey(group);
  const box = $(group ? 'group-attach-preview' : 'msg-attach-preview');

  if (!box) return;

  box.replaceChildren();

  const file = key ? composerAttachments.get(key) : null;
  const attempt = key ? retryMessages.get(key) : null;

  // Загруженная картинка принадлежит конкретной попытке, не всем сообщениям.
  const uploaded = !file && attempt?.imageUrl && !attempt?.file;

  if (!file && !uploaded) {
    box.classList.remove('show');
    return;
  }

  box.classList.add('show');

  const label = uiNode(
    'span',
    'attach-preview-label',
    file ? `Изображение: ${file.name || 'image'}` : 'Изображение готово к отправке',
  );

  const remove = uiNode('button', 'attach-preview-remove', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Убрать изображение');

  /*
   * Удаление/замена вложения во время неопределённого результата отправки
   * создаёт неоднозначность повтора. До завершения попытки блокируем это.
   */
  remove.disabled = !!attempt?.inFlight;

  remove.addEventListener('click', () => {
    if (!key || retryMessages.get(key)?.inFlight) return;

    composerAttachments.delete(key);
    retryMessages.delete(key);
    refreshComposer(group);
  });

  box.append(label, remove);
}

function setComposerAttachment(group, file) {
  uiEnsureSession();

  const key = attachmentKey(group);

  if (!key || !state.me) return false;

  if (retryMessages.get(key)?.inFlight) {
    showTransientNotice('Дождитесь завершения отправки');
    return false;
  }

  if (!isSupportedImage(file)) {
    showTransientNotice('Можно отправлять JPG, PNG, WEBP или GIF');
    return false;
  }

  if (file.size > MAX_AVATAR_SIZE) {
    showTransientNotice(
      `Изображение слишком большое: максимум ${Math.round(MAX_AVATAR_SIZE / 1024 / 1024)} МБ`,
    );
    return false;
  }

  composerAttachments.set(key, normalizeImageFile(file));

  // Новое вложение — новая отправка, старый imageUrl не переиспользуем.
  retryMessages.delete(key);

  refreshComposer(group);
  return true;
}

async function uploadChatImage(file) {
  if (!isSupportedImage(file)) throw new Error('Некорректное изображение');
  if (file.size > MAX_AVATAR_SIZE) throw new Error('Изображение слишком большое');

  const normalized = normalizeImageFile(file);
  const form = new FormData();

  form.append('image', normalized, normalized.name || 'image.png');

  const response = await authFetch(`${BACKEND_URL}/api/upload/image`, {
    method: 'POST',
    body: form,
  });

  const data = await safeJson(response);

  if (!response.ok || !uiUploadUrl(data?.url)) {
    const error = new Error(uiErrorText(data, 'Не удалось загрузить изображение'));
    error.reason = response.status === 413 ? 'image_too_large' : data?.reason;
    throw error;
  }

  return data.url;
}

for (const group of [false, true]) {
  const inputId = group ? 'group-image-input' : 'msg-image-input';
  const buttonId = group ? 'btn-group-attach-image' : 'btn-attach-image';

  on(buttonId, 'click', () => {
    if (!retryMessages.get(composerKey(group))?.inFlight) $(inputId)?.click();
  });

  on(inputId, 'change', event => {
    const input = event.target;
    const file = input.files?.[0];

    input.value = '';
    if (file) setComposerAttachment(group, file);
  });

  on(group ? 'group-msg-input' : 'msg-input', 'input', () => {
    uiEnsureSession();

    const key = composerKey(group);
    const input = $(group ? 'group-msg-input' : 'msg-input');

    if (key && input) composerDrafts.set(key, input.value);
    refreshComposer(group);
  });
}

function pastedImage(event) {
  for (const item of [...(event.clipboardData?.items || [])]) {
    if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }

  return [...(event.clipboardData?.files || [])].find(isSupportedImage) || null;
}

document.addEventListener('paste', event => {
  if (event.defaultPrevented || isAnyModalOpen()) return;
  if (!(event.target instanceof Element)) return;

  const target = event.target;
  const group = target.id === 'group-msg-input';
  const dm = target.id === 'msg-input';

  if (!group && !dm) return;

  const file = pastedImage(event);
  if (!file) return;

  event.preventDefault();

  if (setComposerAttachment(group, file)) {
    showTransientNotice('Изображение добавлено к сообщению');
  }
});

function refreshComposer(group) {
  uiEnsureSession();

  const key = composerKey(group);
  const input = $(group ? 'group-msg-input' : 'msg-input');
  const button = $(group ? 'btn-group-send' : 'btn-send');
  const attachmentButton = $(group ? 'btn-group-attach-image' : 'btn-attach-image');

  const busy = !!retryMessages.get(key)?.inFlight;

  if (input) {
    delete input.dataset.sending;
    input.style.height = 'auto';

    const maxHeight = Math.max(54, Math.min(216, window.innerHeight * 0.30));

    input.style.height = `${Math.max(54, Math.min(input.scrollHeight, maxHeight))}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  renderAttachmentPreview(group);

  if (button) {
    button.disabled = busy || !state.me || !key || !socket.connected;
    button.setAttribute('aria-busy', String(busy));
  }

  if (attachmentButton) {
    attachmentButton.disabled = busy || !state.me || !key;
  }
}

function uiSendError(error) {
  if (error?.reason === 'image_too_large') {
    return 'Изображение слишком большое';
  }

  try {
    if (
      typeof SEND_MESSAGE_ERRORS !== 'undefined' &&
      Object.prototype.hasOwnProperty.call(SEND_MESSAGE_ERRORS, error?.reason)
    ) {
      return SEND_MESSAGE_ERRORS[error.reason];
    }
  } catch (_) {}

  return error?.message || 'Не удалось отправить сообщение';
}

async function sendComposer(group) {
  uiEnsureSession();

  const input = $(group ? 'group-msg-input' : 'msg-input');
  const target = group ? state.activeGroup : state.activeFriend;

  if (!input || !target || !state.me) return;

  const key = `${group ? 'group' : 'dm'}:${target}`;

  if (retryMessages.get(key)?.inFlight) return;

  const snapshot = uiSnapshot();
  const raw = input.value;
  const text = raw.trim();
  const file = composerAttachments.get(key) || null;

  let attempt = retryMessages.get(key);

  const reusable =
    !!attempt &&
    attempt.text === text &&
    attempt.file === file;

  if (!text && !file && !(reusable && attempt.imageUrl)) return;

  if (text.length > MAX_MESSAGE_LENGTH) {
    showTransientNotice(`Сообщение не должно превышать ${MAX_MESSAGE_LENGTH} символов`);
    return;
  }

  composerDrafts.set(key, raw);

  if (!socket.connected) {
    showTransientNotice('Нет соединения. Сообщение сохранено в поле ввода');
    return;
  }

  if (!reusable) {
    attempt = {
      text,
      file,
      fileToken: fileToken(file),
      clientId: uiClientId(),
      imageUrl: null,
      inFlight: false,
    };

    retryMessages.set(key, attempt);
  }

  attempt.inFlight = true;
  refreshComposer(group);

  const ownsAttempt = () =>
    uiCurrent(snapshot) &&
    retryMessages.get(key) === attempt;

  try {
    if (!attempt.imageUrl && file) {
      const imageUrl = await uploadChatImage(file);

      if (!ownsAttempt()) return;
      attempt.imageUrl = imageUrl;
    }

    if (!ownsAttempt()) return;

    await socketRequest(group ? 'groupMessage' : 'sendMessage', {
      ...(group ? { groupId: target } : { toId: target }),
      text: attempt.text,
      image: attempt.imageUrl || null,
      clientId: attempt.clientId,
    });

    if (!ownsAttempt()) return;

    retryMessages.delete(key);

    // Не удаляем другой файл, если вложение изменилось внешним UI-кодом.
    if (composerAttachments.get(key) === file) {
      composerAttachments.delete(key);
    }

    if (composerDrafts.get(key) === raw) composerDrafts.delete(key);

    const currentTarget = group ? state.activeGroup : state.activeFriend;

    if (currentTarget === target && input.value === raw) {
      input.value = '';
    }
  } catch (error) {
    if (ownsAttempt() && !uiSilentError(error)) {
      showTransientNotice(uiSendError(error));
    }
  } finally {
    attempt.inFlight = false;

    if (uiCurrent(snapshot)) refreshComposer(group);
  }
}

/* ============================================================================
 * QUICK SEARCH / DISCLOSURE
 * ========================================================================== */

function openQuickSearch() {
  if (!state.me || isAnyModalOpen()) return;

  if (window.innerWidth <= 640 && (state.activeFriend || state.activeGroup)) {
    goBackMobile();
  }

  const input = $('search-input');
  input?.focus();
  input?.select();
}

on('btn-find-friend', 'click', openQuickSearch);
on('btn-empty-create-group', 'click', () => $('btn-create-group')?.click());

whenDomReady(() => {
  const panel = $('group-members-panel');

  if (panel && 'MutationObserver' in window) {
    const sync = () => {
      $('btn-toggle-members')?.setAttribute(
        'aria-expanded',
        String(!panel.classList.contains('hidden')),
      );
    };

    new MutationObserver(sync).observe(panel, {
      attributes: true,
      attributeFilter: ['class'],
    });

    sync();
  }

  /*
   * Закрытие через closeAllModals() из других файлов также должно
   * инвалидировать ожидающие ответы профиля/списка блокировок.
   */
  if ('MutationObserver' in window) {
    for (const [id, close] of [
      ['profile-modal', closeProfileModal],
      ['blocked-users-modal', closeBlockedUsersModal],
    ]) {
      const modal = $(id);
      if (!modal) continue;

      let wasOpen = modal.style.display !== 'none' &&
        getComputedStyle(modal).display !== 'none';

      new MutationObserver(() => {
        const isOpen = modal.style.display !== 'none' &&
          getComputedStyle(modal).display !== 'none';

        if (wasOpen && !isOpen) close();
        wasOpen = isOpen;
      }).observe(modal, {
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden'],
      });
    }
  }

  refreshComposer(false);
  refreshComposer(true);
});

/* ============================================================================
 * HISTORY: INITIAL LOAD
 * ========================================================================== */

function uiHistoryUrl(url, parameters) {
  const destination = new URL(url, BACKEND_URL);

  for (const [key, value] of Object.entries(parameters)) {
    if (value != null && value !== '') {
      destination.searchParams.set(key, String(value));
    }
  }

  return destination.href;
}

async function loadConversationHistory(
  box,
  url,
  welcome,
  render,
  seqKey,
  seq,
  unread,
) {
  if (!box || !state.me) return false;

  const snapshot = uiSnapshot();
  const conversationKey = box._conversationKey;

  uiCancelHistory(box);

  const operation = {
    controller: new AbortController(),
    cancelled: false,
  };

  box._historyOperation = operation;
  uiHistoryOperations.add(operation);

  // На retry сохраняем сообщения, пришедшие во время первой попытки.
  box._liveMessages ||= new Map();
  box._liveAnonymous ||= [];
  box._loadingHistory = true;
  box._historyReady = false;

  const stale = () =>
    operation.cancelled ||
    !uiCurrent(snapshot) ||
    state.seq[seqKey] !== seq ||
    box._conversationKey !== conversationKey ||
    box._historyOperation !== operation;

  try {
    const response = await authFetch(uiHistoryUrl(url, { limit: 50 }), {
      signal: operation.controller.signal,
    });

    if (!response.ok) throw new Error('Не удалось загрузить историю');

    const page = await response.json();

    if (stale()) return false;
    if (!Array.isArray(page)) throw new Error('Некорректная история');

    const validPage = uiUniqueMessages(page);
    const live = [...box._liveMessages.values(), ...box._liveAnonymous];
    const rows = uiUniqueMessages([...validPage, ...live]);

    /*
     * Обновляем удалённые сообщения из уже отрисованного realtime DOM,
     * чтобы история не вернула их старое содержимое.
     */
    const deletedIds = new Set(
      [...box.querySelectorAll('.g-msg.deleted[data-msgid]')]
        .map(element => element.dataset.msgid),
    );

    box._loadingHistory = false;

    resetMsgContainer(box);

    // При наличии предыдущих страниц приветствие пока не показываем.
    const mayHaveMore = page.length >= 50 && validPage.length > 0;

    box._historyWelcome = welcome;

    if (!mayHaveMore) renderChatWelcome(box, welcome);

    /*
     * unread обычно считает входящие сообщения. Отсчитываем от конца
     * только сообщения других отправителей, а не все строки.
     */
    let remaining = uiUnread(unread);
    let firstUnread = -1;

    for (let index = rows.length - 1; index >= 0 && remaining > 0; index--) {
      if (String(rows[index].from) !== String(state.me.id)) {
        firstUnread = index;
        remaining--;
      }
    }

    rows.forEach((message, index) => {
      if (index === firstUnread) appendNewMessagesDivider(box);

      render(deletedIds.has(uiMessageId(message))
        ? { ...message, deleted: true }
        : message);
    });

    box._liveMessages.clear();
    box._liveAnonymous = [];
    box._historyReady = true;

    if (mayHaveMore) {
      addHistoryPager(box, url, validPage[0], render, stale);
    }

    scrollMsgs(box.id);
    return true;
  } catch (error) {
    if (stale() || uiSilentError(error)) return false;

    box._loadingHistory = false;
    clearMsgsPlaceholder(box);

    box.querySelectorAll('.history-error').forEach(element => element.remove());

    const button = uiNode(
      'button',
      'history-more history-error',
      'История не загрузилась. Попробовать снова',
    );

    button.type = 'button';

    button.addEventListener('click', () => {
      if (stale() || button.disabled) return;

      button.disabled = true;
      button.remove();

      /*
       * Не очищаем DOM и realtime-буфер перед повторной попыткой.
       */
      uiRun(async () => {
        const loaded = await loadConversationHistory(
          box, url, welcome, render, seqKey, seq, unread,
        );

        if (
          loaded &&
          uiCurrent(snapshot) &&
          state.seq[seqKey] === seq &&
          document.visibilityState === 'visible'
        ) {
          const group = seqKey === 'groupChat';
          const target = group ? state.activeGroup : state.activeFriend;

          if (target) {
            if (group) {
              state.groupUnread[target] = 0;
              refreshGroupItem(target);
            } else {
              state.unread[target] = 0;
              refreshFriendItem(target);
            }

            updateTitleBadge();
            uiMarkRead(group, target);
          }
        }
      });
    });

    box.prepend(button);
    return false;
  } finally {
    if (stale()) uiHistoryOperations.delete(operation);

    /*
     * Успешная операция остаётся владельцем pager.
     * При смене чата uiCancelHistory удалит её из Set.
     */
  }
}

/* ============================================================================
 * HISTORY: PAGINATION
 * ========================================================================== */

function uiRestoreHistoryMetadata(box) {
  const messages = [...box.querySelectorAll('.g-msg[data-time]')];
  const last = messages.at(-1);

  if (last) box.dataset.lastDay = dayKey(Number(last.dataset.time));
  else delete box.dataset.lastDay;

  if (box.querySelector('.msg-divider.new')) {
    box.dataset.hasNewDivider = '1';
  } else {
    delete box.dataset.hasNewDivider;
  }
}

function uiRemoveDuplicateBoundaryDivider(box) {
  /*
   * Пагинация может создать два разделителя одной даты.
   * Удаляем только повторный разделитель дня, не "Новые сообщения".
   */
  let lastDay = null;

  for (const element of [...box.children]) {
    if (element.classList.contains('msg-divider') &&
        !element.classList.contains('new')) {
      const key = element.dataset.day;

      if (key && key === lastDay) {
        element.remove();
      } else if (key) {
        lastDay = key;
      }

      continue;
    }

    if (element.classList.contains('g-msg')) {
      const key = dayKey(Number(element.dataset.time));
      if (key) lastDay = key;
    }
  }
}

function addHistoryPager(box, url, first, render, stale) {
  if (!uiValidMessage(first)) return;

  let cursor = first;
  let controller = null;

  const button = uiNode(
    'button',
    'history-more',
    'Показать предыдущие сообщения',
  );

  button.type = 'button';

  box.querySelectorAll('.history-more').forEach(element => element.remove());
  box.prepend(button);

  button.addEventListener('click', () => {
    if (button.disabled || stale()) return;

    uiRun(async () => {
      button.disabled = true;
      button.textContent = 'Загружаем…';

      controller = new AbortController();

      const parentOperation = box._historyOperation;
      const abort = () => controller?.abort();

      parentOperation?.controller.signal.addEventListener('abort', abort, {
        once: true,
      });

      if (parentOperation?.controller.signal.aborted) controller.abort();

      try {
        const before = msgTimeRaw(cursor);
        const beforeId = uiMessageId(cursor);

        if (before == null || !beforeId) {
          throw new Error('У сообщения нет курсора пагинации');
        }

        const response = await authFetch(
          uiHistoryUrl(url, {
            limit: 50,
            before,
            beforeId,
          }),
          { signal: controller.signal },
        );

        if (!response.ok) throw new Error('Не удалось загрузить сообщения');

        const page = await response.json();

        if (stale() || !button.isConnected) return;
        if (!Array.isArray(page)) throw new Error('Некорректная история');

        const sorted = uiUniqueMessages(page);

        const existingIds = new Set(
          [...box.querySelectorAll('.g-msg[data-msgid]')]
            .map(element => element.dataset.msgid),
        );

        const fresh = sorted.filter(message => {
          const id = uiMessageId(message);
          return !id || !existingIds.has(id);
        });

        const nextCursor = sorted[0];
        const cursorAdvanced = nextCursor &&
          (
            uiMessageId(nextCursor) !== beforeId ||
            String(msgTimeRaw(nextCursor)) !== String(before)
          );

        const hasMore = page.length >= 50 && !!cursorAdvanced;

        /*
         * Сохраняем конкретный визуальный якорь: высота кнопки и
         * разделителей не влияет на позицию прочитанного сообщения.
         */
        const boxRect = box.getBoundingClientRect();

        const anchor = [...box.querySelectorAll('.g-msg')]
          .find(element => element.getBoundingClientRect().bottom > boxRect.top);

        const anchorTop = anchor?.getBoundingClientRect().top;
        const oldHeight = box.scrollHeight;
        const oldScrollTop = box.scrollTop;

        const tail = document.createDocumentFragment();

        button.remove();

        while (box.firstChild) tail.appendChild(box.firstChild);

        delete box.dataset.lastDay;
        delete box.dataset.hasNewDivider;

        /*
         * При исключении рендера старые сообщения обязательно возвращаются.
         */
        try {
          for (const message of fresh) render(message);
        } finally {
          box.appendChild(tail);
        }

        box.querySelectorAll('.chat-welcome').forEach(element => element.remove());

        if (hasMore) {
          cursor = nextCursor;
          box.prepend(button);
        } else {
          const welcomeFragment = document.createDocumentFragment();

          renderChatWelcome(
            welcomeFragment,
            box._historyWelcome || {},
          );

          box.prepend(welcomeFragment);
        }

        uiRemoveDuplicateBoundaryDivider(box);
        uiRestoreHistoryMetadata(box);

        if (anchor?.isConnected && Number.isFinite(anchorTop)) {
          box.scrollTop = oldScrollTop +
            anchor.getBoundingClientRect().top - anchorTop;
        } else {
          box.scrollTop = oldScrollTop + box.scrollHeight - oldHeight;
        }

        button.textContent = 'Показать предыдущие сообщения';
      } catch (error) {
        if (!stale() && !uiSilentError(error)) {
          button.textContent = 'Не загрузилось. Повторить';

          if (!button.isConnected) box.prepend(button);
          uiRestoreHistoryMetadata(box);
        }
      } finally {
        parentOperation?.controller.signal.removeEventListener('abort', abort);
        controller = null;
        button.disabled = false;
      }
    });
  });
}

/* ============================================================================
 * EXPORTS
 * ========================================================================== */

Object.assign(window, {
  loadGroups,
  renderGroupsList,
  refreshGroupItem,
  memberName,

  openChat,
  openGroupChat,
  updateGroupVoiceBar,
  updateGroupChatHeader,
  renderGroupMembersPanel,

  appendMsg,
  appendGroupMsg,
  appendChatMsg,
  appendSystemMsg,

  openDeleteConfirm,
  closeDeleteConfirm,
  deleteMessage,

  showUserProfile,
  closeProfileModal,
  performBlock,
  performUnblock,

  openEditProfileModal,
  closeEditProfileModal,
  discardPendingAvatar,

  openBlockedUsersModal,
  closeBlockedUsersModal,

  closeCreateGroupModal,
  openGroupInfoModal,
  closeGroupInfoModal,
  openAddMembersModal,
  closeAddMembersModal,

  saveComposerDraft,
  refreshComposer,
  sendComposer,
  sendMsg,
  sendGroupMsg,
  normalizeImageFile,

  openQuickSearch,
  goBackMobile,
  resetChatUiState,
});