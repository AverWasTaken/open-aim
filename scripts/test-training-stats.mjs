// tools/training_stats_patch.py + app/training-analytics-core.js:
//  - the "aim-run-stats" insert is in both OkAdunfX.js copies once, right before the anchor, the
//    copies are identical and the bundle still parses;
//  - the inserted code itself (cut out of the bundle) runs against stand-in Ks locals and builds
//    the right detail, also when zn / killLog / approach / wt are missing;
//  - the core's summary math, store parse, cap and duplicate handling;
//  - with the game files in site/: the real up() (OkAdunfX export, via scripts/sim-loader.mjs)
//    gives the ratios the core's recounted counts must match.
// Run: node --test scripts/test-training-stats.mjs   (npm run test:stats in app/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const core = require(path.join(ROOT, 'app', 'training-analytics-core.js'));
const COPIES = [
  path.join(ROOT, 'app', 'mods', 'next', 'js', 'OkAdunfX.js'),
  path.join(ROOT, 'app', 'mods', '_assets', 'r20261021-1', 'next', 'js', 'OkAdunfX.js'),
];
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ANCHOR = 'p.value=wt,h.value=Math.round(wt.smoothness)';
const START = 'try{const _sR=';
const TICK = 1 / 128;

function insertOf(s) {
  const at = s.indexOf(ANCHOR);
  const from = s.lastIndexOf(START, at);
  assert.ok(at > 0 && from > 0 && at - from < 4000, 'insert not found before the anchor');
  return s.slice(from, at);
}

test('both OkAdunfX.js copies are identical', () => {
  assert.equal(read(COPIES[0]), read(COPIES[1]));
});

test('aim-run-stats insert is patched in once, right before the anchor, inside Ks', () => {
  for (const p of COPIES) {
    const s = read(p);
    assert.equal(s.split(ANCHOR).length - 1, 1, `${p}: anchor count`);
    assert.equal(s.split('"aim-run-stats"').length - 1, 1, `${p}: event count (re-run tools/training_stats_patch.py?)`);
    assert.equal(s.split(START).length - 1, 1, `${p}: insert count`);
    const ins = insertOf(s);
    assert.ok(ins.endsWith('}catch{}'), `${p}: insert is one try/catch block`);
    // it sits after both record branches of Ks (the community branch ends with `else C.value=null}`)
    const ks = s.indexOf('function Ks(');
    assert.ok(ks > 0 && ks < s.indexOf(START) && s.indexOf(START) - ks < 4000, `${p}: insert is inside Ks`);
    assert.ok(s.slice(0, s.indexOf(START)).endsWith('else C.value=null}'), `${p}: insert follows the record branches`);
    // the run record join and the guarded reads
    for (const part of ['b.value?.run??C.value?.run??null', 'zn?.lives', 'G?.killLog', 'Tt?.meta?.id', 'round:!!ge?.round', 'tracking:_sW.scoring==="tracking"', 'tickSec:_sN(ve)']) {
      assert.ok(ins.includes(part), `${p}: insert lacks ${part}`);
    }
    assert.ok(!/reaction/i.test(ins.replace('k?.reactionTicks', '')), `${p}: no "reaction" naming in the event`);
  }
});

