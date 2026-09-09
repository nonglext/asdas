'use strict';

/* ============================================================================
 * CONSTANTS
 * ========================================================================== */

const ID_RE = /^[a-z0-9_]{3,30}$/;
const ID_MIN_LEN = 3;
const PW_MIN_LEN = 8;
const SLOW_SERVER_HINT_MS = 6000;
const NICK_FETCH_CONCURRENCY = 6;
const SIDEBAR_TAB_KEY = 'chatapp_tab';

const AUTH_ERRORS = Object.freeze({
  invalid_credentials: 'Неверный ID или пароль',
  wrong_password: 'Неверный ID или пароль',
  not_found: 'Пользователь не найден',
  user_exists: 'Этот ID уже занят',
  already_exists: 'Этот ID уже занят',
  invalid_id: 'ID: только a-z, 0-9, _; от 3 до 30 символов',
  weak_password: `Пароль минимум ${PW_MIN_LEN} символов`,
  rate_limited: 'Слишком много попыток, попробуйте позже',
  server_error: 'Ошибка сервера',
});

const FRIEND_REQUEST_ERRORS = Object.freeze({
  rate_limited: 'Слишком много заявок, попробуйте позже',
  not_found: 'Пользователь не найден',
  self: 'Нельзя добавить самого себя',
  already_friends: 'Вы уже друзья',
  already_sent: 'Заявка уже отправлена',
  blocked: 'Невозможно отправить заявку',
  limit_reached: 'Достигнут лимит заявок или друзей',
  target_limit_reached: 'У пользователя переполнен список заявок',
  server_error: 'Ошибка сервера. Попробуйте позже',
  incoming_request_exists: 'У вас уже есть входящая заявка от этого пользователя',
  no_request: 'Заявка уже обработана или отозвана',
  unauthorized: 'Сессия истекла. Войдите снова',
  busy: 'Сервер занят. Попробуйте ещё раз',
  bad_request: 'Некорректный запрос. Обновите страницу',
});

const SEND_MESSAGE_ERRORS = Object.freeze({
  image_too_large: 'Изображение слишком большое',
  text_too_long: 'Сообщение слишком длинное',
  not_friends: 'Вы не друзья с этим пользователем',
  blocked: 'Невозможно отправить сообщение',
  rate_limited: 'Слишком много сообщений, подождите',
  not_found: 'Получатель не найден',
  server_error: 'Не удалось отправить сообщение',
});

const GROUP_ERRORS = Object.freeze({
  not_found: 'Группа не найдена',
  not_member: 'Вы не участник группы',
  not_owner: 'Только владелец может это делать',
  limit_reached: 'Достигнут лимит участников',
  not_friends: 'Можно добавлять только друзей',
  already_member: 'Пользователь уже в группе',
  blocked: 'Невозможно добавить пользователя',
  rate_limited: 'Слишком много действий, подождите',
  text_too_long: 'Сообщение слишком длинное',
  server_error: 'Ошибка сервера',
});

/* ============================================================================
 * LOCAL STATE
 * ========================================================================== */

let authUiRevision = state.sessionRevision;

let authOperation = null;
let restoreOperation = null;
let restoreStarted = false;

let searchTimer = null;
let searchAbort = null;
let searchBlurTimer = null;

let nickFetchInFlight = null;
let nickFetchController = null;
let nickFetchGeneration = 0;

const nicknameQueue = new Set();
const nicknameVersions = new Map();

const friendRequestOperations = new Map();
const incomingRequestOperations = new Map();
const sentFriendRequests = new Set();

const recentMessageEvents = new Map();
const deletedMessageIds = new Set();

const buttonBusyOperations = new WeakMap();

const MAX_RECENT_MESSAGE_EVENTS = 5000;
const MAX_DELETED_MESSAGE_IDS = 5000;

/* ============================================================================
 * SMALL HELPERS
 * ========================================================================== */

function auRecord(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function auId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';

  const id = String(value);
  return id && id.length <= 512 ? id : '';
}

const getReqId = request => auId(
  typeof request === 'string' || typeof request === 'number'
    ? request
    : request?.id,
);

const userIdOf = user => auId(
  typeof user === 'string' || typeof user === 'number'
    ? user
    : user?.id,
);

function auIds(value) {
  if (!Array.isArray(value)) return [];

  return [...new Set(value.map(userIdOf).filter(Boolean))];
}

function auCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function auCounts(value) {
  const result = Object.create(null);

  if (!auRecord(value)) return result;

  for (const [id, count] of Object.entries(value)) {
    if (auId(id)) result[id] = auCount(count);
  }

  return result;
}

function auMembers(group) {
  if (!Array.isArray(group?.members)) return [];

  const seen = new Set();

  return group.members.filter(member => {
    const id = userIdOf(member);

    if (!auRecord(member) || !id || seen.has(id)) return false;

    seen.add(id);
    return true;
  });
}

function auRequests(value) {
  if (!Array.isArray(value)) return [];

  const result = new Map();

  for (const request of value) {
    const id = getReqId(request);
    if (!id) continue;

    result.set(id, {
      ...(auRecord(request) ? request : {}),
      id,
    });
  }

  return [...result.values()];
}

function auSnapshot() {
  return {
    revision: state.sessionRevision,
    userId: state.me?.id ?? null,
    token: storage.getItem('chatapp_token'),
  };
}

function auCurrent(snapshot) {
  return state.sessionRevision === snapshot.revision &&
    (state.me?.id ?? null) === snapshot.userId &&
    storage.getItem('chatapp_token') === snapshot.token;
}

function auSilentError(error) {
  return [
    'AuthError',
    'SessionChangedError',
    'AbortError',
  ].includes(error?.name);
}

function auRun(action) {
  try {
    Promise.resolve(action()).catch(error => {
      if (!auSilentError(error)) {
        console.warn('[auth-ui] action failed', error);
        showTransientNotice(error?.message || 'Не удалось выполнить действие');
      }
    });
  } catch (error) {
    if (!auSilentError(error)) {
      console.warn('[auth-ui] action failed', error);
      showTransientNotice(error?.message || 'Не удалось выполнить действие');
    }
  }
}

function auNode(tag, className, text) {
  const element = document.createElement(tag);

  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text ?? '');

  return element;
}

function auActivate(element, action) {
  element.setAttribute('role', 'button');
  element.tabIndex = 0;

  element.addEventListener('click', () => auRun(action));

  element.addEventListener('keydown', event => {
    if (event.target !== element || event.repeat || event.isComposing) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;

    event.preventDefault();
    element.click();
  });
}

function humanError(raw, dictionary, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;

  if (Object.prototype.hasOwnProperty.call(dictionary, raw)) {
    return dictionary[raw];
  }

  const looksLikeText = /\s|[а-яё]/i.test(raw) && raw.length < 160;
  return looksLikeText ? raw : fallback;
}

function auErrorCode(data) {
  return typeof data?.reason === 'string'
    ? data.reason
    : typeof data?.error === 'string'
      ? data.error
      : '';
}

function auPersistProfile() {
  if (!state.me) return;

  try {
    storage.setItem('chatapp_profile', JSON.stringify(state.me));
  } catch (error) {
    console.warn('[auth-ui] profile cache failed', error);
  }
}

function auIsFriend(id) {
  return !!state.friends[id] || auIds(state.me?.friends).includes(id);
}

function auIsBlocked(id) {
  return auIds(state.me?.blockedUsers).includes(id);
}

function auMessageId(message) {
  return auId(message?._id ?? message?.id);
}

function auRememberMessage(key) {
  if (recentMessageEvents.has(key)) return false;

  recentMessageEvents.set(key, Date.now());

  while (recentMessageEvents.size > MAX_RECENT_MESSAGE_EVENTS) {
    recentMessageEvents.delete(recentMessageEvents.keys().next().value);
  }

  return true;
}

function auRememberDeleted(id) {
  deletedMessageIds.add(id);

  while (deletedMessageIds.size > MAX_DELETED_MESSAGE_IDS) {
    deletedMessageIds.delete(deletedMessageIds.values().next().value);
  }
}

