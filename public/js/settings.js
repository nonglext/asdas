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
on('settings-modal', 'click', event => {
  if (event.target === $('settings-modal')) closeSettings();
});

document.querySelectorAll('input[name="app-theme"]').forEach(input => {
  input.addEventListener('change', () => {
    if (input.checked) applyAppTheme(input.value, true);
  });
});

applyAppTheme(currentAppTheme());