test('patched bundle parses (node --check on a temp .mjs copy)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-stats-'));
  try {
    const f = path.join(dir, 'OkAdunfX.mjs');
    fs.copyFileSync(COPIES[0], f);
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Runs the inserted code with stand-ins for the Ks locals it reads; returns the event details.
function runInsert(locals) {
  const ins = insertOf(read(COPIES[0]));
  const events = [];
  const window = { dispatchEvent: (e) => events.push(e) };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  const ctx = vm.createContext({ window, CustomEvent, Array, Number, Math, ...locals });
  vm.runInContext(ins, ctx);
  // the vm has its own Array/Object: compare as plain JSON (the detail must be plain data anyway)
  return events.map((e) => ({ type: e.type, detail: JSON.parse(JSON.stringify(e.detail)) }));
}

const APPROACH_OVER = { amplitudeDeg: 20, radiusDeg: 0.5, stopAlongDeg: 1.25, stop: 'over', straightness: 0.9 };
const APPROACH_ON = { amplitudeDeg: 15, radiusDeg: 0.5, stopAlongDeg: 0.1, stop: 'on', straightness: 0.8 };
const APPROACH_UNDER = { amplitudeDeg: 10, radiusDeg: 0.5, stopAlongDeg: -0.9, stop: 'under', straightness: 0.7 };
const LIVES = [
  { actorId: 1, bornTick: 0, seenTick: 10, killTick: 74, killFromTick: 10, firstHit: true, secondHit: null, firstMoving: false, approach: APPROACH_OVER },
  { actorId: 2, bornTick: 74, seenTick: 80, killTick: 208, killFromTick: 80, firstHit: false, secondHit: true, firstMoving: true, approach: APPROACH_ON },
  { actorId: 3, bornTick: 208, seenTick: 210, killTick: 306, killFromTick: 210, firstHit: false, secondHit: false, firstMoving: false, approach: APPROACH_UNDER },
  { actorId: 4, bornTick: 306, seenTick: null, killTick: null, killFromTick: null, firstHit: null, secondHit: null, firstMoving: null, approach: null },
];
const WT = {
  scoring: 'kills', score: 2100, accuracy: 60, hits: 3, shots: 5, duration: 60, smoothness: 70, coverage: 0, kills: 3, killsByMisses: [1, 2, 0],
  firstShotHitRate: 100 / 3, followUpHitRate: 50, overshootRatio: 100 / 3, undershootRatio: 100 / 3, pathEfficiency: 80,
  movingShotRatio: 100 / 3, avgKillTime: ((64 + 128 + 96) / 3) * TICK * 1e3,
};
const workshopLocals = (over = {}) => ({
  b: { value: { brief: {}, run: { id: '1730000000000-abc123', createdAt: 1730000000000, shareCode: 'ABCDEF', sceneHash: 'h1' }, prior: null } },
  C: { value: null },
  G: { killLog: [{ targetId: 1, missesBefore: 0, reactionTicks: 74 }, { targetId: 2, missesBefore: 1, reactionTicks: 134 }, { targetId: 3, missesBefore: 1, reactionTicks: 98 }] },
  ge: { endReason: 'time', targetsKilled: 3, targetsTotal: 4, kills: [] },
  zn: { lives: LIVES },
  wt: WT,
  Tt: { meta: { id: 'replay-1' } },
  ve: TICK,
  ...over,
});

test('insert builds the detail from the run record, outcome, up() stats, lives and killLog', () => {
  const ev = runInsert(workshopLocals());
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'aim-run-stats');
  const d = ev[0].detail;
  assert.equal(d.v, 1);
  assert.equal(d.recordId, '1730000000000-abc123');
  assert.equal(d.shareCode, 'ABCDEF');
  assert.equal(d.sceneHash, 'h1');
  assert.equal(d.createdAt, 1730000000000);
  assert.equal(d.endReason, 'time');
  assert.equal(d.targetsKilled, 3);
  assert.equal(d.targetsTotal, 4);
  assert.equal(d.replayId, 'replay-1');
  assert.equal(d.round, false);
  assert.equal(d.tracking, false);
  assert.equal(d.tickSec, TICK);
  assert.equal(d.stats.avgKillTime, WT.avgKillTime);
  assert.equal(d.stats.followUpHitRate, 50);
  assert.equal(d.stats.headshots, null);
  assert.equal(d.stats.coverage, 0);
  assert.equal(d.stats.smoothness, 70);
  assert.deepEqual(d.stats.killsByMisses, [1, 2, 0]);
  assert.equal(d.stats.damageTaken, null);
  assert.deepEqual(d.lives[0], [0, 10, 74, 10, 1, null, 0, 'over', 0.5, 1.25]);
  assert.deepEqual(d.lives[3], [306, null, null, null, null, null, null, null, null, null]);
  assert.deepEqual(d.spawnTicks, [74, 134, 98]);
  // plain data only
});

