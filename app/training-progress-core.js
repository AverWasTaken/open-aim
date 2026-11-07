/* Training progress: pure math over the saved runs (no DOM). Used by training-progress.js in the
   page and required by scripts/test-training-progress.cjs. Read-only: nothing here writes storage. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.aimTrainingProgress = factory();
})(globalThis, function () {
  "use strict";
  // The game's run store (index.uPZ7wDgX.js key table): newest first, max 300 runs. Community
  // (pw) runs are pushed here too, so al-pw-runs-v1 is not read (it would count them twice).
  const RUNS_KEY = "al-workshop-runs-v1";
  const DAY = 864e5;
  const WINDOW = 14 * DAY;
  const CHART_RUNS = 30;

  // Skill = lobby drill type. Ids and English labels of the lobby's type chips (ut in
  // site/next/js/BPUvDycd.js, English from the i18n dictionary / english-fixes.js), in chip order.
  // "ball" is the Target Workshop's own type; the ux word for it is "Target drills".
  const SKILLS = [
    { id: "aim", label: "Pre-aim" },
    { id: "hold", label: "Angle holding" },
    { id: "flash", label: "Anti-flash" },
    { id: "moment", label: "Scenarios" },
    { id: "basic", label: "Fundamentals" },
    { id: "ball", label: "Target drills" },
  ];
  const SKILL_IDS = new Set(SKILLS.map((s) => s.id));
  // Fixed tie order for the "What to practise" pick.
  const TIE_ORDER = ["basic", "aim", "hold", "flash", "moment", "ball"];
  const labelOf = (id) => SKILLS.find((s) => s.id === id)?.label || id;

  // Chart metrics. better: +1 higher is better, -1 lower is better.
  const METRICS = [
    { id: "accuracy", label: "Accuracy", unit: "%", better: 1 },
    { id: "firstShot", label: "First shot", unit: "%", better: 1 },
    { id: "killTime", label: "Kill time", unit: "ms", better: -1 },
    { id: "headshot", label: "Headshot %", unit: "%", better: 1 },
  ];

  const num = (v) => typeof v === "number" && Number.isFinite(v);

  // ---------- reading ----------
  // Same check as the game's loader (Vs in Dc2Dm9E6.js): runs failing it are dropped by the game,
  // so they are not counted here either.
  const numOrNull = (v) => v === null || num(v);
  const validRun = (r) => !!r && typeof r === "object" && typeof r.id === "string" && typeof r.shareCode === "string"
    && typeof r.sceneHash === "string" && typeof r.name === "string" && (r.end === "cleared" || r.end === "died" || r.end === "time")
    && num(r.createdAt) && num(r.seconds) && num(r.score) && num(r.accuracy) && numOrNull(r.damage) && numOrNull(r.killed) && numOrNull(r.total);

  // The runs as the game loads them: valid entries only, the old firstPlacementAccuracy field read
  // as firstShotHitRate (Hs), first 300. Corrupt or missing data gives []. Soft-deleted runs are
  // kept (callers filter). Returns new objects; storage is never written.
  function parseRuns(raw) {
    if (typeof raw !== "string" || !raw) return [];
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    return list.filter(validRun).slice(0, 300).map((r) => {
      if (!("firstPlacementAccuracy" in r)) return r;
      const { firstPlacementAccuracy, ...rest } = r;
      return { ...rest, firstShotHitRate: num(r.firstShotHitRate) ? r.firstShotHitRate : Number(firstPlacementAccuracy) || 0 };
    });
  }

  // Runs the game lists (liveRuns): not soft-deleted.
  const isLive = (r) => r.deletedAt === undefined;
  // Runs used for skill stats and charts: live, not a merged legacy moment best ('legacy-' ids
  // carry no stats), and with at least one shot (shots must be a number > 0).
  const isCounted = (r) => isLive(r) && !String(r.id || "").startsWith("legacy-") && num(r.shots) && r.shots > 0;

  // catalogue: the training list ('/prod-api/api/v1/public/val/aimlab/workshop' data, Easy twins
  // left out) -> Map code -> item. variants: '/aim/drill-variants.json' .variants (code -> group).
  function indexCatalogue(items) {
    const map = new Map();
    if (Array.isArray(items)) for (const it of items) if (it && typeof it.shareCode === "string") map.set(it.shareCode, it);
    return map;
  }

  // Drill group code. The rank picker's "No return fire" starts the drill's Easy twin, which has
  // its own shareCode; group.code (from drill-variants.js) is the Hard code shown on the card, so
  // Easy-twin runs are counted under the drill they were started from.
  function groupCode(code, variants) {
    const g = variants && Object.prototype.hasOwnProperty.call(variants, code) ? variants[code] : null;
    return g && typeof g.code === "string" ? g.code : code;
  }

  // Skill of a run: its own type when it is a known skill, else the catalogue's type for its code
  // (or its group's code). Unknown -> null (the run is skipped). Community runs have type null.
  function skillOf(run, catalogue, variants) {
    if (SKILL_IDS.has(run.type)) return run.type;
    const it = catalogue?.get(run.shareCode) || catalogue?.get(groupCode(run.shareCode, variants));
    return it && SKILL_IDS.has(it.type) ? it.type : null;
  }

  // ---------- per-run metric values (null = no value for this run) ----------
  function metricValue(run, id) {
    if (id === "accuracy") return num(run.accuracy) ? run.accuracy : null;
    if (id === "firstShot") return num(run.firstShotHitRate) ? run.firstShotHitRate : null;
    if (id === "killTime") return num(run.avgKillTime) && run.avgKillTime > 0 ? run.avgKillTime : null;
    if (id === "headshot") return run.headshots !== null && num(run.headshots) && num(run.killed) && run.killed > 0 ? (run.headshots / run.killed) * 100 : null;
    return null;
  }

  // Aggregate of one window. accuracy / firstShot: plain mean of the per-run % values.
  // killTime: mean over runs with avgKillTime > 0 (ms). headshot: pooled sum(headshots) /
  // sum(killed) over runs with headshots !== null and killed > 0. null when there is no data.
  function aggregate(runs) {
    const mean = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
    let hs = 0;
    let killed = 0;
    for (const r of runs) {
      if (r.headshots !== null && num(r.headshots) && num(r.killed) && r.killed > 0) {
        hs += r.headshots;
        killed += r.killed;
      }
    }
    return {
      runs: runs.length,
      accuracy: mean(runs.map((r) => metricValue(r, "accuracy")).filter((v) => v !== null)),
      firstShot: mean(runs.map((r) => metricValue(r, "firstShot")).filter((v) => v !== null)),
      killTime: mean(runs.map((r) => metricValue(r, "killTime")).filter((v) => v !== null)),
      headshot: killed > 0 ? (hs / killed) * 100 : null,
    };
  }

  // Skill cards. Windows are rolling: recent = (now-14d, now], previous = (now-28d, now-14d].
  // delta = recent - previous (null unless both have a value). Ball drills have no headshot value.
  function skillStats(runs, opts = {}) {
    const now = num(opts.now) ? opts.now : Date.now();
    const recentFrom = now - WINDOW;
    const prevFrom = now - 2 * WINDOW;
    const buckets = new Map(SKILLS.map((s) => [s.id, { recent: [], prev: [] }]));
    for (const r of runs) {
      if (!isCounted(r)) continue;
      const skill = skillOf(r, opts.catalogue, opts.variants);
      if (!skill) continue;
      const b = buckets.get(skill);
      if (r.createdAt > recentFrom && r.createdAt <= now) b.recent.push(r);
      else if (r.createdAt > prevFrom && r.createdAt <= recentFrom) b.prev.push(r);
    }
    return SKILLS.map((s) => {
      const b = buckets.get(s.id);
      const recent = aggregate(b.recent);
      const prev = aggregate(b.prev);
      if (s.id === "ball") recent.headshot = prev.headshot = null;
      const delta = {};
      for (const m of METRICS) delta[m.id] = recent[m.id] !== null && prev[m.id] !== null ? recent[m.id] - prev[m.id] : null;
      return { id: s.id, label: s.label, recent, prev, delta };
    });
  }

  // ---------- "What to practise" ----------
  // candidates: lobby types present in the catalogue, plus ball.
  // 1. A candidate with >= 3 runs in each window whose average accuracy dropped by >= 2 points:
  //    the biggest drop wins ("dropped").
  // 2. Else the candidate with the fewest runs in the last 14 days ("least").
  // Ties: TIE_ORDER. Returns { skill, label, kind, drop?, text } or null without candidates.
  function weakSpot(stats, candidates) {
    const set = new Set(candidates);
    const list = TIE_ORDER.filter((id) => set.has(id)).map((id) => stats.find((s) => s.id === id)).filter(Boolean);
    if (!list.length) return null;
    let best = null;
    for (const s of list) {
      if (s.recent.runs < 3 || s.prev.runs < 3 || s.delta.accuracy === null) continue;
      const drop = -s.delta.accuracy;
      if (drop >= 2 && (!best || drop > best.drop)) best = { s, drop };
    }
    if (best) {
      const d = Math.round(best.drop * 10) / 10;
      return { skill: best.s.id, label: best.s.label, kind: "dropped", drop: d, text: `Your accuracy in ${best.s.label} dropped ${d} points this fortnight.` };
    }
    let least = list[0];
    for (const s of list) if (s.recent.runs < least.recent.runs) least = s;
    return { skill: least.id, label: least.label, kind: "least", text: `You haven't played ${least.label} much lately.` };
  }

  // Lobby types present in the catalogue (ball is not a lobby type), plus ball.
  function candidateSkills(catalogueItems) {
    const types = new Set();
    if (Array.isArray(catalogueItems)) for (const it of catalogueItems) if (it && it.type !== "ball" && SKILL_IDS.has(it.type)) types.add(it.type);
    types.add("ball");
    return TIE_ORDER.filter((id) => types.has(id));
  }

  // Drill to play for a skill: the player's most-played drill of that type (by group code, i.e.
  // the Hard card; ties -> most recently played), else the first catalogue drill of that type.
  // Only drills in the catalogue can be launched. Returns a catalogue item or null.
  function drillForSkill(skill, runs, catalogue, variants, catalogueItems) {
    const counts = new Map();
    for (const r of runs) {
      if (!isLive(r) || String(r.id || "").startsWith("legacy-")) continue;
      if (skillOf(r, catalogue, variants) !== skill) continue;
      const code = groupCode(r.shareCode, variants);
      const it = catalogue?.get(code);
      if (!it || it.type !== skill) continue;
      const c = counts.get(code) || { n: 0, last: 0 };
      c.n += 1;
      c.last = Math.max(c.last, r.createdAt);
      counts.set(code, c);
    }
    let pick = null;
    for (const [code, c] of counts) {
      if (!pick || c.n > pick.n || (c.n === pick.n && (c.last > pick.last || (c.last === pick.last && code < pick.code)))) pick = { code, ...c };
    }
    if (pick) return catalogue.get(pick.code);
    if (Array.isArray(catalogueItems)) for (const it of catalogueItems) if (it && it.type === skill && typeof it.shareCode === "string") return it;
    return null;
  }

  // ---------- names ----------
  // The game's title parser (vt in site/next/js/BPUvDycd.js; same as drill-variants.js): raw
  // names carry a 简单-/困难- (Easy/Hard) prefix that the page translates; we show the title only.
  const NAME = /^(简单|普通|中等|困难)(?:\s*[-－—·]\s*|\s+)(.+)$/;
  function cleanName(name) {
    const s = String(name || "").trim();
    const m = NAME.exec(s);
    return m ? m[2].trim() : s;
  }
  function drillName(code, catalogue, variants, runs) {
    const g = variants && Object.prototype.hasOwnProperty.call(variants, code) ? variants[code] : null;
    if (g && g.title) return cleanName(g.title);
    const it = catalogue?.get(code);
    if (it && it.name) return cleanName(it.name);
    const r = runs && runs.find((x) => x.shareCode === code && x.name);
    return r ? cleanName(r.name) : "Unnamed drill";
  }

  // ---------- per-drill chart ----------
  // Drills with >= 2 counted runs, most played first (ties: most recent). Easy-twin runs are merged
  // into their Hard drill (merged: true when the drill has any).
  function drillList(runs, catalogue, variants) {
    const groups = new Map();
    for (const r of runs) {
      if (!isCounted(r)) continue;
      const code = groupCode(r.shareCode, variants);
      const g = groups.get(code) || { code, runs: 0, last: 0, merged: false };
      g.runs += 1;
      g.last = Math.max(g.last, r.createdAt);
      if (r.shareCode !== code) g.merged = true;
      groups.set(code, g);
    }
    return [...groups.values()]
      .filter((g) => g.runs >= 2)
      .sort((a, b) => b.runs - a.runs || b.last - a.last || (a.code < b.code ? -1 : 1))
      .map((g) => ({ ...g, name: drillName(g.code, catalogue, variants, runs) }));
  }

  // Last 30 counted runs of a drill group (oldest -> newest) with a value for the metric.
  // pb: best value among them (max, or min for kill time). Easy-twin runs are included.
  function drillSeries(runs, code, metric, variants) {
    const m = METRICS.find((x) => x.id === metric) || METRICS[0];
    const own = runs
      .filter((r) => isCounted(r) && groupCode(r.shareCode, variants) === code)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-CHART_RUNS);
    const points = [];
    for (const r of own) {
      const v = metricValue(r, m.id);
      if (v !== null) points.push({ at: r.createdAt, value: v, easy: r.shareCode !== code });
    }
    let pb = null;
    for (const p of points) if (pb === null || (m.better > 0 ? p.value > pb : p.value < pb)) pb = p.value;
    return { metric: m, points, pb, runs: own.length };
  }

  // ---------- lobby card chip ----------
  // Mirrors the card back (WorkshopCardBack: summaryFor(code) = me() + K() in BZb782s6.js):
  // the card's own code only, all live runs (no shot filter, legacy moment bests included).
  // Moment drills: best = lowest seconds (rounded to 0.01) among cleared runs. Others: highest
  // score, ties -> lower seconds, then the earlier run. Value format as qo(): seconds toFixed(2)
  // "sec", score rounded with thousands separators. null when the code has no live runs.
  const r2 = (v) => Math.round(v * 100) / 100;
  function better(a, b, moment) {
    if (moment) {
      const x = r2(a.seconds);
      const y = r2(b.seconds);
      return x !== y ? x < y : a.createdAt < b.createdAt;
    }
    if (a.score !== b.score) return a.score > b.score;
    const x = r2(a.seconds);
    const y = r2(b.seconds);
    return x !== y ? x < y : a.createdAt < b.createdAt;
  }
  function cardSummary(runs, code, type) {
    const moment = type === "moment";
    let attempts = 0;
    let best = null;
    for (const r of runs) {
      if (r.shareCode !== code || !isLive(r)) continue;
      attempts += 1;
      if (moment ? r.end !== "cleared" : false) continue;
      if (!num(r.score) || !num(r.seconds)) continue;
      if (!best || better(r, best, moment)) best = r;
    }
    if (!attempts) return null;
    const value = best ? (moment ? r2(best.seconds).toFixed(2) + " sec" : Math.round(best.score).toLocaleString("en-US")) : null;
    return { attempts, value };
  }
  function chipText(summary) {
    if (!summary) return "";
    const n = `${summary.attempts} ${summary.attempts === 1 ? "run" : "runs"}`;
    return summary.value === null ? n : `PB ${summary.value} · ${n}`;
  }

  // ---------- formatting ----------
  // "–" for no data, never NaN.
  function fmt(metric, v) {
    if (v === null || v === undefined || !num(v)) return "–";
    if (metric === "killTime") return `${Math.round(v)} ms`;
    return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
  }
  // Change vs the previous window: { text, dir: "up"|"down"|"flat", good: true|false|null }.
  function fmtDelta(metric, d) {
    if (d === null || d === undefined || !num(d)) return { text: "–", dir: "flat", good: null };
    const m = METRICS.find((x) => x.id === metric);
    const r = metric === "killTime" ? Math.round(d) : Math.round(d * 10) / 10;
    if (r === 0) return { text: metric === "killTime" ? "0 ms" : "0.0", dir: "flat", good: null };
    const abs = Math.abs(r);
    const text = metric === "killTime" ? `${abs} ms` : abs.toFixed(1);
    return { text, dir: r > 0 ? "up" : "down", good: (r > 0) === (m.better > 0) };
  }

  return {
    RUNS_KEY, SKILLS, METRICS, TIE_ORDER, WINDOW, CHART_RUNS,
    parseRuns, isLive, isCounted, indexCatalogue, groupCode, skillOf, metricValue, aggregate,
    skillStats, weakSpot, candidateSkills, drillForSkill, cleanName, drillName, drillList, drillSeries,
    cardSummary, chipText, fmt, fmtDelta, labelOf,
  };
});