function auPrepareMessage(message) {
  if (!auRecord(message) || !userIdOf(message.from)) return null;

  const id = auMessageId(message);

  return {
    ...message,
    from: userIdOf(message.from),
    ...(id && deletedMessageIds.has(id) ? { deleted: true } : {}),
  };
}

function auEnsureSession() {
  if (authUiRevision === state.sessionRevision) return;

  authUiRevision = state.sessionRevision;

  clearTimeout(searchTimer);
  clearTimeout(searchBlurTimer);

  searchTimer = null;
  searchBlurTimer = null;

  searchAbort?.abort();
  searchAbort = null;

  nickFetchGeneration++;
  nickFetchController?.abort();
  nickFetchController = null;
  nickFetchInFlight = null;

  nicknameQueue.clear();
  nicknameVersions.clear();

  for (const operation of incomingRequestOperations.values()) {
    clearTimeout(operation.timer);
  }

  incomingRequestOperations.clear();
  friendRequestOperations.clear();
  sentFriendRequests.clear();

  recentMessageEvents.clear();
  deletedMessageIds.clear();

  $('search-results')?.replaceChildren();
  $('search-results')?.classList.remove('open');
  $('search-input')?.setAttribute('aria-expanded', 'false');
}

function auOnSocket(event, handler) {
  socket.on(event, payload => {
    auEnsureSession();

    if (!state.me || state.loggingOut) return;

    auRun(() => handler(payload));
  });
}

function bindEnterToButton(inputIds, buttonId) {
  for (const id of inputIds) {
    on(id, 'keydown', event => {
      if (
        event.key !== 'Enter' ||
        event.isComposing ||
        event.repeat
      ) {
        return;
      }

      event.preventDefault();
      $(buttonId)?.click();
    });
  }
}

/* ============================================================================
 * BOOT READINESS
 * ========================================================================== */

function auWaitForApp() {
  if (window.__chatappReady) return window.__chatappReady;

  if (window.__chatappBooted) return Promise.resolve();

  if (window.__chatappBootstrap) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener('chatapp:ready', onReady);
        window.removeEventListener('chatapp:boot-error', onError);
      };

      const onReady = () => {
        cleanup();
        resolve();
      };

      const onError = event => {
        cleanup();
        reject(new Error(event.detail?.message || 'Ошибка загрузки приложения'));
      };

      window.addEventListener('chatapp:ready', onReady, { once: true });
      window.addEventListener('chatapp:boot-error', onError, { once: true });
    });
  }

  // Совместимость с обычным подключением всех скриптов в HTML.
  if (document.readyState === 'complete') return Promise.resolve();

  return new Promise(resolve => {
    window.addEventListener('load', resolve, { once: true });
  });
}

/* ============================================================================
 * PASSWORD / TABS / SIDEBAR
 * ========================================================================== */

whenDomReady(() => {
  document.querySelectorAll('.pw-toggle').forEach(button => {
    if (button instanceof HTMLButtonElement) button.type = 'button';

    button.addEventListener('click', () => {
      const input = $(button.dataset.target);

      if (!(input instanceof HTMLInputElement)) return;
      if (!['password', 'text'].includes(input.type)) return;

      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';

      const svg = button.querySelector('svg');
      if (svg) svg.style.opacity = show ? '0.5' : '1';

      button.setAttribute('aria-pressed', String(show));
      button.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');

      input.focus({ preventScroll: true });
    });
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (!tab.dataset.tab) return;

      document.querySelectorAll('.tab').forEach(element => {
        const active = element === tab;
        element.classList.toggle('active', active);
        element.setAttribute('aria-selected', String(active));
      });

      document.querySelectorAll('.tab-content').forEach(element => {
        element.classList.remove('active');
      });

      const content = $(`tab-${tab.dataset.tab}`);
      content?.classList.add('active');

      setErr('');
      content?.querySelector('input')?.focus();
    });
  });

  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => switchSidebarTab(tab.dataset.stab));
  });

  document.querySelectorAll('.rail-btn[data-rail]').forEach(button => {
    button.addEventListener('click', () => switchSidebarTab(button.dataset.rail));
  });

  switchSidebarTab(
    storage.getItem(SIDEBAR_TAB_KEY) === 'groups' ? 'groups' : 'dm',
  );

  if (!storage.getItem('chatapp_token')) {
    $('login-id')?.focus({ preventScroll: true });
  }
});

function switchSidebarTab(value) {
  const name = value === 'groups' ? 'groups' : 'dm';
  const isGroups = name === 'groups';

  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    const active = tab.dataset.stab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.rail-btn[data-rail]').forEach(button => {
    const active = button.dataset.rail === name;
    button.classList.toggle('active', active);

    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  setDisplay('dm-panel', isGroups ? 'none' : '');
  setDisplay('groups-panel', isGroups ? '' : 'none');

  storage.setItem(SIDEBAR_TAB_KEY, name);
}

/* ============================================================================
 * BUTTON BUSY
 * ========================================================================== */

async function withButtonBusy(button, busyText, action) {
  if (!button) return action();
  if (button.disabled || buttonBusyOperations.has(button)) return;

  const operation = {
    text: button.textContent,
    disabled: button.disabled,
  };

  buttonBusyOperations.set(button, operation);

  button.disabled = true;
  button.textContent = busyText;
  button.setAttribute('aria-busy', 'true');

  const timer = setTimeout(() => {
    if (buttonBusyOperations.get(button) === operation && button.isConnected) {
      button.textContent = 'Сервер запускается…';
    }
  }, SLOW_SERVER_HINT_MS);

  try {
    return await action();
  } finally {
    clearTimeout(timer);

    if (buttonBusyOperations.get(button) === operation) {
      buttonBusyOperations.delete(button);

      button.disabled = operation.disabled;
      button.textContent = operation.text;
      button.removeAttribute('aria-busy');
    }
  }
}

/* ============================================================================
 * REGISTER / LOGIN
 * ========================================================================== */

function auCancelRestoration() {
  if (!restoreOperation) return;

  restoreOperation.cancelled = true;
  restoreOperation.controller.abort();
  restoreOperation = null;

  setConnBanner(false);
}

async function authRequest(path, body, fallbackError) {
  if (authOperation) return;

  auCancelRestoration();

  const operation = {
    controller: new AbortController(),
    snapshot: auSnapshot(),
  };

  authOperation = operation;

  const current = () =>
    authOperation === operation &&
    !operation.controller.signal.aborted &&
    auCurrent(operation.snapshot);

  try {
    await auWaitForApp();

    if (!current() || state.me) return;

    const response = await authFetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: operation.controller.signal,
    });

    const data = await safeJson(response);

    if (!current()) return;

    if (response.status === 429) {
      setErr(AUTH_ERRORS.rate_limited);
      return;
    }

    if (!response.ok) {
      setErr(humanError(auErrorCode(data), AUTH_ERRORS, fallbackError));
      return;
    }

    const user = data?.user;
    const token = data?.token;
    const id = userIdOf(user) || auId(body.userId);

    if (
      !auRecord(user) ||
      !id ||
      typeof token !== 'string' ||
      !token.trim()
    ) {
      setErr('Некорректный ответ сервера');
      return;
    }

    saveAndLogin({ ...user, id }, id, token);

    for (const id of ['login-pw', 'reg-pw']) {
      const input = $(id);
      if (input) input.value = '';
    }
  } catch (error) {
    if (!current() || auSilentError(error)) return;

    console.warn('[auth] request failed', error);

    setErr(
      error?.name === 'TimeoutError'
        ? 'Сервер не отвечает, попробуйте ещё раз'
        : 'Не удалось выполнить вход. Проверьте соединение',
    );
  } finally {
    if (authOperation === operation) authOperation = null;
  }
}