test('insert: community record via C.value, no record, round and missing data', () => {
  const pw = runInsert(workshopLocals({ b: { value: null }, C: { value: { shareCode: 'PWCODE', run: { id: 'pw-1', createdAt: 5, shareCode: 'PWCODE', sceneHash: '' }, prior: null } } }))[0].detail;
  assert.equal(pw.recordId, 'pw-1');
  assert.equal(pw.shareCode, 'PWCODE');
  const studio = runInsert(workshopLocals({ b: { value: null }, C: { value: null }, Tt: null }))[0].detail;
  assert.equal(studio.recordId, null);
  assert.equal(studio.replayId, null);
  const round = runInsert(workshopLocals({ b: { value: null }, C: { value: null }, ge: { endReason: 'cleared', round: { win: true } } }))[0].detail;
  assert.equal(round.round, true);
  const bare = runInsert(workshopLocals({ zn: undefined, G: undefined, ge: undefined, wt: undefined, Tt: undefined }));
  assert.equal(bare.length, 1, 'still dispatches with nothing to read');
  assert.deepEqual(bare[0].detail.lives, []);
  assert.deepEqual(bare[0].detail.spawnTicks, []);
  assert.equal(bare[0].detail.stats.accuracy, null);
  assert.equal(bare[0].detail.stats.killsByMisses, null);
  const tracking = runInsert(workshopLocals({ wt: { ...WT, scoring: 'tracking' }, G: { killLog: [{ targetId: 1, missesBefore: 0 }] } }))[0].detail;
  assert.equal(tracking.tracking, true);
  assert.deepEqual(tracking.spawnTicks, []);
  // a throwing getter must not escape the try/catch
  assert.doesNotThrow(() => runInsert(workshopLocals({ zn: { get lives() { throw new Error('boom'); } } })));
});

const detailOf = (over = {}) => ({ ...runInsert(workshopLocals())[0].detail, ...over });

test('core summary: counts, game ratios, kill and spawn times, overflick depth', () => {
  const s = core.summarize(detailOf(), 99);
  assert.equal(s.at, 1730000000000);
  assert.equal(s.shareCode, 'ABCDEF');
  assert.equal(s.kills, 3);
  assert.equal(s.killTimeN, 3);
  assert.equal(s.coverage, 0);
  assert.equal(s.smoothness, 70);
  assert.equal(s.avgKillTimeMs, Math.round(WT.avgKillTime));
  assert.equal(s.medianKillTimeMs, Math.round(96 * TICK * 1e3)); // 750
  assert.deepEqual(s.spawnToKillMs, { avg: Math.round(((74 + 134 + 98) / 3) * TICK * 1e3), median: Math.round(98 * TICK * 1e3), n: 3 });
  assert.deepEqual(s.firstShot, { hit: 1, n: 3 });
  assert.deepEqual(s.followUp, { hit: 1, n: 2 });
  assert.deepEqual(s.moving, { yes: 1, n: 3 });
  assert.deepEqual(s.approach, { over: 1, under: 1, on: 1, n: 3 });
  assert.equal(s.firstShotHitRate, 33.33);
  assert.equal(s.followUpHitRate, 50);
  assert.equal(s.overshootRatio, 33.33);
  assert.equal(s.undershootRatio, 33.33);
  assert.equal(s.movingShotRatio, 33.33);
  assert.equal(s.pathEfficiency, 80);
  assert.equal(s.overflickDeg, 0.75);
  assert.equal(s.accuracy, 60);
  assert.equal(s.tracking, false);
  assert.equal(s.round, false);
  assert.ok(!Object.keys(s).some((k) => /reaction/i.test(k)));
});

