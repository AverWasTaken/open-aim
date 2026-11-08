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
  assert.match(html, /<article class="tr-card" data-routine="r" title="Fake\nTwin drill, Other drill, Clock drill\nLast done: Today">/);
  assert.match(html, /<span class="tr-meta-n">3 drills<\/span><span class="tr-meta-min"> · ~4 min<\/span>/);
  // The compact block only hides text, never a button or the resume row's actions.
  const css = fs.readFileSync(path.join(root, 'app', 'training-routines.css'), 'utf-8');
  const at = css.indexOf('@media (max-height: 800px) {');
  assert.ok(at > 0);
  const block = css.slice(at, css.indexOf('/* ---------- summary', at)).replace(/@media[^{]*{/g, '');
  for (const m of block.matchAll(/([^{}]+)\{[^}]*display:\s*none/g)) {
    for (const sel of m[1].split(',').map((x) => x.trim())) {
      assert.ok(['.tr-strip-head p', '.tr-blurb', '.tr-drills', '.tr-last', '.tr-strip.has-run .tr-rows', '.tr-strip:has(.tr-chip) .tr-rows .tr-meta', '.tr-meta-min'].includes(sel), 'hidden in compact: ' + sel);
    }
  }
});

// ---------- I1: custom routines ----------
const A = OTHER, B = THIRD;
const C1 = 'c-abc123', C2 = 'c-def456';
const cstore = (routines, v = 1) => JSON.stringify({ v, routines });

test('custom store: tolerant parse, ids, caps, names, never throws', () => {
  for (const bad of [null, '', '{', '[]', 'null', '7', '"x"', '{"v":1}', '{"v":1,"routines":{}}', '{"routines":[]}', '{"v":"1","routines":[]}']) {
    assert.deepEqual(core.readCustom(bad), { v: 1, routines: [], readOnly: false }, String(bad));
  }
  const s = core.readCustom(cstore([
    null, 7, 'x', {},
    { id: 'bad id', name: 'x', codes: [A, B] },
    { id: 'C-UPPER', name: 'x', codes: [A, B] },
    { id: C1, name: '  Warm\u0000 up\u0007  ', codes: [A, 'nope', B, 12], createdAt: 5, updatedAt: 'x' },
    { id: C1, name: 'duplicate id', codes: [A, B] },
    { id: 'c-empty', name: 'no codes', codes: ['zz'] },
    { id: 'c-one', name: '', codes: [A] }, // one valid code is kept (2-10 is only enforced on save)
    { id: 'c-long', name: 'x'.repeat(50), codes: Array(14).fill(A) },
  ]));
  assert.equal(s.readOnly, false);
  assert.deepEqual(s.routines.map((r) => r.id), [C1, 'c-one', 'c-long']);
  assert.deepEqual(s.routines[0], { id: C1, name: 'Warm up', codes: [A, B], createdAt: 5, updatedAt: 0 });
  assert.equal(s.routines[1].name, 'My routine');
  assert.equal(s.routines[2].name.length, core.NAME_MAX);
  assert.equal(s.routines[2].codes.length, core.CUSTOM_MAX_DRILLS);
  // first 12 routines only
  const many = core.readCustom(cstore(Array.from({ length: 20 }, (_, i) => ({ id: 'c-' + i, name: 'R' + i, codes: [A, B] }))));
  assert.equal(many.routines.length, core.CUSTOM_MAX);
  assert.equal(many.routines[11].id, 'c-11');
  // a newer version's store: shown, but read-only (saves refused)
  const newer = core.readCustom(cstore([{ id: C1, name: 'x', codes: [A, B] }], 2));
  assert.equal(newer.readOnly, true);
  assert.equal(newer.routines.length, 1);
  assert.match(core.saveCustom(newer, { id: null, name: 'y', codes: [A, B] }, 1).error, /newer version/);
  assert.match(core.deleteCustom(newer, C1).error, /newer version/);
  // round trip
  const back = core.readCustom(core.writeCustom(s.routines));
  assert.deepEqual(back.routines, s.routines);
  assert.equal(JSON.parse(core.writeCustom(s.routines)).v, 1);
  assert.equal(core.CUSTOM_KEY, 'aim-training-routines-custom-v1');
});

