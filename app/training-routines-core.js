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
      blurb: "Small flicks, head level and pistol taps at range.",
      steps: [
        // Short, exact flicks inside a narrow box.
        { code: "e3c17ccb9f5a1500", seconds: 60 }, // Micro flicks
        // Tiny targets one small step apart.
        { code: "d43f842fb33e4d46", seconds: 60 }, // Micro tiles
        // Small heads in a tight row at head height.
        { code: "406d6e47ebc89bc3", seconds: 60 }, // Head-level micro
        // Sheriff with real reloads: every miss costs time.
        { code: "5d9cb8204613805e", seconds: 60 }, // Drift Reload
        // Sheriff taps down Haven C Long, against the clock.
        { code: "8e3c439a53c4dc6b", seconds: 40 }, // Erv's Sheriff 5k in 7 seconds
      ],
    },
    {
      id: "holding",
      name: "Holding angles",
      blurb: "Hold an angle, react to swings, turn away from flashes.",
      steps: [
        // Targets swing past one angle: pure reaction on a hold.
        { code: "5a9e43d609bbb3a3", seconds: 60 }, // Boaster's flick drill (hard)
        // Hold from Heaven on Split.
        { code: "782614562cd94b22", seconds: 60 }, // Split Heaven hold
        // Hold A Main and turn away from flashes.
        { code: "cb2431243b5643fd", seconds: 60 }, // Split A Main hold (updated)
        // Hold A Long while flashers swing and shoot back.
        { code: "112bc51af7b16caf", seconds: 60 }, // Haven A Long: hold vs flashes
      ],
    },
    {
      id: "movement",
      name: "Movement & peeks",
      blurb: "Track strafing bots, then clear routes against peekers.",
      steps: [
        // Track short strafes with sharp stops.
        { code: "6bdae48b1990cd16", seconds: 60 }, // Stop-and-go strafer
        // Track strafes with jumps.
        { code: "43dd532452d8890e", seconds: 60 }, // Jumping strafer
        // Three map routes where bots jiggle-peek real angles and shoot back.
        { code: "54d79166b4f48373", seconds: 90 }, // Ascent B retake: peekers
        { code: "61abe15ed0660f15", seconds: 90 }, // Split B Heaven retake: peekers
        { code: "5268ac892259ed6f", seconds: 90 }, // Haven Garage push: peekers
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
  function itemFor(code, catalogue, variants) {
    const byCode = new Map();
    for (const it of catalogue || []) if (it && typeof it.shareCode === "string") byCode.set(it.shareCode, it);
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

  return {
    ROUTINES, RUN_KEY, STORE_KEY, TEST_KEY, RUNS_KEY, CAP,
    drillName, groupOf, sameGroup, itemFor, resolve, minutes, testRoutine,
    start, nextIndex, isDone, onScene, onResult, pause, advance, restore,
    summarize, better, pbStatus, parseRuns, formatValue, formatAccuracy, formatClock, playedSeconds, summary,
    readStore, addCompletion, dayDiff, lastDone, streak,
  };
});
