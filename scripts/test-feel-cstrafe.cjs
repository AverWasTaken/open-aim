// Stop to shot (counter-strafe timing) in app/shooting-error.js: the per-frame hook
// (window.__aimTick) sees the movement error fall back to "still", and the first still shot
// after that records how long after becoming accurate it was fired. The file runs in a vm with
// a bare window/document; frames and shots are fed the way the game's frame loop does it
// (each frame's state first, then that frame's shots). Real-sim timing: test-feel-cstrafe-sim.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'shooting-error.js'), 'utf-8');
const MS = 1000 / 128;

function load({ start = true } = {}) {
  const listeners = {};
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; }, innerHeight: 1000, devicePixelRatio: 1 };
  const document = { querySelector: () => null, querySelectorAll: () => [], hidden: false, body: { appendChild() {} } };
  const ctx = {
    window, document, console,
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => 0 },
    setInterval: () => 0, setTimeout: () => 0, requestAnimationFrame: () => 0,
  };
  vm.runInNewContext(src, ctx);
  const phase = (p, previous) => listeners['aim-round-phase']({ detail: { phase: p, previous, mapId: 'range' } });
  if (start) phase('running', 'idle');
  return {
    phase,
    window,
    frame: (tick, meDeg) => window.__aimTick({ tick, player: { position: { x: 0, y: 0, z: 0 }, ...(meDeg === undefined ? {} : { meDeg }) } }),
    shot: (tick, moveDeg) => window.__aimShot({ tick, spreadDeg: 0.25 + moveDeg, firingDeg: 0.25, moveDeg }),
    stops: () => JSON.parse(JSON.stringify(window.__aimShotGraph.stops())),
  };
}

