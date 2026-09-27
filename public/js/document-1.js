(function () {
  var mq = window.matchMedia('(max-width: 640px)');
  var sidebar = document.querySelector('.sidebar');
  var wins = [document.getElementById('chat-window'), document.getElementById('group-chat-window')].filter(Boolean);
  var panel = document.getElementById('group-members-panel');
  var backdrop = document.querySelector('.members-backdrop');

  function chatOpen() {
    return wins.some(function (w) { return w.style.display !== 'none' && getComputedStyle(w).display !== 'none'; });
  }
  function sync() {
    if (!sidebar) return;
    var open = mq.matches && chatOpen();
    sidebar.classList.toggle('hidden', open);
    // На мобилке при открытии чата панель участников по умолчанию скрыта
    if (mq.matches && open && panel && !panel.dataset.userOpened) panel.classList.add('hidden');
    if (!mq.matches && panel) delete panel.dataset.userOpened;
  }

  if ('MutationObserver' in window) {
    var mo = new MutationObserver(sync);
    wins.forEach(function (w) { mo.observe(w, { attributes: true, attributeFilter: ['style', 'class'] }); });
  }
  if (mq.addEventListener) mq.addEventListener('change', sync); else mq.addListener(sync);
  window.addEventListener('resize', sync);
  sync();

  // Пользователь явно открыл/закрыл панель участников
  var toggle = document.getElementById('btn-toggle-members');
  if (toggle && panel) toggle.addEventListener('click', function () {
    setTimeout(function () {
      if (panel.classList.contains('hidden')) delete panel.dataset.userOpened;
      else panel.dataset.userOpened = '1';
    }, 0);
  });
  if (backdrop && panel) backdrop.addEventListener('click', function () {
    panel.classList.add('hidden');
    delete panel.dataset.userOpened;
  });

  // Esc закрывает панель участников на мобилке (модалки закрываются своим кодом)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mq.matches && panel && !panel.classList.contains('hidden')) {
      panel.classList.add('hidden'); delete panel.dataset.userOpened;
    }
  });
})();
