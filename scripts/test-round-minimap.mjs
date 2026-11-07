// Round mode minimap markers (R3 S4a): app/mods/aim-rounds/round-minimap.mjs (pure module, fake
// recording canvas), its wiring in round-visual.mjs, and the glue tools/round_minimap_patch.py puts
// into OkAdunfX.js (the patched small-map v(), big-map m() and redraw loop I() are cut out of the
// real bundle and run with stubs). Normal drills (window.__aimRoundMarks null) must draw exactly as
// the un-patched code does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MODS = path.join(root, 'app', 'mods');
const JS = [path.join(MODS, 'next', 'js'), path.join(MODS, '_assets', 'r20261021-1', 'next', 'js')];
const OKA = fs.readFileSync(path.join(JS[0], 'OkAdunfX.js'), 'utf-8').replace(/\r\n/g, '\n');
const mm = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-minimap.mjs')).href);
const { createRoundVisual } = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-visual.mjs')).href);
const { roundScene } = require(path.join(root, 'app', 'round-scene.js'));
const roundCfg = (code) => JSON.parse(roundScene(MODS, code).doc).rules.round;
const PAIRS = JSON.parse(execFileSync('python', ['-I', path.join(root, 'tools', 'round_minimap_patch.py'), '--print-pairs'], { encoding: 'utf-8' }))['OkAdunfX.js'];
const count = (s, sub) => s.split(sub).length - 1;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

// Recording 2D context: every method call and property set, in order.
function fakeCtx() {
  const log = [];
  return new Proxy({ log }, {
    get(t, k) {
      if (k === 'log') return log;
      if (k in t) return t[k];
      return (...a) => { log.push([k, ...a]); };
    },
    set(t, k, v) { log.push(['=' + String(k), v]); t[k] = v; return true; },
  });
}
const calls = (ctx, name) => ctx.log.filter((c) => c[0] === name);
const balanced = (ctx) => assert.equal(calls(ctx, 'save').length, calls(ctx, 'restore').length, 'save/restore balanced');

// ---------------------------------------------------------------- module
test('createRoundMarks: one letter per site at its centre (real Ascent round cfg)', () => {
  const cfg = roundCfg('round-ascent-attack-vandal-20');
  const m = mm.createRoundMarks(cfg);
  assert.deepEqual(m.letters.map((l) => l.t), cfg.sites.map((s) => s.id));
  for (const [i, s] of cfg.sites.entries()) { assert.equal(m.letters[i].x, s.center.x); assert.equal(m.letters[i].z, s.center.z); }
  assert.equal(m.spike, 0);
  assert.equal(mm.createRoundMarks(null).letters.length, 0);
  assert.equal(mm.createRoundMarks({ sites: [{ id: 'A' }, { id: 'B', center: { x: 1, z: NaN } }] }).letters.length, 0);
});

