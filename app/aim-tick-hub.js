// Shared per-frame hook for shell scripts. app/main.js serves the game's frame loop with
//   window.__aimTick?.(state); window.__aimTickHub?.emit(state);
// once per rendered frame (state = the sim snapshot: player.position, yaw, pitch, tick, ...).
// window.__aimTick stays a plain property for the shot graph (shooting-error.js assigns it).
// New scripts call window.__aimTickHub.add(fn) instead of replacing window.__aimTick.
// A listener that throws is logged once and never blocks the others.
(() => {
  if (window.__aimTickHub) return;
  const listeners = new Set();
  const reported = new WeakSet();
  window.__aimTickHub = {
    add(fn) {
      if (typeof fn === "function") listeners.add(fn);
      return () => listeners.delete(fn);
    },
    remove(fn) { listeners.delete(fn); },
    emit(state) {
      for (const fn of listeners) {
        try { fn(state); } catch (err) {
          if (!reported.has(fn)) { reported.add(fn); console.error("AIM TICK HUB:", err); }
        }
      }
    },
  };
})();
