'use strict';

const THEME_STORAGE_KEY = 'chatapp_theme';
const APP_THEMES = new Set(['gray', 'white']);

let voiceCheck = null;

function formatDb(value) { return `${String(value).replace('-', '−')} dBFS`; }
function voiceMeterPercent(db) { return Math.max(0, Math.min(100, (db + 70) / 70 * 100)); }

function renderVoiceCheck(level, active) {
  const meter = $('voice-meter');
  meter.style.setProperty('--voice-level', `${level === null ? 0 : voiceMeterPercent(level)}%`);
  meter.classList.toggle('is-active', active);
  const output = $('voice-meter-value');
  const text = level === null ? '—' : formatDb(Math.round(level));
  if (output.textContent !== text) output.textContent = text;
}

function stopVoiceCheck(message = 'Запустите проверку и скажите пару слов.') {
  if (!voiceCheck) return;
  const check = voiceCheck;
  voiceCheck = null;
  clearInterval(check.timer);
  check.source?.disconnect();
  check.stream?.getTracks().forEach(track => track.stop());
  if (check.context && check.context.state !== 'closed') check.context.close().catch(() => {});
  renderVoiceCheck(null, false);
  $('voice-check-toggle').textContent = 'Проверить микрофон';
  $('voice-check-status').textContent = message;
}

async function startVoiceCheck() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const status = $('voice-check-status');
  if (!AudioContextClass) {
    status.textContent = 'Этот браузер не поддерживает проверку микрофона.';
    return;
  }
  const check = {};
  voiceCheck = check;
  $('voice-check-toggle').textContent = 'Остановить проверку';
  status.textContent = 'Подключаем микрофон…';
  try {
    const trackInCall = callState.active && callState.localStream?.getAudioTracks().find(isLiveTrack);
    if (callState.active && (!trackInCall || !callState.micOn || !trackInCall.enabled)) {
      stopVoiceCheck('Сначала включите микрофон в звонке.');
      return;
    }
    check.context = new AudioContextClass();
    const resumed = check.context.resume().then(() => true, () => false);
    let track = trackInCall;
    if (!track) {
      if (!navigator.mediaDevices?.getUserMedia) {
        stopVoiceCheck('Микрофон недоступен. Откройте сайт по HTTPS.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: getCallAudioConstraints() });
      if (voiceCheck !== check) {
        stream.getTracks().forEach(item => item.stop());
        return;
      }
      check.stream = stream;
      [track] = stream.getAudioTracks();
    }
    const running = await resumed;
    if (voiceCheck !== check) return;
    if (!running || !track) throw new Error('Voice check unavailable');
    const analyser = check.context.createAnalyser();
    analyser.fftSize = 2048;
    check.source = check.context.createMediaStreamSource(new MediaStream([track]));
    check.source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const activity = createVoiceActivity();
    status.textContent = 'Скажите пару слов обычным голосом.';
    const tick = () => {
      if (!isLiveTrack(track) || (trackInCall && (!callState.active || !callState.micOn || !track.enabled))) {
        stopVoiceCheck('Микрофон отключён. Запустите проверку снова.');
        return;
      }
      const level = track.muted || !track.enabled || check.context.state !== 'running' ? null : readVoiceLevelDb(analyser, samples);
      renderVoiceCheck(level, activity(level, getVoiceSpeakingThresholdDb()));
    };
    check.timer = setInterval(tick, 50);
    tick();
  } catch (error) {
    if (voiceCheck !== check) return;
    const problems = {
      NotAllowedError: 'Разрешите этому сайту доступ к микрофону и попробуйте снова.',
      NotFoundError: 'Микрофон не найден. Подключите его и попробуйте снова.',
      NotReadableError: 'Не удалось открыть микрофон. Проверьте, доступен ли он системе.',
    };
    stopVoiceCheck(problems[error.name] || 'Не удалось проверить микрофон. Попробуйте снова.');
  }
}

on('voice-check-toggle', 'click', () => voiceCheck ? stopVoiceCheck() : startVoiceCheck());
const voiceCheckModal = $('settings-modal');
if (voiceCheckModal) {
  new MutationObserver(() => {
    if (voiceCheckModal.style.display === 'none') stopVoiceCheck();
  }).observe(voiceCheckModal, { attributes: true, attributeFilter: ['style'] });
}
window.addEventListener('pagehide', () => stopVoiceCheck());
// sfx.setEnabled существовал с самого начала, но ни одна кнопка его не звала:
// отключить звуки из интерфейса было невозможно.
function syncSoundsControl() {
  const input = document.getElementById('sounds-enabled');
  if (input && typeof sfx !== 'undefined') input.checked = sfx.enabled();
}

function syncVoiceThresholdControl() {
  const input = document.getElementById('voice-threshold');
  const output = document.getElementById('voice-threshold-value');
  if (!input || !output) return;
  const value = window.getVoiceSpeakingThresholdDb?.() ?? -48;
  input.value = String(value);
  output.textContent = formatDb(value);
  $('voice-meter')?.style.setProperty('--voice-threshold', `${voiceMeterPercent(value)}%`);
}

function currentAppTheme() {
  return APP_THEMES.has(document.documentElement.dataset.theme)
    ? document.documentElement.dataset.theme
    : 'white';
}

function saveAppTheme(theme) {
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (_) {}
}

function syncThemeControls() {
  const theme = currentAppTheme();
  document.querySelectorAll('input[name="app-theme"]').forEach(input => {
    input.checked = input.value === theme;
  });
}

function applyAppTheme(theme, announce = false) {
  const next = APP_THEMES.has(theme) ? theme : 'white';
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content', next === 'gray' ? '#2f3136' : '#f4f2f8',
  );
  saveAppTheme(next);
  syncThemeControls();

  if (announce) {
    const status = document.getElementById('settings-status');
    if (status) {
      status.textContent = next === 'gray'
        ? 'Серая тема включена'
        : 'Белая тема включена';
    }
  }
}