test('updateRoundMarks: planted both sides, dropped attack only, never botPlanting/carrier; rev bumps only on change', () => {
  const m = mm.createRoundMarks({ sites: [] });
  const r0 = m.rev;
  const P = { x: 10.04, y: 1, z: -3.01 };
  mm.updateRoundMarks(m, { side: 'defense', phase: 'live', botPlanting: true, spike: { carrier: null, dropped: null, planted: null } });
  assert.equal(m.spike, 0); assert.equal(m.rev, r0, 'botPlanting shows nothing');
  mm.updateRoundMarks(m, { side: 'defense', phase: 'live', spike: { carrier: null, dropped: { x: 4, y: 0, z: 5 }, planted: null } });
  assert.equal(m.spike, 0, 'defense never sees the dropped spike'); assert.equal(m.rev, r0);
  mm.updateRoundMarks(m, { side: 'attack', phase: 'live', spike: { carrier: null, dropped: { x: 4, y: 0, z: 5 }, planted: null } });
  assert.equal(m.spike, 2); assert.deepEqual([m.sx, m.sz], [4, 5]); assert.equal(m.pulse, false);
  const r1 = m.rev; assert.ok(r1 > r0);
  mm.updateRoundMarks(m, { side: 'attack', phase: 'live', spike: { carrier: null, dropped: { x: 4.01, y: 0, z: 5.02 }, planted: null } });
  assert.equal(m.rev, r1, 'sub-0.2 m wobble does not redraw');
  mm.updateRoundMarks(m, { side: 'attack', phase: 'live', spike: { carrier: 'player', dropped: null, planted: null } });
  assert.equal(m.spike, 0); assert.ok(m.rev > r1);
  for (const side of ['attack', 'defense']) {
    mm.updateRoundMarks(m, { side, phase: 'planted', spike: { carrier: null, dropped: null, planted: P } });
    assert.equal(m.spike, 1, side); assert.equal(m.pulse, true); near(m.sx, 10); near(m.sz, -3);
  }
  const r2 = m.rev;
  mm.updateRoundMarks(m, { side: 'defense', phase: 'planted', spike: { planted: P } });
  assert.equal(m.rev, r2, 'same frame again: no bump');
  mm.updateRoundMarks(m, { side: 'defense', phase: 'ended', reason: 'defused', spike: { planted: P } });
  assert.equal(m.spike, 1); assert.equal(m.pulse, false, 'no pulse after the round'); assert.equal(m.rev, r2 + 1);
  mm.updateRoundMarks(m, null); mm.updateRoundMarks(null, { spike: {} }); // no throw
});

test('roundMarksKey: "" without marks; |m<rev>; time step only while pulsing', () => {
  const prev = globalThis.__aimRoundMarks;
  try {
    globalThis.__aimRoundMarks = null;
    assert.equal(mm.roundMarksKey(1234), '');
    const m = mm.createRoundMarks({ sites: [{ id: 'A', center: { x: 0, z: 0 } }] });
    globalThis.__aimRoundMarks = m;
    assert.equal(mm.roundMarksKey(1000), `|m${m.rev}`);
    assert.equal(mm.roundMarksKey(1000), mm.roundMarksKey(5000), 'static marks: key stable over time');
    mm.updateRoundMarks(m, { side: 'attack', phase: 'planted', spike: { planted: { x: 1, y: 0, z: 1 } } });
    assert.equal(mm.roundMarksKey(1000), `|m${m.rev}:12`);
    assert.notEqual(mm.roundMarksKey(1000), mm.roundMarksKey(1080));
    assert.equal(mm.roundMarksKey(1000), mm.roundMarksKey(1039), '~12 Hz steps');
  } finally { globalThis.__aimRoundMarks = prev; }
});

test('drawMiniMarks: letters at mapped spots, outside ones skipped, spike pinned to the rim', () => {
  const R = 100, dpr = 2;
  const m = mm.createRoundMarks({ sites: [{ id: 'A', center: { x: 10, z: 0 } }, { id: 'B', center: { x: 500, z: 0 } }] });
  mm.updateRoundMarks(m, { side: 'attack', phase: 'planted', spike: { planted: { x: 0, y: 0, z: 400 } } });
  const map = (x, z) => [R + x, R + z];
  const ctx = fakeCtx();
  mm.drawMiniMarks(ctx, m, map, R, dpr, 250);
  const texts = calls(ctx, 'fillText');
  assert.deepEqual(texts.map((c) => c[1]), ['A'], 'B is outside the circle');
  assert.deepEqual(texts[0].slice(2), [R + 10, R]);
  const mv = calls(ctx, 'moveTo').at(-1); // diamond top: (x, y - r)
  const r = 4.5 * dpr, lim = R - 6 * dpr;
  near(mv[1], R, 'pinned x'); near(mv[2], R + lim - r, 'pinned y');
  assert.equal(calls(ctx, 'arc').length, 1, 'pulse ring while planted');
  balanced(ctx);
  // Inside the circle: drawn where it maps, no pin.
  mm.updateRoundMarks(m, { side: 'attack', phase: 'ended', spike: { planted: { x: -20, y: 0, z: 30 } } });
  const c2 = fakeCtx();
  mm.drawMiniMarks(c2, m, map, R, dpr, 0);
  const mv2 = calls(c2, 'moveTo').at(-1);
  near(mv2[1], R - 20, 'x'); near(mv2[2], R + 30 - r, 'y');
  assert.equal(calls(c2, 'arc').length, 0, 'no pulse after the round');
  assert.ok(c2.log.some((c) => c[0] === '=fillStyle' && c[1] === '#ff4655'), 'planted = accent red');
  // Dropped: amber, no ring.
  mm.updateRoundMarks(m, { side: 'attack', phase: 'live', spike: { dropped: { x: 0, y: 0, z: 0 } } });
  const c3 = fakeCtx();
  mm.drawMiniMarks(c3, m, map, R, dpr, 0);
  assert.ok(c3.log.some((c) => c[0] === '=fillStyle' && c[1] === '#ffd166'));
  assert.equal(calls(c3, 'arc').length, 0);
  // Nothing to draw: no ctx calls at all.
  const c4 = fakeCtx();
  mm.drawMiniMarks(c4, null, map, R, dpr);
  assert.equal(c4.log.length, 0);
});

