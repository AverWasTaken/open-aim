// Round mode bots on Corrode's (rook) REAL collision: the same checks as test-round-bots-real.mjs
// (Ascent) on the second round map. Defenders walk from their spawns to every one of Corrode's 13
// setups in both movement modes (default and "game"), on the true floors, never leave the defender
// side or cross a barrier while the barriers are up, a bot whose setup is past a defender barrier
// waits at it, and the retake (A site, player hidden; B site, player dead) ends in a defuse;
// determinism across the plant tick.
// Uses scripts/round-bots-sweep.mjs with ROUND_MAP=rook (its ASCENT / NAV_AB then hold Corrode's
// data). Needs the game files in site/ (skipped without them). Heavy: run it on hp
// (npm run test:round in app/). The first loadTerrain('rook') builds the triangle cache in the OS
// temp dir; later runs reuse it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ROUND_MAP = 'rook';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(root, 'app', 'mods');
const { terrainSources, loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
const navlib = await import(pathToFileURL(path.join(root, 'tools', 'round_navlib.mjs')).href);
const bots = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-bots.mjs')).href);
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js')) && !!terrainSources('rook', root);
const skip = !HAVE_SITE && 'no game files in site/';
let sim = null, T = null, SW = null;
if (HAVE_SITE) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);
  SW = await import(pathToFileURL(path.join(root, 'scripts', 'round-bots-sweep.mjs')).href);
}
const terrain = async () => (T ??= await loadTerrain('rook', { root }));

const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
const I = bots.roundBotsInternals;
const ROOK = JSON.parse(fs.readFileSync(path.join(MODS, 'aim-rounds', 'rook.json'), 'utf-8'));
const DEF_BARS = ROOK.barriers.filter((b) => b.team === 'defense');
// Three 5-bot sets that together hold all 13 setups (5 A, 3 mid, 5 B).
const SETS = [
  ['A site front', 'A link corner', 'Mid window', 'B site', 'B link watch'],
  ['A ramp', 'A pocket', 'Mid window left', 'B back', 'B elbow'],
  ['A yard', 'A site front', 'Mid window right', 'B corner', 'B site'],
];
const ALL_SETUPS = Object.values(ROOK.setups.defense).flat().map((s) => s.name);
const MODES = [['default', {}], ['game', { movement: 'game' }]];
const crossesBar = (a, b) => DEF_BARS.some((w) => navlib.segCross(a.x, a.z, b.x, b.z, w.a.x, w.a.z, w.b.x, w.b.z));
const segDist = (p, w) => {
  const vx = w.b.x - w.a.x, vz = w.b.z - w.a.z, l = vx * vx + vz * vz, t = Math.max(0, Math.min(1, ((p.x - w.a.x) * vx + (p.z - w.a.z) * vz) / l));
  return Math.hypot(p.x - (w.a.x + vx * t), p.z - (w.a.z + vz * t));
};
const dropEdge = (g, i, j) => { for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) if (g.edgeTo[e] === j && g.edgeType[e] === 1) return true; return false; };

function realDoc({ barrierSec, set }) {
  const doc = SW.realDoc({ barrierSec, set });
  assert.deepEqual(doc.blocks, [], 'no flat plane over Corrode');
  assert.equal(doc.rules.round.map, 'rook');
  return doc;
}