on('btn-register', 'click', () => {
  if (authOperation || state.me) return;

  setErr('');

  const userId = ($('reg-id')?.value || '').trim().toLowerCase();
  const nickname = ($('reg-nick')?.value || '').trim() || userId;
  const password = $('reg-pw')?.value || '';

  if (userId.length < ID_MIN_LEN) {
    setErr(`ID минимум ${ID_MIN_LEN} символа`);
    return;
  }

  if (!ID_RE.test(userId)) {
    setErr(AUTH_ERRORS.invalid_id);
    return;
  }

  if (password.length < PW_MIN_LEN) {
    setErr(AUTH_ERRORS.weak_password);
    return;
  }

  if (
    new TextEncoder().encode(password).length > 72 ||
    password.includes('\0')
  ) {
    setErr('Пароль: не больше 72 байт UTF-8, без нулевого символа');
    return;
  }

  auRun(() => withButtonBusy(
    $('btn-register'),
    'Регистрация…',
    () => authRequest(
      '/api/register',
      { userId, nickname, password },
      'Ошибка регистрации',
    ),
  ));
});

on('btn-login', 'click', () => {
  if (authOperation || state.me) return;

  setErr('');

  const userId = ($('login-id')?.value || '').trim().toLowerCase();
  const password = $('login-pw')?.value || '';

  if (!userId || !password) {
    setErr('Введите ID и пароль');
    return;
  }

  auRun(() => withButtonBusy(
    $('btn-login'),
    'Вход…',
    () => authRequest(
      '/api/login',
      { userId, password },
      'Ошибка входа',
    ),
  ));
});

bindEnterToButton(['login-id', 'login-pw'], 'btn-login');
bindEnterToButton(['reg-id', 'reg-nick', 'reg-pw'], 'btn-register');

on('btn-logout', 'click', event => {
  event.stopPropagation();

  if (callState.active && !confirm('Идёт звонок. Выйти из аккаунта?')) return;

  authOperation?.controller.abort();
  authOperation = null;

  auCancelRestoration();
  closeDrop();

  /*
   * resetChatUiState вызывается и здесь для совместимости,
   * даже если хук ещё не добавлен в core.resetState().
   */
  window.resetChatUiState?.();

  forceLogoutToLogin();
  auEnsureSession();
});

/* ============================================================================
 * SESSION RESTORATION
 * ========================================================================== */

