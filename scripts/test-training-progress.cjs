// Checks for the training progress math (app/training-progress-core.js): skill stats over the
// 14-day windows, run filters, kill-time direction, the "What to practise" rule, the lobby chip
// (same best and count as the card's Stats side), drill charts and bad storage data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const core = require('../app/training-progress-core');

const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 6, 12);
let seq = 0;
// A run as the game stores it (BZb782s6 xe()), passing the store validator.
function run(o = {}) {
  seq += 1;
  return {
    id: `${NOW}-r${seq}`, createdAt: NOW - DAY, shareCode: 'c-aim1', sceneHash: 'h', name: '困难-Ascent A: pre-aim', type: 'aim',
    mapId: 'ascent', end: 'time', seconds: 60, score: 1000, accuracy: 50, avgKillTime: 500, firstShotHitRate: 40,
    overshootRatio: 10, damage: 0, killed: 10, total: 20, headshots: 5, shots: 30, ...o,
  };
}
const raw = (list) => JSON.stringify(list);
const byId = (stats, id) => stats.find((s) => s.id === id);

test('bad or missing storage gives no runs', () => {
  for (const bad of [null, undefined, '', 'not json', '{"a":1}', '42', 'null', '[1,"x",null]']) assert.deepEqual(core.parseRuns(bad), [], String(bad));
  // Entries the game's validator (Vs) drops are dropped here too.
  const ok = run();
  const list = core.parseRuns(raw([ok, { ...ok, id: 5 }, { ...ok, end: 'quit' }, { ...ok, killed: undefined }, { ...ok, score: NaN }]));
  assert.equal(list.length, 1);
  // Old field name is read like the game does (Hs).
  const old = run({ firstPlacementAccuracy: 77 });
  delete old.firstShotHitRate;
  assert.equal(core.parseRuns(raw([old]))[0].firstShotHitRate, 77);
});

test('skill stats: 14-day rolling windows, means, pooled headshots', () => {
  const list = [
    run({ createdAt: NOW - 1 * DAY, accuracy: 60, firstShotHitRate: 50, avgKillTime: 400, headshots: 2, killed: 4 }),
    run({ createdAt: NOW - 13 * DAY, accuracy: 40, firstShotHitRate: 30, avgKillTime: 600, headshots: 6, killed: 6 }),
    run({ createdAt: NOW - 14 * DAY, accuracy: 10 }), // exactly 14 days ago: previous window
    run({ createdAt: NOW - 20 * DAY, accuracy: 30, avgKillTime: 0 }), // kill time 0 ignored
    run({ createdAt: NOW - 28 * DAY, accuracy: 99 }), // exactly 28 days: outside (windows are (start, end])
    run({ createdAt: NOW - 29 * DAY, accuracy: 1 }), // outside both
    run({ createdAt: NOW + DAY, accuracy: 1 }), // future: ignored
  ];
  const s = byId(core.skillStats(list, { now: NOW }), 'aim');
  assert.equal(s.recent.runs, 2);
  assert.equal(s.recent.accuracy, 50);
  assert.equal(s.recent.firstShot, 40);
  assert.equal(s.recent.killTime, 500);
  assert.equal(s.recent.headshot, (8 / 10) * 100); // pooled, not mean of 50% and 100%
  assert.equal(s.prev.runs, 2);
  assert.equal(s.prev.accuracy, 20);
  assert.equal(s.prev.killTime, 500); // 500 and 500, the 0 one skipped
  assert.equal(s.delta.accuracy, 30);
  // Every skill card is there, in chip order, ball last.
  assert.deepEqual(core.skillStats([], { now: NOW }).map((x) => x.id), ['aim', 'hold', 'flash', 'moment', 'basic', 'ball']);
});

test('deleted, legacy and 0-shot runs are left out of skill stats', () => {
  const list = [
    run({ accuracy: 80 }),
    run({ accuracy: 0, deletedAt: NOW }),
    run({ accuracy: 0, id: 'legacy-c-aim1' }),
    run({ accuracy: 0, shots: 0 }),
    run({ accuracy: 0, shots: null }),
    run({ accuracy: 0, shots: '5' }),
  ];
  const s = byId(core.skillStats(core.parseRuns(raw(list)), { now: NOW }), 'aim');
  assert.equal(s.recent.runs, 1);
  assert.equal(s.recent.accuracy, 80);
});

