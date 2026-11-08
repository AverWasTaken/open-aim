// Routines (app/training-routines-core.js): routine data against the real drill list, the routine
// state machine, personal bests, streaks and storage that is missing or broken.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../app/training-routines-core');

const root = path.join(__dirname, '..');
const listFile = path.join(root, 'site', 'prod-api', 'api', 'v1', 'public', 'val', 'aimlab', 'workshop');
const scenesDir = path.join(root, 'site', 'prod-api', 'api', 'v1', 'public', 'val', 'aimlab', 'scenes');
const setFile = path.join(root, 'app', 'training-set.json');
const official = JSON.parse(fs.readFileSync(listFile, 'utf-8')).data;
const trainingSet = fs.existsSync(setFile) ? JSON.parse(fs.readFileSync(setFile, 'utf-8')) : { items: [], scenes: {} };
const catalogue = [...official, ...trainingSet.items.filter((x) => !official.some((o) => o.shareCode === x.shareCode))];

function sceneDoc(code) {
  let scene = trainingSet.scenes[code];
  if (!scene) {
    const file = path.join(scenesDir, code);
    if (!fs.existsSync(file)) return null;
    scene = JSON.parse(fs.readFileSync(file, 'utf-8')).data;
  }
  return typeof scene.doc === 'string' ? JSON.parse(scene.doc) : scene.doc;
}

// Easy/Hard twins as /aim/drill-variants.json gives them.
const HARD = 'aaaaaaaaaaaaaaa1', EASY = 'aaaaaaaaaaaaaaa2', OLD = 'aaaaaaaaaaaaaaa3', OTHER = 'bbbbbbbbbbbbbbb1', THIRD = 'ccccccccccccccc1';
const group = { code: HARD, item: { shareCode: HARD, name: '困难-Twin drill', type: 'aim' }, easy: { shareCode: EASY, name: '简单-Twin drill', type: 'aim' } };
const variants = { [HARD]: group, [EASY]: group, [OLD]: group };
const fakeList = [group.item, { shareCode: OTHER, name: 'Other drill', type: 'basic' }, { shareCode: THIRD, name: 'Clock drill', type: 'moment' }];
const fakeRoutine = { id: 'r', name: 'Fake', steps: [{ code: EASY, seconds: 60 }, { code: OTHER, seconds: 30 }, { code: THIRD, seconds: 40 }] };
const rec = (code, extra = {}) => ({ id: 'run-' + Math.random().toString(36).slice(2), createdAt: 1000, shareCode: code, name: 'x', type: 'aim', end: 'time', seconds: 60, score: 100, accuracy: 50, ...extra });

test('every routine drill is in the drill list and its length matches its scene', () => {
  assert.ok(core.ROUTINES.length >= 3 && core.ROUTINES.length <= 4);
  const ids = new Set();
  for (const r of core.ROUTINES) {
    assert.ok(!ids.has(r.id), 'unique id ' + r.id); ids.add(r.id);
    assert.ok(r.name && r.blurb && !/[—–]/.test(r.name + r.blurb), 'plain text ' + r.id);
    assert.ok(r.steps.length >= 3 && r.steps.length <= 6, r.id);
    const resolved = core.resolve(r, catalogue, {}, (code) => assert.fail('missing ' + code));
    assert.equal(resolved.steps.length, r.steps.length);
    for (const s of r.steps) {
      const doc = sceneDoc(s.code);
      assert.ok(doc, 'scene for ' + s.code);
      assert.equal(s.seconds, doc.rules.duration, 'duration of ' + s.code);
    }
  }
  const warm = core.resolve(core.ROUTINES.find((r) => r.id === 'warmup'), catalogue, {});
  assert.equal(warm.steps.length, 5);
  assert.equal(core.minutes(warm.steps), 8);
  assert.ok(!warm.steps.some((s) => /简单|困难/.test(s.name)));
});

