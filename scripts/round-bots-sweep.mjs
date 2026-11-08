// Round mode bots, retake sweep on Ascent's REAL collision (tools/round_terrain.mjs) with the real
// nav graph and the real patched sim: N seeds x both sites x barrier 10/20 s x player hidden-alive
// (at the attacker spawn) / dead. Each run: defenders walk from their spawns to their setups, the
// barriers drop, the spike is planted (forced: save -> edit -> restore of the round state, on a
// seeded plant-zone spot incl. crate tops), and the round plays out. Reports per run and in total:
// retake arrival (defuse candidate at the spike), defuse start / finish (s after the plant, vs the
// 45 s spike), stuck bots, barrier crossings (must be 0), fires while defusing (must be 0), outcome.
// Split, rank and movement mode vary with the seed.
//
// Heavy (about 6 s per run on hp): run it on hp only, one CPU job at a time:
//   node scripts/round-bots-sweep.mjs [--seeds 6] [--out /tmp/round-bots-sweep.json] [--max-min 9]
// (npm run sweep:round-bots in app/). scripts/test-round-bots-real.mjs imports retakeRun from here.
// --defense: the R3 attacker bots instead (defenseMain below; scripts/test-round-bots-attack.mjs
// imports defenseDoc / attackRun from here).
import fs from 'node:fs';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(root, 'app', 'mods');
const bots = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-bots.mjs')).href);
const core = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-core.mjs')).href);
const navlib = await import(pathToFileURL(path.join(root, 'tools', 'round_navlib.mjs')).href);
const I = bots.roundBotsInternals;
export const TPS = 128;
export const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
export const ASCENT = JSON.parse(fs.readFileSync(path.join(MODS, 'aim-rounds', 'ascent.json'), 'utf-8'));
export const { buildDoc } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
const NAV_BYTES = fs.readFileSync(path.join(MODS, 'aim-rounds', 'ascent.nav.bin'));
const NAV_AB = NAV_BYTES.buffer.slice(NAV_BYTES.byteOffset, NAV_BYTES.byteOffset + NAV_BYTES.byteLength);
export const useNav = () => { globalThis.__aimRoundNav = { ascent: NAV_AB }; return I.navFor('ascent'); };
const DEF_BARS = ASCENT.barriers.filter((b) => b.team === 'defense');
const crossesBar = (a, b) => DEF_BARS.some((w) => navlib.segCross(a.x, a.z, b.x, b.z, w.a.x, w.a.z, w.b.x, w.b.z));
const STOPPED = new Set([I.MODE.hold, I.MODE.wait, I.MODE.stage, I.MODE.cover, I.MODE.defuse]);
export const HIDE = { ...ASCENT.spawns.attack[0] }; // the attacker spawn: out of every defender's sight

// The real round scene (Ascent collision only). set = kept setup names (forced), atSetups = bots
// start on their setups (no walk from the spawn), rank / movement go to the sim options.
export function realDoc({ barrierSec = 20, set = null, atSetups = false } = {}) {
  const doc = buildDoc(ASCENT, { side: 'attack', weapon: 'vandal', barrierSec });
  const r = doc.rules.round;
  if (set) {
    const byName = Object.fromEntries(Object.entries(r.setupBySpawner).map(([id, s]) => [s.name, id]));
    const ids = set.map((n) => byName[n]);
    if (!ids.every(Boolean)) throw new Error(`setup names ${set}`);
    r.setups = { groups: { all: ids }, splits: [[ids.length]], count: ids.length };
    doc.spawners = doc.spawners.filter((s) => ids.includes(s.id));
  }
  if (atSetups) delete r.botStart;
  return doc;
}

// Plant-zone spots of a site = nav nodes inside its zone (all floors, crate tops too); box = the
// node stands >= 0.8 m above the lowest node within 1 m xz.
export function zoneSpots(N, site) {
  const g = N.g, cfg = { sites: ASCENT.sites }, all = [], box = [];
  for (let i = 0; i < g.count; i++) {
    if (core.roundZoneAt(cfg, g.x[i], g.y[i], g.z[i]) !== site) continue;
    all.push(i);
    const low = Math.min(...I.nodesNear(N, g.x[i], g.z[i], 1).map((k) => g.y[k]));
    if (g.y[i] - low >= 0.8) box.push(i);
  }
  return { all, box };
}
export const spotOf = (N, k, site) => ({ x: N.g.x[k], y: N.g.y[k], z: N.g.z[k], site });

// Force the plant now: round state planted at the current tick with the spike at `spike`; the
// player hidden at the attacker spawn (or dead).
export function forcePlant(s, spike, player) {
  const st = s.saveState(), r = st.aimRound;
  Object.assign(r, { phase: 'planted', plantTick: r.tick, plant: 0, holding: null, spike: { carrier: null, dropped: null, planted: { ...spike } } });
  if (player !== 'visible') st.player.position = { x: HIDE.x, y: HIDE.y, z: HIDE.z };
  if (player === 'dead') { st.player.health = 0; r.playerAlive = false; }
  s.restoreState(st);
  return r.tick;
}

