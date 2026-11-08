// Checks for Find my sens (app/feel-sens-finder-core.js): the 6-run plan, the suggestion rule
// (Clear / Lean / no difference, warm-up, runs that didn't count, not enough runs), the drill codes,
// and the runner driven by a fake page (fake clock, sens field, drill launch and storage).
// Also checks main.js / package.json list the files. Node only, no app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const C = require(path.join(APP, 'feel-sens-finder-core.js'));

// ---------- plan ----------
test('plan is B X Y Y X B with 0.8x / 1.25x, order flipped by the RNG', () => {
  const lowFirst = C.makePlan(0.4, () => 0.1);
  assert.deepEqual(lowFirst.map((s) => s.level), ['base', 'low', 'high', 'high', 'low', 'base']);
  assert.deepEqual(lowFirst.map((s) => s.sens), [0.4, 0.32, 0.5, 0.5, 0.32, 0.4]);
  const highFirst = C.makePlan(0.4, () => 0.9);
  assert.deepEqual(highFirst.map((s) => s.level), ['base', 'high', 'low', 'low', 'high', 'base']);
  assert.ok(C.planOk(lowFirst) && C.planOk(highFirst));
});

test('plan rounds to 3 decimals and clamps to 0.001-10', () => {
  const p = C.makePlan(0.437, () => 0);
  assert.deepEqual(p.map((s) => s.sens), [0.437, 0.35, 0.546, 0.546, 0.35, 0.437]); // 0.3496, 0.54625
  assert.equal(C.planOk(C.makePlan(10, () => 0)), false); // high clamps to 10 = base
  assert.equal(C.planOk(C.makePlan(0.001, () => 0)), false); // low clamps to 0.001 = base
  assert.equal(C.makePlan(9, () => 0)[2].sens, 10);
  assert.ok(C.planOk(C.makePlan(9, () => 0)));
  assert.ok(C.planOk(C.makePlan(0.005, () => 0)));
});

// ---------- suggestion ----------
const PLAN = C.makePlan(0.4, () => 0.1); // B L H H L B: 0.4 0.32 0.5 0.5 0.32 0.4
const res = (score, extra = {}) => ({ score, accuracy: 80, valid: true, why: '', ...extra });
const bad = (score, why = 'ended early') => ({ score, accuracy: 50, valid: false, why });
const runs = (b1, l1, h1, h2, l2, b2) => [b1, l1, h1, h2, l2, b2].map((v) => (v && typeof v === 'object' ? v : v === null ? null : res(v)));

test('Clear: +4% and both runs beat both base runs', () => {
  const r = C.recommend(PLAN, runs(1000, 1070, 990, 1000, 1060, 1010));
  assert.equal(r.verdict, 'clear');
  assert.equal(r.pick, 0.32);
  assert.equal(r.gainPct, 6);
  assert.equal(r.lines[0], 'You scored 6% higher at 0.32 in both runs. Worth trying for a few days.');
  assert.ok(r.lines.includes("Your current sens has a head start because you're used to it."));
  assert.ok(r.lines.some((l) => /at the edge/.test(l)));
  assert.ok(r.lines.some((l) => /big turns feel hard at the new sens, go back up/.test(l)));
});

test('Lean: +4% mean but one run below a base run is only Lean', () => {
  const r = C.recommend(PLAN, runs(1000, 1150, 990, 1000, 1005, 1010)); // low mean 1077.5 = +7%, 1005 < 1010
  assert.equal(r.verdict, 'lean');
  assert.equal(r.pick, 0.32);
  assert.equal(r.lines[0], 'Slightly better at 0.32, but close. Keep 0.4 or try 0.32 for a few days.');
});

test('Lean: +2% to +4%', () => {
  const r = C.recommend(PLAN, runs(1000, 990, 1030, 1035, 980, 1000)); // high +3.25%
  assert.equal(r.verdict, 'lean');
  assert.equal(r.pick, 0.5);
  assert.ok(r.lines.some((l) => /small corrections feel shaky at the new sens, go back down/.test(l)));
});

test('No clear difference below +2%, no edge advice', () => {
  const r = C.recommend(PLAN, runs(1000, 1010, 990, 1005, 1012, 1000));
  assert.equal(r.verdict, 'none');
  assert.equal(r.pick, null);
  assert.equal(r.lines[0], 'No clear difference. Keep 0.4.');
  assert.ok(!r.lines.some((l) => /edge/.test(l)));
});