test('the gen-3 drills sit in the routines they fit', () => {
  const codes = (id) => core.ROUTINES.find((r) => r.id === id).steps.map((s) => s.code);
  const fromFile = (f) => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', f + '.json'), 'utf-8')).item.shareCode;
  for (const [id, files] of [
    ['precision', ['long-range-taps', 'sheriff-one-taps']],
    ['movement', ['counter-strafe-taps', 'jiggle-peek-duels']],
    ['holding', ['operator-angle-hold', 'spray-transfer']],
  ]) for (const f of files) assert.ok(codes(id).includes(fromFile(f)), f + ' in ' + id);
  for (const r of core.ROUTINES) {
    assert.equal(new Set(r.steps.map((s) => s.code)).size, r.steps.length, 'no repeats in ' + r.id);
    const min = core.minutes(r.steps);
    assert.ok(min >= 5 && min <= 10, r.id + ' takes ' + min + ' min');
  }
});

test('missing drills are skipped with a warning, twins resolve to their lobby card', () => {
  const warned = [];
  const r = core.resolve({ id: 'x', name: 'X', steps: [{ code: 'ffffffffffffffff' }, { code: EASY, seconds: 60 }, { code: 'nope' }, { code: OTHER }] }, fakeList, variants, (c) => warned.push(c));
  assert.deepEqual(warned, ['ffffffffffffffff', 'nope']);
  assert.deepEqual(r.steps.map((s) => [s.code, s.name, s.seconds]), [[HARD, 'Twin drill', 60], [OTHER, 'Other drill', 60]]);
  assert.equal(core.resolve({ id: 'y', name: 'Y', steps: [{ code: 'ffffffffffffffff' }] }, fakeList, variants), null);
  assert.equal(core.resolve(null, fakeList, variants), null);
  assert.equal(core.resolve({ id: 'z', name: 'Z', steps: [{ code: OTHER }] }, null, null), null, 'no drill list yet');
});

test('test-only routine is read only when present and valid', () => {
  assert.equal(core.testRoutine(null), null);
  assert.equal(core.testRoutine('{bad'), null);
  assert.equal(core.testRoutine('{"codes":["xyz"]}'), null);
  const t = core.testRoutine(JSON.stringify({ name: 'T', codes: [OTHER, 'bad', THIRD] }));
  assert.deepEqual(t.steps.map((s) => s.code), [OTHER, THIRD]);
  assert.equal(t.id, 'test');
});

test('state machine: start, launch, result, play again, next, finish', () => {
  const resolved = core.resolve(fakeRoutine, fakeList, variants);
  let run = core.start(resolved, 5000);
  assert.equal(run.phase, 'launching');
  assert.equal(run.index, 0);
  // The rank picker's "No return fire" starts the Easy twin: same step.
  run = core.onScene(run, EASY, variants);
  assert.equal(run.phase, 'playing');
  assert.equal(core.nextIndex(run), 0);
  // a result of another drill does not count
  assert.equal(core.onResult(run, rec(OTHER), variants), run);
  run = core.onResult(run, rec(EASY, { id: 'a', score: 100 }), variants);
  assert.equal(run.results[0].score, 100);
  // Play again: no new scene event, the newer result replaces the step's result
  run = core.onResult(run, rec(EASY, { id: 'b', score: 250 }), variants);
  assert.equal(run.results[0].id, 'b');
  assert.equal(run.results.length, 1);
  assert.equal(core.nextIndex(run), 1);
  run = core.advance(run, 6000);
  assert.deepEqual([run.index, run.phase, run.launchedAt], [1, 'launching', 6000]);
  run = core.onScene(run, OTHER, variants);
  run = core.onResult(run, rec(OTHER, { type: 'basic' }), variants);
  run = core.onScene(core.advance(run, 7000), THIRD, variants);
  assert.equal(core.isDone(run), false);
  run = core.onResult(run, rec(THIRD, { type: 'moment', end: 'cleared', seconds: 7.5 }), variants);
  assert.equal(core.isDone(run), true);
  assert.equal(core.nextIndex(run), 3);
  // nothing left to launch
  assert.equal(core.advance(run, 8000).phase, 'paused');
});

