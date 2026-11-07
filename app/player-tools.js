// Player tools opened from the top bar (buttons added by lobby-bar.js):
// - Backups: list the automatic and manual backups of your data, back up now,
//   restore one, export to a folder, import from a folder (backups.js does the work).
// - Sens tools: eDPI and cm/360 for your VALORANT sensitivity, and a converter
//   between VALORANT and other games (same DPI), with a button to use the result here.
(() => {
  if (window.__aimTools) return;

  // ---------- shared panel ----------
  let open = null;

  function closePanel() {
    open?.remove();
    open = null;
  }

  function panel(title, subtitle) {
    closePanel();
    const shade = document.createElement("div");
    shade.className = "es-tool-shade";
    shade.innerHTML = `<section class="es-tool" role="dialog" aria-label="${title}">
      <header class="es-tool-head"><div><h2>${title}</h2><p>${subtitle}</p></div>
      <button type="button" class="es-tool-x" aria-label="Close">✕</button></header>
      <div class="es-tool-body"></div></section>`;
    shade.addEventListener("mousedown", (e) => { if (e.target === shade) closePanel(); });
    shade.querySelector(".es-tool-x").addEventListener("click", closePanel);
    // Keys typed here belong to the panel, not the game's shortcuts.
    for (const type of ["keydown", "keyup", "keypress"]) {
      shade.addEventListener(type, (e) => {
        if (type === "keydown" && e.key === "Escape") closePanel();
        e.stopPropagation();
      });
    }
    document.body.appendChild(shade);
    open = shade;
    return shade.querySelector(".es-tool-body");
  }

  // In-panel confirmation (instead of the browser's confirm popup).
  function ask(body, text, yes) {
    return new Promise((resolve) => {
      body.querySelector(".es-tool-ask")?.remove();
      const bar = document.createElement("div");
      bar.className = "es-tool-ask";
      bar.innerHTML = `<p>${esc(text).replace(/\n/g, "<br>")}</p><div><button type="button" class="es-tool-primary" data-ask="yes">${esc(yes)}</button><button type="button" data-ask="no">Cancel</button></div>`;
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ask]");
        if (!b) return;
        e.stopPropagation();
        bar.remove();
        resolve(b.dataset.ask === "yes");
      });
      body.prepend(bar);
    });
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- backups ----------
  const api = () => window.__aimDesktop && window.__aimDesktop.backups;
  const REASONS = { launch: "Automatic (app start)", manual: "Saved by you", export: "Exported", imported: "Imported", "before restore": "Before a restore" };

  function when(ms) {
    const d = new Date(ms);
    const today = new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === today.toDateString()) return `Today ${time}`;
    return `${d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })} ${time}`;
  }

  async function openBackups() {
    const body = panel("Backups", "Your training history, personal bests, settings and studio scenes. A backup is made every time the app starts (the last 10 are kept).");
    if (!api()) {
      body.innerHTML = `<p class="es-tool-note">Backups are only available in the desktop app.</p>`;
      return;
    }
    body.innerHTML = `<div class="es-tool-actions">
        <button type="button" class="es-tool-primary" data-act="create">Back up now</button>
        <button type="button" data-act="export">Export to folder…</button>
        <button type="button" data-act="import">Import from folder…</button>
        <button type="button" data-act="folder">Open backups folder</button>
      </div>
      <p class="es-tool-status" role="status"></p>
      <div class="es-tool-list"></div>`;
    const status = body.querySelector(".es-tool-status");
    const listEl = body.querySelector(".es-tool-list");
    const say = (text, bad) => { status.textContent = text; status.classList.toggle("is-bad", !!bad); };

    async function refresh() {
      const items = await api().list();
      if (!items.length) {
        listEl.innerHTML = `<p class="es-tool-note">No backups yet. One is made each time the app starts.</p>`;
        return;
      }
      listEl.innerHTML = items.map((b) => `<div class="es-tool-row">
          <div><b>${esc(when(b.created))}</b><span>${esc(REASONS[b.reason] || b.reason)} · ${(b.size / 1048576).toFixed(1)} MB</span></div>
          <button type="button" data-act="restore" data-id="${esc(b.id)}">Restore</button>
          <button type="button" data-act="export-one" data-id="${esc(b.id)}" title="Save a copy of this backup to a folder">Export</button>
        </div>`).join("");
    }

    body.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const { act, id } = btn.dataset;
      try {
        if (act === "create") {
          await api().create();
          say("Backup saved.");
          await refresh();
        } else if (act === "folder") {
          await api().openFolder();
        } else if (act === "export" || act === "export-one") {
          const dest = await api().exportTo(act === "export-one" ? id : undefined);
          if (dest) say(`Exported to ${dest}`);
          await refresh();
        } else if (act === "import") {
          if (!(await ask(body, "Import a backup folder?\nYour current data is backed up first, then the app restarts with the imported data.", "Choose folder"))) return;
          const done = await api().importFrom();
          if (done) say("Imported. Restarting…");
        } else if (act === "restore") {
          const row = btn.closest(".es-tool-row").querySelector("b").textContent;
          if (!(await ask(body, `Restore the backup from ${row}?\nYour current data is backed up first, then the app restarts with this backup.`, "Restore and restart"))) return;
          await api().restore(id);
          say("Restoring. Restarting…");
        }
      } catch (err) {
        say(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), true);
      }
    });
    await refresh();
  }

  // ---------- sensitivity ----------
  // Every game is turned into "degrees turned per mouse count" (deg/count) and back.
  // Linear games: deg/count = sens × yaw. Numbers: open-aim-hq teams/feel-ref-sens.md.
  const VAL_YAW = 0.07;
  const R6_K = 180 / Math.PI / 200; // deg/count = slider × MouseSensitivityMultiplierUnit × R6_K
  const MC_LO = 0.0096; // Minecraft 0 %
  const MC_HI = 0.6144; // Minecraft 200 %
  const TRAINER_MIN = 0.001;
  const TRAINER_MAX = 10;
  const ok = (n) => Number.isFinite(n) && n > 0;
  const linear = (yaw) => ({
    yaw,
    toDeg: (v) => (ok(v) ? v * yaw : NaN),
    fromDeg: (deg) => (ok(deg) ? deg / yaw : NaN),
  });
  const GAMES = [
    { id: "valorant", name: "VALORANT", unitLabel: "Sensitivity", decimals: 3, example: "0.4", ...linear(VAL_YAW) },
    { id: "cs2", name: "Counter-Strike 2 / CS:GO", unitLabel: "Sensitivity", decimals: 3, example: "1.2", ...linear(0.022) },
    { id: "apex", name: "Apex Legends", unitLabel: "Mouse sensitivity", decimals: 3, example: "1.2", ...linear(0.022) },
    { id: "deadlock", name: "Deadlock", unitLabel: "Sensitivity", decimals: 3, example: "1.2", ...linear(0.022) },
    { id: "quake", name: "Quake Champions", unitLabel: "Sensitivity", decimals: 3, example: "1.2", ...linear(0.022) },
    { id: "ow2", name: "Overwatch 2", unitLabel: "Sensitivity", decimals: 2, example: "4.5", ...linear(0.0066) },
    { id: "cod", name: "CoD: MW3 / BO6 / Warzone", unitLabel: "Hipfire sensitivity", decimals: 2, example: "4.5", ...linear(0.0066) },
    { id: "destiny2", name: "Destiny 2", unitLabel: "Look sensitivity", decimals: 2, example: "4.5", ...linear(0.0066) },
    { id: "fortnite", name: "Fortnite", unitLabel: "X/Y sensitivity (%)", decimals: 1, example: "6.3", percent: true, ...linear(VAL_YAW / 12.6) },
    {
      id: "r6", name: "Rainbow Six Siege", unitLabel: "Mouse sensitivity (slider)", decimals: 0, example: "10",
      toDeg: (v, x) => (ok(v) && ok(x?.r6unit) ? v * x.r6unit * R6_K : NaN),
      fromDeg: (deg, x) => (ok(deg) && ok(x?.r6unit) ? deg / (x.r6unit * R6_K) : NaN),
    },
    {
      // Not linear: deg/count = 1.2 × (0.6·s + 0.2)³ with s = menu % / 200. The menu only goes 0–200 %.
      id: "minecraft", name: "Minecraft Java", unitLabel: "Mouse sensitivity (%)", decimals: 0, example: "100", percent: true,
      toDeg: (pct) => (Number.isFinite(pct) && pct >= 0 && pct <= 200 ? 1.2 * (0.6 * (pct / 200) + 0.2) ** 3 : NaN),
      fromDeg: (deg) => {
        if (!ok(deg) || deg < MC_LO * (1 - 1e-9) || deg > MC_HI * (1 + 1e-9)) return NaN;
        const pct = (((deg / 1.2) ** (1 / 3) - 0.2) / 0.6) * 200;
        return Math.min(200, Math.max(0, pct));
      },
    },
    { id: "marvel", name: "Marvel Rivals (approx.)", unitLabel: "Sensitivity", decimals: 3, example: "1.6", approx: true, ...linear(0.0175) },
  ];
  const gameById = (id) => GAMES.find((g) => g.id === id);
  // Other game -> VALORANT sens, and back. NaN when there is no answer (bad input or out of range).
  const toVal = (id, value, extra) => gameById(id).toDeg(value, extra) / VAL_YAW;
  const fromVal = (id, valSens, extra) => (ok(valSens) ? gameById(id).fromDeg(valSens * VAL_YAW, extra) : NaN);
  const cm360 = (valSens, dpi) => (ok(valSens) && ok(dpi) ? (360 / (VAL_YAW * valSens * dpi)) * 2.54 : NaN);
  // Sensitivity for a new DPI that keeps the same cm/360.
  const dpiSwap = (valSens, oldDpi, newDpi) => (ok(valSens) && ok(oldDpi) && ok(newDpi) ? (valSens * oldDpi) / newDpi : NaN);
  const inTrainerRange = (v) => Number.isFinite(v) && v >= TRAINER_MIN && v <= TRAINER_MAX;
  // Zoom levels: the trainer's ADS multiplier covers 1.15× / 1.25× / 1.5×, the scoped one 2.5× / 3.5× / 5×.
  // Zoomed deg/count = 0.07 × sens × multiplier / zoom. match0 = the multiplier that feels like hipfire
  // near the crosshair (0 % monitor distance, zoomed FOV = 103° / zoom).
  const ZOOMS = [
    { zoom: 1.15, kind: "ads", what: "SMGs, MGs" },
    { zoom: 1.25, kind: "ads", what: "Rifles" },
    { zoom: 1.5, kind: "ads", what: "Guardian" },
    { zoom: 2.5, kind: "scoped", what: "Operator" },
    { zoom: 3.5, kind: "scoped", what: "Marshal, Outlaw" },
    { zoom: 5, kind: "scoped", what: "Operator 2nd zoom" },
  ];
  const rad = (deg) => (deg * Math.PI) / 180;
  function zoomRows(valSens, dpi, ads = 1, scoped = 1) {
    return ZOOMS.map((z) => {
      const mult = z.kind === "ads" ? ads : scoped;
      const degPerCount = ok(valSens) && ok(mult) ? (VAL_YAW * valSens * mult) / z.zoom : NaN;
      return {
        ...z,
        mult,
        degPerCount,
        cm360: ok(degPerCount) && ok(dpi) ? (360 / (degPerCount * dpi)) * 2.54 : NaN,
        match0: (z.zoom * Math.tan(rad(51.5 / z.zoom))) / Math.tan(rad(51.5)),
      };
    });
  }
  const sensMath = { GAMES, toVal, fromVal, cm360, dpiSwap, zoomRows, inTrainerRange, TRAINER_MIN, TRAINER_MAX };

  const DPI_KEY = "es-mouse-dpi";
  const R6_KEY = "feel-sens-r6unit";

  function sensInput() {
    return document.querySelector(".hall-sens input");
  }

  function currentSens() {
    const v = parseFloat(sensInput()?.value);
    if (v > 0) return v;
    try { const s = parseFloat(localStorage.getItem("al-sensitivity-v1")); if (s > 0) return s; } catch {}
    return 0.5; // the game's default
  }

  // The trainer's ADS / scoped multipliers (Settings), 1 when unset.
  function zoomMults() {
    let ads = 1;
    let scoped = 1;
    try {
      const d = JSON.parse(localStorage.getItem("al-display-settings-v1") || "{}") || {};
      if (ok(+d.adsSensitivity)) ads = +d.adsSensitivity;
      if (ok(+d.scopedSensitivity)) scoped = +d.scopedSensitivity;
    } catch {}
    return { ads, scoped };
  }

  function useSens(value) {
    const input = sensInput();
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.blur();
    return true;
  }

  const fmt = (n, d = 3) => (Number.isFinite(n) ? String(+n.toFixed(d)) : "–");

  const SENS_CSS = `
.feel-sens-r6 { margin-top: 10px; }
.feel-sens-r6[hidden] { display: none; }
.feel-sens-r6 p { align-self: end; margin: 0 0 2px; font-size: 12px; line-height: 1.4; color: #9aa1ae; overflow-wrap: anywhere; }
.es-tool-list.feel-sens-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.feel-sens-cols .es-tool-row { min-width: 0; padding: 7px 10px; }
.feel-sens-cols .es-tool-row > div b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.es-tool b.feel-sens-oor { font-size: 13px !important; font-weight: 400; color: #9aa1ae; }
.es-tool .feel-sens-done { min-height: 0; margin: 6px 0 0; }
.es-tool .feel-sens-done:empty { display: none; }
.feel-sens-sec { margin-top: 12px; background: rgba(255, 255, 255, 0.03); border-left: 3px solid #343b4a; }
.feel-sens-sec[open] { border-left-color: #ff4655; }
.feel-sens-sec > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 12px; cursor: pointer; list-style: none; font-size: 14px; font-weight: 700; font-stretch: 75%; text-transform: uppercase; letter-spacing: 0.1em; color: #ff6b77; user-select: none; }
.feel-sens-sec > summary::-webkit-details-marker { display: none; }
.feel-sens-sec > summary::after { content: "+"; flex: none; font-size: 18px; line-height: 1; color: #9aa1ae; }
.feel-sens-sec[open] > summary::after { content: "−"; }
.feel-sens-sec > summary:hover::after { color: #fff; }
.feel-sens-sec > summary:focus-visible { outline: 2px solid #ff4655; outline-offset: -2px; }
.feel-sens-in { padding: 0 12px 12px; }
.feel-sens-note { margin: 8px 0 0; font-size: 12px; line-height: 1.45; color: #9aa1ae; }
.feel-sens-zoom { width: 100%; border-collapse: separate; border-spacing: 0 3px; font-variant-numeric: tabular-nums; }
.feel-sens-zoom th { padding: 0 10px 2px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #9aa1ae; }
.feel-sens-zoom td { padding: 6px 10px; font-size: 15px; font-weight: 700; background: rgba(255, 255, 255, 0.04); }
.feel-sens-zoom td small { display: block; margin-top: 1px; font-size: 11px; font-weight: 400; color: #9aa1ae; }
.feel-sens-zoom :is(th, td):nth-child(n + 2) { text-align: right; }
.feel-sens-zoom td.feel-sens-dim { font-size: 13px; font-weight: 400; color: #9aa1ae; }
`;

  function ensureSensCss() {
    if (document.getElementById("feel-sens-css")) return;
    const style = document.createElement("style");
    style.id = "feel-sens-css";
    style.textContent = SENS_CSS;
    document.head.appendChild(style);
  }

  function openSens() {
    ensureSensCss();
    const body = panel("Sensitivity tools", "Work out eDPI and cm/360, and convert your sensitivity from or to other games (same mouse DPI).");
    let dpi = 800;
    let r6unit = 0.02;
    try { dpi = parseInt(localStorage.getItem(DPI_KEY), 10) || 800; } catch {}
    try { const u = parseFloat(localStorage.getItem(R6_KEY)); if (ok(u)) r6unit = u; } catch {}
    const others = GAMES.filter((g) => g.id !== "valorant");
    body.innerHTML = `<div class="es-sens-grid">
        <label>Mouse DPI<input type="number" min="50" max="32000" step="50" data-f="dpi" value="${dpi}"></label>
        <label>VALORANT sensitivity<input type="number" min="${TRAINER_MIN}" max="${TRAINER_MAX}" step="0.001" data-f="val" value="${currentSens()}"></label>
      </div>
      <div class="es-sens-stats">
        <div><span>eDPI</span><b data-o="edpi">–</b></div>
        <div><span>cm / 360°</span><b data-o="cm">–</b></div>
        <div><span>inches / 360°</span><b data-o="in">–</b></div>
      </div>
      <h3>Convert from another game</h3>
      <div class="es-sens-grid">
        <label>Game<select data-f="game">${others.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select></label>
        <label><span data-o="unit">Sensitivity</span><input type="number" min="0" step="0.001" data-f="other"></label>
      </div>
      <div class="es-sens-grid feel-sens-r6" hidden>
        <label title="MouseSensitivityMultiplierUnit">Multiplier unit<input type="number" min="0.0001" step="0.001" data-f="r6unit" value="${r6unit}"></label>
        <p>MouseSensitivityMultiplierUnit in GameSettings.ini. Default 0.02.</p>
      </div>
      <div class="es-sens-convert"><span>VALORANT equivalent</span><b data-o="conv">–</b><button type="button" class="es-tool-primary" data-act="use-conv">Use in trainer</button></div>
      <p class="es-tool-status feel-sens-done" role="status" data-s="use-conv"></p>
      <h3>Your sensitivity in other games</h3>
      <div class="es-tool-list es-sens-table feel-sens-cols"></div>
      <div class="es-tool-actions"><button type="button" class="es-tool-primary" data-act="use-val">Use this sensitivity in the trainer</button></div>
      <p class="es-tool-status feel-sens-done" role="status" data-s="use-val"></p>
      <details class="feel-sens-sec">
        <summary>Changed your mouse DPI?</summary>
        <div class="feel-sens-in">
          <div class="es-sens-grid">
            <label>Old DPI<input type="number" min="50" max="32000" step="50" data-f="olddpi" value="${dpi}"></label>
            <label>New DPI<input type="number" min="50" max="32000" step="50" data-f="newdpi" placeholder="e.g. 1600"></label>
          </div>
          <div class="es-sens-convert"><span>New VALORANT sensitivity</span><b data-o="dpiswap">–</b><button type="button" class="es-tool-primary" data-act="use-dpi">Use in trainer</button></div>
          <p class="feel-sens-note">Keeps the same cm / 360° as your sensitivity above.</p>
          <p class="es-tool-status feel-sens-done" role="status" data-s="use-dpi"></p>
        </div>
      </details>
      <details class="feel-sens-sec">
        <summary>Zoomed sensitivity</summary>
        <div class="feel-sens-in">
          <table class="feel-sens-zoom">
            <thead><tr><th>Zoom</th><th>Multiplier</th><th>cm / 360°</th><th>Match to 0%</th></tr></thead>
            <tbody data-o="zoom"></tbody>
          </table>
          <p class="feel-sens-note">Multiplier: your ADS and Scoped sensitivity settings. Match to 0%: multiplier that makes zoomed aim feel the same near the crosshair.</p>
        </div>
      </details>`;
    const f = (name) => body.querySelector(`[data-f="${name}"]`);
    const o = (name) => body.querySelector(`[data-o="${name}"]`);
    const results = { "use-conv": NaN, "use-dpi": NaN };

    function say(act, text, bad) {
      for (const el of body.querySelectorAll("[data-s]")) el.textContent = "";
      const el = body.querySelector(`[data-s="${act}"]`);
      el.textContent = text;
      el.classList.toggle("is-bad", !!bad);
    }

    // Rounded for display; NaN when it rounds to 0 or below (too small to set in that game).
    const shown = (n, decimals) => (Number.isFinite(n) && +n.toFixed(decimals) > 0 ? n : NaN);

    // A number, "out of range" (input fine but no matching value), or "–" (nothing to show yet).
    function show(el, n, decimals, oor) {
      el.classList.toggle("feel-sens-oor", !Number.isFinite(n) && oor);
      el.textContent = Number.isFinite(n) ? fmt(n, decimals) : oor ? "out of range" : "–";
    }

    function update() {
      const d = parseFloat(f("dpi").value);
      const v = parseFloat(f("val").value);
      const u = parseFloat(f("r6unit").value);
      try { if (d > 0) localStorage.setItem(DPI_KEY, String(Math.round(d))); } catch {}
      try { if (ok(u)) localStorage.setItem(R6_KEY, String(u)); } catch {}
      const extra = { r6unit: u };
      const cm = cm360(v, d);
      o("edpi").textContent = ok(d) && ok(v) ? fmt(d * v, 1) : "–";
      o("cm").textContent = fmt(cm, 1);
      o("in").textContent = fmt(cm / 2.54, 2);

      const game = gameById(f("game").value);
      o("unit").textContent = game.unitLabel;
      f("other").placeholder = `e.g. ${game.example}`;
      f("other").step = game.decimals ? String(10 ** -game.decimals) : "1";
      body.querySelector(".feel-sens-r6").hidden = game.id !== "r6";
      const otherRaw = f("other").value.trim();
      const other = parseFloat(otherRaw);
      const conv = otherRaw === "" ? NaN : shown(toVal(game.id, other, extra), 3);
      results["use-conv"] = conv;
      show(o("conv"), conv, 3, Number.isFinite(other) && (game.id !== "r6" || ok(u)));

      body.querySelector(".es-sens-table").innerHTML = others
        .map((g) => {
          const n = shown(fromVal(g.id, v, extra), g.decimals);
          const oor = ok(v) && (g.id !== "r6" || ok(u)) && !Number.isFinite(n);
          const text = Number.isFinite(n) ? `${g.approx ? "≈ " : ""}${fmt(n, g.decimals)}${g.percent ? "%" : ""}` : oor ? "out of range" : "–";
          return `<div class="es-tool-row"><div><b title="${esc(g.name)}">${esc(g.name)}</b></div><b class="es-sens-num${oor ? " feel-sens-oor" : ""}">${text}</b></div>`;
        })
        .join("");

      if (!oldDpiTouched) f("olddpi").value = f("dpi").value; // follows Mouse DPI until edited
      const swapped = dpiSwap(v, parseFloat(f("olddpi").value), parseFloat(f("newdpi").value));
      results["use-dpi"] = swapped;
      show(o("dpiswap"), swapped, 3, false);

      const { ads, scoped } = zoomMults();
      o("zoom").innerHTML = zoomRows(v, d, ads, scoped)
        .map((r) => `<tr><td>${r.zoom}×<small>${r.what}</small></td><td>${r.kind === "ads" ? "ADS" : "Scoped"} ${fmt(r.mult, 3)}</td><td>${Number.isFinite(r.cm360) ? r.cm360.toFixed(1) : "–"}</td><td class="feel-sens-dim">${r.match0.toFixed(3)}</td></tr>`)
        .join("");
    }

    // Range check, hand the value to the lobby's sensitivity field, then read back what the trainer saved.
    async function apply(act, value) {
      if (!Number.isFinite(value)) {
        let msg = "Enter a sensitivity first.";
        if (act === "use-dpi" && ok(parseFloat(f("val").value))) msg = "Enter your new DPI.";
        if (act === "use-conv" && o("conv").classList.contains("feel-sens-oor")) msg = "Out of range for that game.";
        return say(act, msg, true);
      }
      const rounded = +value.toFixed(3);
      if (!inTrainerRange(rounded)) return say(act, `Out of range (${TRAINER_MIN}–${TRAINER_MAX}).`, true);
      if (!useSens(rounded)) return say(act, "Open the lobby to change the trainer's sensitivity.", true);
      await new Promise((r) => setTimeout(r, 50));
      let saved = NaN;
      try { saved = parseFloat(localStorage.getItem("al-sensitivity-v1")); } catch {}
      // The trainer only saves when the value changes, so on a fresh profile re-setting the
      // default (0.5) leaves the key empty; then the lobby field is the read-back.
      if (!Number.isFinite(saved)) saved = parseFloat(sensInput()?.value);
      if (!(Math.abs(saved - rounded) < 0.0005)) return say(act, "The trainer didn't take it. Open the lobby and try again.", true);
      let extra = "";
      if (act === "use-dpi") {
        // The new DPI is now the mouse DPI, so the panel's numbers stay right.
        f("dpi").value = f("olddpi").value = f("newdpi").value;
        f("newdpi").value = "";
        oldDpiTouched = false;
        extra = ` Mouse DPI set to ${f("dpi").value}.`;
      }
      f("val").value = fmt(saved);
      update();
      say(act, `Trainer sensitivity set to ${fmt(saved)}.${extra}`);
    }

    let oldDpiTouched = false;
    body.addEventListener("input", (e) => {
      if (e.target === f("olddpi")) oldDpiTouched = true;
      update();
    });
    body.addEventListener("change", update);
    body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const { act } = btn.dataset;
      apply(act, act === "use-val" ? parseFloat(f("val").value) : results[act]);
    });
    update();
  }

  window.__aimTools = { openBackups, openSens, close: closePanel, sensMath };
})();