// Field time still to go for a bot's current B3 goal (null for setup / wait / rotation goals).
function goalTime(N, cfg, sp, b) {
  const F = I.spikeData(N, cfg, sp).field;
  if (b.gk === I.GK.stage) { const k = I.stagingFor(N, cfg)[sp.site]?.[b.sgi]; return k >= 0 ? I.fieldFor(N, k, null).dist[b.cur] - b.slotT : null; }
  if (!F) return null;
  if (b.gk === I.GK.place) return F.dist[b.cur] - b.ipT;
  if (b.gk === I.GK.spike) return F.dist[b.cur];
  if (b.gk === I.GK.cover) return F.dist[b.cur] - b.covT;
  return null;
}

// One run with metrics. plantAfter = s after the drop (forced plant; null = never, the caller plants),
// player 'hidden' | 'dead' | 'visible' (stays where it is). onTick(s, st, m, info) may edit the run
// (save -> edit -> restore). Stops one tick after the round ends or after maxSec.
export function retakeRun({ sim, W, doc, seed, extra = {}, plantAfter = 0.5, spike = null, player = 'hidden', maxSec = 80, onTick = null }) {
  const N = useNav();
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed, terrain: W, ...extra });
  const cfg = doc.rules.round, ts = 1 / TPS;
  const m = {
    seed, site: spike?.site ?? null, spike, player, live: -1, plant: -1, plantMs: null, outcome: null, end: -1,
    crossings: 0, stuck: 0, retries: 0, fireWhileDefusing: 0, seenWhileDefusing: 0, defuseStart: -1, candArrive: -1,
    flagGap: 0, staged2: -1, firstPush: -1, maxExcess: -Infinity, arrivals: [], defusers: [], maxDefuse: 0, cands: new Set(),
    kind: null, minStill: Infinity, minStillTick: Infinity, maxDefusers: 0, overdue: 0, shotsBy: {},
  };
  const prev = new Map(), flag = new Map(), track = new Map(), stuckIds = new Set();
  let timing = false;
  for (let i = 0; i < maxSec * TPS; i++) {
    const t0 = timing ? performance.now() : 0;
    const ev = s.step(IDLE);
    if (timing) { m.plantMs = performance.now() - t0; timing = false; }
    let st = s.saveState(), r = st.aimRound;
    const tick = r.tick;
    if (m.live < 0 && r.phase !== 'barrier') m.live = tick;
    for (const e of ev) if (e.kind === 'enemyShot') { m.shotsBy[e.actorId] = (m.shotsBy[e.actorId] ?? 0) + 1; if (flag.get(e.actorId) === 1) m.fireWhileDefusing++; }
    const sp = r.spike?.planted;
    let defusing = null;
    for (const a of st.actors) {
      const b = a.behavior.roundBot, p = a.position, q = prev.get(a.id);
      if (r.phase === 'barrier' && q && crossesBar(q, p)) m.crossings++;
      if (b.mode === I.MODE.stuck && !stuckIds.has(a.id)) stuckIds.add(a.id);
      prev.set(a.id, { ...p });
      flag.set(a.id, a.alive && a.roundDefusing === 1 ? 1 : 0);
      if (!a.alive || !sp || b.nav !== 1) continue;
      if (a.roundDefusing === 1) { defusing = a; if (a.behavior.shooter?.lastSeenTick === tick) m.seenWhileDefusing++; }
      if (b.cand >= 0) m.cands.add(b.cand);
      // Arrival per B3 goal: from the tick the goal was set to the tick it stands (field x 1.35 + 1 s).
      let t = track.get(a.id);
      if (!t || t.fk !== b.fk) { const ft = goalTime(N, cfg, sp, b); t = { fk: b.fk, gk: b.gk, start: tick, ft, done: ft === null }; track.set(a.id, t); }
      if (!t.done && STOPPED.has(b.mode)) {
        t.done = true;
        const sec = (tick - t.start) * ts, excess = sec - (1.35 * Math.max(0, t.ft) + 1);
        m.arrivals.push({ id: a.id, gk: t.gk, field: +t.ft.toFixed(2), sec: +sec.toFixed(2) });
        m.maxExcess = Math.max(m.maxExcess, excess);
        if (t.gk === I.GK.spike && m.candArrive < 0) m.candArrive = (tick - m.plant) * ts;
      }
    }
    if (sp && m.plant >= 0) {
      m.kind = I.spikeData(N, cfg, sp).kind;
      const still = st.actors.filter((a) => a.alive && STOPPED.has(a.behavior.roundBot.mode));
      for (const a of still) for (const b of still) if (a.id < b.id) m.minStillTick = Math.min(m.minStillTick, Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z));
      m.maxDefusers = Math.max(m.maxDefusers, st.actors.filter((a) => a.alive && a.roundDefusing === 1).length);
      const alive = st.actors.filter((a) => a.alive && a.behavior.roundBot.nav === 1);
      if (m.staged2 < 0 && alive.filter((a) => a.behavior.roundBot.staged === 1).length >= 2) m.staged2 = tick;
      if (m.firstPush < 0 && alive.some((a) => a.behavior.roundBot.pushed === 1)) m.firstPush = tick;
      if (defusing && m.defuseStart < 0) m.defuseStart = (tick - m.plant) * ts;
      if (m.defuseStart >= 0 && !defusing && r.phase === 'planted') m.flagGap++;
      if (r.defuser != null && m.defusers[m.defusers.length - 1] !== r.defuser) m.defusers.push(r.defuser);
      m.maxDefuse = Math.max(m.maxDefuse, r.defuse);
    }
    if (r.phase === 'ended' && !m.outcome) {
      m.outcome = r.reason; m.end = (tick - (m.plant >= 0 ? m.plant : tick)) * ts;
      // Goals still open at the end that are already overdue (> 1.35 x field + 1 s): a bot wandering.
      for (const a of st.actors) { const t = track.get(a.id); if (a.alive && t && !t.done && (tick - t.start) * ts > 1.35 * Math.max(0, t.ft) + 1) m.overdue++; }
      const still = st.actors.filter((a) => a.alive && STOPPED.has(a.behavior.roundBot.mode));
      for (const a of still) for (const b of still) if (a.id < b.id) m.minStill = Math.min(m.minStill, Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z));
      break;
    }
    if (spike && m.plant < 0 && m.live >= 0 && tick >= m.live + Math.round(plantAfter * TPS)) {
      m.plant = forcePlant(s, spike, player);
      timing = true;
      continue;
    }
    if (onTick) onTick(s, st, m, { tick, phase: r.phase });
    if (m.plant < 0 && r.phase === 'planted') m.plant = r.plantTick; // a real plant (the caller held the key)
  }
  const fin = s.saveState();
  m.stuck = stuckIds.size;
  m.retries = fin.actors.reduce((n, a) => n + (a.behavior.roundBot.retries ?? 0), 0);
  m.cands = [...m.cands];
  m.s = s;
  return m;
}

