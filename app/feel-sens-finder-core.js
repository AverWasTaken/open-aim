// Find my sens: the logic behind the sensitivity finder (feel-sens-finder.js draws it).
// Pure: no DOM. The runner gets everything it touches (sens field, drill launch, storage, timers)
// from an env object, so scripts/test-feel-sens-finder.cjs drives it with a fake one.
// - Plan: 6 runs of one 60 s drill, B X Y Y X B: B = your sens, X/Y = 0.8x and 1.25x (which one
//   comes first is random per session). Base is played first and last to even out warm-up.
// - The test sens is set right before a run starts and your own sens is put back the moment the
//   run's result arrives, so between runs (and after a crash or reload) the trainer has your sens.
// - Only a tested sens is ever suggested: Clear (+4% and both runs beat both base runs),
//   Lean (+2%) or no clear difference.
// Loaded as a shell UI script (window.__aimSensFinderCore) and by node (module.exports).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.__aimSensFinderCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DRILLS = [
    { id: "click", label: "Clicking", drill: "Drift Click", code: "d355a344c819596d", type: "basic" },
    { id: "track", label: "Tracking", drill: "Drift Track", code: "ea9dd90bd251f6ba", type: "basic" },
  ];
  const RUN_KEY = "es-sens-finder-run"; // localStorage: the session in progress
  const HISTORY_KEY = "es-sens-finder-v1"; // localStorage: last 10 finished sessions
  const ROUTINE_KEY = "aim-training-routine-run-v1"; // sessionStorage: a training routine in progress
  const SENS_KEY = "al-sensitivity-v1";
  const MIN = 0.001;
  const MAX = 10;
  const LOW = 0.8;
  const HIGH = 1.25;
  const RUNS = 6;
  const MAX_AGE_MS = 2 * 60 * 60 * 1000; // older sessions are dropped on load
  const HISTORY_MAX = 10;
  const CLEAR_GAIN = 0.04;
  const LEAN_GAIN = 0.02;
  const WARMUP_GAIN = 0.1;
  const LAUNCH_WAIT_MS = 10000; // no drill opened by then: paused
  const PICKER_GRACE_MS = 4000; // a picker closed and no drill by then: paused
  const LOBBY_WAIT_MS = 10000; // leaving the open drill took longer than this: paused
  const OPEN_MAX_MS = 180000; // loading screen open this long without the drill: paused
  const POLL_MS = 250;
  const SET_SETTLE_MS = 60; // the trainer saves the sens field a moment after the input event
  const SET_WAIT_MS = 1500; // test sens not saved by then: paused
  const GOOD_ENDS = ["time", "cleared"]; // record.end of a run that played to the end

  const round3 = (n) => Math.round(n * 1000) / 1000;
  const clamp = (n) => Math.min(MAX, Math.max(MIN, n));
  const sensOf = (n) => round3(clamp(n));
  const isSens = (n) => typeof n === "number" && Number.isFinite(n) && n >= MIN && n <= MAX;
  const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.0005;
  // Up to 4 decimals: test sens have 3, the player's own sens is shown as it is.
  const fmt = (n) => (Number.isFinite(n) ? String(Math.round(n * 10000) / 10000) : "-");
  const drillById = (id) => DRILLS.find((d) => d.id === id) || null;

  // B X Y Y X B. rand() < 0.5 puts the low sens first.
  function makePlan(base, rand) {
    const b = isSens(base) ? base : sensOf(base); // the player's own sens stays exact
    const low = sensOf(base * LOW);
    const high = sensOf(base * HIGH);
    const lowFirst = (rand ? rand() : Math.random()) < 0.5;
    const x = lowFirst ? { level: "low", sens: low } : { level: "high", sens: high };
    const y = lowFirst ? { level: "high", sens: high } : { level: "low", sens: low };
    const B = { level: "base", sens: b };
    return [B, x, y, y, x, B].map((s) => ({ ...s }));
  }
  // A plan only works when all three sens are different (not squashed by the 0.001-10 range).
  function planOk(plan) {
    if (!Array.isArray(plan) || plan.length !== RUNS) return false;
    const by = {};
    for (const s of plan) {
      if (!s || !isSens(s.sens) || !["base", "low", "high"].includes(s.level)) return false;
      if (by[s.level] !== undefined && by[s.level] !== s.sens) return false;
      by[s.level] = s.sens;
    }
    return by.base !== undefined && by.low !== undefined && by.high !== undefined && by.low < by.base && by.base < by.high
      && !same(by.low, by.base) && !same(by.base, by.high); // the 0.0005 match must tell them apart
  }

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

  // The suggestion from the 6 results. results[i] = {score, valid, ...} or null (not played).
  function recommend(plan, results) {
    const rows = plan.map((p, i) => {
      const r = results && results[i];
      return { n: i + 1, level: p.level, sens: p.sens, played: !!r, valid: !!(r && r.valid), why: r ? r.why || "" : "not played", score: r ? r.score : null, accuracy: r ? r.accuracy : null };
    });
    const levels = {};
    for (const lv of ["base", "low", "high"]) {
      const all = rows.filter((r) => r.level === lv);
      const good = all.filter((r) => r.valid && Number.isFinite(r.score));
      levels[lv] = { sens: all[0] ? all[0].sens : NaN, runs: all.length, scores: good.map((r) => r.score), mean: mean(good.map((r) => r.score)) };
    }
    const base = levels.base;
    const invalid = rows.filter((r) => !r.valid).length;
    const out = { verdict: "short", pick: null, gainPct: null, base: base.sens, levels, rows, invalid, warm: false, lines: [] };
    const others = ["low", "high"].filter((lv) => levels[lv].scores.length > 0);
    if (!base.scores.length || !others.length || !(base.mean > 0)) {
      out.lines.push("Not enough runs to compare. Try the finder again.");
      if (invalid) out.lines.push("Some runs didn't count: they ended early or the sens was changed.");
      return out;
    }
    const b1 = rows[0];
    const b6 = rows[RUNS - 1];
    out.warm = !!(b1 && b6 && b1.valid && b6.valid && b1.score > 0 && b6.score > b1.score * (1 + WARMUP_GAIN));
    const cands = others.map((lv) => {
      const L = levels[lv];
      const gain = L.mean / base.mean - 1;
      const clear = gain >= CLEAR_GAIN && L.scores.length === 2 && base.scores.length === 2 && Math.min(...L.scores) > Math.max(...base.scores);
      return { lv, sens: L.sens, gain, clear, lean: !clear && gain >= LEAN_GAIN };
    });
    const best = (list) => list.sort((a, b) => b.gain - a.gain)[0];
    const pick = best(cands.filter((c) => c.clear)) || best(cands.filter((c) => c.lean));
    const keep = fmt(base.sens);
    if (pick) {
      const s = fmt(pick.sens);
      const pct = Math.round(pick.gain * 100);
      out.verdict = pick.clear ? "clear" : "lean";
      out.pick = pick.sens;
      out.gainPct = pct;
      out.lines.push(pick.clear
        ? `You scored ${pct}% higher at ${s} in both runs. Worth trying for a few days.`
        : `Slightly better at ${s}, but close. Keep ${keep} or try ${s} for a few days.`);
    } else {
      out.verdict = "none";
      out.lines.push(`No clear difference. Keep ${keep}.`);
    }
    out.lines.push("Your current sens has a head start because you're used to it.");
    if (out.warm) out.lines.push("You were still warming up, so results are less reliable.");
    if (invalid) out.lines.push("Some runs didn't count: they ended early or the sens was changed.");
    if (pick) {
      out.lines.push(`Your best was at the edge of what was tested. Run the finder again from ${fmt(pick.sens)} to look further.`);
      out.lines.push(pick.sens < base.sens
        ? "This drill only tests aim in front of you. If big turns feel hard at the new sens, go back up."
        : "This drill only tests aim in front of you. If small corrections feel shaky at the new sens, go back down.");
    }
    return out;
  }

  // ---------- storage ----------
  function parseRun(raw) {
    if (!raw) return null;
    let s;
    try { s = JSON.parse(raw); } catch { return null; }
    if (!s || typeof s !== "object" || s.v !== 1) return null;
    const d = drillById(s.drill);
    if (!d || s.code !== d.code || !isSens(s.origSens) || !planOk(s.plan)) return null;
    if (!Array.isArray(s.results) || s.results.length !== RUNS) return null;
    if (!Number.isInteger(s.step) || s.step < 0 || s.step > RUNS) return null;
    if (s.appliedSens !== null && !isSens(s.appliedSens)) return null;
    if (!Number.isFinite(s.startedAt)) return null;
    return s;
  }
  function parseHistory(raw) {
    if (!raw) return [];
    try {
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a.filter((e) => e && typeof e === "object" && Number.isFinite(e.at)).slice(-HISTORY_MAX) : [];
    } catch { return []; }
  }
  function addHistory(list, s, rec, now) {
    const entry = {
      at: now, drill: s.drill, origSens: s.origSens, verdict: rec.verdict, pick: rec.pick, gainPct: rec.gainPct,
      runs: rec.rows.map((r) => ({ sens: r.sens, score: r.score, valid: r.valid })),
    };
    return list.concat([entry]).slice(-HISTORY_MAX);
  }

  // ---------- runner ----------
  // env: now(), rand(), every(fn, ms) -> cancel, after(fn, ms) -> cancel,
  //   readSens() -> number|NaN (al-sensitivity-v1, else the lobby field), setSens(v) -> bool (lobby field),
  //   lobbyReady(), drillOpen(), pickerOpen(), roundOn(), routineActive(), aidsOn(code),
  //   launch(code) -> bool, leave() -> bool, loadRun()/saveRun(json|null), loadHistory()/saveHistory(json),
  //   setActive(bool), render(view)
  function createRunner(env) {
    let s = null; // the session (persisted under RUN_KEY)
    let note = ""; // message on the card
    let result = null; // recommendation of the session just finished
    let watch = null; // launch / playing poll
    let restoring = null; // restore poll
    let waiting = null; // lobby wait before a launch
    let pending = null; // set-sens settle timer

    const cancel = (c) => { if (c) c(); return null; };
    function stopTimers() { watch = cancel(watch); waiting = cancel(waiting); pending = cancel(pending); }
    function persist() {
      env.saveRun(s ? JSON.stringify(s) : null);
      env.setActive(!!s);
      env.render(view());
    }
    function view() {
      if (!s) return { phase: result ? "result" : "idle", note, result };
      const d = drillById(s.drill);
      const at = Math.min(s.step, RUNS - 1);
      return {
        phase: s.phase, note, step: s.step, total: RUNS, done: s.results.filter(Boolean).length,
        drill: d.drill, label: d.label, code: s.code, origSens: s.origSens, sens: s.plan[at].sens, restoring: s.appliedSens !== null,
      };
    }

    // Put the player's own sens back. Keeps trying (every POLL_MS) until the lobby field takes it;
    // appliedSens stays saved until then so a reload finishes the job.
    function restore(then) {
      if (!s || s.appliedSens === null) { if (then) then(); return; }
      const to = s.origSens;
      const done = () => {
        restoring = cancel(restoring);
        if (s) { s.appliedSens = null; persist(); }
        if (then) then();
      };
      const applied = s.appliedSens;
      // Back to the player's sens: done. Neither ours nor theirs: they changed it, leave it alone.
      const settled = () => {
        const cur = env.readSens();
        return same(cur, to) || !same(cur, applied);
      };
      const attempt = () => {
        if (settled()) return true;
        env.setSens(to);
        return settled();
      };
      restoring = cancel(restoring);
      if (attempt()) { done(); return; }
      restoring = env.every(() => {
        if (!s || s.appliedSens === null) { restoring = cancel(restoring); return; }
        if (attempt()) done();
      }, POLL_MS);
    }

    function end(msg) {
      stopTimers();
      restoring = cancel(restoring);
      s = null;
      note = msg || "";
      persist();
    }
    function pause(msg) {
      stopTimers();
      if (!s) return;
      s.phase = "paused";
      note = msg;
      persist();
      restore();
    }

    // Can a new session start now? {ok, reason}
    function canStart(drillId) {
      const d = drillById(drillId);
      if (!d) return { ok: false, reason: "Unknown drill." };
      if (s) return { ok: false, reason: "The sens finder is already running. Use the card at the top." };
      if (env.routineActive()) return { ok: false, reason: "Finish or end your routine first." };
      if (env.roundOn()) return { ok: false, reason: "Leave Round mode first." };
      if (env.drillOpen() || !env.lobbyReady()) return { ok: false, reason: "Go back to the lobby first." };
      const base = env.readSens();
      if (!isSens(base)) return { ok: false, reason: "Couldn't read your sensitivity. Open the lobby and try again." };
      if (!planOk(makePlan(base, () => 0))) return { ok: false, reason: `Your sens is too close to the edge of the range (${MIN} to ${MAX}) to test around it.` };
      return { ok: true, base };
    }

    // From the Start click (the drill launch needs the click for fullscreen).
    function start(drillId) {
      const c = canStart(drillId);
      if (!c.ok) return c;
      const d = drillById(drillId);
      result = null;
      s = { v: 1, drill: d.id, code: d.code, origSens: c.base, appliedSens: null, plan: makePlan(c.base, env.rand), results: new Array(RUNS).fill(null), step: 0, phase: "ready", startedAt: env.now() };
      note = env.aidsOn(d.code) ? "Aim aids are on. That's fine, but keep them the same for all runs." : "";
      runStep();
      return { ok: true };
    }

    // Next run / Continue / Retry: leave the open drill, wait for the lobby, set the test sens, launch.
    function runStep() {
      if (!s || s.step >= RUNS) return;
      stopTimers();
      if (env.routineActive()) { pause("A routine is running. End it, then continue."); return; }
      if (env.roundOn()) { pause("Leave Round mode, then continue."); return; }
      if (s.appliedSens !== null) restore();
      if (!s) return;
      if (s.appliedSens !== null) {
        // Still putting the player's sens back (field not ready yet): try again shortly.
        note = "Putting your sens back. Try again in a moment.";
        s.phase = "paused";
        persist();
        return;
      }
      if (!same(env.readSens(), s.origSens)) { end("Your sens was changed outside the finder, so the finder stopped."); return; }
      s.phase = "launching";
      s.launchedAt = env.now();
      persist();
      if (env.drillOpen()) {
        try { env.leave(); } catch {}
      }
      if (env.lobbyReady()) { setAndLaunch(); return; }
      const t0 = env.now();
      waiting = env.every(() => {
        if (!s || s.phase !== "launching") { waiting = cancel(waiting); return; }
        if (env.lobbyReady()) { waiting = cancel(waiting); setAndLaunch(); return; }
        if (env.now() - t0 > LOBBY_WAIT_MS) { waiting = cancel(waiting); pause("Couldn't get back to the lobby. Try again."); }
      }, 100);
    }
    function setAndLaunch() {
      if (!s || s.phase !== "launching") return;
      const sens = s.plan[s.step].sens;
      s.appliedSens = sens; // saved before the change so a crash or reload still restores
      persist();
      if (!env.setSens(sens)) { pause("Couldn't change the sens. Open the lobby and try again."); return; }
      // Launch once the trainer has saved the test sens (normally the first check).
      const t0 = env.now();
      const check = () => {
        if (!s || s.phase !== "launching") { pending = cancel(pending); return; }
        if (!same(env.readSens(), sens)) {
          if (env.now() - t0 >= SET_WAIT_MS) { pending = cancel(pending); pause("The trainer didn't take the test sens. Try again."); }
          return;
        }
        pending = cancel(pending);
        let ok = false;
        try { ok = !!env.launch(s.code); } catch { ok = false; }
        if (!ok) { pause("Couldn't start the drill. Go back to the lobby and try again."); return; }
        watchLaunch();
      };
      pending = env.every(check, SET_SETTLE_MS);
    }
    // Launching: wait for the drill to open (aim-local-scene). Playing: notice the drill closing
    // without a result (left early).
    function watchLaunch() {
      watch = cancel(watch);
      let at = env.now();
      let picker = false;
      let layer = false;
      watch = env.every(() => {
        if (!s || (s.phase !== "launching" && s.phase !== "playing")) { watch = cancel(watch); return; }
        const now = env.now();
        const open = env.drillOpen();
        if (s.phase === "playing") {
          if (!open && env.lobbyReady()) pause(`Run ${s.step + 1} ended early. Play it again to continue.`);
          return;
        }
        if (env.pickerOpen()) { picker = true; at = now; return; }
        if (open) { layer = true; if (now - at > OPEN_MAX_MS) pause("The drill didn't start. Try again."); return; }
        if (layer) { pause("The drill closed before it started. Try again."); return; }
        if (picker && now - at > PICKER_GRACE_MS) { pause("The drill didn't start. Try again."); return; }
        if (now - at > LAUNCH_WAIT_MS) pause("The drill didn't open. Try again.");
      }, POLL_MS);
    }

    // window 'aim-local-scene' {id}
    function onScene(id) {
      if (!s || (s.phase !== "launching" && s.phase !== "playing")) return;
      if (s.phase === "launching" && id === s.code) {
        s.phase = "playing";
        persist();
        if (!watch) watchLaunch();
        return;
      }
      if (id !== s.code || s.phase === "launching") pause("Another drill was started, so the finder paused.");
    }
    // window 'aim-local-result' {record}
    function onResult(detail) {
      if (!s || s.phase !== "playing") return; // one result per launch, after its drill came up
      const rec = detail && detail.record;
      if (!rec || rec.shareCode !== s.code) return;
      watch = cancel(watch);
      const endOk = GOOD_ENDS.includes(rec.end);
      const sensOk = same(env.readSens(), s.appliedSens);
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      s.results[s.step] = {
        sens: s.plan[s.step].sens, score: num(rec.score), accuracy: num(rec.accuracy), avgKillTime: num(rec.avgKillTime),
        end: typeof rec.end === "string" ? rec.end : null, valid: endOk && sensOk && num(rec.score) !== null,
        why: !endOk ? "ended early" : !sensOk ? "sens changed" : "",
      };
      s.step += 1;
      s.phase = s.step >= RUNS ? "done" : "between";
      note = "";
      persist();
      restore();
    }

    function next() { if (s && s.phase === "between") runStep(); }
    function resume() { if (s && s.phase === "paused") runStep(); }

    // Stop button: leave a drill the finder opened, put the sens back, forget the session.
    function stop() {
      if (!s) { result = null; note = ""; persist(); return; }
      const inRun = s.phase === "launching" || s.phase === "playing";
      stopTimers();
      if (inRun && env.drillOpen()) { try { env.leave(); } catch {} }
      if (s.appliedSens === null) { end(""); return; }
      s.phase = "stopping";
      note = "";
      persist();
      restore(() => end(""));
    }

    // The suggestion for a finished session, saved to history.
    function record(fin) {
      const rec = recommend(fin.plan, fin.results);
      rec.drill = drillById(fin.drill);
      rec.origSens = fin.origSens;
      env.saveHistory(JSON.stringify(addHistory(parseHistory(env.loadHistory()), fin, rec, env.now())));
      return rec;
    }
    // See result (after the 6th run): suggestion, saved to history, session cleared.
    function finish() {
      if (!s || s.phase !== "done") return null;
      const fin = s;
      const go = () => {
        const rec = record(fin);
        if (env.drillOpen()) { try { env.leave(); } catch {} }
        stopTimers();
        s = null;
        note = "";
        result = rec;
        persist();
      };
      if (s.appliedSens !== null) restore(go); else go();
      return result;
    }
    function closeResult() { result = null; note = ""; persist(); }

    // App start: never resumes on its own. Puts the player's sens back if the test sens is still set.
    function init() {
      s = parseRun(env.loadRun());
      if (!s) { env.saveRun(null); env.setActive(false); env.render(view()); return; }
      const cur = env.readSens();
      const stale = env.now() - s.startedAt > MAX_AGE_MS;
      if (s.appliedSens !== null && !same(cur, s.appliedSens)) s.appliedSens = null; // changed elsewhere: leave it
      // Too old, or closed in the middle of Stop: finish the stop (a finished session nobody
      // looked at still goes to history).
      if (stale || s.phase === "stopping") {
        if (s.phase === "done") record(s);
        if (s.appliedSens !== null) { s.phase = "stopping"; note = ""; persist(); restore(() => end("")); }
        else end("");
        return;
      }
      if (s.phase !== "done") {
        s.phase = "paused";
        const n = s.results.filter(Boolean).length;
        note = `Sens finder paused, ${n} of ${RUNS} runs done.`;
      } else note = "";
      persist();
      restore();
    }

    return {
      init, canStart, start, next, resume, stop, finish, closeResult, onScene, onResult, view,
      get session() { return s; },
    };
  }

  return {
    DRILLS, RUN_KEY, HISTORY_KEY, ROUTINE_KEY, SENS_KEY, MIN, MAX, LOW, HIGH, RUNS, MAX_AGE_MS, HISTORY_MAX,
    CLEAR_GAIN, LEAN_GAIN, WARMUP_GAIN, LAUNCH_WAIT_MS, PICKER_GRACE_MS, LOBBY_WAIT_MS, POLL_MS, SET_SETTLE_MS, SET_WAIT_MS, GOOD_ENDS,
    round3, sensOf, isSens, same, fmt, drillById, makePlan, planOk, recommend, parseRun, parseHistory, addHistory, createRunner,
  };
});
