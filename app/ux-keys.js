/* Result screen and Tab menu keys.
   Result screen: R = Play again, Esc = Back. Tab menu: Q = Quit drill (the menu already shows a
   "Q" hint; the game never handled the key). Each key clicks the game's own button, so the game's
   code runs exactly as on a mouse click. The "R" / "Esc" hints on the buttons are CSS
   (theme-esports.css, "result screen key hints").

   Ignored: key repeats, Ctrl/Alt/Meta (Shift is fine), IME composition, focus in a text field,
   and any key in the first 600 ms after the result appears or while the result card is still
   animating in (players are often still pressing R to reload when a run ends). Esc and Q skip
   events another handler already took (preventDefault): the aim-aids sheet and the preaim
   how-to close on Esc over the result screen. Before a click the button must be on screen, enabled,
   on top at its centre, and not behind an aria-modal dialog (the replay viewer opens over the
   result, which stays in the page).

   decideKey() is pure and tested in node (scripts/test-ux-result.mjs). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root && root.document) api.install(root, root.document);
})(globalThis, function () {
  "use strict";

  const GUARD_MS = 600;
  const RESULT = ".al-result-overlay";
  const RESULT_MODAL = ".al-result-overlay .al-result-modal";
  const BUTTONS = {
    retry: [".al-result-overlay .al-run-actions .al-primary-btn", ".al-result-overlay .al-mr-btn[data-action=retry]"],
    back: [".al-result-overlay .al-run-actions .al-secondary-btn", ".al-result-overlay .al-mr-btn[data-action=exit]"],
    // The full Tab menu only: the pointer-lost panel has another .is-exit button.
    quit: [".al-pause-overlay .al-pause-acts .al-pause-act.is-exit"],
  };
  // R is the reload bind; if the game's input layer marks it handled we still act (the sim is
  // stopped on the result screen). Esc / Q respect other handlers.
  const RESPECT_PREVENTED = { KeyR: false, Escape: true, KeyQ: true };

  /* ev: {code, repeat, ctrlKey, altKey, metaKey, isComposing, defaultPrevented}
     st: {now, resultAt (ms when the result appeared, or null when no result is showing),
          resultBusy (result card still animating in), pauseOpen (full Tab menu showing), editing}
     Returns "retry" | "back" | "quit" | null. */
  function decideKey(ev, st) {
    if (!ev || !st) return null;
    const code = ev.code;
    if (code !== "KeyR" && code !== "Escape" && code !== "KeyQ") return null;
    if (ev.repeat || ev.isComposing || ev.ctrlKey || ev.altKey || ev.metaKey) return null;
    if (st.editing) return null;
    if (ev.defaultPrevented && RESPECT_PREVENTED[code]) return null;
    if (code === "KeyQ") return st.pauseOpen ? "quit" : null;
    if (typeof st.resultAt !== "number" || !Number.isFinite(st.resultAt)) return null;
    if (st.now - st.resultAt < GUARD_MS || st.resultBusy) return null;
    return code === "KeyR" ? "retry" : "back";
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable;
  }

  function canClick(btn, doc) {
    if (!btn || !btn.isConnected || btn.disabled) return false;
    if (!btn.getClientRects().length) return false;
    const r = btn.getBoundingClientRect();
    const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !btn.contains(hit)) return false;
    for (const d of doc.querySelectorAll('[aria-modal="true"]')) {
      if (!d.contains(btn) && d.getClientRects().length) return false;
    }
    return true;
  }

  function findButton(doc, action) {
    for (const sel of BUTTONS[action] || []) {
      const btn = doc.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function install(win, doc) {
    if (win.__aimUxKeys) return;
    win.__aimUxKeys = true;
    const now = () => win.performance.now();
    let phase = null;
    let resultAt = null;

    // Every TrainLayer phase change (not only Round mode) fires this.
    win.addEventListener("aim-round-phase", (e) => {
      phase = e && e.detail ? e.detail.phase : null;
      resultAt = phase === "result" ? now() : null;
    });
    // Fallback in case the event is missed: the overlay itself.
    const sync = () => {
      if (doc.querySelector(RESULT)) {
        if (resultAt === null) resultAt = now();
      } else if (phase !== "result") {
        resultAt = null;
      }
    };
    if (typeof win.__aimWatchPage === "function") win.__aimWatchPage(sync, { childList: true, subtree: true });
    else new win.MutationObserver(sync).observe(doc.documentElement, { childList: true, subtree: true });
    sync();

    const busy = () => {
      const modal = doc.querySelector(RESULT_MODAL);
      if (!modal || typeof modal.getAnimations !== "function") return false;
      return modal.getAnimations().some((a) => a.playState === "running");
    };

    win.addEventListener("keydown", (e) => {
      const code = e.code;
      if (code !== "KeyR" && code !== "Escape" && code !== "KeyQ") return;
      const showing = !!doc.querySelector(RESULT);
      const pauseOpen = code === "KeyQ" && !showing && !!doc.querySelector(BUTTONS.quit[0]);
      if (!showing && !pauseOpen) return;
      const action = decideKey(e, {
        now: now(),
        resultAt: showing ? resultAt : null,
        resultBusy: showing && busy(),
        pauseOpen,
        editing: isEditable(e.target) || isEditable(doc.activeElement),
      });
      if (!action) return;
      const btn = findButton(doc, action);
      if (!canClick(btn, doc)) return;
      e.preventDefault();
      btn.click();
    });
  }

  return { decideKey, canClick, findButton, isEditable, install, GUARD_MS, BUTTONS, RESPECT_PREVENTED };
});