test('drawBigMarks: badge above the site centre (clear of the callout label), spike at its spot', () => {
  const dpr = 1.5;
  const m = mm.createRoundMarks({ sites: [{ id: 'A', center: { x: 25, z: 50 } }] });
  mm.updateRoundMarks(m, { side: 'defense', phase: 'planted', spike: { planted: { x: 50, y: 0, z: 50 } } });
  const map = (x, z) => [x * 8, z * 8];
  const ctx = fakeCtx();
  mm.drawBigMarks(ctx, m, map, dpr, 500);
  const t = calls(ctx, 'fillText')[0];
  assert.equal(t[1], 'A'); near(t[2], 200, 'badge x'); assert.ok(t[3] < 400 - 15 * dpr, 'badge sits above the centre');
  const mv = calls(ctx, 'moveTo').at(-1);
  near(mv[1], 400, 'spike x'); near(mv[2], 400 - 7 * dpr, 'spike y');
  balanced(ctx);
});

test('round-visual sets __aimRoundMarks on create, feeds it on update, clears it on dispose', () => {
  class V3 { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { Object.assign(this, { x, y, z }); return this; } copy(o) { return this.set(o.x, o.y, o.z); } setScalar(s) { return this.set(s, s, s); } }
  class Obj { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.scale = new V3(); this.visible = true; } add(...c) { this.children.push(...c); } remove(c) { this.children = this.children.filter((x) => x !== c); } updateMatrixWorld() {} }
  class G { dispose() {} }
  const THREE = { Mesh: class extends Obj { constructor(g, mt) { super(); this.geometry = g; this.material = mt; } }, Group: Obj, PlaneGeometry: G, SphereGeometry: G, BoxGeometry: G, CylinderGeometry: G, MeshBasicMaterial: class extends G { constructor(o) { super(); Object.assign(this, o); } }, DoubleSide: 2 };
  const cfg = roundCfg('round-ascent-attack-vandal-20');
  const v = createRoundVisual(THREE, new Obj(), cfg);
  const m = globalThis.__aimRoundMarks;
  assert.ok(m && m.letters.length === cfg.sites.length);
  v.update({ side: 'defense', phase: 'planted', timeLeft: 30, spike: { carrier: null, dropped: null, planted: { x: 3, y: 1, z: 4 } } }, 1);
  assert.equal(globalThis.__aimRoundMarks, m, 'same object, no per-frame allocation');
  assert.equal(m.spike, 1); assert.deepEqual([m.sx, m.sz], [3, 4]);
  // A newer visual's marks are not cleared by an older one's dispose.
  const v2 = createRoundVisual(THREE, new Obj(), cfg);
  const m2 = globalThis.__aimRoundMarks;
  v.dispose();
  assert.equal(globalThis.__aimRoundMarks, m2);
  v2.dispose();
  assert.equal(globalThis.__aimRoundMarks, null);
});