// ---------------------------------------------------------------- R3: attacker bots (defense side)
// The defense round scene (buildDoc side 'defense': 5 attacker bots at the attacker spawns, the
// map's attack data), prepared with planSeed (roundPrepare -> cfg.attack; a prepared doc passes the
// sim's own roundPrepare unchanged). plan = fields to force on cfg.attack (site, lurker, ...).
export function defenseDoc({ barrierSec = 20, planSeed = 1, plan = null } = {}) {
  const doc = core.roundPrepare(buildDoc(ASCENT, { side: 'defense', weapon: 'vandal', barrierSec }), planSeed);
  if (plan) Object.assign(doc.rules.round.attack, plan);
  return doc;
}
// A plan seed whose drawn site is `site` (lurker true / false: with / without a lurker), from `from` up.
export function planSeedFor(site, { lurker = null, from = 1 } = {}) {
  for (let s = from; s < from + 500; s++) {
    const a = defenseDoc({ planSeed: s }).rules.round.attack;
    if (a.site === site && (lurker === null || (lurker ? a.lurker !== null : a.lurker === null))) return s;
  }
  throw new Error(`no plan seed for ${site}`);
}
const ATK_BARS = ASCENT.barriers.filter((b) => b.team === 'attack');
const crossesAtk = (a, b) => ATK_BARS.some((w) => navlib.segCross(a.x, a.z, b.x, b.z, w.a.x, w.a.z, w.b.x, w.b.z));
const KILL_R = 5;
const STANDING = new Set([I.MODE.wait, I.MODE.stage, I.MODE.cover, I.MODE.post, I.MODE.plant]);

