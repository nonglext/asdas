'use strict';

/* ============================================================================
 * chat-plus.js · ChatApp 2.0
 *
 * Ответы с цитатой, редактирование, реакции, «печатает…», отметки прочтения,
 * кнопка «к новым сообщениям», быстрые клавиши. Работает поверх chat-ui.js:
 * сообщение рисует appendChatMsg, а этот модуль только «одевает» его.
 * ========================================================================== */

const CP_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '🙏', '💯'];
const CP_TYPING_SEND_MS = 3000;
const CP_TYPING_IDLE_MS = 4500;
const CP_TYPING_EXPIRE_MS = 6500;

const cpReplies = new Map();
const cpTypers = new Map();
const cpTyping = { key: null, sentAt: 0, idleTimer: null };
let cpEditing = null;
let cpPickerFor = null;

const CP_ICON = {
  react: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
};

/* ── Утилиты ─────────────────────────────────────────────────────────────── */

function cpEl(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function cpId(value) {
  return value == null ? '' : String(value);
}

function cpActiveKey(group) {
  const target = group ? state.activeGroup : state.activeFriend;
  return target ? `${group ? 'group' : 'dm'}:${target}` : null;
}

function cpContainerGroup(containerId) {
  return containerId === 'group-messages';
}

function cpName(userId, group = !!state.activeGroup) {
  const id = cpId(userId);

  if (state.me && id === String(state.me.id)) return 'Вы';

  if (group && state.activeGroup) {
    const info = state.groups[state.activeGroup];
    const members = typeof uiMembers === 'function' ? uiMembers(info) : info?.members;

    if (Array.isArray(members)) {
      const member = members.find(item => cpId(item?.id ?? item) === id);
      if (member?.nickname) return member.nickname;
    }
  }

  return state.friends?.[id]?.nickname || id;
}

function cpAttachmentLabel(message) {
  const mime = String(message?.attachmentMime || '');

  if (mime.startsWith('image/')) return 'Фото';
  if (mime === 'audio/mpeg') return 'Аудио';
  if (mime === 'video/mp4') return 'Видео';
  if (message?.hasAttachment || message?.image) return 'Файл';

  return '';
}

function cpSnippet(message) {
  if (!message || message.deleted) return 'Сообщение удалено';

  const text = String(message.text || '').replace(/\s+/g, ' ').trim();

  if (text) return text.length > 120 ? `${text.slice(0, 117)}…` : text;

  return cpAttachmentLabel(message) || 'Сообщение';
}

function cpWraps(id) {
  const result = [];

  for (const containerId of ['messages', 'group-messages']) {
    const container = document.getElementById(containerId);
    if (!container) continue;

    for (const wrap of container.querySelectorAll('.g-msg[data-msgid]')) {
      if (wrap.dataset.msgid === id) result.push(wrap);
    }
  }

  return result;
}

function cpCanDelete(wrap) {
  const message = wrap._msg;
  if (!message || message.deleted || !wrap.dataset.msgid || !state.me) return false;
  if (cpId(message.from) === String(state.me.id)) return true;

  const group = state.activeGroup ? state.groups[state.activeGroup] : null;

  return !!group &&
    wrap.closest('#group-messages') &&
    typeof isGroupOwner === 'function' &&
    isGroupOwner(group, state.me.id);
}

function cpNotice(text) {
  if (typeof showTransientNotice === 'function') showTransientNotice(text);
}

/* ── Оформление сообщения ────────────────────────────────────────────────── */

function cpRenderReplyQuote(body, reply, group) {
  body.querySelector(':scope > .msg-reply')?.remove();
  if (!reply || typeof reply !== 'object') return;

  const quote = cpEl('button', 'msg-reply');
  quote.type = 'button';
  quote.dataset.replyId = cpId(reply._id);
  quote.setAttribute('aria-label', `Ответ на сообщение: ${cpSnippet(reply)}`);

  const name = cpEl('span', 'msg-reply-name', cpName(reply.from, group));
  const text = cpEl('span', 'msg-reply-text', cpSnippet(reply));

  if (reply.deleted) quote.classList.add('is-deleted');

  quote.append(name, text);

  const anchor = body.querySelector(':scope > .g-msg-text');
  body.insertBefore(quote, anchor || body.firstChild);
}

function cpRenderMeta(wrap, message, info) {
  const body = wrap.querySelector('.g-msg-body');
  if (!body) return;

  let meta = body.querySelector(':scope > .msg-meta');

  if (!meta) {
    meta = cpEl('span', 'msg-meta');
    body.appendChild(meta);
  }

  meta.replaceChildren();

  if (message.editedAt && !message.deleted) {
    const edited = cpEl('span', 'msg-edited', 'изменено');
    edited.title = `Изменено ${new Date(message.editedAt).toLocaleString('ru-RU')}`;
    meta.appendChild(edited);
  }

}

function cpRenderReactions(wrap, reactions) {
  const body = wrap.querySelector('.g-msg-body');
  if (!body) return;

  let row = body.querySelector(':scope > .msg-reactions');
  const entries = Object.entries(reactions || {})
    .filter(([emoji, users]) => CP_REACTIONS.includes(emoji) && Array.isArray(users) && users.length);

  if (!entries.length || wrap.classList.contains('deleted')) {
    row?.remove();
    return;
  }

  if (!row) {
    row = cpEl('div', 'msg-reactions');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Реакции');
    const meta = body.querySelector(':scope > .msg-meta');
    body.insertBefore(row, meta || null);
  }

  row.replaceChildren();

  const me = state.me ? String(state.me.id) : '';
  const group = !!wrap.closest('#group-messages');

  entries.sort((a, b) => CP_REACTIONS.indexOf(a[0]) - CP_REACTIONS.indexOf(b[0]));

  for (const [emoji, users] of entries) {
    const mine = users.map(String).includes(me);
    const chip = cpEl('button', `msg-reaction${mine ? ' mine' : ''}`);
    const names = users.slice(0, 8).map(id => cpName(id, group));

    chip.type = 'button';
    chip.dataset.emoji = emoji;
    chip.setAttribute('aria-pressed', String(mine));
    chip.title = `${names.join(', ')}${users.length > 8 ? ` и ещё ${users.length - 8}` : ''}`;
    chip.setAttribute('aria-label', `${emoji} ${users.length}. ${chip.title}`);
    chip.append(cpEl('span', 'msg-reaction-emoji', emoji), cpEl('span', 'msg-reaction-count', String(users.length)));
    row.appendChild(chip);
  }

  const add = cpEl('button', 'msg-reaction add');
  add.type = 'button';
  add.dataset.act = 'react';
  add.title = 'Добавить реакцию';
  add.setAttribute('aria-label', 'Добавить реакцию');
  add.innerHTML = CP_ICON.react;
  row.appendChild(add);
}

function cpRenderActions(wrap, info) {
  wrap.querySelector(':scope > .msg-actions')?.remove();

  const message = wrap._msg;
  if (!message || message.deleted || !wrap.dataset.msgid) return;

  const bar = cpEl('div', 'msg-actions');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Действия с сообщением');

  const add = (act, label, icon, extra = '') => {
    const button = cpEl('button', `msg-action${extra ? ` ${extra}` : ''}`);
    button.type = 'button';
    button.dataset.act = act;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    bar.appendChild(button);
  };

  add('react', 'Реакция', CP_ICON.react);
  add('reply', 'Ответить', CP_ICON.reply);
  if (info.isMine && (message.text || !message.image)) add('edit', 'Изменить', CP_ICON.edit);
  if (String(message.text || '').trim()) add('copy', 'Копировать текст', CP_ICON.copy);
  if (cpCanDelete(wrap)) add('delete', 'Удалить', CP_ICON.trash, 'danger');

  wrap.appendChild(bar);
}

function chatPlusDecorate(wrap, message, info) {
  const body = wrap.querySelector('.g-msg-body');
  if (!body) return;

  wrap.classList.toggle('in-group', !!info.group);

  if (!info.deleted) cpRenderReplyQuote(body, message.replyTo, info.group);

  cpRenderReactions(wrap, message.reactions);
  cpRenderMeta(wrap, message, info);
  cpRenderActions(wrap, info);
}

window.chatPlusDecorate = chatPlusDecorate;

/* ── Ответ ───────────────────────────────────────────────────────────────── */

function cpComposerWrap(group) {
  const input = document.getElementById(group ? 'group-msg-input' : 'msg-input');
  return input?.closest('.msg-bar-wrap') || null;
}

function cpRenderComposerContext(group) {
  const wrap = cpComposerWrap(group);
  if (!wrap) return;

  const key = cpActiveKey(group);
  const reply = key ? cpReplies.get(key) : null;
  let context = wrap.querySelector(':scope > .composer-context');

  if (!reply) {
    context?.remove();
    wrap.classList.remove('has-context');
    return;
  }

  if (!context) {
    context = cpEl('div', 'composer-context');
    context.setAttribute('role', 'status');
    wrap.insertBefore(context, wrap.querySelector('.msg-bar'));
  }

  context.replaceChildren();

  const icon = cpEl('span', 'composer-context-icon');
  icon.innerHTML = CP_ICON.reply;

  const copy = cpEl('div', 'composer-context-copy');
  const title = cpEl('span', 'composer-context-title');
  title.append('Ответ ', cpEl('strong', '', reply.name));
  copy.append(title, cpEl('span', 'composer-context-text', reply.snippet));

  const close = cpEl('button', 'composer-context-close');
  close.type = 'button';
  close.title = 'Отменить ответ (Esc)';
  close.setAttribute('aria-label', 'Отменить ответ');
  close.innerHTML = CP_ICON.close;
  close.addEventListener('click', () => {
    cpReplies.delete(key);
    cpRenderComposerContext(group);
    document.getElementById(group ? 'group-msg-input' : 'msg-input')?.focus();
  });

  context.append(icon, copy, close);
  wrap.classList.add('has-context');
}

function cpStartReply(wrap) {
  const group = !!wrap.closest('#group-messages');
  const key = cpActiveKey(group);
  const message = wrap._msg;
  if (!key || !message || !wrap.dataset.msgid) return;

  cpReplies.set(key, {
    id: wrap.dataset.msgid,
    name: cpName(message.from, group),
    snippet: cpSnippet(message),
  });

  cpRenderComposerContext(group);
  document.getElementById(group ? 'group-msg-input' : 'msg-input')?.focus();
}

function chatPlusReplyFor(key) {
  return cpReplies.get(key)?.id || null;
}

function chatPlusSent(key, replyId) {
  const current = cpReplies.get(key);
  if (current && current.id === replyId) cpReplies.delete(key);

  cpRenderComposerContext(key.startsWith('group:'));
}

window.chatPlusReplyFor = chatPlusReplyFor;
window.chatPlusSent = chatPlusSent;

function cpJumpTo(id) {
  const target = cpWraps(id).find(wrap => wrap.offsetParent !== null);

  if (!target) {
    cpNotice('Это сообщение выше в истории. Подгрузите предыдущие сообщения');
    return;
  }

  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
}

/* ── Редактирование ──────────────────────────────────────────────────────── */

function cpCancelEdit({ focus = true } = {}) {
  if (!cpEditing) return;

  const { wrap, textNode, editor, group } = cpEditing;
  cpEditing = null;

  editor.remove();
  textNode.hidden = false;
  wrap.classList.remove('editing');

  if (focus) document.getElementById(group ? 'group-msg-input' : 'msg-input')?.focus();
}

async function cpSaveEdit() {
  if (!cpEditing || cpEditing.saving) return;

  const editing = cpEditing;
  const text = editing.input.value.trim();
  const original = String(editing.wrap._msg?.text || '');

  if (text === original.trim()) {
    cpCancelEdit();
    return;
  }

  if (!text && !editing.wrap._msg?.image) {
    cpNotice('Сообщение не может быть пустым. Удалите его, если оно не нужно');
    return;
  }

  editing.saving = true;
  editing.input.disabled = true;

  try {
    const result = await socketRequest('editMessage', {
      messageId: editing.wrap.dataset.msgid,
      text,
    });

    cpApplyEdit({
      messageId: editing.wrap.dataset.msgid,
      text: result?.text ?? text,
      editedAt: result?.editedAt || new Date().toISOString(),
    });

    if (cpEditing === editing) cpCancelEdit();
  } catch (error) {
    editing.saving = false;
    editing.input.disabled = false;
    editing.input.focus();
    cpNotice(error?.message || 'Не удалось сохранить изменения');
  }
}

function cpStartEdit(wrap) {
  const message = wrap._msg;
  const textNode = wrap.querySelector('.g-msg-text');
  if (!message || message.deleted || !textNode || !wrap.dataset.msgid) return;

  cpCancelEdit({ focus: false });

  const group = !!wrap.closest('#group-messages');
  const editor = cpEl('div', 'msg-editor');
  const input = cpEl('textarea', 'msg-edit-input');
  input.value = String(message.text || '');
  input.maxLength = 4000;
  input.rows = 1;
  input.setAttribute('aria-label', 'Изменить сообщение');

  const hint = cpEl('div', 'msg-edit-hint');
  const cancel = cpEl('button', 'msg-edit-link', 'отмена');
  const save = cpEl('button', 'msg-edit-link strong', 'сохранить');
  cancel.type = save.type = 'button';
  hint.append('Esc ', cancel, ' · Enter ', save);

  editor.append(input, hint);
  textNode.hidden = true;
  textNode.after(editor);
  wrap.classList.add('editing');

  cpEditing = { wrap, textNode, editor, input, group, saving: false };

  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  };

  input.addEventListener('input', resize);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cpCancelEdit();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void cpSaveEdit();
    }
  });
  cancel.addEventListener('click', () => cpCancelEdit());
  save.addEventListener('click', () => void cpSaveEdit());

  requestAnimationFrame(() => {
    resize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

function cpApplyEdit(payload) {
  const id = cpId(payload?.messageId);
  if (!id || typeof payload.text !== 'string') return;

  for (const wrap of cpWraps(id)) {
    if (!wrap._msg || wrap._msg.deleted) continue;

    wrap._msg = { ...wrap._msg, text: payload.text, editedAt: payload.editedAt };

    const textNode = wrap.querySelector('.g-msg-text');

    if (textNode) {
      textNode.innerHTML = formatMsgText(payload.text);
      textNode.classList.toggle('jumbo', isJumboEmoji(payload.text));
    }

    const group = !!wrap.closest('#group-messages');
    const isMine = state.me && cpId(wrap._msg.from) === String(state.me.id);

    cpRenderMeta(wrap, wrap._msg, {
      timeMs: Number(wrap.dataset.time) || Date.now(),
      isMine,
      group,
    });
    cpRenderActions(wrap, { isMine, group });
  }

  document.querySelectorAll(`.msg-reply[data-reply-id="${CSS.escape(id)}"] .msg-reply-text`)
    .forEach(node => { node.textContent = cpSnippet({ text: payload.text }); });
}

/* ── Реакции ─────────────────────────────────────────────────────────────── */

function cpPicker() {
  let picker = document.getElementById('cp-react-picker');
  if (picker) return picker;

  picker = cpEl('div', 'react-picker');
  picker.id = 'cp-react-picker';
  picker.setAttribute('role', 'menu');
  picker.setAttribute('aria-label', 'Выберите реакцию');
  picker.hidden = true;

  for (const emoji of CP_REACTIONS) {
    const button = cpEl('button', 'react-picker-item', emoji);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.dataset.emoji = emoji;
    picker.appendChild(button);
  }

  picker.addEventListener('click', event => {
    const button = event.target.closest('[data-emoji]');
    if (!button || !cpPickerFor) return;

    const wrap = cpPickerFor;
    cpClosePicker();
    void cpToggleReaction(wrap, button.dataset.emoji);
  });

  picker.addEventListener('keydown', event => {
    const items = [...picker.querySelectorAll('button')];
    const index = items.indexOf(document.activeElement);

    if (event.key === 'Escape') {
      event.preventDefault();
      const wrap = cpPickerFor;
      cpClosePicker();
      wrap?.querySelector('[data-act="react"]')?.focus();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  });

  document.body.appendChild(picker);
  return picker;
}

function cpOpenPicker(wrap, anchor) {
  const picker = cpPicker();
  cpPickerFor = wrap;
  picker.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const width = picker.offsetWidth;
  const height = picker.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
  const above = rect.top - height - 8;
  const top = above > 8 ? above : rect.bottom + 8;

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
  wrap.classList.add('picker-open');

  picker.querySelector('button')?.focus({ preventScroll: true });
}

function cpClosePicker() {
  const picker = document.getElementById('cp-react-picker');
  if (picker) picker.hidden = true;

  cpPickerFor?.classList.remove('picker-open');
  cpPickerFor = null;
}

async function cpToggleReaction(wrap, emoji) {
  const id = wrap.dataset.msgid;
  if (!id || !CP_REACTIONS.includes(emoji)) return;

  try {
    const result = await socketRequest('reactMessage', { messageId: id, emoji });
    if (result?.reactions) cpApplyReactions({ messageId: id, reactions: result.reactions });
  } catch (error) {
    cpNotice(error?.message || 'Не удалось поставить реакцию');
  }
}

function cpApplyReactions(payload) {
  const id = cpId(payload?.messageId);
  if (!id || typeof payload.reactions !== 'object') return;

  for (const wrap of cpWraps(id)) {
    if (!wrap._msg) continue;
    wrap._msg = { ...wrap._msg, reactions: payload.reactions };
    cpRenderReactions(wrap, payload.reactions);
  }
}

/* ── Делегирование кликов в ленте ────────────────────────────────────────── */

function cpBindContainer(containerId) {
  const container = document.getElementById(containerId);
  if (!container || container._cpBound) return;
  container._cpBound = true;

  container.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const wrap = target.closest('.g-msg');
    if (!wrap) return;

    const quote = target.closest('.msg-reply');
    if (quote) {
      event.preventDefault();
      if (quote.dataset.replyId) cpJumpTo(quote.dataset.replyId);
      return;
    }

    const chip = target.closest('.msg-reaction[data-emoji]');
    if (chip) {
      event.preventDefault();
      void cpToggleReaction(wrap, chip.dataset.emoji);
      return;
    }

    const action = target.closest('[data-act]');

    if (action) {
      event.preventDefault();
      event.stopPropagation();

      switch (action.dataset.act) {
        case 'react':
          if (cpPickerFor === wrap) cpClosePicker();
          else cpOpenPicker(wrap, action);
          break;
        case 'reply':
          cpStartReply(wrap);
          break;
        case 'edit':
          cpStartEdit(wrap);
          break;
        case 'copy':
          cpCopy(wrap);
          break;
        case 'delete':
          if (typeof openDeleteConfirm === 'function') openDeleteConfirm(wrap.dataset.msgid);
          break;
        default:
          break;
      }

      wrap.classList.remove('actions-open');
      return;
    }

    // Сенсорные экраны: тап по сообщению открывает панель действий.
    if (
      window.matchMedia('(hover: none)').matches &&
      !target.closest('a, button, audio, video, img, textarea, .md-spoiler')
    ) {
      const open = !wrap.classList.contains('actions-open');
      container.querySelectorAll('.g-msg.actions-open').forEach(item => item.classList.remove('actions-open'));
      wrap.classList.toggle('actions-open', open);
    }
  });

  // Двойной клик по сообщению: быстрый ответ, как в десктопных мессенджерах.
  container.addEventListener('dblclick', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('a, button, audio, video, img, textarea, .msg-editor')) return;
    if (window.getSelection()?.toString()) return;

    const wrap = target.closest('.g-msg[data-msgid]');
    if (wrap && !wrap.classList.contains('deleted')) {
      window.getSelection()?.removeAllRanges();
      cpStartReply(wrap);
    }
  });
}