// One run with per-tick checks (as in test-round-bots-real.mjs); returns per-bot results.
async function runReal(doc, { seed, extra = {}, ticks, each = null }) {
  const N = SW.useNav(), g = N.g, H = navlib.nodeIndex(g), W = await terrain();
  const mask = I.maskFor(N, I.barriersOf(doc.rules.round));
  const spawns = ROOK.spawns.defense.map((p) => navlib.nearestNode(g, H, p.x, p.z, 1, p.y, 1.5));
  const seal = navlib.flood(g, spawns, { types: navlib.TYPES.all, mask });
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed, terrain: W, ...extra });
  const res = new Map(), prev = new Map();
  for (let i = 0; i < ticks; i++) {
    s.step(IDLE);
    const st = s.saveState(), phase = s.snapshot().round.phase;
    for (const a of st.actors) {
      const b = a.behavior.roundBot, p = a.position, q = prev.get(a.id);
      if (!res.has(a.id)) res.set(a.id, { id: a.id, spawnerId: a.spawnerId, name: doc.rules.round.setupBySpawner[a.spawnerId].name, maxStep: 0, maxFloor: 0, noFloor: 0, offNode: 0, outside: 0, crossed: 0, airTicks: 0, modeAtDrop: -1, waited: 0, static: 0, notNav: 0 });
      const r = res.get(a.id);
      r.b = b; r.p = { ...p };
      if (b.nav !== 1) r.notNav++;
      if (b.mode === I.MODE.static) r.static++;
      if (b.mode === I.MODE.wait) r.waited++;
      if (b.air === 1) { r.airTicks++; r.lipRun = 0; }
      else {
        const top = p.y + 0.5, t = W.ray(W.pawn, [p.x, top, p.z], [0, -1, 0], 2);
        if (t < 0) r.noFloor++;
        else r.maxFloor = Math.max(r.maxFloor, Math.abs(top - t - p.y));
        const lip = (b.tgt >= 0 && dropEdge(g, b.cur, b.tgt)) || p.y - g.y[b.cur] > 0.6;
        if (!navlib.nodesNear(g, H, p.x, p.z, lip ? 0.75 : 0.36, p.y, 0.6).length) r.offNode++;
        r.lipRun = lip ? (r.lipRun ?? 0) + 1 : 0;
        r.maxLip = Math.max(r.maxLip ?? 0, r.lipRun);
      }
      if (phase === 'barrier') {
        const k = navlib.nearestNode(g, H, p.x, p.z, 0.75, p.y, b.air === 1 ? 6 : 1);
        if (k < 0 || seal[k] === -2) r.outside++;
        if (q && crossesBar(q, p)) r.crossed++;
      } else if (r.modeAtDrop < 0) r.modeAtDrop = b.mode;
      if (q) r.maxStep = Math.max(r.maxStep, Math.hypot(p.x - q.x, p.z - q.z));
      prev.set(a.id, { ...p });
    }
    if (each) each(s, st, i, phase);
  }
  for (const r of res.values()) r.field = I.fieldFor(N, r.b.goal, null).dist[r.b.spawn];
  return { s, res: [...res.values()] };
}

function checkRun(res, label) {
  assert.equal(res.length, 5, `${label}: 5 bots`);
  for (const r of res) {
    const tag = `${label} ${r.name}`;
    assert.equal(r.notNav, 0, `${tag}: ticks not in nav mode`);
    assert.equal(r.static, 0, `${tag}: ticks as a static (no-nav) bot`);
    assert.equal(r.noFloor, 0, `${tag}: ticks with no floor under the bot`);
    assert.ok(r.maxFloor < 0.6, `${tag}: ${r.maxFloor.toFixed(3)} m off the real floor`);
    assert.equal(r.offNode, 0, `${tag}: ticks not within 0.36 m of a nav node on its floor`);
    assert.equal(r.outside, 0, `${tag}: outside the defender seal flood in the barrier phase`);
    assert.equal(r.crossed, 0, `${tag}: crossed a defender barrier in the barrier phase`);
    assert.ok(r.maxStep < 0.12, `${tag}: max xz step ${r.maxStep.toFixed(3)} (no teleport)`);
    assert.equal(r.b.replans, 0, `${tag}: re-plans`);
    assert.notEqual(r.b.mode, I.MODE.stuck, `${tag}: stuck`);
    assert.ok((r.maxLip ?? 0) <= 0.3 * TPS, `${tag}: ${r.maxLip} ticks in a row on a drop lip (never parks on a ledge)`);
  }
  const still = res.filter((r) => r.b.mode === I.MODE.hold || r.b.mode === I.MODE.wait);
  for (const a of still) for (const b of still) if (a.id < b.id) assert.ok(Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) >= 0.8, `${label}: ${a.name} and ${b.name} stand within 0.8 m`);
}
// Arrival bound: start + 1.25 x field + 1 s (field = nav travel time from its spawn), as on Ascent.
// Only a bot that waited at a barrier gets max(barrier, that) (it walks on after the drop); no real
// Corrode setup needs a wait.
const due = (r, barrierSec) => (r.waited ? Math.max(barrierSec, r.b.goT + 1.25 * r.field + 1) : r.b.goT + 1.25 * r.field + 1);