// One defense round with metrics (the player hides idle on the other site: the defender spawn is in
// sight of the B routes, which reach B from the CT side). kill: null | 'route' (the
// carrier walking to its plant spot with >= 1 s of field left, and every bot within KILL_R of it)
// | 'midplant' (the carrier once botPlant >= half the plant time). Stops postSec after the plant,
// at the round end or after maxSec. onTick(s, st, m, info) may edit the run (save -> edit -> restore).
// hide = false: the player stands idle where roundPrepare put it (the defender spawn) or at `at`.
export function attackRun({ sim, W, doc, seed = 1, extra = {}, kill = null, maxSec = 130, postSec = 15, onTick = null, hide = true, at = null }) {
  const N = useNav(), g = N.g, cfg = doc.rules.round, plan = cfg.attack, ts = 1 / TPS, H = navlib.nodeIndex(g);
  const A = I.atkData(N, cfg);
  const mask = I.maskFor(N, I.barriersOf(cfg));
  const seal = navlib.flood(g, ASCENT.spawns.attack.map((p) => navlib.nearestNode(g, H, p.x, p.z, 1, p.y, 1.5)), { types: navlib.TYPES.all, mask });
  const hideNode = g.header.siteGoals?.[plan.site === 'A' ? 'B' : 'A']?.node;
  const runDoc = at ? { ...doc, playerSpawn: { position: { ...at }, yaw: 0 } } : hide && Number.isInteger(hideNode) ? { ...doc, playerSpawn: { position: { x: g.x[hideNode], y: g.y[hideNode], z: g.z[hideNode] }, yaw: 0 } } : doc;
  const s = sim.c(runDoc, { sensitivity: 1, zoomSensitivity: 1, seed, terrain: W, ...extra });
  const m = {
    offFloor: 0, offFloorAt: null,
    seed, site: plan.site, plan: { ...plan, routeBySpawner: { ...plan.routeBySpawner } }, kill, live: -1, go: -1, goAfterLive: null, stagedAtGo: 0, members: 0,
    plant: -1, plantAfterLive: null, planted: null, plantNodeDist: null, planter: null, plantSite: null, outcome: null,
    crossings: 0, outside: 0, nav: true, bots: 0, waitSeen: false, routeOk: true, minStill: Infinity, minStillBarrier: Infinity, minStillStage: Infinity,
    stuck: 0, retries: 0, seen: 0, shots: 0, carriers: [], drops: [], pickups: [], killed: null, fetcher: null, fetchWalk: null, dropMs: null,
    botPlantBeforeKill: 0, post: null, lurkerStaged: null, maxPlanters: 0, plantingNotCarrier: 0, firstMs: 0,
  };
  const prev = new Map(), walk = new Map(), stuckIds = new Set();
  let lastCarrier = null, lastDropped = null, timing = false, killedAt = -1, postAt = -1, fetchWalk0 = 0;
  for (let i = 0; i < maxSec * TPS; i++) {
    const t0 = performance.now();
    const ev = s.step(IDLE);
    const dt = performance.now() - t0;
    if (timing) { m.dropMs = dt; timing = false; }
    if (i < 64) m.firstMs = Math.max(m.firstMs, dt); // spawn + init (all plan-site fields)
    const st = s.saveState(), r = st.aimRound;
    const tick = r.tick, barrier = r.phase === 'barrier';
    if (m.live < 0 && r.phase !== 'barrier') m.live = tick;
    for (const e of ev) if (e.kind === 'enemyShot') m.shots++;
    const bots = st.actors.filter((a) => a.behavior?.roundBot);
    m.bots = Math.max(m.bots, bots.length);
    let planters = 0;
    for (const a of bots) {
      const b = a.behavior.roundBot, p = a.position, q = prev.get(a.id);
      if (b.nav !== 1) m.nav = false;
      if (barrier && q && crossesAtk(q, p)) m.crossings++;
      if (barrier && a.alive) { const k = navlib.nearestNode(g, H, p.x, p.z, 0.75, p.y, b.air === 1 ? 6 : 1); if (k < 0 || seal[k] === -2) m.outside++; }
      if (barrier && b.mode === I.MODE.wait) m.waitSeen = true;
      // On the nav's floors: a node of its own floor within 0.75 m xz (not while airborne).
      if (a.alive && b.air !== 1 && !navlib.nodesNear(g, H, p.x, p.z, 0.75, p.y, 0.5).length) { m.offFloor++; m.offFloorAt ??= { id: a.id, tick, p: [p.x, p.y, p.z].map((v) => +v.toFixed(2)), cur: b.cur, gk: b.gk }; }
      if (b.mode === I.MODE.stuck && !stuckIds.has(a.id)) { stuckIds.add(a.id); (m.stuckAt ??= []).push({ id: a.id, t: +((tick - (m.live >= 0 ? m.live : tick)) * ts).toFixed(2), p: [p.x, p.y, p.z].map((v) => +v.toFixed(2)), cur: b.cur, curY: +g.y[b.cur].toFixed(2), gk: b.gk, tgt: b.tgt }); }
      if (a.alive && a.behavior.shooter?.lastSeenTick === tick) m.seen++;
      if (a.alive && b.planting === 1) { planters++; if (r.phase === 'live' && r.spike.carrier !== a.id) m.plantingNotCarrier++; }
      if (A && b.atk === 1 && A.routes[b.ri]?.name !== (plan.routeBySpawner[a.spawnerId] ?? A.routes[0].name)) m.routeOk = false;
      if (q) walk.set(a.id, (walk.get(a.id) ?? 0) + Math.hypot(p.x - q.x, p.z - q.z));
      if (m.lurkerStaged === null && plan.lurker && a.spawnerId === plan.lurker && b.atStage === 1 && !barrier && b.go !== 1) m.lurkerStaged = +((tick - m.live) * ts).toFixed(2);
      prev.set(a.id, { ...p });
    }
    m.maxPlanters = Math.max(m.maxPlanters, planters);
    // Standing bots never within 0.8 m (barrier wait, staging, clear / post spots, planting).
    const still = bots.filter((a) => a.alive && STANDING.has(a.behavior.roundBot.mode));
    for (const a of still) for (const b of still) if (a.id < b.id) {
      const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      if (d < m.minStill) m.minStillAt = { t: +((tick - (m.live >= 0 ? m.live : tick)) * ts).toFixed(2), phase: r.phase, a: [a.id, a.behavior.roundBot.mode, a.behavior.roundBot.gk, a.behavior.roundBot.cur], b: [b.id, b.behavior.roundBot.mode, b.behavior.roundBot.gk, b.behavior.roundBot.cur] };
      m.minStill = Math.min(m.minStill, d);
      if (barrier) m.minStillBarrier = Math.min(m.minStillBarrier, d);
      if (a.behavior.roundBot.mode === I.MODE.stage && b.behavior.roundBot.mode === I.MODE.stage) m.minStillStage = Math.min(m.minStillStage, d);
    }
    if (m.go < 0 && bots.some((a) => a.alive && a.behavior.roundBot.go === 1)) {
      m.go = tick; m.goAfterLive = +((tick - m.live) * ts).toFixed(2);
      const mem = bots.filter((a) => a.alive && a.spawnerId !== plan.lurker);
      m.members = mem.length; m.stagedAtGo = mem.filter((a) => a.behavior.roundBot.atStage === 1).length;
    }
    // Carrier / drop / fetch / pickup.
    const c = r.spike.carrier;
    if (c !== lastCarrier) { if (c !== null) { m.carriers.push(c); if (lastDropped) m.pickups.push({ id: c, tick }); } lastCarrier = c; }
    if (r.spike.dropped && !lastDropped) { m.drops.push({ tick, at: { ...r.spike.dropped } }); timing = true; }
    if (r.spike.dropped && lastDropped && m.fetcher === null) {
      const f = bots.find((a) => a.alive && a.behavior.roundBot.fetch >= 0);
      if (f) { m.fetcher = f.behavior.roundBot.fetch; fetchWalk0 = walk.get(m.fetcher) ?? 0; }
    }
    if (!r.spike.dropped && lastDropped && m.fetcher !== null && m.fetchWalk === null) m.fetchWalk = +((walk.get(m.fetcher) ?? 0) - fetchWalk0).toFixed(2);
    lastDropped = r.spike.dropped ? { ...r.spike.dropped } : null;
    // Plant.
    if (m.plant < 0 && r.spike.planted) {
      m.plant = tick; m.plantAfterLive = +((tick - m.live) * ts).toFixed(2); m.planted = { ...r.spike.planted }; m.plantSite = r.spike.planted.site;
      if (A) m.plantNodeDist = Math.min(...A.plant.map((pl) => Math.hypot(g.x[pl.node] - m.planted.x, g.z[pl.node] - m.planted.z)));
      const pl = bots.find((a) => a.alive && Math.hypot(a.position.x - m.planted.x, a.position.z - m.planted.z) < 0.05 && Math.abs(a.position.y - m.planted.y) < 0.05);
      m.planter = pl ? pl.id : null;
      postAt = tick + Math.round(postSec * TPS);
    }
    if (m.plant >= 0 && tick === postAt) {
      const alive = bots.filter((a) => a.alive);
      const held = alive.filter((a) => { const b = a.behavior.roundBot; return b.mode === I.MODE.post && b.pn >= 0 && Math.hypot(a.position.x - g.x[b.pn], a.position.z - g.z[b.pn]) < 0.3; });
      const pns = alive.map((a) => a.behavior.roundBot.pn).filter((k) => k >= 0);
      const pi = A ? A.plant.findIndex((pl) => Math.hypot(g.x[pl.node] - m.planted.x, g.z[pl.node] - m.planted.z) === m.plantNodeDist) : -1;
      m.post = { alive: alive.length, assigned: pns.length, distinct: new Set(pns).size, held: held.length, spots: pi >= 0 ? (A.post[pi] ?? []).length : 0 };
    }
    if (r.phase === 'ended' && !m.outcome) m.outcome = r.reason;
    if (m.outcome || (postAt >= 0 && tick >= postAt)) break;
    // Kills (save -> edit -> restore).
    if (kill && killedAt < 0 && c !== null) {
      const ca = bots.find((a) => a.id === c && a.alive), b = ca?.behavior.roundBot;
      let doIt = false, also = [];
      if (ca && kill === 'route' && b.gk === I.GK.plant && b.mode === I.MODE.walk && b.pi >= 0 && I.fieldFor(N, A.plant[b.pi].node, null, 1).dist[b.cur] >= 1) {
        // A multi-kill: the carrier and every bot within KILL_R (5 m) of it, when a bot is left farther
        // out (the team walks in a column; the fetch must be a real walk: >= 3 m to the 1.5 m pickup).
        const near = (o) => Math.hypot(o.position.x - ca.position.x, o.position.z - ca.position.z) < KILL_R;
        also = bots.filter((o) => o.alive && o.id !== c && near(o)).map((o) => o.id);
        doIt = bots.some((o) => o.alive && o.id !== c && !near(o));
      }
      if (ca && kill === 'midplant' && r.botPlant >= Math.round((cfg.plantSec ?? 4) * TPS) / 2) { doIt = true; m.botPlantBeforeKill = r.botPlant; }
      if (doIt) {
        const a = st.actors.find((x) => x.id === c);
        a.alive = false; a.health = 0;
        for (const id of also) { const o = st.actors.find((x) => x.id === id); o.alive = false; o.health = 0; }
        m.killed = { id: c, tick, at: { ...a.position }, also };
        killedAt = tick;
        s.restoreState(st);
        continue;
      }
    }
    if (onTick) onTick(s, st, m, { tick, phase: r.phase });
  }
  const fin = s.saveState();
  m.stuck = stuckIds.size;
  m.retries = fin.actors.reduce((n, a) => n + (a.behavior.roundBot?.retries ?? 0), 0);
  m.s = s;
  return m;
}