test('no data shows a dash, never NaN', () => {
  const s = byId(core.skillStats([], { now: NOW }), 'hold');
  for (const m of core.METRICS) {
    assert.equal(s.recent[m.id], null);
    assert.equal(core.fmt(m.id, s.recent[m.id]), '–');
    assert.equal(core.fmtDelta(m.id, s.delta[m.id]).text, '–');
  }
  assert.equal(core.fmt('accuracy', NaN), '–');
  // headshots null or nothing killed: no headshot value.
  const t = byId(core.skillStats([run({ headshots: null }), run({ killed: 0, headshots: 0 })], { now: NOW }), 'aim');
  assert.equal(t.recent.headshot, null);
  // Ball drills never show headshots.
  const b = byId(core.skillStats([run({ type: 'ball', shareCode: 'b1' })], { now: NOW }), 'ball');
  assert.equal(b.recent.runs, 1);
  assert.equal(b.recent.headshot, null);
  assert.equal(b.delta.headshot, null);
});

test('kill time: lower is better', () => {
  const faster = core.fmtDelta('killTime', -40);
  assert.deepEqual(faster, { text: '40 ms', dir: 'down', good: true });
  assert.deepEqual(core.fmtDelta('killTime', 25.4), { text: '25 ms', dir: 'up', good: false });
  assert.deepEqual(core.fmtDelta('accuracy', 3.14), { text: '3.1', dir: 'up', good: true });
  assert.deepEqual(core.fmtDelta('accuracy', -2), { text: '2.0', dir: 'down', good: false });
  assert.equal(core.fmtDelta('accuracy', 0.01).dir, 'flat');
  assert.equal(core.fmt('killTime', 412.6), '413 ms');
  // From 1000 ms on, kill time reads in seconds with 2 decimals (half up, no float slip).
  assert.equal(core.fmt('killTime', 520), '520 ms');
  assert.equal(core.fmt('killTime', 999.4), '999 ms');
  assert.equal(core.fmt('killTime', 999.6), '1.00 s');
  assert.equal(core.fmt('killTime', 17715), '17.72 s');
  assert.equal(core.fmt('killTime', 17714.4), '17.71 s');
  assert.equal(core.fmt('killTime', 1004.9), '1.00 s');
  assert.deepEqual(core.fmtDelta('killTime', 1200), { text: '1.20 s', dir: 'up', good: false });
  assert.deepEqual(core.fmtDelta('killTime', -1204), { text: '1.20 s', dir: 'down', good: true });
  assert.deepEqual(core.fmtDelta('killTime', -35), { text: '35 ms', dir: 'down', good: true });
  assert.deepEqual(core.fmtDelta('killTime', 0.4), { text: '0 ms', dir: 'flat', good: null });
  assert.equal(core.fmt('accuracy', 54.25), '54.3%');
  // Chart PB for kill time is the lowest value.
  const list = [run({ createdAt: NOW - 3 * DAY, avgKillTime: 500 }), run({ createdAt: NOW - 2 * DAY, avgKillTime: 300 }), run({ createdAt: NOW - DAY, avgKillTime: 400 })];
  assert.equal(core.drillSeries(list, 'c-aim1', 'killTime', {}).pb, 300);
  assert.equal(core.drillSeries(list, 'c-aim1', 'accuracy', {}).pb, 50);
});

test('community runs (type null) take their type from the catalogue, unknown ones are skipped', () => {
  const catalogue = core.indexCatalogue([{ shareCode: 'pw1', type: 'hold', name: 'x' }]);
  const stats = core.skillStats([run({ type: null, shareCode: 'pw1' }), run({ type: null, shareCode: 'zz' }), run({ type: 'weird', shareCode: 'zz2' })], { now: NOW, catalogue });
  assert.equal(byId(stats, 'hold').recent.runs, 1);
  assert.equal(stats.reduce((n, s) => n + s.recent.runs, 0), 1);
});