test('state machine: other drills, quitting, pause and resume', () => {
  const resolved = core.resolve(fakeRoutine, fakeList, variants);
  let run = core.start(resolved, 0);
  // another drill started while ours was loading pauses the routine
  assert.equal(core.onScene(run, OTHER, variants).phase, 'paused');
  run = core.onScene(run, OLD, variants); // an older copy of the twin group still counts
  assert.equal(run.phase, 'playing');
  // a second scene while playing = the player started something else
  assert.equal(core.onScene(run, HARD, variants).phase, 'paused');
  // quit mid-run (Back): paused, no result, Continue relaunches the same step
  run = core.pause(run);
  assert.equal(run.phase, 'paused');
  assert.equal(core.onResult(run, rec(HARD), variants), run, 'paused routines record nothing');
  assert.equal(core.onScene(run, HARD, variants), run, 'paused stays paused');
  run = core.advance(run, 1);
  assert.deepEqual([run.index, run.phase], [0, 'launching']);
  assert.equal(core.pause(null), null);
  assert.equal(core.onScene(null, HARD, variants), null);
});

test('restore after reload is always paused; corrupt data is dropped', () => {
  const resolved = core.resolve(fakeRoutine, fakeList, variants);
  let run = core.onScene(core.start(resolved, 42), HARD, variants);
  run = core.onResult(run, rec(HARD, { id: 'r1' }), variants);
  const back = core.restore(JSON.stringify(run));
  assert.equal(back.phase, 'paused');
  assert.equal(back.results[0].id, 'r1');
  assert.equal(back.startedAt, 42);
  assert.equal(core.nextIndex(back), 1);
  for (const bad of [null, '', '{', '[]', '{"v":2}', '{"v":1,"id":"x","codes":[]}', '{"v":1,"id":"x","codes":["zz"]}', 'null', '7']) {
    assert.equal(core.restore(bad), null, String(bad));
  }
  const odd = core.restore(JSON.stringify({ v: 1, id: 'x', codes: [OTHER, THIRD], index: 9, results: [7, { code: OTHER }], names: ['a'] }));
  assert.deepEqual([odd.index, odd.results[0], !!odd.results[1], odd.names], [0, undefined, true, ['Drill', 'Drill']]);
});

test('personal bests follow the game rule, across twins, excluding the new run and deleted runs', () => {
  const runs = [
    rec(EASY, { id: 'new', createdAt: 500, score: 300 }),
    rec(HARD, { id: 'h', createdAt: 400, score: 250 }),
    rec(OLD, { id: 'del', createdAt: 300, score: 900, deletedAt: 301 }),
    rec(OTHER, { id: 'o', createdAt: 200, score: 5000 }),
    rec(HARD, { id: 'later', createdAt: 600, score: 9999 }),
  ];
  const r = core.summarize(runs[0]);
  assert.equal(core.pbStatus(r, runs, variants).kind, 'pb');
  assert.equal(core.pbStatus(r, runs, variants).best.score, 250);
  assert.equal(core.pbStatus({ ...r, score: 200 }, runs, variants).kind, 'off');
  // equal score: the lower time wins
  assert.equal(core.pbStatus({ ...r, score: 250, seconds: 50 }, runs, variants).kind, 'pb');
  assert.equal(core.pbStatus({ ...r, score: 250, seconds: 60 }, runs, variants).kind, 'off');
  // without twins the Hard run would not be compared
  assert.equal(core.pbStatus({ ...r, score: 1 }, runs, {}).kind, 'first');
  // Scenario drills: fastest cleared time, runs that did not clear never count
  const m = [
    rec(THIRD, { id: 'm0', type: 'moment', createdAt: 900, end: 'cleared', seconds: 8.2 }),
    rec(THIRD, { id: 'm1', type: 'moment', createdAt: 800, end: 'died', seconds: 3 }),
    rec(THIRD, { id: 'm2', type: 'moment', createdAt: 700, end: 'cleared', seconds: 9.1 }),
  ];
  assert.equal(core.pbStatus(core.summarize(m[0]), m, variants).kind, 'pb');
  assert.equal(core.pbStatus(core.summarize({ ...m[0], seconds: 9.5 }), m, variants).kind, 'off');
  assert.equal(core.pbStatus(core.summarize(m[1]), m, variants).kind, 'none');
  assert.equal(core.pbStatus(core.summarize(m[2]), m, variants).kind, 'first');
  assert.equal(core.formatValue(core.summarize(m[0])), '8.20 s');
  assert.equal(core.formatValue(core.summarize(m[1])), 'Not cleared');
  assert.equal(core.formatValue(core.summarize(rec(OTHER, { score: 12345.6 }))), '12,346');
  // broken history
  assert.deepEqual(core.parseRuns('{x'), []);
  assert.deepEqual(core.parseRuns('{"a":1}'), []);
  assert.equal(core.pbStatus(r, [null, 7, 'x', {}], variants).kind, 'first');
});

