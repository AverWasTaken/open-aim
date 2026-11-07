// Shooting error graph and end-of-round shooting summary.
//
// Live graph: one bar per shot, on a time axis like a heart-rate monitor. The right edge is
// "now" and the strip keeps scrolling left while the round runs (WINDOW seconds wide), so a
// pause in shooting shows as empty space. It runs on the game's own round clock (sim ticks),
// so it freezes while the game is paused. Bar height is the shot's total error (spray + movement), so a spray climbs bar by bar.
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
// Kept cheap: the graph is one small canvas. It repaints every frame only while a round is
// running and the graph is on screen (no allocations per frame); otherwise it repaints only
// when something changes. The per-frame hook only compares a few numbers unless the player moved.
(() => {
  if (window.__aimShotGraph) return;
  window.__aimShotGraph = true;

  const KEY = "es-shot-graph"; // "off" | "graph" | "numbers"
  const STILL = "#ff9d42", MOVING = "#4cb2ff", MOVING_SPRAY = "#2b74c2";
  const CLEAN = 0.01; // degrees of movement error that still counts as standing still
  const mode = () => { try { return localStorage.getItem(KEY) || "graph"; } catch { return "graph"; } };
  const setMode = (m) => {
    try { localStorage.setItem(KEY, m); } catch {}
    sync();
    if (round && round.summary) renderSummary(round); // Off hides an open summary, Graph brings it back
  };

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

  let phase = "idle";
  window.addEventListener("aim-round-phase", (ev) => {
    const d = ev.detail || {};
    phase = d.phase || "idle";
    queue(); // start or stop the scroll loop
    if (d.phase === "running" && d.previous !== "running" && d.previous !== "paused") newRound(d.mapId);
    else if (d.phase === "result" && round && !round.endedAt) { round.endedAt = performance.now(); waitForResult(round); }
    else if (d.phase === "idle" && round && !round.endedAt) round = null; // left before the end
    sync();
  });

  // Per frame: the player's feet. Distance adds up every frame (horizontal only); the path
  // keeps a point about every 15 cm. Jumps over 3 m in one frame are respawns/teleports.
  window.__aimTick = (state) => {
    if (state && typeof state.tick === "number") clockTick(state.tick);
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
  // Time axis: the right edge is the round clock's "now" and each bar sits left of it by its
  // age, WINDOW seconds across the plot. Bars are BAR wide, narrowed (down to MIN_BAR) when
  // shots come faster than the bars fit, so a full-auto spray (about 10 shots/s) still shows
  // one bar per shot with a gap.
  const CAP = 128, BAR = 4, MIN_BAR = 2, WINDOW = 5;
  const SCALES = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45]; // fixed steps: a height means the same from shot to shot
  const AXIS = 34, PLOT_W = 36 * 6 + 2, PLOT_H = 50, TOP = 18, NUMS = 46, H = TOP + PLOT_H + 1;
  const PPS = (PLOT_W - 2) / WINDOW; // pixels per second of round time
  const firing = new Float32Array(CAP), movement = new Float32Array(CAP), isMoving = new Uint8Array(CAP);
  const at = new Float64Array(CAP); // round time of each shot, seconds
  let count = 0, head = 0; // ring buffer: head is the next slot to write
  let canvas = null, g = null, raf = 0, shown = "";

  function clearGraph() { count = 0; head = 0; queue(); }

  // Round clock: the sim's tick (128 per second) from the per-frame hook. It does not advance
  // while the game is paused. Between ticks it is moved on by wall time, never more than one
  // tick ahead, so the scroll is smooth at any frame rate.
  const TICK_S = 1 / 128;
  let simTick = -1, tickAt = 0, lastClock = 0;
  function clockTick(t) {
    if (t === simTick) return;
    if (t < simTick) { lastClock = 0; clearGraph(); } // the sim started over
    simTick = t;
    tickAt = performance.now();
  }
  function clockNow() {
    if (simTick < 0) return 0;
    const ahead = phase === "running" ? Math.min(TICK_S, (performance.now() - tickAt) / 1000) : 0;
    // never step back the bit of interpolation already shown (on pause the strip holds still)
    lastClock = Math.max(simTick * TICK_S + ahead, Math.min(lastClock, (simTick + 1) * TICK_S));
    return lastClock;
  }

  window.__aimShot = (e) => {
    if (!e || typeof e.spreadDeg !== "number") return;
    const total = Math.max(0, e.spreadDeg);
    const rawMove = typeof e.moveDeg === "number" ? Math.max(0, e.moveDeg) : null;
    // Still or moving comes straight from the game's movement error, not from the bar split:
    // a perfect-accuracy drill reports 0 total error even while you move.
    const moving = rawMove !== null ? rawMove > CLEAN : typeof e.firingDeg === "number" && total - e.firingDeg > CLEAN;
    const f = rawMove !== null ? total - Math.min(total, rawMove) : Math.min(total, typeof e.firingDeg === "number" ? Math.max(0, e.firingDeg) : total);
    const tick = typeof e.tick === "number" ? e.tick : null;
    if (tick !== null && simTick < 0) clockTick(tick);
    firing[head] = f;
    movement[head] = total - f;
    isMoving[head] = moving ? 1 : 0;
    at[head] = tick !== null ? tick * TICK_S : clockNow();
    head = (head + 1) % CAP;
    if (count < CAP) count++;
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

  // One rAF loop. It keeps going only while the round runs and the graph is on screen, and
  // paints one last frame when that stops, so a pause freezes the strip where it is.
  const live = () => canvas && !canvas.style.display && phase === "running" && !document.hidden;
  function frame() {
    raf = 0;
    paint();
    if (live()) raf = requestAnimationFrame(frame);
  }
  function queue() {
    if (raf || !canvas || canvas.style.display) return;
    raf = requestAnimationFrame(frame);
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

  // per-frame text, rebuilt only when the scale changes
  let movingW = 0, labelTop = -1, labelHi = "", labelMid = "";

  function paint() {
    if (!canvas) return;
    const numbers = shown === "numbers";
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

    const x0 = AXIS, y0 = TOP, right = x0 + PLOT_W;
    const now = clockNow();
    // bars still on the strip: newest first, until one is older than the window
    let visible = 0, max = 0;
    for (; visible < count; visible++) {
      const i = (head - 1 - visible + CAP) % CAP;
      if ((now - at[i]) * PPS >= PLOT_W - 1) break; // past the left edge
      max = Math.max(max, firing[i] + movement[i]);
    }
    let top = SCALES[SCALES.length - 1];
    for (const s of SCALES) if (s >= max) { top = s; break; }
    if (max > top) top = Math.ceil(max / 15) * 15;

    g.font = "700 12px Bahnschrift, Segoe UI, sans-serif";
    label("Shooting error", x0, 12, "#fff", "left");
    // legend, right-aligned over the plot
    g.font = "600 11px Bahnschrift, Segoe UI, sans-serif";
    if (!movingW) movingW = g.measureText("moving").width;
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
    if (top !== labelTop) {
      const digits = top < 4 ? 2 : 1;
      labelTop = top;
      labelHi = `${top.toFixed(digits)}°`;
      labelMid = `${(top / 4).toFixed(digits)}°`;
    }
    label(labelHi, x0 - 4, y0 + 8, "#c9ced6", "right");
    label(labelMid, x0 - 4, y0 + PLOT_H / 2 + 4, "#c9ced6", "right");

    // bars by age. Square-root heights: a 1° spray stays readable next to a 6° moving shot
    // (the half line is a quarter of the top value). Snapped to device pixels.
    const inner = PLOT_H - 3, base = y0 + PLOT_H - 1, edge = right - 1;
    let newer = Infinity; // round time of the next newer shot
    for (let n = 0; n < visible; n++) {
      const i = (head - 1 - n + CAP) % CAP;
      const t = at[i];
      const older = n + 1 < count ? at[(head - 2 - n + CAP) % CAP] : -Infinity;
      // room to the nearest neighbour, minus a 1 px gap
      const room = Math.min(newer - t, t - older) * PPS - 1;
      newer = t;
      let w = Math.max(MIN_BAR, Math.min(BAR, Math.floor(room * dpr) / dpr));
      let x = Math.round((edge - w - Math.max(0, now - t) * PPS) * dpr) / dpr;
      if (x + w <= x0) break;
      if (x < x0) { w -= x0 - x; x = x0; } // sliding out at the left edge
      const moving = isMoving[i] === 1;
      const sum = firing[i] + movement[i];
      const h = sum <= 0 ? 0 : Math.max(1, Math.round(Math.sqrt(sum / top) * inner * dpr)) / dpr;
      const total = Math.min(inner, Math.max(2, h)); // a 0° shot still shows as a stub
      if (!moving) {
        g.fillStyle = STILL;
        g.fillRect(x, base - total, w, total);
        continue;
      }
      // spray share of the bar, in proportion to the degrees
      const f = sum > 0 ? Math.min(total, Math.round(total * (firing[i] / sum) * dpr) / dpr) : 0;
      g.fillStyle = MOVING;
      g.fillRect(x, base - total, w, total - f);
      g.fillStyle = MOVING_SPRAY;
      g.fillRect(x, base - f, w, f);
    }

    if (numbers) {
      const last = count ? (head - 1 + CAP) % CAP : -1;
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
      // the clock's finish-time labels hang below it (absolutely placed), so measure every
      // child's bottom edge and turn screen pixels back into stage units
      let bottom = clock ? clock.offsetTop + clock.offsetHeight : 0;
      if (clock) {
        const stageTop = spot.stage.getBoundingClientRect().top, k = spot.stage.getBoundingClientRect().height / (spot.stage.offsetHeight || 1) || 1;
        for (const el of clock.querySelectorAll("*")) bottom = Math.max(bottom, (el.getBoundingClientRect().bottom - stageTop) / k);
      }
      const top = Math.ceil(bottom) + 18;
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
    // compact (scenario) layout: one line per kind instead of the table
    const line = (name, cls, t) => `<p class="es-shotgraph-sum-line"><b class="${cls}">${name}</b> ${t.n ? `${deg(t.err / t.n)} average error, ${t.hit} ${t.hit === 1 ? "hit" : "hits"} (${pct(t.hit, t.n)}%)` : "no shots"}</p>`;
    const headRow = `<tr><th>Headshots</th><td>${cell(still, still.head)}</td><td>${cell(moving, moving.head)}</td></tr>`;
    panel.innerHTML = `
      <canvas class="es-shotgraph-sum-map" width="1" height="1" role="img"></canvas>
      <div class="es-shotgraph-sum-text">
        <h3>Shooting error</h3>
        <p class="es-shotgraph-sum-lead">${total} ${total === 1 ? "shot" : "shots"}: <b class="is-still">${still.n} still</b>, <b class="is-moving">${moving.n} while moving</b>.${compact ? ` ${walked}` : ""}</p>
        <div class="es-shotgraph-sum-split" aria-hidden="true"><i class="is-still" style="flex-grow:${still.n}"></i><i class="is-moving" style="flex-grow:${moving.n}"></i></div>
        ${compact ? `${line("Still", "is-still", still)}${line("Moving", "is-moving", moving)}` : `<table>
          <thead><tr><th></th><th class="is-still">Still</th><th class="is-moving">Moving</th></tr></thead>
          <tbody>
            ${shotsRow}
            <tr><th>Average error</th><td>${cell(still, deg(still.err / still.n))}</td><td>${cell(moving, deg(moving.err / moving.n))}</td></tr>
            <tr><th>Hits</th><td>${cell(still, `${still.hit} <small>${pct(still.hit, still.n)}%</small>`)}</td><td>${cell(moving, `${moving.hit} <small>${pct(moving.hit, moving.n)}%</small>`)}</td></tr>
            ${headRow}
          </tbody>
        </table>`}
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
  // The graph shows in the round view (.al-aimlab-root) while the run is live.
  let inRound = false;
  function sync() {
    const root = !!document.querySelector(".al-aimlab-root");
    if (root !== inRound) { inRound = root; count = 0; head = 0; shown = ""; if (!root) round = null; }
    const result = !!document.querySelector(".al-result-overlay");
    // Only while a run is live: not over the loading screen, the pause menu or the result card.
    const m = root && !result && phase === "running" ? mode() : "off";
    if (m !== "off" && !canvas) build();
    if (canvas) canvas.style.display = m !== "off" ? "" : "none";
    if (m !== shown) { shown = m; if (m !== "off") paint(); }
    if (live()) queue(); // starts the scroll loop while a round runs
    addSetting();
  }

  // Settings > Video > Stats: a row like the game's "Performance overlay" switch.
  function addSetting() {
    const anchor = document.querySelector('[data-setting="showPerformance"]');
    if (!anchor || anchor.parentElement.querySelector(".es-shotgraph-setting")) return;
    const row = document.createElement("div");
    row.className = "hall-field es-shotgraph-setting";
    row.innerHTML = '<span class="hall-field-text"><b>Shooting error graph</b><small>A bar for every shot. The graph scrolls left as the round goes on: the newest shot is on the right, and a gap means you stopped shooting. Taller bars mean the shot could land further off. Orange: you were standing still. Blue: you were moving. The result screen adds a summary and a map of where you fired.</small></span><div class="es-shotgraph-seg" role="radiogroup" aria-label="Shooting error graph"></div>';
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