test('what to practise: biggest accuracy drop with >= 3 runs in each window', () => {
  const at = (type, code, days, accuracy) => run({ type, shareCode: code, createdAt: NOW - days * DAY, accuracy });
  const list = [];
  for (const d of [1, 2, 3]) list.push(at('aim', 'a', d, 50), at('hold', 'h', d, 40));
  for (const d of [15, 16, 17]) list.push(at('aim', 'a', d, 53), at('hold', 'h', d, 45));
  const cands = ['basic', 'aim', 'hold', 'flash', 'moment', 'ball'];
  const spot = core.weakSpot(core.skillStats(list, { now: NOW }), cands);
  assert.equal(spot.kind, 'dropped');
  assert.equal(spot.skill, 'hold'); // dropped 5 vs aim's 3
  assert.equal(spot.text, 'Your accuracy in Angle holding dropped 5 points this fortnight.');
  // A drop under 2 points does not count; then the least played skill (ties in fixed order) wins.
  const small = [];
  for (const d of [1, 2, 3]) small.push(at('aim', 'a', d, 50));
  for (const d of [15, 16, 17]) small.push(at('aim', 'a', d, 51.5));
  const s2 = core.weakSpot(core.skillStats(small, { now: NOW }), cands);
  assert.equal(s2.kind, 'least');
  assert.equal(s2.skill, 'basic');
  assert.equal(s2.text, "You haven't played Fundamentals much lately.");
  // Only 2 runs in the old window: not judged by drop.
  const few = [];
  for (const d of [1, 2, 3]) few.push(at('hold', 'h', d, 10));
  for (const d of [15, 16]) few.push(at('hold', 'h', d, 90));
  const s3 = core.weakSpot(core.skillStats(few, { now: NOW }), ['hold', 'ball']);
  assert.deepEqual([s3.kind, s3.skill], ['least', 'ball']);
  // Least played: fewest recent runs, not tie order, when counts differ.
  const s4 = core.weakSpot(core.skillStats([at('basic', 'b', 1, 50)], { now: NOW }), ['basic', 'aim']);
  assert.equal(s4.skill, 'aim');
  assert.equal(core.weakSpot(core.skillStats([], { now: NOW }), []), null);
});

test('candidate skills: lobby types in the catalogue plus ball, in tie order', () => {
  assert.deepEqual(core.candidateSkills([{ type: 'aim' }, { type: 'hold' }, { type: 'ball' }, { type: 'zzz' }]), ['aim', 'hold', 'ball']);
  assert.deepEqual(core.candidateSkills(null), ['ball']);
});

test('drill to play: most played (Easy twin counted under its Hard card), else first catalogue drill', () => {
  const items = [{ shareCode: 'h1', type: 'hold', name: '困难-One' }, { shareCode: 'h2', type: 'hold', name: '困难-Two' }, { shareCode: 'f1', type: 'flash', name: 'F' }];
  const catalogue = core.indexCatalogue(items);
  const variants = { h2: { code: 'h2', title: 'Two', easy: {} }, e2: { code: 'h2', title: 'Two', easy: {} } };
  const list = [run({ type: 'hold', shareCode: 'h1' }), run({ type: 'hold', shareCode: 'e2' }), run({ type: 'hold', shareCode: 'e2' })];
  assert.equal(core.drillForSkill('hold', list, catalogue, variants, items).shareCode, 'h2');
  assert.equal(core.drillForSkill('flash', list, catalogue, variants, items).shareCode, 'f1');
  assert.equal(core.drillForSkill('moment', list, catalogue, variants, items), null);
  assert.equal(core.drillName('h2', catalogue, variants, list), 'Two');
  assert.equal(core.drillName('h1', catalogue, variants, list), 'One');
  assert.equal(core.drillName('zz', catalogue, variants, [run({ shareCode: 'zz', name: '简单 - Gone drill' })]), 'Gone drill');
});

