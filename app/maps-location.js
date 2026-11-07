// "You are here": the callout you are standing in ("A Main", "Mid Courtyard"), shown under
// the in-game minimap while a map drill or round runs.
// - Map id: the aim-round-phase event (detail.mapId). Callouts: /aim-maps/<mapId>.minimap.json
//   (English names, world metres, the same x/z as the player's position).
// - Position: window.__aimTickHub (aim-tick-hub.js), about 6 times a second.
// - Shown only while the phase is "running", the minimap is on screen and the setting is on
//   (Settings > Video > Stats > Location under minimap, saved as aim-maps-location).
// The pure helpers at the top are also loaded by scripts/test-maps-location.mjs in node.
(() => {
  // ---------- pure helpers ----------
  // Nearest callout with hysteresis: keep the current one C (distance dC) until the nearest
  // one N (distance dN) is clearly closer: dN < dC - min(1.5, 0.25 * dC). First pick = nearest.
  function pickCallout(callouts, x, z, current) {
    if (!Array.isArray(callouts) || !callouts.length || !Number.isFinite(x) || !Number.isFinite(z)) return current || null;
    let best = null, bestD = Infinity;
    for (const c of callouts) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!current || !callouts.includes(current) || best === current) return best;
    const dC = Math.hypot(current.x - x, current.z - z);
    return bestD < dC - Math.min(1.5, 0.25 * dC) ? best : current;
  }
  // minimapWidth: the minimap's on-screen width, or null when there is no minimap element.
  function labelVisible(phase, minimapWidth, settingOn) {
    return phase === "running" && typeof minimapWidth === "number" && minimapWidth > 0 && !!settingOn;
  }
  // Minimap unit square (u, v) for a world point; the same transform the game's minimap uses.
  function toMapUV(t, x, z) {
    return { u: x * t.scaleU + t.offsetU, v: z * t.scaleV + t.offsetV };
  }
  // One line centred under the minimap, 6 px below it (the arena tag sits 36 px below it).
  function labelBox(rect) {
    return { left: rect.left, top: rect.bottom + 6, width: rect.width };
  }
  const pure = { pickCallout, labelVisible, toMapUV, labelBox };
  if (typeof window === "undefined") {
    if (typeof module === "object" && module.exports) module.exports = pure;
    return;
  }
  if (window.__aimMapsLocation) return;
  window.__aimMapsLocation = pure;

  // ---------- setting ----------
  const KEY = "aim-maps-location";
  let settingOn = true;
  try { settingOn = localStorage.getItem(KEY) !== "0"; } catch {}
  function setSetting(on) {
    settingOn = !!on;
    try { localStorage.setItem(KEY, settingOn ? "1" : "0"); } catch {}
    paint();
  }

  // ---------- callouts per map ----------
  const maps = new Map(); // mapId -> Promise<callouts[] | null>
  function loadCallouts(id) {
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) return Promise.resolve(null);
    if (!maps.has(id)) {
      maps.set(id, fetch(`/aim-maps/${id}.minimap.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((info) => {
          const list = info && Array.isArray(info.callouts) ? info.callouts : [];
          const ok = list.filter((c) => c && typeof c.name === "string" && c.name && Number.isFinite(c.x) && Number.isFinite(c.z));
          return ok.length ? ok : null;
        })
        .catch(() => null));
    }
    return maps.get(id);
  }

  // ---------- state ----------
  let phase = "idle", mapId = null, callouts = null, current = null, lastPick = 0;
  window.addEventListener("aim-round-phase", (ev) => {
    const d = ev.detail || {};
    phase = d.phase || "idle";
    if (d.phase === "running" && d.previous !== "running" && d.previous !== "paused") current = null; // new run
    if (phase === "idle") current = null;
    const id = d.mapId || null;
    if (id !== mapId) {
      mapId = id; callouts = null; current = null;
      if (id) loadCallouts(id).then((list) => { if (mapId === id) { callouts = list; paint(); } });
    }
    paint();
  });

  const hub = window.__aimTickHub;
  if (hub) hub.add((state) => {
    if (phase !== "running" || !callouts || !settingOn) return;
    const now = performance.now();
    if (now - lastPick < 160) return;
    lastPick = now;
    const p = state && state.player && state.player.position;
    if (!p) return;
    const next = pickCallout(callouts, p.x, p.z, current);
    if (next !== current) { current = next; paint(); }
  });
  else console.log("MAPS LOCATION: no tick hub, label off");

  // ---------- label ----------
  let node = null, minimap = null;
  const mapResize = typeof ResizeObserver === "function" ? new ResizeObserver(() => paint()) : null;
  function addStyle() {
    if (document.getElementById("aim-map-location-style")) return;
    const style = document.createElement("style");
    style.id = "aim-map-location-style";
    style.textContent = `.aim-map-location{position:fixed;z-index:2147483000;pointer-events:none;display:block;box-sizing:border-box;padding:0 4px;
      overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:center;line-height:14px;height:14px;
      font:700 12px var(--es-head);font-stretch:75%;letter-spacing:.06em;text-transform:uppercase;
      color:var(--es-text);text-shadow:0 1px 3px var(--es-bg),0 0 2px var(--es-bg);}`;
    (document.head || document.documentElement).appendChild(style);
  }
  function followMap() {
    const next = document.querySelector('.hall-train-layer [data-role="minimap"]');
    if (next === minimap) return;
    mapResize?.disconnect();
    minimap = next;
    if (minimap) mapResize?.observe(minimap);
  }
  function hide() { if (node) node.style.display = "none"; }
  function paint() {
    followMap();
    const rect = minimap ? minimap.getBoundingClientRect() : null;
    const name = current && current.name;
    if (!name || !labelVisible(phase, rect ? rect.width : null, settingOn) || !(rect.height > 0)) { hide(); return; }
    if (!node) {
      addStyle();
      node = document.createElement("div");
      node.className = "aim-map-location";
      node.setAttribute("aria-live", "off");
      document.body.appendChild(node);
    }
    if (node.textContent !== name) node.textContent = name;
    const box = labelBox(rect);
    const left = Math.round(box.left) + "px", top = Math.round(box.top) + "px", width = Math.round(box.width) + "px";
    if (node.style.left !== left) node.style.left = left;
    if (node.style.top !== top) node.style.top = top;
    if (node.style.width !== width) node.style.width = width;
    if (node.style.display !== "block") node.style.display = "block";
  }

  // Settings > Video > Stats: an Off/On row next to the shot graph's (the panel remounts, so
  // this is re-checked every 500 ms).
  function addSetting() {
    const anchor = document.querySelector('[data-setting="showPerformance"]');
    if (!anchor) return;
    const box = anchor.parentElement;
    let row = box.querySelector(".aim-map-location-setting");
    if (!row) {
      row = document.createElement("div");
      row.className = "hall-field aim-map-location-setting";
      row.innerHTML = '<span class="hall-field-text"><b>Location under minimap</b><small>Shows the callout you are standing in, like "A Main", under the minimap while a map drill or round runs.</small></span><div class="es-shotgraph-seg" role="radiogroup" aria-label="Location under minimap"></div>';
      const seg = row.querySelector(".es-shotgraph-seg");
      for (const [value, text] of [[false, "Off"], [true, "On"]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.setAttribute("role", "radio");
        b.dataset.on = value ? "1" : "0";
        b.addEventListener("click", () => { setSetting(value); markSetting(row); });
        seg.appendChild(b);
      }
      (box.querySelector(".es-shotgraph-setting") || anchor).after(row);
    }
    markSetting(row);
  }
  function markSetting(row) {
    for (const b of row.querySelectorAll(".es-shotgraph-seg button")) {
      const on = (b.dataset.on === "1") === settingOn;
      if (b.classList.contains("is-on") !== on) b.classList.toggle("is-on", on);
      if (b.getAttribute("aria-checked") !== String(on)) b.setAttribute("aria-checked", String(on));
    }
  }

  const reposition = () => paint();
  addEventListener("resize", reposition);
  addEventListener("fullscreenchange", reposition);
  setInterval(paint, 250);
  setInterval(addSetting, 500);
  paint();
  addSetting();
})();