function openSettings() {
  const user = window.state?.me;
  const avatar = document.getElementById('settings-user-avatar');
  const name = document.getElementById('settings-user-name');
  const accountName = document.getElementById('settings-account-name');
  const accountId = document.getElementById('settings-account-id');
  const accountStatus = document.getElementById('settings-account-status');
  const accountBio = document.getElementById('settings-account-bio');
  if (user) {
    if (name) name.textContent = user.nickname || user.id || 'Профиль';
    if (accountName) accountName.textContent = user.nickname || user.id || '—';
    if (accountId) accountId.textContent = user.id ? `@${user.id}` : '—';
    if (accountStatus) accountStatus.textContent = user.status || 'Активен';
    if (accountBio) accountBio.textContent = user.bio || 'Не заполнено';
    if (avatar && typeof renderAv === 'function') renderAv(avatar, user.nickname || user.id, user.avatar || null);
  }
  syncThemeControls();
  syncVoiceThresholdControl();
  const processing = document.getElementById('voice-processing');
  if (processing) processing.checked = window.voiceProcessingEnabled?.() ?? false;
  syncSoundsControl();
  const search = document.getElementById('settings-search-input');
  if (search) {
    search.value = '';
    search.dispatchEvent(new Event('input'));
  }
  const status = document.getElementById('settings-status');
  if (status) status.textContent = 'Тема сохраняется на этом устройстве';
  setDisplay('settings-modal', 'flex');
}

function closeSettings() {
  stopVoiceCheck();
  setDisplay('settings-modal', 'none');
  document.getElementById('password-change-form')?.reset();
  const message = document.getElementById('password-form-message');
  if (message) message.textContent = '';
}

on('btn-settings-profile', 'click', () => {
  closeSettings();
  openEditProfileModal();
});

on('btn-settings', 'click', event => {
  event.stopPropagation();
  openSettings();
});
on('btn-close-settings', 'click', closeSettings);
on('btn-close-settings-top', 'click', closeSettings);
on('btn-settings-blocked', 'click', () => {
  closeSettings();
  openBlockedUsersModal();
});
on('settings-modal', 'click', event => {
  if (event.target === $('settings-modal')) closeSettings();
});

document.querySelectorAll('input[name="app-theme"]').forEach(input => {
  input.addEventListener('change', () => {
    if (input.checked) applyAppTheme(input.value, true);
  });
});

