// Checks for the Sensitivity tools math in app/player-tools.js (window.__aimTools.sensMath):
// game conversions both ways, the non-linear Minecraft and slider-based R6 mappings, DPI swap,
// cm/360, zoomed rows and the trainer's range check. The file is run in a vm with a bare window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'player-tools.js'), 'utf-8');
const window = {};
vm.runInNewContext(src, { window });
const m = window.__aimTools.sensMath;
const R6 = { r6unit: 0.02 };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ±${tol}`);
const game = (id) => m.GAMES.find((g) => g.id === id);

test('every game has the fields the panel needs', () => {
  const ids = Array.from(m.GAMES, (g) => g.id); // main-realm array for deepEqual
  assert.deepEqual(ids, ['valorant', 'cs2', 'apex', 'deadlock', 'quake', 'ow2', 'cod', 'destiny2', 'fortnite', 'r6', 'minecraft', 'marvel']);
  for (const g of m.GAMES) {
    assert.equal(typeof g.name, 'string', g.id);
    assert.equal(typeof g.unitLabel, 'string', g.id);
    assert.ok(Number.isInteger(g.decimals) && g.decimals >= 0 && g.decimals <= 3, g.id);
    assert.equal(typeof g.toDeg, 'function', g.id);
    assert.equal(typeof g.fromDeg, 'function', g.id);
  }
  assert.equal(game('r6').decimals, 0);
  assert.equal(game('minecraft').decimals, 0);
  assert.equal(game('fortnite').decimals, 1);
  assert.equal(game('ow2').decimals, 2);
  assert.equal(game('cs2').decimals, 3);
  assert.ok(game('marvel').approx);
  assert.match(game('marvel').name, /\(approx\.\)/);
});

test('yaw values', () => {
  const yaw = { valorant: 0.07, cs2: 0.022, apex: 0.022, deadlock: 0.022, quake: 0.022, ow2: 0.0066, cod: 0.0066, destiny2: 0.0066, marvel: 0.0175 };
  for (const [id, y] of Object.entries(yaw)) near(game(id).toDeg(1), y, 1e-12, id);
  near(game('fortnite').toDeg(1), 0.07 / 12.6, 1e-12, 'fortnite');
});

test('every game round-trips through VALORANT', () => {
  for (const g of m.GAMES) {
    for (const val of [0.2, 0.314, 0.4, 0.55, 0.9]) {
      const other = m.fromVal(g.id, val, R6);
      assert.ok(Number.isFinite(other), `${g.id} ${val}`);
      near(m.toVal(g.id, other, R6), val, 1e-9, `${g.id} ${val}`);
    }
  }
});

test('VALORANT 0.4 <-> CS2 1.2727', () => {
  near(m.fromVal('cs2', 0.4), 1.2727, 0.0001);
  near(m.toVal('cs2', 1.2727), 0.4, 0.0001);
  near(m.toVal('valorant', 0.4), 0.4, 1e-12);
});

test('Fortnite 5.04 % <-> VALORANT 0.4', () => {
  near(m.toVal('fortnite', 5.04), 0.4, 1e-9);
  near(m.fromVal('fortnite', 0.4), 5.04, 1e-9);
});

test('Rainbow Six Siege slider with the multiplier unit', () => {
  // slider 50 at unit 0.02 = multiplier 1.0 = 0.2864789 deg/count
  near(game('r6').toDeg(50, R6), 0.2864789, 1e-6);
  near(m.toVal('r6', 50, R6), 0.2864789 / 0.07, 1e-6);
  near(m.fromVal('r6', 0.4, R6), 0.028 / (0.02 * 0.2864789), 1e-4);
  // half the unit -> twice the slider for the same feel
  near(m.fromVal('r6', 0.4, { r6unit: 0.01 }), 2 * m.fromVal('r6', 0.4, R6), 1e-9);
  near(m.toVal('r6', 20, { r6unit: 0.005 }), m.toVal('r6', 5, R6), 1e-12);
  // a missing or bad unit gives no answer
  for (const x of [undefined, {}, { r6unit: 0 }, { r6unit: -1 }, { r6unit: NaN }]) {
    assert.ok(Number.isNaN(m.toVal('r6', 10, x)), JSON.stringify(x));
    assert.ok(Number.isNaN(m.fromVal('r6', 0.4, x)), JSON.stringify(x));
  }
});

test('Minecraft: 100 % = 0.15 deg/count, edges and out of range', () => {
  const mc = game('minecraft');
  near(mc.toDeg(100), 0.15, 1e-12);
  near(mc.fromDeg(0.15), 100, 1e-9);
  near(mc.toDeg(0), 0.0096, 1e-12);
  near(mc.toDeg(200), 0.6144, 1e-12);
  near(mc.fromDeg(0.0096), 0, 1e-9);
  near(mc.fromDeg(0.6144), 200, 1e-9);
  near(m.fromVal('minecraft', 0.15 / 0.07), 100, 1e-9);
  // VALORANT 0.4 = 0.028 deg/count -> s = (cbrt(0.028/1.2) - 0.2) / 0.6
  near(m.fromVal('minecraft', 0.4), ((Math.cbrt(0.028 / 1.2) - 0.2) / 0.6) * 200, 1e-9);
  for (const deg of [0.005, 0.0095, 0.62, 1]) assert.ok(Number.isNaN(mc.fromDeg(deg)), String(deg));
  assert.ok(Number.isNaN(m.fromVal('minecraft', 0.1))); // 0.007 deg/count, below 0 %
  assert.ok(Number.isNaN(m.fromVal('minecraft', 9))); // 0.63 deg/count, above 200 %
  for (const pct of [-1, 200.5, 250, NaN]) assert.ok(Number.isNaN(m.toVal('minecraft', pct)), String(pct));
});

test('Marvel Rivals (approx.) round-trip', () => {
  near(m.fromVal('marvel', 0.4), 1.6, 1e-9);
  near(m.toVal('marvel', 1.6), 0.4, 1e-9);
});

test('bad inputs give no answer', () => {
  for (const id of ['cs2', 'fortnite', 'ow2', 'marvel']) {
    for (const bad of [0, -1, NaN, Infinity]) {
      assert.ok(Number.isNaN(m.toVal(id, bad)), `${id} ${bad}`);
      assert.ok(Number.isNaN(m.fromVal(id, bad)), `${id} ${bad}`);
    }
  }
  assert.ok(Number.isNaN(m.cm360(0, 800)));
  assert.ok(Number.isNaN(m.cm360(0.4, 0)));
  assert.ok(Number.isNaN(m.dpiSwap(0.4, 800, 0)));
  assert.ok(Number.isNaN(m.dpiSwap(0.4, NaN, 1600)));
});

test('DPI 800 -> 1600 halves the sensitivity and keeps cm/360', () => {
  near(m.dpiSwap(0.4, 800, 1600), 0.2, 1e-12);
  near(m.dpiSwap(0.4, 1600, 400), 1.6, 1e-12);
  near(m.cm360(m.dpiSwap(0.4, 800, 1600), 1600), m.cm360(0.4, 800), 1e-9);
});

test('cm/360: VALORANT 0.4 at 800 DPI = 40.82 cm', () => {
  near(m.cm360(0.4, 800), 40.82, 0.005);
});

test('zoom rows: multipliers, cm/360 and the 0 % match column', () => {
  const want = { 1.15: 0.908, 1.25: 0.870, 1.5: 0.815, 2.5: 0.747, 3.5: 0.731, 5: 0.723 };
  const rows = m.zoomRows(0.4, 800, 0.8, 1.2);
  assert.deepEqual(Array.from(rows, (r) => r.zoom), [1.15, 1.25, 1.5, 2.5, 3.5, 5]);
  assert.deepEqual(Array.from(rows, (r) => r.kind), ['ads', 'ads', 'ads', 'scoped', 'scoped', 'scoped']);
  for (const r of rows) {
    near(r.match0, want[r.zoom], 0.0015, `match0 ${r.zoom}`);
    const mult = r.kind === 'ads' ? 0.8 : 1.2;
    assert.equal(r.mult, mult);
    near(r.degPerCount, (0.07 * 0.4 * mult) / r.zoom, 1e-12, `deg ${r.zoom}`);
    near(r.cm360, (360 / (r.degPerCount * 800)) * 2.54, 1e-9, `cm ${r.zoom}`);
  }
  // multiplier 1 at 2.5x: 2.5x the hipfire cm/360
  near(m.zoomRows(0.4, 800)[3].cm360, 2.5 * m.cm360(0.4, 800), 1e-9);
  assert.ok(Number.isNaN(m.zoomRows(NaN, 800)[0].cm360));
});

test('trainer range check (0.001 to 10)', () => {
  assert.equal(m.TRAINER_MIN, 0.001);
  assert.equal(m.TRAINER_MAX, 10);
  for (const v of [0.001, 0.4, 10]) assert.ok(m.inTrainerRange(v), String(v));
  for (const v of [0, 0.0009, 10.001, 12, -1, NaN, Infinity]) assert.ok(!m.inTrainerRange(v), String(v));
});