// ---------------------------------------------------------------- sweep (CLI)
function rng(seed) {
  let a = (seed >>> 0) ^ 0x9e3779b9;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const RANKS = [undefined, 'iron', 'gold', 'platinum', 'radiant'];

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const seeds = +arg('--seeds', 6), out = arg('--out', path.join('/tmp', 'round-bots-sweep.json')), maxMin = +arg('--max-min', 9);
  const only = arg('--only', '') ? new Set(arg('--only', '').split(',').map(Number)) : null, debug = process.argv.includes('--debug');
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis; globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);
  const { loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
  const W = await loadTerrain('ascent', { root });
  const N = useNav(), spots = { A: zoneSpots(N, 'A'), B: zoneSpots(N, 'B') };
  const t0 = Date.now(), rows = [];
  console.log(`zone spots: A ${spots.A.all.length} (${spots.A.box.length} box), B ${spots.B.all.length} (${spots.B.box.length} box)`);
  outer: for (let k = 0; k < seeds; k++) for (const site of ['A', 'B']) for (const barrierSec of [10, 20]) for (const player of ['hidden', 'dead']) {
    if (Date.now() - t0 > maxMin * 60e3) { console.log(`time budget (${maxMin} min) reached, stopping`); break outer; }
    const seed = 1000 + k * 100 + (site === 'B' ? 50 : 0) + (barrierSec === 20 ? 20 : 0) + (player === 'dead' ? 5 : 0), R = rng(seed); // unique per run
    if (only && !only.has(seed)) continue;
    const box = R() < 0.25 && spots[site].box.length > 0, pool = box ? spots[site].box : spots[site].all;
    const node = pool[Math.floor(R() * pool.length)], rank = RANKS[Math.floor(R() * RANKS.length)], game = R() < 0.5;
    const plantAfter = 2 + R() * 10;
    const doc = realDoc({ barrierSec });
    const w0 = Date.now();
    const m = retakeRun({ sim: sim, W, doc, seed, extra: { ...(rank ? { enemyRank: rank } : {}), ...(game ? { movement: 'game' } : {}) }, plantAfter, spike: spotOf(N, node, site), player, maxSec: barrierSec + plantAfter + 50,
      onTick: debug ? (q, st, mm, info) => {
        if (mm.plant < 0) return;
        const dtk = info.tick - mm.plant;
        if (process.env.RB_WIN && dtk >= +process.env.RB_WIN.split(',')[0] * TPS && dtk <= +process.env.RB_WIN.split(',')[1] * TPS && dtk % 4 === 0) console.log(`  w+${(dtk / TPS).toFixed(3)} ` + st.actors.map((a) => `[${a.id} ${[a.position.x, a.position.y, a.position.z].map((v) => v.toFixed(2))} tgt ${a.behavior.roundBot.tgt} air ${a.behavior.roundBot.air ?? 0} sp ${(a.behavior.roundBot.speed ?? 0).toFixed(1)}]`).join(' '));
        if (dtk % 64 !== 0) return;
        const g = N.g, sd = I.spikeData(N, doc.rules.round, st.aimRound.spike.planted);
        for (const a of st.actors) { const b = a.behavior.roundBot; if (b.cand !== a.id) continue; console.log(`  t+${((info.tick - mm.plant) / TPS).toFixed(1)} cand ${a.id} pos ${[a.position.x, a.position.y, a.position.z].map((v) => v.toFixed(2))} cur ${b.cur} y ${g.y[b.cur].toFixed(2)} field ${sd.field?.dist[b.cur].toFixed(2)} tgt ${b.tgt} mode ${b.mode} gk ${b.gk} replans ${b.replans} air ${b.air ?? 0} speed ${(b.speed ?? 0).toFixed(2)} yield ${b.yieldT.toFixed(2)}`); }
      } : null });
    const row = {
      seed, site, barrierSec, player, rank: rank ?? 'default', movement: game ? 'game' : 'default', box, kind: m.kind,
      spike: [+m.spike.x.toFixed(2), +m.spike.y.toFixed(2), +m.spike.z.toFixed(2)], plantMs: m.plantMs === null ? null : +m.plantMs.toFixed(1),
      candArrive: m.candArrive < 0 ? null : +m.candArrive.toFixed(2), defuseStart: m.defuseStart < 0 ? null : +m.defuseStart.toFixed(2),
      outcome: m.outcome, end: +m.end.toFixed(2), stuck: m.stuck, retries: m.retries, crossings: m.crossings, fireWhileDefusing: m.fireWhileDefusing,
      flagGap: m.flagGap, maxDefusers: m.maxDefusers, overdue: m.overdue, minStillTick: Number.isFinite(m.minStillTick) ? +m.minStillTick.toFixed(2) : null, push: m.firstPush < 0 || m.staged2 < 0 ? null : +((m.firstPush - m.staged2) / TPS).toFixed(2), maxExcess: +m.maxExcess.toFixed(2),
      minStill: Number.isFinite(m.minStill) ? +m.minStill.toFixed(2) : null, wall: +((Date.now() - w0) / 1000).toFixed(1),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    if (debug) {
      console.log(`  arrivals ${JSON.stringify(m.arrivals)} defusers ${m.defusers} plant ${m.plant} live ${m.live}`);
      const st = m.s.saveState(), sp = st.aimRound.spike.planted, sd = I.spikeData(N, doc.rules.round, sp), g = N.g;
      console.log(`  spike ${JSON.stringify(sp)} kind ${sd.kind} set ${JSON.stringify(sd.set.map((k) => [k, +g.x[k].toFixed(2), +g.y[k].toFixed(2), +g.z[k].toFixed(2)]))}`);
      for (const a of st.actors) {
        const b = a.behavior.roundBot, p = a.position;
        console.log(`  bot ${a.id} alive ${a.alive} mode ${b.mode} gk ${b.gk} cand ${b.cand} pushed ${b.pushed} pos ${[p.x, p.y, p.z].map((v) => v.toFixed(2))} cur ${b.cur} (${[g.x[b.cur], g.y[b.cur], g.z[b.cur]].map((v) => v.toFixed(2))}) at ${b.at} tgt ${b.tgt} speed ${(b.speed ?? 0).toFixed(2)} air ${b.air ?? 0} ch ${a.combatHold ?? '-'} seen ${st.aimRound.tick - (a.behavior.shooter?.lastSeenTick ?? -1e9)} xz ${Math.hypot(p.x - sp.x, p.z - sp.z).toFixed(2)} dy ${(p.y - sp.y).toFixed(2)} field ${sd.field ? sd.field.dist[b.cur].toFixed(2) : '-'}`);
      }
    }
  }
  const n = rows.length, ok = rows.filter((r) => r.kind === 'defuse'), defused = ok.filter((r) => r.outcome === 'defused');
  const q = (a, f) => { const v = a.map(f).filter((x) => x !== null).sort((x, y) => x - y); return v.length ? { min: v[0], med: v[Math.floor(v.length / 2)], max: v[v.length - 1] } : null; };
  const summary = {
    runs: n, minutes: +((Date.now() - t0) / 60e3).toFixed(1), defuseSpots: ok.length, defused: defused.length,
    outcomes: rows.reduce((o, r) => ({ ...o, [`${r.kind}:${r.outcome}`]: (o[`${r.kind}:${r.outcome}`] ?? 0) + 1 }), {}),
    candArrive: q(ok, (r) => r.candArrive), defuseStart: q(ok, (r) => r.defuseStart), defuseEnd: q(defused, (r) => r.end),
    stuckBots: rows.reduce((s, r) => s + r.stuck, 0), crossings: rows.reduce((s, r) => s + r.crossings, 0),
    fireWhileDefusing: rows.reduce((s, r) => s + r.fireWhileDefusing, 0), flagGapRuns: rows.filter((r) => r.flagGap > 0).length,
    maxDefusers: Math.max(...rows.map((r) => r.maxDefusers)), overdue: rows.reduce((s, r) => s + r.overdue, 0), minStillTick: q(rows, (r) => r.minStillTick),
    plantMs: q(rows, (r) => r.plantMs), maxExcess: Math.max(...rows.map((r) => r.maxExcess)),
  };
  console.log('SUMMARY ' + JSON.stringify(summary));
  try { fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 1)); console.log(`wrote ${out}`); } catch (e) { console.log(`could not write ${out}: ${e.message}`); }
}