async function restoreSession() {
  if (restoreStarted || state.me || authOperation) return;

  restoreStarted = true;

  const token = storage.getItem('chatapp_token');

  if (!token) {
    document.documentElement.classList.remove('has-session');
    return;
  }

  const operation = {
    controller: new AbortController(),
    snapshot: auSnapshot(),
    cancelled: false,
  };

  restoreOperation = operation;

  const current = () =>
    restoreOperation === operation &&
    !operation.cancelled &&
    !authOperation &&
    !state.me &&
    auCurrent(operation.snapshot);

  setConnBanner(true, 'Проверяем сессию…');

  try {
    const response = await authFetch(`${BACKEND_URL}/api/me`, {
      cache: 'no-store',
      timeoutMs: 20000,
      signal: operation.controller.signal,
    });

    if (!current()) return;

    if (response.status === 401) {
      storage.removeItem('chatapp_token');
      storage.removeItem('chatapp_id');
      storage.removeItem('chatapp_profile');

      document.documentElement.classList.remove('has-session');
      setErr('Сессия истекла, войдите снова');
      return;
    }

    if (!response.ok) {
      throw new Error(`Проверка сессии: HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!current()) return;

    const user = auRecord(data?.user) ? data.user : data;
    const id = userIdOf(user);

    if (!auRecord(user) || !id) {
      throw new Error('Некорректный ответ /api/me');
    }

    saveAndLogin({ ...user, id }, id, token);
  } catch (error) {
    if (!current() || auSilentError(error)) return;

    console.warn('[auth] restoration failed', error);

    /*
     * Сбой сети не означает, что токен недействителен.
     * Не удаляем сохранённую сессию и не доверяем кешированному профилю.
     */
    restoreStarted = false;

    document.documentElement.classList.remove('has-session');

    setErr(
      error?.name === 'TimeoutError'
        ? 'Проверка сессии заняла слишком много времени. Обновите страницу или войдите'
        : 'Не удалось проверить сессию. Проверьте соединение или войдите снова',
    );
  } finally {
    if (restoreOperation === operation) {
      restoreOperation = null;
      setConnBanner(false);
    }
  }
}

/*
 * Загрузчик не ожидает этот Promise, поэтому циклического ожидания нет:
 * сначала выполняются chat-ui.js и calls.js, затем восстанавливается сессия.
 */
auWaitForApp()
  .then(() => restoreSession())
  .catch(error => {
    console.warn('[auth] App is not ready:', error);
  });

window.addEventListener('online', () => {
  if (!state.me && !authOperation && !restoreOperation && !restoreStarted) {
    auRun(restoreSession);
  }
});

/* ============================================================================
 * CHAT / OWN PROFILE
 * ========================================================================== */

function showChatPlaceholder() {
  setDisplay('chat-placeholder', 'flex');
  setDisplay('chat-window', 'none');
  setDisplay('group-chat-window', 'none');
  setDisplay('group-voice-bar', 'none');
  setDisplay('dm-voice-bar', 'none');
}

function closeActiveChat() {
  /*
   * При logout state.me уже может быть null.
   * Не восстанавливаем очищенные drafts из старых DOM-полей.
   */
  if (state.me && typeof saveComposerDraft === 'function') {
    saveComposerDraft();
  }

  state.seq.chat++;
  state.seq.groupChat++;

  for (const id of ['messages', 'group-messages']) {
    const box = $(id);

    if (typeof uiCancelHistory === 'function') uiCancelHistory(box);

    if (box) {
      box._conversationKey = null;
      box._historyReady = false;
    }
  }

  state.activeFriend = null;
  state.activeGroup = null;
  state.pendingDeleteId = null;

  setDisplay('delete-confirm', 'none');

  document.querySelectorAll('.friend-item.active').forEach(element => {
    element.classList.remove('active');
  });

  showChatPlaceholder();

  if (typeof scheduleOverlaySync === 'function') scheduleOverlaySync();
}

on('me-card', 'click', event => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest('#btn-logout')) return;

  if (state.me) auRun(() => openEditProfileModal());
});

on('me-card', 'keydown', event => {
  if (event.target !== $('me-card') || event.repeat) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;

  event.preventDefault();

  if (state.me) auRun(() => openEditProfileModal());
});

/* ============================================================================
 * SEARCH
 * ========================================================================== */

function closeDrop(clearInput = true) {
  clearTimeout(searchTimer);
  clearTimeout(searchBlurTimer);

  searchTimer = null;
  searchBlurTimer = null;

  searchAbort?.abort();
  searchAbort = null;

  state.seq.search++;

  $('search-results')?.classList.remove('open');
  $('search-input')?.setAttribute('aria-expanded', 'false');

  if (clearInput) {
    const input = $('search-input');
    if (input) input.value = '';
  }
}

function renderSearchNotice(drop, text, isError = false) {
  if (!drop) return;

  const notice = auNode('div', 's-empty', text);

  if (isError) notice.style.color = 'var(--red)';

  drop.replaceChildren(notice);
  drop.classList.add('open');

  $('search-input')?.setAttribute('aria-expanded', 'true');
}

function auRefreshAddButtons(userId) {
  const id = auId(userId);
  if (!id) return;

  const buttons = [];

  for (const row of document.querySelectorAll('.s-item[data-uid]')) {
    if (row.dataset.uid === id) {
      const button = row.querySelector('.btn-add');
      if (button) buttons.push({ button, profile: false });
    }
  }

  if ($('profile-modal-id')?.textContent === `@${id}`) {
    const button = $('btn-add-friend');
    if (button) buttons.push({ button, profile: true });
  }

  const friend = auIsFriend(id);
  const blocked = auIsBlocked(id);
  const pending = friendRequestOperations.has(id);
  const sent = sentFriendRequests.has(id);

  for (const { button, profile } of buttons) {
    if (friend) {
      button.textContent = profile ? 'Написать' : '✓ В друзьях';
      button.disabled = !profile;
      button.removeAttribute('aria-busy');

      if (profile) {
        button.onclick = () => {
          closeProfileModal();
          auRun(() => openChat(id));
        };
      }
    } else if (pending) {
      button.textContent = 'Отправляем…';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      button.textContent = sent
        ? 'Заявка отправлена'
        : profile ? 'Добавить в друзья' : 'Добавить';

      button.disabled = sent || blocked;
      button.removeAttribute('aria-busy');

      if (profile) {
        button.onclick = () => auRun(() => requestFriend(id, button));
      }
    }
  }
}

function buildSearchItem(user) {
  const id = userIdOf(user);
  if (!id) return null;

  const element = auNode('div', 's-item');
  element.dataset.uid = id;
  element.setAttribute('role', 'option');
  element.setAttribute('aria-selected', 'false');
  element.tabIndex = -1;

  const avatar = auNode('div', 's-mini-av');
  const info = auNode('div');

  info.style.flex = '1';
  info.style.minWidth = '0';

  info.append(
    auNode('div', 's-nick', user.nickname || id),
    auNode('div', 's-id', `@${id}`),
  );

  const button = auNode('button', 'btn-add', 'Добавить');
  button.type = 'button';

  const friend = auIsFriend(id);
  const sent = sentFriendRequests.has(id);
  const pending = friendRequestOperations.has(id);

  button.textContent = friend
    ? '✓ В друзьях'
    : pending
      ? 'Отправляем…'
      : sent
        ? 'Заявка отправлена'
        : 'Добавить';

  button.disabled = friend || pending || sent || auIsBlocked(id);

  renderAvWithDot(avatar, user.nickname || id, user.avatar, user.online === true);

  element.append(avatar, info, button);

  button.addEventListener('click', event => {
    event.stopPropagation();

    if (!button.disabled) auRun(() => requestFriend(id, button));
  });

  element.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('button')) return;

    const openFriend = auIsFriend(id);

    closeDrop();

    auRun(() => openFriend ? openChat(id) : showUserProfile(id));
  });

  element.addEventListener('focus', () => {
    element.setAttribute('aria-selected', 'true');
  });

  element.addEventListener('blur', () => {
    element.setAttribute('aria-selected', 'false');
  });

  return element;
}

async function doSearch(rawQuery) {
  auEnsureSession();

  if (!state.me) return;

  const query = String(rawQuery || '')
    .trim()
    .replace(/^@/, '')
    .slice(0, 50);

  if (!query) {
    closeDrop(false);
    return;
  }

  const drop = $('search-results');
  if (!drop) return;

  searchAbort?.abort();

  const controller = new AbortController();
  searchAbort = controller;

  const snapshot = auSnapshot();
  const requestSeq = ++state.seq.search;

  const stale = () =>
    !auCurrent(snapshot) ||
    requestSeq !== state.seq.search ||
    controller.signal.aborted;

  try {
    const response = await authFetch(
      `${BACKEND_URL}/api/search?q=${encodeURIComponent(query)}`,
      { signal: controller.signal },
    );

    if (stale()) return;

    if (response.status === 429) {
      renderSearchNotice(drop, 'Слишком часто, подождите');
      return;
    }

    if (!response.ok) {
      const detail = await safeJson(response);
      if (stale()) return;

      throw new Error(
        typeof detail?.error === 'string'
          ? detail.error
          : 'Ошибка поиска',
      );
    }

    const data = await response.json();

    if (stale()) return;
    if (!Array.isArray(data)) throw new Error('Некорректный результат поиска');

    const users = new Map();

    for (const user of data) {
      const id = userIdOf(user);

      if (
        auRecord(user) &&
        id &&
        id !== String(state.me.id) &&
        !auIsBlocked(id)
      ) {
        users.set(id, { ...user, id });
      }
    }

    if (!users.size) {
      renderSearchNotice(drop, 'Никого не найдено');
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const user of [...users.values()].slice(0, 100)) {
      const item = buildSearchItem(user);
      if (item) fragment.appendChild(item);
    }

    drop.replaceChildren(fragment);
    drop.classList.add('open');

    $('search-input')?.setAttribute('aria-expanded', 'true');
  } catch (error) {
    if (stale() || auSilentError(error)) return;

    renderSearchNotice(drop, error.message || 'Ошибка поиска', true);
  } finally {
    if (searchAbort === controller) searchAbort = null;
  }
}

on('search-input', 'input', event => {
  closeDrop(false);

  const query = event.target.value.trim();
  if (!query || !state.me) return;

  searchTimer = setTimeout(() => {
    searchTimer = null;
    auRun(() => doSearch(query));
  }, SEARCH_DEBOUNCE_MS);
});

on('search-input', 'focus', event => {
  clearTimeout(searchBlurTimer);

  const query = event.target.value.trim();
  if (query && state.me) auRun(() => doSearch(query));
});

function auScheduleSearchClose() {
  clearTimeout(searchBlurTimer);

  searchBlurTimer = setTimeout(() => {
    const active = document.activeElement;

    if (
      active !== $('search-input') &&
      !$('search-results')?.contains(active)
    ) {
      closeDrop(false);
    }
  }, 150);
}

on('search-input', 'blur', auScheduleSearchClose);
on('search-results', 'focusout', auScheduleSearchClose);

on('search-input', 'keydown', event => {
  if (event.isComposing) return;

  const drop = $('search-results');

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();

    closeDrop();
    event.target.blur();
    return;
  }

  if (!drop?.classList.contains('open')) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    drop.querySelector('.s-item[data-uid]')?.click();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    drop.querySelector('.s-item[data-uid]')?.focus();
  }
});

on('search-results', 'keydown', event => {
  if (event.isComposing) return;

  const drop = $('search-results');
  if (!drop) return;

  const items = [...drop.querySelectorAll('.s-item[data-uid]')];
  const row = document.activeElement?.closest?.('.s-item[data-uid]');
  const index = items.indexOf(row);

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();

    closeDrop();
    $('search-input')?.focus();
    return;
  }

  if (index < 0) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    items[Math.min(index + 1, items.length - 1)]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();

    if (index === 0) $('search-input')?.focus();
    else items[index - 1]?.focus();
  } else if (
    (event.key === 'Enter' || event.key === ' ') &&
    document.activeElement === row
  ) {
    event.preventDefault();
    row.click();
  }
});

document.addEventListener('pointerdown', event => {
  if (!(event.target instanceof Element)) return;

  if (
    !event.target.closest('#search-results') &&
    !event.target.closest('#search-input')
  ) {
    closeDrop(false);
  }
}, { passive: true });

/* ============================================================================
 * FRIEND REQUESTS
 * ========================================================================== */

function removeFriendRequest(value) {
  const id = userIdOf(value);
  if (!id || !state.me) return;

  const operation = incomingRequestOperations.get(id);

  if (operation) {
    clearTimeout(operation.timer);
    incomingRequestOperations.delete(id);
  }

  state.me.friendRequests = auRequests(state.me.friendRequests)
    .filter(request => request.id !== id);

  renderRequests(state.me.friendRequests);
  auPersistProfile();
}

async function requestFriend(value, button) {
  auEnsureSession();

  const userId = auId(value);

  if (!state.me || !userId || userId === String(state.me.id)) return;
  if (button?.disabled || friendRequestOperations.has(userId)) return;

  if (auIsFriend(userId)) {
    auRefreshAddButtons(userId);
    return;
  }

  if (!socket.connected) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  const snapshot = auSnapshot();
  const operation = {};

  friendRequestOperations.set(userId, operation);

  if (button) {
    button.disabled = true;
    button.textContent = 'Отправляем…';
    button.setAttribute('aria-busy', 'true');
  }

  auRefreshAddButtons(userId);

  try {
    const result = await socketRequest('sendFriendRequest', userId);

    if (
      !auCurrent(snapshot) ||
      friendRequestOperations.get(userId) !== operation
    ) {
      return;
    }

    if (result.status === 'friends') {
      state.me.friends = [...new Set([...auIds(state.me.friends), userId])];

      state.friends[userId] ||= {
        id: userId,
        nickname: userId,
        online: false,
      };

      auRun(() => fetchNicknames([userId]));
      renderFriendsList();
    } else {
      sentFriendRequests.add(userId);
    }
  } catch (error) {
    if (!auCurrent(snapshot) || auSilentError(error)) return;

    showTransientNotice(
      humanError(
        error.reason,
        FRIEND_REQUEST_ERRORS,
        error.message || 'Не удалось отправить заявку',
      ),
    );
  } finally {
    if (friendRequestOperations.get(userId) === operation) {
      friendRequestOperations.delete(userId);
    }

    if (auCurrent(snapshot)) {
      auRefreshAddButtons(userId);

      if (button?.isConnected) {
        button.removeAttribute('aria-busy');
      }
    }
  }
}

function auRespondToRequest(id, accept) {
  if (!state.me || incomingRequestOperations.has(id)) return;

  if (!socket.connected) {
    showTransientNotice('Нет соединения с сервером');
    return;
  }

  const snapshot = auSnapshot();
  const operation = { timer: null };

  incomingRequestOperations.set(id, operation);

  /*
   * Исходный протокол использует события без ACK.
   * Не меняем его на socketRequest, иначе старый сервер будет давать таймауты.
   */
  socket.emit(accept ? 'acceptFriendRequest' : 'declineFriendRequest', id);

  operation.timer = setTimeout(() => {
    if (incomingRequestOperations.get(id) !== operation) return;

    incomingRequestOperations.delete(id);

    if (auCurrent(snapshot)) {
      renderRequests(state.me.friendRequests);
      showTransientNotice('Нет подтверждения от сервера. Попробуйте ещё раз');
    }
  }, 15000);

  renderRequests(state.me.friendRequests);
}

function renderRequests(value) {
  const section = $('requests-section');
  const list = $('requests-list');

  if (!section || !list) return;

  const requests = auRequests(value);
  list.replaceChildren();

  section.style.display = requests.length ? 'block' : 'none';
  setText('req-badge', requests.length ? String(requests.length) : '');

  for (const request of requests) {
    const id = request.id;
    const nickname = request.nickname || id;
    const pending = incomingRequestOperations.has(id);

    const card = auNode('div', 'req-card');
    const avatar = auNode('div', 'f-av');
    const info = auNode('div', 'req-info');

    info.append(
      auNode('div', 'req-nick', nickname),
      auNode('div', 'req-id', `Входящая заявка · @${id}`),
    );

    auActivate(info, () => showUserProfile(id));
    info.setAttribute('aria-label', `Профиль: ${nickname}`);

    const controls = auNode('div', 'req-btns');
    const accept = auNode('button', 'btn-ok', '✓');
    const decline = auNode('button', 'btn-no', '✕');

    accept.type = 'button';
    decline.type = 'button';

    accept.title = 'Принять';
    decline.title = 'Отклонить';

    accept.setAttribute('aria-label', `Принять заявку от ${nickname}`);
    decline.setAttribute('aria-label', `Отклонить заявку от ${nickname}`);

    accept.disabled = pending || !socket.connected;
    decline.disabled = pending || !socket.connected;

    accept.addEventListener('click', () => auRespondToRequest(id, true));
    decline.addEventListener('click', () => auRespondToRequest(id, false));

    renderAv(avatar, nickname, request.avatar || null);

    controls.append(accept, decline);
    card.append(avatar, info, controls);
    list.appendChild(card);
  }
}

/* ============================================================================
 * FRIENDS LIST
 * ========================================================================== */

function sortedFriendIds() {
  return Object.keys(state.friends).sort((a, b) => {
    const unreadDifference =
      Number(auCount(state.unread[b]) > 0) -
      Number(auCount(state.unread[a]) > 0);

    if (unreadDifference) return unreadDifference;

    const activityDifference =
      (Number(state.lastActivity[b]) || 0) -
      (Number(state.lastActivity[a]) || 0);

    if (activityDifference) return activityDifference;

    const onlineDifference =
      Number(!!state.friends[b]?.online) -
      Number(!!state.friends[a]?.online);

    if (onlineDifference) return onlineDifference;

    return String(state.friends[a]?.nickname || a)
      .localeCompare(String(state.friends[b]?.nickname || b), 'ru') ||
      a.localeCompare(b);
  });
}

function buildFriendEl(id) {
  const friend = state.friends[id];
  if (!friend) return null;

  const unread = auCount(state.unread[id]);
  const nickname = friend.nickname || id;

  const element = auNode(
    'div',
    `friend-item${state.activeFriend === id ? ' active' : ''}${unread ? ' unread' : ''}`,
  );

  element.dataset.fid = id;

  element.setAttribute(
    'aria-label',
    `${nickname}${unread
      ? `, ${plural(unread, 'новое сообщение', 'новых сообщения', 'новых сообщений')}`
      : ''}`,
  );

  const avatar = auNode('div', 'f-av');
  const info = auNode('div', 'f-info');

  info.append(
    auNode('div', 'f-nick', nickname),
    auNode(
      'div',
      `f-stat${friend.online ? ' on' : ''}`,
      friend.online ? friend.status || 'В сети' : 'Не в сети',
    ),
  );

  renderAvWithDot(avatar, nickname, friend.avatar, friend.online);

  element.append(avatar, info);

  if (unread) {
    element.appendChild(
      auNode('div', 'f-unread', unread > 99 ? '99+' : unread),
    );
  }

  auActivate(element, () => openChat(id));
  return element;
}

function renderFriendsList() {
  const list = $('friends-list');
  if (!list) return;

  const ids = sortedFriendIds();

  const focused = document.activeElement;
  const focusedItem = focused?.closest?.('.friend-item[data-fid]');
  const focusedId = focusedItem && list.contains(focusedItem)
    ? focusedItem.dataset.fid
    : null;

  if (!ids.length) {
    list.innerHTML = emptyFriendsHTML();
  } else {
    const fragment = document.createDocumentFragment();

    for (const id of ids) {
      const item = buildFriendEl(id);
      if (item) fragment.appendChild(item);
    }

    list.replaceChildren(fragment);

    if (focusedId) {
      [...list.children]
        .find(element => element.dataset.fid === focusedId)
        ?.focus({ preventScroll: true });
    }
  }

  updateTitleBadge();
}

function refreshFriendItem() {
  // Online/unread/активность меняют порядок списка.
  renderFriendsList();
}

function updateStatus(id, online) {
  renderFriendsList();

  if (state.activeFriend !== id) return;

  const status = $('chat-status');

  if (status) {
    status.textContent = online ? 'В сети' : 'Не в сети';
    status.className = `chat-head-status${online ? ' on' : ''}`;
  }
}

function auRefreshActiveFriend() {
  const friend = state.friends[state.activeFriend];
  if (!friend) return;

  renderAv($('chat-avatar'), friend.nickname, friend.avatar);
  setText('chat-nick', friend.nickname || friend.id);

  const input = $('msg-input');

  if (input) {
    input.placeholder = `Написать @${friend.nickname || friend.id}`;
  }

  const status = $('chat-status');

  if (status) {
    status.textContent = friend.online ? 'В сети' : 'Не в сети';
    status.className = `chat-head-status${friend.online ? ' on' : ''}`;
  }
}

/* ============================================================================
 * FETCH FRIEND PROFILES: SHARED QUEUE
 * ========================================================================== */

function fetchNicknames(values) {
  auEnsureSession();

  if (!state.me) return Promise.resolve();

  for (const id of auIds(values)) {
    if (state.friends[id]) nicknameQueue.add(id);
  }

  if (nickFetchInFlight) return nickFetchInFlight;
  if (!nicknameQueue.size) return Promise.resolve();

  const snapshot = auSnapshot();
  const generation = nickFetchGeneration;

  const controller = new AbortController();
  nickFetchController = controller;

  const current = () =>
    generation === nickFetchGeneration &&
    auCurrent(snapshot) &&
    !controller.signal.aborted;

  let touched = false;

  const worker = async () => {
    while (current() && nicknameQueue.size) {
      const id = nicknameQueue.values().next().value;
      nicknameQueue.delete(id);

      const original = state.friends[id];
      const version = nicknameVersions.get(id) || 0;

      if (!original) continue;

      try {
        const response = await authFetch(
          `${BACKEND_URL}/api/profile/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );

        if (!response.ok) continue;

        const user = await response.json();

        if (!current()) return;
        if (!auRecord(user) || userIdOf(user) !== id) continue;

        /*
         * Presence/socket-событие, пришедшее позднее начала запроса,
         * имеет приоритет перед HTTP-снимком.
         */
        if (
          state.friends[id] !== original ||
          (nicknameVersions.get(id) || 0) !== version
        ) {
          continue;
        }

        state.friends[id] = {
          ...original,
          id,
          nickname: typeof user.nickname === 'string' ? user.nickname : id,
          avatar: typeof user.avatar === 'string' ? user.avatar : null,
          online: user.online === true,
          status: typeof user.status === 'string' ? user.status : '',
        };

        touched = true;
      } catch (error) {
        if (auSilentError(error) || !current()) return;
        console.warn('[friends] profile fetch failed', id, error);
      }
    }
  };

  let task;

  task = Promise.all(
    Array.from(
      { length: Math.min(NICK_FETCH_CONCURRENCY, nicknameQueue.size) },
      worker,
    ),
  ).then(() => {
    if (!current() || !touched) return;

    renderFriendsList();
    auRefreshActiveFriend();
  }).finally(() => {
    if (nickFetchInFlight === task) {
      nickFetchInFlight = null;
      nickFetchController = null;
    }
  });

  nickFetchInFlight = task;
  return task;
}

