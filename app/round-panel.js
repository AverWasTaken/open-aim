// Round mode panel: the lobby's "Round (beta)" button (lobby-bar.js) opens it. Pick map, side,
// enemy rank, weapon and barrier time, then Start loads the generated round scene
// (round-<map>-<side>-<weapon>-<barrierSec>, served by main.js from app/round-scene.js) through
// window.__aimLaunchScene (tools/round_patch.py). The rank is the same setting the drills use
// (localStorage "aim-enemy-rank", read by the game when a round starts); "Default" = the round's
// own bots. Last choices are kept in "aim-round-setup".
// It also prefetches the bots' nav graph of every round map (see prefetchNav below).
(() => {
  if (window.__aimRoundPanel) return;
  const SETUP_KEY = "aim-round-setup";
  const RANK_KEY = "aim-enemy-rank";
  const MAPS = [{ id: "ascent", name: "Ascent" }];
  const SIDES = [{ id: "attack", name: "Attack", sub: "Plant the spike" }, { id: "defense", name: "Defense", sub: "Coming soon", off: true }];
  const WEAPONS = [["vandal", "Vandal"], ["phantom", "Phantom"], ["spectre", "Spectre"], ["guardian", "Guardian"], ["sheriff", "Sheriff"], ["marshal", "Marshal"], ["outlaw", "Outlaw"], ["operator", "Operator"]];
  const BARRIERS = [10, 20, 30];
  const NONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5 19 19 5"/></svg>';

  // ---------- nav prefetch ----------
  // The bots' nav graph /aim-rounds/<map>.nav.bin, read by app/mods/aim-rounds/round-bots.mjs from
  // globalThis.__aimRoundNav[map] (ArrayBuffer). Fetched when this script loads and again when the
  // panel opens, so Start can launch right inside the click (the game's fullscreen request needs a
  // user action) and restarts / Play again find it. Start waits only when the fetch is still
  // running. A missing or bad file is remembered (the bots then stand on their setup spots).
  const navState = {}; // map -> "ok" | "missing" | Promise (fetch running)
  function prefetchNav(map) {
    const cache = (globalThis.__aimRoundNav ??= {});
    if (cache[map] instanceof ArrayBuffer) { navState[map] = "ok"; return null; }
    if (navState[map] instanceof Promise) return navState[map];
    const p = fetch(`/aim-rounds/${map}.nav.bin`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => {
        const ok = buf instanceof ArrayBuffer && buf.byteLength >= 12 && String.fromCharCode(...new Uint8Array(buf, 0, 4)) === "RNAV";
        if (ok) cache[map] = buf;
        navState[map] = ok ? "ok" : "missing";
      })
      .catch(() => { navState[map] = "missing"; });
    navState[map] = p;
    return p;
  }
  const prefetchAll = () => { for (const m of MAPS) prefetchNav(m.id); };

  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const ranks = () => window.__aimBots?.RANKS || [];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function setup() {
    let v = {};
    try { v = JSON.parse(get(SETUP_KEY) || "{}") || {}; } catch {}
    const rank = get(RANK_KEY);
    return {
      map: MAPS.some((m) => m.id === v.map) ? v.map : MAPS[0].id,
      side: "attack",
      weapon: WEAPONS.some((w) => w[0] === v.weapon) ? v.weapon : "vandal",
      barrier: BARRIERS.includes(v.barrier) ? v.barrier : 20,
      rank: ranks().some((r) => r[0] === rank) ? rank : "default",
    };
  }

  function style() {
    if (document.getElementById("aim-round-panel-css")) return;
    const s = document.createElement("style");
    s.id = "aim-round-panel-css";
    s.textContent = `
.es-tool.aim-round { width: min(860px, 100%); }
.aim-round-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; align-items: start; margin-bottom: 12px; }
.aim-round-row > h3 { margin: 10px 0 0; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #8b93a3; font-weight: 600; }
.aim-round-opts { display: flex; flex-wrap: wrap; gap: 6px; }
.aim-round-opts .aim-pick-grid { width: 100%; }
.es-tool .es-tool-body button.aim-round-opt { min-height: 40px; padding: 6px 14px; border-radius: 4px; border: 1px solid #2a303c; background: #191d26; color: #e8ebf0; font: inherit; font-size: 13px; cursor: pointer; display: inline-flex; flex-direction: column; align-items: flex-start; justify-content: center; text-align: left; }
.es-tool .es-tool-body button.aim-round-opt small { font-size: 11px; color: #8b93a3; }
.es-tool .es-tool-body button.aim-round-opt.is-active { border-color: #ff4655; background: #2a1a20; box-shadow: inset 3px 0 0 #ff4655; }
.es-tool .es-tool-body button.aim-round-opt:disabled { opacity: .45; cursor: default; }
.es-tool .es-tool-body button.aim-round-opt:not(:disabled):hover { border-color: #4a5262; }
.aim-round-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; padding-top: 12px; border-top: 1px solid #262b35; }
.aim-round-keys { margin: 0; font-size: 12px; color: #8b93a3; line-height: 1.6; }
.aim-round-keys kbd { display: inline-block; min-width: 18px; padding: 0 5px; border: 1px solid #3a4150; border-bottom-width: 2px; border-radius: 3px; background: #11141a; color: #e8ebf0; font: 600 11px/18px inherit; text-align: center; }
.es-tool .es-tool-body button.aim-round-start { min-width: 150px; min-height: 44px; border: 0; border-radius: 4px; background: #ff4655; color: #fff; font: inherit; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; cursor: pointer; }
.es-tool .es-tool-body button.aim-round-start:hover { background: #ff5b68; }
.aim-round-note { min-height: 1.2em; margin: 8px 0 0; font-size: 12px; color: #ffb4ba; }
`;
    document.head.appendChild(s);
  }

  let open = null;
  function close() {
    if (!open) return;
    removeEventListener("keydown", open.onKey, true);
    open.shade.remove();
    open = null;
  }

  function openPanel() {
    close();
    style();
    prefetchAll();
    const cur = setup();
    const shade = document.createElement("div");
    shade.className = "es-tool-shade aim-pick-shade";
    shade.innerHTML = `<section class="es-tool aim-pick aim-round" role="dialog" aria-modal="true" aria-label="Round">
      <header class="es-tool-head"><div><h2>Round (beta)</h2><p>One round against 5 bots. Barriers hold both teams in their spawn area at the start; then plant the spike in a site and keep it alive.</p></div>
      <button type="button" class="es-tool-x" aria-label="Close">✕</button></header>
      <div class="es-tool-body">
        <div class="aim-round-row"><h3>Map</h3><div class="aim-round-opts" data-k="map"></div></div>
        <div class="aim-round-row"><h3>Side</h3><div class="aim-round-opts" data-k="side"></div></div>
        <div class="aim-round-row"><h3>Enemy rank</h3><div class="aim-round-opts" data-k="rank"><div class="aim-pick-top"></div><div class="aim-pick-grid"></div></div></div>
        <div class="aim-round-row"><h3>Weapon</h3><div class="aim-round-opts" data-k="weapon"></div></div>
        <div class="aim-round-row"><h3>Barrier</h3><div class="aim-round-opts" data-k="barrier"></div></div>
        <div class="aim-round-foot">
          <p class="aim-round-keys">Hold <kbd>4</kbd> in a site to plant (4 s) · <kbd>F</kbd> defuses (7 s) · stand still or walk while holding</p>
          <button type="button" class="aim-round-start">Start</button>
        </div>
        <p class="aim-round-note" role="status"></p>
      </div></section>`;
    const note = shade.querySelector(".aim-round-note");
    const opt = (k, value, label, sub, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "aim-round-opt";
      b.dataset.v = String(value);
      b.disabled = !!disabled;
      b.innerHTML = `<span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}`;
      b.classList.toggle("is-active", String(cur[k]) === String(value));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        cur[k] = typeof cur[k] === "number" ? Number(value) : value;
        for (const o of b.parentElement.children) o.classList.toggle("is-active", o === b);
      });
      return b;
    };
    const box = (k) => shade.querySelector(`[data-k="${k}"]`);
    for (const m of MAPS) box("map").append(opt("map", m.id, m.name));
    for (const s of SIDES) box("side").append(opt("side", s.id, s.name, s.sub, s.off));
    for (const [id, name] of WEAPONS) box("weapon").append(opt("weapon", id, name));
    for (const sec of BARRIERS) box("barrier").append(opt("barrier", sec, `${sec} s`));

    // Rank tiles: same look as the rank picker (rank-picker.js).
    const rankTile = (value, label, sub, icon) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "aim-pick-tile";
      b.dataset.pick = value;
      if (value !== "default") b.dataset.rank = value;
      b.innerHTML = `<span class="aim-pick-icon">${icon}</span><span class="aim-pick-text"><span class="aim-pick-name">${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</span>`;
      b.classList.toggle("is-active", cur.rank === value);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        cur.rank = value;
        for (const t of shade.querySelectorAll(".aim-round [data-pick]")) t.classList.toggle("is-active", t === b);
      });
      return b;
    };
    const img = (id) => `<img src="/aim-ranks/${id}.png" alt="" draggable="false">`;
    shade.querySelector(".aim-pick-top").append(rankTile("default", "Default", "Round's own bots", NONE_ICON));
    for (const r of ranks()) shade.querySelector(".aim-pick-grid").append(rankTile(r[0], r[1], "", img(r[0])));

    let waiting = false;
    const start = () => {
      if (waiting) return;
      if (typeof window.__aimLaunchScene !== "function") { note.textContent = "Open the lobby first, then start the round from there."; return; }
      if (navState[cur.map] === undefined) prefetchNav(cur.map);
      const pending = navState[cur.map] instanceof Promise ? navState[cur.map] : null;
      if (!pending) { launch(); return; }
      // Cold cache (the fetch is still running): wait for it, at most 5 s.
      waiting = true;
      note.textContent = "Loading map data…";
      Promise.race([pending, new Promise((r) => setTimeout(r, 5000))]).then(() => { waiting = false; if (open?.shade === shade) launch(); });
    };
    const launch = () => {
      put(SETUP_KEY, JSON.stringify({ map: cur.map, weapon: cur.weapon, barrier: cur.barrier }));
      put(RANK_KEY, cur.rank === "default" ? null : cur.rank);
      dispatchEvent(new Event("aim-bot-settings-change"));
      const map = MAPS.find((m) => m.id === cur.map);
      const code = `round-${cur.map}-${cur.side}-${cur.weapon}-${cur.barrier}`;
      close();
      // Inside the click handler, so the game's fullscreen request counts as a user action.
      window.__aimLaunchScene({ shareCode: code, name: `Round · ${map ? map.name : cur.map}`, subtitle: "Attack · plant the spike", mapId: null });
    };
    shade.querySelector(".aim-round-start").addEventListener("click", (e) => { e.stopPropagation(); start(); });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) shade.addEventListener(type, (e) => e.stopPropagation());
    shade.addEventListener("click", (e) => { e.stopPropagation(); if (e.target === shade) close(); });
    shade.querySelector(".es-tool-x").addEventListener("click", (e) => { e.stopPropagation(); close(); });
    const onKey = (e) => {
      if (!open) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement && document.activeElement !== shade.querySelector(".aim-round-start"))) {
        e.preventDefault(); e.stopPropagation(); start();
      }
    };
    addEventListener("keydown", onKey, true);
    document.body.appendChild(shade);
    open = { shade, onKey };
    shade.querySelector(".aim-round-start").focus({ preventScroll: true });
  }

  window.__aimRoundPanel = { open: openPanel, close, prefetchNav, navState };
  prefetchAll();
})();
