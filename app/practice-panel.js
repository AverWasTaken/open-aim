// Practice panel: the lobby's "Practice" button (lobby-bar.js) opens it. Pick a map, an area, a
// weapon and the bots (none / standing / strafing, how many); Start loads the generated practice
// scene (practice-<map>-<area>-<weapon>-<bots>-<count>, served by main.js from
// app/practice-scene.js) through window.__aimLaunchScene. Areas come from /aim-practice/areas.json
// (tools/practice_areas.mjs). Last choices are kept in "aim-practice-setup".
// While a practice scene is loaded (window.__aimPracticeOn, tools/practice_patch.py) html gets the
// class aim-practice-on, which hides the 24 h duration on the scene brief and the HUD.
// The map box shows our own top-down picture of the map (/aim-maps/maps.json + <map>.preview.png,
// tools/maps_previews.mjs) with your spawn (arrow, facing your start yaw) and the bot spots that
// Start would use (strafing bots as a short line along their lane).
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

  // Where the practice scene puts things, in world x/z: same spot pick and strafe home as
  // app/practice-scene.js pickSpots/strafeOf (strafe-first order for strafing, cut to count; a
  // strafing bot's home is the middle of its lane and it swings +-min(lane, 1.5 m)/2 along it).
  // scripts/test-maps-previews.mjs lifts this function and checks it against buildDoc.
  function practiceMarkers(area, bots, count) {
    const spawn = { x: area.spawn.x, z: area.spawn.z, yaw: area.spawn.yaw };
    if (bots === "none") return { spawn, bots: [] };
    const list = bots === "strafe" ? [...area.spots.filter((s) => s.lane), ...area.spots.filter((s) => !s.lane)] : area.spots;
    return {
      spawn,
      bots: list.slice(0, Math.min(count, list.length)).map((s) => {
        if (bots !== "strafe" || !s.lane) return { x: s.x, z: s.z };
        const [ax, az, lo, hi] = s.lane;
        const mid = (lo + hi) / 2, half = Math.min(hi - lo, 1.5) / 2;
        const x = s.x + ax * mid, z = s.z + az * mid;
        return { x, z, lane: [x - ax * half, z - az * half, x + ax * half, z + az * half] };
      }),
    };
  }

  // Run flag -> html class (the brief card and HUD chips are the game's own; CSS below).
  function styleGlobal() {
    if (document.getElementById("aim-practice-css")) return;
    const s = document.createElement("style");
    s.id = "aim-practice-css";
    s.textContent = `
html.aim-practice-on .al-scene-brief-specs > div:first-child,
html.aim-practice-on .al-scene-brief-note { display: none !important; }
html.aim-practice-on .al-hud-top .al-hud-chip:only-child { display: none !important; }
.es-tool.aim-practice { width: min(1080px, 100%); }
.aim-practice-main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; align-items: start; }
.aim-practice-map { margin: 4px 0 0; }
.aim-practice-map-box { position: relative; aspect-ratio: 1 / 1; background: var(--es-bg); border: 1px solid var(--es-line); overflow: hidden; }
.aim-practice-map-box > img, .aim-practice-map-box > svg { position: absolute; left: 8px; top: 8px; width: calc(100% - 16px); height: calc(100% - 16px); }
.aim-practice-map-box > img { object-fit: contain; pointer-events: none; }
.aim-practice-map-box > img[hidden], .aim-practice-map-box > svg[hidden], .aim-practice-map-empty[hidden] { display: none; }
.aim-practice-map-empty { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; font-size: 13px; color: var(--es-muted); }
.aim-practice-map-cap { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--es-muted); }
.aim-practice-map-cap > span { display: inline-flex; align-items: center; gap: 6px; }
.aim-practice-map-cap i { display: inline-block; width: 10px; height: 10px; }
.aim-practice-key-you { background: var(--es-text); clip-path: polygon(50% 0, 100% 100%, 50% 72%, 0 100%); }
.aim-practice-key-bot { background: var(--es-red); border-radius: 50%; }
.aim-practice-key-lane { height: 3px !important; background: var(--es-red); }
.aim-practice-mk-you { fill: var(--es-text); stroke: var(--es-bg); stroke-linejoin: miter; }
.aim-practice-mk-bot { fill: var(--es-red); stroke: var(--es-bg); }
.aim-practice-mk-lane { stroke: var(--es-red); stroke-linecap: square; opacity: .8; }
@media (max-width: 860px) { .aim-practice-main { grid-template-columns: minmax(0, 1fr); } .aim-practice-map { width: min(320px, 100%); } }
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

  let mapsData = null;
  let mapsLoading = null;
  function loadMaps() {
    if (mapsData) return Promise.resolve(mapsData);
    mapsLoading ??= fetch("/aim-maps/maps.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => (mapsData = Array.isArray(d) ? d : [])).finally(() => { mapsLoading = null; });
    return mapsLoading;
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
      <div class="es-tool-body"><div class="aim-practice-main"><div class="aim-practice-controls">
        <div class="aim-practice-row"><h3 class="aim-practice-label">Map</h3><div class="aim-practice-opts" data-k="map" role="group" aria-label="Map"></div></div>
        <div class="aim-practice-row"><h3 class="aim-practice-label">Area</h3><div class="aim-practice-opts" data-k="area" role="group" aria-label="Area"></div></div>
        <div class="aim-practice-row"><h3 class="aim-practice-label">Weapon</h3><div class="aim-practice-opts" data-k="weapon" role="group" aria-label="Weapon"></div></div>
        <div class="aim-practice-row"><h3 class="aim-practice-label">Bots</h3><div class="aim-practice-opts" data-k="bots" role="group" aria-label="Bots"></div></div>
        <div class="aim-practice-row" data-row="count"><h3 class="aim-practice-label">How many</h3><div class="aim-practice-opts" data-k="count" role="group" aria-label="How many bots"></div></div>
        </div><figure class="aim-practice-map" aria-label="Map preview">
          <div class="aim-practice-map-box"><img alt="" draggable="false" hidden><svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="xMidYMid meet" hidden></svg><p class="aim-practice-map-empty">Loading map...</p></div>
          <figcaption class="aim-practice-map-cap"><span><i class="aim-practice-key-you"></i>You</span><span><i class="aim-practice-key-bot"></i>Bots</span><span data-key="lane" hidden><i class="aim-practice-key-lane"></i>Strafe lane</span></figcaption>
        </figure></div>
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

    // Map box: preview image + SVG markers in image pixels (maps.json world: px = a*x + b*z + c,
    // py = d*x + e*z + f). Facing: forward = (-sin yaw, -cos yaw) in world x/z.
    const mapBox = shade.querySelector(".aim-practice-map-box");
    const mapImg = mapBox.querySelector("img");
    const mapSvg = mapBox.querySelector("svg");
    const mapEmpty = mapBox.querySelector(".aim-practice-map-empty");
    const laneKey = shade.querySelector('[data-key="lane"]');
    let mapsFailed = false;
    const showSvg = (on) => mapSvg.toggleAttribute("hidden", !on); // SVG elements have no .hidden property
    const noPreview = () => { mapImg.hidden = true; showSvg(false); mapEmpty.hidden = false; mapEmpty.textContent = "No preview for this map."; };
    mapImg.addEventListener("error", noPreview);
    mapImg.addEventListener("load", () => { mapImg.hidden = false; showSvg(true); mapEmpty.hidden = true; });
    const svgEl = (tag, cls, attrs) => {
      const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
      e.setAttribute("class", cls);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === "number" ? v.toFixed(2) : v);
      return e;
    };
    function drawMap(area, count) {
      laneKey.hidden = cur.bots !== "strafe";
      const entry = mapsData?.find((m) => m.id === cur.map);
      if (!entry) {
        mapImg.removeAttribute("src");
        delete mapImg.dataset.map;
        mapSvg.replaceChildren();
        if (mapsData || mapsFailed) noPreview();
        else { mapImg.hidden = true; showSvg(false); mapEmpty.hidden = false; mapEmpty.textContent = "Loading map..."; }
        return;
      }
      if (mapImg.dataset.map !== entry.id) {
        mapImg.dataset.map = entry.id;
        mapImg.hidden = true; showSvg(false); mapEmpty.hidden = false; mapEmpty.textContent = "Loading map...";
        mapImg.src = entry.preview;
      }
      const [w, h] = entry.size, W = entry.world, u = Math.max(w, h) / 100;
      const at = (x, z) => [W.a * x + W.b * z + W.c, W.d * x + W.e * z + W.f];
      mapSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      const parts = [];
      if (area) {
        const mk = practiceMarkers(area, cur.bots, count);
        for (const b of mk.bots) {
          if (!b.lane) continue;
          const [x1, y1] = at(b.lane[0], b.lane[1]), [x2, y2] = at(b.lane[2], b.lane[3]);
          parts.push(svgEl("line", "aim-practice-mk-lane", { x1, y1, x2, y2, "stroke-width": u * 0.8 }));
        }
        for (const b of mk.bots) {
          const [cx, cy] = at(b.x, b.z);
          parts.push(svgEl("circle", "aim-practice-mk-bot", { cx, cy, r: u * 1.1, "stroke-width": u * 0.35 }));
        }
        const [sx, sy] = at(mk.spawn.x, mk.spawn.z);
        const fx = -Math.sin(mk.spawn.yaw), fz = -Math.cos(mk.spawn.yaw);
        let dx = W.a * fx + W.b * fz, dy = W.d * fx + W.e * fz;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const L = u * 2.6, pt = (f, s) => `${(sx + dx * f - dy * s).toFixed(2)},${(sy + dy * f + dx * s).toFixed(2)}`;
        parts.push(svgEl("polygon", "aim-practice-mk-you", { points: [pt(L, 0), pt(-L * 0.7, L * 0.8), pt(-L * 0.3, 0), pt(-L * 0.7, -L * 0.8)].join(" "), "stroke-width": u * 0.35 }));
      }
      mapSvg.replaceChildren(...parts);
    }
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
      drawMap(area, cur.bots === "none" || !area ? 0 : Math.max(1, Math.min(cur.count, MAX_BOTS, area.spots.length)));
    }
    render();
    loadAreas().then(render, () => { note.textContent = "Couldn't load the practice areas."; });
    loadMaps().then(render, () => { mapsFailed = true; render(); });

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
      // Pass the map id: the loader then waits for the map's collision before it prepares the drill.
      // With mapId null the preparation races the map download; when the map lands the game rebuilds
      // the scene, the preparation aborts and the loading screen silently goes back to the lobby.
      try { ok = window.__aimLaunchScene({ shareCode: code, name: `Practice: ${mapName} ${area.name}`, subtitle: botsText, mapId: cur.map }) !== false; } catch {}
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