/* ============================================================================
 * SOCKET: PROFILE / FRIENDS
 * ========================================================================== */

auOnSocket('profile', profile => {
  if (!auRecord(profile)) return;

  const id = userIdOf(profile);

  // Не принимаем профиль другого аккаунта или профиль без идентификатора.
  if (!id || id !== String(state.me.id)) return;

  const snapshot = auSnapshot();

  const friendIds = Array.isArray(profile.friends)
    ? auIds(profile.friends)
    : auIds(state.me.friends);

  state.me = {
    ...state.me,
    ...profile,
    id,
    friends: friendIds,
    blockedUsers: Array.isArray(profile.blockedUsers)
      ? auIds(profile.blockedUsers)
      : auIds(state.me.blockedUsers),
    friendRequests: Array.isArray(profile.friendRequests)
      ? auRequests(profile.friendRequests)
      : auRequests(state.me.friendRequests),
  };

  if (auRecord(profile.unreadCounts)) {
    state.unread = auCounts(profile.unreadCounts);
  }

  if (auRecord(profile.groupUnreadCounts)) {
    state.groupUnread = auCounts(profile.groupUnreadCounts);
  }

  const next = Object.create(null);

  for (const friendId of friendIds) {
    next[friendId] = state.friends[friendId] || {
      id: friendId,
      nickname: friendId,
      online: false,
    };
  }

  state.friends = next;

  auPersistProfile();

  renderAv($('my-avatar'), state.me.nickname, state.me.avatar);
  setText('my-nick', state.me.nickname || id);
  setText('my-id', `@${id}`);

  renderRequests(state.me.friendRequests);
  renderFriendsList();

  auRun(() => fetchNicknames(friendIds));

  /*
   * Не вызываем openChat() на каждом profile/reconnect:
   * иначе теряются позиция прокрутки и состояние загрузки истории.
   */
  if (state.activeFriend) {
    if (state.friends[state.activeFriend]) auRefreshActiveFriend();
    else closeActiveChat();
  }

  auRun(async () => {
    const loaded = await loadGroups();

    if (!loaded || !auCurrent(snapshot)) return;

    if (state.activeGroup) {
      const group = state.groups[state.activeGroup];

      if (group) syncActiveGroupUI(group);
      else closeActiveChat();
    }
  });
});