test('the bigger gain wins when both levels qualify; Clear beats a bigger Lean', () => {
  const both = C.recommend(PLAN, runs(1000, 1050, 1100, 1120, 1060, 1000));
  assert.equal(both.pick, 0.5);
  // low: Clear at +5%; high: +9% mean but one run under base = Lean -> Clear wins
  const mixed = C.recommend(PLAN, runs(1000, 1050, 1180, 990, 1050, 1000));
  assert.equal(mixed.verdict, 'clear');
  assert.equal(mixed.pick, 0.32);
});

test('ties go to no difference', () => {
  const r = C.recommend(PLAN, runs(1000, 1000, 1000, 1000, 1000, 1000));
  assert.equal(r.verdict, 'none');
});

test('warm-up warning when the last base run beats the first by more than 10%', () => {
  const r = C.recommend(PLAN, runs(900, 1000, 990, 1000, 1000, 1000));
  assert.ok(r.warm);
  assert.ok(r.lines.includes('You were still warming up, so results are less reliable.'));
  assert.ok(!C.recommend(PLAN, runs(950, 1000, 990, 1000, 1000, 1040)).warm); // +9.5%
});

test("runs that didn't count: warning, Clear needs both runs", () => {
  const r = C.recommend(PLAN, runs(1000, 1100, 990, 1000, bad(1200), 1000));
  assert.equal(r.invalid, 1);
  assert.equal(r.verdict, 'lean'); // only one valid low run
  assert.equal(r.pick, 0.32);
  assert.ok(r.lines.some((l) => /didn't count/.test(l)));
});

test('not enough runs: no valid base, or no other level', () => {
  const noBase = C.recommend(PLAN, runs(bad(1000), 1100, 1000, 1000, 1100, bad(1000, 'sens changed')));
  assert.equal(noBase.verdict, 'short');
  assert.equal(noBase.pick, null);
  assert.match(noBase.lines[0], /Not enough runs/);
  const onlyBase = C.recommend(PLAN, runs(1000, bad(1), bad(1), null, null, 1000));
  assert.equal(onlyBase.verdict, 'short');
  const zero = C.recommend(PLAN, runs(0, 100, 100, 100, 100, 0));
  assert.equal(zero.verdict, 'short');
});

// ---------- drills ----------
test('both drills exist in the training set, last 60 s and get no rank picker', () => {
  const ts = JSON.parse(fs.readFileSync(path.join(APP, 'training-set.json'), 'utf-8'));
  const { mergeVariants, shooterStats, docOf, parseName } = require(path.join(APP, 'drill-variants.js'));
  const botsOf = (it) => shooterStats(docOf(ts.scenes[it.shareCode] || {}) || {});
  const { variants } = mergeVariants(ts.items, botsOf);
  assert.deepEqual(C.DRILLS.map((d) => d.code), ['d355a344c819596d', 'ea9dd90bd251f6ba']);
  for (const d of C.DRILLS) {
    const item = ts.items.find((x) => x.shareCode === d.code);
    assert.ok(item, `${d.code} in items`);
    assert.equal(item.name, d.drill);
    assert.equal(parseName(item.name).label, null, 'no Easy/Hard twin');
    const scene = ts.scenes[d.code];
    assert.ok(scene, `${d.code} in scenes`);
    const doc = docOf(scene);
    assert.ok(doc, 'scene doc parses');
    const durations = [];
    (function walk(o) {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'duration') durations.push(v); walk(v); }
    })(doc);
    assert.ok(durations.includes(60), `${d.code} is 60 s (${durations})`);
    assert.equal(botsOf(item).length, 0, 'no bots that shoot back');
    assert.ok(!(d.code in variants), 'not a key of /aim/drill-variants.json');
  }
});

