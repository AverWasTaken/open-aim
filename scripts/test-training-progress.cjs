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