test('drill list and chart: >= 2 runs, most played first, twins merged, last 30 oldest first', () => {
  const variants = { H: { code: 'H', title: 'Hard drill' }, E: { code: 'H', title: 'Hard drill' } };
  const list = [run({ shareCode: 'H' }), run({ shareCode: 'E' }), run({ shareCode: 'X' }), run({ shareCode: 'Y' }), run({ shareCode: 'Y' }), run({ shareCode: 'Y', shots: 0 })];
  const drills = core.drillList(list, new Map(), variants);
  assert.deepEqual(drills.map((d) => [d.code, d.runs, d.merged]), [['H', 2, true], ['Y', 2, false]]);
  assert.equal(drills[0].name, 'Hard drill');
  const many = [];
  for (let i = 0; i < 40; i++) many.push(run({ shareCode: 'Z', createdAt: NOW - (40 - i) * DAY, accuracy: i }));
  const s = core.drillSeries(many.slice().reverse(), 'Z', 'accuracy', {});
  assert.equal(s.points.length, 30);
  assert.equal(s.points[0].value, 10);
  assert.equal(s.points[29].value, 39);
  assert.equal(s.pb, 39);
  // Runs without the stat leave a gap rather than a 0 point.
  const hs = core.drillSeries([run({ shareCode: 'Q', killed: 0 }), run({ shareCode: 'Q', headshots: 2, killed: 4 })], 'Q', 'headshot', {});
  assert.deepEqual(hs.points.map((p) => p.value), [50]);
});

test('lobby chip matches the card Stats side (me()/K() in BZb782s6.js)', () => {
  const list = [
    run({ shareCode: 'A', score: 900, seconds: 60, createdAt: 1 }),
    run({ shareCode: 'A', score: 1200.6, seconds: 50, createdAt: 2 }),
    run({ shareCode: 'A', score: 1200.6, seconds: 40, createdAt: 3 }), // same score, faster: best
    run({ shareCode: 'A', score: 5000, deletedAt: 9 }), // deleted: not counted
    run({ shareCode: 'A', score: 0, shots: 0 }), // 0-shot runs still count as attempts
    run({ shareCode: 'Atwin', score: 9999 }), // other code (Easy twin): not on this card
  ];
  const s = core.cardSummary(list, 'A', 'aim');
  assert.deepEqual(s, { attempts: 4, value: '1,201' });
  assert.equal(core.chipText(s), 'PB 1,201 · 4 runs');
  // Moment drills: lowest seconds among cleared runs, two decimals.
  const m = [
    run({ shareCode: 'M', type: 'moment', end: 'died', seconds: 3 }),
    run({ shareCode: 'M', type: 'moment', end: 'cleared', seconds: 12.345 }),
    run({ shareCode: 'M', type: 'moment', end: 'cleared', seconds: 9.999 }),
    run({ shareCode: 'M', type: 'moment', end: 'cleared', seconds: 3, id: 'legacy-M', shots: null, score: 0 }),
  ];
  assert.equal(core.chipText(core.cardSummary(m, 'M', 'moment')), 'PB 3.00 sec · 4 runs');
  // No cleared moment run: count only. No runs: no chip.
  assert.equal(core.chipText(core.cardSummary([m[0]], 'M', 'moment')), '1 run');
  assert.equal(core.chipText(core.cardSummary(list, 'none', 'aim')), '');
});

test('shell registration: UI script, CSS and build files', () => {
  const app = path.join(__dirname, '..', 'app');
  const main = fs.readFileSync(path.join(app, 'main.js'), 'utf-8');
  assert.match(main, /\["TRAINING PROGRESS", TRAINING_PROGRESS_JS\]/);
  assert.match(main, /insertCSS\(TRAINING_PROGRESS_CSS\)/);
  assert.ok(main.indexOf('"training-progress-core.js", "training-progress.js"') > 0, 'core loads before the UI');
  const files = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf-8')).build.files;
  for (const f of ['training-progress-core.js', 'training-progress.js', 'training-progress.css']) assert.ok(files.includes(f), f);
  // main.js parses, and the joined scripts compile the way main.js batches them (UI_SCRIPT_BATCH).
  execFileSync(process.execPath, ['--check', path.join(app, 'main.js')]);
  const joined = ['training-progress-core.js', 'training-progress.js'].map((n) => fs.readFileSync(path.join(app, n), 'utf-8')).join('\n');
  new vm.Script(`try {\n${joined}\n} catch (err) { console.error(err); }`);
  // Runs in a page without a DOM to decorate and without the core: no throw.
  const ctx = { requestAnimationFrame: () => {}, addEventListener: () => {}, fetch: () => Promise.resolve({ ok: false }), console };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  assert.doesNotThrow(() => vm.runInNewContext(fs.readFileSync(path.join(app, 'training-progress.js'), 'utf-8'), ctx));
  // The UI script never writes the run store.
  const ui = fs.readFileSync(path.join(app, 'training-progress.js'), 'utf-8') + fs.readFileSync(path.join(app, 'training-progress-core.js'), 'utf-8');
  assert.doesNotMatch(ui, /setItem|removeItem/);
});

