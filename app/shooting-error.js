// Shooting error graph and end-of-round shooting summary.
//
// Live graph: one bar per shot. New bars enter at the right edge and older ones move left.
// Bar height is the shot's total error (spray + movement), so a spray climbs bar by bar.
// Orange bar: fired standing still. Blue bar: fired while moving (the darker blue part at
// the bottom is the spray share, the bright part on top is the extra error from moving).
//
// Summary: when the round's result screen opens, a panel in the result card shows how many
// shots were fired still vs moving, the error and hits for each, how far the player walked,
// and a map with the walked path and a dot for every shot.
//
// Where the data comes from (all of it the game's own numbers):
//  - main.js patches the game's frame loop to call window.__aimShot(event) for every shot
//    (spreadDeg = total error, firingDeg = spray part, moveDeg = movement part, origin =
//    the player's eye) and window.__aimTick(state) once per frame (state.player.position).
//  - the training layer (Hwnlm6zD.js) fires "aim-round-phase" on every phase change
//    (idle / running / paused / result) with the drill's map id.
// Turned on in Settings > Video > Stats (saved in localStorage, default Graph).
//
// Kept cheap: the graph is one small canvas that repaints only when a shot arrives; the
// per-frame hook only compares two numbers unless the player moved.
(() => {
  if (window.__aimShotGraph) return;
  window.__aimShotGraph = true;

  const KEY = "es-shot-graph"; // "off" | "graph" | "numbers"
  const STILL = "#ff9d42", MOVING = "#4cb2ff", MOVING_SPRAY = "#2b74c2";
  const CLEAN = 0.01; // degrees of movement error that still counts as standing still
  const mode = () => { try { return localStorage.getItem(KEY) || "graph"; } catch { return "graph"; } };
  const setMode = (m) => { try { localStorage.setItem(KEY, m); } catch {} sync(); };

  // ---------- round tracking ----------
  // A round starts when the phase becomes "running" from anything but running/paused
  // (that covers the first start, Restart and Play again) and ends at "result".
  // Shots that land in the same frame as the result still count (late window below).
  // Totals count every shot; only the map's dots and path points are capped.
  const LATE_MS = 1500, MAX_DOTS = 20000, MAX_ROUTE = 20000;
  const tally = () => ({ n: 0, err: 0, hit: 0, head: 0 });
  let round = null;

  function newRound(mapId) {
    round = { mapId: mapId || null, stats: { still: tally(), moving: tally() }, shots: [], route: [], walked: 0, last: null, endedAt: 0, summary: null };
    clearGraph();
  }
  const recording = () => round && (!round.endedAt || performance.now() - round.endedAt < LATE_MS);

  window.addEventListener("aim-round-phase", (ev) => {
    const d = ev.detail || {};
    if (d.phase === "running" && d.previous !== "running" && d.previous !== "paused") newRound(d.mapId);
    else if (d.phase === "result" && round && !round.endedAt) { round.endedAt = performance.now(); waitForResult(round); }
    else if (d.phase === "idle" && round && !round.endedAt) round = null; // left before the end
    sync();
  });

  // Per frame: the player's feet. Distance adds up every frame (horizontal only); the path
  // keeps a point about every 15 cm. Jumps over 3 m in one frame are respawns/teleports.
  window.__aimTick = (state) => {
    if (!round || round.endedAt) return;
    const p = state && state.player && state.player.position;
    if (!p) return;
    const last = round.last;
    if (last) {
      const dx = p.x - last.x, dz = p.z - last.z;
      if (dx === 0 && dz === 0) return;
      const step = Math.hypot(dx, dz);
      if (step > 3) {
        round.last = { x: p.x, z: p.z };
        if (round.route.length < MAX_ROUTE - 1) round.route.push(null, round.last);
        return;
      }
      round.walked += step;
      const tail = round.route[round.route.length - 1];
      if (tail && Math.hypot(p.x - tail.x, p.z - tail.z) < 0.15) { round.last = { x: p.x, z: p.z }; return; }
    }
    round.last = { x: p.x, z: p.z };
    if (round.route.length < MAX_ROUTE) round.route.push(round.last);
  };

  // ---------- live graph ----------
  const SHOTS = 36, BAR = 4, GAP = 2;
  const SCALES = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45]; // fixed steps: a height means the same from shot to shot
  const AXIS = 34, PLOT_W = SHOTS * (BAR + GAP) + 2, PLOT_H = 50, TOP = 18, NUMS = 46, H = TOP + PLOT_H + 1;
  const firing = new Float32Array(SHOTS), movement = new Float32Array(SHOTS), isMoving = new Uint8Array(SHOTS);
  let count = 0, head = 0; // ring buffer: head is the next slot to write
  let canvas = null, g = null, queued = false, shown = "";

  function clearGraph() { count = 0; head = 0; queue(); }

  window.__aimShot = (e) => {
    if (!e || typeof e.spreadDeg !== "number") return;
    const total = Math.max(0, e.spreadDeg);
    const rawMove = typeof e.moveDeg === "number" ? Math.max(0, e.moveDeg) : null;
    // Still or moving comes straight from the game's movement error, not from the bar split:
    // a perfect-accuracy drill reports 0 total error even while you move.
    const moving = rawMove !== null ? rawMove > CLEAN : typeof e.firingDeg === "number" && total - e.firingDeg > CLEAN;
    const f = rawMove !== null ? total - Math.min(total, rawMove) : Math.min(total, typeof e.firingDeg === "number" ? Math.max(0, e.firingDeg) : total);
    firing[head] = f;
    movement[head] = total - f;
    isMoving[head] = moving ? 1 : 0;
    head = (head + 1) % SHOTS;
    if (count < SHOTS) count++;
    queue();
    if (recording()) {
      const t = round.stats[moving ? "moving" : "still"];
      t.n++;
      t.err += total;
      if (e.hitActorId !== null && e.hitActorId !== undefined) t.hit++;
      if (e.hitPart === "head") t.head++;
      const o = e.origin || {};
      if (round.shots.length < MAX_DOTS && Number.isFinite(o.x) && Number.isFinite(o.z)) round.shots.push({ x: o.x, z: o.z, moving });
      if (round.summary) renderSummary(round); // a shot from the round's last frame
    }
  };

  function queue() {
    if (queued || !canvas || canvas.style.display) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; paint(); });
  }

  function build() {
    canvas = document.createElement("canvas");
    canvas.className = "es-shotgraph";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    g = canvas.getContext("2d");
  }

  function label(text, x, y, color, align) {
    g.textAlign = align;
    g.fillStyle = "rgba(0,0,0,.85)";
    g.fillText(text, x + 1, y + 1);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  function paint() {
    if (!canvas) return;
    const numbers = mode() === "numbers";
    const W = AXIS + PLOT_W + (numbers ? NUMS : 2);
    // grows a little on tall windows, like the game's own HUD
    const ui = Math.min(1.5, Math.max(1, window.innerHeight / 1000));
    const dpr = (window.devicePixelRatio || 1) * ui;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W * ui + "px";
      canvas.style.height = H * ui + "px";
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    let max = 0;
    for (let i = 0; i < count; i++) max = Math.max(max, firing[i] + movement[i]);
    const top = SCALES.find((s) => s >= max) ?? Math.ceil(max / 15) * 15;

    const x0 = AXIS, y0 = TOP, right = x0 + PLOT_W;
    g.font = "700 12px Bahnschrift, Segoe UI, sans-serif";
    label("Shooting error", x0, 12, "#fff", "left");
    // legend, right-aligned over the plot
    g.font = "600 11px Bahnschrift, Segoe UI, sans-serif";
    const movingW = g.measureText("moving").width;
    label("moving", right, 12, MOVING, "right");
    label("still", right - movingW - 10, 12, STILL, "right");

    // plot: dark backing, half line
    g.fillStyle = "rgba(8,10,14,.55)";
    g.fillRect(x0, y0, PLOT_W, PLOT_H);
    g.fillStyle = "rgba(255,255,255,.10)";
    g.fillRect(x0, Math.round(y0 + PLOT_H / 2), PLOT_W, 1);
    g.fillStyle = "rgba(255,255,255,.28)";
    g.fillRect(x0, y0 + PLOT_H - 1, PLOT_W, 1);

    g.font = "10px Bahnschrift, Segoe UI, sans-serif";
    const digits = top < 4 ? 2 : 1;
    label(`${top.toFixed(digits)}°`, x0 - 4, y0 + 8, "#c9ced6", "right");
    label(`${(top / 4).toFixed(digits)}°`, x0 - 4, y0 + PLOT_H / 2 + 4, "#c9ced6", "right");

    // bars, newest at the right edge. Square-root heights: a 1° spray stays readable next to
    // a 6° moving shot (the half line is a quarter of the top value). Snapped to device pixels.
    const inner = PLOT_H - 3, base = y0 + PLOT_H - 1;
    const px = (deg) => (deg <= 0 ? 0 : Math.max(1, Math.round(Math.sqrt(deg / top) * inner * dpr)) / dpr);
    for (let n = 0; n < count; n++) {
      const i = (head - count + n + SHOTS) % SHOTS;
      const x = right - 1 - (count - n) * (BAR + GAP) + GAP;
      const moving = isMoving[i] === 1;
      const sum = firing[i] + movement[i];
      const total = Math.min(inner, Math.max(2, px(sum))); // a 0° shot still shows as a stub
      if (!moving) {
        g.fillStyle = STILL;
        g.fillRect(x, base - total, BAR, total);
        continue;
      }
      // spray share of the bar, in proportion to the degrees
      const f = sum > 0 ? Math.min(total, Math.round(total * (firing[i] / sum) * dpr) / dpr) : 0;
      g.fillStyle = MOVING;
      g.fillRect(x, base - total, BAR, total - f);
      g.fillStyle = MOVING_SPRAY;
      g.fillRect(x, base - f, BAR, f);
    }

    if (numbers) {
      const last = count ? (head - 1 + SHOTS) % SHOTS : -1;
      const nx = right + 6;
      g.font = "700 12px Bahnschrift, Segoe UI, sans-serif";
      if (last < 0) label("-", nx, y0 + 16, "#c9ced6", "left");
      else {
        const moving = isMoving[last] === 1;
        label(`${(firing[last] + movement[last]).toFixed(2)}°`, nx, y0 + 16, moving ? MOVING : STILL, "left");
        g.font = "10px Bahnschrift, Segoe UI, sans-serif";
        label(moving ? `+${movement[last].toFixed(2)}° move` : "still", nx, y0 + 31, "#c9ced6", "left");
      }
    }
  }

  // ---------- end-of-round summary ----------
  // The game's result map turns some minimaps a quarter turn (Dc2Dm9E6.js); same table here
  // so this map faces the same way as the game's own.
  const ROTATION = { ascent: 1, bonsai: 1, triad: 1, plummet: 0, jam: 0, infinity: 1, rook: 1, duality: 0 };
  const minimaps = new Map(); // mapId -> Promise<{info, image} | null>
  function loadMinimap(id) {
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) return Promise.resolve(null);
    if (!minimaps.has(id)) {
      minimaps.set(id, fetch(`/aim-maps/${id}.minimap.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((info) => {
          if (!info || !info.transform || !info.image) return null;
          const image = new Image();
          image.src = `/aim-maps/${info.image}`;
          return image.decode().then(() => ({ info, image }), () => null);
        })
        .catch(() => null));
    }
    return minimaps.get(id);
  }

  // Two result layouts: the usual result card (.al-result-modal), and the full-screen
  // "moment" result of scenario drills (.al-mr-stage, a 1600x900 stage scaled to the window).
  function resultSpot() {
    const actions = document.querySelector(".al-result-modal .al-run-actions");
    if (actions) return { kind: "card", actions };
    const stage = document.querySelector(".al-mr-stage");
    if (stage && stage.querySelector(".al-mr-acts")) return { kind: "moment", stage };
    return null;
  }

  function waitForResult(r) {
    const started = performance.now();
    const look = () => {
      if (round !== r) return;
      if (resultSpot()) { r.summary = true; renderSummary(r); return; }
      if (performance.now() - started < 5000) setTimeout(look, 100);
    };
    look();
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const deg = (v) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)}°`;

  function make() {
    const panel = document.createElement("section");
    panel.className = "es-shotgraph-sum";
    panel.setAttribute("aria-label", "Shooting summary");
    return panel;
  }

  function renderSummary(r) {
    const spot = resultSpot();
    let panel = document.querySelector(".es-shotgraph-sum");
    const { still, moving } = r.stats, total = still.n + moving.n;
    if (!spot || !total || mode() === "off") { if (panel) panel.remove(); return; }
    let mapSize = 208;
    if (spot.kind === "moment") {
      // the empty strip in the left column, between the score block and the stars
      // (offsets are in the stage's own 1600x900 units, before its scale)
      const clock = spot.stage.querySelector(".al-mr-clock"), stars = spot.stage.querySelector(".al-mr-stars");
      const top = clock ? clock.offsetTop + clock.offsetHeight + 18 : 0;
      const room = clock && stars ? stars.offsetTop - top - 14 : 0;
      if (room < 96) { if (panel) panel.remove(); return; }
      mapSize = Math.min(room, 150);
      if (!panel || panel.parentElement !== spot.stage) {
        if (panel) panel.remove();
        panel = make();
        spot.stage.appendChild(panel);
      }
      panel.classList.add("is-moment");
      Object.assign(panel.style, { left: clock.offsetLeft + "px", top: top + "px", width: Math.min(clock.offsetWidth, 640) + "px", height: room + "px" });
    } else if (!panel || panel.nextElementSibling !== spot.actions) {
      if (panel) panel.remove();
      panel = make();
      spot.actions.before(panel);
    }
    const compact = spot.kind === "moment";
    const cell = (t, text) => (t.n ? text : "-");
    const walked = r.walked >= 0.5 ? `You walked ${r.walked < 10 ? r.walked.toFixed(1) : Math.round(r.walked)} m.` : "You stayed in place.";
    const shotsRow = `<tr><th>Shots</th><td>${still.n} <small>${pct(still.n, total)}%</small></td><td>${moving.n} <small>${pct(moving.n, total)}%</small></td></tr>`;
    const headRow = `<tr><th>Headshots</th><td>${cell(still, still.head)}</td><td>${cell(moving, moving.head)}</td></tr>`;
    panel.innerHTML = `
      <canvas class="es-shotgraph-sum-map" width="1" height="1" role="img"></canvas>
      <div class="es-shotgraph-sum-text">
        <h3>Shooting error</h3>
        <p class="es-shotgraph-sum-lead">${total} ${total === 1 ? "shot" : "shots"}: <b class="is-still">${still.n} still</b>, <b class="is-moving">${moving.n} while moving</b>.${compact ? ` ${walked}` : ""}</p>
        <div class="es-shotgraph-sum-split" aria-hidden="true"><i class="is-still" style="flex-grow:${still.n}"></i><i class="is-moving" style="flex-grow:${moving.n}"></i></div>
        <table>
          <thead><tr><th></th><th class="is-still">Still</th><th class="is-moving">Moving</th></tr></thead>
          <tbody>
            ${compact ? "" : shotsRow}
            <tr><th>Average error</th><td>${cell(still, deg(still.err / still.n))}</td><td>${cell(moving, deg(moving.err / moving.n))}</td></tr>
            <tr><th>Hits</th><td>${cell(still, `${still.hit} <small>${pct(still.hit, still.n)}%</small>`)}</td><td>${cell(moving, `${moving.hit} <small>${pct(moving.hit, moving.n)}%</small>`)}</td></tr>
            ${compact ? "" : headRow}
          </tbody>
        </table>
        ${compact ? "" : `<p class="es-shotgraph-sum-note">${walked} The map shows your path and a dot where each shot was fired.</p>`}
      </div>`;
    const map = panel.querySelector("canvas");
    map.setAttribute("aria-label", `Map of where you fired: ${still.n} shots still, ${moving.n} while moving`);
    drawMap(map, r, null, mapSize);
    loadMinimap(r.mapId).then((mm) => { if (mm && map.isConnected) drawMap(map, r, mm, mapSize); });
  }

  function drawMap(canvas, r, mm, SIZE) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
    canvas.style.width = canvas.style.height = SIZE + "px";
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#0d1015";
    c.fillRect(0, 0, SIZE, SIZE);

    // map coordinates: (u, v) in the minimap's unit square, or plain world x/z
    const rot = mm ? ((ROTATION[mm.info.map] ?? 0) % 4 + 4) % 4 : 0;
    const t = mm && mm.info.transform;
    const toMap = (x, z) => {
      if (!mm) return { u: x, v: z };
      const a = x * t.scaleU + t.offsetU, b = z * t.scaleV + t.offsetV;
      return rot === 1 ? { u: 1 - b, v: a } : rot === 2 ? { u: 1 - a, v: 1 - b } : rot === 3 ? { u: b, v: 1 - a } : { u: a, v: b };
    };
    const pts = [];
    for (const p of r.route) if (p) pts.push(toMap(p.x, p.z));
    for (const s of r.shots) pts.push(toMap(s.x, s.z));
    if (!pts.length) return;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of pts) { u0 = Math.min(u0, p.u); u1 = Math.max(u1, p.u); v0 = Math.min(v0, p.v); v1 = Math.max(v1, p.v); }
    const metre = mm ? Math.abs(t.scaleU) : 1; // map units per metre
    let span = Math.max(u1 - u0, v1 - v0) * 1.35 + 4 * metre;
    span = Math.max(span, 16 * metre);
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const k = SIZE / span;
    const sx = (u) => (u - cu) * k + SIZE / 2, sy = (v) => (v - cv) * k + SIZE / 2;

    if (mm) {
      // the whole minimap drawn into its unit square, turned like the game's result map
      c.save();
      c.translate(sx(0), sy(0));
      c.scale(k, k);
      c.translate(0.5, 0.5);
      c.rotate(rot * Math.PI / 2);
      c.globalAlpha = 0.8;
      c.drawImage(mm.image, -0.5, -0.5, 1, 1);
      c.restore();
    } else {
      // no minimap (training range): a 5 m grid
      c.strokeStyle = "rgba(255,255,255,.06)";
      c.lineWidth = 1;
      for (let g5 = Math.floor((cu - span / 2) / 5) * 5; g5 <= cu + span / 2; g5 += 5) {
        c.beginPath(); c.moveTo(Math.round(sx(g5)) + 0.5, 0); c.lineTo(Math.round(sx(g5)) + 0.5, SIZE); c.stroke();
      }
      for (let g5 = Math.floor((cv - span / 2) / 5) * 5; g5 <= cv + span / 2; g5 += 5) {
        c.beginPath(); c.moveTo(0, Math.round(sy(g5)) + 0.5); c.lineTo(SIZE, Math.round(sy(g5)) + 0.5); c.stroke();
      }
    }

    // walked path: dark under-stroke, light line on top
    const path = () => {
      c.beginPath();
      let pen = false;
      for (const p of r.route) {
        if (!p) { pen = false; continue; }
        const m = toMap(p.x, p.z);
        if (pen) c.lineTo(sx(m.u), sy(m.v)); else { c.moveTo(sx(m.u), sy(m.v)); pen = true; }
      }
    };
    c.lineJoin = c.lineCap = "round";
    path(); c.strokeStyle = "rgba(0,0,0,.6)"; c.lineWidth = 3.5; c.stroke();
    path(); c.strokeStyle = "rgba(235,240,247,.85)"; c.lineWidth = 1.5; c.stroke();

    // shots: moving dots drawn last so a few blue dots are not buried under many orange ones
    const dot = (s) => {
      const m = toMap(s.x, s.z);
      c.beginPath();
      c.arc(sx(m.u), sy(m.v), 3.2, 0, Math.PI * 2);
      c.fillStyle = s.moving ? MOVING : STILL;
      c.fill();
      c.lineWidth = 1.2;
      c.strokeStyle = "#0d1015";
      c.stroke();
    };
    for (const s of r.shots) if (!s.moving) dot(s);
    for (const s of r.shots) if (s.moving) dot(s);

    // scale bar, bottom left
    const bar = 5 * metre * k;
    c.fillStyle = "rgba(13,16,21,.7)";
    c.fillRect(6, SIZE - 22, Math.max(bar, 24) + 30, 16);
    c.fillStyle = "#d6d9df";
    c.fillRect(10, SIZE - 12, bar, 2);
    c.font = "10px Bahnschrift, Segoe UI, sans-serif";
    c.textAlign = "left";
    c.fillText("5 m", 14 + bar, SIZE - 9);
  }

  // ---------- visibility and settings ----------
  // The graph shows in the round view (.al-aimlab-root) and hides behind the result card.
  let inRound = false;
  function sync() {
    const root = !!document.querySelector(".al-aimlab-root");
    if (root !== inRound) { inRound = root; count = 0; head = 0; shown = ""; if (!root) round = null; }
    const result = !!document.querySelector(".al-result-overlay");
    const m = root && !result ? mode() : "off";
    if (m !== "off" && !canvas) build();
    if (canvas) canvas.style.display = m !== "off" ? "" : "none";
    if (m !== shown) { shown = m; if (m !== "off") paint(); }
    addSetting();
  }

  // Settings > Video > Stats: a row like the game's "Performance overlay" switch.
  function addSetting() {
    const anchor = document.querySelector('[data-setting="showPerformance"]');
    if (!anchor || anchor.parentElement.querySelector(".es-shotgraph-setting")) return;
    const row = document.createElement("div");
    row.className = "hall-field es-shotgraph-setting";
    row.innerHTML = '<span class="hall-field-text"><b>Shooting error graph</b><small>A bar for every shot, newest on the right. Taller bars mean the shot could land further off. Orange: you were standing still. Blue: you were moving. The result screen adds a summary and a map of where you fired.</small></span><div class="es-shotgraph-seg" role="radiogroup" aria-label="Shooting error graph"></div>';
    const seg = row.querySelector(".es-shotgraph-seg");
    for (const [value, text] of [["off", "Off"], ["graph", "Graph"], ["numbers", "Graph + numbers"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => { setMode(value); mark(); });
      b.dataset.value = value;
      seg.appendChild(b);
    }
    const mark = () => { for (const b of seg.children) { const on = b.dataset.value === mode(); b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); } };
    mark();
    anchor.after(row);
  }

  setInterval(sync, 500);
  sync();
})();
