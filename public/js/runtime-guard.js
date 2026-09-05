
'use strict';
window.addEventListener('error', event => {
  const scriptFailure = event.target instanceof HTMLScriptElement;
  if (!scriptFailure && !event.message) return;
  document.documentElement.classList.remove('has-session');
  const show = () => {
    const box = document.getElementById('auth-error');
    if (box) box.textContent = 'Не удалось загрузить приложение. Обновите страницу. Если ошибка повторится, проверьте, что сервер и файлы интерфейса обновлены вместе.';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
  else show();
}, true);
