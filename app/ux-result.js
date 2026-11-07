/* Result card container for other teams' additions (training's routine bar, etc.).
   Whenever the run result shows (.al-result-overlay .al-run-body > .al-run-actions), one empty
   div.ux-result-extra is placed above the buttons, or above feel's shot summary
   (.es-shotgraph-sum) when that sits right above the buttons. So the order is always
   [other rows] [ux-result-extra] [es-shotgraph-sum?] [buttons], whichever script runs first.
   An existing container is never moved. Each new container fires
   window "ux-result-extra" with detail.el; window.__aimUxResult.extra() returns the current one.
   The container is empty until someone fills it; CSS hides it while empty
   (theme-esports.css, "result card container").

   place(doc) is pure DOM work and tested in node (scripts/test-ux-result-theme.mjs). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root && root.document) api.install(root, root.document);
})(globalThis, function () {
  "use strict";

  const ACTIONS = ".al-result-overlay .al-run-body > .al-run-actions";
  const CLASS = "ux-result-extra";

  function hasClass(el, c) {
    return !!(el && el.classList && el.classList.contains(c));
  }

  function directExtra(parent) {
    for (const c of parent.children || []) if (hasClass(c, CLASS)) return c;
    return null;
  }

  /* Returns the new container, or null when nothing was inserted. */
  function place(doc) {
    if (!doc.querySelector(".al-result-overlay")) return null;
    const actions = doc.querySelector(ACTIONS);
    if (!actions) return null;
    const body = actions.parentElement;
    if (!body || directExtra(body)) return null;
    const prev = actions.previousElementSibling;
    const anchor = hasClass(prev, "es-shotgraph-sum") ? prev : actions;
    const el = doc.createElement("div");
    el.className = CLASS;
    body.insertBefore(el, anchor);
    return el;
  }

  function current(doc) {
    const actions = doc.querySelector(ACTIONS);
    return actions && actions.parentElement ? directExtra(actions.parentElement) : null;
  }

  function install(win, doc) {
    if (win.__aimUxResult) return;
    win.__aimUxResult = { extra: () => current(doc) };
    const sync = () => {
      const el = place(doc);
      if (el) win.dispatchEvent(new win.CustomEvent("ux-result-extra", { detail: { el } }));
    };
    if (typeof win.__aimWatchPage === "function") win.__aimWatchPage(sync, { childList: true, subtree: true });
    sync();
  }

  return { install, place, current };
});
