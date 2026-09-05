
'use strict';
(() => {
  let active = null, previous = null;
  const visible = el => el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  const focusable = modal => [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(visible);
  const sync = () => {
    const next = [...document.querySelectorAll('.modal-overlay')].filter(visible).at(-1) || null;
    if (next === active) return;
    if (active) active.removeAttribute('aria-modal');
    if (!active && next) previous = document.activeElement;
    active = next;
    document.querySelectorAll('.screen').forEach(el => { el.inert = !!active; });
    if (active) {
      active.setAttribute('role', 'dialog'); active.setAttribute('aria-modal', 'true');
      active.tabIndex = -1;
      (focusable(active)[0] || active).focus({ preventScroll: true });
    } else if (visible(previous)) previous.focus({ preventScroll: true });
  };
  const observer = new MutationObserver(sync);
  document.querySelectorAll('.modal-overlay').forEach(el => observer.observe(el, { attributes: true, attributeFilter: ['style', 'class'] }));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || !active) return;
    const items = focusable(active), first = items[0], last = items.at(-1);
    if (!first) { e.preventDefault(); active.focus(); return; }
    if (e.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  sync();
})();