test('summary rows, play time and clock', () => {
  const resolved = core.resolve(fakeRoutine, fakeList, variants);
  let run = core.onScene(core.start(resolved, 0), HARD, variants);
  run = core.onResult(run, rec(HARD, { id: 's1', seconds: 61.4, score: 10 }), variants);
  const s = core.summary(run, [rec(HARD, { id: 's1', score: 10 })], variants);
  assert.equal(s.rows.length, 3);
  assert.equal(s.rows[0].pb.kind, 'first');
  assert.equal(s.rows[1].result, null);
  assert.equal(s.complete, false);
  assert.equal(core.formatClock(s.played), '1:01');
  assert.equal(core.formatClock(330), '5:30');
  assert.equal(core.formatAccuracy({ accuracy: 49.6 }), '50%');
  assert.equal(core.formatAccuracy(null), '-');
});

test('completions: stored newest first, Play again replaces, capped, corrupt storage tolerated', () => {
  for (const bad of [null, '', '{', '[]', '{"v":2,"completions":[]}', '{"v":1,"completions":{}}']) {
    assert.deepEqual(core.readStore(bad), { v: 1, completions: [] }, String(bad));
  }
  assert.equal(core.readStore('{"v":1,"completions":[null,{"id":"a"},{"id":"a","at":5}]}').completions.length, 1);
  const run = { id: 'warmup', startedAt: 10, results: [{ code: OTHER, name: 'n', score: 1, accuracy: 2, seconds: 3, end: 'time' }] };
  let store = core.addCompletion(core.readStore(null), run, 100);
  store = core.addCompletion(store, { ...run, results: [{ ...run.results[0], score: 9 }] }, 120);
  assert.equal(store.completions.length, 1);
  assert.equal(store.completions[0].results[0].score, 9);
  for (let i = 0; i < 250; i++) store = core.addCompletion(store, { ...run, startedAt: 1000 + i }, 1000 + i);
  assert.equal(store.completions.length, core.CAP);
  assert.equal(store.completions[0].at, 1249);
  const again = core.readStore(JSON.stringify(store));
  assert.equal(again.completions.length, core.CAP);
});

