// Round mode bots on Ascent's REAL collision (tools/round_terrain.mjs loadTerrain: the game's own
// pawn/projectile worlds rebuilt in node) with the real nav graph and the real patched sim:
// defenders walk from their spawns to every setup during the barrier phase in both movement modes
// (default and the "game" setting), on the true floors (A site, heaven, drops), never leave the
// defender side while the barriers are up, wait at a barrier when their setup is beyond it, and a
// save taken while a bot is in the air restores to the same run.
// Needs the game files in site/ (skipped without them). The first loadTerrain on a machine builds
// the triangle cache in the OS temp dir (~6 s); later runs reuse it. Arrival times are printed and
// written to <tmp>/round-bots-arrivals.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(root, 'app', 'mods');
const { terrainSources, loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
const navlib = await import(pathToFileURL(path.join(root, 'tools', 'round_navlib.mjs')).href);
const bots = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-bots.mjs')).href);
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js')) && !!terrainSources('ascent', root);
const skip = !HAVE_SITE && 'no game files in site/';
let sim = null, T = null;
if (HAVE_SITE) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);
}
const terrain = async () => (T ??= await loadTerrain('ascent', { root }));

const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
const I = bots.roundBotsInternals;
const ASCENT = JSON.parse(fs.readFileSync(path.join(MODS, 'aim-rounds', 'ascent.json'), 'utf-8'));
const { buildDoc } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
const NAV_BYTES = fs.readFileSync(path.join(MODS, 'aim-rounds', 'ascent.nav.bin'));
const NAV_AB = NAV_BYTES.buffer.slice(NAV_BYTES.byteOffset, NAV_BYTES.byteOffset + NAV_BYTES.byteLength);
const useNav = () => { globalThis.__aimRoundNav = { ascent: NAV_AB }; return I.navFor('ascent'); };
const DEF_BARS = ASCENT.barriers.filter((b) => b.team === 'defense');
const SUBST = [11378, 11575]; // "B site front" -> nearest reachable nodes
const SETS = [
  ['A site default', 'A site front', 'Market', 'B default', 'B back site'],
  ['A generator', 'A site tree side', 'Market back', 'B boathouse side', 'B site front'],
  ['A heaven', 'A heaven tree side', 'A rafters back', 'Pizza', 'B workshop'],
];
const MODES = [['default', {}], ['game', { movement: 'game' }]];
const crossesBar = (a, b) => DEF_BARS.some((w) => navlib.segCross(a.x, a.z, b.x, b.z, w.a.x, w.a.z, w.b.x, w.b.z));
const segDist = (p, w) => {
  const vx = w.b.x - w.a.x, vz = w.b.z - w.a.z, l = vx * vx + vz * vz, t = Math.max(0, Math.min(1, ((p.x - w.a.x) * vx + (p.z - w.a.z) * vz) / l));
  return Math.hypot(p.x - (w.a.x + vx * t), p.z - (w.a.z + vz * t));
};

const dropEdge = (g, i, j) => { for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) if (g.edgeTo[e] === j && g.edgeType[e] === 1) return true; return false; };

// The real round scene (no blocks: Ascent's collision only), kept setups forced to `set`.
function realDoc({ barrierSec, set }) {
  const doc = buildDoc(ASCENT, { side: 'attack', weapon: 'vandal', barrierSec });
  assert.deepEqual(doc.blocks, [], 'no flat plane over Ascent');
  const r = doc.rules.round;
  const byName = Object.fromEntries(Object.entries(r.setupBySpawner).map(([id, s]) => [s.name, id]));
  const ids = set.map((n) => byName[n]);
  assert.ok(ids.every(Boolean), 'setup names');
  r.setups = { groups: { all: ids }, splits: [[ids.length]], count: ids.length };
  doc.spawners = doc.spawners.filter((s) => ids.includes(s.id));
  return doc;
}