test('core summary: empty lives null every ratio; tracking; no record / round skipped', () => {
  const empty = core.summarize(detailOf({ lives: [], spawnTicks: [], stats: { ...WT, followUpHitRate: 100, firstShotHitRate: 0, avgKillTime: 0 } }), 7);
  assert.equal(empty.killTimeN, 0);
  assert.equal(empty.avgKillTimeMs, null);
  assert.equal(empty.medianKillTimeMs, null);
  assert.equal(empty.spawnToKillMs, null);
  for (const k of ['firstShotHitRate', 'followUpHitRate', 'movingShotRatio', 'overshootRatio', 'undershootRatio', 'pathEfficiency', 'overflickDeg']) assert.equal(empty[k], null, k);
  assert.deepEqual(empty.followUp, { hit: 0, n: 0 });
  // all first shots hit: the game says followUpHitRate 100, there was no follow-up to measure
  const allHit = core.summarize(detailOf({ lives: [[0, 1, 50, 1, 1, null, 0, null, null, null]] }));
  assert.equal(allHit.followUpHitRate, null);
  assert.equal(allHit.firstShot.n, 1);
  assert.equal(allHit.overshootRatio, null, 'approach null -> no approach ratios');
  const tr = core.summarize(detailOf({ tracking: true, spawnTicks: [] }));
  assert.equal(tr.tracking, true);
  assert.equal(tr.spawnToKillMs, null);
  assert.equal(core.summarize(detailOf({ recordId: null })), null);
  assert.equal(core.summarize(detailOf({ round: true })), null);
  assert.equal(core.summarize(null), null);
  assert.equal(core.summarize({}), null);
  // createdAt missing -> now; garbage rows ignored; bad tickSec -> 1/128
  const odd = core.summarize(detailOf({ createdAt: null, tickSec: 0, lives: ['x', null, [0, 0, 128, 0, 1, null, null, 'over', null, null]] }), 1234);
  assert.equal(odd.at, 1234);
  assert.equal(odd.killTimeN, 1);
  assert.equal(odd.medianKillTimeMs, 1000);
  assert.equal(odd.overflickDeg, null, 'no depth without radius/stop numbers');
});

test('core store: corrupt/missing tolerated, duplicate id skipped, cap drops oldest', () => {
  for (const t of [null, '', '{', '[]', '{"v":2,"runs":{}}', '{"v":1,"runs":[]}', '{"v":1,"runs":{"a":5,"b":{"at":"x"}}}']) {
    assert.deepEqual(Object.keys(core.parse(t).runs), [], String(t));
  }
  const kept = core.parse('{"v":1,"runs":{"a":{"at":1},"constructor":{"at":2}}}');
  assert.deepEqual(Object.keys(kept.runs).sort(), ['a', 'constructor']);
  const store = core.parse(null);
  const s1 = core.summarize(detailOf());
  assert.equal(core.add(store, 'r1', s1), true);
  assert.equal(core.add(store, 'r1', { ...s1, kills: 99 }), false);
  assert.equal(store.runs.r1.kills, 3);
  assert.equal(core.add(store, '', s1), false);
  assert.equal(core.add(store, 'r2', null), false);
  assert.equal(core.CAP, 400);
  const big = core.parse(null);
  for (let i = 0; i < 405; i++) core.add(big, `id${i}`, { at: 1000 + ((i * 7919) % 405) });
  const ids = Object.keys(big.runs);
  assert.equal(ids.length, 400);
  const ats = ids.map((id) => big.runs[id].at);
  assert.equal(Math.min(...ats), 1005, 'the 5 oldest were dropped');
  const listed = core.list(big);
  assert.equal(listed[0].at, 1404);
  assert.ok(listed[0].id);
  // round trip through JSON
  const back = core.parse(JSON.stringify(store));
  assert.deepEqual(JSON.parse(JSON.stringify(back.runs.r1)), JSON.parse(JSON.stringify(s1)));
});

test('shell script stores only record runs and never touches the run store', () => {
  const mem = new Map([['al-workshop-runs-v1', '[{"id":"keep"}]']]);
  const listeners = {};
  const window = { addEventListener: (t, f) => { listeners[t] = f; } };
  const localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  window.aimTrainingAnalyticsCore = core;
  const ctx = vm.createContext({ window, localStorage, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'training-analytics.js'), 'utf8'), ctx);
  const fire = (detail) => listeners['aim-run-stats']({ detail });
  fire(detailOf());
  fire(detailOf({ recordId: null }));
  fire(detailOf({ recordId: 'round-x', round: true }));
  fire(detailOf()); // duplicate
  const saved = JSON.parse(mem.get(core.KEY));
  assert.deepEqual(Object.keys(saved.runs), ['1730000000000-abc123']);
  assert.equal(mem.get('al-workshop-runs-v1'), '[{"id":"keep"}]');
  assert.equal(window.__aimTrainingAnalytics.get('1730000000000-abc123').kills, 3);
  assert.equal(window.__aimTrainingAnalytics.get('nope'), null);
  assert.equal(window.__aimTrainingAnalytics.all().length, 1);
  mem.set(core.KEY, '{corrupt');
  fire(detailOf({ recordId: 'after-corrupt' }));
  assert.deepEqual(Object.keys(JSON.parse(mem.get(core.KEY)).runs), ['after-corrupt']);
});