const arrivals = [];
test('real Corrode: the sweep runs on rook data (ROUND_MAP=rook), the 3 test sets cover all 13 setups', { skip }, () => {
  assert.equal(SW.MAP, 'rook');
  assert.equal(SW.ASCENT.map, 'rook');
  assert.equal(ALL_SETUPS.length, 13);
  assert.deepEqual([...new Set(SETS.flat())].sort(), [...ALL_SETUPS].sort());
});

test('real Corrode, 20 s barrier, both movement modes: all 13 setups reached (nav mode every tick, no wait, arrived before 20 s and by 1.25 x field + 1 s), on the real floor, inside the defender side, never across a barrier', { skip }, async () => {
  const seen = new Set();
  for (const [mode, extra] of MODES) {
    for (let k = 0; k < SETS.length; k++) {
      const label = `20s ${mode} set ${k}`;
      const { res } = await runReal(realDoc({ barrierSec: 20, set: SETS[k] }), { seed: 41 + k, extra, ticks: TPS * 30 });
      checkRun(res, label);
      for (const r of res) {
        seen.add(r.name);
        arrivals.push({ barrier: 20, mode, setup: r.name, field: +r.field.toFixed(2), start: +r.b.goT.toFixed(2), arrive: r.b.arriveT, air: r.airTicks, waited: r.waited });
        assert.equal(r.b.arrived, 1, `${label} ${r.name}: arrived`);
        assert.equal(r.waited, 0, `${label} ${r.name}: no wait (every Corrode setup is on the defender side)`);
        assert.ok(r.b.arriveT < 20, `${label} ${r.name}: arrived at ${r.b.arriveT} (barrier 20)`);
        assert.ok(r.b.arriveT <= due(r, 20), `${label} ${r.name}: arrived at ${r.b.arriveT} vs due ${due(r, 20).toFixed(2)} (field ${r.field.toFixed(2)} from ${r.b.goT.toFixed(2)})`);
        assert.equal(r.b.mode, I.MODE.hold, `${label} ${r.name}: holds`);
      }
    }
  }
  assert.equal(seen.size, 13, 'every setup walked to');
});

test('real Corrode, 10 s barrier, both movement modes: late bots keep walking through the drop, then hold', { skip }, async () => {
  for (const [mode, extra] of MODES) {
    for (let k = 0; k < SETS.length; k++) {
      const label = `10s ${mode} set ${k}`;
      const { res } = await runReal(realDoc({ barrierSec: 10, set: SETS[k] }), { seed: 61 + k, extra, ticks: TPS * 30 });
      checkRun(res, label);
      for (const r of res) {
        arrivals.push({ barrier: 10, mode, setup: r.name, field: +r.field.toFixed(2), start: +r.b.goT.toFixed(2), arrive: r.b.arriveT, air: r.airTicks, waited: r.waited });
        assert.equal(r.b.arrived, 1, `${label} ${r.name}: arrived`);
        assert.equal(r.b.mode, I.MODE.hold, `${label} ${r.name}: holds`);
        assert.ok(r.b.arriveT <= due(r, 10), `${label} ${r.name}: arrived ${r.b.arriveT} vs due ${due(r, 10).toFixed(2)}`);
        if (r.b.arriveT > 10 && !r.waited) assert.equal(r.modeAtDrop, I.MODE.walk, `${label} ${r.name}: still walking at the drop`);
      }
    }
  }
  assert.ok(arrivals.filter((a) => a.barrier === 10 && a.arrive > 10).length >= 6, 'late bots (arriving after the 10 s drop) exercised');
  const rows = arrivals.map((a) => `${String(a.barrier).padStart(2)}s ${a.mode.padEnd(7)} ${a.setup.padEnd(17)} field ${a.field.toFixed(2).padStart(5)}  start ${a.start.toFixed(2)}  arrive ${a.arrive.toFixed(2).padStart(5)}${a.waited ? '  (waited)' : ''}${a.barrier === 10 && a.arrive > 10 ? '  (after the drop)' : ''}`);
  console.log(['Corrode arrival times (s from round start):', ...rows].join('\n'));
});

