/* Training analytics: pure functions over the game's end-of-run "aim-run-stats" event (from
   tools/training_stats_patch.py) and the per-run summary store. No DOM. Used by
   training-analytics.js in the page and required by scripts/test-training-stats.mjs.

   Store: localStorage "aim-training-analytics-v1" = { v: 1, runs: { [recordId]: summary } },
   recordId = the id of the game's own run record (al-workshop-runs-v1), which this file never
   reads or writes. Max 400 runs; the oldest (by `at`) go first.

   Summary fields (all from one run):
     at, shareCode, endReason, round, tracking
     kills                       game's kill count (up() kills, same as the result card)
     killTimeN                   lives with a kill time (the lives the game's avgKillTime uses)
     avgKillTimeMs               game's avgKillTime (spot to kill), null when killTimeN is 0
     medianKillTimeMs            median of the same lives' (killTick - killFromTick)
     spawnToKillMs {avg, median, n}   killLog reactionTicks: spawn (or previous kill) to kill.
                                 Only mapless non-tracking drills record it, else null.
     firstShot {hit, n}, followUp {hit, n}, moving {yes, n}, approach {over, under, on, n}
                                 counts behind the game's ratios, recounted from the lives with the
                                 game's own rules (ip() in OkAdunfX.js; up() exposes only ratios)
     firstShotHitRate, followUpHitRate, movingShotRatio, overshootRatio, undershootRatio,
     pathEfficiency              game's own values (percent), null when their count n is 0
     overflickDeg                mean (stopAlongDeg - radiusDeg) over "over" approaches: how far
                                 past the target edge the flick stopped, degrees; null if none
     accuracy, shots, hits, coverage, smoothness   game's values (coverage = tracking drills' main
                                 number, percent) */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.aimTrainingAnalyticsCore = factory();
})(globalThis, function () {
  "use strict";
  const KEY = "aim-training-analytics-v1";
  const CAP = 400;
  const DEFAULT_TICK = 1 / 128;

  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const round = (x, d) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // A ratio is kept only when its sample count is > 0 (the game reports 0, or 100 for
  // followUpHitRate, when there was nothing to measure).
  const ratio = (value, n) => (n > 0 ? round(num(value), 2) : null);

  // lives rows: [bornTick, seenTick, killTick, killFromTick, firstHit, secondHit, firstMoving,
  //              stop, radiusDeg, stopAlongDeg]
  function life(row) {
    if (!Array.isArray(row)) return null;
    const flag = (x) => (x === 1 ? true : x === 0 ? false : null);
    return {
      killTick: num(row[2]),
      killFromTick: num(row[3]),
      firstHit: flag(row[4]),
      secondHit: flag(row[5]),
      firstMoving: flag(row[6]),
      stop: typeof row[7] === "string" ? row[7] : null,
      radiusDeg: num(row[8]),
      stopAlongDeg: num(row[9]),
    };
  }

  // Per-run summary of one event detail, or null when it can't be stored (no record id, i.e.
  // Studio/plaza runs, or a Round mode run).
  function summarize(detail, now = Date.now()) {
    if (!detail || typeof detail !== "object") return null;
    const id = detail.recordId;
    if (typeof id !== "string" || !id || detail.round) return null;
    const st = detail.stats && typeof detail.stats === "object" ? detail.stats : {};
    const tick = num(detail.tickSec) > 0 ? detail.tickSec : DEFAULT_TICK;
    const lives = (Array.isArray(detail.lives) ? detail.lives : []).map(life).filter(Boolean);

    // Same filters as the game's ip().
    const killed = lives.filter((l) => l.killTick !== null && l.killFromTick !== null);
    const killMs = killed.map((l) => (l.killTick - l.killFromTick) * tick * 1e3);
    const first = lives.filter((l) => l.firstHit !== null);
    const follow = lives.filter((l) => l.firstHit === false && l.secondHit !== null);
    const moving = lives.filter((l) => l.firstMoving !== null);
    const appr = lives.filter((l) => l.stop !== null);
    const over = appr.filter((l) => l.stop === "over");
    const under = appr.filter((l) => l.stop === "under");
    const depth = over.filter((l) => l.radiusDeg !== null && l.stopAlongDeg !== null).map((l) => l.stopAlongDeg - l.radiusDeg);
    const spawn = (Array.isArray(detail.spawnTicks) ? detail.spawnTicks : []).map(num).filter((x) => x !== null && x >= 0).map((t) => t * tick * 1e3);

    const createdAt = num(detail.createdAt);
    return {
      at: createdAt ?? now,
      shareCode: typeof detail.shareCode === "string" ? detail.shareCode : null,
      endReason: typeof detail.endReason === "string" ? detail.endReason : null,
      round: false,
      tracking: !!detail.tracking,
      kills: num(st.kills),
      killTimeN: killed.length,
      avgKillTimeMs: killed.length ? round(num(st.avgKillTime) ?? mean(killMs), 0) : null,
      medianKillTimeMs: round(median(killMs), 0),
      spawnToKillMs: spawn.length ? { avg: round(mean(spawn), 0), median: round(median(spawn), 0), n: spawn.length } : null,
      firstShot: { hit: first.filter((l) => l.firstHit).length, n: first.length },
      followUp: { hit: follow.filter((l) => l.secondHit).length, n: follow.length },
      moving: { yes: moving.filter((l) => l.firstMoving).length, n: moving.length },
      approach: { over: over.length, under: under.length, on: appr.length - over.length - under.length, n: appr.length },
      firstShotHitRate: ratio(st.firstShotHitRate, first.length),
      followUpHitRate: ratio(st.followUpHitRate, follow.length),
      movingShotRatio: ratio(st.movingShotRatio, moving.length),
      overshootRatio: ratio(st.overshootRatio, appr.length),
      undershootRatio: ratio(st.undershootRatio, appr.length),
      pathEfficiency: ratio(st.pathEfficiency, appr.length),
      overflickDeg: round(mean(depth), 2),
      accuracy: round(num(st.accuracy), 2),
      shots: num(st.shots),
      hits: num(st.hits),
      coverage: round(num(st.coverage), 2),
      smoothness: round(num(st.smoothness), 2),
    };
  }

  // Store text -> { v: 1, runs } (missing, corrupt or foreign data -> empty store).
  function parse(text) {
    let o = null;
    try {
      o = typeof text === "string" ? JSON.parse(text) : null;
    } catch {}
    const runs = Object.create(null); // ids are user data: no prototype keys
    if (o && typeof o === "object" && o.v === 1 && o.runs && typeof o.runs === "object" && !Array.isArray(o.runs)) {
      for (const [id, r] of Object.entries(o.runs)) {
        if (r && typeof r === "object" && !Array.isArray(r) && num(r.at) !== null) runs[id] = r;
      }
    }
    return { v: 1, runs };
  }

  // Adds a summary (unless the id is already stored) and trims to CAP (oldest `at` first).
  // Returns true when the store changed.
  function add(store, id, summary, cap = CAP) {
    if (!summary || typeof id !== "string" || !id) return false;
    if (Object.prototype.hasOwnProperty.call(store.runs, id)) return false;
    store.runs[id] = summary;
    const ids = Object.keys(store.runs);
    if (ids.length > cap) {
      ids.sort((a, b) => store.runs[a].at - store.runs[b].at);
      for (const old of ids.slice(0, ids.length - cap)) delete store.runs[old];
    }
    return true;
  }

  // Newest first, each with its id.
  const list = (store) => Object.entries(store.runs).map(([id, r]) => ({ ...r, id })).sort((a, b) => b.at - a.at);

  return { KEY, CAP, summarize, parse, add, list, median };
});