// ---------------------------------------------------------------- bundle glue
const unpatch = (s) => { for (const [o, n] of PAIRS) s = s.split(n).join(o); return s; };
const slice = (src, from, to) => { const i = src.indexOf(from), j = src.indexOf(to, i); assert.ok(i >= 0 && j > i, `slice ${from}`); return src.slice(i, j); };
const SMALL = slice(OKA, 'function v(){const w=r.value', 'function f(w,O,U,k,L,D)');
const BIG = slice(OKA, 'function m(){const w=u.value', 'let A=null');
const LOOP = slice(OKA, 'function I(){', 'function P(){');

// Small map v(): Hn is the identity (map u/v = world x/z), scaleU = B = o0 = 1, so the mapper is
// N(x,z) = centre + rot(yaw) * ((x,z) - pose) * zoom * dpr.
function runSmall(src, { marks = null, showBots = false, rotates = true, yaw = Math.PI / 2, zoom = 2, dpr = 1.5, size = 200 } = {}) {
  const ctx = fakeCtx(), seen = [];
  const env = {
    r: { value: { getContext: () => ctx } }, o: { value: { src: 'map.png' } }, a: { value: { transform: { scaleU: 1 } } },
    t: { pose: { x: 5, z: 7, yaw }, rotates, soundRings: null, showBots, bots: showBots ? { alive: [], downs: [] } : null },
    i: { value: dpr }, n: { value: size }, s: { value: zoom }, d: () => 1, Hn: (U, x, z) => ({ u: x, v: z }), o0: 1,
    Cl: (U, y) => y, nr: () => {}, jl: () => 0, Zp: 1, p: () => {}, sr: () => 0,
    f: (...a) => seen.push(['bots', ...a]), window: { __aimRoundMarks: marks }, __aimMiniMarks: (...a) => seen.push(['marks', ...a]),
  };
  const fn = new Function(...Object.keys(env), `${src};return v();`);
  const ok = fn(...Object.values(env));
  return { ok, ctx, seen };
}

test('patched small map: overlay gets the bot mapper (rotated 90°, zoomed), before the bots; none without marks', () => {
  const marks = { letters: [], spike: 0 };
  const { ok, seen } = runSmall(SMALL, { marks, showBots: true });
  assert.equal(ok, true);
  assert.deepEqual(seen.map((s) => s[0]), ['marks', 'bots']);
  const [, ctx, m, N, R, D] = seen[0];
  assert.equal(m, marks); assert.equal(R, 150); assert.equal(D, 1.5); assert.equal(ctx.log, seen[1][1].log);
  assert.equal(N, seen[1][4], 'same mapper as the bots');
  // (x,z) = pose + (1, 0) world -> 3 px along +u; yaw 90° turns +u into +v (down).
  const [px, py] = N(6, 7);
  near(px, 150, 'rotated x'); near(py, 150 + 3, 'rotated y');
  const [qx, qy] = N(5, 8);
  near(qx, 150 - 3, 'rotated x2'); near(qy, 150, 'rotated y2');
  // Fixed (non-rotating) map, zoom 1.
  const fixed = runSmall(SMALL, { marks, rotates: false, zoom: 1 });
  assert.deepEqual(fixed.seen.map((s) => s[0]), ['marks']);
  const [fx, fy] = fixed.seen[0][3](6, 9);
  near(fx, 150 + 1.5, 'fixed x'); near(fy, 150 + 3, 'fixed y');
  // No marks: overlay never called; bots alone like before.
  assert.deepEqual(runSmall(SMALL, { marks: null, showBots: false }).seen, []);
  assert.deepEqual(runSmall(SMALL, { marks: null, showBots: true }).seen.map((s) => s[0]), ['bots']);
});

test('patched small/big map with no marks draw exactly what the un-patched code draws', () => {
  const SMALL0 = unpatch(SMALL), BIG0 = unpatch(BIG);
  assert.ok(!SMALL0.includes('__aim') && !BIG0.includes('__aim'), 'unpatch removed every hunk');
  for (const showBots of [false, true]) {
    const a = runSmall(SMALL, { showBots }), b = runSmall(SMALL0, { showBots });
    assert.deepEqual(a.ctx.log, b.ctx.log); assert.deepEqual(a.seen.length, b.seen.length);
    const c = runBig(BIG, { showBots }), d = runBig(BIG0, { showBots });
    assert.deepEqual(c.ctx.log, d.ctx.log);
  }
});