// ---------- shell wiring ----------
test('main.js injects core then page script; package.json ships both and the test', () => {
  const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf-8');
  assert.match(main, /\["feel-sens-finder-core\.js", "feel-sens-finder\.js"\]/);
  assert.match(main, /\["SENS FINDER", SENS_FINDER_JS\]/);
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf-8'));
  assert.ok(pkg.build.files.includes('feel-sens-finder-core.js'));
  assert.ok(pkg.build.files.includes('feel-sens-finder.js'));
  assert.equal(pkg.scripts['test:feelsensfinder'], 'node --test ../scripts/test-feel-sens-finder.cjs');
  for (const f of ['feel-sens-finder-core.js', 'feel-sens-finder.js']) {
    const src = fs.readFileSync(path.join(APP, f), 'utf-8');
    assert.ok(!src.includes('—'), `${f}: no em dashes`);
    assert.ok(!/\.focus\(/.test(src), `${f}: never calls focus()`);
    assert.ok(!/aria-modal/.test(src), `${f}: never aria-modal`);
  }
  const page = fs.readFileSync(path.join(APP, 'feel-sens-finder.js'), 'utf-8');
  const css = page.slice(page.indexOf('const CSS = `'), page.indexOf('`;', page.indexOf('const CSS = `')));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'CSS uses tokens, no raw hex');
});

// ---------- runner with a fake page ----------
function fakeEnv(opts = {}) {
  const e = {
    t: 1_000_000,
    timers: [],
    sens: opts.sens ?? 0.4, // al-sensitivity-v1
    field: true, // .hall-sens input present
    lobby: true,
    open: false,
    picker: false,
    round: false,
    routine: false,
    aids: false,
    launchOk: true,
    launched: [],
    left: 0,
    sets: [],
    run: opts.run ?? null,
    history: null,
    active: false,
    views: [],
    applyDelay: 0, // ms before the field's value reaches al-sensitivity-v1
  };
  let nextId = 1;
  const add = (fn, ms, repeat) => { const id = nextId++; e.timers.push({ id, at: e.t + ms, ms, fn, repeat }); return () => { e.timers = e.timers.filter((x) => x.id !== id); }; };
  e.env = {
    now: () => e.t,
    rand: () => 0.1,
    every: (fn, ms) => add(fn, ms, true),
    after: (fn, ms) => add(fn, ms, false),
    readSens: () => e.sens,
    setSens: (v) => {
      if (!e.field) return false;
      e.sets.push(v);
      if (e.applyDelay) add(() => { e.sens = v; }, e.applyDelay, false);
      else e.sens = v;
      return true;
    },
    lobbyReady: () => e.lobby && !e.open && e.field,
    drillOpen: () => e.open,
    pickerOpen: () => e.picker,
    roundOn: () => e.round,
    routineActive: () => e.routine,
    aidsOn: () => e.aids,
    launch: (code) => { if (!e.launchOk || e.open) return false; e.launched.push({ code, sens: e.sens }); return true; },
    leave: () => { if (!e.open) return false; e.left++; e.open = false; return true; },
    loadRun: () => e.run,
    saveRun: (j) => { e.run = j; },
    loadHistory: () => e.history,
    saveHistory: (j) => { e.history = j; },
    setActive: (on) => { e.active = on; },
    render: (v) => { e.views.push(v); },
  };
  // Advance the fake clock, firing timers in order.
  e.tick = (ms) => {
    const end = e.t + ms;
    for (;;) {
      const due = e.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      e.t = due.at;
      if (due.repeat) due.at += due.ms; else e.timers = e.timers.filter((x) => x.id !== due.id);
      due.fn();
    }
    e.t = end;
  };
  // The game opening the launched drill: loading layer, then aim-local-scene.
  e.openDrill = (r, code) => { e.open = true; r.onScene(code ?? e.launched[e.launched.length - 1].code); };
  e.result = (r, score, extra = {}) => r.onResult({ record: { shareCode: C.DRILLS[0].code, score, accuracy: 75, end: 'time', ...extra }, source: 'workshop', eligible: true });
  return e;
}
const CODE = C.DRILLS[0].code;
const saved = (e) => (e.run ? JSON.parse(e.run) : null);