// Wait mode on Corrode: for every defender barrier with open floor 3 m past it (attacker side), a
// test setup there -> the bot reaches its wait node and waits within 2 m of the line while the
// barriers are up (20 s), never crosses, and walks on after the drop. (No real Corrode setup needs a
// wait: every one is on the defender side, see the arrival table.)
test('real Corrode, 20 s barrier: a setup just past a defender barrier -> the bot waits at it, never crosses while it is up, then walks on (both movement modes)', { skip }, async () => {
  // Past = 3 m off the barrier's middle, on the side the defenders can't reach while the barriers
  // are up (outside the defender seal flood) but can after the drop (inside the unmasked flood).
  const N = SW.useNav(), g = N.g, H = navlib.nodeIndex(g);
  const spawns = ROOK.spawns.defense.map((p) => navlib.nearestNode(g, H, p.x, p.z, 1, p.y, 1.5));
  const seal = navlib.flood(g, spawns, { types: navlib.TYPES.all, mask: I.maskFor(N, I.barriersOf(realDoc({ barrierSec: 20, set: SETS[0] }).rules.round)) });
  const open = navlib.flood(g, spawns, { types: navlib.TYPES.all });
  const inSeal = (p, dy = 1) => { const n = navlib.nearestNode(g, H, p.x, p.z, 0.75, p.y, dy); return n >= 0 && seal[n] !== -2; };
  let tried = 0;
  for (const w of DEF_BARS) {
    const mx = (w.a.x + w.b.x) / 2, mz = (w.a.z + w.b.z) / 2, len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z);
    const nx = -(w.b.z - w.a.z) / len, nz = (w.b.x - w.a.x) / len;
    let k = -1;
    for (const d of [3, -3]) {
      k = I.nodesNear(N, mx + d * nx, mz + d * nz, 1.5).find((i) => g.y[i] >= w.y[0] && g.y[i] <= w.y[1] && seal[i] === -2 && open[i] !== -2 && segDist({ x: g.x[i], z: g.z[i] }, w) > 2) ?? -1;
      if (k >= 0) break;
    }
    if (!(k >= 0)) { console.log(`wait test: no node past ${w.id}`); continue; }
    tried++;
    for (const [mode, extra] of MODES) {
      const doc = realDoc({ barrierSec: 20, set: SETS[0] });
      const sid = Object.keys(doc.rules.round.setupBySpawner).find((id) => doc.rules.round.setupBySpawner[id].name === 'Mid window');
      doc.rules.round.setupBySpawner[sid] = { name: `test: past ${w.id}`, group: 'mid', x: g.x[k], y: g.y[k], z: g.z[k] };
      let atDrop = null;
      const { res } = await runReal(doc, { seed: 17, extra, ticks: TPS * 36, each: (q, st, i, phase) => { if (!atDrop && phase !== 'barrier') atDrop = structuredClone(st.actors.find((a) => a.spawnerId === sid)); } });
      const r = res.find((x) => x.spawnerId === sid);
      r.name = `test: past ${w.id}`;
      const label = `past ${w.id} ${mode}`;
      checkRun(res, label);
      assert.ok(r.b.wait >= 0, `${label}: has a wait node`);
      assert.equal(atDrop.behavior.roundBot.mode, I.MODE.wait, `${label}: waiting when the barriers drop`);
      assert.ok(segDist(atDrop.position, w) < 2, `${label}: waits ${segDist(atDrop.position, w).toFixed(2)} m from the line`);
      assert.ok(inSeal(atDrop.position), `${label}: on the defender side at the drop`);
      assert.equal(r.b.mode, I.MODE.hold, `${label}: reached the setup after the drop`);
      assert.ok(Math.hypot(r.p.x - g.x[k], r.p.z - g.z[k]) < 0.05, `${label}: at the setup past the barrier`);
      assert.ok(r.waited > 0, `${label}: wait mode used`);
      assert.ok(r.b.arriveT > 20 && r.b.arriveT < 30, `${label}: arrived ${r.b.arriveT} (after the drop)`);
    }
  }
  console.log(`wait mode exercised at ${tried} of ${DEF_BARS.length} defender barriers`);
  assert.ok(tried >= 2, `wait mode exercised at ${tried} defender barriers`);
});