function runBig(src, { marks = null, showBots = false, dpr = 2, size = 500 } = {}) {
  const ctx = fakeCtx(), seen = [];
  const env = {
    u: { value: { getContext: () => ctx } }, o: { value: {} }, a: { value: { callouts: [{ x: 0.1, z: 0.2, name: 'A Site' }] } },
    i: { value: dpr }, l: { value: size }, t: { pose: { x: 0.3, z: 0.3, yaw: 0 }, showBots, bots: showBots ? { now: 0, alive: [{ x: 0.4, z: 0.4 }], downs: [] } : null },
    Hn: (U, x, z) => ({ u: x, v: z }), nr: () => {}, Ga: () => 0, or: () => {}, Fl: () => {}, ar: (c, x, y) => c.arc(x, y, 1, 0, 1), p: () => {}, sr: () => 0,
    window: { __aimRoundMarks: marks }, __aimBigMarks: (...a) => seen.push(a),
  };
  const fn = new Function(...Object.keys(env), `${src};return m();`);
  const ok = fn(...Object.values(env));
  return { ok, ctx, seen };
}

test('patched big map: overlay after the callouts, before the bots, in map-image pixels', () => {
  const marks = { letters: [], spike: 0 };
  const { ok, ctx, seen } = runBig(BIG, { marks, showBots: true });
  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  const [c, m, map, dpr] = seen[0];
  assert.equal(c.log, ctx.log); assert.equal(m, marks); assert.equal(dpr, 2);
  assert.deepEqual(map(0.25, 0.5), [250, 500]);
  assert.equal(runBig(BIG, { marks: null }).seen.length, 0);
});

test('patched redraw loop: both keys get the marker suffix; unchanged without marks', () => {
  const run = (src, suffix) => {
    const keys = [];
    const env = {
      t: { pose: { x: 1, z: 2, yaw: 0 }, rotates: true }, g: () => '|b', E: (c, rot) => `E${rot}`, r: { value: 1 }, u: { value: 2 }, y: () => '',
      Rl: (prev, k) => { keys.push(k.key); return false; }, A: null, b: null, C: 2, v: () => true, m: () => true, c: { value: true }, h: 0,
      requestHudFrame: () => 1, __aimMarksKey: (now) => { assert.equal(typeof now, 'number'); return suffix; },
    };
    new Function(...Object.keys(env), `${src};I();`)(...Object.values(env));
    return keys;
  };
  assert.deepEqual(run(LOOP, '|m7'), ['Etrue|b|m7', 'Efalse|b|m7']);
  assert.deepEqual(run(LOOP, ''), run(unpatch(LOOP), 'unused'));
});

test('round_minimap_patch.py: each hunk once, copies byte-identical, import before round-core, refuses twice', () => {
  const a = fs.readFileSync(path.join(JS[0], 'OkAdunfX.js')), b = fs.readFileSync(path.join(JS[1], 'OkAdunfX.js'));
  assert.ok(a.equals(b), 'OkAdunfX.js copies differ');
  for (const [, n] of PAIRS) assert.equal(count(OKA, n), 1, n.slice(0, 80));
  assert.ok(OKA.startsWith("import {drawMiniMarks as __aimMiniMarks,drawBigMarks as __aimBigMarks,roundMarksKey as __aimMarksKey} from '/aim-rounds/round-minimap.mjs';import {roundPrepare as __aimRoundPrepare}"));
  for (const k of ['drawMiniMarks', 'drawBigMarks', 'roundMarksKey']) assert.equal(typeof mm[k], 'function', k);
  let out = '';
  try { execFileSync('python', ['-I', path.join(root, 'tools', 'round_minimap_patch.py')], { stdio: 'pipe' }); } catch (e) { out = String(e.stderr || '') + String(e.stdout || ''); }
  assert.match(out, /already patched/);
  assert.ok(fs.readFileSync(path.join(JS[0], 'OkAdunfX.js')).equals(a), 'refused run left the file alone');
});
