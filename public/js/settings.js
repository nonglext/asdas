'use strict';

const THEME_STORAGE_KEY = 'chatapp_theme';
const APP_THEMES = new Set(['gray', 'white']);

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
  const accountStatus = document.getElementById('settings-account-status');
  const accountBio = document.getElementById('settings-account-bio');
  if (user) {
    if (name) name.textContent = user.nickname || user.id || 'Профиль';
    if (accountName) accountName.textContent = user.nickname || user.id || '—';
    if (accountStatus) accountStatus.textContent = user.status || 'Активен';
    if (accountBio) accountBio.textContent = user.bio || 'Не заполнено';
    if (avatar && typeof renderAv === 'function') renderAv(avatar, user.nickname || user.id, user.avatar || null);
  }
  syncThemeControls();
  const status = document.getElementById('settings-status');
  if (status) status.textContent = 'Тема сохраняется на этом устройстве';
  setDisplay('settings-modal', 'flex');
}

function closeSettings() {
  setDisplay('settings-modal', 'none');
}

on('btn-settings', 'click', event => {
  event.stopPropagation();
  openSettings();
});
on('btn-close-settings', 'click', closeSettings);
on('btn-close-settings-top', 'click', closeSettings);
on('settings-modal', 'click', event => {
  if (event.target === $('settings-modal')) closeSettings();
});

document.querySelectorAll('input[name="app-theme"]').forEach(input => {
  input.addEventListener('change', () => {
    if (input.checked) applyAppTheme(input.value, true);
  });
});

applyAppTheme(currentAppTheme());


document.querySelectorAll('[data-settings-section]').forEach(button => {
  button.addEventListener('click', () => {
    const section = button.dataset.settingsSection;
    document.querySelectorAll('[data-settings-section]').forEach(item => item.classList.toggle('active', item === button || item.dataset.settingsSection === section && item.classList.contains('settings-subitem')));
    document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === section));
    const title = document.getElementById('settings-title');
    const crumb = document.getElementById('settings-current-section');
    const labels = { account: 'Информация об аккаунте', security: 'Пароль и безопасность', privacy: 'Конфиденциальность', notifications: 'Уведомления', appearance: 'Темы' };
    if (title) title.textContent = labels[section] || 'Настройки';
    if (crumb) crumb.textContent = section === 'appearance' ? 'Оформление' : section === 'account' || section === 'security' ? 'Аккаунт' : labels[section] || 'Настройки';
  });
});


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