test('last done and day streak use local calendar days', () => {
  const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
  const now = day(2026, 11, 6, 9);
  const mk = (...ats) => ({ v: 1, completions: ats.map((at) => ({ id: 'warmup', at })) });
  assert.deepEqual(core.lastDone(mk(), 'warmup', now), { at: null, label: 'Not done yet' });
  assert.equal(core.lastDone(mk(day(2026, 11, 6, 1)), 'warmup', now).label, 'Today');
  assert.equal(core.lastDone(mk(day(2026, 11, 5, 23)), 'warmup', now).label, 'Yesterday');
  assert.equal(core.lastDone(mk(day(2026, 11, 3), day(2026, 10, 1)), 'warmup', now).label, '3 days ago');
  assert.equal(core.lastDone(mk(day(2026, 11, 6, 1)), 'precision', now).label, 'Not done yet');
  assert.equal(core.streak(mk(), 'warmup', now), 0);
  // today, yesterday, the day before: 3; a gap ends the streak
  assert.equal(core.streak(mk(day(2026, 11, 6, 1), day(2026, 11, 5), day(2026, 11, 4), day(2026, 11, 2)), 'warmup', now), 3);
  // not done yet today: the streak up to yesterday still counts
  assert.equal(core.streak(mk(day(2026, 11, 5), day(2026, 11, 4)), 'warmup', now), 2);
  // last done two days ago: no streak
  assert.equal(core.streak(mk(day(2026, 11, 4)), 'warmup', now), 0);
  // several the same day count once; across a month end
  assert.equal(core.streak(mk(day(2026, 11, 1, 8), day(2026, 11, 1, 20), day(2026, 10, 31)), 'warmup', day(2026, 11, 1, 22)), 2);
});

// ---------- R2: feel hooks, ux result container, compact strip ----------
function fakeWin(extra = {}) {
  const calls = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  return {
    calls, CustomEvent,
    dispatchEvent(e) { calls.push(['event', e.type, e.detail]); return true; },
    __aimLaunchWorkshop(item) { calls.push(['launch', item.shareCode]); return true; },
    ...extra,
  };
}

test('step event: payload, fired right before each launch, none without a drill or launcher', () => {
  let run = core.start(core.resolve(fakeRoutine, fakeList, variants), 0);
  const win = fakeWin();
  assert.equal(core.launchStep(win, run, core.itemFor(run.codes[0], fakeList, variants)), true);
  run = core.onScene(run, EASY, variants);
  run = core.onResult(run, rec(EASY), variants);
  run = core.advance(run, 10);
  core.launchStep(win, run, core.itemFor(run.codes[run.index], fakeList, variants));
  assert.deepEqual(win.calls, [
    ['event', 'aim-routine-step', { routineId: 'r', index: 0, total: 3, shareCode: HARD, name: 'Twin drill' }],
    ['launch', HARD],
    ['event', 'aim-routine-step', { routineId: 'r', index: 1, total: 3, shareCode: OTHER, name: 'Other drill' }],
    ['launch', OTHER],
  ]);
  assert.equal(core.STEP_EVENT, 'aim-routine-step');
  // A refused launch still reports false; no item / no launcher: no event, no launch.
  const refuse = fakeWin({ __aimLaunchWorkshop() { refuse.calls.push(['launch']); return false; } });
  assert.equal(core.launchStep(refuse, run, fakeList[1]), false);
  assert.deepEqual(refuse.calls.map((c) => c[0]), ['event', 'launch']);
  const none = fakeWin({ __aimLaunchWorkshop: undefined });
  assert.equal(core.launchStep(none, run, fakeList[1]), false);
  assert.equal(core.launchStep(win, run, null), false);
  assert.equal(none.calls.length, 0);
  assert.equal(win.calls.length, 4);
});