// ---------- aim habits (D2): analytics store join, pooled habits, tiers, practise hint ----------
// A stored analytics summary (training-analytics-core.js summarize) with the counts D2 reads.
function summary(o = {}) {
  return {
    at: NOW - DAY, shareCode: 'c-aim1', endReason: 'time', round: false, tracking: false,
    approach: { over: 2, under: 1, on: 2, n: 5 }, followUp: { hit: 1, n: 2 }, moving: { yes: 1, n: 5 }, overflickDeg: 1.5, ...o,
  };
}
const store = (runs) => JSON.stringify({ v: 1, runs });

test('habits: parseAnalytics tolerates missing, corrupt and foreign data', () => {
  for (const bad of [null, undefined, '', 'not json', '42', 'null', '[]', '{"v":2,"runs":{"a":{"at":1}}}', '{"v":1,"runs":[]}', '{"v":1}']) {
    assert.equal(Object.keys(core.parseAnalytics(bad).runs).length, 0, String(bad));
  }
  const s = core.parseAnalytics('{"v":1,"runs":{"a":{"at":1},"b":{"at":"x"},"c":null,"d":[1],"__proto__":{"at":1}}}');
  assert.deepEqual(Object.keys(s.runs).sort(), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(s.runs), null, 'no prototype: "__proto__" is a plain key');
  assert.equal(core.ANALYTICS_KEY, 'aim-training-analytics-v1');
});