applyAppTheme(currentAppTheme());

on('sounds-enabled', 'change', event => {
  const enabled = typeof sfx !== 'undefined'
    ? sfx.setEnabled(event.target.checked)
    : event.target.checked;

  const status = document.getElementById('notifications-status');
  if (status) status.textContent = enabled ? 'Звуки включены' : 'Звуки выключены';

  // Короткий сигнал подтверждает, что звук действительно слышно.
  if (enabled && typeof sfx !== 'undefined') sfx.message();
});

on('voice-threshold', 'input', event => {
  window.saveVoiceSpeakingThresholdDb?.(event.target.value);
  syncVoiceThresholdControl();
  const status = document.getElementById('voice-settings-status');
  if (status) status.textContent = 'Порог сохранён на этом устройстве';
});

on('voice-processing', 'change', event => {
  try { localStorage.setItem(VOICE_PROCESSING_KEY, String(event.target.checked)); } catch (_) {}
  const status = document.getElementById('voice-settings-status');
  if (status) status.textContent = 'Режим звука применяется со следующего звонка';
});


document.querySelectorAll('[data-settings-section]').forEach(button => {
  button.addEventListener('click', () => {
    const section = button.dataset.settingsSection;
    if (section !== 'voice') stopVoiceCheck();
    document.querySelectorAll('[data-settings-section]').forEach(item => {
      const selected = item.dataset.settingsSection === section;
      item.classList.toggle('active', selected);
      if (selected) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === section));
    const title = document.getElementById('settings-title');
    const crumb = document.getElementById('settings-current-section');
    const labels = { account: 'Информация об аккаунте', security: 'Пароль и безопасность', privacy: 'Конфиденциальность', notifications: 'Уведомления', voice: 'Голос', appearance: 'Темы' };
    if (title) title.textContent = labels[section] || 'Настройки';
    if (crumb) crumb.textContent = section === 'appearance' ? 'Оформление' : section === 'voice' ? 'Голос' : section === 'account' || section === 'security' ? 'Аккаунт' : labels[section] || 'Настройки';
  });
});

// Search real navigation items, including the nested password section.
const settingsSearch = document.getElementById('settings-search-input');
settingsSearch?.addEventListener('input', () => {
  const query = settingsSearch.value.trim().toLocaleLowerCase('ru');
  const items = [...document.querySelectorAll('.settings-nav [data-settings-section]')];
  const matched = items.filter(item => item.textContent.toLocaleLowerCase('ru').includes(query));
  for (const item of items) {
    const section = item.dataset.settingsSection;
    item.hidden = Boolean(query) && !matched.includes(item) &&
      !(section === 'account' && matched.some(match => match.dataset.settingsSection === 'security'));
  }
  document.querySelectorAll('.settings-subnav').forEach(group => {
    group.hidden = Boolean(query) && ![...group.querySelectorAll('[data-settings-section]')]
      .some(item => !item.hidden);
  });
  const empty = document.getElementById('settings-search-empty');
  if (empty) empty.hidden = !query || matched.length > 0;
  document.querySelectorAll('.settings-nav-divider, .settings-nav-label').forEach(item => { item.hidden = Boolean(query); });
});

settingsSearch?.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const query = settingsSearch.value.trim().toLocaleLowerCase('ru');
  const first = [...document.querySelectorAll('.settings-nav [data-settings-section]:not([hidden])')].find(item => item.textContent.toLocaleLowerCase('ru').includes(query));
  if (first) { event.preventDefault(); first.click(); first.focus(); }
});