test('full session: test sens set at launch, own sens back at each result, 6 runs, result saved', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.init();
  assert.deepEqual(r.start('click'), { ok: true });
  assert.equal(e.active, true);
  e.tick(100);
  assert.equal(e.launched.length, 1);
  assert.deepEqual(e.launched[0], { code: CODE, sens: 0.4 });
  const plan = r.session.plan.map((s) => s.sens);
  const scores = [1000, 1070, 990, 1000, 1060, 1010];
  for (let i = 0; i < 6; i++) {
    if (i > 0) {
      assert.equal(r.view().phase, 'between');
      assert.equal(e.sens, 0.4, 'own sens between runs');
      r.next();
      e.tick(100);
      assert.equal(e.launched.length, i + 1);
      assert.equal(e.launched[i].sens, plan[i], `run ${i + 1} launched at the test sens`);
      assert.equal(saved(e).appliedSens, plan[i], 'applied sens saved before launch');
    }
    e.openDrill(r);
    assert.equal(r.view().phase, 'playing');
    e.result(r, scores[i]);
    e.tick(300);
    assert.equal(e.sens, 0.4, `own sens back after run ${i + 1}`);
    assert.equal(saved(e).appliedSens, null);
  }
  assert.equal(r.view().phase, 'done');
  assert.equal(e.left, 5, 'Next run closed the open drill each time');
  r.finish();
  assert.equal(e.left, 6, 'See result closes the drill');
  const v = r.view();
  assert.equal(v.phase, 'result');
  assert.equal(v.result.verdict, 'clear');
  assert.equal(v.result.pick, 0.32);
  assert.equal(e.run, null, 'session cleared');
  assert.equal(e.active, false);
  const hist = C.parseHistory(e.history);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].pick, 0.32);
  assert.equal(hist[0].runs.length, 6);
  r.closeResult();
  assert.equal(r.view().phase, 'idle');
});

test('a duplicate result (R = Play again) is ignored until the next launch', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.result(r, 5000);
  assert.equal(r.session.step, 1);
  assert.equal(r.session.results[0].score, 1000);
  assert.equal(r.session.results[1], null);
  r.onScene(CODE); // a restart of the same drill between runs changes nothing
  assert.equal(r.view().phase, 'between');
});

test('results from another drill are ignored', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  r.onResult({ record: { shareCode: 'ffffffffffffffff', score: 1, end: 'time' } });
  assert.equal(r.session.step, 0);
  assert.equal(r.view().phase, 'playing');
});

test("a run that ended early or ran at a changed sens doesn't count", () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 900, { end: 'died' });
  assert.equal(r.session.results[0].valid, false);
  assert.equal(r.session.results[0].why, 'ended early');
  e.tick(300);
  r.next();
  e.tick(100);
  e.openDrill(r);
  e.sens = 0.9; // changed in the settings during the run
  e.result(r, 900);
  assert.equal(r.session.results[1].valid, false);
  assert.equal(r.session.results[1].why, 'sens changed');
});

test('leaving the drill without a result pauses the step and restores the sens', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  r.session; // playing at 0.4 (run 1 = base); use run 2 for a visible restore
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  e.openDrill(r);
  assert.equal(e.sens, 0.32);
  e.open = false; // Back to the lobby
  e.tick(300);
  assert.equal(r.view().phase, 'paused');
  assert.match(r.view().note, /Run 2 ended early/);
  assert.equal(e.sens, 0.4);
  r.resume();
  e.tick(100);
  assert.equal(e.launched.length, 3);
  assert.equal(e.launched[2].sens, 0.32, 'same step again');
});

test('sens changed outside the finder ends the session without restoring', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  e.sens = 0.7; // the player changed it in the lobby
  r.next();
  assert.equal(r.session, null);
  assert.equal(e.sens, 0.7);
  assert.match(r.view().note, /changed outside the finder/);
  assert.equal(e.run, null);
  assert.equal(e.active, false);
});

test('restore never fights a sens the player picked themselves', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  // the field takes a while to save: launch waits for it
  e.applyDelay = 1000;
  r.next();
  e.tick(500);
  assert.equal(e.launched.length, 1);
  e.tick(700);
  assert.equal(e.launched.length, 2);
  assert.equal(e.launched[1].sens, 0.32);
  e.applyDelay = 0;
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  assert.equal(e.sens, 0.4);
  // the field never saves: paused, nothing launched, own sens kept
  const set = e.env.setSens;
  e.env.setSens = () => true;
  r.next();
  e.tick(C.SET_WAIT_MS + 200);
  assert.equal(e.launched.length, 2);
  assert.equal(r.view().phase, 'paused');
  assert.match(r.view().note, /didn't take the test sens/);
  assert.equal(e.sens, 0.4);
  assert.equal(saved(e).appliedSens, null);
  e.env.setSens = set;
  r.resume();
  e.tick(100);
  e.openDrill(r);
  e.field = false; // field gone: restore has to wait
  e.result(r, 1000);
  e.tick(1000);
  assert.equal(saved(e).appliedSens, 0.5);
  e.sens = 0.6; // player sets their own value meanwhile
  e.field = true;
  e.tick(1000);
  assert.equal(e.sens, 0.6, 'left alone');
  assert.equal(saved(e).appliedSens, null);
});