test('habits: join attaches counts by record id, skips round/tracking, never mutates', () => {
  const a = run({ id: 'r-a' });
  const b = run({ id: 'r-b' });
  const c = run({ id: 'r-c' });
  const d = run({ id: 'toString' }); // prototype name as an id: not in the store
  const list = [a, b, c, d];
  const st = core.parseAnalytics(store({ 'r-a': summary(), 'r-b': summary({ tracking: true }), 'r-c': summary({ round: true }) }));
  const out = core.joinAnalytics(list, st);
  assert.deepEqual(out[0].habits, { approach: { n: 5, over: 2, under: 1 }, followUp: { n: 2, hit: 1 }, moving: { n: 5, yes: 1 }, overflickDeg: 1.5 });
  assert.equal(out[1].habits, undefined);
  assert.equal(out[2].habits, undefined);
  assert.equal(out[3].habits, undefined);
  assert.equal(a.habits, undefined, 'input run not mutated');
  assert.equal(out[1], b, 'runs without habits come back as they were');
  // Bad stores and bad inputs.
  assert.deepEqual(core.joinAnalytics(list, core.parseAnalytics('garbage')).map((r) => r.habits), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(core.joinAnalytics(null, st), []);
  assert.equal(core.joinAnalytics(list, null), list);
});

test('habits: corrupt count groups are dropped one by one', () => {
  const st = core.parseAnalytics(store({
    x: summary({ approach: { over: 3, under: 3, n: 5 }, followUp: { hit: 1.5, n: 2 }, moving: { yes: 6, n: 5 } }),
    y: summary({ approach: { over: 1, under: 0, n: 4 }, followUp: 'no', moving: { yes: -1, n: 5 }, overflickDeg: -2 }),
    z: summary({ approach: null, followUp: null, moving: null }),
  }));
  const [x, y, z] = core.joinAnalytics([run({ id: 'x' }), run({ id: 'y' }), run({ id: 'z' })], st);
  assert.equal(x.habits, undefined, 'all groups bad: no habits');
  assert.deepEqual(y.habits, { approach: { n: 4, over: 1, under: 0 }, followUp: null, moving: null, overflickDeg: null });
  assert.equal(z.habits, undefined);
});

test('habits: pooled over runs, null under the card minimum, deltas between windows', () => {
  const recent = [];
  const prev = [];
  const sums = {};
  // 4 recent runs x 5 flicks = 20 (= CARD_MIN_N); pooled, not a mean of per-run ratios.
  const rc = [[1, 0, 0.5], [4, 1, 2.5], [2, 1, 1], [3, 0, 2]];
  rc.forEach(([over, under, deg], i) => {
    recent.push(run({ id: `h-r${i}`, createdAt: NOW - DAY }));
    sums[`h-r${i}`] = summary({ approach: { over, under, on: 5 - over - under, n: 5 }, overflickDeg: deg, followUp: { hit: 2, n: 5 }, moving: { yes: i, n: 5 } });
  });
  // Previous window: 20 flicks, 25% overflick.
  for (let i = 0; i < 4; i += 1) {
    prev.push(run({ id: `h-p${i}`, createdAt: NOW - 20 * DAY }));
    sums[`h-p${i}`] = summary({ approach: { over: i === 0 ? 2 : 1, under: 0, on: 4, n: 5 }, followUp: { hit: 1, n: 5 }, moving: { yes: 0, n: 5 } });
  }
  const list = core.joinAnalytics([...recent, ...prev, run({ id: 'old', createdAt: NOW - DAY })], core.parseAnalytics(store(sums)));
  const s = byId(core.skillStats(list, { now: NOW }), 'aim');
  assert.equal(s.recent.runs, 5, 'the old run without analytics still counts for the main metrics');
  assert.equal(s.recent.overflick, (10 / 20) * 100);
  assert.equal(s.recent.underflick, (2 / 20) * 100);
  assert.equal(s.recent.followUp, (8 / 20) * 100);
  assert.equal(s.recent.moving, (6 / 20) * 100);
  // Depth weighted by each run's over count.
  assert.equal(s.recent.overflickDeg, (1 * 0.5 + 4 * 2.5 + 2 * 1 + 3 * 2) / 10);
  assert.deepEqual(s.recent.habitN, { approach: 20, followUp: 20, moving: 20 });
  assert.equal(s.prev.overflick, 25);
  assert.equal(s.delta.overflick, 25);
  assert.equal(s.delta.moving, 30);
  assert.equal(s.delta.followUp, 20);
  // Below the minimum (one run = 5 flicks): null, and no delta.
  const one = core.joinAnalytics([recent[0]], core.parseAnalytics(store(sums)));
  const s1 = byId(core.skillStats(one, { now: NOW }), 'aim');
  for (const h of core.HABITS) assert.equal(s1.recent[h.id], null, h.id);
  assert.equal(s1.recent.overflickDeg, null);
  assert.equal(s1.delta.overflick, null);
  // Each habit has its own minimum: 20 flicks but only 4 follow-up samples.
  const fewFollow = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, { ...v, followUp: { hit: 1, n: 1 } }]));
  const s2 = byId(core.skillStats(core.joinAnalytics(recent, core.parseAnalytics(store(fewFollow))), { now: NOW }), 'aim');
  assert.equal(s2.recent.followUp, null);
  assert.equal(s2.recent.overflick, 50);
  // No analytics at all: every habit null, nothing else changes.
  const plain = byId(core.skillStats(recent, { now: NOW }), 'aim');
  for (const h of core.HABITS) assert.equal(plain.recent[h.id], null, h.id);
  assert.deepEqual(plain.recent.habitN, { approach: 0, followUp: 0, moving: 0 });
});

test('habits: chart series per run with the per-run minimum, lower overflick is the PB', () => {
  const runs = [
    run({ id: 'c1', createdAt: NOW - 3 * DAY }),
    run({ id: 'c2', createdAt: NOW - 2 * DAY }),
    run({ id: 'c3', createdAt: NOW - DAY }),
    run({ id: 'c4', createdAt: NOW - DAY / 2 }), // no analytics
  ];
  const list = core.joinAnalytics(runs, core.parseAnalytics(store({
    c1: summary({ approach: { over: 3, under: 0, on: 2, n: 5 } }),
    c2: summary({ approach: { over: 1, under: 1, on: 2, n: 4 } }), // under the per-run minimum (5)
    c3: summary({ approach: { over: 1, under: 2, on: 7, n: 10 } }),
  })));
  const s = core.drillSeries(list, 'c-aim1', 'overflick');
  assert.equal(s.metric.id, 'overflick');
  assert.deepEqual(s.points.map((p) => p.value), [60, 10]);
  assert.equal(s.pb, 10);
  assert.equal(s.runs, 4);
  assert.deepEqual(core.drillSeries(list, 'c-aim1', 'underflick').points.map((p) => p.value), [0, 20]);
  assert.equal(core.metricValue(list[3], 'overflick'), null);
  assert.equal(core.CHART_MIN_N, 5);
  assert.equal(core.CARD_MIN_N, 20);
  // Unknown metric still falls back to accuracy.
  assert.equal(core.drillSeries(list, 'c-aim1', 'nope').metric.id, 'accuracy');
});

