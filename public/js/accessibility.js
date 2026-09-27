'use strict';
(() => {
  const dialogs = [...document.querySelectorAll('.modal-overlay')];
  const stack = [], returnFocus = new Map();
  let active = null, rootFocus = null;
  const visible = el => !!el && el.isConnected && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
  const focusable = modal => [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')].filter(el => visible(el) && !el.closest('[inert]'));
  const sync = () => {
    const previous = active;
    // Opening order, not DOM order, determines which dialog is on top.
    for (let i = stack.length - 1; i >= 0; i--) if (!visible(stack[i])) stack.splice(i, 1);
    for (const modal of dialogs) if (visible(modal) && !stack.includes(modal)) {
      if (!previous && !stack.length) rootFocus = document.activeElement;
      returnFocus.set(modal, document.activeElement);
      stack.push(modal);
    }
    active = stack.at(-1) || null;
    document.querySelectorAll('.screen').forEach(el => { el.inert = !!active; });
    dialogs.forEach(el => {
      el.inert = !!active && el !== active;
      if (el === active) el.setAttribute('aria-modal', 'true');
      else el.removeAttribute('aria-modal');
      const position = stack.indexOf(el);
      const z = position < 0 ? '' : `calc(var(--z-modal) + ${position})`;
      // Comparing first avoids a style-observer feedback loop.
      if (el.style.zIndex !== z) el.style.zIndex = z;
    });
    if (active === previous) return;
    const restore = previous ? returnFocus.get(previous) : null;
    for (const modal of returnFocus.keys()) if (!visible(modal)) returnFocus.delete(modal);
    if (active) {
      // Preserve alertdialog for incoming calls.
      if (!active.hasAttribute('role')) active.setAttribute('role', 'dialog');
      active.tabIndex = -1;
      const target = visible(restore) && active.contains(restore) ? restore : (focusable(active)[0] || active);
      target.focus({ preventScroll: true });
    } else {
      const target = visible(restore) && !restore.closest('[inert]') ? restore : rootFocus;
      if (visible(target) && !target.closest('[inert]')) target.focus({ preventScroll: true });
      rootFocus = null;
    }
  };
  const observer = new MutationObserver(sync);
  dialogs.forEach(el => observer.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] }));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || !active) return;
    const items = focusable(active), first = items[0], last = items.at(-1);
    if (!first) { e.preventDefault(); active.focus(); return; }
    if (e.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  sync();
})();