async function cpCopy(wrap) {
  const text = String(wrap._msg?.text || '');
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    cpNotice('Текст скопирован');
  } catch (_) {
    cpNotice('Не удалось скопировать');
  }
}

/* ── «Печатает…» ─────────────────────────────────────────────────────────── */

function cpTypingPayload(key, isTyping) {
  if (!key) return null;

  const [kind, target] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];

  return kind === 'group'
    ? { groupId: target, isTyping }
    : { toId: target, isTyping };
}

function chatPlusStopTyping() {
  clearTimeout(cpTyping.idleTimer);
  cpTyping.idleTimer = null;

  if (cpTyping.key && cpTyping.sentAt && socket?.connected) {
    const payload = cpTypingPayload(cpTyping.key, false);
    if (payload) socket.emit('typing', payload);
  }

  cpTyping.key = null;
  cpTyping.sentAt = 0;
}

window.chatPlusStopTyping = chatPlusStopTyping;

function cpOnComposerInput(group) {
  const input = document.getElementById(group ? 'group-msg-input' : 'msg-input');
  const key = cpActiveKey(group);
  if (!input || !key || !socket?.connected || !state.me) return;

  if (!input.value.trim()) {
    chatPlusStopTyping();
    return;
  }

  if (cpTyping.key && cpTyping.key !== key) chatPlusStopTyping();

  const now = Date.now();

  if (cpTyping.key !== key || now - cpTyping.sentAt > CP_TYPING_SEND_MS) {
    const payload = cpTypingPayload(key, true);
    if (payload) socket.emit('typing', payload);
    cpTyping.key = key;
    cpTyping.sentAt = now;
  }

  clearTimeout(cpTyping.idleTimer);
  cpTyping.idleTimer = setTimeout(chatPlusStopTyping, CP_TYPING_IDLE_MS);
}