test('startup restore: test sens still set after a crash -> own sens back, paused, never resumes', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  e.openDrill(r);
  assert.equal(e.sens, 0.32);
  const raw = e.run;
  // app restarts
  const e2 = fakeEnv({ sens: 0.32, run: raw });
  e2.field = false; // lobby not up yet
  const r2 = C.createRunner(e2.env);
  r2.init();
  assert.equal(r2.view().phase, 'paused');
  assert.equal(r2.view().note, 'Sens finder paused, 1 of 6 runs done.');
  assert.equal(e2.active, true);
  e2.tick(1000);
  assert.equal(e2.sens, 0.32, 'waits for the field');
  e2.field = true;
  e2.tick(300);
  assert.equal(e2.sens, 0.4);
  assert.equal(saved(e2).appliedSens, null);
  assert.equal(e2.launched.length, 0, 'no auto-resume');
  e2.tick(60000);
  assert.equal(e2.launched.length, 0);
  r2.resume();
  e2.tick(100);
  assert.equal(e2.launched.length, 1);
  assert.equal(e2.launched[0].sens, 0.32);
});

test('startup: a session older than 2 h is restored and dropped; garbage is dropped', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  const raw = e.run;
  const e2 = fakeEnv({ sens: 0.32, run: raw });
  e2.t += C.MAX_AGE_MS + 1;
  const r2 = C.createRunner(e2.env);
  r2.init();
  e2.tick(300);
  assert.equal(e2.sens, 0.4);
  assert.equal(e2.run, null);
  assert.equal(r2.session, null);
  const e3 = fakeEnv({ run: '{"v":1,"drill":"click"}' });
  const r3 = C.createRunner(e3.env);
  r3.init();
  assert.equal(r3.session, null);
  assert.equal(e3.run, null);
});

test('startup: sens no longer the test value -> left alone', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  const e2 = fakeEnv({ sens: 0.75, run: e.run });
  const r2 = C.createRunner(e2.env);
  r2.init();
  e2.tick(1000);
  assert.equal(e2.sens, 0.75);
  assert.deepEqual(e2.sets, []);
  assert.equal(saved(e2).appliedSens, null);
});

test('refuses to start: routine running, Round mode, drill open, not in lobby, already running, edge sens', () => {
  const cases = [
    ['routine', (e) => { e.routine = true; }, /routine/],
    ['round', (e) => { e.round = true; }, /Round mode/],
    ['open', (e) => { e.open = true; }, /lobby/],
    ['lobby', (e) => { e.lobby = false; }, /lobby/],
    ['edge', (e) => { e.sens = 10; }, /edge of the range/],
    ['nosens', (e) => { e.sens = NaN; }, /Couldn't read/],
  ];
  for (const [name, set, re] of cases) {
    const e = fakeEnv();
    set(e);
    const r = C.createRunner(e.env);
    const out = r.start('click');
    assert.equal(out.ok, false, name);
    assert.match(out.reason, re, name);
    assert.equal(e.launched.length, 0, name);
    assert.equal(e.run, null, name);
  }
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('track');
  assert.equal(r.start('click').ok, false);
  assert.equal(r.session.code, C.DRILLS[1].code);
});

test('aim aids note at start', () => {
  const e = fakeEnv();
  e.aids = true;
  const r = C.createRunner(e.env);
  r.start('click');
  assert.match(r.view().note, /Aim aids are on/);
});

test('launch timeout and a closed loading screen pause the step', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  assert.equal(r.view().phase, 'launching');
  e.tick(C.LAUNCH_WAIT_MS + 500);
  assert.equal(r.view().phase, 'paused');
  assert.equal(e.sens, 0.4);
  r.resume();
  e.tick(100);
  e.open = true; // loading screen, then closed before the scene
  e.tick(500);
  e.open = false;
  e.tick(500);
  assert.equal(r.view().phase, 'paused');
  assert.match(r.view().note, /closed before it started/);
  // launch refused by the game
  e.launchOk = false;
  r.resume();
  e.tick(100);
  assert.equal(r.view().phase, 'paused');
  assert.match(r.view().note, /Couldn't start the drill/);
});

test('a rank picker that is cancelled pauses after the grace time', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.picker = true;
  e.tick(20000);
  assert.equal(r.view().phase, 'launching', 'picker open: keeps waiting');
  e.picker = false;
  e.tick(C.PICKER_GRACE_MS + 500);
  assert.equal(r.view().phase, 'paused');
});