// The game's own up() (exported from OkAdunfX.js as `ab`) on the same hand-made lives: the core's
// recounted counts must give the game's ratios. Needs the game files in site/.
const HAVE_SITE = fs.existsSync(path.join(ROOT, 'site', 'next', 'js', 'CK5kb5jb.js'));
let up = null;
let loadError = null;
if (HAVE_SITE) {
  try {
    register(pathToFileURL(path.join(ROOT, 'scripts', 'sim-loader.mjs')).href);
    // OkAdunfX.js imports three.js from /studio/vendor/ (served from app/studio/ by main.js)
    const studio = pathToFileURL(path.join(ROOT, 'app', 'studio')).href;
    register('data:text/javascript,' + encodeURIComponent(
      `export async function resolve(s,c,n){return s.startsWith('/studio/')?{url:${JSON.stringify(studio)}+s.slice(7),shortCircuit:true}:n(s,c)}`));
    globalThis.window ??= globalThis;
    globalThis.self ??= globalThis;
    globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
    const mod = await import(pathToFileURL(COPIES[0]).href);
    up = typeof mod.ab === 'function' ? mod.ab : null;
    if (!up) loadError = 'export ab is not a function';
  } catch (err) {
    loadError = String(err && err.message || err).split('\n')[0];
  }
}
const upSkip = !HAVE_SITE ? 'no game files in site/' : !up ? `OkAdunfX.js did not load headless: ${loadError}` : false;

test('real up(): core counts reproduce the game ratios', { skip: upSkip }, () => {
  const G = { shots: 5, hits: 3, path: [], jerk: 0, frames: 0, covered: 0, coveredHead: 0, killLog: workshopLocals().G.killLog, duration: 60, configuredDuration: 60, humanoidHits: 0, enemyShotsFaced: 0, flashesFaced: 0 };
  const cases = [
    LIVES,
    [],
    [LIVES[0]],
    [LIVES[1], LIVES[2], LIVES[3]],
    [{ ...LIVES[0], firstMoving: true }, { ...LIVES[2], approach: APPROACH_OVER }],
  ];
  for (const lives of cases) {
    const wt = up(G, 'kills', { lives });
    const d = runInsert(workshopLocals({ wt, zn: { lives } }))[0].detail;
    const s = core.summarize(d);
    const pct = (a, n) => (n > 0 ? Math.round((a / n) * 100 * 100) / 100 : null);
    assert.equal(s.firstShotHitRate, pct(s.firstShot.hit, s.firstShot.n), 'firstShot');
    assert.equal(s.followUpHitRate, pct(s.followUp.hit, s.followUp.n), 'followUp');
    assert.equal(s.movingShotRatio, pct(s.moving.yes, s.moving.n), 'moving');
    assert.equal(s.overshootRatio, pct(s.approach.over, s.approach.n), 'over');
    assert.equal(s.undershootRatio, pct(s.approach.under, s.approach.n), 'under');
    assert.equal(s.avgKillTimeMs, s.killTimeN ? Math.round(wt.avgKillTime) : null, 'avgKillTime');
    assert.equal(s.kills, wt.kills, 'kills = game kill count');
    assert.equal(s.coverage, Math.round(wt.coverage * 100) / 100, 'coverage');
    if (s.killTimeN) {
      const ms = lives.filter((l) => l.killTick !== null && l.killFromTick !== null).map((l) => (l.killTick - l.killFromTick) * TICK * 1e3);
      assert.ok(Math.abs(wt.avgKillTime - ms.reduce((a, b) => a + b, 0) / ms.length) < 1e-6, 'game avgKillTime = mean spot-to-kill of the same lives');
    }
  }
});