function cpTypingNames(key) {
  const typers = cpTypers.get(key);
  if (!typers || !typers.size) return [];

  const group = key.startsWith('group:');
  return [...typers.keys()].map(id => cpName(id, group));
}

function cpRenderTyping() {
  for (const group of [false, true]) {
    const wrap = cpComposerWrap(group);
    if (!wrap) continue;

    const key = cpActiveKey(group);
    const names = key ? cpTypingNames(key) : [];
    let indicator = wrap.querySelector(':scope > .typing-indicator');

    if (!indicator) {
      indicator = cpEl('div', 'typing-indicator');
      indicator.setAttribute('aria-live', 'polite');
      wrap.prepend(indicator);
    }

    if (!names.length) {
      indicator.classList.remove('show');
      indicator.textContent = '';
      continue;
    }

    let label;

    if (!group) label = 'печатает';
    else if (names.length === 1) label = `${names[0]} печатает`;
    else if (names.length === 2) label = `${names[0]} и ${names[1]} печатают`;
    else label = `${names.length} участника печатают`;

    indicator.replaceChildren(
      cpEl('span', 'typing-dots'),
      cpEl('span', 'typing-text', group ? label : `${cpName(key.slice(3), false)} ${label}`),
    );

    indicator.firstChild.append(cpEl('i'), cpEl('i'), cpEl('i'));
    indicator.classList.add('show');
  }

  cpRenderSidebarTyping();
}