auOnSocket('friendRequest', request => {
  if (!auRecord(request)) return;

  const id = userIdOf(request);
  if (!id || id === String(state.me.id)) return;

  const requests = auRequests(state.me.friendRequests);

  if (requests.some(item => item.id === id)) return;

  requests.push({
    id,
    nickname: typeof request.nickname === 'string' ? request.nickname : id,
    avatar: typeof request.avatar === 'string' ? request.avatar : null,
  });

  state.me.friendRequests = requests;

  renderRequests(requests);
  auPersistProfile();

  showTransientNotice(`Заявка в друзья от ${request.nickname || id}`);
  sfx.friend();
});

auOnSocket('requestSent', payload => {
  if (payload != null && !auRecord(payload)) return;

  const id = auId(payload?.targetId ?? payload?.toId ?? payload?.id);

  if (id) {
    sentFriendRequests.add(id);
    auRefreshAddButtons(id);
  }

  showTransientNotice(
    payload?.alreadySent
      ? 'Заявка уже отправлена: ждём ответа'
      : 'Заявка отправлена',
  );
});

auOnSocket('friendRequestError', payload => {
  if (!auRecord(payload)) return;

  const id = auId(payload.targetId ?? payload.toId ?? payload.fromId);
  const reason = typeof payload.reason === 'string' ? payload.reason : '';

  if (id) {
    const incoming = incomingRequestOperations.get(id);

    if (incoming) {
      clearTimeout(incoming.timer);
      incomingRequestOperations.delete(id);
      renderRequests(state.me.friendRequests);
    }

    if (reason === 'already_sent') {
      sentFriendRequests.add(id);
    } else if (!friendRequestOperations.has(id)) {
      sentFriendRequests.delete(id);
    }

    auRefreshAddButtons(id);
  }

  /*
   * Если действие идёт через socketRequest, ошибку покажет его catch.
   * Не сбрасываем кнопки чужого профиля или всех результатов поиска.
   */
  if (!id || !friendRequestOperations.has(id)) {
    showTransientNotice(
      humanError(reason, FRIEND_REQUEST_ERRORS, 'Не удалось обработать заявку'),
    );
  }
});

auOnSocket('requestDeclined', payload => {
  const id = userIdOf(payload) || auId(payload?.fromId);
  if (id) removeFriendRequest(id);
});

auOnSocket('friendAdded', user => {
  if (!auRecord(user)) return;

  const id = userIdOf(user);
  if (!id || id === String(state.me.id)) return;

  const existed = !!state.friends[id];

  nicknameVersions.set(id, (nicknameVersions.get(id) || 0) + 1);

  state.friends[id] = {
    ...(state.friends[id] || {}),
    id,
    nickname: typeof user.nickname === 'string' ? user.nickname : id,
    avatar: typeof user.avatar === 'string' ? user.avatar : null,
    online: user.online === true,
    status: typeof user.status === 'string' ? user.status : '',
  };

  state.me.friends = [...new Set([...auIds(state.me.friends), id])];

  sentFriendRequests.delete(id);
  removeFriendRequest(id);
  renderFriendsList();
  auRefreshAddButtons(id);
  auPersistProfile();

  if (!existed) {
    showTransientNotice(`${user.nickname || id} теперь у вас в друзьях`);
    sfx.friend();
  }
});

