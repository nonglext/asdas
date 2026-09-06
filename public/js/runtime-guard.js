'use strict';
// A runtime exception must never hide an already authenticated workspace.
(() => {
  function report() {
    const show = () => {
      const running = document.getElementById('app-screen')?.classList.contains('active');
      if (!running) {
        document.documentElement.classList.remove('has-session');
        const box = document.getElementById('auth-error');
        if (box) box.textContent = 'Не удалось загрузить приложение. Обновите страницу. Если ошибка повторится, проверьте, что сервер и интерфейс обновлены вместе.';
        return;
      }
      if (document.getElementById('runtime-notice')) return;
      const notice = document.createElement('div');
      notice.id = 'runtime-notice';
      notice.className = 'runtime-notice';
      notice.setAttribute('role', 'alert');
      const text = document.createElement('span');
      text.textContent = 'Возникла ошибка интерфейса. Если действие не сработало, повторите его.';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Закрыть';
      dismiss.addEventListener('click', () => notice.remove());
      notice.append(text, dismiss);
      document.body.appendChild(notice);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
    else show();
  }
  window.addEventListener('error', event => {
    // Broken images are handled by their own fallback, not a global crash screen.
    if (event.target instanceof HTMLScriptElement || event.message) report();
  }, true);
  window.addEventListener('unhandledrejection', event => {
    if (event.reason?.name !== 'AbortError') report();
  });
})();