// Plays ticks [from, to): me(t) = movement error at tick t; shots = ticks to fire on. A frame
// every `step` ticks: the frame's state (tick = frame tick), then the shots of the ticks it covers.
function play(app, { from = 0, to, step = 2, me, shots = [], frameMe = me }) {
  let pending = [];
  for (let t = from; t < to; t++) {
    if (shots.includes(t)) pending.push(t);
    if ((t - from) % step === step - 1 || t === to - 1) {
      app.frame(t, frameMe(t));
      for (const s of pending) app.shot(s, me(s));
      pending = [];
    }
  }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ±${tol}`);

test('accessor is truthy and read-only, empty before anything happens', () => {
  const app = load();
  assert.ok(app.window.__aimShotGraph);
  assert.deepEqual(app.stops(), []);
});

test('move, stop, shoot 150 ms after being accurate: one entry of about 150 ms', () => {
  for (const step of [2, 3, 1]) {
    const app = load();
    const accurate = 199; // first tick with no movement error
    const shot = accurate + Math.round(150 / MS);
    play(app, { to: 400, step, me: (t) => (t < 64 ? 0 : t < accurate ? 2.5 : 0), shots: [shot] });
    const s = app.stops();
    assert.equal(s.length, 1, `step ${step}`);
    assert.equal(s[0].early, false);
    near(s[0].ms, (shot - accurate) * MS, (step / 2) * MS + 1, `step ${step}`);
  }
});

test('a spray after a stop adds one entry, not one per bullet', () => {
  const app = load();
  const shots = [];
  for (let t = 215; t < 300; t += 12) shots.push(t);
  play(app, { to: 400, me: (t) => (t < 64 ? 0 : t < 200 ? 2.5 : 0), shots });
  const s = app.stops();
  assert.equal(s.length, 1);
  near(s[0].ms, 15 * MS, MS + 1);
});

test('standing more than 500 ms before the shot, or never moving: no entry', () => {
  let app = load();
  play(app, { to: 400, me: (t) => (t < 64 ? 0 : t < 200 ? 2.5 : 0), shots: [200 + 70] });
  assert.deepEqual(app.stops(), []);
  app = load();
  play(app, { to: 400, me: () => 0, shots: [100, 150, 300] });
  assert.deepEqual(app.stops(), []);
});

test('moving shots never make a stop-to-shot entry on their own', () => {
  const app = load();
  play(app, { to: 400, me: (t) => (t < 64 ? 0 : 2.5), shots: [100, 150, 300] });
  assert.deepEqual(app.stops(), []);
});

test('a moving shot within 200 ms before becoming accurate is early (negative), once', () => {
  // shot from an earlier frame
  let app = load();
  play(app, { to: 400, me: (t) => (t < 64 ? 0 : t < 200 ? 2.5 : 0), shots: [190, 230] });
  let s = app.stops();
  assert.equal(s.length, 1, 'early only; the still shot after it adds nothing');
  assert.equal(s[0].early, true);
  assert.ok(s[0].ms < 0 && s[0].ms > -30 * MS, `ms ${s[0].ms}`);
  // shot from the same frame as the stop (that frame's state is handled before its shots)
  app = load();
  play(app, { to: 400, step: 4, me: (t) => (t < 64 ? 0 : t < 201 ? 2.5 : 0), shots: [200] });
  s = app.stops();
  assert.equal(s.length, 1);
  assert.equal(s[0].early, true);
  assert.ok(s[0].ms <= 0);
  // more than 200 ms before the stop: not early
  app = load();
  play(app, { to: 400, me: (t) => (t < 64 ? 0 : t < 200 ? 2.5 : 0), shots: [150] });
  assert.deepEqual(app.stops(), []);
});

test('still shot in the same frame as moving again still counts', () => {
  const app = load();
  // accurate at 200, moving again from 210; frames every 4 ticks, so the still shot at 209
  // arrives after the frame (tick 211) that already shows movement again
  play(app, { to: 400, step: 4, me: (t) => (t < 64 ? 0 : t < 200 ? 2.5 : t < 210 ? 0 : 2.5), shots: [209] });
  const s = app.stops();
  assert.equal(s.length, 1);
  assert.equal(s[0].early, false);
  near(s[0].ms, 9 * MS, 2 * MS + 1);
});

test('sim restart (tick goes back) forgets the last stop', () => {
  const app = load();
  play(app, { from: 0, to: 1000, me: (t) => (t < 900 ? 2.5 : 0) });
  play(app, { from: 10, to: 60, me: () => 0, shots: [20] }); // restart: tick 11 < 999
  assert.deepEqual(app.stops(), []);
  // and a fresh stop after the restart works
  play(app, { from: 60, to: 300, me: (t) => (t < 150 ? 2.5 : 0), shots: [170] });
  assert.equal(app.stops().length, 1);
});

test('a long gap between frames (hitch) gives no entry', () => {
  const app = load();
  play(app, { to: 200, me: () => 2.5 });
  app.frame(240, 0); // 41 ticks since the last moving frame
  app.shot(240, 0);
  assert.deepEqual(app.stops(), []);
});

test('pause: frames with the same tick change nothing', () => {
  const app = load();
  play(app, { to: 201, me: (t) => (t < 200 ? 2.5 : 0) });
  for (let i = 0; i < 100; i++) app.frame(200, 0); // paused on the stop frame
  play(app, { from: 201, to: 260, me: () => 0, shots: [210] });
  const s = app.stops();
  assert.equal(s.length, 1);
  near(s[0].ms, 10.5 * MS, MS + 1);
});

test('no movement error in the state: nothing recorded', () => {
  const app = load();
  play(app, { to: 400, me: (t) => (t < 200 ? 2.5 : 0), frameMe: () => undefined, shots: [215] });
  assert.deepEqual(app.stops(), []);
});

test('no round running: nothing recorded; a new round starts empty', () => {
  const app = load({ start: false });
  play(app, { to: 400, me: (t) => (t < 200 ? 2.5 : 0), shots: [215] });
  assert.deepEqual(app.stops(), []);
  app.phase('running', 'idle');
  play(app, { from: 400, to: 700, me: (t) => (t < 500 ? 2.5 : 0), shots: [515] });
  assert.equal(app.stops().length, 1);
  app.phase('result', 'running');
  app.phase('idle', 'result');
  app.phase('running', 'idle'); // Play again
  assert.deepEqual(app.stops(), []);
});

test('a moving shot from a stop frame, after that stop was used, is not early for the next stop', () => {
  const app = load();
  // moving shot at 190 makes stop 1 (frame 203) early; the moving shot at 200 in that same frame
  // must not count as early again for stop 2 (moving 204-210, still from 211)
  play(app, { to: 300, step: 4, me: (t) => (t < 64 ? 0 : t < 201 ? 2.5 : t < 204 ? 0 : t < 211 ? 2.5 : 0), frameMe: (t) => (t < 64 ? 0 : t < 201 ? 2.5 : t < 204 ? 0 : t < 211 ? 2.5 : 0), shots: [190, 200] });
  const s = app.stops();
  assert.equal(s.filter((e) => e.early).length, 1, JSON.stringify(s));
});

test('summary line text', () => {
  const app = load();
  const line = (stops, compact) => app.window.__aimShotGraph.stopLine(stops, compact);
  const text = (html) => html.replace(/<small>.*<\/small>/, '').replace(/<[^>]+>/g, '');
  assert.equal(line([]), '');
  assert.equal(text(line([{ ms: 80, early: false }])), 'Stop to shot: median +80 ms · 1 shot');
  assert.equal(text(line([{ ms: 80, early: false }, { ms: 120, early: false }, { ms: -30, early: true }])), 'Stop to shot: median +100 ms · 2 shots · 1 early');
  assert.equal(text(line([{ ms: 200, early: false }, { ms: 50, early: false }, { ms: 90, early: false }])), 'Stop to shot: median +90 ms · 3 shots');
  assert.equal(text(line([{ ms: -10, early: true }, { ms: 0, early: true }])), 'Stop to shot: 2 early');
  assert.match(line([{ ms: 80, early: false }]), /<small>Time from being accurate again to the shot, after moving\. Early = fired before you were accurate\.<\/small>/);
  assert.doesNotMatch(line([{ ms: 80, early: false }], true), /<small>/, 'no hint in the scenario layout');
  assert.doesNotMatch(line([{ ms: 80, early: false }]), /—/, 'no em dash');
});
