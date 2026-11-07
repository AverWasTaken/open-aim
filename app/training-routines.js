// Routines: play a set of drills in a row (Daily warm-up, Precision, Holding angles, Movement &
// peeks). Logic and routine definitions live in training-routines-core.js (window.aimRoutinesCore).
// - Lobby: a "Routines" strip above the drill sections with one card per routine, and a
//   "Continue routine" row while a routine is paused.
// - Start / Next drill / Continue launch drills like a lobby click (window.__aimLaunchWorkshop,
//   tools/training_launch_patch.py), so the rank picker, run history and 'aim-local-result' work
//   as usual. "Next drill" first closes the open drill (window.__aimLeaveTraining).
// - Result screen: a routine bar above the shooting summary with Next drill / End routine.
// - After the last drill: a summary (score, hit rate, personal best per drill, time played).
// The routine in progress is kept in sessionStorage (aim-training-routine-run-v1); a reload always
// leaves it paused in the lobby. Finished routines go to localStorage aim-training-routines-v1.
(() => {
  if (window.__aimTrainingRoutines) return;
  window.__aimTrainingRoutines = true;
  const C = window.aimRoutinesCore;
  if (!C) { console.error("ROUTINES: training-routines-core.js is missing"); return; }

  const LIST_URL = "/prod-api/api/v1/public/val/aimlab/workshop";
  const VARIANTS_URL = "/aim/drill-variants.json";
  const LAUNCH_WAIT_MS = 10000; // no drill opened by then: back to paused
  const LEAVE_WAIT_MS = 10000;
  const PICKER_GRACE_MS = 4000; // rank picker closed, drill not open by then: cancelled

  const store = (s) => ({
    get: (k) => { try { return s().getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? s().removeItem(k) : s().setItem(k, v); } catch {} },
  });
  const session = store(() => sessionStorage);
  const local = store(() => localStorage);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- drill list ----------
  let catalogue = null;
  let variants = {};
  let loading = null;
  const warned = new Set();
  function load() {
    loading ??= Promise.all([
      fetch(LIST_URL, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(VARIANTS_URL, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([list, v]) => {
      if (list && Array.isArray(list.data)) catalogue = list.data;
      if (v && v.variants && typeof v.variants === "object") variants = v.variants;
      schedule();
    }).finally(() => { loading = null; });
    return loading;
  }
  load();
  addEventListener("focus", () => load());

  function routines() {
    if (!catalogue) return [];
    const defs = C.ROUTINES.slice();
    const t = C.testRoutine(session.get(C.TEST_KEY));
    if (t) defs.unshift(t);
    const out = [];
    for (const def of defs) {
      const r = C.resolve(def, catalogue, variants, (code, id) => {
        const key = id + ":" + code;
        if (warned.has(key)) return;
        warned.add(key);
        console.warn(`ROUTINES: drill ${code} of routine "${id}" is not in the drill list; skipped`);
      });
      if (r) out.push(r);
    }
    return out;
  }

  // ---------- routine in progress ----------
  let run = C.restore(session.get(C.RUN_KEY)); // always paused after a reload
  const save = () => session.set(C.RUN_KEY, run ? JSON.stringify(run) : null);
  save();
  let pending = null; // launch watch: {at, picker, layer, timer}
  let leaving = null; // "Next drill" waiting for the lobby

  const layerOpen = () => !!document.querySelector(".hall-train-layer") || document.body.classList.contains("al-training-active");
  const lobbyReady = () => {
    const root = document.querySelector(".hall-root");
    return !layerOpen() && !!root && !root.inert;
  };

  function stopWatching() {
    if (pending) clearInterval(pending.timer);
    pending = null;
    if (leaving) clearInterval(leaving);
    leaving = null;
  }
  function setRun(next) {
    run = next;
    save();
    if (!run || run.phase !== "launching") stopWatching();
    schedule();
  }
  const failLaunch = () => { if (run && run.phase === "launching") setRun(C.pause(run)); else stopWatching(); };

  // Starts codes[index] like a lobby click. Runs inside the click handler when it can, so the
  // game's fullscreen request and the rank picker work as usual.
  function launch() {
    if (!run || run.phase !== "launching") return;
    const item = C.itemFor(run.codes[run.index], catalogue, variants);
    let ok = false;
    try {
      ok = !!item && typeof window.__aimLaunchWorkshop === "function" && window.__aimLaunchWorkshop(item);
    } catch (err) {
      console.error("ROUTINES:", err);
    }
    if (!ok) { failLaunch(); return; }
    watchLaunch();
  }
  // The rank picker can be open for a while, be cancelled, or drop the launch: no matching
  // 'aim-local-scene' means the routine goes back to paused at this step.
  function watchLaunch() {
    if (pending) clearInterval(pending.timer);
    pending = { at: Date.now(), picker: false, layer: false };
    pending.timer = setInterval(() => {
      if (!run || run.phase !== "launching" || !pending) { stopWatching(); return; }
      const now = Date.now();
      if (document.querySelector(".aim-pick-shade")) { pending.picker = true; pending.at = now; return; }
      if (layerOpen()) { pending.layer = true; if (now - pending.at > 180000) failLaunch(); return; }
      if (pending.layer) { failLaunch(); return; } // the drill was closed before it came up
      // Picker gone and no drill opening: it was cancelled (a pick opens the drill at once).
      if (pending.picker && now - pending.at > PICKER_GRACE_MS) { failLaunch(); return; }
      if (now - pending.at > LAUNCH_WAIT_MS) failLaunch();
    }, 250);
  }
  // Waits until the open drill is closed and the lobby takes clicks again, then launches.
  function launchFromLobby() {
    if (lobbyReady()) { launch(); return; }
    const started = Date.now();
    if (leaving) clearInterval(leaving);
    leaving = setInterval(() => {
      if (!run || run.phase !== "launching") { clearInterval(leaving); leaving = null; return; }
      if (lobbyReady()) { clearInterval(leaving); leaving = null; launch(); return; }
      if (Date.now() - started > LEAVE_WAIT_MS) { clearInterval(leaving); leaving = null; failLaunch(); }
    }, 100);
  }

  function startRoutine(id) {
    const r = routines().find((x) => x.id === id);
    if (!r) return;
    closeSummary();
    stopWatching();
    setRun(C.start(r, Date.now()));
    launch();
  }
  function continueRoutine() {
    if (!run) return;
    stopWatching();
    if (C.isDone(run)) { openSummary(run); return; }
    setRun(C.advance(run, Date.now()));
    launchFromLobby();
  }
  function nextDrill() {
    if (!run || !run.results[run.index]) return;
    stopWatching();
    setRun(C.advance(run, Date.now()));
    if (run.phase !== "launching") return;
    try { window.__aimLeaveTraining?.(); } catch (err) { console.error("ROUTINES:", err); }
    launchFromLobby();
  }
  function endRoutine() {
    const r = run;
    stopWatching();
    setRun(null);
    if (r && r.results.some(Boolean)) openSummary(r);
  }

  addEventListener("aim-local-scene", (e) => {
    if (!run) return;
    const next = C.onScene(run, e.detail && e.detail.id, variants);
    if (next !== run) setRun(next);
  });
  addEventListener("aim-local-result", (e) => {
    if (!run) return;
    const next = C.onResult(run, e.detail && e.detail.record, variants);
    if (next === run) return;
    setRun(next);
    if (C.isDone(run)) {
      const saved = C.addCompletion(C.readStore(local.get(C.STORE_KEY)), run, Date.now());
      local.set(C.STORE_KEY, JSON.stringify(saved));
    }
  });

  // ---------- summary ----------
  let summaryEl = null;
  function closeSummary() {
    if (!summaryEl) return;
    removeEventListener("keydown", summaryEl.onKey, true);
    summaryEl.remove();
    summaryEl = null;
  }
  const PB_TEXT = { pb: "New PB", first: "First run", off: "", none: "" };
  function openSummary(r) {
    closeSummary();
    const s = C.summary(r, C.parseRuns(local.get(C.RUNS_KEY)), variants);
    const rows = s.rows.map((row) => {
      const res = row.result;
      const pb = row.pb ? PB_TEXT[row.pb.kind] : "";
      const best = row.pb && row.pb.kind === "off" && row.pb.best ? `PB ${C.formatValue({ ...row.pb.best, type: res.type })}` : "";
      return `<tr class="${res ? "" : "is-skipped"}">
        <td class="tr-sum-no">${row.index + 1}</td>
        <td class="tr-sum-name">${esc(row.name)}</td>
        <td class="tr-num">${res ? esc(C.formatValue(res)) : "Not played"}</td>
        <td class="tr-num">${res ? esc(C.formatAccuracy(res)) : ""}</td>
        <td class="tr-sum-pb">${pb ? `<span class="tr-pb">${pb}</span>` : best ? `<span class="tr-pb-best">${esc(best)}</span>` : ""}</td>
      </tr>`;
    }).join("");
    const shade = document.createElement("div");
    shade.className = "es-tool-shade tr-sum-shade";
    shade.innerHTML = `<section class="es-tool tr-sum" role="dialog" aria-modal="true" aria-labelledby="tr-sum-title">
      <header class="es-tool-head"><div><h2 id="tr-sum-title">${esc(r.name)}</h2>
      <p>${s.complete ? "Routine done." : "Routine ended early."} ${s.pbs ? `${s.pbs} new ${s.pbs === 1 ? "PB" : "PBs"}.` : ""}</p></div>
      <button type="button" class="es-tool-x" aria-label="Close">✕</button></header>
      <div class="es-tool-body">
        <table class="tr-sum-table"><thead><tr><th>#</th><th>Drill</th><th class="tr-num">Score</th><th class="tr-num">Hit rate</th><th>PB</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="tr-sum-foot"><span class="tr-sum-time">Time played <b>${C.formatClock(s.played)}</b></span>
        <div class="es-tool-actions"><button type="button" class="es-tool-primary" data-act="done">Done</button></div></div>
      </div></section>`;
    const done = () => {
      closeSummary();
      if (run && run.startedAt === r.startedAt && run.id === r.id) setRun(null);
    };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) shade.addEventListener(type, (e) => e.stopPropagation());
    shade.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target === shade || e.target.closest(".es-tool-x") || e.target.closest("[data-act=done]")) done();
    });
    shade.onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(); }
    };
    addEventListener("keydown", shade.onKey, true);
    document.body.appendChild(shade);
    summaryEl = shade;
    shade.querySelector("[data-act=done]").focus({ preventScroll: true });
  }

  // ---------- lobby strip ----------
  // Sits right above the first drill section of the VALORANT training list.
  function lobbyAnchor() {
    if (layerOpen()) return null;
    const first = document.querySelector(".hall-root [data-section]");
    if (!first || !first.querySelector(".al-wk-card") || !first.parentElement) return null;
    return first;
  }
  function stripSig(list, now) {
    const store = C.readStore(local.get(C.STORE_KEY));
    const cards = list.map((r) => {
      const last = C.lastDone(store, r.id, now);
      const days = C.streak(store, r.id, now);
      return { id: r.id, name: r.name, blurb: r.blurb, n: r.steps.length, min: C.minutes(r.steps), drills: r.steps.map((s) => s.name), last: last.label, days };
    });
    const state = run ? { id: run.id, name: run.name, phase: run.phase, i: C.nextIndex(run), n: run.codes.length, done: C.isDone(run), next: run.names[Math.min(C.nextIndex(run), run.codes.length - 1)] } : null;
    return { cards, state };
  }
  function stripHtml(sig) {
    const st = sig.state;
    let resume = "";
    if (st) {
      const step = `drill ${Math.min(st.i + 1, st.n)} of ${st.n}`;
      const text = st.done ? `<b>${esc(st.name)}</b> All drills played.`
        : st.phase === "launching" ? `<b>${esc(st.name)}</b> Starting ${step}: ${esc(st.next)}`
        : `<b>${esc(st.name)}</b> Paused at ${step}: ${esc(st.next)}`;
      const acts = st.done ? `<button type="button" class="tr-btn is-accent" data-act="summary">See summary</button>`
        : st.phase === "launching" ? "" : `<button type="button" class="tr-btn is-accent" data-act="continue">Continue routine</button>`;
      resume = `<div class="tr-resume" role="status"><span class="tr-resume-text">${text}</span><span class="tr-resume-acts">${acts}<button type="button" class="tr-btn is-ghost" data-act="end">End routine</button></span></div>`;
    }
    const cards = sig.cards.map((c) => `<article class="tr-card" data-routine="${esc(c.id)}">
      <div class="tr-card-head"><h3>${esc(c.name)}</h3><span class="tr-meta">${c.n} drills · ~${c.min} min</span></div>
      <p class="tr-blurb">${esc(c.blurb)}</p>
      <p class="tr-drills" title="${esc(c.drills.join(", "))}">${esc(c.drills.join(" · "))}</p>
      <div class="tr-card-foot"><span class="tr-last">Last done: <b>${esc(c.last)}</b>${c.days >= 2 ? ` · <b class="tr-streak">${c.days} day streak</b>` : ""}</span>
      <button type="button" class="tr-btn" data-act="start" data-routine="${esc(c.id)}" aria-label="Start ${esc(c.name)}">Start</button></div>
    </article>`).join("");
    return `<header class="tr-strip-head"><h2>Routines</h2><p>Play a set of drills in a row. Go to the next drill from the result screen.</p></header>${resume}<div class="tr-cards">${cards}</div>`;
  }
  function onStripClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    e.stopPropagation();
    const act = b.dataset.act;
    if (act === "start") startRoutine(b.dataset.routine);
    else if (act === "continue") continueRoutine();
    else if (act === "summary") { if (run) openSummary(run); }
    else if (act === "end") endRoutine();
  }
  function syncStrip() {
    const anchor = lobbyAnchor();
    let strip = document.querySelector(".tr-strip");
    const list = routines();
    // No drill list on screen (another tab, or every section filtered out): no strip. While a
    // drill is open the lobby stays underneath, so the strip is left alone.
    if (!anchor || !list.length) { if (strip && !layerOpen()) strip.remove(); return; }
    if (!strip) {
      strip = document.createElement("section");
      strip.className = "tr-strip";
      strip.setAttribute("aria-label", "Routines");
      strip.addEventListener("click", onStripClick);
    }
    if (strip.nextElementSibling !== anchor || strip.parentElement !== anchor.parentElement) anchor.before(strip);
    const sig = JSON.stringify(stripSig(list, Date.now()));
    if (strip.dataset.sig !== sig) {
      strip.dataset.sig = sig;
      strip.innerHTML = stripHtml(JSON.parse(sig));
    }
  }

  // ---------- result bar ----------
  // The usual result card (.al-result-modal) or the full-screen Scenario result (.al-mr-stage).
  function resultSpot() {
    const modal = document.querySelector(".al-result-modal");
    if (modal) {
      const actions = modal.querySelector(".al-run-actions");
      if (actions && actions.parentElement) {
        // Above every shell-added section (shooting summary, progress card) that sits right over
        // the buttons: those have classes but none of the game's "al-" ones.
        const added = (el) => {
          const cls = typeof el.className === "string" ? el.className.trim() : "";
          return cls !== "" && !cls.split(/\s+/).some((c) => c.startsWith("al-"));
        };
        let before = actions;
        for (let p = actions.previousElementSibling; p && added(p); p = p.previousElementSibling) {
          if (!p.classList.contains("tr-bar")) before = p;
        }
        return { kind: "card", parent: actions.parentElement, before };
      }
      const body = modal.querySelector(".al-run-body") || modal;
      return { kind: "card", parent: body, before: body.firstElementChild };
    }
    const stage = document.querySelector(".al-mr-stage");
    if (stage) return { kind: "moment", parent: document.body, before: null };
    return null;
  }
  function barSig() {
    if (!run || run.phase !== "playing" || !run.results[run.index]) return null;
    const n = run.codes.length;
    const last = run.index >= n - 1;
    return { name: run.name, at: run.index + 1, n, last, next: last ? "" : run.names[run.index + 1] };
  }
  function syncBar() {
    let bar = document.querySelector(".tr-bar");
    const sig = barSig();
    const spot = sig && resultSpot();
    if (!spot) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "tr-bar";
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "Routine");
      bar.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-act]");
        if (!b) return;
        e.stopPropagation();
        if (b.dataset.act === "next") nextDrill();
        else if (b.dataset.act === "summary") { if (run) openSummary(run); }
        else if (b.dataset.act === "end") endRoutine();
      });
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) bar.addEventListener(type, (e) => e.stopPropagation());
    }
    if (bar.classList.contains("is-floating") !== (spot.kind === "moment")) bar.classList.toggle("is-floating", spot.kind === "moment");
    if (spot.before) {
      if (bar.parentElement !== spot.parent || bar.nextElementSibling !== spot.before) spot.before.before(bar);
    } else if (bar.parentElement !== spot.parent) spot.parent.append(bar);
    const key = JSON.stringify(sig);
    if (bar.dataset.sig === key) return;
    bar.dataset.sig = key;
    const text = sig.last
      ? `<b>${esc(sig.name)}</b><span class="tr-bar-step">${sig.at}/${sig.n}</span><span>Last drill done</span>`
      : `<b>${esc(sig.name)}</b><span class="tr-bar-step">${sig.at}/${sig.n}</span><span>Next: ${esc(sig.next)}</span>`;
    const acts = sig.last
      ? `<button type="button" class="tr-btn" data-act="summary">See summary</button>`
      : `<button type="button" class="tr-btn" data-act="next">Next drill</button><button type="button" class="tr-btn is-ghost" data-act="end">End routine</button>`;
    bar.innerHTML = `<span class="tr-bar-text">${text}</span><span class="tr-bar-acts">${acts}</span>`;
  }

  // ---------- page watch ----------
  function sync() {
    // Back / menu out of a routine drill: paused, Continue starts it again.
    if (run && run.phase === "playing" && !layerOpen()) { run = C.pause(run); save(); }
    try { syncStrip(); } catch (err) { console.error("ROUTINES:", err); }
    try { syncBar(); } catch (err) { console.error("ROUTINES:", err); }
  }
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sync(); });
  }
  window.__aimWatchPage?.(schedule, { childList: true, subtree: true });
  addEventListener("storage", schedule);
  schedule();
})();
