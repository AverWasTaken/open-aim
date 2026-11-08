// Round mode R3: the attacker bots (defense side: the player defends, 5 roundBot attackers wait behind
// their barriers, stage on their plan route, go together, the carrier plants, the rest hold post-plant
// spots; a dropped spike is fetched and replanted). app/mods/aim-rounds/round-bots.mjs "R3" section.
// Pure checks with the real Ascent nav (no sim), then the real patched sim on Ascent's REAL collision
// (scripts/round-bots-sweep.mjs defenseDoc / attackRun; needs the game files in site/, else skipped).
// The attack side (defenders) is unchanged: test-round-bots*.mjs cover it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(root, 'app', 'mods');
const bots = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-bots.mjs')).href);
const SW = await import(pathToFileURL(path.join(root, 'scripts', 'round-bots-sweep.mjs')).href);
const { terrainSources, loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
const { buildDoc, SIDES } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
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

const TPS = SW.TPS, IDLE = SW.IDLE, ASCENT = SW.ASCENT, I = bots.roundBotsInternals, MODE = I.MODE, GK = I.GK;
const useNav = SW.useNav;
const fakeRng = (u = 0.5) => ({ range: (a, b) => a + (b - a) * u });
// Plan seeds (roundPrepare of the defense doc; checked below): site, lurker.
const PLAN = { A: 2, A_LURK: 12, B: 1, B_LURK: 11, A_MID: 13 };

// ---------------------------------------------------------------- pure (real nav, no sim)
// The 5 attackers of a prepared defense doc at their spawners (the attacker spawns), initialised in
// the barrier phase; ctxAt builds a tick's ctx with the snapshot of all of them.
function team(planSeed, { barrierSec = 20 } = {}) {
  const N = useNav(), doc = SW.defenseDoc({ barrierSec, planSeed }), r = doc.rules.round;
  const state = { phase: 'barrier', side: 'defense', tick: 0, liveTick: 0, plantTick: -1, spike: { carrier: null, dropped: null, planted: null }, playerAlive: true, botPlant: 0 };
  const actors = doc.spawners.map((sp, i) => {
    const a = { id: i + 1, spawnerId: sp.id, alive: true, position: { ...sp.position }, offset: { x: 0, y: 0, z: 0 }, behavior: { shooter: { lastSeenTick: -1 } }, rng: fakeRng() };
    bots.roundBotInit({}, a, { tick: 1, elapsed: 1 / TPS, round: { cfg: r, state, bots: null }, profile: { runSpeed: 5.4 }, target: { eye: { x: 0, y: 0, z: 0 }, canSee: () => false } });
    return a;
  });
  const ctxAt = (tick) => ({ tick, elapsed: tick / TPS, round: { cfg: r, state, bots: bots.aimRoundBotList(actors) }, profile: { runSpeed: 5.4 }, target: { eye: { x: 0, y: 0, z: 0 }, canSee: () => false } });
  const tickAll = (tick, il = () => {}) => { const ctx = ctxAt(tick); for (const a of actors) bots.roundBotUpdate({}, a, ctx, 1 / TPS, il); return ctx; };
  const place = (a, k) => { const g = N.g; a.position = { x: g.x[k], y: g.y[k], z: g.z[k] }; a.behavior.roundBot.cur = k; };
  return { N, doc, r, plan: r.attack, A: I.atkData(N, r), state, actors, ctxAt, tickAll, place };
}

test('R3 defense scene: buildDoc adds the map\'s attack data on the defense side only; defense is a lobby side (SIDES); this file runs on Ascent', () => {
  assert.equal(SW.MAP, 'ascent', 'round-bots-sweep.mjs MAP must be ascent here (unset ROUND_MAP / --map)');
  const d = buildDoc(ASCENT, { side: 'defense', weapon: 'vandal', barrierSec: 20 }).rules.round;
  assert.deepEqual(d.attackData, ASCENT.attack);
  assert.equal('attackData' in buildDoc(ASCENT, { side: 'attack', weapon: 'vandal', barrierSec: 20 }).rules.round, false);
  assert.deepEqual(SIDES, ['attack', 'defense']);
  for (const [k, site, lurk] of [['A', 'A', false], ['A_LURK', 'A', true], ['B', 'B', false], ['B_LURK', 'B', true], ['A_MID', 'A', null]]) {
    const a = SW.defenseDoc({ planSeed: PLAN[k] }).rules.round.attack;
    assert.equal(a.site, site, `plan seed ${k}`);
    if (lurk !== null) assert.equal(a.lurker !== null, lurk, `plan seed ${k} lurker`);
  }
});

test('R3 init: every attacker on the nav with its plan route; staging slots distinct; the lurker on the other route; clear spots distinct; barrier wait slots; the attack side has no attacker state', () => {
  for (const seed of [PLAN.A, PLAN.A_LURK, PLAN.B, PLAN.B_LURK]) {
    const { N, plan, A, actors } = team(seed), g = N.g;
    assert.ok(A && A.routes.length === 2 && A.plant.length === 2, `seed ${seed}: plan-site data`);
    const slots = new Set(), clears = new Map(), waits = new Set(), byRoute = new Map();
    for (const a of actors) {
      const s = a.behavior.roundBot, tag = `seed ${seed} ${a.spawnerId}`;
      assert.equal(s.nav, 1, `${tag}: nav`); assert.equal(s.atk, 1, `${tag}: attacker`);
      assert.equal(A.routes[s.ri].name, plan.routeBySpawner[a.spawnerId], `${tag}: plan route`);
      const key = `${s.goal}|${s.stopT}`;
      assert.ok(!slots.has(key), `${tag}: slot ${key} shared`); slots.add(key);
      assert.equal(s.stopT, 0, `${tag}: a slot node (room around the staging points)`);
      const near = A.routes[s.ri].staging.map((n) => Math.hypot(g.x[n] - g.x[s.goal], g.z[n] - g.z[s.goal]));
      assert.ok(Math.min(...near) <= 4, `${tag}: slot within 4 m of a staging point of its route`);
      const rl = byRoute.get(s.ri) ?? []; rl.push(s); byRoute.set(s.ri, rl);
      assert.equal(s.lurk, plan.lurker === a.spawnerId ? 1 : 0);
      assert.ok(s.wait >= 0, `${tag}: staging beyond the attacker barrier -> a wait node`);
      assert.equal(s.waitT, 0, `${tag}: a wait slot node`);
      assert.ok(!waits.has(s.wait), `${tag}: wait slot shared`); waits.add(s.wait);
      if (a.spawnerId !== plan.carrierSpawner) { assert.ok(s.ci >= 0, `${tag}: clear spot`); assert.ok(!clears.has(s.ci), `${tag}: clear spot shared`); clears.set(s.ci, a.spawnerId); }
      for (const [k, v] of Object.entries(s)) assert.ok(typeof v === 'number' || typeof v === 'boolean', `${tag}: flat state ${k}`);
      assert.ok(Math.hypot(g.x[s.spawn] - a.position.x, g.z[s.spawn] - a.position.z) < 1.5, 'no teleport');
    }
    // Clear spots stay on / around the plan site (Ascent B: the site-area setups; clear:false keeps the
    // CT, link, market door and B Main spots out), within 16 m of the site centre.
    const sc = ASCENT.sites.find((x) => x.id === plan.site).center;
    for (const k of A.clear) assert.ok(Math.hypot(g.x[k] - sc.x, g.z[k] - sc.z) <= 16, `seed ${seed}: clear node ${k} ${Math.hypot(g.x[k] - sc.x, g.z[k] - sc.z).toFixed(1)} m from site ${plan.site}`);
    for (const [ri, list] of byRoute) for (const p of list) for (const q of list) if (p !== q) {
      assert.ok(Math.hypot(g.x[p.goal] - g.x[q.goal], g.z[p.goal] - g.z[q.goal]) >= 1.2 - 1e-9, `seed ${seed} route ${ri}: staging slots >= 1.2 m apart`);
      assert.ok(Math.hypot(g.x[p.wait] - g.x[q.wait], g.z[p.wait] - g.z[q.wait]) >= 1.2 - 1e-9, `seed ${seed} route ${ri}: wait slots >= 1.2 m apart`);
    }
    if (plan.lurker) {
      const l = actors.find((a) => a.spawnerId === plan.lurker).behavior.roundBot;
      assert.ok(actors.filter((a) => a.spawnerId !== plan.lurker).every((a) => a.behavior.roundBot.ri !== l.ri), 'the lurker takes the other route');
    }
  }
  // Attack side: the defenders' init never takes the attacker branch.
  const doc = buildDoc(ASCENT, { side: 'attack', weapon: 'vandal', barrierSec: 20 }), r = doc.rules.round;
  const sid = Object.keys(r.setupBySpawner)[0], s = r.setupBySpawner[sid];
  const a = { id: 1, spawnerId: sid, alive: true, position: { x: s.x, y: s.y, z: s.z }, offset: { x: 0, y: 0, z: 0 }, behavior: {}, rng: fakeRng() };
  bots.roundBotInit({}, a, { tick: 1, elapsed: 1 / TPS, round: { cfg: r, state: { phase: 'barrier' }, bots: null }, target: { eye: { x: 0, y: 0, z: 0 } } });
  assert.equal(a.behavior.roundBot.nav, 1);
  assert.equal('atk' in a.behavior.roundBot, false);
});

test('R3 fallbacks: no nav / no plan / no plan site -> static at the spawn (faces the player), never plants', () => {
  const runFallback = (prep) => {
    const doc = SW.defenseDoc({ planSeed: PLAN.B }), r = doc.rules.round;
    prep(r);
    const state = { phase: 'live', side: 'defense', liveTick: 0, spike: { carrier: 1, dropped: null, planted: null }, playerAlive: true };
    const sp = doc.spawners[0], a = { id: 1, spawnerId: sp.id, alive: true, position: { ...sp.position }, offset: { x: 0, y: 0, z: 0 }, behavior: {}, rng: fakeRng() };
    const ctx = { tick: 1, elapsed: 1 / TPS, round: { cfg: r, state, bots: null }, target: { eye: { x: 0, y: 1.6, z: 0 } } };
    bots.roundBotInit({}, a, ctx);
    for (let t = 2; t < 40; t++) { ctx.tick = t; ctx.elapsed = t / TPS; bots.roundBotUpdate({}, a, ctx, 1 / TPS, () => assert.fail('no il')); }
    assert.equal(a.behavior.roundBot.nav, 0); assert.equal(a.behavior.roundBot.mode, MODE.static);
    assert.deepEqual(a.position, sp.position);
    assert.equal(bots.aimRoundIoBots([a])[0].planting, 0);
  };
  globalThis.__aimRoundNav = {};
  runFallback(() => {});
  useNav();
  runFallback((r) => { delete r.attack; });
  runFallback((r) => { r.attack.site = null; });
  runFallback((r) => { r.attack.site = 'C'; });
});

test('R3 go: not before the gather time while bots are still out; every bot latches it on the same tick (gather time + half staged / 15 s cap / all staged / any go in the snapshot)', () => {
  const go = (t) => t.actors.map((a) => a.behavior.roundBot.go);
  // Ticks only the living bots (the sim doesn't update dead actors); the snapshot keeps the dead ones
  // with alive false, like aimRoundBotList does.
  const tickLiving = (t, tick) => { const ctx = t.ctxAt(tick); for (const a of t.actors) if (a.alive) bots.roundBotUpdate({}, a, ctx, 1 / TPS, () => {}); };
  // Gather time with ceil(5/2) - 1 = 2 of 5 members staged: no go, until the 15 s cap.
  let t = team(PLAN.A);
  assert.equal(t.plan.lurker, null, 'plan A has no lurker: 5 members');
  t.state.phase = 'live';
  const g0 = Math.ceil(t.plan.gatherSec * TPS), cap = Math.ceil((t.plan.gatherSec + 15) * TPS);
  for (const a of t.actors.slice(0, 2)) t.place(a, a.behavior.roundBot.goal);
  for (const k of [1, 2, g0 - 1, g0, g0 + 1, cap - 1]) { t.tickAll(k); assert.deepEqual(go(t), [0, 0, 0, 0, 0], `2 of 5 staged, tick ${k}`); }
  assert.deepEqual(t.actors.map((a) => a.behavior.roundBot.atStage), [1, 1, 0, 0, 0], '2 of 5 staged');
  t.tickAll(cap);
  assert.deepEqual(go(t), [1, 1, 1, 1, 1], 'all at gatherSec + 15 s (cap)');
  // Nobody staged at all: the cap alone.
  t = team(PLAN.A);
  t.state.phase = 'live';
  for (const k of [g0, cap - 1]) { t.tickAll(k); assert.deepEqual(go(t), [0, 0, 0, 0, 0], `0 staged, tick ${k}`); }
  t.tickAll(cap);
  assert.deepEqual(go(t), [1, 1, 1, 1, 1], '0 staged: the cap');
  // ceil(5/2) = 3 staged: no go before the gather time, then all 5 on the gather tick.
  t = team(PLAN.A);
  t.state.phase = 'live';
  for (const a of t.actors.slice(1, 4)) t.place(a, a.behavior.roundBot.goal);
  for (const k of [1, 2, g0 - 1]) { t.tickAll(k); assert.deepEqual(go(t), [0, 0, 0, 0, 0], `3 of 5 staged, tick ${k}`); }
  t.tickAll(g0);
  assert.deepEqual(go(t), [1, 1, 1, 1, 1], '3 of 5 staged: all at the gather time');
  // Deaths shrink the count: 2 of 5 dead -> 3 members, ceil(3/2) = 2 staged is enough at the gather time.
  t = team(PLAN.A);
  t.state.phase = 'live';
  t.actors[3].alive = false; t.actors[4].alive = false;
  for (const a of t.actors.slice(0, 2)) t.place(a, a.behavior.roundBot.goal);
  for (const k of [1, 2, g0 - 1]) { tickLiving(t, k); assert.deepEqual(go(t).slice(0, 3), [0, 0, 0], `2 of 3 staged, tick ${k}`); }
  tickLiving(t, g0);
  assert.deepEqual(go(t).slice(0, 3), [1, 1, 1], '2 of 3 living staged: all living at the gather time');
  // All staged (members only: the lurker doesn't count): staged this tick -> go on the next.
  t = team(PLAN.A_LURK);
  t.state.phase = 'live';
  for (const a of t.actors) if (a.spawnerId !== t.plan.lurker) t.place(a, a.behavior.roundBot.goal);
  t.tickAll(2);
  assert.deepEqual(go(t), [0, 0, 0, 0, 0]);
  assert.ok(t.actors.every((a) => a.behavior.roundBot.atStage === (a.spawnerId === t.plan.lurker ? 0 : 1)), 'members at their slots');
  t.tickAll(3);
  assert.deepEqual(go(t), [1, 1, 1, 1, 1], 'go on the next tick, lurker included');
  // One bot with go in the snapshot -> everyone.
  t = team(PLAN.B);
  t.state.phase = 'live';
  t.tickAll(2);
  t.actors[3].behavior.roundBot.go = 1;
  t.tickAll(3);
  assert.deepEqual(go(t), [1, 1, 1, 1, 1]);
  // Barrier phase: never.
  t = team(PLAN.B);
  t.tickAll(Math.ceil(30 * TPS));
  assert.deepEqual(go(t), [0, 0, 0, 0, 0], 'no go in the barrier phase');
});

test('R3 plant handshake: the carrier at its plant node plants (planting 1, hands busy, io defusing 0), holds it without moving, lets go when it loses the spike; in combat only when time is short', () => {
  const setup = () => {
    const t = team(PLAN.B), a = t.actors[0];
    t.state.phase = 'live'; t.state.spike.carrier = a.id;
    for (const b of t.actors) b.behavior.roundBot.go = 1;
    t.place(a, t.A.plant[0].node);
    return { t, a };
  };
  const T0 = TPS; // past the spawn stagger (<= 0.6 s)
  let { t, a } = setup();
  t.tickAll(T0);
  const s = a.behavior.roundBot;
  assert.equal(s.pi, 0); assert.equal(s.gk, GK.plant);
  assert.equal(s.planting, 1, 'planting'); assert.equal(a.roundDefusing, 1, 'hands busy'); assert.equal(s.mode, MODE.plant);
  assert.deepEqual(bots.aimRoundIoBots([a]).map((e) => [e.planting, e.defusing]), [[1, 0]]);
  assert.equal(I.zoneAt(t.r, a.position.x, a.position.y, a.position.z), 'B');
  let moved = 0;
  for (let k = T0 + 1; k < T0 + 40; k++) t.tickAll(k, (st, o, who) => { if (who === a) moved++; });
  assert.equal(moved, 0, 'no il while planting'); assert.equal(s.planting, 1);
  t.state.spike.carrier = t.actors[1].id;
  t.tickAll(T0 + 40);
  assert.equal(s.planting, 0, 'let go: not the carrier'); assert.equal(a.roundDefusing, 0);
  assert.equal(bots.aimRoundIoBots([a])[0].planting, 0);
  // Killed while planting: io planting 0.
  ({ t, a } = setup());
  t.tickAll(T0); assert.equal(a.behavior.roundBot.planting, 1);
  a.alive = false; t.tickAll(T0 + 1);
  assert.equal(bots.aimRoundIoBots([a])[0].planting, 0); assert.equal(a.behavior.roundBot.planting, 0);
  // Combat: waits, unless time left < plantSec + 3 s.
  ({ t, a } = setup());
  a.combatHold = 1;
  t.tickAll(T0);
  assert.equal(a.behavior.roundBot.planting, 0, 'not while in combat');
  t.state.liveTick = T0 - Math.round(94 * TPS); // 6 s left (< 4 + 3)
  t.tickAll(T0 + 1);
  assert.equal(a.behavior.roundBot.planting, 1, 'time pressure: plants under fire');
});

test('R3 fetch data: the goal set is attacker-reachable nodes within 1.0 m xz / |dy| < 1.8 of the spike; an unreachable crate top -> lost (no field); LRU bounded', () => {
  const N = useNav(), g = N.g, cfg = SW.defenseDoc({ planSeed: PLAN.A }).rules.round, R = I.reachUnion(N, cfg);
  const k = I.atkData(N, cfg).plant[0].node, sp = { x: g.x[k] + 0.3, y: g.y[k], z: g.z[k] - 0.2 };
  const d = I.fetchData(N, cfg, sp);
  assert.ok(d.set.length > 0 && d.field);
  for (const n of d.set) assert.ok(Math.hypot(g.x[n] - sp.x, g.z[n] - sp.z) <= 1 && Math.abs(g.y[n] - sp.y) < 1.8 && R[n] === 1);
  assert.equal(I.fetchData(N, cfg, sp), d, 'cached');
  for (const bad of N.header.zones.A.bad) {
    const l = I.fetchData(N, cfg, { x: bad[0], y: bad[1], z: bad[2] });
    assert.equal(l.field, null, `unreachable crate top ${bad}: lost`);
  }
  for (let i = 0; i < 12; i++) I.fetchData(N, cfg, { x: sp.x + i * 0.1, y: sp.y, z: sp.z });
  assert.ok(I.fetchCacheSize(N) <= I.FETCH_LRU);
});

test('R3 post-plant latch: the planter first, then by id -> the plant spot\'s post-plant spots (distinct); the 5th holds its clear spot', () => {
  const t = team(PLAN.A), k = t.A.plant[1].node, g = t.N.g;
  t.state.phase = 'planted'; t.state.plantTick = 50; t.state.spike.planted = { x: g.x[k], y: g.y[k] + 0.0, z: g.z[k], site: 'A' };
  t.actors[3].behavior.roundBot.planting = 1; // the snapshot shows bot 4 planting
  t.tickAll(51);
  const spots = t.A.post[1], pn = t.actors.map((a) => a.behavior.roundBot.pn);
  assert.equal(spots.length, 4);
  assert.deepEqual(pn, [spots[1], spots[2], spots[3], spots[0], -1]);
  assert.equal(t.actors[4].behavior.roundBot.gk, t.actors[4].behavior.roundBot.ci >= 0 ? GK.clear : GK.astage, 'overflow: its clear spot');
  for (const a of t.actors.slice(0, 4)) assert.equal(a.behavior.roundBot.gk, GK.post);
  assert.equal(t.actors[3].behavior.roundBot.planting, 0, 'the planter let go (planted)');
});

// ---------------------------------------------------------------- real sim on Ascent's collision
const run = async (o) => SW.attackRun({ sim, W: await terrain(), ...o });
function checkRun(m, label, { plant = true } = {}) {
  const tag = `${label} [plan ${m.plan.site} seed ${m.seed}]`;
  assert.equal(m.bots, 5, `${tag}: 5 bots`);
  assert.equal(m.nav, true, `${tag}: every bot on the nav`);
  assert.equal(m.routeOk, true, `${tag}: routes from cfg.attack (the plan reached the bots)`);
  assert.equal(m.crossings, 0, `${tag}: crossed an attacker barrier in the barrier phase`);
  assert.equal(m.outside, 0, `${tag}: left the attacker side in the barrier phase`);
  assert.equal(m.offFloor, 0, `${tag}: off the nav floors ${JSON.stringify(m.offFloorAt)}`);
  assert.equal(m.waitSeen, true, `${tag}: waited behind the barrier`);
  assert.equal(m.stuck, 0, `${tag}: stuck bots`);
  assert.ok(m.minStill >= 0.8, `${tag}: two standing bots ${m.minStill.toFixed(2)} m apart`);
  assert.ok(m.maxPlanters <= 1, `${tag}: planters on one tick`);
  assert.equal(m.plantingNotCarrier, 0, `${tag}: a non-carrier planting`);
  assert.equal(m.seen, 0, `${tag}: the hidden player was seen`);
  assert.ok(m.go >= 0, `${tag}: go`);
  if (plant) {
    assert.ok(m.plant >= 0, `${tag}: planted`);
    assert.ok(m.plantAfterLive <= 40, `${tag}: planted ${m.plantAfterLive} s after the drop`);
    assert.equal(m.plantSite, m.plan.site, `${tag}: planted on the plan site`);
    assert.ok(m.plantNodeDist < 0.1, `${tag}: spike ${m.plantNodeDist} m from a plant spot`);
    assert.ok(m.planter !== null, `${tag}: a bot stands on the spike (bot plant)`);
    assert.ok(m.post && m.post.assigned === Math.min(m.post.alive, m.post.spots) && m.post.distinct === m.post.assigned && m.post.held === m.post.assigned, `${tag}: post-plant spots ${JSON.stringify(m.post)}`);
  }
}

test('R3 real Ascent: A and B, both movement modes, with and without a lurker: wait behind the barriers (never across), stage, go together, plant within 40 s of the drop on the plan site, hold distinct post-plant spots', { skip }, async () => {
  const cases = [
    { planSeed: PLAN.A, barrierSec: 10, extra: {} },
    { planSeed: PLAN.A_LURK, barrierSec: 20, extra: { movement: 'game' } },
    { planSeed: PLAN.B, barrierSec: 10, extra: { movement: 'game' } },
    { planSeed: PLAN.B_LURK, barrierSec: 30, extra: {} },
  ];
  for (const c of cases) {
    const m = await run({ doc: SW.defenseDoc(c), seed: 3, extra: c.extra });
    checkRun(m, `${c.extra.movement ?? 'default'} barrier ${c.barrierSec}`);
    if (m.plan.lurker === null) assert.equal(m.members, 5);
    console.log(`plan ${m.plan.site} seed ${c.planSeed} (${c.extra.movement ?? 'default'}, barrier ${c.barrierSec}): go ${m.goAfterLive} s after the drop (${m.stagedAtGo}/${m.members} staged, gather ${m.plan.gatherSec}), planted ${m.plantAfterLive} s after the drop, post ${JSON.stringify(m.post)}, lurker staged ${m.lurkerStaged}, first ticks ${m.firstMs.toFixed(1)} ms`);
  }
});

test('R3 real Ascent: carrier killed on the way (with everyone within 5 m of it) -> the latched fetcher walks >= 3 m, picks it up and plants (B "game" movement; A with the lurker fetching)', { skip }, async () => {
  for (const c of [{ planSeed: PLAN.B, barrierSec: 10, extra: { movement: 'game' } }, { planSeed: PLAN.A_LURK, barrierSec: 20, extra: {} }]) {
    const m = await run({ doc: SW.defenseDoc(c), seed: 3, extra: c.extra, kill: 'route' });
    const tag = `route kill plan ${m.plan.site}`;
    assert.ok(m.killed, `${tag}: the carrier was killed on its way`);
    assert.equal(m.drops.length, 1, `${tag}: one drop`);
    assert.equal(m.pickups.length, 1, `${tag}: picked up`);
    assert.equal(m.pickups[0].id, m.fetcher, `${tag}: the new carrier is the latched fetcher`);
    assert.ok(m.fetchWalk >= 3, `${tag}: fetcher walked ${m.fetchWalk} m`);
    checkRun(m, tag);
    console.log(`${tag}: killed ${1 + m.killed.also.length}, fetch walk ${m.fetchWalk} m, planted ${m.plantAfterLive} s after the drop; spike-drop tick ${m.dropMs.toFixed(1)} ms`);
  }
});

test('R3 real Ascent: carrier killed mid-plant -> the spike drops at the plant spot, a bot fetches it and replants (A, B)', { skip }, async () => {
  for (const c of [{ planSeed: PLAN.A_MID, barrierSec: 30, extra: {} }, { planSeed: PLAN.B, barrierSec: 10, extra: { movement: 'game' } }]) {
    const m = await run({ doc: SW.defenseDoc(c), seed: 3, extra: c.extra, kill: 'midplant' });
    const tag = `mid-plant kill plan ${m.plan.site}`;
    assert.ok(m.killed && m.botPlantBeforeKill > 0, `${tag}: killed with plant progress ${m.botPlantBeforeKill}`);
    assert.equal(m.drops.length, 1);
    assert.ok(Math.hypot(m.drops[0].at.x - m.killed.at.x, m.drops[0].at.z - m.killed.at.z) < 0.05, `${tag}: dropped where it died`);
    assert.equal(m.pickups.length, 1);
    assert.equal(m.pickups[0].id, m.fetcher, `${tag}: the fetcher picked it up`);
    assert.notEqual(m.planter, m.killed.id);
    checkRun(m, tag);
    console.log(`${tag}: progress ${m.botPlantBeforeKill} ticks, fetch walk ${m.fetchWalk} m, replanted ${m.plantAfterLive} s after the drop; spike-drop tick ${m.dropMs.toFixed(1)} ms`);
  }
});

test('R3 real Ascent: spike dropped where no bot can reach (a stacked-crate top) -> lost: everyone holds a distinct clear spot, nobody stuck, nobody picks it up', { skip }, async () => {
  const N = useNav(), g = N.g, bad = N.header.zones.A.bad[1];
  let phase = 0;
  const m = await run({
    doc: SW.defenseDoc({ planSeed: PLAN.A, barrierSec: 10 }), seed: 5, maxSec: 48,
    onTick: (s, st, mm, info) => {
      // Kill the carrier with its body on the crate top: round-core drops the spike at the dead entry.
      if (phase === 0 && mm.go >= 0 && info.tick >= mm.go + 2 * TPS && st.aimRound.spike.carrier !== null) {
        const c = st.actors.find((a) => a.id === st.aimRound.spike.carrier); c.alive = false; c.health = 0; c.position = { x: bad[0], y: bad[1], z: bad[2] }; s.restoreState(st); phase = 1; return;
      }
      if (phase === 1 && st.aimRound.spike.dropped) phase = 2;
    },
  });
  assert.equal(phase, 2, 'killed + moved the spike');
  const fin = m.s.saveState(), alive = fin.actors.filter((a) => a.alive);
  assert.deepEqual(fin.aimRound.spike.dropped, { x: bad[0], y: bad[1], z: bad[2] }, 'still lying there');
  assert.equal(m.stuck, 0);
  const cis = alive.map((a) => a.behavior.roundBot.ci);
  assert.equal(new Set(cis).size, alive.length, 'distinct clear spots');
  for (const a of alive) {
    const b = a.behavior.roundBot;
    assert.equal(b.lost, 1); assert.equal(b.fetch, -1); assert.equal(b.gk, GK.clear);
    assert.equal(b.mode, MODE.cover, `bot ${a.id} holds its clear spot`);
    assert.ok(Math.hypot(a.position.x - g.x[b.ci], a.position.z - g.z[b.ci]) < 0.3);
  }
});

test('R3 real Ascent: the player in sight (idle on the plan site): the attackers fight (shots, combat brake), nobody stuck or off the floor, the round ends by kills', { skip }, async () => {
  const N = useNav(), g = N.g;
  for (const c of [{ planSeed: PLAN.A, barrierSec: 10, extra: {} }, { planSeed: PLAN.B, barrierSec: 10, extra: { movement: 'game', enemyRank: 'gold' } }]) {
    const doc = SW.defenseDoc(c), k = g.header.siteGoals[doc.rules.round.attack.site].node;
    const m = await run({ doc, seed: 7, extra: c.extra, hide: false, at: { x: g.x[k], y: g.y[k], z: g.z[k] }, maxSec: 80 });
    const tag = `visible player plan ${m.plan.site}`;
    assert.ok(m.seen > 0 && m.shots > 0, `${tag}: the bots saw (${m.seen}) and shot (${m.shots})`);
    assert.equal(m.crossings, 0); assert.equal(m.outside, 0);
    assert.equal(m.stuck, 0, `${tag}: stuck ${JSON.stringify(m.stuckAt)}`);
    assert.equal(m.offFloor, 0, `${tag}: off the floor ${JSON.stringify(m.offFloorAt)}`);
    assert.ok(m.maxPlanters <= 1 && m.plantingNotCarrier === 0);
    assert.ok(m.outcome === 'died' || m.plant >= 0, `${tag}: ended by kills or planted (outcome ${m.outcome})`);
    console.log(`${tag}: seen ${m.seen} ticks, ${m.shots} shots, outcome ${m.outcome}, planted ${m.plant >= 0 ? m.plantAfterLive : '-'}`);
  }
});

// S4: the defending player against a real bot plant (save -> edit -> restore after the plant).
// killAll: every attacker dead (alive false, round-core's enemiesDead = enemyCount). The player
// stands 0.3 m from the spike (any facing counts that close). Hold use with s.setRoundHold after the
// restore (a restore clears the held keys).
function afterPlant(m, { killAll = true } = {}) {
  const s = m.s, st = s.saveState(), r = st.aimRound, sp = r.spike.planted;
  assert.equal(r.phase, 'planted', 'planted');
  if (killAll) {
    for (const a of st.actors) if (a.behavior?.roundBot) { a.alive = false; a.health = 0; }
    r.enemiesDead = 5;
  }
  st.player.position = { x: sp.x + 0.3, y: sp.y + 0.02, z: sp.z };
  s.restoreState(st);
  return s;
}
const stepUntil = (s, maxSec, fn) => {
  for (let i = 0; i < maxSec * TPS; i++) { s.step(IDLE); const r = s.saveState().aimRound; if (fn(r) || r.phase === 'ended') return r; }
  return s.saveState().aimRound;
};

test('S4 real Ascent: defending against a bot plant: every attacker dead after the plant -> the round goes on; hold use at the spike -> defused in 7 s with the 3.5 s checkpoint (win); no hold -> detonated (loss)', { skip }, async () => {
  for (const planSeed of [PLAN.A, PLAN.B]) {
    // Defuse.
    let m = await run({ doc: SW.defenseDoc({ planSeed, barrierSec: 10 }), seed: 3, postSec: 3 });
    assert.ok(m.plant >= 0, `plan ${m.plan.site}: the bots planted`);
    let s = afterPlant(m);
    let r = stepUntil(s, 1, () => false);
    assert.equal(r.phase, 'planted', 'all attackers dead after the plant: still planted');
    assert.equal(r.playerAlive, true); assert.equal(r.near, true, 'at the spike');
    assert.equal(r.defuse, 0, 'no defuse without the key');
    s.setRoundHold({ use: true });
    const t0 = r.tick;
    let cp = -1;
    r = stepUntil(s, 9, (q) => { if (cp < 0 && q.checkpoint) cp = q.tick; return false; });
    s.setRoundHold({ use: false });
    assert.equal(r.reason, 'defused', `plan ${m.plan.site}: ${r.reason}`); assert.equal(r.winner, 'defense');
    const ts = 1 / TPS, took = (r.endTick - t0) * ts, cpAt = (cp - t0) * ts;
    assert.ok(took >= 7 - 1e-9 && took <= 7.3, `defuse took ${took} s`);
    assert.ok(cpAt >= 3.5 - 1e-9 && cpAt <= 3.8, `checkpoint at ${cpAt} s`);
    assert.equal(s.snapshot().round.win, true, 'view: win');
    const took1 = took, cp1 = cpAt;
    // Detonation.
    m = await run({ doc: SW.defenseDoc({ planSeed, barrierSec: 10 }), seed: 3, postSec: 3 });
    s = afterPlant(m);
    r = stepUntil(s, 47, () => false);
    assert.equal(r.reason, 'detonated', `plan ${m.plan.site}: no hold -> ${r.reason}`); assert.equal(r.winner, 'attack');
    const boom = (r.endTick - m.plant) / TPS;
    assert.ok(Math.abs(boom - 45) < 0.05, `detonated ${boom} s after the plant`);
    console.log(`defense plan ${m.plan.site}: defused in ${took1.toFixed(2)} s (checkpoint ${cp1.toFixed(2)} s); no hold: detonated at +${boom.toFixed(2)} s`);
  }
});

test('S4 real Ascent: the defending player at the spike in sight of the living attackers (post-plant spots) -> killed: "died" (loss)', { skip }, async () => {
  for (const planSeed of [PLAN.A, PLAN.B]) {
    const m = await run({ doc: SW.defenseDoc({ planSeed, barrierSec: 10 }), seed: 3, postSec: 10 });
    assert.ok(m.plant >= 0, 'planted');
    const s = afterPlant(m, { killAll: false });
    const r = stepUntil(s, 46, () => false);
    assert.equal(r.reason, 'died', `plan ${m.plan.site}: ${r.reason}`); assert.equal(r.winner, 'attack'); assert.equal(r.playerAlive, false);
    console.log(`defense plan ${m.plan.site}: player at the spike died ${((r.endTick - m.plant) / TPS).toFixed(2)} s after the plant`);
  }
});

test('R3 real Ascent: determinism: restore after the go / while planting -> the same run; cold caches -> the same run', { skip }, async () => {
  const W = await terrain();
  useNav();
  const s = sim.c(SW.defenseDoc({ planSeed: PLAN.A_LURK, barrierSec: 10 }), { sensitivity: 1, zoomSensitivity: 1, seed: 21, terrain: W });
  const runN = (n) => { const out = []; for (let i = 0; i < n; i++) out.push(JSON.stringify(s.step(IDLE)), JSON.stringify(s.snapshot().actors)); return out.join('\n') + JSON.stringify(s.saveState()); };
  let S0 = null, S1 = null;
  for (let i = 0; i < 60 * TPS && !S1; i++) {
    s.step(IDLE);
    const st = s.saveState();
    if (!S0 && st.actors.some((a) => a.behavior.roundBot.go === 1)) S0 = st;
    if (st.actors.some((a) => a.behavior.roundBot.planting === 1) && st.aimRound.botPlant > 64) S1 = st;
  }
  assert.ok(S0 && S1, 'reached the go and a plant in progress');
  s.restoreState(S0);
  const a = runN(3 * TPS);
  s.restoreState(S0);
  assert.ok(runN(3 * TPS) === a, 'restore after the go replays the same');
  I.resetCaches(); useNav();
  s.restoreState(S0);
  assert.ok(runN(3 * TPS) === a, 'cold caches: same run');
  s.restoreState(S1);
  const b = runN(4 * TPS);
  s.restoreState(S1);
  assert.ok(runN(4 * TPS) === b, 'restore mid-plant replays the same (plant completes the same)');
  assert.ok(s.saveState().aimRound.spike.planted, 'planted within the replay');
});