function profileColor(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function readProfileCustomization() {
  return {
    pronouns: document.getElementById('edit-pronouns').value.trim(),
    profileColor: profileColor(document.getElementById('edit-profile-color').value, '#5865f2'),
    profileAccent: profileColor(document.getElementById('edit-profile-accent').value, '#9b59b6'),
  };
}

function paintProfileBanner(element, user) {
  if (!element) return;
  element.style.background = `linear-gradient(120deg, ${profileColor(user.profileColor, '#5865f2')}, ${profileColor(user.profileAccent, '#9b59b6')})`;
}

function renderProfileDecoration(user) {
  paintProfileBanner(document.getElementById('profile-modal-banner'), user);
  const pronouns = document.getElementById('profile-modal-pronouns');
  if (pronouns) pronouns.textContent = typeof user.pronouns === 'string' ? user.pronouns : '';
}

function updateProfilePreview() {
  const user = readProfileCustomization();
  paintProfileBanner(document.getElementById('profile-preview-banner'), user);
  for (const [target, value] of Object.entries({
    'profile-preview-name': document.getElementById('edit-nick').value || 'Ваше имя',
    'profile-preview-pronouns': user.pronouns,
    'profile-preview-status': document.getElementById('edit-status').value,
    'profile-preview-bio': document.getElementById('edit-bio').value,
  })) document.getElementById(target).textContent = value;
}

function initProfileCustomization(user) {
  document.getElementById('edit-pronouns').value = user.pronouns || '';
  document.getElementById('edit-profile-color').value = profileColor(user.profileColor, '#5865f2');
  document.getElementById('edit-profile-accent').value = profileColor(user.profileAccent, '#9b59b6');
  updateProfilePreview();
}

for (const id of ['edit-nick', 'edit-status', 'edit-bio', 'edit-pronouns', 'edit-profile-color', 'edit-profile-accent']) {
  on(id, 'input', updateProfilePreview);
}


function showPasswordMessage(text, good = false) {
  const box = document.getElementById('password-form-message');
  if (!box) return;
  box.textContent = text;
  box.className = `settings-form-message${good ? ' is-good' : ' is-error'}`;
}

function openPasswordSection() {
  document.querySelector('[data-settings-section="security"]')?.click();
  setTimeout(() => document.getElementById('current-password')?.focus(), 0);
}

on('btn-open-password', 'click', openPasswordSection);
on('password-change-form', 'submit', event => {
  event.preventDefault();
  const currentPassword = document.getElementById('current-password')?.value || '';
  const newPassword = document.getElementById('new-password')?.value || '';
  const confirmPassword = document.getElementById('confirm-password')?.value || '';
  if (!currentPassword || !newPassword || !confirmPassword) return showPasswordMessage('Заполните все поля');
  if (newPassword.length < 8) return showPasswordMessage('Новый пароль должен содержать минимум 8 символов');
  if (newPassword !== confirmPassword) return showPasswordMessage('Новые пароли не совпадают');
  if (currentPassword === newPassword) return showPasswordMessage('Новый пароль должен отличаться от текущего');

  const button = document.getElementById('btn-save-password');
  button.disabled = true;
  button.textContent = 'Сохраняем…';
  showPasswordMessage('Проверяем пароль…');
  authFetch(`${BACKEND_URL}/api/password/change`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось изменить пароль');
    if (data.token) storage.setItem('chatapp_token', data.token);
    document.getElementById('password-change-form').reset();
    showPasswordMessage('Пароль успешно изменён', true);
  }).catch(error => showPasswordMessage(error.message || 'Не удалось изменить пароль'))
    .finally(() => { button.disabled = false; button.textContent = 'Сохранить новый пароль'; });
});

// Presets edit the draft; persistence still happens only with Save.
document.querySelectorAll('[data-profile-colors]').forEach(button => {
  button.addEventListener('click', () => {
    if (document.getElementById('edit-profile-color').disabled) return;
    const [primary, accent] = button.dataset.profileColors.split(',');
    document.getElementById('edit-profile-color').value = primary;
    document.getElementById('edit-profile-accent').value = accent;
    updateProfilePreview();
  });
});
const previewAvatarSource = document.getElementById('edit-avatar');
if (previewAvatarSource) new MutationObserver(() => {
  const target = document.getElementById('profile-preview-avatar');
  target.replaceChildren(...[...previewAvatarSource.childNodes].map(node => node.cloneNode(true)));
  target.style.background = previewAvatarSource.style.background;
  target.style.setProperty('--avatar-color', previewAvatarSource.style.getPropertyValue('--avatar-color'));
}).observe(previewAvatarSource, { childList: true, subtree: true, attributes: true });