test('another drill coming up during a step pauses and restores', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  r.onScene('ffffffffffffffff');
  e.tick(300);
  assert.equal(r.view().phase, 'paused');
  assert.match(r.view().note, /Another drill/);
  assert.equal(e.sens, 0.4);
});

test('Next run when already in the lobby (leave() returns false) still launches', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  e.open = false; // player went back to the lobby with the game's Back
  r.next();
  e.tick(100);
  assert.equal(e.left, 0);
  assert.equal(e.launched.length, 2);
});

test('Next run waits for the lobby after leaving, then pauses if it never comes', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  e.env.leave = () => { e.lobby = false; e.open = false; return true; }; // lobby still inert
  r.next();
  e.tick(500);
  assert.equal(e.launched.length, 1);
  e.lobby = true;
  e.tick(200);
  assert.equal(e.launched.length, 2);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  e.lobby = false;
  r.next();
  e.tick(C.LOBBY_WAIT_MS + 500);
  assert.equal(r.view().phase, 'paused');
  assert.match(r.view().note, /back to the lobby/);
});

test('Stop: leaves the drill, restores the sens, clears the session', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  e.openDrill(r);
  assert.equal(e.sens, 0.32);
  r.stop();
  e.tick(300);
  assert.equal(e.open, false);
  assert.equal(e.sens, 0.4);
  assert.equal(r.session, null);
  assert.equal(e.run, null);
  assert.equal(e.active, false);
  assert.equal(e.history, null, 'stopped sessions are not saved');
});

test('routine started meanwhile: Next run pauses instead of launching', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  e.routine = true;
  r.next();
  e.tick(100);
  assert.equal(e.launched.length, 1);
  assert.equal(r.view().phase, 'paused');
});

test("the player's own sens is kept exact (not rounded), test sens are rounded", () => {
  const e = fakeEnv({ sens: 0.4567 });
  const r = C.createRunner(e.env);
  r.start('click');
  assert.equal(r.session.origSens, 0.4567);
  assert.deepEqual(r.session.plan.map((s) => s.sens), [0.4567, 0.365, 0.571, 0.571, 0.365, 0.4567]);
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  assert.equal(e.sens, 0.4567);
});

test('a result before the drill came up (still launching) is ignored', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  assert.equal(r.view().phase, 'launching');
  e.result(r, 1000);
  assert.equal(r.session.step, 0);
  assert.equal(r.view().phase, 'launching');
});

test('startup: a finished session older than 2 h still goes to history', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  for (let i = 0; i < 6; i++) {
    if (i) { r.next(); e.tick(100); }
    e.openDrill(r);
    e.result(r, [1000, 1070, 990, 1000, 1060, 1010][i]);
    e.tick(300);
  }
  assert.equal(r.view().phase, 'done');
  const e2 = fakeEnv({ run: e.run });
  e2.t += C.MAX_AGE_MS + 1;
  const r2 = C.createRunner(e2.env);
  r2.init();
  assert.equal(r2.session, null);
  assert.equal(e2.run, null);
  const h = C.parseHistory(e2.history);
  assert.equal(h.length, 1);
  assert.equal(h[0].verdict, 'clear');
});

test('startup: closed in the middle of Stop finishes the stop', () => {
  const e = fakeEnv();
  const r = C.createRunner(e.env);
  r.start('click');
  e.tick(100);
  e.openDrill(r);
  e.result(r, 1000);
  e.tick(300);
  r.next();
  e.tick(100);
  e.openDrill(r);
  e.field = false; // restore can't finish
  r.stop();
  assert.equal(saved(e).phase, 'stopping');
  const e2 = fakeEnv({ sens: 0.32, run: e.run });
  const r2 = C.createRunner(e2.env);
  r2.init();
  e2.tick(300);
  assert.equal(e2.sens, 0.4);
  assert.equal(r2.session, null);
  assert.equal(e2.run, null);
  assert.equal(e2.active, false);
});