function cpRenderSidebarTyping() {
  document.querySelectorAll('.friend-item[data-fid]').forEach(item => {
    item.classList.toggle('is-typing', !!cpTypers.get(`dm:${item.dataset.fid}`)?.size);
  });
}

function cpReceiveTyping(payload) {
  if (!payload || typeof payload !== 'object' || !state.me) return;

  const from = cpId(payload.from);
  if (!from || from === String(state.me.id)) return;

  const key = payload.groupId ? `group:${payload.groupId}` : `dm:${from}`;
  let typers = cpTypers.get(key);

  if (!typers) {
    typers = new Map();
    cpTypers.set(key, typers);
  }

  clearTimeout(typers.get(from));

  if (payload.isTyping) {
    typers.set(from, setTimeout(() => {
      typers.delete(from);
      cpRenderTyping();
    }, CP_TYPING_EXPIRE_MS));
  } else {
    typers.delete(from);
  }

  cpRenderTyping();
}

function cpClearTyper(key, from) {
  const typers = cpTypers.get(key);
  if (!typers?.has(from)) return;

  clearTimeout(typers.get(from));
  typers.delete(from);
  cpRenderTyping();
}

/* ── Кнопка «к последним сообщениям» ─────────────────────────────────────── */

function cpSetupJump(containerId) {
  const container = document.getElementById(containerId);
  if (!container || container._cpJump) return;

  const host = container.parentElement;
  const button = cpEl('button', 'jump-latest');
  const badge = cpEl('span', 'jump-latest-badge');

  button.type = 'button';
  button.title = 'К последним сообщениям';
  button.setAttribute('aria-label', 'К последним сообщениям');
  button.innerHTML = CP_ICON.down;
  button.appendChild(badge);
  host.appendChild(button);

  let unseen = 0;

  const sync = () => {
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const away = distance > 240;

    if (!away) unseen = 0;

    button.classList.toggle('show', away);
    badge.textContent = unseen > 99 ? '99+' : String(unseen || '');
    badge.hidden = !unseen;
  };

  container.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });

  button.addEventListener('click', () => {
    unseen = 0;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    sync();
  });

  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof HTMLElement &&
          node.classList.contains('g-msg') &&
          !node.classList.contains('mine') &&
          node === container.lastElementChild &&
          button.classList.contains('show')
        ) {
          unseen++;
        }

        if (node instanceof HTMLElement && node.classList.contains('g-msg')) {
          const group = containerId === 'group-messages';
          const key = cpActiveKey(group);
          if (key && node.dataset.sender) cpClearTyper(key, node.dataset.sender);
        }
      }
    }

    sync();
  }).observe(container, { childList: true });

  container._cpJump = { sync, reset: () => { unseen = 0; sync(); } };
}

