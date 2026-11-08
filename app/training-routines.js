// Routines: play a set of drills in a row (Daily warm-up, Precision, Holding angles, Movement &
// peeks). Logic and routine definitions live in training-routines-core.js (window.aimRoutinesCore).
// - Lobby: a "Routines" strip above the drill sections with one card per routine, and a
//   "Continue routine" row while a routine is paused.
// - Start / Next drill / Continue launch drills like a lobby click (window.__aimLaunchWorkshop,
//   tools/training_launch_patch.py), so the rank picker, run history and 'aim-local-result' work
//   as usual. "Next drill" first closes the open drill (window.__aimLeaveTraining).
// - Result screen: a routine bar with Next drill / End routine. Inside ux's div.ux-result-extra
//   (app/ux-result.js, event "ux-result-extra") when the card has one, else above the shooting
//   summary. Scenario results: floating at the top.
// - After the last drill: a summary (score, hit rate, personal best per drill, time played).
// The routine in progress is kept in sessionStorage (aim-training-routine-run-v1); a reload always
// leaves it paused in the lobby. Finished routines go to localStorage aim-training-routines-v1.
// Hooks for other scripts (feel's sensitivity finder):
// - window CustomEvent "aim-routine-step", detail {routineId, index, total, shareCode, name}
//   (index 0-based), fired synchronously right before each routine drill is launched (Start,
//   Next drill, Continue). The launch can still be dropped after it (rank picker cancelled).
// - Start / Continue do nothing while window.__aimSensFinderActive is truthy; the strip shows
//   "Finish or stop the sensitivity finder first." for 4 s instead.
// Custom routines (player-made, localStorage aim-training-routines-custom-v1, see the core): one
// line of chips under the built-in cards with Start / Edit and "+ New routine", and an editor
// modal (name, drill search, chosen list with up / down / remove). Same runner as the built-ins.
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
  const esc = C.esc;

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

  const customStore = () => C.readCustom(local.get(C.CUSTOM_KEY));
  function warnMissing(code, id) {
    const key = id + ":" + code;
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`ROUTINES: drill ${code} of routine "${id}" is not in the drill list; skipped`);
  }
  // Built-ins (plus the test-only routine), then the player's own routines.
  function routines(cstore = customStore()) {
    if (!catalogue) return [];
    const defs = C.ROUTINES.slice();
    const t = C.testRoutine(session.get(C.TEST_KEY));
    if (t) defs.unshift(t);
    const out = [];
    for (const def of defs) {
      const r = C.resolve(def, catalogue, variants, warnMissing);
      if (r) out.push(r);
    }
    for (const def of C.customDefs(cstore)) out.push(C.resolveCustom(def, catalogue, variants, warnMissing));
    return out;
  }

  // ---------- routine in progress ----------
  let run = C.restore(session.get(C.RUN_KEY)); // always paused after a reload
  const save = () => session.set(C.RUN_KEY, run ? JSON.stringify(run) : null);
  save();
  let pending = null; // launch watch: {at, picker, layer, timer}
  let leaving = null; // "Next drill" waiting for the lobby
  let notice = null; // {text, until}: short line on the strip (refused Start / Continue)
  let noticeTimer = 0;
  // Refuses Start / Continue while feel's sensitivity finder runs; state stays untouched.
  function refusedBySensFinder() {
    if (!C.sensFinderBusy(window)) return false;
    notice = { text: C.SENS_NOTICE, until: Date.now() + C.NOTICE_MS };
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(schedule, C.NOTICE_MS + 50);
    schedule();
    return true;
  }

  // A drill counts as open from its loading screens on: the workshop loading panel (.al-wkload,
  // shown from the click) and the trainer download fallback (.hall-train-loading). 'aim-local-scene'
  // fires before the trainer layer mounts, so checking .hall-train-layer alone would pause the
  // routine on the first drill after the app opens.
  const layerOpen = () => !!document.querySelector(".hall-train-layer, .hall-train-loading, .al-wkload") || document.body.classList.contains("al-training-active");
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
      ok = C.launchStep(window, run, item); // "aim-routine-step", then the lobby launch
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
    if (refusedBySensFinder()) return;
    const r = routines().find((x) => x.id === id);
    if (!r || !r.steps.length) return; // a custom routine with none of its drills in the list
    closeSummary();
    stopWatching();
    setRun(C.start(r, Date.now()));
    launch();
  }
  function continueRoutine() {
    if (refusedBySensFinder()) return;
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
  // Model and markup live in the core (same markup at every window size; CSS makes it one line
  // at max-height 800px).
  const stripSig = (list, now, cstore) => C.stripModel(list, run, C.readStore(local.get(C.STORE_KEY)), now, notice, { custom: cstore });
  function onStripClick(e) {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    e.stopPropagation();
    const act = b.dataset.act;
    if (act === "start") startRoutine(b.dataset.routine);
    else if (act === "continue") continueRoutine();
    else if (act === "summary") { if (run) openSummary(run); }
    else if (act === "end") endRoutine();
    else if (act === "edit" || act === "new") {
      if (b.disabled || (run && run.phase === "launching")) return;
      openEditor(act === "edit" ? b.dataset.routine : null, b);
    }
  }
  // Chip rows (data-wheel-x): the vertical wheel scrolls them sideways while they can still move
  // (smooth-scroll.js leaves those events alone), else the lobby scrolls as usual.
  function onStripWheel(e) {
    if (e.defaultPrevented || e.ctrlKey || e.shiftKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const row = wheelRow(e.target, e.deltaY);
    if (!row) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * row.clientWidth : e.deltaY;
    row.scrollLeft += dy;
  }
  function wheelRow(target, dy) {
    for (let n = target && target.closest ? target.closest("[data-wheel-x]") : null; n; n = n.parentElement && n.parentElement.closest("[data-wheel-x]")) {
      const max = n.scrollWidth - n.clientWidth;
      if (max > 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX) && ((dy > 0 && n.scrollLeft < max - 1) || (dy < 0 && n.scrollLeft > 1))) return n;
    }
    return null;
  }
  function syncStrip() {
    const anchor = lobbyAnchor();
    let strip = document.querySelector(".tr-strip");
    const cstore = customStore();
    const list = routines(cstore);
    // No drill list on screen (another tab, or every section filtered out): no strip. While a
    // drill is open the lobby stays underneath, so the strip is left alone.
    if (!anchor || !list.length) { if (strip && !layerOpen()) strip.remove(); return; }
    if (!strip) {
      strip = document.createElement("section");
      strip.className = "tr-strip";
      strip.setAttribute("aria-label", "Routines");
      strip.addEventListener("click", onStripClick);
      strip.addEventListener("wheel", onStripWheel, { passive: false });
    }
    if (strip.nextElementSibling !== anchor || strip.parentElement !== anchor.parentElement) anchor.before(strip);
    const sig = JSON.stringify(stripSig(list, Date.now(), cstore));
    if (strip.dataset.sig !== sig) {
      strip.dataset.sig = sig;
      const model = JSON.parse(sig);
      strip.classList.toggle("has-run", !!model.state);
      strip.innerHTML = C.stripHtml(model);
    }
  }

  // ---------- custom routine editor ----------
  // Opens only from the lobby strip. Keys: Esc cancels, Enter does nothing in the text fields and
  // clicks a focused button, Tab stays inside. Every key event is stopped at window (capture) so
  // the game's hotkeys (R, Q, Esc...) never see typing; printable keys keep their default.
  let editor = null;
  function trySet(k, v) {
    try { localStorage.setItem(k, v); return true; } catch { return false; }
  }
  function openEditor(id, trigger) {
    if (editor) return;
    const cstore = customStore();
    if (cstore.readOnly) return;
    const old = id ? cstore.routines.find((r) => r.id === id) : null;
    if (id && !old) return;
    if (!id && cstore.routines.length >= C.CUSTOM_MAX) return;
    let draft = C.newDraft(cstore, old);
    let query = "";
    let confirming = false;
    let error = "";
    const shade = document.createElement("div");
    shade.className = "es-tool-shade tr-ed-shade";
    shade.innerHTML = `<section class="es-tool tr-ed" role="dialog" aria-modal="true" aria-labelledby="tr-ed-title">
      <header class="es-tool-head"><div><h2 id="tr-ed-title">${old ? "Edit routine" : "New routine"}</h2>
      <p>Pick ${C.CUSTOM_MIN_DRILLS} to ${C.CUSTOM_MAX_DRILLS} drills. They play in this order.</p></div>
      <button type="button" class="es-tool-x" data-act="cancel" aria-label="Close">✕</button></header>
      <div class="es-tool-body">
        <label class="tr-ed-label" for="tr-ed-name">Name</label>
        <input id="tr-ed-name" class="tr-ed-input" type="text" maxlength="${C.NAME_MAX}" autocomplete="off" spellcheck="false">
        <div class="tr-ed-cols">
          <div class="tr-ed-col">
            <h3>Drills</h3>
            <input class="tr-ed-input" type="search" data-search placeholder="Search drills or paste a code" aria-label="Search drills" autocomplete="off" spellcheck="false">
            <div class="es-tool-list tr-ed-list" data-pick></div>
          </div>
          <div class="tr-ed-col">
            <h3>Your routine <span class="tr-ed-count" data-count></span></h3>
            <ol class="es-tool-list tr-ed-list tr-ed-chosen" data-chosen></ol>
          </div>
        </div>
        <p class="tr-ed-hint" data-hint></p>
        <p class="tr-ed-warn" data-warn hidden>Saving ends the paused run.</p>
        <p class="es-tool-status is-bad" data-error role="status" aria-live="polite"></p>
        <div class="tr-ed-foot"><div class="tr-ed-del" data-del></div>
        <div class="es-tool-actions"><button type="button" data-act="cancel">Cancel</button><button type="button" class="es-tool-primary" data-act="save">Save</button></div></div>
      </div></section>`;
    const panel = shade.querySelector("section");
    const nameEl = shade.querySelector("#tr-ed-name");
    const searchEl = shade.querySelector("[data-search]");
    const pickEl = shade.querySelector("[data-pick]");
    const chosenEl = shade.querySelector("[data-chosen]");
    const saveBtn = shade.querySelector('[data-act="save"]');
    nameEl.value = draft.name;
    nameEl.placeholder = C.defaultName(cstore, draft.id); // what an empty name saves as

    function render() {
      const full = draft.codes.length >= C.CUSTOM_MAX_DRILLS;
      const items = C.pickerItems(catalogue, variants, query);
      pickEl.innerHTML = !items ? `<p class="es-tool-note">Drill list not loaded.</p>`
        : !items.length ? `<p class="es-tool-note">No drills match.</p>`
        : items.map((it) => `<div class="es-tool-row tr-ed-row"><div><b>${esc(it.name)}</b>${it.type ? `<i class="tr-type">${esc(it.type)}</i>` : ""}</div>`
          + `<button type="button" data-act="add" data-code="${it.code}" aria-label="Add ${esc(it.name)}"${full ? " disabled" : ""}>Add</button></div>`).join("");
      const rows = C.draftRows(draft, catalogue, variants);
      chosenEl.innerHTML = rows.length ? rows.map((r) => `<li class="es-tool-row tr-ed-row${r.missing ? " is-missing" : ""}"><i class="tr-ed-no">${r.i + 1}</i>`
        + `<div><b>${esc(r.name)}</b>${r.missing ? `<i class="tr-type">${r.code}</i>` : r.type ? `<i class="tr-type">${esc(r.type)}</i>` : ""}</div>`
        + `<span class="tr-ed-acts"><button type="button" data-act="up" data-i="${r.i}" aria-label="Move ${esc(r.name)} up" title="Move up"${r.i === 0 ? " disabled" : ""}>↑</button>`
        + `<button type="button" data-act="down" data-i="${r.i}" aria-label="Move ${esc(r.name)} down" title="Move down"${r.i === rows.length - 1 ? " disabled" : ""}>↓</button>`
        + `<button type="button" data-act="remove" data-i="${r.i}" aria-label="Remove ${esc(r.name)}" title="Remove">✕</button></span></li>`).join("")
        : `<li class="es-tool-note tr-ed-empty">No drills yet. Add them from the list.</li>`;
      const min = C.draftMinutes(draft);
      shade.querySelector("[data-count]").textContent = `${draft.codes.length} of ${C.CUSTOM_MAX_DRILLS} drills${min ? ` · ~${min} min` : ""}`;
      const check = C.draftCheck(draft, !!items);
      shade.querySelector("[data-hint]").textContent = check.ok ? (full ? `${C.CUSTOM_MAX_DRILLS} drills max.` : "") : check.text;
      shade.querySelector("[data-warn]").hidden = !(run && draft.id && run.id === draft.id && C.codesChanged(customStore(), draft));
      shade.querySelector("[data-error]").textContent = error;
      saveBtn.disabled = !check.ok;
      shade.querySelector("[data-del]").innerHTML = !old ? ""
        : confirming ? `<span class="tr-ed-ask">Delete this routine?</span><button type="button" data-act="del-yes">Yes</button><button type="button" data-act="del-no">No</button>`
        : `<button type="button" class="tr-ed-delete" data-act="delete">Delete</button>`;
    }
    const focusOne = (...sels) => {
      for (const sel of sels) {
        const el = sel && shade.querySelector(sel);
        if (el && !el.disabled) { el.focus({ preventScroll: true }); return; }
      }
      searchEl.focus({ preventScroll: true });
    };

    function save() {
      const cs = customStore(); // fresh: another window may have changed it
      const changed = C.codesChanged(cs, draft);
      const res = C.saveCustom(cs, { ...draft, name: nameEl.value }, Date.now());
      if (res.error) { error = res.error; render(); return; }
      if (!trySet(C.CUSTOM_KEY, C.writeCustom(res.store.routines))) { error = "Could not save. Storage is full or blocked."; render(); return; }
      const saved = res.store.routines.find((r) => r.id === res.id);
      const next = C.runAfterSave(run, res.id, saved.name, changed);
      if (next !== run) setRun(next); // changed drills: the paused run ends, no summary
      close(`[data-act="edit"][data-routine="${res.id}"]`);
    }
    function remove() {
      const res = C.deleteCustom(customStore(), draft.id);
      if (res.error) { error = res.error; confirming = false; render(); return; }
      if (!trySet(C.CUSTOM_KEY, C.writeCustom(res.store.routines))) { error = "Could not delete. Storage is full or blocked."; confirming = false; render(); return; }
      const next = C.runAfterDelete(run, draft.id);
      if (next !== run) setRun(next); // its paused run ends, no summary
      close('.tr-strip [data-act="new"]');
    }
    // fallback: the same control in the redrawn strip (the trigger is gone after a redraw).
    function close(fallback) {
      if (!editor) return;
      removeEventListener("keydown", onKey, true);
      removeEventListener("keyup", stopKey, true);
      removeEventListener("keypress", stopKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      shade.remove();
      editor = null;
      sync(); // the storage event does not fire in this page: redraw now
      const sel = trigger && trigger.dataset ? (trigger.dataset.act === "new" ? '.tr-strip [data-act="new"]' : `.tr-strip [data-act="edit"][data-routine="${trigger.dataset.routine}"]`) : null;
      const back = (trigger && trigger.isConnected && !trigger.disabled ? trigger : null)
        || [fallback, sel].map((s) => s && document.querySelector(s)).find((el) => el && !el.disabled);
      // nothing to go back to: focus was inside the removed modal, so it is on the body now
      if (back) back.focus({ preventScroll: true });
    }
    const cancel = () => close(null);

    const stopKey = (e) => e.stopPropagation();
    function onKey(e) {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return; // IME: Esc / Enter belong to the input tool
      if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
      if (e.key === "Tab") {
        const targets = [...panel.querySelectorAll('button:not(:disabled), input, [tabindex="0"]')].filter((el) => el.getClientRects().length);
        if (!targets.length) return;
        const first = targets[0], last = targets[targets.length - 1];
        if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (!panel.contains(document.activeElement)) { nameEl.focus({ preventScroll: true }); return; }
      if (e.key === "Enter") {
        if (e.target instanceof HTMLInputElement) e.preventDefault(); // never submits from a text field
        // a focused button gets its usual Enter click (default action)
      }
    }
    function onFocusIn(e) {
      if (editor && !panel.contains(e.target)) nameEl.focus({ preventScroll: true });
    }
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu"]) shade.addEventListener(type, (e) => e.stopPropagation());
    shade.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b || b.disabled) return;
      const act = b.dataset.act, i = Number(b.dataset.i);
      if (act !== "save") error = "";
      if (act === "cancel") cancel();
      else if (act === "save") save();
      else if (act === "add") { draft = C.draftAdd(draft, b.dataset.code); render(); focusOne(`[data-act="add"][data-code="${b.dataset.code}"]`); }
      else if (act === "up") { draft = C.draftMove(draft, i, -1); render(); focusOne(`[data-act="up"][data-i="${i - 1}"]`, `[data-act="down"][data-i="${i - 1}"]`); }
      else if (act === "down") { draft = C.draftMove(draft, i, 1); render(); focusOne(`[data-act="down"][data-i="${i + 1}"]`, `[data-act="up"][data-i="${i + 1}"]`); }
      else if (act === "remove") { draft = C.draftRemove(draft, i); render(); focusOne(`[data-act="remove"][data-i="${Math.min(i, draft.codes.length - 1)}"]`); }
      else if (act === "delete") { confirming = true; render(); focusOne('[data-act="del-no"]'); }
      else if (act === "del-no") { confirming = false; render(); focusOne('[data-act="delete"]'); }
      else if (act === "del-yes") remove();
    });
    nameEl.addEventListener("input", () => { draft = { ...draft, name: nameEl.value }; error = ""; render(); });
    searchEl.addEventListener("input", () => { query = searchEl.value; render(); });

    editor = { shade, close: cancel };
    addEventListener("keydown", onKey, true);
    addEventListener("keyup", stopKey, true);
    addEventListener("keypress", stopKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    render();
    document.body.appendChild(shade);
    nameEl.focus({ preventScroll: true });
    nameEl.select();
  }

  // ---------- result bar ----------
  // Placement: C.resultSpot / C.placeBar (ux's .ux-result-extra when the card has one).
  function barSig() {
    if (!run || run.phase !== "playing" || !run.results[run.index]) return null;
    const n = run.codes.length;
    const last = run.index >= n - 1;
    return { name: run.name, at: run.index + 1, n, last, next: last ? "" : run.names[run.index + 1] };
  }
  function syncBar() {
    let bar = document.querySelector(".tr-bar");
    const sig = barSig();
    const spot = sig && C.resultSpot(document);
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
    C.placeBar(bar, spot);
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
  addEventListener("ux-result-extra", schedule); // ux's result container appeared
  schedule();
})();