test('custom routines resolve like built-ins; a routine with no drill left still gets a card', () => {
  const s = core.readCustom(cstore([{ id: C1, name: 'Mine', codes: [EASY, 'ffffffffffffffff', A] }, { id: C2, name: 'Gone', codes: ['eeeeeeeeeeeeeeee'] }]));
  const defs = core.customDefs(s);
  assert.deepEqual(defs[0], { id: C1, name: 'Mine', blurb: '', steps: [{ code: EASY, seconds: 60 }, { code: 'ffffffffffffffff', seconds: 60 }, { code: A, seconds: 60 }], custom: true });
  const warned = [];
  const r = core.resolveCustom(defs[0], fakeList, variants, (c, id) => warned.push([c, id]));
  assert.deepEqual(r.steps.map((x) => x.code), [HARD, A]); // twin -> its lobby card; missing skipped
  assert.deepEqual(warned, [['ffffffffffffffff', C1]]);
  assert.equal(r.custom, true);
  const gone = core.resolveCustom(defs[1], fakeList, variants);
  assert.deepEqual(gone, { id: C2, name: 'Gone', blurb: '', steps: [], custom: true });
  assert.equal(core.start(gone, 0), null, 'nothing to start');
});

test('default name: smallest unused "My routine N"', () => {
  const st = (...names) => ({ routines: names.map((name, i) => ({ id: 'c-' + i, name, codes: [A, B] })) });
  assert.equal(core.defaultName(st()), 'My routine 1');
  assert.equal(core.defaultName(st('My routine 1', 'my routine 3')), 'My routine 2');
  assert.equal(core.defaultName(st('My routine 2', 'Other')), 'My routine 1');
  assert.equal(core.newDraft(st('My routine 1'), null).name, 'My routine 2');
  // the routine being edited does not count: clearing its name keeps "My routine 1"
  const own = st('My routine 1');
  assert.equal(core.defaultName(own, 'c-0'), 'My routine 1');
  assert.equal(core.saveCustom({ ...own, readOnly: false }, { id: 'c-0', name: ' ', codes: [A, B] }, 5).store.routines[0].name, 'My routine 1');
});

test('editor model: add, move, remove, check, minutes', () => {
  let d = core.newDraft({ routines: [] }, null);
  assert.deepEqual(d, { id: null, name: 'My routine 1', codes: [] });
  assert.deepEqual(core.draftCheck(d, true), { ok: false, text: 'Add at least 2 drills.' });
  assert.equal(core.draftCheck(d, false).text, 'Drill list not loaded.');
  assert.equal(core.draftMinutes(d), 0);
  d = core.draftAdd(d, A);
  d = core.draftAdd(d, 'nope'); // not a code: unchanged
  d = core.draftAdd(d, B);
  d = core.draftAdd(d, A); // the same drill again is fine
  assert.deepEqual(d.codes, [A, B, A]);
  assert.equal(core.draftCheck(d, true).ok, true);
  assert.equal(core.draftMinutes(core.draftRemove(d, 2)), 3); // 2 x (60 s + 30 s overhead)
  assert.deepEqual(core.draftMove(d, 0, 1).codes, [B, A, A]);
  assert.deepEqual(core.draftMove(d, 2, -1).codes, [A, A, B]);
  assert.equal(core.draftMove(d, 0, -1), d, 'top stays');
  assert.equal(core.draftMove(d, 2, 1), d, 'bottom stays');
  assert.deepEqual(core.draftRemove(d, 1).codes, [A, A]);
  assert.equal(core.draftRemove(d, 9), d);
  for (let i = 0; i < 20; i++) d = core.draftAdd(d, B);
  assert.equal(d.codes.length, core.CUSTOM_MAX_DRILLS, 'capped at 10');
  assert.equal(core.draftCheck(d, true).ok, true);
  assert.equal(core.draftCheck({ codes: Array(11).fill(A) }, true).text, '10 drills max.');
});