test('habits: formatting in whole percent, deltas in whole points', () => {
  assert.equal(core.fmt('overflick', 37.6), '38%');
  assert.equal(core.fmt('moving', null), '–');
  assert.deepEqual(core.fmtDelta('overflick', 4.4), { text: '4', dir: 'up', good: false });
  assert.deepEqual(core.fmtDelta('followUp', 4.6), { text: '5', dir: 'up', good: true });
  assert.deepEqual(core.fmtDelta('moving', -0.4), { text: '0', dir: 'flat', good: null });
  // METRICS formatting unchanged.
  assert.equal(core.fmt('accuracy', 37.66), '37.7%');
  assert.deepEqual(core.fmtDelta('accuracy', 3.14), { text: '3.1', dir: 'up', good: true });
});

test('habits: game tiers (Bn in OkAdunfX.js) and their words', () => {
  // Thresholds match the bundle's own table.
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'app', 'mods', 'next', 'js', 'OkAdunfX.js'), 'utf-8');
  assert.ok(bundle.includes('overshoot:{dir:-1,good:45,great:30,elite:18}'));
  assert.ok(bundle.includes('movingShot:{dir:-1,good:25,great:12,elite:5}'));
  assert.ok(bundle.includes('followUp:{dir:1,good:40,great:60,elite:75}'));
  assert.deepEqual(core.TIERS.overshoot, { dir: -1, good: 45, great: 30, elite: 18 });
  assert.deepEqual(core.TIERS.movingShot, { dir: -1, good: 25, great: 12, elite: 5 });
  assert.deepEqual(core.TIERS.followUp, { dir: 1, good: 40, great: 60, elite: 75 });
  assert.equal(core.OVERFLICK_HINT, 45);
  // Limits are inclusive like Lx(), on the whole % shown.
  assert.equal(core.habitTier('overflick', 18), 'elite');
  assert.equal(core.habitTier('overflick', 18.4), 'elite');
  assert.equal(core.habitTier('overflick', 18.5), 'great');
  assert.equal(core.habitTier('overflick', 30), 'great');
  assert.equal(core.habitTier('overflick', 45), 'good');
  assert.equal(core.habitTier('overflick', 45.3), 'good');
  assert.equal(core.habitTier('overflick', 45.5), 'weak');
  assert.equal(core.habitTier('moving', 5), 'elite');
  assert.equal(core.habitTier('moving', 12), 'great');
  assert.equal(core.habitTier('moving', 25), 'good');
  assert.equal(core.habitTier('moving', 26), 'weak');
  assert.equal(core.habitTier('underflick', 80), null, 'no tier for underflick');
  assert.equal(core.habitTier('followUp', 80), null, 'tier word not shown for hit after miss');
  assert.equal(core.habitTier('overflick', null), null);
  assert.deepEqual(core.TIER_WORDS, { elite: 'Excellent', great: 'Great', good: 'Good', weak: 'Needs work' });
  assert.deepEqual(core.HABITS.map((h) => h.label), ['Overflick', 'Underflick', 'Hit after miss', 'Crosshair moving']);
  // Habits are not chart METRICS (the card and tab loops over METRICS stay the same).
  assert.deepEqual(core.METRICS.map((m) => m.id), ['accuracy', 'firstShot', 'killTime', 'headshot']);
});

