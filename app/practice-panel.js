// Practice panel: the lobby's "Practice" button (lobby-bar.js) opens it. Pick a map, an area, a
// weapon and the bots (none / standing / strafing, how many); Start loads the generated practice
// scene (practice-<map>-<area>-<weapon>-<bots>-<count>, served by main.js from
// app/practice-scene.js) through window.__aimLaunchScene. Areas come from /aim-practice/areas.json
// (tools/practice_areas.mjs). Last choices are kept in "aim-practice-setup".
// While a practice scene is loaded (window.__aimPracticeOn, tools/practice_patch.py) html gets the
// class aim-practice-on, which hides the 24 h duration on the scene brief and the HUD.
(() => {
  if (window.__aimPracticePanel) return;
  const SETUP_KEY = "aim-practice-setup";
  const MAPS = [["ascent", "Ascent"], ["bonsai", "Split"], ["triad", "Haven"], ["plummet", "Summit"], ["jam", "Lotus"], ["infinity", "Abyss"], ["rook", "Corrode"], ["duality", "Bind"], ["juliett", "Sunset"]];
  const WEAPONS = [["vandal", "Vandal"], ["phantom", "Phantom"], ["spectre", "Spectre"], ["guardian", "Guardian"], ["sheriff", "Sheriff"], ["marshal", "Marshal"], ["outlaw", "Outlaw"], ["operator", "Operator"]];
  const BOTS = [["none", "None"], ["static", "Standing"], ["strafe", "Strafing"]];
  const MAX_BOTS = 12;

  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Run flag -> html class (the brief card and HUD chips are the game's own; CSS below).
  function styleGlobal() {
    if (document.getElementById("aim-practice-css")) return;
    const s = document.createElement("style");
    s.id = "aim-practice-css";
    s.textContent = `
html.aim-practice-on .al-scene-brief-specs > div:first-child,
html.aim-practice-on .al-scene-brief-note { display: none !important; }
html.aim-practice-on .al-hud-top .al-hud-chip:only-child { display: none !important; }
.es-tool.aim-practice { width: min(880px, 100%); }
.aim-practice-row { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: start; margin-bottom: 12px; }
.aim-practice-row[hidden] { display: none; }
.aim-practice-row > h3.aim-practice-label { margin: 10px 0 0; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--es-muted); }
.aim-practice-opts { display: flex; flex-wrap: wrap; gap: 4px; }
.es-tool .es-tool-body button.aim-practice-opt { height: auto; min-height: 36px; padding: 6px 12px; background: var(--es-raised); color: var(--es-soft); border: 1px solid var(--es-line); border-left-width: 1px; display: inline-flex; flex-direction: column; align-items: flex-start; justify-content: center; text-align: left; }
.es-tool .es-tool-body button.aim-practice-opt small { font-size: 11px; font-weight: 400; color: var(--es-muted); text-transform: none; letter-spacing: 0; }
.es-tool .es-tool-body button.aim-practice-opt:not(:disabled):hover { background: var(--es-raised-2); border-color: var(--es-line-2); }
.es-tool .es-tool-body button.aim-practice-opt.is-active { background: var(--es-red-wash); border-color: var(--es-red); color: var(--es-text); }
.es-tool .es-tool-body button.aim-practice-opt:disabled { color: var(--es-dim); cursor: default; }
.es-tool .es-tool-body button.aim-practice-opt:disabled small { color: var(--es-dim); }
.es-tool .es-tool-body button.aim-practice-num { min-width: 40px; align-items: center; font-variant-numeric: tabular-nums; }
.es-tool.aim-practice button:focus-visible { outline: 2px solid var(--es-red); outline-offset: 2px; }
.aim-practice-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--es-line); }
.aim-practice-hint { margin: 0; font-size: 13px; line-height: 1.5; color: var(--es-muted); }
.es-tool .es-tool-body button.es-tool-primary.aim-practice-start { min-width: 150px; height: 44px; font-size: 15px; font-weight: 800; }
.aim-practice-note { min-height: 1.2em; margin: 8px 0 0; font-size: 13px; color: var(--es-red-2); }
`;
    document.head.appendChild(s);
  }
  styleGlobal();
  // The game shows the scene brief while the map is still loading, before To() sets the flag, so
  // a launch from this panel counts as on until the flag takes over, the player is back in the
  // lobby, or 2 minutes pass.
  let flagOn = false;
  let launching = null; // { at, sawTraining }
  function sync() {
    if (launching) {
      const training = document.body?.classList.contains("al-training-active");
      if (training) launching.sawTraining = true;
      if (window.__aimPracticeOn || (launching.sawTraining && !training) || Date.now() - launching.at > 120000) launching = null;
    }
    const on = !!window.__aimPracticeOn || !!launching;
    if (on !== flagOn) { flagOn = on; document.documentElement.classList.toggle("aim-practice-on", on); }
  }
  setInterval(sync, 250);

  let areasData = null;
  let areasLoading = null;
  function loadAreas() {
    if (areasData) return Promise.resolve(areasData);
    areasLoading ??= fetch("/aim-practice/areas.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => (areasData = d)).finally(() => { areasLoading = null; });
    return areasLoading;
  }

  function setup() {
    let v = {};
    try { v = JSON.parse(get(SETUP_KEY) || "{}") || {}; } catch {}
    return {
      map: MAPS.some((m) => m[0] === v.map) ? v.map : "ascent",
      area: typeof v.area === "string" ? v.area : "",
      weapon: WEAPONS.some((w) => w[0] === v.weapon) ? v.weapon : "vandal",
      bots: BOTS.some((b) => b[0] === v.bots) ? v.bots : "static",
      count: Number.isInteger(v.count) && v.count >= 1 && v.count <= MAX_BOTS ? v.count : 5,
    };
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
    styleGlobal();
    const cur = setup();
    const shade = document.createElement("div");
    shade.className = "es-tool-shade";
    shade.innerHTML = `<section class="es-tool aim-practice" role="dialog" aria-modal="true" aria-label="Practice">
      <header class="es-tool-head"><div><h2>Practice</h2><p>No timer. Bots come back 1.5 s after you kill them.</p></div>
      <button type="button" class="es-tool-x" aria-label="Close">✕</button></header>
      <div class="es-tool-body">
        <div class="aim-practice-row"><h3 class="aim-practice-label">Map</h3><div class="aim-practice-opts" data-k="map" role="group" aria-label="Map"></div></div>
        <div class="aim-practice-row"><h3 class="aim-practice-label">Area</h3><div class="aim-practice-opts" data-k="area" role="group" aria-label="Area"></div></div>
        <div class="aim-practice-row"><h3 class="aim-practice-label">Weapon</h3><div class="aim-practice-opts" data-k="weapon" role="group" aria-label="Weapon"></div></div>
        <div class="aim-practice-row"><h3 class="aim-practice-label">Bots</h3><div class="aim-practice-opts" data-k="bots" role="group" aria-label="Bots"></div></div>
        <div class="aim-practice-row" data-row="count"><h3 class="aim-practice-label">How many</h3><div class="aim-practice-opts" data-k="count" role="group" aria-label="How many bots"></div></div>
        <div class="aim-practice-foot">
          <p class="aim-practice-hint">Bots don't shoot. Esc opens the menu, quit from there.</p>
          <button type="button" class="es-tool-primary aim-practice-start">Start</button>
        </div>
        <p class="aim-practice-note" role="status"></p>
      </div></section>`;
    const note = shade.querySelector(".aim-practice-note");
    const startBtn = shade.querySelector(".aim-practice-start");
    const box = (k) => shade.querySelector(`[data-k="${k}"]`);
    const opt = (k, value, label, sub, disabled, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "aim-practice-opt" + (cls ? " " + cls : "");
      b.dataset.v = String(value);
      b.disabled = !!disabled;
      b.innerHTML = `<span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}`;
      const active = String(cur[k]) === String(value);
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        cur[k] = typeof cur[k] === "number" ? Number(value) : value;
        render();
        box(k).querySelector(`[data-v="${value}"]`)?.focus({ preventScroll: true });
      });
      return b;
    };
    const areasOf = () => areasData?.maps?.[cur.map]?.areas ?? [];
    function render() {
      const areas = areasOf();
      if (areas.length && !areas.some((a) => a.id === cur.area)) cur.area = areas[0].id;
      const area = areas.find((a) => a.id === cur.area) || null;
      const lanes = area ? area.spots.filter((s) => s.lane).length : 0;
      if (cur.bots === "strafe" && area && !lanes) cur.bots = "static";
      const max = area ? Math.min(MAX_BOTS, area.spots.length) : MAX_BOTS;
      if (cur.count > max) cur.count = max;
      box("map").replaceChildren(...MAPS.map(([id, name]) => opt("map", id, name)));
      box("area").replaceChildren(...(areas.length ? areas.map((a) => opt("area", a.id, a.name)) : [Object.assign(document.createElement("span"), { className: "aim-practice-hint", textContent: areasData ? "No areas on this map." : "Loading areas..." })]));
      box("weapon").replaceChildren(...WEAPONS.map(([id, name]) => opt("weapon", id, name)));
      box("bots").replaceChildren(...BOTS.map(([id, name]) => opt("bots", id, name, id === "strafe" && area && !lanes ? "No room here" : "", id === "strafe" && area && !lanes)));
      const nums = [];
      for (let n = 1; n <= MAX_BOTS; n++) nums.push(opt("count", n, String(n), "", n > max, "aim-practice-num"));
      box("count").replaceChildren(...nums);
      shade.querySelector('[data-row="count"]').hidden = cur.bots === "none";
      note.textContent = cur.bots === "strafe" && area && cur.count > lanes ? `${lanes} spots here have room to strafe. The rest stand still.` : "";
      startBtn.disabled = !area;
    }
    render();
    loadAreas().then(render, () => { note.textContent = "Couldn't load the practice areas."; });

    const start = () => {
      const area = areasOf().find((a) => a.id === cur.area);
      if (!area) return;
      if (typeof window.__aimLaunchScene !== "function") { note.textContent = "Open the lobby first, then start practice from there."; return; }
      const count = cur.bots === "none" ? 0 : Math.max(1, Math.min(cur.count, MAX_BOTS, area.spots.length));
      put(SETUP_KEY, JSON.stringify({ map: cur.map, area: cur.area, weapon: cur.weapon, bots: cur.bots, count: cur.count }));
      const mapName = (MAPS.find((m) => m[0] === cur.map) || [, cur.map])[1];
      const botsText = cur.bots === "none" ? "No bots" : `${count} ${cur.bots === "strafe" ? "strafing" : "standing"} bot${count === 1 ? "" : "s"}`;
      const code = `practice-${cur.map}-${cur.area}-${cur.weapon}-${cur.bots}-${count}`;
      close();
      // Inside the click handler, so the game's fullscreen request counts as a user action.
      launching = { at: Date.now(), sawTraining: false };
      sync();
      let ok = false;
      try { ok = window.__aimLaunchScene({ shareCode: code, name: `Practice: ${mapName} ${area.name}`, subtitle: botsText, mapId: null }) !== false; } catch {}
      if (!ok) { launching = null; sync(); }
    };
    startBtn.addEventListener("click", (e) => { e.stopPropagation(); start(); });
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) shade.addEventListener(type, (e) => e.stopPropagation());
    shade.addEventListener("click", (e) => { e.stopPropagation(); if (e.target === shade) close(); });
    shade.querySelector(".es-tool-x").addEventListener("click", (e) => { e.stopPropagation(); close(); });
    const onKey = (e) => {
      if (!open) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement && document.activeElement !== startBtn)) {
        e.preventDefault(); e.stopPropagation(); start();
      }
    };
    addEventListener("keydown", onKey, true);
    document.body.appendChild(shade);
    open = { shade, onKey };
    startBtn.focus({ preventScroll: true });
  }

  window.__aimPracticePanel = { open: openPanel, close };
})();