test('save and delete: new id, edit in place, caps, default name', () => {
  let s = core.readCustom(null);
  assert.match(core.saveCustom(s, { id: null, name: 'x', codes: [A] }, 1).error, /at least 2/);
  const res = core.saveCustom(s, { id: null, name: '   ', codes: [A, B] }, 1700000000000);
  assert.equal(res.id, 'c-' + (1700000000000).toString(36));
  assert.ok(/^c-[0-9a-z]+$/.test(res.id));
  s = res.store;
  assert.deepEqual(s.routines[0], { id: res.id, name: 'My routine 1', codes: [A, B], createdAt: 1700000000000, updatedAt: 1700000000000 });
  // same millisecond: still a unique id
  const twin = core.saveCustom(s, { id: null, name: 'Two', codes: [B, A] }, 1700000000000);
  assert.notEqual(twin.id, res.id);
  s = twin.store;
  // edit keeps id, createdAt and the order of routines
  const ed = core.saveCustom(s, { id: res.id, name: 'Renamed\u0001', codes: [B, B, A] }, 1700000000500);
  assert.equal(ed.id, res.id);
  assert.deepEqual(ed.store.routines.map((r) => r.id), [res.id, twin.id]);
  assert.deepEqual(ed.store.routines[0], { id: res.id, name: 'Renamed', codes: [B, B, A], createdAt: 1700000000000, updatedAt: 1700000000500 });
  assert.equal(core.codesChanged(s, { id: res.id, codes: [B, B, A] }), true);
  assert.equal(core.codesChanged(s, { id: res.id, codes: [A, B] }), false);
  assert.equal(core.codesChanged(s, { id: null, codes: [A, B] }), false);
  // the stored copy reads back the same
  assert.deepEqual(core.readCustom(core.writeCustom(ed.store.routines)).routines, ed.store.routines);
  // 12 routines max (an edit still works at the cap)
  let full = core.readCustom(null);
  for (let i = 0; i < 12; i++) full = core.saveCustom(full, { id: null, name: 'R' + i, codes: [A, B] }, 1000 + i).store;
  assert.equal(full.routines.length, 12);
  assert.match(core.saveCustom(full, { id: null, name: 'R', codes: [A, B] }, 2000).error, /12 routines max/);
  assert.equal(core.saveCustom(full, { id: full.routines[3].id, name: 'R3b', codes: [A, B] }, 2000).store.routines[3].name, 'R3b');
  // delete
  const del = core.deleteCustom(ed.store, res.id);
  assert.deepEqual(del.store.routines.map((r) => r.id), [twin.id]);
});

test('runner with a custom routine: start, next, summary, completion under its id; repeats back to back', () => {
  const s = core.saveCustom(core.readCustom(null), { id: null, name: 'Mine', codes: [A, A, EASY] }, 50).store;
  const id = s.routines[0].id;
  const list = core.customDefs(s).map((d) => core.resolveCustom(d, fakeList, variants));
  let run = core.start(list[0], 100);
  assert.deepEqual([run.id, run.name, run.codes], [id, 'Mine', [A, A, HARD]]);
  run = core.onScene(run, A, variants);
  run = core.onResult(run, rec(A, { id: 'x1', type: 'basic', score: 10 }), variants);
  assert.equal(core.nextIndex(run), 1);
  run = core.advance(run, 200);
  assert.deepEqual([run.index, run.phase], [1, 'launching']);
  // the same drill again: step 2 counts its own result, step 1 keeps its own
  run = core.onScene(run, A, variants);
  assert.equal(run.phase, 'playing');
  run = core.onResult(run, rec(A, { id: 'x2', type: 'basic', score: 20 }), variants);
  assert.deepEqual(run.results.map((r) => r.id), ['x1', 'x2']);
  run = core.onScene(core.advance(run, 300), EASY, variants);
  run = core.onResult(run, rec(EASY, { id: 'x3', score: 30 }), variants);
  assert.equal(core.isDone(run), true);
  const sum = core.summary(run, [], variants);
  assert.deepEqual(sum.rows.map((r) => r.result.score), [10, 20, 30]);
  assert.equal(sum.complete, true);
  const done = core.addCompletion(core.readStore(null), run, 400);
  assert.equal(done.completions[0].id, id);
  assert.equal(core.lastDone(done, id, 400).label, 'Today');
  assert.equal(core.streak(done, id, 400), 1);
  // a reload restores it paused like a built-in
  assert.equal(core.restore(JSON.stringify(run)).id, id);
});

