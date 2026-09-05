'use strict';

/**
 * Загрузчик слоёв приложения.
 * Файлы скачиваются ПАРАЛЛЕЛЬНО, но выполняются строго по порядку (async = false).
 * При ошибке показывает понятное сообщение вместо пустого экрана.
 */
(function bootstrap() {
  const VERSION = '1'; // поменяй при деплое, чтобы сбросить кэш браузера
  const SCRIPTS = ['/js/core.js', '/js/auth-ui.js', '/js/chat-ui.js', '/js/calls.js'];

  if (window.__chatappBooted) return; // защита от двойного подключения app.js
  window.__chatappBooted = true;

  if (typeof window.io !== 'function') {
    return fail('Не загрузился socket.io — проверь, что сервер запущен и отдаёт /socket.io/socket.io.js');
  }

  const loads = SCRIPTS.map(src => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${src}?v=${VERSION}`;
    s.async = false; // ← ключевое: порядок выполнения = порядок вставки, загрузка параллельная
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.appendChild(s);
  }));

  Promise.all(loads).catch(err => fail(err.message));

  function fail(message) {
    console.error('ChatApp failed to initialize:', message);
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999', 'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center', 'gap:12px', 'padding:24px', 'text-align:center',
      'background:#313338', 'color:#dbdee1', 'font:15px/1.4 system-ui,sans-serif',
    ].join(';');
    box.innerHTML =
      '<div style="font-size:20px;font-weight:600;color:#f2f3f5">Не удалось запустить ChatApp</div>' +
      `<div style="color:#b5bac1;max-width:420px">${escapeHtml(message)}</div>` +
      '<button type="button" style="margin-top:8px;padding:10px 20px;border:0;border-radius:3px;background:#5865f2;color:#fff;font:inherit;font-weight:500;cursor:pointer">Обновить страницу</button>';
    box.querySelector('button').addEventListener('click', () => location.reload());
    document.body.appendChild(box);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();