test('sensitivity finder: Start / Continue refused before any state change, notice for 4 s', () => {
  assert.equal(core.sensFinderBusy({}), false);
  assert.equal(core.sensFinderBusy({ __aimSensFinderActive: 0 }), false);
  assert.equal(core.sensFinderBusy({ __aimSensFinderActive: true }), true);
  assert.equal(core.sensFinderBusy({ __aimSensFinderActive: { step: 2 } }), true);
  assert.equal(core.sensFinderBusy({ get __aimSensFinderActive() { throw new Error('x'); } }), false);
  const notice = { text: core.SENS_NOTICE, until: 1000 + core.NOTICE_MS };
  assert.equal(core.NOTICE_MS, 4000);
  assert.equal(core.SENS_NOTICE, 'Finish or stop the sensitivity finder first.');
  assert.ok(!/[—–]/.test(core.SENS_NOTICE));
  assert.equal(core.noticeText(notice, 1000), core.SENS_NOTICE);
  assert.equal(core.noticeText(notice, 1000 + core.NOTICE_MS), '');
  assert.equal(core.noticeText(null, 0), '');
  const list = [core.resolve(fakeRoutine, fakeList, variants)];
  const on = core.stripModel(list, null, core.readStore(null), 1000, notice);
  const off = core.stripModel(list, null, core.readStore(null), 1000 + core.NOTICE_MS, notice);
  assert.equal(on.notice, core.SENS_NOTICE);
  assert.notEqual(JSON.stringify(on), JSON.stringify(off), 'the strip redraws when the notice ends');
  assert.match(core.stripHtml(on), /<span class="tr-notice" role="status">Finish or stop the sensitivity finder first\.<\/span>/);
  assert.doesNotMatch(core.stripHtml(off), /tr-notice/);
  // The shell checks the finder first thing, before closeSummary / stopWatching / setRun.
  const src = fs.readFileSync(path.join(root, 'app', 'training-routines.js'), 'utf-8');
  for (const fn of ['startRoutine(id)', 'continueRoutine()']) {
    const body = src.slice(src.indexOf('function ' + fn + ' {'));
    const first = body.split('\n')[1].trim();
    assert.equal(first, 'if (refusedBySensFinder()) return;', fn);
  }
  assert.match(src, /C\.launchStep\(window, run, item\)/);
});