// ---------------------------------------------------------------- retake / defuse on real collision
const SITE_NODE = (N, site) => N.g.header.siteGoals[site].node;
async function retake({ set, spike, player = 'hidden', seed = 5, extra = {}, maxSec = 60 }) {
  const doc = SW.realDoc({ barrierSec: 1, set, atSetups: true });
  return SW.retakeRun({ sim, W: await terrain(), doc, seed, extra, plantAfter: 0.5, spike, player, maxSec });
}
function checkRetake(m, label) {
  const tag = `${label} [seed ${m.seed}]`;
  assert.equal(m.crossings, 0, `${tag}: barrier crossings`);
  assert.equal(m.fireWhileDefusing, 0, `${tag}: a bot fired while defusing`);
  assert.equal(m.stuck, 0, `${tag}: stuck bots`);
  assert.ok(m.maxExcess <= 0, `${tag}: an arrival took longer than 1.35 x field + 1 s (${m.maxExcess.toFixed(2)} s over) ${JSON.stringify(m.arrivals)}`);
  assert.ok(m.minStillTick >= 0.8, `${tag}: two standing bots ${m.minStillTick.toFixed(2)} m apart on some tick`);
  assert.ok(m.maxDefusers <= 1, `${tag}: ${m.maxDefusers} bots defusing on one tick`);
  assert.equal(m.overdue, 0, `${tag}: goals still open and overdue at the end`);
  assert.equal(m.flagGap, 0, `${tag}: the defuse flag holds every tick until the end`);
  assert.equal(m.outcome, 'defused', `${tag}: outcome ${m.outcome}`);
  assert.equal(m.kind, 'defuse');
  assert.ok(m.end < 45, `${tag}: defused ${m.end.toFixed(2)} s after the plant`);
  assert.ok(m.candArrive >= 0 && m.defuseStart >= m.candArrive, `${tag}: candidate arrived ${m.candArrive}, defuse ${m.defuseStart}`);
}

test('real Corrode retake: A site plant with no bot on A, player hidden: bots stage, push, one defuses', { skip }, async () => {
  const N = SW.useNav();
  const m = await retake({ set: ['Mid window', 'Mid window left', 'B site', 'B back', 'B elbow'], spike: SW.spotOf(N, SITE_NODE(N, 'A'), 'A') });
  checkRetake(m, 'Corrode A hidden');
  assert.ok(m.staged2 >= 0, 'two bots staged before the push');
  assert.equal(m.defusers.length, 1, 'one defuser');
  const r = m.s.snapshot().round;
  assert.equal(r.reason, 'defused');
  console.log(`Corrode A hidden: cand at spike ${m.candArrive.toFixed(2)} s, defuse ${m.defuseStart.toFixed(2)} -> ${m.end.toFixed(2)} s after the plant`);
});

test('real Corrode retake: B site plant, player dead, "game" movement: everyone pushes at once, one defuses', { skip }, async () => {
  const N = SW.useNav();
  const m = await retake({ set: SETS[0], spike: SW.spotOf(N, SITE_NODE(N, 'B'), 'B'), player: 'dead', extra: { movement: 'game' }, seed: 7 });
  checkRetake(m, 'Corrode B dead');
  assert.equal(m.staged2, -1, 'no staging with the player dead');
  console.log(`Corrode B dead: cand at spike ${m.candArrive.toFixed(2)} s, defuse ${m.defuseStart.toFixed(2)} -> ${m.end.toFixed(2)} s after the plant`);
});

test('real Corrode: determinism across the plant tick: restore the planted state -> same run; cold caches -> same run; save mid-retake -> same continuation', { skip }, async () => {
  const N = SW.useNav(), W = await terrain();
  const doc = SW.realDoc({ barrierSec: 1, set: SETS[1], atSetups: true });
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed: 21, terrain: W });
  for (let i = 0; i < TPS * 1.5 + 64; i++) s.step(IDLE);
  SW.forcePlant(s, SW.spotOf(N, SITE_NODE(N, 'B'), 'B'), 'hidden');
  const S0 = s.saveState();
  const run = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(JSON.stringify(s.step(IDLE)), JSON.stringify(s.snapshot().actors)); return out.join('\n') + JSON.stringify(s.saveState()); };
  const a = run(TPS * 3);
  s.restoreState(S0);
  assert.ok(run(TPS * 3) === a, 'restore of the planted state replays the same');
  I.resetCaches(); SW.useNav();
  s.restoreState(S0);
  assert.ok(run(TPS * 3) === a, 'cold caches across the plant tick: same run');
  s.restoreState(S0);
  run(TPS * 1.5);
  const S1 = s.saveState(), b = run(TPS);
  s.restoreState(S1);
  assert.ok(run(TPS) === b, 'mid-retake save -> same continuation');
  assert.ok(S1.actors.some((x) => x.behavior.roundBot.pk >= 0), 'the save is past the latch');
});
