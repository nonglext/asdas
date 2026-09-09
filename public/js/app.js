'use strict';

/* ============================================================================
 * APP BOOTSTRAP
 *
 * Подключение в HTML:
 *
 * <script src="/socket.io/socket.io.js" defer></script>
 * <script src="/js/app.js?v=1.7.1" defer></script>
 *
 * core.js / auth-ui.js / chat-ui.js / calls.js отдельно в HTML не подключать.
 *
 * Preload позволяет браузеру заранее скачать файлы.
 * Выполнение слоёв — строго последовательное.
 * ========================================================================== */

(function bootstrap() {
  const VERSION = '1.7.1';
  const SCRIPT_TIMEOUT_MS = 30_000;

  const SCRIPTS = Object.freeze([
    '/js/core.js',
    '/js/auth-ui.js',
    '/js/chat-ui.js',
    '/js/calls.js',
  ]);

  const ERROR_ELEMENT_ID = 'chatapp-bootstrap-error';

  /*
   * Проверяем и новый маркер, и маркер старой версии загрузчика.
   * Повторная инициализация classic scripts с const/let недопустима.
   */
  if (window.__chatappBootstrap || window.__chatappBooted) return;

  const boot = {
    version: VERSION,
    status: 'loading',
    currentScript: null,
    loadedScripts: [],
    error: null,
    startedAt: Date.now(),
    completedAt: null,
  };

  window.__chatappBootstrap = boot;
  window.__chatappBooted = false;

  const preloads = [];
  const scriptUrls = SCRIPTS.map(path => {
    const url = new URL(path, window.location.href);
    url.searchParams.set('v', VERSION);
    return url.href;
  });

  let activeLoad = null;

  function normalizeUrl(value) {
    if (!value) return '';

    try {
      const url = new URL(value, window.location.href);
      url.hash = '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function displayPath(value) {
    try {
      return new URL(value, window.location.href).pathname;
    } catch (_) {
      return String(value || 'неизвестный файл');
    }
  }

  function createBootError(message, cause) {
    const error = new Error(message);

    if (cause !== undefined) {
      error.cause = cause;
    }

    return error;
  }

  function waitForDom() {
    if (document.readyState !== 'loading') {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', resolve, {
        once: true,
      });
    });
  }

  function createPreloads() {
    const parent = document.head || document.documentElement;
    if (!parent) return;

    for (const url of scriptUrls) {
      const link = document.createElement('link');

      link.rel = 'preload';
      link.as = 'script';
      link.href = url;
      link.dataset.chatappPreload = VERSION;

      /*
       * Ошибка preload не считается окончательной:
       * основной <script> ещё может успешно загрузиться.
       */
      parent.appendChild(link);
      preloads.push(link);
    }
  }

  function removePreloads() {
    for (const link of preloads) {
      link.remove();
    }

    preloads.length = 0;
  }

  /*
   * Событие load у <script> не гарантирует отсутствие SyntaxError/ReferenceError.
   * Синхронные ошибки выполнения ловим отдельно через window.error.
   *
   * Ошибки поздних таймеров, обработчиков и Promise не являются надёжно
   * определяемым результатом загрузки файла и обрабатываются самим приложением.
   */
  function onScriptRuntimeError(event) {
    const load = activeLoad;
    if (!load) return;

    if (normalizeUrl(event.filename) !== load.url) return;

    const line = Number.isInteger(event.lineno) && event.lineno > 0
      ? `, строка ${event.lineno}`
      : '';

    const detail = event.error?.message ||
      event.message ||
      'ошибка выполнения JavaScript';

    load.reject(
      createBootError(
        `Ошибка в ${displayPath(load.url)}${line}: ${detail}`,
        event.error,
      ),
    );

    // Не вызываем preventDefault: ошибка остаётся видна в консоли.
  }

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');

      let settled = false;
      let timer = null;

      script.src = url;
      script.async = false;
      script.dataset.chatappLayer = VERSION;

      const load = {
        url: normalizeUrl(url),
        reject: error => finish(error),
      };

      function finish(error = null) {
        if (settled) return;
        settled = true;

        clearTimeout(timer);

        script.onload = null;
        script.onerror = null;

        if (activeLoad === load) {
          activeLoad = null;
        }

        if (error) {
          /*
           * Удаление script не гарантирует отмену уже начатой загрузки
           * или выполнения. Поэтому после ошибки разрешаем только reload,
           * а не повторную вставку слоёв в этот же документ.
           */
          script.remove();
          reject(error);
          return;
        }

        resolve();
      }

      script.onload = () => finish();

      script.onerror = () => {
        finish(createBootError(
          `Не удалось загрузить ${displayPath(url)}. ` +
          'Проверьте соединение, доступность файла и настройки CSP.',
        ));
      };

      timer = setTimeout(() => {
        finish(createBootError(
          `Превышено время ожидания загрузки ${displayPath(url)}. ` +
          'Проверьте соединение и обновите страницу.',
        ));
      }, SCRIPT_TIMEOUT_MS);

      activeLoad = load;
      boot.currentScript = displayPath(url);

      try {
        const parent = document.head || document.documentElement;

        if (!parent) {
          throw new Error('Документ ещё не готов для подключения скриптов');
        }

        parent.appendChild(script);
      } catch (error) {
        finish(createBootError(
          `Не удалось подключить ${displayPath(url)}`,
          error,
        ));
      }
    });
  }

  function renderFailure(error) {
    const mount = () => {
      if (document.getElementById(ERROR_ELEMENT_ID)) return;

      const root = document.createElement('div');

      root.id = ERROR_ELEMENT_ID;
      root.setAttribute('role', 'alertdialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-labelledby', `${ERROR_ELEMENT_ID}-title`);
      root.setAttribute('aria-describedby', `${ERROR_ELEMENT_ID}-message`);

      root.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'box-sizing:border-box',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'gap:14px',
        'padding:24px',
        'overflow:auto',
        'text-align:center',
        'background:#313338',
        'color:#dbdee1',
        'font:15px/1.5 system-ui,sans-serif',
      ].join(';');

      const title = document.createElement('h1');

      title.id = `${ERROR_ELEMENT_ID}-title`;
      title.textContent = 'Не удалось запустить ChatApp';
      title.style.cssText =
        'margin:0;font-size:22px;font-weight:600;color:#f2f3f5';

      const message = document.createElement('p');

      message.id = `${ERROR_ELEMENT_ID}-message`;
      message.textContent = error.message || 'Неизвестная ошибка запуска';
      message.style.cssText =
        'margin:0;max-width:560px;color:#b5bac1;overflow-wrap:anywhere';

      const version = document.createElement('p');

      version.textContent = `Версия приложения: ${VERSION}`;
      version.style.cssText = 'margin:0;font-size:12px;color:#949ba4';

      const reload = document.createElement('button');

      reload.type = 'button';
      reload.textContent = 'Обновить страницу';
      reload.style.cssText = [
        'margin-top:8px',
        'padding:11px 22px',
        'border:0',
        'border-radius:6px',
        'background:#5865f2',
        'color:#fff',
        'font:inherit',
        'font-weight:600',
        'cursor:pointer',
      ].join(';');

      reload.addEventListener('click', () => {
        reload.disabled = true;
        reload.textContent = 'Перезагрузка…';
        window.location.reload();
      });

      root.append(title, message, version, reload);

      /*
       * Не вставляем текст исключения через innerHTML.
       * Ошибка может содержать произвольную строку.
       */
      const parent = document.body || document.documentElement;
      parent.appendChild(root);

      reload.focus({ preventScroll: true });
    };

    if (document.body) {
      mount();
    } else {
      waitForDom().then(mount).catch(error => {
        console.error('[bootstrap] Failed to display error:', error);
      });
    }
  }

  async function run() {
    try {
      /*
       * Скачивание можно начать до готовности DOM.
       * Само выполнение откладываем: некоторые слои сразу ищут элементы.
       */
      createPreloads();
      await waitForDom();

      if (typeof window.io !== 'function') {
        throw createBootError(
          'Не загрузился Socket.IO. Проверьте, что ' +
          '/socket.io/socket.io.js подключён перед app.js ' +
          'и доступен на сервере.',
        );
      }

      window.addEventListener('error', onScriptRuntimeError);

      for (const url of scriptUrls) {
        await loadScript(url);
        boot.loadedScripts.push(displayPath(url));
      }

      boot.status = 'ready';
      boot.currentScript = null;
      boot.completedAt = Date.now();

      window.__chatappBooted = true;

      /*
       * Событие означает, что все файлы выполнили верхнеуровневый код.
       * Оно не означает завершения авторизации или загрузки HTTP-данных.
       */
      window.dispatchEvent(new CustomEvent('chatapp:ready', {
        detail: {
          version: VERSION,
          loadedScripts: [...boot.loadedScripts],
          durationMs: boot.completedAt - boot.startedAt,
        },
      }));

      return boot;
    } catch (cause) {
      const error = cause instanceof Error
        ? cause
        : createBootError(String(cause));

      boot.status = 'failed';
      boot.error = error;
      boot.completedAt = Date.now();

      window.__chatappBooted = false;

      console.error('[bootstrap] ChatApp initialization failed:', error);

      renderFailure(error);

      window.dispatchEvent(new CustomEvent('chatapp:boot-error', {
        detail: {
          version: VERSION,
          script: boot.currentScript,
          message: error.message,
        },
      }));

      throw error;
    } finally {
      window.removeEventListener('error', onScriptRuntimeError);
      removePreloads();
    }
  }

  const ready = run();

  window.__chatappReady = ready;

  /*
   * Ошибка уже показана пользователю.
   * Этот catch предотвращает лишний unhandledrejection, но исходный ready
   * остаётся rejected для кода, который ожидает его самостоятельно.
   */
  ready.catch(() => {});
})();