// Find my sens: plays one 60 s drill 6 times at 3 sensitivities and says if one scored better.
// Logic lives in feel-sens-finder-core.js (window.__aimSensFinderCore); this file is the page side:
// - a "Find my sens" block added to the top of the Sens tools panel (player-tools.js) when it opens;
// - a small card at the top of the screen while a session runs (Next run / Continue / Stop). It never
//   takes focus, never reacts to keys and hides while a run is being played;
// - the result panel (Use / Keep).
// Drills are launched like a lobby click (window.__aimLaunchWorkshop) and closed with
// window.__aimLeaveTraining (tools/training_launch_patch.py). The sens is changed through the
// lobby's sens field, the same way the Sens tools' "Use in trainer" does.
// While a session exists window.__aimSensFinderActive is true; it won't start while a training
// routine runs (sessionStorage aim-training-routine-run-v1) or in Round mode.
(() => {
  if (window.__aimSensFinder) return;
  const C = window.__aimSensFinderCore;
  if (!C) { console.error("SENS FINDER: feel-sens-finder-core.js is missing"); return; }

  const DPI_KEY = "es-mouse-dpi";
  const store = (s) => ({
    get: (k) => { try { return s().getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? s().removeItem(k) : s().setItem(k, v); } catch {} },
  });
  const local = store(() => localStorage);
  const session = store(() => sessionStorage);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = C.fmt;

  // ---------- page ----------
  const sensInput = () => document.querySelector(".hall-sens input");
  // A drill counts as open from its loading screens on (same test as training-routines.js).
  const layerOpen = () => !!document.querySelector(".hall-train-layer, .hall-train-loading, .al-wkload") || document.body.classList.contains("al-training-active");
  const lobbyReady = () => {
    const root = document.querySelector(".hall-root");
    return !layerOpen() && !!root && !root.inert && !!sensInput();
  };
  function readSens() {
    const saved = parseFloat(local.get(C.SENS_KEY));
    if (Number.isFinite(saved) && saved > 0) return saved;
    // The trainer only saves when the value changes; on a fresh profile the field is the answer.
    const v = parseFloat(sensInput()?.value);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  }
  // Same as player-tools.js useSens(): hand the value to the lobby field.
  function setSens(value) {
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
  // Aim aids or drill tunables switched on (they change how the drill plays). Best effort: any
  // true value in the aim aids settings, or saved tunables for the drill.
  function aidsOn(code) {
    const anyTrue = (o, depth = 0) => o === true || (depth < 4 && !!o && typeof o === "object" && Object.values(o).some((v) => anyTrue(v, depth + 1)));
    try { if (anyTrue(JSON.parse(local.get("al-aim-aids-v1") || "null"))) return true; } catch {}
    try {
      const t = JSON.parse(local.get("al-workshop-tunables-v1") || "null");
      const mine = t && typeof t === "object" ? t[code] : null;
      if (mine && typeof mine === "object" && Object.keys(mine).length) return true;
    } catch {}
    return false;
  }
  const dpi = () => {
    const d = parseInt(local.get(DPI_KEY), 10);
    return d > 0 ? d : NaN;
  };
  const cm360 = (sens) => {
    const f = window.__aimTools?.sensMath?.cm360;
    const d = dpi();
    return f && d ? f(sens, d) : NaN;
  };

  // ---------- styles ----------
  const CSS = `
.feel-sf-card { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147482500; display: flex; align-items: center; gap: 12px; max-width: min(640px, calc(100vw - 32px)); padding: 8px 8px 8px 14px; color: var(--es-text); background: var(--es-panel); border-top: 3px solid var(--es-red); outline: 1px solid var(--es-line-2); outline-offset: -1px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); font-family: var(--es-head); font-size: 13px; line-height: 1.35; }
.feel-sf-card[hidden] { display: none; }
.feel-sf-card-text { min-width: 0; }
.feel-sf-card-text b { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--es-red-2); }
.feel-sf-card-text span { display: block; color: var(--es-soft); font-variant-numeric: tabular-nums; }
.feel-sf-card-text small { display: block; margin-top: 2px; font-size: 11px; color: var(--es-muted); }
.feel-sf-card-btns { display: flex; flex: none; gap: 8px; }
.feel-sf-card button { height: 30px; padding: 0 14px; color: var(--es-text); cursor: pointer; background: var(--es-raised-2); border: none; border-left: 3px solid transparent; font: 700 13px var(--es-head); font-stretch: 75%; letter-spacing: 0.04em; text-transform: uppercase; }
.feel-sf-card button:hover { background: var(--es-line); border-left-color: var(--es-red); }
.feel-sf-card button.feel-sf-primary { background: var(--es-red); border-left: none; clip-path: var(--es-slant-sm); padding: 0 18px; font-style: italic; font-weight: 800; }
.feel-sf-card button.feel-sf-primary:hover { background: var(--es-red-2); }
.feel-sf-card button:focus-visible, .feel-sf-sec button:focus-visible, .feel-sf-result button:focus-visible { outline: 2px solid var(--es-red); outline-offset: 2px; }
html[data-aim-local]:not(#es) body .feel-sf-card button { border-radius: 0 !important; text-transform: uppercase !important; }
html[data-aim-local]:not(#es) body .feel-sf-card button.feel-sf-primary { clip-path: var(--es-slant-sm) !important; }
.feel-sf-sec { margin: 0 0 12px; padding: 12px 12px 10px; background: var(--es-red-wash); border-left: 3px solid var(--es-red); }
.es-tool-body .feel-sf-sec h3 { margin: 0 0 4px; }
.feel-sf-sec p { margin: 0 0 8px; font-size: 13px; line-height: 1.45; color: var(--es-soft); }
.feel-sf-sec p.feel-sf-warn { color: var(--es-warn, var(--es-red-2)); }
.feel-sf-sec p.feel-sf-last { margin: 6px 0 0; font-size: 12px; color: var(--es-muted); }
.feel-sf-sec .es-tool-actions { margin: 0; }
.feel-sf-sec .es-tool-status { margin: 6px 0 0; min-height: 0; }
.feel-sf-sec .es-tool-status:empty { display: none; }
.feel-sf-sec button small { margin-left: 6px; font-weight: 400; color: var(--es-muted); text-transform: none; }
.es-tool.feel-sf-result { width: min(560px, 100%); }
.feel-sf-verdict { margin: 4px 0 12px; padding: 10px 12px; background: var(--es-raised); border-left: 3px solid var(--es-line-2); }
.feel-sf-verdict.is-clear { border-left-color: var(--es-green); }
.feel-sf-verdict.is-lean { border-left-color: var(--es-warn, var(--es-red-2)); }
.feel-sf-verdict b { display: block; font-size: 15px; font-weight: 700; line-height: 1.4; }
.feel-sf-verdict p { margin: 6px 0 0; font-size: 13px; line-height: 1.45; color: var(--es-soft); }
.feel-sf-runs { width: 100%; border-collapse: separate; border-spacing: 0 3px; font-variant-numeric: tabular-nums; }
.feel-sf-runs th { padding: 0 10px 2px; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--es-muted); }
.feel-sf-runs td { padding: 6px 10px; font-size: 13px; background: var(--es-raised); }
.feel-sf-runs :is(th, td):nth-child(n + 2) { text-align: right; }
.feel-sf-runs tr.is-pick td { background: var(--es-red-wash); }
.feel-sf-runs tr.is-void td { color: var(--es-muted); }
.feel-sf-runs td small { display: block; font-size: 11px; color: var(--es-muted); }
.feel-sf-result .feel-sf-foot { margin: 8px 0 0; font-size: 12px; line-height: 1.45; color: var(--es-muted); }
`;
  function ensureCss() {
    if (document.getElementById("feel-sf-css")) return;
    const style = document.createElement("style");
    style.id = "feel-sf-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---------- runner ----------
  const env = {
    now: () => Date.now(),
    rand: () => Math.random(),
    every: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
    after: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
    readSens,
    setSens,
    lobbyReady,
    drillOpen: layerOpen,
    pickerOpen: () => !!document.querySelector(".aim-pick-shade"),
    roundOn: () => !!window.__aimRoundOn,
    routineActive: () => session.get(C.ROUTINE_KEY) !== null,
    aidsOn,
    launch: (code) => typeof window.__aimLaunchWorkshop === "function" && window.__aimLaunchWorkshop(code) === true,
    leave: () => typeof window.__aimLeaveTraining === "function" && window.__aimLeaveTraining() === true,
    loadRun: () => local.get(C.RUN_KEY),
    saveRun: (json) => local.set(C.RUN_KEY, json),
    loadHistory: () => local.get(C.HISTORY_KEY),
    saveHistory: (json) => local.set(C.HISTORY_KEY, json),
    setActive: (on) => { if (on) window.__aimSensFinderActive = true; else delete window.__aimSensFinderActive; },
    render: (v) => { lastView = v; render(); },
  };
  let lastView = { phase: "idle", note: "" };
  let roundPhase = null; // aim-round-phase of the open drill
  const runner = C.createRunner(env);

  // ---------- card ----------
  let card = null;
  function cardEl() {
    if (card && card.isConnected) return card;
    ensureCss();
    card = document.createElement("div");
    cardSig = "";
    card.className = "feel-sf-card";
    card.setAttribute("role", "status");
    card.hidden = true;
    // Mouse presses don't move focus here (the game keeps R / Esc) and don't reach the game.
    for (const type of ["pointerdown", "mousedown"]) {
      card.addEventListener(type, (e) => { e.stopPropagation(); if (e.target.closest("button")) e.preventDefault(); });
    }
    for (const type of ["pointerup", "mouseup", "dblclick"]) card.addEventListener(type, (e) => e.stopPropagation());
    let lastClick = 0;
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      const b = e.target.closest("button[data-sf]");
      if (!b) return;
      // The card redraws (and Stop can move under the pointer) right after a click: a double
      // click must not hit the next button.
      const now = Date.now();
      if (e.detail > 1 || now - lastClick < 600) return;
      lastClick = now;
      const act = b.dataset.sf;
      if (act === "next") runner.next();
      else if (act === "resume") runner.resume();
      else if (act === "stop") runner.stop();
      else if (act === "result") runner.finish();
      else if (act === "ok") runner.closeResult();
    });
    document.body.appendChild(card);
    return card;
  }
  function cardContent(v) {
    const n = Math.min(v.step + 1, C.RUNS);
    const stop = `<button type="button" data-sf="stop">Stop</button>`;
    const sub = v.note ? `<small>${esc(v.note)}</small>` : "";
    switch (v.phase) {
      case "launching":
        return { text: `Starting run ${n} of ${C.RUNS} at ${fmt(v.sens)}`, sub, btns: stop };
      case "playing":
        return { text: `Run ${n} of ${C.RUNS} at ${fmt(v.sens)}. Play the drill to the end.`, sub, btns: stop };
      case "between":
        return { text: `Run ${v.step} of ${C.RUNS} done. Next run at ${fmt(v.sens)}.`, sub, btns: `<button type="button" class="feel-sf-primary" data-sf="next">Next run</button>${stop}` };
      case "paused":
        return { text: v.note || `Sens finder paused, ${v.done} of ${C.RUNS} runs done.`, sub: "", btns: `<button type="button" class="feel-sf-primary" data-sf="resume">Continue</button>${stop}` };
      case "done":
        return { text: `All ${C.RUNS} runs done.`, sub, btns: `<button type="button" class="feel-sf-primary" data-sf="result">See result</button>${stop}` };
      case "stopping":
        return { text: "Putting your sens back.", sub: "", btns: "" };
      default:
        return v.note && v.phase === "idle" ? { text: v.note, sub: "", btns: `<button type="button" data-sf="ok">OK</button>` } : null;
    }
  }
  let cardSig = "";
  function renderCard() {
    const v = lastView;
    const c = cardContent(v);
    // Hidden while a run is being played (or its pause menu is up) so it never covers the drill.
    const live = layerOpen() && (roundPhase === "running" || roundPhase === "paused");
    if (!c || live || v.phase === "result") {
      if (card) card.hidden = true;
      return;
    }
    const el = cardEl();
    const sig = JSON.stringify(c);
    if (sig !== cardSig) {
      cardSig = sig;
      el.innerHTML = `<div class="feel-sf-card-text"><b>Find my sens${v.drill ? ` · ${esc(v.drill)}` : ""}</b><span>${esc(c.text)}</span>${c.sub}</div><div class="feel-sf-card-btns">${c.btns}</div>`;
      el.querySelectorAll("button").forEach((b) => b.setAttribute("tabindex", "-1"));
    }
    el.hidden = false;
  }

  // ---------- Sens tools block ----------
  function lastLine() {
    const h = C.parseHistory(local.get(C.HISTORY_KEY));
    const e = h[h.length - 1];
    if (!e) return "";
    const d = C.drillById(e.drill);
    const when = new Date(e.at).toLocaleDateString([], { day: "numeric", month: "short" });
    const what = e.verdict === "clear" || e.verdict === "lean"
      ? `${e.verdict === "clear" ? "better" : "slightly better"} at ${fmt(e.pick)} than ${fmt(e.origSens)}`
      : e.verdict === "none" ? `no clear difference around ${fmt(e.origSens)}` : "not enough runs";
    return `Last time (${when}, ${d ? d.label : "drill"}): ${what}.`;
  }
  function sectionHtml() {
    const v = lastView;
    const busy = v.phase !== "idle" && v.phase !== "result";
    const last = lastLine();
    const intro = `Plays the same 60 s drill ${C.RUNS} times at 3 sensitivities (about 8 minutes), then tells you if one scored better. Warm up with a drill or two first. These runs count in your drill history and PBs.`;
    if (busy) {
      return `<h3>Find my sens</h3><p>The sens finder is running. Use the card at the top of the screen to continue or stop it.</p>`;
    }
    const btns = C.DRILLS.map((d) => `<button type="button" data-sf-start="${d.id}">${esc(d.label)}<small>${esc(d.drill)}</small></button>`).join("");
    return `<h3>Find my sens</h3><p>${esc(intro)}</p>
      <p class="feel-sf-warn" data-sf-aids hidden>Aim aids are on. That's fine, but keep them the same for all runs.</p>
      <div class="es-tool-actions">${btns}</div>
      <p class="es-tool-status is-bad" role="status" data-sf-status></p>
      ${last ? `<p class="feel-sf-last">${esc(last)}</p>` : ""}`;
  }
  function fillSection(sec) {
    // Only redrawn when what it shows changes (keeps the status line and hover state).
    const sig = `${lastView.phase !== "idle" && lastView.phase !== "result"}|${local.get(C.HISTORY_KEY) || ""}`;
    if (sec.dataset.sig === sig) return;
    sec.dataset.sig = sig;
    sec.innerHTML = sectionHtml();
    const aids = sec.querySelector("[data-sf-aids]");
    if (aids) aids.hidden = !C.DRILLS.some((d) => aidsOn(d.code));
  }
  function injectSection(panelEl) {
    if (panelEl.querySelector(".feel-sf-sec")) return;
    const body = panelEl.querySelector(".es-tool-body");
    if (!body) return;
    ensureCss();
    const sec = document.createElement("section");
    sec.className = "feel-sf-sec";
    fillSection(sec);
    sec.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-sf-start]");
      if (!b) return;
      const id = b.dataset.sfStart;
      const status = sec.querySelector("[data-sf-status]");
      // The Sens tools panel sits over the lobby: close it first, then start from this click.
      const check = runner.canStart(id);
      if (!check.ok) { if (status) status.textContent = check.reason; return; }
      window.__aimTools?.close?.();
      const r = runner.start(id);
      if (!r.ok) console.warn("SENS FINDER:", r.reason);
    });
    body.prepend(sec);
  }
  function refreshSection() {
    for (const sec of document.querySelectorAll(".feel-sf-sec")) fillSection(sec);
  }
  const sensPanel = () => document.querySelector('.es-tool-shade .es-tool[aria-label="Sensitivity tools"]');

  // ---------- result panel ----------
  let resultEl = null;
  function closeResultPanel() {
    resultEl?.remove();
    resultEl = null;
  }
  function openResultPanel(rec) {
    if (resultEl) return;
    ensureCss();
    window.__aimTools?.close?.();
    const showCm = Number.isFinite(dpi()) && !!window.__aimTools?.sensMath;
    const levelName = { base: "yours", low: "lower", high: "higher" };
    const rows = rec.rows.map((r) => {
      const cm = cm360(r.sens);
      const why = r.valid ? "" : `<small>didn't count${r.why ? `: ${esc(r.why)}` : ""}</small>`;
      return `<tr class="${rec.pick !== null && r.sens === rec.pick ? "is-pick" : ""}${r.valid ? "" : " is-void"}">
        <td>${r.n}</td><td>${fmt(r.sens)}<small>${levelName[r.level]}</small></td>
        ${showCm ? `<td>${Number.isFinite(cm) ? cm.toFixed(1) : "-"}</td>` : ""}
        <td>${r.score === null ? "-" : Math.round(r.score)}${why}</td>
        <td>${r.accuracy === null ? "-" : `${Math.round(r.accuracy)}%`}</td></tr>`;
    }).join("");
    const [head, ...rest] = rec.lines;
    const pick = rec.pick;
    const keep = rec.origSens;
    const shade = document.createElement("div");
    shade.className = "es-tool-shade feel-sf-shade";
    shade.innerHTML = `<section class="es-tool feel-sf-result" role="dialog" aria-label="Find my sens result">
      <header class="es-tool-head"><div><h2>Find my sens</h2><p>${esc(rec.drill ? rec.drill.drill : "")}: ${C.RUNS} runs at ${fmt(rec.levels.low.sens)}, ${fmt(rec.levels.base.sens)} and ${fmt(rec.levels.high.sens)}.</p></div>
      <button type="button" class="es-tool-x" aria-label="Close">✕</button></header>
      <div class="es-tool-body">
        <div class="feel-sf-verdict is-${rec.verdict}"><b>${esc(head || "")}</b>${rest.map((l) => `<p>${esc(l)}</p>`).join("")}</div>
        <table class="feel-sf-runs"><thead><tr><th>Run</th><th>Sens</th>${showCm ? "<th>cm / 360°</th>" : ""}<th>Score</th><th>Hit rate</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="es-tool-actions" style="margin-top:12px">
          ${pick !== null ? `<button type="button" class="es-tool-primary" data-sf-use="${pick}">Use ${fmt(pick)}</button><button type="button" data-sf-keep>Keep ${fmt(keep)}</button>` : `<button type="button" class="es-tool-primary" data-sf-keep>Done</button>`}
        </div>
        <p class="es-tool-status" role="status" data-sf-status></p>
        <p class="feel-sf-foot">Your sens is back to ${fmt(keep)} until you choose.</p>
      </div></section>`;
    const done = () => { closeResultPanel(); runner.closeResult(); };
    const openedAt = Date.now(); // the second press of a double click on See result lands here
    shade.addEventListener("mousedown", (e) => { if (e.target === shade && Date.now() - openedAt > 600) done(); });
    shade.querySelector(".es-tool-x").addEventListener("click", done);
    for (const type of ["keydown", "keyup", "keypress"]) {
      shade.addEventListener(type, (e) => {
        if (type === "keydown" && e.key === "Escape") done();
        e.stopPropagation();
      });
    }
    shade.addEventListener("click", (e) => {
      if (e.target.closest("[data-sf-keep]")) { done(); return; }
      const use = e.target.closest("[data-sf-use]");
      if (!use) return;
      const value = parseFloat(use.dataset.sfUse);
      const status = shade.querySelector("[data-sf-status]");
      if (!setSens(value)) { status.textContent = "Open the lobby to change the trainer's sensitivity."; status.classList.add("is-bad"); return; }
      setTimeout(() => {
        if (C.same(readSens(), value)) {
          status.textContent = `Trainer sensitivity set to ${fmt(value)}.`;
          status.classList.remove("is-bad");
          shade.querySelector(".feel-sf-foot")?.remove();
          use.remove();
          const k = shade.querySelector("[data-sf-keep]");
          if (k) { k.textContent = "Done"; k.classList.add("es-tool-primary"); }
        } else {
          status.textContent = "The trainer didn't take it. Open the lobby and try again.";
          status.classList.add("is-bad");
        }
      }, 80);
    });
    document.body.appendChild(shade);
    resultEl = shade;
  }

  // ---------- wiring ----------
  function render() {
    renderCard();
    if (lastView.phase === "result" && lastView.result) {
      // Shown once the lobby is back (See result closes the drill first).
      if (!resultEl && !layerOpen()) openResultPanel(lastView.result);
    } else if (resultEl) closeResultPanel();
    if (document.querySelector(".feel-sf-sec")) refreshSection();
  }

  addEventListener("aim-local-scene", (e) => runner.onScene(e.detail && e.detail.id));
  addEventListener("aim-local-result", (e) => runner.onResult(e.detail));
  addEventListener("aim-round-phase", (e) => { roundPhase = e.detail ? e.detail.phase : null; renderCard(); });

  // The Sens tools panel and the lobby come and go; one cheap observer handles both.
  let queued = false;
  const tick = () => {
    queued = false;
    const p = sensPanel();
    if (p) injectSection(p);
    if (!layerOpen()) roundPhase = null;
    render();
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(tick);
  }).observe(document.body, { childList: true });
  // The drill layer toggles a body class rather than (only) adding nodes.
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(tick); } }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  runner.init();
  window.__aimSensFinder = {
    open: () => window.__aimTools?.openSens?.(),
    view: () => runner.view(),
    stop: () => runner.stop(),
  };
})();