/* ── Переключение чатов ──────────────────────────────────────────────────── */

let cpRevision = null;

function chatPlusChatOpened(group) {
  if (cpRevision !== state.sessionRevision) {
    cpRevision = state.sessionRevision;
    cpReplies.clear();
    for (const typers of cpTypers.values()) {
      for (const timer of typers.values()) clearTimeout(timer);
    }
    cpTypers.clear();
  }

  cpCancelEdit({ focus: false });
  cpClosePicker();

  if (cpTyping.key && cpTyping.key !== cpActiveKey(group)) chatPlusStopTyping();

  cpRenderComposerContext(false);
  cpRenderComposerContext(true);
  cpRenderTyping();

  const container = document.getElementById(group ? 'group-messages' : 'messages');
  container?._cpJump?.reset();
}

window.chatPlusChatOpened = chatPlusChatOpened;

/* ── Клавиатура ──────────────────────────────────────────────────────────── */

function cpLastOwnMessage(group) {
  const container = document.getElementById(group ? 'group-messages' : 'messages');
  if (!container) return null;

  const own = [...container.querySelectorAll('.g-msg.mine[data-msgid]:not(.deleted)')];
  return own.reverse().find(wrap => wrap.querySelector('[data-act="edit"]')) || null;
}

for (const group of [false, true]) {
  const id = group ? 'group-msg-input' : 'msg-input';

  on(id, 'input', () => cpOnComposerInput(group));
  on(id, 'blur', () => {
    const input = document.getElementById(id);
    if (!input?.value.trim()) chatPlusStopTyping();
  });

  on(id, 'keydown', event => {
    const input = event.currentTarget;

    if (event.key === 'Escape' && !event.isComposing) {
      const key = cpActiveKey(group);

      if (key && cpReplies.has(key)) {
        event.preventDefault();
        event.stopPropagation();
        cpReplies.delete(key);
        cpRenderComposerContext(group);
      }

      return;
    }

    if (
      event.key === 'ArrowUp' &&
      !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
      !input.value
    ) {
      const wrap = cpLastOwnMessage(group);

      if (wrap) {
        event.preventDefault();
        wrap.scrollIntoView({ block: 'nearest' });
        cpStartEdit(wrap);
      }
    }
  });
}

