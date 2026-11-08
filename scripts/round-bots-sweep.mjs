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
//   node scripts/round-bots-sweep.mjs [--map rook] [--seeds 6] [--out /tmp/round-bots-sweep.json] [--max-min 9]
// --map (or env ROUND_MAP) picks the map: app/mods/aim-rounds/<map>.json + .nav.bin and its real
// collision (default ascent). ASCENT / NAV_AB below hold that map's data, whatever the map.
// (npm run sweep:round-bots in app/). scripts/test-round-bots-real.mjs imports retakeRun from here.
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
const mapArg = process.argv.indexOf('--map');
export const MAP = (mapArg > 0 ? process.argv[mapArg + 1] : process.env.ROUND_MAP) || 'ascent';
export const ASCENT = JSON.parse(fs.readFileSync(path.join(MODS, 'aim-rounds', `${MAP}.json`), 'utf-8'));
export const { buildDoc } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
const NAV_BYTES = fs.readFileSync(path.join(MODS, 'aim-rounds', `${MAP}.nav.bin`));
const NAV_AB = NAV_BYTES.buffer.slice(NAV_BYTES.byteOffset, NAV_BYTES.byteOffset + NAV_BYTES.byteLength);
export const useNav = () => { globalThis.__aimRoundNav = { [MAP]: NAV_AB }; return I.navFor(MAP); };
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
  const W = await loadTerrain(MAP, { root });
  const N = useNav(), spots = { A: zoneSpots(N, 'A'), B: zoneSpots(N, 'B') };
  const t0 = Date.now(), rows = [];
  console.log(`${MAP} zone spots: A ${spots.A.all.length} (${spots.A.box.length} box), B ${spots.B.all.length} (${spots.B.box.length} box)`);
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