// Minimal DOM: enough for resultSpot / placeBar (querySelector by one class, siblings, moves).
class El {
  constructor(cls = '', kids = []) { this.className = cls; this.children = []; this.parentElement = null; for (const k of kids) this.append(k); }
  get classList() { const list = this.className.split(/\s+/).filter(Boolean); return { contains: (c) => list.includes(c) }; }
  get firstElementChild() { return this.children[0] || null; }
  _sib(d) { const p = this.parentElement; if (!p) return null; return p.children[p.children.indexOf(this) + d] || null; }
  get previousElementSibling() { return this._sib(-1); }
  get nextElementSibling() { return this._sib(1); }
  remove() { const p = this.parentElement; if (p) { p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  append(el) { el.remove(); el.parentElement = this; this.children.push(el); }
  prepend(el) { el.remove(); el.parentElement = this; this.children.unshift(el); }
  before(el) { const p = this.parentElement; el.remove(); el.parentElement = p; p.children.splice(p.children.indexOf(this), 0, el); }
  contains(el) { for (let e = el; e; e = e.parentElement) if (e === this) return true; return false; }
  querySelector(sel) {
    const c = sel.replace(/^\./, '');
    for (const k of this.children) { if (k.classList.contains(c)) return k; const d = k.querySelector(sel); if (d) return d; }
    return null;
  }
}

test("result bar: fallback above the shell rows, then into ux's container once, never re-moved", () => {
  const actions = new El('al-run-actions');
  const shot = new El('es-shotgraph-sum');
  const body = new El('al-run-body', [new El('al-run-hero'), shot, actions]);
  const modal = new El('al-result-modal', [body]);
  const doc = new El('', [new El('al-result-overlay', [modal])]);
  doc.body = doc;
  const bar = new El('tr-bar');
  const names = () => body.children.map((k) => k.className);

  let spot = core.resultSpot(doc);
  assert.equal(spot.kind, 'card');
  core.placeBar(bar, spot);
  assert.deepEqual(names(), ['al-run-hero', 'tr-bar', 'es-shotgraph-sum', 'al-run-actions']);
  core.placeBar(bar, core.resultSpot(doc)); // stable
  assert.deepEqual(names(), ['al-run-hero', 'tr-bar', 'es-shotgraph-sum', 'al-run-actions']);

  // ux-result.js place(): container above the shot summary; "ux-result-extra" fires -> sync.
  const extra = new El('ux-result-extra');
  shot.before(extra);
  spot = core.resultSpot(doc);
  assert.equal(spot.kind, 'extra');
  assert.equal(spot.parent, extra);
  core.placeBar(bar, spot);
  assert.equal(bar.parentElement, extra);
  assert.deepEqual(names(), ['al-run-hero', 'ux-result-extra', 'es-shotgraph-sum', 'al-run-actions']);

  // Another script adds its row first in the container: the bar is not moved to fix the order.
  const other = new El('xx-row');
  extra.prepend(other);
  let moves = 0;
  const count = (fn) => function (...a) { moves++; return fn.apply(this, a); };
  for (const k of ['prepend', 'append', 'before']) { extra[k] = count(El.prototype[k]); bar[k] = count(El.prototype[k]); }
  core.placeBar(bar, core.resultSpot(doc));
  core.placeBar(bar, core.resultSpot(doc));
  assert.equal(moves, 0);
  assert.deepEqual(extra.children.map((k) => k.className), ['xx-row', 'tr-bar']);

  // A container outside the result card is ignored; the Scenario result floats on the body.
  const lone = new El('', [new El('ux-result-extra'), new El('al-mr-stage')]);
  lone.body = lone;
  assert.equal(core.resultSpot(lone).kind, 'moment');
  assert.equal(core.resultSpot(lone).parent, lone);
  assert.equal(core.resultSpot(new El('')), null);
});

test('compact strip: same markup and state at every window size; CSS keeps every button', () => {
  const store = core.addCompletion(core.readStore(null), { ...core.start(core.resolve(fakeRoutine, fakeList, variants), 0), results: [core.summarize(rec(EASY))] }, Date.now());
  const list = [core.resolve(fakeRoutine, fakeList, variants)];
  const paused = core.pause(core.start(list[0], 1));
  const render = () => [null, paused].map((run) => {
    const model = core.stripModel(list, run, store, Date.now(), null);
    return JSON.stringify(model) + core.stripHtml(model);
  });
  const g = globalThis;
  const saved = { innerHeight: g.innerHeight, innerWidth: g.innerWidth, matchMedia: g.matchMedia };
  try {
    Object.assign(g, { innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: true }) });
    const small = render();
    Object.assign(g, { innerWidth: 1920, innerHeight: 1080, matchMedia: () => ({ matches: false }) });
    assert.deepEqual(render(), small);
  } finally { Object.assign(g, saved); }
  // Last done moves into the card title (every layout), with the drill list.
  const html = core.stripHtml(core.stripModel(list, null, store, Date.now(), null));
  assert.match(html, /<article class="tr-card" data-routine="r" title="Twin drill, Other drill, Clock drill\nLast done: Today">/);
  assert.match(html, /<span class="tr-meta-n">3 drills<\/span><span class="tr-meta-min"> · ~4 min<\/span>/);
  // The compact block only hides text, never a button or the resume row's actions.
  const css = fs.readFileSync(path.join(root, 'app', 'training-routines.css'), 'utf-8');
  const at = css.indexOf('@media (max-height: 800px) {');
  assert.ok(at > 0);
  const block = css.slice(at, css.indexOf('/* ---------- summary', at)).replace(/@media[^{]*{/g, '');
  for (const m of block.matchAll(/([^{}]+)\{[^}]*display:\s*none/g)) {
    for (const sel of m[1].split(',').map((x) => x.trim())) {
      assert.ok(['.tr-strip-head p', '.tr-blurb', '.tr-drills', '.tr-last', '.tr-strip.has-run .tr-cards', '.tr-meta-min'].includes(sel), 'hidden in compact: ' + sel);
    }
  }
});
