/* Routines: pure logic (no DOM). Loaded in the page before training-routines.js and require()d by
   scripts/test-training-routines.cjs. Exposed as window.aimRoutinesCore in the page. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.aimRoutinesCore = factory();
})(globalThis, function () {
  "use strict";

  // ---------- ROUTINE DEFINITIONS ----------
  // One entry per routine card in the lobby. Each step is a drill's share code (the code of its
  // lobby card; Easy/Hard twins from /aim/drill-variants.json count as the same drill) and its
  // run length in seconds (rules.duration of the drill's scene; scripts/test-training-routines.cjs
  // checks these against the scene files). Add drills by adding steps. A code that is not in the
  // drill list is skipped with a console warning.
  const ROUTINES = [
    {
      id: "warmup",
      name: "Daily warm-up",
      blurb: "Easy flicks, tracking, head level, an angle hold, then peekers.",
      steps: [
        // Six targets always up, no pressure: wakes up hand and eyes with easy flicks.
        { code: "887a651550f1bca1", seconds: 60 }, // Six targets (Target drill)
        // Follow a bot that strafes and counter-strafes like a player.
        { code: "6bdae48b1990cd16", seconds: 60 }, // Stop-and-go strafer
        // Small corrections along head height, the base of crosshair placement.
        { code: "406d6e47ebc89bc3", seconds: 60 }, // Head-level micro
        // Hold one angle on a real map and react.
        { code: "782614562cd94b22", seconds: 60 }, // Split Heaven hold
        // Finish game-like: bots jiggle-peek real angles and shoot back.
        { code: "54d79166b4f48373", seconds: 90 }, // Ascent B retake: peekers
      ],
    },
    {
      id: "precision",
      name: "Precision",
      blurb: "Small flicks, head level, long-range taps and Sheriff heads.",
      steps: [
        // Short, exact flicks inside a narrow box.
        { code: "e3c17ccb9f5a1500", seconds: 60 }, // Micro flicks
        // Tiny targets one small step apart.
        { code: "d43f842fb33e4d46", seconds: 60 }, // Micro tiles
        // Sheriff vs strafing bots: wait for the stop, tap the head.
        { code: "44e40db6736c1916", seconds: 60 }, // Sheriff one-taps
        // Small heads in a tight row at head height.
        { code: "406d6e47ebc89bc3", seconds: 60 }, // Head-level micro
        // Bots 35 to 50 m away: line up the head, first shot counts.
        { code: "f12ecead87952aa4", seconds: 60 }, // Long-range taps
        // Finish against the clock: Sheriff taps down Haven C Long.
        { code: "8e3c439a53c4dc6b", seconds: 40 }, // Erv's Sheriff 5k in 7 seconds
      ],
    },
    {
      id: "holding",
      name: "Holding angles",
      blurb: "React to swings, hold with the Operator, turn from flashes, spray a stack.",
      steps: [
        // Targets swing past one angle: pure reaction on a hold.
        { code: "5a9e43d609bbb3a3", seconds: 60 }, // Boaster's flick drill (hard)
        // Operator on a narrow gap: scope in and shoot what crosses.
        { code: "da695c3c99a7d3cf", seconds: 60 }, // Operator angle hold
        // Hold from Heaven on Split.
        { code: "782614562cd94b22", seconds: 60 }, // Split Heaven hold
        // Hold A Long while flashers swing and shoot back.
        { code: "112bc51af7b16caf", seconds: 60 }, // Haven A Long: hold vs flashes
        // A stack runs into your angle: spray through the whole row in one burst.
        { code: "4f6729c818033962", seconds: 60 }, // Spray transfer
      ],
    },
    {
      id: "movement",
      name: "Movement & peeks",
      blurb: "Track strafes, shoot on the stop, beat jiggle peeks, then clear a site.",
      steps: [
        // Track short strafes with sharp stops.
        { code: "6bdae48b1990cd16", seconds: 60 }, // Stop-and-go strafer
        // Your own movement: strafe, stop, tap; the gun only fires right after you stop.
        { code: "d522b8584d057391", seconds: 60 }, // Counter-strafe taps
        // Don't chase the jiggles, hit them when they swing out.
        { code: "1ee402b08e6fe47b", seconds: 60 }, // Jiggle-peek duels
        // Two map routes where bots jiggle-peek real angles and shoot back.
        { code: "54d79166b4f48373", seconds: 90 }, // Ascent B retake: peekers
        { code: "61abe15ed0660f15", seconds: 90 }, // Split B Heaven retake: peekers
      ],
    },
  ];

  const RUN_KEY = "aim-training-routine-run-v1"; // sessionStorage: the routine in progress
  const STORE_KEY = "aim-training-routines-v1"; // localStorage: finished routines
  const TEST_KEY = "aim-training-routine-test-v1"; // sessionStorage, tests only: {name, codes[]}
  const RUNS_KEY = "al-workshop-runs-v1"; // the game's run history (read only)
  const CAP = 200;
  const OVERHEAD_SECONDS = 30; // loading, countdown and the result screen, per drill
  const DEFAULT_SECONDS = 60;

  const isCode = (c) => typeof c === "string" && /^[0-9a-f]{16}$/.test(c);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  // Drill name as the lobby shows it: the official "简单-"/"困难-" (Easy/Hard) prefix dropped.
  function drillName(item) {
    const n = String((item && item.name) || "");
    const m = /^\s*(简单|困难)\s*-\s*(.+)$/.exec(n);
    return (m ? m[2] : n).trim() || "Drill";
  }

  // ---------- drill groups ----------
  // variants: /aim/drill-variants.json "variants" (code -> {code, item, easy, ...}). Every code of a
  // drill (its card, its Easy twin, older hidden copies) points at a group with the card's code.
  const groupOf = (code, variants) => (variants && variants[code] && variants[code].code) || code;
  const sameGroup = (a, b, variants) => !!a && !!b && groupOf(a, variants) === groupOf(b, variants);

  // The catalogue item to launch for a code: the lobby card of its group.
  const cardIndex = (catalogue) => {
    const byCode = new Map();
    for (const it of catalogue || []) if (it && typeof it.shareCode === "string") byCode.set(it.shareCode, it);
    return byCode;
  };
  // index: optional cardIndex(catalogue), for callers that look up many codes.
  function itemFor(code, catalogue, variants, index) {
    const byCode = index || cardIndex(catalogue);
    const g = variants && variants[code];
    if (g && g.item && byCode.has(g.item.shareCode)) return byCode.get(g.item.shareCode);
    if (byCode.has(code)) return byCode.get(code);
    if (g && g.item && typeof g.item.shareCode === "string") return g.item;
    return null;
  }

  // Routine with its steps matched to the drill list. Missing drills are skipped (warn(code) is
  // called for each). Returns null if no step is left.
  function resolve(routine, catalogue, variants, warn) {
    if (!routine || !Array.isArray(routine.steps)) return null;
    const steps = [];
    for (const s of routine.steps) {
      const item = s && isCode(s.code) ? itemFor(s.code, catalogue, variants) : null;
      if (!item) {
        if (warn) warn(s && s.code, routine.id);
        continue;
      }
      steps.push({ code: item.shareCode, name: drillName(item), seconds: num(s.seconds) || DEFAULT_SECONDS, item });
    }
    return steps.length ? { id: routine.id, name: routine.name, blurb: routine.blurb || "", steps } : null;
  }

  const minutes = (steps) => Math.max(1, Math.round(steps.reduce((t, s) => t + (num(s.seconds) || DEFAULT_SECONDS) + OVERHEAD_SECONDS, 0) / 60));

  // Test-only routine from sessionStorage TEST_KEY ({name, codes:[...]}); null if absent or bad.
  function testRoutine(raw) {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      const codes = Array.isArray(v && v.codes) ? v.codes.filter(isCode) : [];
      if (!codes.length) return null;
      return { id: "test", name: String(v.name || "Test routine").slice(0, 40), blurb: "Test only.", steps: codes.map((code) => ({ code, seconds: DEFAULT_SECONDS })) };
    } catch {
      return null;
    }
  }

  // ---------- routine run (state machine) ----------
  // run = {v:1, id, name, codes[], names[], index, phase, results[], startedAt, launchedAt?}
  // phase: "launching" (we asked the lobby to start codes[index]), "playing" (that drill is open),
  // "paused" (in the lobby, or another drill was started). results[i] is the latest run of step i.
  function start(resolved, now) {
    if (!resolved || !resolved.steps.length) return null;
    return {
      v: 1,
      id: resolved.id,
      name: resolved.name,
      codes: resolved.steps.map((s) => s.code),
      names: resolved.steps.map((s) => s.name),
      index: 0,
      phase: "launching",
      results: [],
      startedAt: now,
    };
  }
  const nextIndex = (run) => (run.results[run.index] ? run.index + 1 : run.index);
  const isDone = (run) => !!run && run.codes.length > 0 && run.codes.every((_, i) => !!run.results[i]);

  // The routine's drill came up (aim-local-scene). Any other drill pauses the routine.
  function onScene(run, id, variants) {
    if (!run || run.phase === "paused") return run;
    if (run.phase === "launching" && sameGroup(id, run.codes[run.index], variants)) return { ...run, phase: "playing" };
    return { ...run, phase: "paused" };
  }
  // A run ended (aim-local-result record). Only counts while the step's drill is open; Play again
  // replaces the step's earlier result.
  function onResult(run, record, variants) {
    if (!run || run.phase !== "playing" || !record || !sameGroup(record.shareCode, run.codes[run.index], variants)) return run;
    const results = run.results.slice();
    results[run.index] = summarize(record);
    return { ...run, results };
  }
  const pause = (run) => (run && run.phase !== "paused" ? { ...run, phase: "paused" } : run);
  // Next drill (result bar) and Continue (lobby): launch the first step without a result.
  function advance(run, now) {
    if (!run) return run;
    const i = nextIndex(run);
    if (i >= run.codes.length) return { ...run, phase: "paused" };
    return { ...run, index: i, phase: "launching", launchedAt: now };
  }

  // sessionStorage copy of a run. After a reload the routine is always paused in the lobby.
  function restore(raw) {
    if (!raw) return null;
    try {
      const r = JSON.parse(raw);
      if (!r || r.v !== 1 || typeof r.id !== "string" || !Array.isArray(r.codes) || !r.codes.length || !r.codes.every(isCode)) return null;
      const n = r.codes.length;
      const index = Number.isInteger(r.index) && r.index >= 0 && r.index < n ? r.index : 0;
      const names = Array.isArray(r.names) && r.names.length === n ? r.names.map((x) => String(x)) : r.codes.map(() => "Drill");
      const results = [];
      for (let i = 0; i < n; i++) {
        const x = Array.isArray(r.results) ? r.results[i] : null;
        results[i] = x && typeof x === "object" && typeof x.code === "string" ? x : undefined;
      }
      while (results.length && results[results.length - 1] === undefined) results.pop();
      return { v: 1, id: r.id, name: String(r.name || "Routine"), codes: r.codes.slice(), names, index, phase: "paused", results, startedAt: num(r.startedAt) || 0 };
    } catch {
      return null;
    }
  }

  // ---------- results and personal bests ----------
  function summarize(rec) {
    return {
      id: String(rec.id || ""),
      code: rec.shareCode,
      name: drillName(rec),
      type: rec.type || null,
      at: num(rec.createdAt) || 0,
      end: rec.end || null,
      score: num(rec.score),
      accuracy: num(rec.accuracy),
      seconds: num(rec.seconds),
    };
  }
  // Same rule as the game's own records (site/next/js/BZb782s6.js me()/K()): Scenario ("moment")
  // drills rank by the fastest cleared time (runs that did not clear never count); every other
  // drill by the highest score, then the lower time, then the earlier run.
  const isMoment = (type) => type === "moment";
  const r2 = (v) => Math.round((v || 0) * 100) / 100;
  const counts = (run, type) => (isMoment(type) ? run.end === "cleared" : true);
  function better(a, b, type) {
    if (isMoment(type)) {
      const x = r2(a.seconds), y = r2(b.seconds);
      return x !== y ? x < y : a.at < b.at;
    }
    if ((a.score || 0) !== (b.score || 0)) return (a.score || 0) > (b.score || 0);
    const x = r2(a.seconds), y = r2(b.seconds);
    return x !== y ? x < y : a.at < b.at;
  }
  // PB status of one routine result against the run history (al-workshop-runs-v1, newest first).
  // Compared across the whole twin group (Easy/Hard twins share one record, like the rank picker's
  // merged card), only against runs made before it (the new run itself is excluded by id), and
  // deleted runs are skipped. kind: "pb" new best, "first" first counted run, "off" not a best,
  // "none" the run does not count (a Scenario drill that was not cleared).
  function pbStatus(result, runs, variants) {
    const type = result.type;
    let best = null;
    for (const r of Array.isArray(runs) ? runs : []) {
      if (!r || typeof r !== "object" || r.deletedAt || r.id === result.id) continue;
      if (!sameGroup(r.shareCode, result.code, variants)) continue;
      const at = num(r.createdAt);
      if (at === null || at > result.at) continue;
      if (!counts(r, type)) continue;
      const s = { score: num(r.score), seconds: num(r.seconds), at, end: r.end };
      if (!best || better(s, best, type)) best = s;
    }
    if (!counts(result, type)) return { kind: "none", best };
    if (!best) return { kind: "first", best: null };
    return { kind: better(result, best, type) ? "pb" : "off", best };
  }
  function parseRuns(raw) {
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  // Score as the lobby shows it: Scenario drills show the cleared time.
  function formatValue(r) {
    if (!r) return "";
    if (isMoment(r.type)) return r.end === "cleared" && r.seconds !== null ? `${r.seconds.toFixed(2)} s` : "Not cleared";
    return r.score === null ? "-" : Math.round(r.score).toLocaleString("en-US");
  }
  const formatAccuracy = (r) => (r && r.accuracy !== null && r.accuracy !== undefined ? `${Math.round(r.accuracy)}%` : "-");
  function formatClock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  const playedSeconds = (run) => (run ? run.results.reduce((t, r) => t + ((r && r.seconds) || 0), 0) : 0);

  function summary(run, runs, variants) {
    const rows = run.codes.map((code, i) => {
      const r = run.results[i];
      if (!r) return { index: i, code, name: run.names[i], result: null, pb: null };
      return { index: i, code, name: run.names[i] || r.name, result: r, pb: pbStatus(r, runs, variants) };
    });
    return { rows, played: playedSeconds(run), complete: isDone(run), pbs: rows.filter((x) => x.pb && (x.pb.kind === "pb")).length };
  }

  // ---------- finished routines (localStorage) ----------
  // {v:1, completions:[{id: routine id, run: startedAt of that run, at, results:[...]}]}, newest first.
  function readStore(raw) {
    try {
      const v = JSON.parse(raw || "null");
      if (v && v.v === 1 && Array.isArray(v.completions)) {
        return { v: 1, completions: v.completions.filter((c) => c && typeof c.id === "string" && num(c.at) !== null) };
      }
    } catch {}
    return { v: 1, completions: [] };
  }
  // Adds (or, for the same run after Play again, replaces) a finished routine.
  function addCompletion(store, run, now) {
    const entry = {
      id: run.id,
      run: run.startedAt,
      at: now,
      results: run.results.map((r) => (r ? { code: r.code, name: r.name, score: r.score, accuracy: r.accuracy, seconds: r.seconds, end: r.end } : null)),
    };
    const rest = store.completions.filter((c) => !(c.id === run.id && c.run === run.startedAt));
    return { v: 1, completions: [entry, ...rest].sort((a, b) => b.at - a.at).slice(0, CAP) };
  }

  // Local calendar days between two times (DST-safe).
  function dayDiff(later, earlier) {
    const a = new Date(later), b = new Date(earlier);
    const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((da - db) / 86400000);
  }
  function lastDone(store, id, now) {
    let at = null;
    for (const c of store.completions) if (c.id === id && c.at <= now && (at === null || c.at > at)) at = c.at;
    if (at === null) return { at: null, label: "Not done yet" };
    const d = dayDiff(now, at);
    return { at, label: d <= 0 ? "Today" : d === 1 ? "Yesterday" : `${d} days ago` };
  }
  // Days in a row (local calendar days) with this routine finished, ending today, or yesterday
  // when it has not been done yet today.
  function streak(store, id, now) {
    const days = new Set();
    for (const c of store.completions) if (c.id === id && c.at <= now) days.add(dayDiff(now, c.at));
    let d = days.has(0) ? 0 : days.has(1) ? 1 : -1;
    if (d < 0) return 0;
    let n = 0;
    while (days.has(d)) { n++; d++; }
    return n;
  }

  // ---------- hooks for other scripts (feel's sensitivity finder) ----------
  // Before each routine drill is launched, window gets CustomEvent "aim-routine-step" with
  // detail {routineId, index, total, shareCode, name}: index is 0-based (first drill = 0), total is
  // the routine's drill count, shareCode the code being launched (the lobby card of the step).
  // It fires synchronously in the click, right before window.__aimLaunchWorkshop(item); the launch
  // can still be dropped after it (rank picker cancelled, drill already open).
  const STEP_EVENT = "aim-routine-step";
  function stepDetail(run, item) {
    const i = run.index;
    return { routineId: run.id, index: i, total: run.codes.length, shareCode: (item && item.shareCode) || run.codes[i], name: run.names[i] };
  }
  // Fires the step event, then launches like a lobby click. Returns whether the launch was taken.
  function launchStep(win, run, item) {
    if (!run || !item || typeof win.__aimLaunchWorkshop !== "function") return false;
    try {
      win.dispatchEvent(new win.CustomEvent(STEP_EVENT, { detail: stepDetail(run, item) }));
    } catch (err) {
      console.error("ROUTINES:", err);
    }
    return !!win.__aimLaunchWorkshop(item);
  }
  // Start / Continue are refused while feel's sensitivity finder runs (window.__aimSensFinderActive).
  const SENS_NOTICE = "Finish or stop the sensitivity finder first.";
  const NOTICE_MS = 4000;
  function sensFinderBusy(win) {
    try { return !!win.__aimSensFinderActive; } catch { return false; }
  }
  const noticeText = (notice, now) => (notice && typeof notice.text === "string" && notice.until > now ? notice.text : "");

  // ---------- lobby strip (pure: same markup at every window size; CSS makes it one line at
  // max-height 800px, see training-routines.css) ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // list: resolved routines (built-ins, then custom ones with custom:true); store:
  // aim-training-routines-v1; notice: {text, until} or null; opts.custom: the custom store
  // (readCustom) for its stored codes and read-only flag.
  function stripModel(list, run, store, now, notice, opts) {
    const cstore = (opts && opts.custom) || { routines: [], readOnly: false };
    const card = (r) => {
      const last = lastDone(store, r.id, now);
      return { id: r.id, name: r.name, blurb: r.blurb, n: r.steps.length, min: minutes(r.steps), drills: r.steps.map((s) => s.name), last: last.label, days: streak(store, r.id, now) };
    };
    const cards = list.filter((r) => !r.custom).map(card);
    // codes: the stored ones, so the strip redraws after an edit that resolves the same.
    const mine = list.filter((r) => r.custom).map((r) => {
      const stored = cstore.routines.find((x) => x.id === r.id);
      return { ...card(r), custom: true, ok: r.steps.length > 0, codes: stored ? stored.codes : r.steps.map((s) => s.code) };
    });
    const state = run ? { id: run.id, name: run.name, phase: run.phase, i: nextIndex(run), n: run.codes.length, done: isDone(run), next: run.names[Math.min(nextIndex(run), run.codes.length - 1)] } : null;
    // "+ New routine": hidden at CUSTOM_MAX or for a read-only store; Edit / New are disabled
    // while a routine drill is launching.
    const add = !cstore.readOnly && mine.length < CUSTOM_MAX;
    return { cards, mine, add, edit: !cstore.readOnly, lock: !!run && run.phase === "launching", state, notice: noticeText(notice, now) };
  }
  function chipsHtml(sig) {
    const mine = sig.mine || [];
    if (!mine.length && !sig.add) return "";
    const lock = sig.lock ? " disabled" : "";
    const chips = mine.map((c) => {
      const lastText = `Last done: ${c.last}${c.days >= 2 ? `, ${c.days} day streak` : ""}`;
      const title = `${c.name}\n${c.ok ? c.drills.join(", ") : "No drills found"}\n${lastText}`; // names can be cut short
      const edit = sig.edit === false ? "" : `<button type="button" class="tr-btn is-ghost" data-act="edit" data-routine="${esc(c.id)}" aria-label="Edit ${esc(c.name)}"${lock}>Edit</button>`;
      return `<article class="tr-chip" data-routine="${esc(c.id)}" title="${esc(title)}"><span class="tr-chip-name">${esc(c.name)}</span><span class="tr-meta">${c.ok ? `${c.n} drills` : "No drills found"}</span>`
        + `<button type="button" class="tr-btn" data-act="start" data-routine="${esc(c.id)}" aria-label="Start ${esc(c.name)}"${c.ok ? "" : " disabled"}>Start</button>${edit}</article>`;
    }).join("");
    const add = sig.add ? `<button type="button" class="tr-btn tr-chip-new" data-act="new"${lock}>+ New routine</button>` : "";
    return `<div class="tr-custom" role="group" aria-label="Your routines" data-wheel-x>${chips}${add}</div>`;
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
    const cards = sig.cards.map((c) => {
      const lastText = `Last done: ${c.last}${c.days >= 2 ? `, ${c.days} day streak` : ""}`;
      return `<article class="tr-card" data-routine="${esc(c.id)}" title="${esc(`${c.name}\n${c.drills.join(", ")}\n${lastText}`)}">
      <div class="tr-card-head"><h3>${esc(c.name)}</h3><span class="tr-meta"><span class="tr-meta-n">${c.n} drills</span><span class="tr-meta-min"> · ~${c.min} min</span></span></div>
      <p class="tr-blurb">${esc(c.blurb)}</p>
      <p class="tr-drills">${esc(c.drills.join(" · "))}</p>
      <div class="tr-card-foot"><span class="tr-last">Last done: <b>${esc(c.last)}</b>${c.days >= 2 ? ` · <b class="tr-streak">${c.days} day streak</b>` : ""}</span>
      <button type="button" class="tr-btn" data-act="start" data-routine="${esc(c.id)}" aria-label="Start ${esc(c.name)}">Start</button></div>
    </article>`;
    }).join("");
    const notice = sig.notice ? `<span class="tr-notice" role="status">${esc(sig.notice)}</span>` : "";
    return `<header class="tr-strip-head"><h2>Routines</h2><p>Play a set of drills in a row. Go to the next drill from the result screen.</p>${notice}</header>${resume}<div class="tr-rows" data-wheel-x><div class="tr-cards">${cards}</div>${chipsHtml(sig)}</div>`;
  }

  // ---------- custom routines (player-made, localStorage) ----------
  // aim-training-routines-custom-v1 = {v:1, routines:[{id:"c-<time36>", name, codes:[shareCode...],
  // createdAt, updatedAt}]}. They run through the same state machine as the built-ins (same run
  // key, result bar, summary, completions under their own id). Each step is 60 s here: the drill
  // list has no run length, and the estimate uses the same overhead rule as the built-ins.
  const CUSTOM_KEY = "aim-training-routines-custom-v1";
  const CUSTOM_MAX = 12; // routines
  const CUSTOM_MIN_DRILLS = 2;
  const CUSTOM_MAX_DRILLS = 10;
  const NAME_MAX = 32;
  const RECORD_CODE = "00000000000000c0"; // Studio's recording slot (studio-store.js), never a step
  const customId = (id) => typeof id === "string" && /^c-[0-9a-z]+$/.test(id);
  // Control characters out, trimmed, at most NAME_MAX characters.
  const cleanName = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, NAME_MAX).trim();

  // Tolerant read: bad entries are dropped, never throws, never writes. A store saved by a newer
  // version (v > 1) is shown but read-only (saveCustom / deleteCustom refuse).
  function readCustom(raw) {
    const out = { v: 1, routines: [], readOnly: false };
    let v = null;
    try { v = JSON.parse(raw || "null"); } catch { return out; }
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    if (typeof v.v === "number" && v.v > 1) out.readOnly = true;
    else if (v.v !== 1) return out;
    if (!Array.isArray(v.routines)) return out;
    const seen = new Set();
    for (const r of v.routines) {
      if (out.routines.length >= CUSTOM_MAX) break;
      if (!r || typeof r !== "object" || !customId(r.id) || seen.has(r.id)) continue;
      const codes = Array.isArray(r.codes) ? r.codes.filter(isCode).slice(0, CUSTOM_MAX_DRILLS) : [];
      if (!codes.length) continue;
      seen.add(r.id);
      out.routines.push({ id: r.id, name: cleanName(r.name) || "My routine", codes, createdAt: num(r.createdAt) || 0, updatedAt: num(r.updatedAt) || 0 });
    }
    return out;
  }
  const writeCustom = (list) => JSON.stringify({
    v: 1,
    routines: (list || []).slice(0, CUSTOM_MAX).map((r) => ({ id: r.id, name: cleanName(r.name), codes: r.codes.slice(0, CUSTOM_MAX_DRILLS), createdAt: r.createdAt, updatedAt: r.updatedAt })),
  });
  // Same shape as ROUTINES entries.
  const customDefs = (store) => store.routines.map((r) => ({ id: r.id, name: r.name, blurb: "", steps: r.codes.map((code) => ({ code, seconds: DEFAULT_SECONDS })), custom: true }));
  // A custom routine always gets a card, also when none of its drills is in the drill list.
  function resolveCustom(def, catalogue, variants, warn) {
    const r = resolve(def, catalogue, variants, warn);
    return r ? { ...r, custom: true } : { id: def.id, name: def.name, blurb: "", steps: [], custom: true };
  }
  // Smallest unused N in "My routine N" (the routine being edited, except, does not count).
  function defaultName(store, except) {
    const used = new Set();
    for (const r of store.routines) {
      if (except && r.id === except) continue;
      const m = /^my routine (\d+)$/i.exec(r.name);
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n++;
    return `My routine ${n}`;
  }

  // ---------- custom routine editor (pure) ----------
  // draft = {id: null for a new routine, name, codes[]}; the same drill may be in it more than once.
  const TYPE_LABELS = { aim: "Pre-aim", hold: "Angle holding", flash: "Anti-flash", moment: "Scenario", basic: "Fundamentals", ball: "Target drill" };
  const typeLabel = (type) => TYPE_LABELS[type] || "";
  function newDraft(store, routine) {
    return routine ? { id: routine.id, name: routine.name, codes: routine.codes.slice() } : { id: null, name: defaultName(store), codes: [] };
  }
  const draftAdd = (d, code) => (isCode(code) && d.codes.length < CUSTOM_MAX_DRILLS ? { ...d, codes: [...d.codes, code] } : d);
  const draftRemove = (d, i) => (i >= 0 && i < d.codes.length ? { ...d, codes: d.codes.filter((_, k) => k !== i) } : d);
  function draftMove(d, i, by) {
    const j = i + by;
    if (i < 0 || i >= d.codes.length || j < 0 || j >= d.codes.length) return d;
    const codes = d.codes.slice();
    [codes[i], codes[j]] = [codes[j], codes[i]];
    return { ...d, codes };
  }
  // {ok, text}: what blocks Save. listLoaded false: the drill list did not load.
  function draftCheck(d, listLoaded) {
    if (!listLoaded) return { ok: false, text: "Drill list not loaded." };
    if (d.codes.length < CUSTOM_MIN_DRILLS) return { ok: false, text: `Add at least ${CUSTOM_MIN_DRILLS} drills.` };
    if (d.codes.length > CUSTOM_MAX_DRILLS) return { ok: false, text: `${CUSTOM_MAX_DRILLS} drills max.` };
    return { ok: true, text: "" };
  }
  const draftMinutes = (d) => (d.codes.length ? minutes(d.codes.map(() => ({ seconds: DEFAULT_SECONDS }))) : 0);
  // Saving changed drills of the routine that is paused ends that run; a rename keeps it.
  function codesChanged(store, d) {
    const old = d.id && store.routines.find((r) => r.id === d.id);
    return !!old && JSON.stringify(old.codes) !== JSON.stringify(d.codes);
  }
  // Returns {store, id} or {error}. now: Date.now() (also the new id).
  function saveCustom(store, d, now) {
    if (store.readOnly) return { error: "Saved by a newer version. Can't change it here." };
    const check = draftCheck(d, true);
    if (!check.ok) return { error: check.text };
    const name = cleanName(d.name) || defaultName(store, d.id);
    const codes = d.codes.filter(isCode).slice(0, CUSTOM_MAX_DRILLS);
    const list = store.routines.slice();
    const at = d.id ? list.findIndex((r) => r.id === d.id) : -1;
    if (at >= 0) {
      list[at] = { ...list[at], name, codes, updatedAt: now };
      return { store: { ...store, routines: list }, id: d.id };
    }
    if (list.length >= CUSTOM_MAX) return { error: `${CUSTOM_MAX} routines max.` };
    let t = Math.max(0, Math.floor(now));
    while (list.some((r) => r.id === "c-" + t.toString(36))) t++;
    const id = "c-" + t.toString(36);
    list.push({ id, name, codes, createdAt: now, updatedAt: now });
    return { store: { ...store, routines: list }, id };
  }
  function deleteCustom(store, id) {
    if (store.readOnly) return { error: "Saved by a newer version. Can't change it here." };
    return { store: { ...store, routines: store.routines.filter((r) => r.id !== id) } };
  }
  // The run after a save / delete of routine id: changed drills or a delete end its run (no
  // summary); a rename only renames it.
  function runAfterSave(run, id, name, changed) {
    if (!run || run.id !== id) return run;
    return changed ? null : run.name === name ? run : { ...run, name };
  }
  const runAfterDelete = (run, id) => (run && run.id === id ? null : run);

  // Drill picker rows: one per lobby card (twins merged), Studio's recording slot left out,
  // filtered by name (any part, any case) or an exact pasted share code.
  function pickerItems(catalogue, variants, query) {
    if (!Array.isArray(catalogue)) return null;
    const q = String(query || "").trim().toLowerCase();
    const index = cardIndex(catalogue);
    const qCard = isCode(q) ? itemFor(q, catalogue, variants, index) : null; // a pasted code (or its twin's)
    const seen = new Set();
    const out = [];
    for (const it of catalogue) {
      if (!it || !isCode(it.shareCode) || it.shareCode === RECORD_CODE) continue;
      const card = itemFor(it.shareCode, catalogue, variants, index) || it;
      if (seen.has(card.shareCode)) continue;
      seen.add(card.shareCode);
      const name = drillName(card);
      if (q && !name.toLowerCase().includes(q) && card.shareCode !== q && !(qCard && qCard.shareCode === card.shareCode)) continue;
      out.push({ code: card.shareCode, name, type: typeLabel(card.type) });
    }
    return out;
  }
  // Rows of the chosen list: codes not in the drill list stay (the player removes them).
  function draftRows(d, catalogue, variants) {
    const index = cardIndex(catalogue);
    return d.codes.map((code, i) => {
      const item = Array.isArray(catalogue) ? itemFor(code, catalogue, variants, index) : null;
      return { i, code, name: item ? drillName(item) : "Not in drill list", type: item ? typeLabel(item.type) : "", missing: !item };
    });
  }

  // ---------- result bar placement (DOM, no layout reads) ----------
  // The usual result card (.al-result-modal) or the full-screen Scenario result (.al-mr-stage).
  // In the card, ux's container (div.ux-result-extra, app/ux-result.js) wins when it is there;
  // otherwise the bar goes above every shell-added section (shooting summary, progress card) that
  // sits right over the buttons: those have classes but none of the game's "al-" ones.
  function resultSpot(doc) {
    const modal = doc.querySelector(".al-result-modal");
    if (modal) {
      const extra = modal.querySelector(".ux-result-extra");
      if (extra && modal.contains(extra)) return { kind: "extra", parent: extra, before: null };
      const actions = modal.querySelector(".al-run-actions");
      if (actions && actions.parentElement) {
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
    const stage = doc.querySelector(".al-mr-stage");
    if (stage) return { kind: "moment", parent: doc.body, before: null };
    return null;
  }
  // Moves the bar only when it is not in place. In ux's container it is prepended once and never
  // moved again to fix the order (other scripts own their rows there).
  function placeBar(bar, spot) {
    if (spot.kind === "extra") {
      if (bar.parentElement !== spot.parent) spot.parent.prepend(bar);
    } else if (spot.before) {
      if (bar.parentElement !== spot.parent || bar.nextElementSibling !== spot.before) spot.before.before(bar);
    } else if (bar.parentElement !== spot.parent) spot.parent.append(bar);
  }

  return {
    ROUTINES, RUN_KEY, STORE_KEY, TEST_KEY, RUNS_KEY, CAP,
    STEP_EVENT, SENS_NOTICE, NOTICE_MS, stepDetail, launchStep, sensFinderBusy, noticeText,
    esc, stripModel, stripHtml, resultSpot, placeBar,
    drillName, groupOf, sameGroup, itemFor, resolve, minutes, testRoutine,
    start, nextIndex, isDone, onScene, onResult, pause, advance, restore,
    summarize, better, pbStatus, parseRuns, formatValue, formatAccuracy, formatClock, playedSeconds, summary,
    readStore, addCompletion, dayDiff, lastDone, streak,
    CUSTOM_KEY, CUSTOM_MAX, CUSTOM_MIN_DRILLS, CUSTOM_MAX_DRILLS, NAME_MAX, RECORD_CODE,
    cleanName, readCustom, writeCustom, customDefs, resolveCustom, defaultName,
    TYPE_LABELS, typeLabel, newDraft, draftAdd, draftRemove, draftMove, draftCheck, draftMinutes, codesChanged,
    saveCustom, deleteCustom, runAfterSave, runAfterDelete, pickerItems, draftRows,
  };
});