test('editing or deleting the routine of a paused run', () => {
  const run = core.pause(core.start(core.resolve({ id: C1, name: 'Old', steps: [{ code: A }, { code: B }] }, fakeList, variants), 0));
  // delete: that run ends (no summary), other runs stay
  assert.equal(core.runAfterDelete(run, C1), null);
  assert.equal(core.runAfterDelete(run, C2), run);
  assert.equal(core.runAfterDelete(null, C1), null);
  // changed drills end it; a rename keeps it (renamed); nothing changed: same object
  assert.equal(core.runAfterSave(run, C1, 'Old', true), null);
  const renamed = core.runAfterSave(run, C1, 'New', false);
  assert.deepEqual([renamed.name, renamed.phase, renamed.codes], ['New', 'paused', run.codes]);
  assert.equal(core.runAfterSave(run, C1, 'Old', false), run);
  assert.equal(core.runAfterSave(run, C2, 'x', true), run);
  // the shell clears the run with setRun directly, never endRoutine (which opens the summary)
  const src = fs.readFileSync(path.join(root, 'app', 'training-routines.js'), 'utf-8');
  const ed = src.slice(src.indexOf('function openEditor('), src.indexOf('// ---------- result bar ----------'));
  assert.ok(ed.length > 1000);
  assert.doesNotMatch(ed, /endRoutine\(/);
  assert.match(ed, /C\.runAfterDelete\(run, draft\.id\)/);
  assert.match(ed, /C\.runAfterSave\(run, res\.id, saved\.name, changed\)/);
  assert.match(ed, /Saving ends the paused run\./);
});

test('drill picker: lobby cards once, Studio slot out, text and code search, type labels', () => {
  const cat = [...fakeList, { shareCode: EASY, name: '简单-Twin drill', type: 'aim' }, { shareCode: core.RECORD_CODE, name: 'Recording', type: 'ball' }, { shareCode: 'dddddddddddddddd', name: 'Ball drill', type: 'ball' }, { shareCode: 'bad', name: 'x' }, null];
  const all = core.pickerItems(cat, variants, '');
  assert.deepEqual(all.map((x) => [x.code, x.name, x.type]), [
    [HARD, 'Twin drill', 'Pre-aim'], [OTHER, 'Other drill', 'Fundamentals'], [THIRD, 'Clock drill', 'Scenario'], ['dddddddddddddddd', 'Ball drill', 'Target drill'],
  ]);
  assert.deepEqual(core.pickerItems(cat, variants, '  CLOCK ').map((x) => x.code), [THIRD]);
  assert.deepEqual(core.pickerItems(cat, variants, OTHER).map((x) => x.code), [OTHER]);
  assert.deepEqual(core.pickerItems(cat, variants, EASY).map((x) => x.code), [HARD], 'a pasted twin code finds its card');
  assert.deepEqual(core.pickerItems(cat, variants, 'zzz'), []);
  assert.equal(core.pickerItems(null, variants, ''), null);
  assert.deepEqual(Object.values(core.TYPE_LABELS), ['Pre-aim', 'Angle holding', 'Anti-flash', 'Scenario', 'Fundamentals', 'Target drill']);
  assert.equal(core.typeLabel('nope'), '');
  // chosen rows keep drills that left the list, marked for removal
  const rows = core.draftRows({ codes: [EASY, 'eeeeeeeeeeeeeeee'] }, fakeList, variants);
  assert.deepEqual(rows.map((r) => [r.i, r.name, r.missing]), [[0, 'Twin drill', false], [1, 'Not in drill list', true]]);
});

test('strip: custom chips in one row after the built-ins, "+ New routine", caps and locks', () => {
  const builtin = core.resolve(fakeRoutine, fakeList, variants);
  const mk = (n) => core.readCustom(cstore(Array.from({ length: n }, (_, i) => ({ id: 'c-' + i, name: 'Mine <' + i + '>', codes: i === 1 ? ['eeeeeeeeeeeeeeee'] : [A, B] }))));
  const listOf = (s) => [builtin, ...core.customDefs(s).map((d) => core.resolveCustom(d, fakeList, variants))];
  const st = core.readStore(null);
  let s = mk(2);
  let model = core.stripModel(listOf(s), null, st, 0, null, { custom: s });
  assert.equal(model.cards.length, 1, 'built-in cards unchanged');
  assert.deepEqual(model.mine.map((c) => [c.id, c.name, c.custom, c.ok, c.codes]), [['c-0', 'Mine <0>', true, true, [A, B]], ['c-1', 'Mine <1>', true, false, ['eeeeeeeeeeeeeeee']]]);
  assert.deepEqual([model.add, model.edit, model.lock], [true, true, false]);
  let html = core.stripHtml(model);
  assert.match(html, /<div class="tr-rows" data-wheel-x><div class="tr-cards"><article class="tr-card" data-routine="r"[\s\S]*<\/article><\/div><div class="tr-custom" role="group" aria-label="Your routines" data-wheel-x>/);
  assert.match(html, /<article class="tr-chip" data-routine="c-0" title="Mine &lt;0&gt;\nOther drill, Clock drill\nLast done: Not done yet"><span class="tr-chip-name">Mine &lt;0&gt;<\/span><span class="tr-meta">2 drills<\/span><button type="button" class="tr-btn" data-act="start" data-routine="c-0" aria-label="Start Mine &lt;0&gt;">Start<\/button><button type="button" class="tr-btn is-ghost" data-act="edit" data-routine="c-0" aria-label="Edit Mine &lt;0&gt;">Edit<\/button><\/article>/);
  // no drill left: Edit stays, Start disabled
  assert.match(html, /<span class="tr-meta">No drills found<\/span><button type="button" class="tr-btn" data-act="start" data-routine="c-1" aria-label="Start Mine &lt;1&gt;" disabled>Start<\/button><button type="button" class="tr-btn is-ghost" data-act="edit" data-routine="c-1"[^>]*>Edit/);
  assert.match(html, /<button type="button" class="tr-btn tr-chip-new" data-act="new">\+ New routine<\/button><\/div><\/div>$/);
  // no custom routines yet: the row holds only "+ New routine"
  const none = core.stripHtml(core.stripModel([builtin], null, st, 0, null, { custom: core.readCustom(null) }));
  assert.match(none, /<div class="tr-custom" role="group" aria-label="Your routines" data-wheel-x><button type="button" class="tr-btn tr-chip-new" data-act="new">\+ New routine<\/button><\/div>/);
  // older callers without opts: still "+ New"
  assert.match(core.stripHtml(core.stripModel([builtin], null, st, 0, null)), /tr-chip-new/);
  // the strip redraws when stored codes change, even when they resolve the same
  const s2 = core.readCustom(cstore([{ id: 'c-0', name: 'Mine <0>', codes: [A, B] }, { id: 'c-1', name: 'Mine <1>', codes: ['eeeeeeeeeeeeeeee', 'ffffffffffffffff'] }]));
  assert.notEqual(JSON.stringify(core.stripModel(listOf(s2), null, st, 0, null, { custom: s2 })), JSON.stringify(model));
  // launching: Edit and New disabled
  const launching = core.start(builtin, 0);
  html = core.stripHtml(core.stripModel(listOf(s), launching, st, 0, null, { custom: s }));
  assert.match(html, /data-act="edit" data-routine="c-0" aria-label="Edit Mine &lt;0&gt;" disabled>/);
  assert.match(html, /data-act="new" disabled>/);
  html = core.stripHtml(core.stripModel(listOf(s), core.pause(launching), st, 0, null, { custom: s }));
  assert.doesNotMatch(html, /disabled>(Edit|\+ New)/);
  // 12 routines: no "+ New"
  s = mk(12);
  model = core.stripModel(listOf(s), null, st, 0, null, { custom: s });
  assert.equal(model.mine.length, 12);
  assert.equal(model.add, false);
  assert.doesNotMatch(core.stripHtml(model), /tr-chip-new/);
  // read-only store: Start only
  const ro = core.readCustom(cstore([{ id: 'c-0', name: 'x', codes: [A, B] }], 2));
  html = core.stripHtml(core.stripModel(listOf(ro), null, st, 0, null, { custom: ro }));
  assert.match(html, /data-act="start" data-routine="c-0"/);
  assert.doesNotMatch(html, /data-act="(edit|new)"/);
  // a finished custom routine shows last done / streak like a built-in
  const doneStore = core.addCompletion(st, { id: 'c-0', startedAt: 1, results: [] }, Date.now());
  assert.match(core.stripHtml(core.stripModel(listOf(mk(1)), null, doneStore, Date.now(), null, { custom: mk(1) })), /title="Mine &lt;0&gt;\nOther drill, Clock drill\nLast done: Today"/);
});

test('chip rows: wheel goes sideways only while the row can move; smooth-scroll leaves it alone', () => {
  const src = fs.readFileSync(path.join(root, 'app', 'training-routines.js'), 'utf-8');
  assert.match(src, /strip\.addEventListener\("wheel", onStripWheel, \{ passive: false \}\)/);
  const smooth = fs.readFileSync(path.join(root, 'app', 'smooth-scroll.js'), 'utf-8');
  const at = smooth.indexOf('[data-wheel-x]');
  assert.ok(at > 0 && at < smooth.indexOf('e.preventDefault()'), 'smooth-scroll skips movable chip rows before it takes the wheel');
  const css = fs.readFileSync(path.join(root, 'app', 'training-routines.css'), 'utf-8');
  assert.match(css, /\.tr-custom \{[^}]*overflow-x: auto/);
  assert.match(css, /\.tr-rows \{[^}]*overflow-x: auto/);
  assert.match(css, /\.tr-chip \{[^}]*min-width: 170px/);
});