test('habits: practise hint priority and text', () => {
  const st = (id, recent, prev = {}, delta = {}) => ({
    id, label: core.labelOf(id),
    recent: { runs: 5, accuracy: 50, overflick: null, overflickDeg: null, habitN: { approach: 0, followUp: 0, moving: 0 }, ...recent },
    prev: { runs: 5, accuracy: 50, ...prev },
    delta: { accuracy: 0, ...delta },
  });
  const cands = ['basic', 'aim', 'ball'];
  // (b) overflick above 45% with >= 20 flicks wins over "least played".
  let stats = [st('basic', {}), st('aim', { overflick: 52.4, overflickDeg: 1.26, habitN: { approach: 30, followUp: 0, moving: 0 } }), st('ball', { runs: 0 })];
  let h = core.practiseHint(stats, cands);
  assert.equal(h.kind, 'habit');
  assert.equal(h.habit, 'overflick');
  assert.equal(h.skill, 'aim');
  assert.equal(h.value, 52);
  assert.equal(h.deg, 1.3);
  assert.equal(h.text, 'You overflick 52% of your flicks in Pre-aim, about 1.3° past the target. Ease off at the end of the flick.');
  // No depth: the degrees part is left out.
  stats[1].recent.overflickDeg = null;
  assert.equal(core.practiseHint(stats, cands).text, 'You overflick 52% of your flicks in Pre-aim. Ease off at the end of the flick.');
  // (a) an accuracy drop beats the habit hint.
  stats = [st('basic', { accuracy: 40 }, { accuracy: 50 }, { accuracy: -10 }), stats[1], stats[2]];
  h = core.practiseHint(stats, cands);
  assert.equal(h.kind, 'dropped');
  assert.equal(h.skill, 'basic');
  // 45% shown (Good tier, also 45.4 rounded) or too few flicks: back to "least played", same as weakSpot.
  for (const recent of [{ overflick: 45, habitN: { approach: 30 } }, { overflick: 45.4, habitN: { approach: 30 } }, { overflick: 70, habitN: { approach: 19 } }]) {
    const s2 = [st('basic', {}), st('aim', recent), st('ball', { runs: 0 })];
    const x = core.practiseHint(s2, cands);
    assert.equal(x.kind, 'least');
    assert.deepEqual(x, core.weakSpot(s2, cands));
  }
  // Not a candidate: ignored.
  const s3 = [st('basic', {}), st('hold', { overflick: 90, habitN: { approach: 50 } }), st('ball', { runs: 0 })];
  assert.equal(core.practiseHint(s3, cands).kind, 'least');
  // Worst skill wins; equal values follow TIE_ORDER (basic before aim).
  const s4 = [st('aim', { overflick: 60, habitN: { approach: 20 } }), st('basic', { overflick: 50, habitN: { approach: 20 } })];
  assert.equal(core.practiseHint(s4, ['basic', 'aim']).skill, 'aim');
  s4[0].recent.overflick = 50;
  assert.equal(core.practiseHint(s4, ['basic', 'aim']).skill, 'basic');
  // No candidates: null like weakSpot.
  assert.equal(core.practiseHint(s4, []), null);
});

test('habits: end to end from stored strings, UI wiring, no banned words', () => {
  const sums = {};
  const list = [];
  for (let i = 0; i < 5; i += 1) {
    list.push(run({ id: `e${i}`, createdAt: NOW - DAY }));
    sums[`e${i}`] = summary({ approach: { over: 3, under: 0, on: 2, n: 5 }, overflickDeg: 2 });
  }
  const joinedRuns = core.joinAnalytics(core.parseRuns(raw(list)), core.parseAnalytics(store(sums)));
  const stats = core.skillStats(joinedRuns, { now: NOW });
  const h = core.practiseHint(stats, ['aim', 'ball']);
  assert.equal(h.text, 'You overflick 60% of your flicks in Pre-aim, about 2.0° past the target. Ease off at the end of the flick.');
  // D1 data has no reaction time, and "moving" is the crosshair, not the player.
  const app = path.join(__dirname, '..', 'app');
  const src = ['training-progress-core.js', 'training-progress.js'].map((n) => fs.readFileSync(path.join(app, n), 'utf-8')).join('\n');
  assert.doesNotMatch(src, /reaction|strafe|on the move/i);
  // No em dashes in habit texts.
  for (const t of [h.text, ...core.HABITS.flatMap((x) => [x.label, x.tip]), ...Object.values(core.TIER_WORDS)]) assert.doesNotMatch(t, /—/);
  // The UI joins the analytics store, refreshes on new run stats and uses the habit-aware hint.
  const ui = fs.readFileSync(path.join(app, 'training-progress.js'), 'utf-8');
  assert.match(ui, /addEventListener\("aim-run-stats", schedule\)/);
  assert.match(ui, /core\.practiseHint\(/);
  assert.match(ui, /core\.joinAnalytics\(/);
  assert.doesNotMatch(ui, /core\.weakSpot\(/);
});