// Defense mode (R3 attackers): seeds x kill none / route / midplant; barrier, plan seed, movement and
// rank vary with the seed; the player stays hidden at its spawn.
//   node scripts/round-bots-sweep.mjs --defense [--seeds 20] [--out /tmp/round-bots-defense.json] [--max-min 9]
async function defenseMain() {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const seeds = +arg('--seeds', 20), out = arg('--out', path.join('/tmp', 'round-bots-defense.json')), maxMin = +arg('--max-min', 9);
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis; globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);
  const { loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
  const W = await loadTerrain('ascent', { root });
  const t0 = Date.now(), rows = [];
  outer: for (let k = 0; k < seeds; k++) for (const kill of [null, 'route', 'midplant']) {
    if (Date.now() - t0 > maxMin * 60e3) { console.log(`time budget (${maxMin} min) reached, stopping`); break outer; }
    const seed = 3000 + k * 10 + (kill === 'route' ? 1 : kill === 'midplant' ? 2 : 0), R = rng(seed);
    const barrierSec = [10, 20, 30][Math.floor(R() * 3)], planSeed = 1 + Math.floor(R() * 1e6), rank = RANKS[Math.floor(R() * RANKS.length)], game = R() < 0.5;
    const doc = defenseDoc({ barrierSec, planSeed });
    const w0 = Date.now();
    const m = attackRun({ sim, W, doc, seed, kill, extra: { ...(rank ? { enemyRank: rank } : {}), ...(game ? { movement: 'game' } : {}) }, maxSec: barrierSec + 100 + 5 });
    const pk = m.pickups[0] ?? null;
    const row = {
      seed, planSeed, site: m.site, barrierSec, kill, killed: m.killed ? 1 + m.killed.also.length : 0, rank: rank ?? 'default', movement: game ? 'game' : 'default', lurker: m.plan.lurker ? 1 : 0,
      gather: m.plan.gatherSec, goAfterLive: m.goAfterLive, stagedAtGo: `${m.stagedAtGo}/${m.members}`, lurkerStaged: m.lurkerStaged,
      planted: m.plant >= 0 ? 1 : 0, plantAfterLive: m.plantAfterLive, plantSiteOk: m.plant >= 0 ? (m.plantSite === m.site ? 1 : 0) : null, plantNodeDist: m.plantNodeDist === null ? null : +m.plantNodeDist.toFixed(3),
      drops: m.drops.length, fetcher: m.fetcher, newCarrier: pk ? pk.id : null, fetchOk: m.drops.length ? (pk && pk.id === m.fetcher ? 1 : 0) : null, fetchWalk: m.fetchWalk,
      botPlantBeforeKill: m.botPlantBeforeKill, outcome: m.outcome, crossings: m.crossings, outside: m.outside, offFloor: m.offFloor, offFloorAt: m.offFloorAt, stuck: m.stuck, retries: m.retries, seen: m.seen, shots: m.shots,
      minStill: Number.isFinite(m.minStill) ? +m.minStill.toFixed(2) : null, post: m.post, maxPlanters: m.maxPlanters, plantingNotCarrier: m.plantingNotCarrier, routeOk: m.routeOk ? 1 : 0, nav: m.nav ? 1 : 0, waitSeen: m.waitSeen ? 1 : 0,
      dropMs: m.dropMs === null ? null : +m.dropMs.toFixed(1), firstMs: +m.firstMs.toFixed(1), wall: +((Date.now() - w0) / 1000).toFixed(1),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const q = (a, f) => { const v = a.map(f).filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return v.length ? { min: v[0], med: v[Math.floor(v.length / 2)], max: v[v.length - 1], n: v.length } : null; };
  const by = (f) => rows.filter(f);
  const kinds = { none: by((r) => r.kill === null), route: by((r) => r.kill === 'route' && r.killed > 0), routeSkipped: by((r) => r.kill === 'route' && r.killed === 0), midplant: by((r) => r.kill === 'midplant' && r.killed > 0) };
  const posts = rows.filter((r) => r.post);
  const summary = {
    runs: rows.length, minutes: +((Date.now() - t0) / 60e3).toFixed(1),
    perKind: Object.fromEntries(Object.entries(kinds).map(([k, a]) => [k, { runs: a.length, planted: a.filter((r) => r.planted).length, plantedWithin40: a.filter((r) => r.planted && r.plantAfterLive <= 40).length, plantAfterLive: q(a, (r) => r.plantAfterLive), fetchOk: a.filter((r) => r.fetchOk === 1).length, drops: a.filter((r) => r.drops > 0).length, fetchWalk: q(a, (r) => r.fetchWalk) }])),
    plantSiteOk: rows.filter((r) => r.plantSiteOk === 1).length, plantNodeDistMax: Math.max(0, ...rows.map((r) => r.plantNodeDist ?? 0)),
    crossings: rows.reduce((s, r) => s + r.crossings, 0), outside: rows.reduce((s, r) => s + r.outside, 0), offFloorRuns: rows.filter((r) => r.offFloor > 0).length, stuckBots: rows.reduce((s, r) => s + r.stuck, 0), retries: rows.reduce((s, r) => s + r.retries, 0),
    seenTicks: rows.reduce((s, r) => s + r.seen, 0), shots: rows.reduce((s, r) => s + r.shots, 0), minStill: q(rows, (r) => r.minStill), maxPlanters: Math.max(...rows.map((r) => r.maxPlanters)), plantingNotCarrier: rows.reduce((s, r) => s + r.plantingNotCarrier, 0),
    post: { runs: posts.length, allHeld: posts.filter((r) => r.post.held === r.post.assigned && r.post.distinct === r.post.assigned && r.post.assigned === Math.min(r.post.alive, r.post.spots)).length, held: posts.reduce((s, r) => s + r.post.held, 0), assigned: posts.reduce((s, r) => s + r.post.assigned, 0) },
    routeOk: rows.filter((r) => r.routeOk).length, nav: rows.filter((r) => r.nav).length, waitSeen: rows.filter((r) => r.waitSeen).length, outcomes: rows.reduce((o, r) => ({ ...o, [String(r.outcome)]: (o[String(r.outcome)] ?? 0) + 1 }), {}),
    lurkerRuns: rows.filter((r) => r.lurker).length, lurkerStaged: rows.filter((r) => r.lurker && r.lurkerStaged !== null).length,
    goAfterLive: q(rows, (r) => r.goAfterLive), dropMs: q(rows, (r) => r.dropMs), firstMs: q(rows, (r) => r.firstMs),
  };
  console.log('SUMMARY ' + JSON.stringify(summary));
  try { fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 1)); console.log(`wrote ${out}`); } catch (e) { console.log(`could not write ${out}: ${e.message}`); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await (process.argv.includes('--defense') ? defenseMain() : main());