document.addEventListener('pointerdown', event => {
  const picker = document.getElementById('cp-react-picker');

  if (
    picker && !picker.hidden &&
    !picker.contains(event.target) &&
    !(event.target instanceof Element && event.target.closest('[data-act="react"]'))
  ) {
    cpClosePicker();
  }

  if (!(event.target instanceof Element) || !event.target.closest('.g-msg')) {
    document.querySelectorAll('.g-msg.actions-open').forEach(item => item.classList.remove('actions-open'));
  }
}, { passive: true });

window.addEventListener('resize', cpClosePicker, { passive: true });

/* ── Сокет ───────────────────────────────────────────────────────────────── */

function cpOnSocket(event, handler) {
  if (typeof auOnSocket === 'function') {
    auOnSocket(event, handler);
    return;
  }

  socket.on(event, payload => {
    if (!state.me) return;

    try {
      handler(payload);
    } catch (error) {
      console.warn(`[chat-plus] ${event}`, error);
    }
  });
}

cpOnSocket('messageEdited', cpApplyEdit);
cpOnSocket('messageReactions', cpApplyReactions);
cpOnSocket('typing', cpReceiveTyping);
cpOnSocket('messageDeleted', payload => {
  const id = cpId(payload?.messageId);
  if (!id) return;

  if (cpEditing?.wrap.dataset.msgid === id) cpCancelEdit({ focus: false });
  if (cpPickerFor?.dataset.msgid === id) cpClosePicker();

  for (const wrap of cpWraps(id)) {
    wrap._msg = wrap._msg ? { ...wrap._msg, deleted: true, reactions: {} } : wrap._msg;
    wrap.querySelector(':scope > .msg-actions')?.remove();
    wrap.querySelector('.msg-reactions')?.remove();
    wrap.querySelector('.msg-reply')?.remove();
    wrap.querySelector('.msg-edited')?.remove();
    wrap.querySelectorAll('.message-audio, .message-video, .message-file').forEach(node => node.remove());
  }

  document.querySelectorAll(`.msg-reply[data-reply-id="${CSS.escape(id)}"]`).forEach(quote => {
    quote.classList.add('is-deleted');
    const text = quote.querySelector('.msg-reply-text');
    if (text) text.textContent = 'Сообщение удалено';
  });

  for (const [key, reply] of cpReplies) {
    if (reply.id === id) {
      cpReplies.delete(key);
      cpRenderComposerContext(key.startsWith('group:'));
    }
  }
});

socket.on('disconnect', () => {
  for (const typers of cpTypers.values()) {
    for (const timer of typers.values()) clearTimeout(timer);
  }

  cpTypers.clear();
  cpTyping.key = null;
  cpTyping.sentAt = 0;
  cpRenderTyping();
});

whenDomReady(() => {
  cpBindContainer('messages');
  cpBindContainer('group-messages');
  cpSetupJump('messages');
  cpSetupJump('group-messages');

  const friends = document.getElementById('friends-list');
  if (friends) new MutationObserver(cpRenderSidebarTyping).observe(friends, { childList: true });
});