auOnSocket('friendRemoved', payload => {
  const id = userIdOf(payload);
  if (!id) return;

  nicknameVersions.set(id, (nicknameVersions.get(id) || 0) + 1);

  state.me.friends = auIds(state.me.friends).filter(friendId => friendId !== id);

  delete state.friends[id];
  delete state.unread[id];
  delete state.lastActivity[id];
  delete state.dmVoiceCalls[id];

  sentFriendRequests.delete(id);

  if (
    callState.active &&
    !callState.isGroup &&
    callState.peerFriendId === id &&
    typeof hangupCall === 'function'
  ) {
    hangupCall();
  }

  if (state.activeFriend === id) closeActiveChat();

  try {
    composerDrafts.delete(`dm:${id}`);
    composerAttachments.delete(`dm:${id}`);
    retryMessages.delete(`dm:${id}`);
  } catch (_) {}

  renderFriendsList();
  auRefreshAddButtons(id);
  auPersistProfile();
});

function setFriendPresence(value, online) {
  const id = auId(value);
  if (!id || !state.me) return;

  nicknameVersions.set(id, (nicknameVersions.get(id) || 0) + 1);

  if (state.friends[id]) {
    state.friends[id] = {
      ...state.friends[id],
      online: !!online,
    };

    updateStatus(id, !!online);
  }

  let touched = false;

  for (const [groupId, group] of Object.entries(state.groups)) {
    const members = auMembers(group);

    if (!members.some(member =>
      String(member.id) === id && !!member.online !== !!online,
    )) {
      continue;
    }

    state.groups[groupId] = {
      ...group,
      members: members.map(member =>
        String(member.id) === id
          ? { ...member, online: !!online }
          : member,
      ),
    };

    touched = true;
  }

  if (touched) {
    renderGroupsList();
    syncActiveGroupUI(state.groups[state.activeGroup]);

    if (state.infoGroupId && state.groups[state.infoGroupId]) {
      renderGroupInfoMembers(state.groups[state.infoGroupId]);
    }
  }
}

auOnSocket('friendOnline', user => setFriendPresence(userIdOf(user), true));
auOnSocket('friendOffline', user => setFriendPresence(userIdOf(user), false));

/* ============================================================================
 * MESSAGES / READ STATE
 * ========================================================================== */

function auChatReadable(group, target, requireNearBottom = true) {
  if (!socket.connected || document.visibilityState !== 'visible') return false;
  if (!state.me || isAnyModalOpen()) return false;

  const activeTarget = group ? state.activeGroup : state.activeFriend;
  if (activeTarget !== target) return false;

  const box = $(group ? 'group-messages' : 'messages');
  const chatWindow = $(group ? 'group-chat-window' : 'chat-window');

  if (!box || !chatWindow) return false;
  if (!box._historyReady || box._loadingHistory) return false;
  if (getComputedStyle(chatWindow).display === 'none') return false;

  return !requireNearBottom || isNearBottom(box);
}

function auMarkRead(group, target) {
  if (!auChatReadable(group, target)) return;

  if (group) {
    state.groupUnread[target] = 0;
    socket.emit('markGroupRead', target);
    refreshGroupItem(target);
  } else {
    state.unread[target] = 0;
    socket.emit('markRead', target);
    refreshFriendItem(target);
  }

  updateTitleBadge();
}

function auReceiveMessage(group, payload) {
  if (!auRecord(payload)) return;

  const target = auId(group ? payload.groupId : payload.chatWith);
  const message = auPrepareMessage(payload.msg);

  if (!target || !message) return;

  const id = auMessageId(message);
  const key = `${group ? 'group' : 'dm'}:${target}:${id}`;

  if (id && !auRememberMessage(key)) {
    if (message.deleted) auDeleteRenderedMessage(id);
    return;
  }

  const activities = group ? state.groupLastActivity : state.lastActivity;

  activities[target] = Math.max(
    Number(activities[target]) || 0,
    getMsgTimeMs(message),
  );

  const mine = message.from === String(state.me.id);
  const active = (group ? state.activeGroup : state.activeFriend) === target;

  /*
   * Проверяем положение ДО вставки: пользователь, читающий старые сообщения,
   * не должен автоматически помечать новое сообщение прочитанным.
   */
  const readable = auChatReadable(group, target);

  if (active) {
    if (group) appendGroupMsg(message);
    else appendMsg(message, 'messages');
  }

  if (!mine) {
    const unread = group ? state.groupUnread : state.unread;

    if (readable) {
      unread[target] = 0;
      socket.emit(group ? 'markGroupRead' : 'markRead', target);
    } else {
      unread[target] = auCount(unread[target]) + 1;
      sfx.message();
    }
  }

  if (group) renderGroupsList();
  else renderFriendsList();

  updateTitleBadge();
}

auOnSocket('newMessage', payload => auReceiveMessage(false, payload));
auOnSocket('newGroupMessage', payload => auReceiveMessage(true, payload));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me) return;

  auEnsureSession();

  if (state.activeFriend) auMarkRead(false, state.activeFriend);
  if (state.activeGroup) auMarkRead(true, state.activeGroup);
});

for (const group of [false, true]) {
  on(group ? 'group-messages' : 'messages', 'scroll', () => {
    if (!state.me) return;

    const target = group ? state.activeGroup : state.activeFriend;
    const unread = group ? state.groupUnread : state.unread;

    if (target && auCount(unread[target])) auMarkRead(group, target);
  }, { passive: true });
}

function auDeleteRenderedMessage(value) {
  const id = auId(value);
  if (!id) return;

  auRememberDeleted(id);

  for (const containerId of ['messages', 'group-messages']) {
    const container = $(containerId);
    if (!container) continue;

    for (const wrap of container.querySelectorAll('.g-msg[data-msgid]')) {
      if (wrap.dataset.msgid !== id) continue;

      wrap.classList.add('deleted');
      wrap.querySelector('.msg-del-btn')?.remove();

      wrap.querySelectorAll('.message-image').forEach(image => {
        image.remove();
      });

      const text = wrap.querySelector('.g-msg-text');

      if (text) {
        text.textContent = 'Сообщение удалено';
        text.classList.remove('jumbo');
      }
    }

    const buffered = container._liveMessages?.get(id);

    if (buffered) {
      container._liveMessages.set(id, {
        ...buffered,
        deleted: true,
      });
    }
  }

  if (String(state.pendingDeleteId) === id) {
    state.pendingDeleteId = null;
    setDisplay('delete-confirm', 'none');
  }
}

auOnSocket('messageDeleted', payload => {
  if (!auRecord(payload)) return;

  const id = auId(payload.messageId);
  if (id) auDeleteRenderedMessage(id);
});

auOnSocket('unreadCleared', payload => {
  if (!auRecord(payload)) return;

  const chatWith = auId(payload.chatWith);
  const groupId = auId(payload.groupId);

  if (chatWith) {
    state.unread[chatWith] = 0;
    refreshFriendItem(chatWith);
  }

  if (groupId) {
    state.groupUnread[groupId] = 0;
    refreshGroupItem(groupId);
  }

  updateTitleBadge();
});

auOnSocket('rateLimited', kind => {
  showTransientNotice(
    kind === 'sendMessage' || kind === 'groupMessage'
      ? 'Слишком много сообщений, подождите немного'
      : 'Слишком много действий, подождите',
  );
});

auOnSocket('sendMessageError', payload => {
  if (!auRecord(payload)) return;

  showTransientNotice(
    humanError(payload.reason, SEND_MESSAGE_ERRORS, 'Не удалось отправить сообщение'),
  );
});

/* ============================================================================
 * GROUP HELPERS
 * ========================================================================== */

function syncActiveGroupUI(group) {
  if (!group || state.activeGroup !== String(group.id)) return;

  updateGroupChatHeader(group);
  renderGroupMembersPanel(group);
}