// One run with per-tick checks; returns per-bot results (+ the sim).
async function runReal(doc, { seed, extra = {}, ticks, each = null }) {
  const N = useNav(), g = N.g, H = navlib.nodeIndex(g), W = await terrain();
  const mask = I.maskFor(N, I.barriersOf(doc.rules.round));
  const spawns = ASCENT.spawns.defense.map((p) => navlib.nearestNode(g, H, p.x, p.z, 1, p.y, 1.5));
  const seal = navlib.flood(g, spawns, { types: navlib.TYPES.all, mask });
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed, terrain: W, ...extra });
  const res = new Map(), prev = new Map();
  let liveTick = -1;
  for (let i = 0; i < ticks; i++) {
    s.step(IDLE);
    const st = s.saveState(), phase = s.snapshot().round.phase;
    if (phase !== 'barrier' && liveTick < 0) liveTick = s.tick;
    for (const a of st.actors) {
      const b = a.behavior.roundBot, p = a.position, q = prev.get(a.id);
      if (!res.has(a.id)) res.set(a.id, { id: a.id, spawnerId: a.spawnerId, name: doc.rules.round.setupBySpawner[a.spawnerId].name, maxStep: 0, maxFloor: 0, noFloor: 0, offNode: 0, outside: 0, crossed: 0, airTicks: 0, modeAtDrop: -1 });
      const r = res.get(a.id);
      r.b = b; r.p = { ...p };
      assert.equal(b.nav, 1, 'nav mode');
      if (b.air === 1) { r.airTicks++; r.lipRun = 0; }
      else {
        const top = p.y + 0.5, t = W.ray(W.pawn, [p.x, top, p.z], [0, -1, 0], 2);
        if (t < 0) r.noFloor++;
        else r.maxFloor = Math.max(r.maxFloor, Math.abs(top - t - p.y));
        // Within 0.36 m xz of a node on its floor (the nav cell is 0.5 m). Exception: on the lip of
        // a drop (its target is the lower end of a drop edge from its node, or its tracked node is
        // already the lower end while it still stands on top), where the pawn floor reaches past the
        // last cell: 0.75 m, and never for long (checked in checkRun).
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
  return { s, res: [...res.values()], liveTick };
}

function checkRun(res, label) {
  assert.equal(res.length, 5, `${label}: 5 bots`);
  for (const r of res) {
    const tag = `${label} ${r.name}`;
    assert.equal(r.noFloor, 0, `${tag}: ticks with no floor under the bot`);
    assert.ok(r.maxFloor < 0.6, `${tag}: ${r.maxFloor.toFixed(3)} m off the real floor`);
    assert.equal(r.offNode, 0, `${tag}: ticks not within 0.36 m of a nav node on its floor`);
    assert.equal(r.outside, 0, `${tag}: outside the defender seal flood in the barrier phase`);
    assert.equal(r.crossed, 0, `${tag}: crossed a defender barrier in the barrier phase`);
    assert.ok(r.maxStep < 0.12, `${tag}: max xz step ${r.maxStep.toFixed(3)} (no teleport)`);
    assert.equal(r.b.replans, 0, `${tag}: re-plans`);
    assert.notEqual(r.b.mode, I.MODE.stuck, `${tag}: stuck`);
    if (r.name === 'B site front') assert.ok(SUBST.includes(r.b.goal), `${tag}: substitute node`);
    assert.ok((r.maxLip ?? 0) <= 0.3 * TPS, `${tag}: ${r.maxLip} ticks in a row on a drop lip (never parks on a ledge)`);
  }
  const still = res.filter((r) => r.b.mode === I.MODE.hold || r.b.mode === I.MODE.wait);
  for (const a of still) for (const b of still) if (a.id < b.id) assert.ok(Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) >= 0.8, `${label}: ${a.name} and ${b.name} stand within 0.8 m`);
}

const arrivals = [];
const report = () => {
  try { fs.writeFileSync(path.join(os.tmpdir(), 'round-bots-arrivals.json'), JSON.stringify(arrivals, null, 1)); } catch {}
};

test('real Ascent, 20 s barrier, both movement modes: all 15 setups reached before the drop (<= 1.25 x field + 1 s), on the real floor, inside the defender side, never across a barrier; a save taken mid-air restores to the same run', { skip }, async () => {
  let airChecked = false;
  for (const [mode, extra] of MODES) {
    for (let k = 0; k < SETS.length; k++) {
      const label = `20s ${mode} set ${k}`;
      let saved = null, savedAt = -1, chunk = null;
      const rec = [];
      const wantAir = !airChecked && mode === 'default';
      const { s, res } = await runReal(realDoc({ barrierSec: 20, set: SETS[k] }), {
        seed: 41 + k, extra, ticks: TPS * 21,
        each: wantAir ? (q, st, i) => {
          if (!saved && st.actors.some((a) => a.behavior.roundBot.air === 1)) { saved = st; savedAt = i; }
          if (saved && i > savedAt && i <= savedAt + TPS) rec.push(JSON.stringify(q.snapshot().actors));
          if (saved && i === savedAt + TPS) chunk = JSON.stringify(q.saveState());
        } : null,
      });
      checkRun(res, label);
      for (const r of res) {
        arrivals.push({ barrier: 20, mode, setup: r.name, field: +r.field.toFixed(2), start: +r.b.goT.toFixed(2), arrive: r.b.arriveT, air: r.airTicks, lip: r.maxLip ?? 0 });
        assert.equal(r.b.arrived, 1, `${label} ${r.name}: arrived`);
        assert.ok(r.b.arriveT < 20, `${label} ${r.name}: arrived at ${r.b.arriveT} (barrier 20)`);
        assert.ok(r.b.arriveT <= r.b.goT + 1.25 * r.field + 1, `${label} ${r.name}: arrived ${r.b.arriveT} vs field ${r.field.toFixed(2)} from ${r.b.goT.toFixed(2)}`);
        assert.equal(r.b.mode, I.MODE.hold, `${label} ${r.name}: holds`);
      }
      if (saved) {
        s.restoreState(saved);
        const again = [];
        for (let i = 0; i < TPS; i++) { s.step(IDLE); again.push(JSON.stringify(s.snapshot().actors)); }
        assert.deepEqual(again, rec, 'mid-air save/restore replays the same');
        assert.equal(JSON.stringify(s.saveState()), chunk);
        airChecked = true;
      }
    }
  }
  assert.ok(airChecked, 'a bot was in the air (drop) on some route, and its save/restore was checked');
  assert.ok(arrivals.some((a) => a.lip > 0), 'the drop-lip rule was exercised (and capped)');
  assert.ok(arrivals.filter((a) => a.barrier === 20 && a.air > 0).length >= 4, 'drop routes exercised on real collision');
  report();
});

test('real Ascent, 10 s barrier, both movement modes: late bots keep walking through the drop, then hold', { skip }, async () => {
  for (const [mode, extra] of MODES) {
    for (let k = 0; k < SETS.length; k++) {
      const label = `10s ${mode} set ${k}`;
      const { res } = await runReal(realDoc({ barrierSec: 10, set: SETS[k] }), { seed: 61 + k, extra, ticks: TPS * 16 });
      checkRun(res, label);
      for (const r of res) {
        arrivals.push({ barrier: 10, mode, setup: r.name, field: +r.field.toFixed(2), start: +r.b.goT.toFixed(2), arrive: r.b.arriveT, air: r.airTicks });
        assert.equal(r.b.mode, I.MODE.hold, `${label} ${r.name}: holds`);
        assert.ok(r.b.arriveT <= r.b.goT + 1.25 * r.field + 1, `${label} ${r.name}: arrived ${r.b.arriveT}`);
        if (r.b.arriveT > 10) assert.equal(r.modeAtDrop, I.MODE.walk, `${label} ${r.name}: still walking at the drop`);
      }
    }
  }
  report();
  const rows = arrivals.map((a) => `${String(a.barrier).padStart(2)}s ${a.mode.padEnd(7)} ${a.setup.padEnd(19)} field ${a.field.toFixed(2).padStart(5)}  start ${a.start.toFixed(2)}  arrive ${a.arrive.toFixed(2).padStart(5)}${a.barrier === 10 && a.arrive > 10 ? '  (after the drop)' : ''}`);
  console.log(['arrival times (s from round start):', ...rows].join('\n'));
});

test('real Ascent: a setup just beyond def-mid -> the bot waits within 2 m of the barrier, never crosses it while it is up, and walks on after the drop (both movement modes)', { skip }, async () => {
  const N = useNav(), g = N.g, w = DEF_BARS.find((b) => b.id === 'def-mid');
  const k = I.nodesNear(N, w.a.x + 3, (w.a.z + w.b.z) / 2, 2).find((i) => g.y[i] >= w.y[0] && g.y[i] <= w.y[1] && g.x[i] > w.a.x + 2);
  assert.ok(k >= 0, 'a node past def-mid');
  for (const [mode, extra] of MODES) {
    const doc = realDoc({ barrierSec: 20, set: SETS[2] });
    const sid = Object.keys(doc.rules.round.setupBySpawner).find((id) => doc.rules.round.setupBySpawner[id].name === 'Pizza');
    doc.rules.round.setupBySpawner[sid] = { name: 'test: past def-mid', group: 'mid', x: g.x[k], y: g.y[k], z: g.z[k] };
    let atDrop = null;
    const { res } = await runReal(doc, { seed: 17, extra, ticks: TPS * 28, each: (q, st, i, phase) => { if (!atDrop && phase !== 'barrier') atDrop = st.actors.find((a) => a.spawnerId === sid); } });
    const r = res.find((x) => x.spawnerId === sid);
    r.name = 'test: past def-mid';
    checkRun(res, `past def-mid ${mode}`);
    assert.ok(r.b.wait >= 0, 'has a wait node');
    assert.equal(atDrop.behavior.roundBot.mode, I.MODE.wait, 'waiting when the barriers drop');
    assert.ok(segDist(atDrop.position, w) < 2, `waits ${segDist(atDrop.position, w).toFixed(2)} m from the line`);
    assert.ok(atDrop.position.x < w.a.x, 'on the defender side at the drop');
    assert.equal(r.b.mode, I.MODE.hold, 'reached the setup after the drop');
    assert.ok(Math.hypot(r.p.x - g.x[k], r.p.z - g.z[k]) < 0.05 && r.p.x > w.a.x, 'past the barrier line');
    assert.ok(r.b.arriveT > 20 && r.b.arriveT < 25, `arrived ${r.b.arriveT}`);
  }
});

// ---------------------------------------------------------------- B3: retake / defuse on real collision
// Runner + metrics shared with the sweep (scripts/round-bots-sweep.mjs retakeRun). Bots start on
// their setups (barrier 1 s); the plant is forced (save -> edit -> restore) with the player hidden
// at the attacker spawn or dead, except the one real hold-plant test.
const SW = HAVE_SITE ? await import(pathToFileURL(path.join(root, 'scripts', 'round-bots-sweep.mjs')).href) : null;
const SITE_NODE = (N, site) => N.g.header.siteGoals[site].node;
const T_DEFUSE = Math.round(7 * TPS), T_CHECK = Math.round(3.5 * TPS);
const plantMs = [];
async function retake({ set, spike, player = 'hidden', seed = 5, extra = {}, onTick = null, maxSec = 60 }) {
  const doc = SW.realDoc({ barrierSec: 1, set, atSetups: true });
  const m = SW.retakeRun({ sim, W: await terrain(), doc, seed, extra, plantAfter: 0.5, spike, player, maxSec, onTick });
  if (m.plantMs !== null) plantMs.push(+m.plantMs.toFixed(1));
  return m;
}
function checkRetake(m, label, { defused = true } = {}) {
  const tag = `${label} [seed ${m.seed}]`;
  assert.equal(m.crossings, 0, `${tag}: barrier crossings`);
  assert.equal(m.fireWhileDefusing, 0, `${tag}: a bot fired while defusing`);
  assert.equal(m.stuck, 0, `${tag}: stuck bots`);
  assert.ok(m.maxExcess <= 0, `${tag}: an arrival took longer than 1.35 x field + 1 s (${m.maxExcess.toFixed(2)} s over) ${JSON.stringify(m.arrivals)}`);
  assert.ok(m.minStillTick >= 0.8, `${tag}: two standing bots ${m.minStillTick.toFixed(2)} m apart on some tick`);
  assert.ok(m.maxDefusers <= 1, `${tag}: ${m.maxDefusers} bots defusing on one tick`);
  assert.equal(m.overdue, 0, `${tag}: goals still open and overdue at the end`);
  if (m.staged2 >= 0) assert.ok(m.firstPush >= 0 && m.firstPush - m.staged2 <= 0.5 * TPS, `${tag}: push ${(m.firstPush - m.staged2) / TPS} s after the second bot staged`);
  if (defused) {
    assert.equal(m.outcome, 'defused', `${tag}: outcome ${m.outcome}`);
    assert.equal(m.kind, 'defuse');
    assert.ok(m.end < 45, `${tag}: defused ${m.end.toFixed(2)} s after the plant`);
    assert.ok(m.candArrive >= 0 && m.defuseStart >= m.candArrive, `${tag}: candidate arrived ${m.candArrive}, defuse ${m.defuseStart}`);
  }
}

const FAR_SET = ['Market', 'Market back', 'Pizza', 'B default', 'B back site']; // nobody on A
test('B3 real Ascent: A site plant with no bot on A, player hidden: bots head for the staging points, push together once two are staged, one defuses with the flag held every tick until "Spike defused"; no fire while defusing; arrivals <= 1.35 x field + 1 s', { skip }, async () => {
  const N = useNav();
  const m = await retake({ set: FAR_SET, spike: SW.spotOf(N, SITE_NODE(N, 'A'), 'A') });
  assert.ok(m.staged2 >= 0, 'two bots staged before the push');
  checkRetake(m, 'A hidden');
  assert.equal(m.flagGap, 0, 'the defuse flag holds every tick until the end');
  assert.equal(m.defusers.length, 1, 'one defuser');
  assert.equal(m.cands.length, 1, 'one candidate all round');
  assert.ok(m.arrivals.some((a) => a.gk === I.GK.spike) && m.arrivals.some((a) => a.gk === I.GK.cover), 'spike + cover arrivals measured');
  const r = m.s.snapshot().round;
  assert.equal(r.reason, 'defused'); assert.equal(r.win, false, 'attack-side loss');
  console.log(`A hidden: cand at spike ${m.candArrive.toFixed(2)} s, defuse ${m.defuseStart.toFixed(2)} -> ${m.end.toFixed(2)} s after the plant; first post-plant tick ${m.plantMs.toFixed(1)} ms`);
});

test('B3 real Ascent: B site plant, player dead, "game" movement: everyone pushes at once, one defuses', { skip }, async () => {
  const N = useNav();
  const m = await retake({ set: SETS[1], spike: SW.spotOf(N, SITE_NODE(N, 'B'), 'B'), player: 'dead', extra: { movement: 'game' }, seed: 7 });
  checkRetake(m, 'B dead');
  assert.equal(m.flagGap, 0);
  assert.equal(m.staged2, -1, 'no staging with the player dead');
  console.log(`B dead: cand at spike ${m.candArrive.toFixed(2)} s, defuse ${m.defuseStart.toFixed(2)} -> ${m.end.toFixed(2)} s; first post-plant tick ${m.plantMs.toFixed(1)} ms`);
});

test('B3 real Ascent: spike on a crate (>= 0.8 m above the floor) -> defused from the floor next to it', { skip }, async () => {
  const N = useNav(), g = N.g, cfg = SW.realDoc({ barrierSec: 1 }).rules.round;
  const box = SW.zoneSpots(N, 'A').box.find((k) => I.spikeData(N, cfg, SW.spotOf(N, k, 'A')).kind === 'defuse');
  assert.ok(box >= 0, 'a defusable crate spot on A');
  const spike = SW.spotOf(N, box, 'A');
  let floorY = null;
  const m = await retake({ set: SETS[2], spike, seed: 9, onTick: (s, st) => { const d = st.actors.find((a) => a.alive && a.roundDefusing === 1); if (d && floorY === null) floorY = d.position.y; } });
  checkRetake(m, 'A crate');
  assert.ok(floorY !== null && spike.y - floorY >= 0.8, `spike ${spike.y} vs defuser floor ${floorY}`);
  void g;
});

test('B3 real Ascent: spike under the heaven ledge, the candidate is the heaven bot: it drops onto the spike (lands, never hangs in the air) and defuses', { skip }, async () => {
  let airCand = 0;
  const m = await retake({
    set: ['A heaven', 'Market', 'Pizza', 'B default', 'B back site'], spike: { x: -77.33, y: 5, z: -60.33, site: 'A' }, seed: 23,
    onTick: (s, st) => { for (const a of st.actors) if (a.alive && a.behavior.roundBot.cand === a.id && a.behavior.roundBot.gk === I.GK.spike && a.behavior.roundBot.air === 1) airCand++; },
  });
  checkRetake(m, 'A under heaven');
  assert.ok(airCand > 0, 'the candidate dropped on its way to the spike');
  const d = m.s.saveState().actors.find((a) => a.behavior.roundBot.mode === I.MODE.defuse || a.behavior.roundBot.cand === a.id);
  assert.ok(!d.behavior.roundBot.air, 'not in the air at the end');
});

test('B3 real Ascent: spike on a stacked-crate top no bot can reach -> nobody defuses, bots stand (no loop), the spike goes off', { skip }, async () => {
  const N = useNav(), bad = N.header.zones.A.bad[1];
  const m = await retake({ set: SETS[0], spike: { x: bad[0], y: bad[1], z: bad[2], site: 'A' }, seed: 11 });
  checkRetake(m, 'A unreachable crate', { defused: false });
  assert.equal(m.outcome, 'detonated');
  assert.notEqual(m.kind, 'defuse');
  assert.equal(m.defuseStart, -1); assert.deepEqual(m.cands, []);
  assert.ok(m.retries === 0, `retries ${m.retries}`);
  const fin = m.s.saveState();
  for (const a of fin.actors) if (a.alive) assert.ok([I.MODE.stage, I.MODE.cover].includes(a.behavior.roundBot.mode), `bot ${a.id} mode ${a.behavior.roundBot.mode}`);
});

test('B3 real Ascent: defuser killed past the checkpoint -> another bot restarts from the checkpoint and finishes', { skip }, async () => {
  const N = useNav();
  let killed = null, minAfter = Infinity;
  const m = await retake({
    set: SETS[0], spike: SW.spotOf(N, SITE_NODE(N, 'A'), 'A'), seed: 13,
    onTick: (s, st) => {
      const r = st.aimRound;
      if (killed) { if (r.defuser != null && r.defuser !== killed.id) minAfter = Math.min(minAfter, r.defuse); return; }
      if (r.defuse < 0.6 * T_DEFUSE) return;
      const d = st.actors.find((a) => a.alive && a.roundDefusing === 1);
      if (!d) return;
      killed = { id: d.id, progress: r.defuse };
      d.alive = false; d.health = 0;
      s.restoreState(st);
    },
  });
  assert.ok(killed && killed.progress > T_CHECK, `killed at ${killed?.progress} ticks of progress`);
  assert.ok(m.defusers.length >= 2 && m.defusers[1] !== killed.id, `defusers ${m.defusers}`);
  assert.ok(minAfter >= T_CHECK, `the new defuser restarted from ${minAfter} (checkpoint ${T_CHECK})`);
  assert.equal(m.outcome, 'defused');
  assert.equal(m.fireWhileDefusing, 0);
});

// The player walks into the defuser's view (in front of it, 5-9 m, clear projectile line).
function showPlayer(N, W, s, st) {
  const g = N.g, d = st.actors.find((a) => a.alive && a.roundDefusing === 1), p = d.position, fy = d.facingYaw;
  for (const k of I.nodesNear(N, p.x, p.z, 9, p.y, 0.6)) {
    const dx = g.x[k] - p.x, dz = g.z[k] - p.z, dist = Math.hypot(dx, dz);
    if (dist < 5 || (dx * Math.sin(fy) + dz * Math.cos(fy)) / dist < Math.cos(Math.PI / 6)) continue;
    const o = [p.x, p.y + 1.5, p.z], t = [g.x[k], g.y[k] + 1.5, g.z[k]], v = [t[0] - o[0], t[1] - o[1], t[2] - o[2]], len = Math.hypot(...v);
    const hit = W.ray(W.projectile, o, v.map((c) => c / len), len);
    if (hit >= 0 && hit < len - 0.05) continue;
    st.player.position = { x: g.x[k], y: g.y[k], z: g.z[k] };
    s.restoreState(st);
    return d.id;
  }
  return null;
}
test('B3 real Ascent: the player shows up in front of the defuser: Default (no rank) and iron keep defusing (never fire), platinum stops and fights, then finishes', { skip }, async () => {
  const N = useNav(), W = await terrain();
  for (const rank of [null, 'iron', 'platinum']) {
    let shown = null, gapAfter = 0;
    const m = await retake({
      set: SETS[0], spike: SW.spotOf(N, SITE_NODE(N, 'A'), 'A'), seed: 15, extra: rank ? { enemyRank: rank } : {},
      onTick: (s, st) => {
        if (shown === null && st.actors.some((a) => a.alive && a.roundDefusing === 1) && st.aimRound.defuse > 0.2 * T_DEFUSE) shown = showPlayer(N, W, s, st) ?? -1;
        if (shown > 0 && st.aimRound.phase === 'planted' && !st.actors.some((a) => a.alive && a.roundDefusing === 1)) gapAfter++;
      },
    });
    assert.ok(shown > 0, `${rank}: found a spot in view of the defuser`);
    assert.equal(m.fireWhileDefusing, 0, `${rank}: fired while defusing`);
    assert.equal(m.outcome, 'defused', `${rank}: ${m.outcome}`);
    if (rank !== 'platinum') {
      assert.ok(m.seenWhileDefusing > 0, `${rank ?? 'default'}: the defuser saw the player while defusing (not vacuous)`);
      assert.equal(m.flagGap, 0, `${rank ?? 'default'}: never let go`);
    } else {
      assert.ok(gapAfter > 0, 'platinum: let go of the defuse when it saw the player');
      assert.ok((m.shotsBy[shown] ?? 0) > 0, 'platinum: the defuser fought (fired) after letting go');
    }
  }
});

test('B3 real Ascent: a real hold-plant on B (no B bots) -> spike at the player\'s feet, the bots retake and defuse', { skip }, async () => {
  const N = useNav(), g = N.g, k = SITE_NODE(N, 'B');
  let phase = 0;
  const m = await retake({
    set: ['A site default', 'A site front', 'A generator', 'Market', 'Pizza'], spike: null, seed: 19, maxSec: 70,
    onTick: (s, st, mm, info) => {
      if (phase === 0 && info.phase === 'live') { st.player.position = { x: g.x[k], y: g.y[k] + 0.05, z: g.z[k] }; s.restoreState(st); phase = 1; return; }
      if (phase === 1 && info.tick >= mm.live + TPS / 2) { s.setRoundHold({ plant: true }); phase = 2; }
      if (phase === 2 && info.phase !== 'live') { s.setRoundHold({ plant: false }); phase = 3; }
    },
  });
  assert.ok(m.plant >= 0, 'planted by holding the key');
  const sp = m.s.saveState().aimRound.spike.planted;
  assert.equal(sp.site, 'B');
  const near = I.nearestNode(N, sp.x, sp.z, 0.6, sp.y, 0.5);
  assert.ok(near >= 0 && Math.abs(g.y[near] - sp.y) < 0.3, `spike y ${sp.y} is the player's feet (floor ${near >= 0 ? g.y[near] : '-'})`);
  assert.equal(m.outcome, 'defused', `outcome ${m.outcome}`);
  assert.equal(m.fireWhileDefusing, 0);
  assert.equal(m.crossings, 0);
});

test('B3 real Ascent: determinism across the plant tick: restore the planted state -> same run; cold caches -> same run; save mid-retake -> same continuation', { skip }, async () => {
  const N = useNav(), W = await terrain();
  const doc = SW.realDoc({ barrierSec: 1, set: SETS[0], atSetups: true });
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed: 21, terrain: W });
  for (let i = 0; i < TPS * 1.5 + 64; i++) s.step(IDLE);
  SW.forcePlant(s, SW.spotOf(N, SITE_NODE(N, 'A'), 'A'), 'hidden');
  const S0 = s.saveState();
  const run = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(JSON.stringify(s.step(IDLE)), JSON.stringify(s.snapshot().actors)); return out.join('\n') + JSON.stringify(s.saveState()); };
  const a = run(TPS * 3);
  s.restoreState(S0);
  assert.ok(run(TPS * 3) === a, 'restore of the planted state replays the same');
  I.resetCaches(); useNav();
  s.restoreState(S0);
  assert.ok(run(TPS * 3) === a, 'cold caches across the plant tick: same run');
  s.restoreState(S0);
  run(TPS * 1.5);
  const S1 = s.saveState(), b = run(TPS);
  s.restoreState(S1);
  assert.ok(run(TPS) === b, 'mid-retake save -> same continuation');
  assert.ok(S1.actors.some((x) => x.behavior.roundBot.pk >= 0), 'the save is past the latch');
  console.log(`first post-plant tick on this machine: ${plantMs.join(', ')} ms`);
});