function forgetGroup(value) {
  const groupId = auId(value);
  if (!groupId) return;

  /*
   * Сначала закрываем звонок, потом удаляем комнату:
   * hangupCall не должен восстанавливать запись уже удалённой группы.
   */
  if (
    callState.active &&
    callState.isGroup &&
    callState.groupId === groupId &&
    typeof hangupCall === 'function'
  ) {
    hangupCall();
  }

  if (state.activeGroup === groupId) closeActiveChat();
  if (state.infoGroupId === groupId) closeGroupInfoModal();

  if ($('add-members-modal')?.dataset.gid === groupId) {
    closeAddMembersModal();
  }

  window.clearGroupVoiceRejoin?.(groupId);

  clearTimeout(state.voiceRejoin[groupId]?.timer);

  delete state.voiceRejoin[groupId];
  delete state.groups[groupId];
  delete state.groupUnread[groupId];
  delete state.groupVoiceCalls[groupId];
  delete state.groupLastActivity[groupId];

  try {
    composerDrafts.delete(`group:${groupId}`);
    composerAttachments.delete(`group:${groupId}`);
    retryMessages.delete(`group:${groupId}`);
  } catch (_) {}

  renderGroupsList();
  updateGroupVoiceBar();
  updateTitleBadge();
}

/* ============================================================================
 * SOCKET: GROUPS / VOICE
 * ========================================================================== */

auOnSocket('addedToGroup', payload => {
  if (!auRecord(payload) || !auRecord(payload.group)) return;

  const id = userIdOf(payload.group);
  if (!id) return;

  const existed = !!state.groups[id];

  state.groups[id] = {
    ...payload.group,
    id,
    members: auMembers(payload.group),
  };

  state.groupLastActivity[id] = Date.now();

  renderGroupsList();

  if (!existed) {
    showTransientNotice(`Вас добавили в группу «${payload.group.name || id}»`);
    sfx.friend();
  }
});

auOnSocket('groupVoiceState', payload => {
  if (!auRecord(payload)) return;

  const groupId = auId(payload.groupId);
  if (!groupId) return;

  if (payload.callId == null || payload.callId === '') {
    window.clearGroupVoiceRejoin?.(groupId);
    delete state.groupVoiceCalls[groupId];
  } else {
    const callId = auId(payload.callId);
    if (!callId) return;

    state.groupVoiceCalls[groupId] = {
      callId,
      video: payload.video === true,
      participants: auIds(payload.participants),
    };

    window.rememberGroupVoice?.(groupId, callId, payload.video === true);
  }

  renderGroupsList();
  updateGroupVoiceBar(groupId);
});

auOnSocket('callStateChanged', payload => {
  if (!auRecord(payload)) return;

  const groupId = auId(payload.groupId);
  const callId = auId(payload.callId);

  if (!groupId || !callId || !Array.isArray(payload.participants)) return;

  const call = state.groupVoiceCalls[groupId];
  if (!call || call.callId !== callId) return;

  state.groupVoiceCalls[groupId] = {
    ...call,
    participants: auIds(payload.participants),
  };

  renderGroupsList();
  updateGroupVoiceBar(groupId);
});

auOnSocket('groupUpdated', payload => {
  if (!auRecord(payload)) return;

  const groupId = auId(payload.groupId);
  if (!groupId) return;

  const previous = state.groups[groupId];

  if (!previous) {
    auRun(loadGroups);
    return;
  }

  const group = {
    ...previous,
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    ...(payload.avatar === null || typeof payload.avatar === 'string'
      ? { avatar: payload.avatar }
      : {}),
  };

  state.groups[groupId] = group;

  refreshGroupItem(groupId);
  syncActiveGroupUI(group);

  if (state.activeGroup === groupId) {
    const input = $('group-msg-input');
    if (input) input.placeholder = `Написать в ${group.name || groupId}`;
  }

  if (state.infoGroupId === groupId) {
    openGroupInfoModal(groupId);
  }
});

auOnSocket('groupMemberJoined', payload => {
  if (!auRecord(payload) || !auRecord(payload.user)) return;

  const groupId = auId(payload.groupId);
  const userId = userIdOf(payload.user);
  const previous = state.groups[groupId];

  if (!groupId || !userId) return;

  if (!previous) {
    auRun(loadGroups);
    return;
  }

  const members = auMembers(previous);
  const existed = members.some(member => String(member.id) === userId);

  const user = { ...payload.user, id: userId };

  const group = {
    ...previous,
    members: existed
      ? members.map(member =>
        String(member.id) === userId ? { ...member, ...user } : member,
      )
      : [...members, user],
  };

  state.groups[groupId] = group;

  renderGroupsList();
  syncActiveGroupUI(group);

  if (!existed && state.activeGroup === groupId) {
    appendSystemMsg(
      'group-messages',
      `${user.nickname || userId} присоединился к группе`,
    );
  }

  if (state.infoGroupId === groupId) renderGroupInfoMembers(group);
});

auOnSocket('groupMemberLeft', payload => {
  if (!auRecord(payload)) return;

  const groupId = auId(payload.groupId);
  const userId = auId(payload.userId);

  if (!groupId || !userId) return;

  const previous = state.groups[groupId];

  if (userId === String(state.me.id)) {
    const name = previous?.name || groupId;

    forgetGroup(groupId);
    showTransientNotice(`Вы больше не участник группы «${name}»`);
    return;
  }

  if (!previous) return;

  const members = auMembers(previous);
  const left = members.find(member => String(member.id) === userId);

  if (!left) return;

  const group = {
    ...previous,
    members: members.filter(member => String(member.id) !== userId),
  };

  state.groups[groupId] = group;

  const room = state.groupVoiceCalls[groupId];

  if (room) {
    state.groupVoiceCalls[groupId] = {
      ...room,
      participants: auIds(room.participants).filter(id => id !== userId),
    };
  }

  renderGroupsList();
  syncActiveGroupUI(group);
  updateGroupVoiceBar(groupId);

  if (state.activeGroup === groupId) {
    appendSystemMsg(
      'group-messages',
      `${left.nickname || userId} покинул(а) группу`,
    );
  }

  if (state.infoGroupId === groupId) renderGroupInfoMembers(group);
});

auOnSocket('groupDeleted', payload => {
  if (!auRecord(payload)) return;

  const groupId = auId(payload.groupId);
  if (!groupId) return;

  const name = state.groups[groupId]?.name;

  forgetGroup(groupId);

  if (name) showTransientNotice(`Группа «${name}» удалена`);
});

auOnSocket('groupError', payload => {
  if (!auRecord(payload)) return;

  showTransientNotice(
    humanError(payload.reason, GROUP_ERRORS, 'Ошибка группы'),
  );
});

/* ============================================================================
 * CONNECTION LIFECYCLE
 *
 * connect_error / баннер / проверку 401 обрабатывают chat-ui.js и core.js.
 * Здесь нет повторного forceLogout по тексту ошибки Socket.IO.
 * ========================================================================== */

socket.on('connect', () => {
  auEnsureSession();

  if (!state.me) return;

  renderRequests(state.me.friendRequests);

  if (state.activeFriend) {
    socket.emit('watchDmVoice', { peerId: state.activeFriend });
  }

  if (state.activeGroup) {
    socket.emit('watchGroupVoice', { groupId: state.activeGroup });
  }
});

socket.on('disconnect', () => {
  for (const operation of incomingRequestOperations.values()) {
    clearTimeout(operation.timer);
  }

  incomingRequestOperations.clear();

  if (state.me && !state.loggingOut) {
    renderRequests(state.me.friendRequests);
  }
});

/*
 * storage обрабатывается в core.js.
 * Не вызываем forceLogoutToLogin из второго обработчика:
 * он мог бы удалить токен, только что установленный другой вкладкой.
 */

/* ============================================================================
 * EXPORTS
 * ========================================================================== */

Object.assign(window, {
  AUTH_ERRORS,
  FRIEND_REQUEST_ERRORS,
  SEND_MESSAGE_ERRORS,
  GROUP_ERRORS,

  humanError,
  withButtonBusy,
  authRequest,
  restoreSession,

  switchSidebarTab,
  showChatPlaceholder,
  closeActiveChat,

  closeDrop,
  doSearch,

  renderRequests,
  removeFriendRequest,
  requestFriend,

  sortedFriendIds,
  renderFriendsList,
  refreshFriendItem,
  buildFriendEl,
  fetchNicknames,
  updateStatus,
  setFriendPresence,

  forgetGroup,
  syncActiveGroupUI,
});