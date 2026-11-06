// Round mode controller (one VALORANT-style round: barrier phase, spike plant / defuse).
// Pure functions over plain data, no game imports: the sim (CnrSARj_.js, tools/round_patch.py)
// calls them every tick, and scripts/test-round.mjs runs them in node.
//
// cfg   = scene.rules.round (built by app/round-scene.js from app/mods/aim-rounds/<map>.json)
// state = small plain object (JSON-clonable), saved/restored with the sim state.
//
// Ticks, not seconds: every timer counts sim ticks, so pausing (no sim steps) freezes all of them.
//
// Outcome precedence inside one tick (first match wins):
//   1. detonation (spike timer ran out)        -> attackers win, "detonated"
//   2. defuse completed                         -> defenders win, "defused"
//   3. eliminations: before the plant, a team with nobody alive loses ("eliminated", or "died" when
//      that team is the player's — 1 v 5, so the player's death); both teams dead in the same tick
//      before the plant -> defenders win. After the plant only the defenders being dead ends the
//      round (attackers win); dead attackers leave it to the spike (defenders must still defuse).
//   4. round timer ran out without a plant      -> defenders win, "timeout"
// Detonation beats a defuse that would complete on the same tick (VALORANT: the defuse has to
// finish before the spike goes off).

export const ROUND_DEFAULTS = {
  barrierSec: 20, roundSec: 100, plantSec: 4, spikeSec: 45, defuseSec: 7, defuseCheckpointSec: 3.5,
  endHoldSec: 3, defuseRadius: 2, pickupRadius: 1.5, holdMaxSpeed: 3.2, barrierPad: 0.4,
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const T = (cfg, key, tickSec) => Math.max(1, Math.round(num(cfg?.[key], ROUND_DEFAULTS[key]) / tickSec));

// Small seeded RNG (mulberry32); only used by roundPrepare.
function rng(seed) {
  let a = (seed >>> 0) ^ 0x9e3779b9;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(list, r) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Called by the sim on the scene before anything else (every run gets a new seed, so every
// restart re-rolls): the player's spawn point and which enemy setup spawners stay.
// cfg.setups = { groups: { A: [spawnerId…], mid: […], B: […] }, splits: [[2,1,2], …], count: 5 }
export function roundPrepare(doc, seed) {
  const cfg = doc?.rules?.round;
  if (!cfg || typeof cfg !== 'object') return doc;
  const r = rng(Number.isFinite(seed) ? seed : 1);
  const own = cfg.spawns?.[cfg.side === 'defense' ? 'defense' : 'attack'];
  let playerSpawn = doc.playerSpawn;
  if (Array.isArray(own) && own.length) {
    const p = own[Math.floor(r() * own.length)];
    playerSpawn = { position: { x: p.x, y: p.y, z: p.z }, yaw: p.yaw };
  }
  const groups = cfg.setups?.groups;
  let spawners = doc.spawners;
  if (groups && typeof groups === 'object') {
    const names = Object.keys(groups);
    const count = Math.max(0, Math.floor(num(cfg.setups.count, 5)));
    const splits = (cfg.setups.splits ?? []).filter((s) => Array.isArray(s) && s.length === names.length);
    const split = splits.length ? splits[Math.floor(r() * splits.length)] : names.map(() => Math.ceil(count / names.length));
    const keep = new Set(), spare = [];
    names.forEach((g, i) => {
      const ids = shuffle(groups[g] ?? [], r);
      ids.slice(0, split[i]).forEach((id) => keep.add(id));
      spare.push(...ids.slice(split[i]));
    });
    for (const id of shuffle(spare, r)) { if (keep.size >= count) break; keep.add(id); }
    while (keep.size > count) keep.delete([...keep].pop());
    const all = new Set(names.flatMap((g) => groups[g] ?? []));
    spawners = doc.spawners.filter((s) => !all.has(s.id) || keep.has(s.id));
  }
  return { ...doc, playerSpawn, spawners };
}

export function roundCreate(cfg, tickSec) {
  const side = cfg?.side === 'defense' ? 'defense' : 'attack';
  return {
    phase: 'barrier', tick: 0, liveTick: 0, plantTick: -1, endTick: -1, done: false,
    side, playerAlive: true, enemiesDead: 0,
    spike: { carrier: side === 'attack' ? 'player' : null, dropped: null, planted: null },
    plant: 0, defuse: 0, checkpoint: false, holding: null, zone: null, near: false,
    winner: null, reason: null, events: 0,
  };
}

export function roundClone(state) { return state ? JSON.parse(JSON.stringify(state)) : state; }

function inPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
export function roundZoneAt(cfg, x, y, z) {
  for (const s of cfg?.sites ?? []) if (Array.isArray(s.zone) && inPoly(s.zone, x, z) && (!s.y || (y >= s.y[0] && y <= s.y[1]))) return s.id;
  return null;
}

function orient(px, pz, qx, qz, rx, rz) { return (qx - px) * (rz - pz) - (qz - pz) * (rx - px); }
function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = orient(cx, cz, dx, dz, ax, az), d2 = orient(cx, cz, dx, dz, bx, bz);
  const d3 = orient(ax, az, bx, bz, cx, cz), d4 = orient(ax, az, bx, bz, dx, dz);
  if (d1 === 0 && d2 === 0) return false; // moving along the barrier line: not a crossing
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}
function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az, l = vx * vx + vz * vz;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l)) : 0;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

// Barrier phase: true when moving the player from (x0,z0) to (x1,z1) at height y would cross (or
// get closer than barrierPad to) one of their team's barrier segments. The caller reverts xz.
export function roundBlocksMove(cfg, state, x0, z0, x1, z1, y) {
  if (!state || state.phase !== 'barrier' || (x0 === x1 && z0 === z1)) return false;
  const team = state.side, pad = num(cfg?.barrierPad, ROUND_DEFAULTS.barrierPad);
  for (const b of cfg?.barriers ?? []) {
    if (b.team !== team) continue;
    if (Array.isArray(b.y) && (y < b.y[0] || y > b.y[1])) continue;
    if (segCross(x0, z0, x1, z1, b.a.x, b.a.z, b.b.x, b.b.z)) return true;
    const d1 = segDist(x1, z1, b.a.x, b.a.z, b.b.x, b.b.z);
    if (d1 < pad && d1 < segDist(x0, z0, b.a.x, b.a.z, b.b.x, b.b.z)) return true;
  }
  return false;
}

// The player can't move at all (dead after the plant: the camera stays where they fell).
export function roundFrozen(state) { return !!state && !state.playerAlive; }
// No player shots: barrier phase, round over, dead, or a plant/defuse hold in progress.
export function roundNoFire(state) { return !!state && (state.phase === 'barrier' || state.phase === 'ended' || !state.playerAlive || state.holding !== null); }
// Bots don't hurt the player: barrier phase, round over, or the player is already dead.
export function roundBotsHold(state) { return !!state && (state.phase === 'barrier' || state.phase === 'ended' || !state.playerAlive); }
// The use key doesn't pick weapons up while it could mean "defuse" (or nothing happens anyway).
export function roundBlocksUse(state) { return !!state && (state.phase !== 'live' || state.holding !== null || state.near); }

// One sim tick. io = { tick, tickSec, player:{x,y,z,speed,grounded,health}, kills, hold:{plant,use} }.
// Returns events for this tick ({kind:'roundPhase'|'roundPlant'|'roundDefuse'|'roundEnd', …}).
export function roundStep(cfg, state, io) {
  const ev = [];
  if (!state) return ev;
  const t = io.tick, ts = io.tickSec;
  state.tick = t;
  if (state.phase === 'ended') {
    if (!state.done && t - state.endTick >= T(cfg, 'endHoldSec', ts)) state.done = true;
    state.holding = null;
    return ev;
  }
  const p = io.player, hold = io.hold ?? {};
  state.enemiesDead += Math.max(0, io.kills | 0);
  const enemyCount = Math.max(0, num(cfg?.enemyCount, 5));
  const enemiesAlive = Math.max(0, enemyCount - state.enemiesDead);
  const alive = (p.health ?? 1) > 0;
  if (state.playerAlive && !alive) {
    state.playerAlive = false;
    if (state.spike.carrier === 'player') { state.spike.carrier = null; state.spike.dropped = { x: p.x, y: p.y, z: p.z }; }
  }

  if (state.phase === 'barrier' && t >= T(cfg, 'barrierSec', ts)) {
    state.phase = 'live'; state.liveTick = t;
    ev.push({ kind: 'roundPhase', phase: 'live' });
  }

  // Spike pickup (dropped spike, attacking player walks over it).
  if (state.spike.dropped && state.playerAlive && state.side === 'attack') {
    const d = state.spike.dropped;
    if (Math.hypot(p.x - d.x, p.z - d.z) <= num(cfg?.pickupRadius, ROUND_DEFAULTS.pickupRadius) && Math.abs(p.y - d.y) < 2) {
      state.spike.carrier = 'player'; state.spike.dropped = null;
    }
  }

  const steady = state.playerAlive && p.grounded !== false && (p.speed ?? 0) <= num(cfg?.holdMaxSpeed, ROUND_DEFAULTS.holdMaxSpeed);
  state.zone = state.playerAlive ? roundZoneAt(cfg, p.x, p.y, p.z) : null;
  const sp = state.spike.planted;
  state.near = !!sp && state.playerAlive && Math.hypot(p.x - sp.x, p.z - sp.z) <= num(cfg?.defuseRadius, ROUND_DEFAULTS.defuseRadius) && Math.abs(p.y - sp.y) < 2;
  state.holding = null;

  // Plant: hold the plant key, carrying the spike, standing still enough in a plant zone.
  let defused = false;
  if (state.phase === 'live' && state.spike.carrier === 'player' && state.zone && steady && hold.plant) {
    state.holding = 'plant';
    state.plant += 1;
    if (state.plant >= T(cfg, 'plantSec', ts)) {
      state.phase = 'planted'; state.plantTick = t; state.plant = 0; state.holding = null;
      state.spike.carrier = null;
      state.spike.planted = { x: p.x, y: p.y, z: p.z, site: state.zone };
      ev.push({ kind: 'roundPlant', site: state.zone });
    }
  } else state.plant = 0;

  // Defuse: hold use near the planted spike (defending player). Past the checkpoint a release
  // keeps half the progress.
  if (state.phase === 'planted' && state.side === 'defense' && state.near && steady && hold.use) {
    state.holding = 'defuse';
    state.defuse += 1;
    if (state.defuse >= T(cfg, 'defuseCheckpointSec', ts)) state.checkpoint = true;
    if (state.defuse >= T(cfg, 'defuseSec', ts)) defused = true;
  } else if (state.phase === 'planted') {
    state.defuse = state.checkpoint ? T(cfg, 'defuseCheckpointSec', ts) : 0;
  }

  // Outcomes, in precedence order.
  const attackAlive = state.side === 'attack' ? (state.playerAlive ? 1 : 0) : enemiesAlive;
  const defenseAlive = state.side === 'defense' ? (state.playerAlive ? 1 : 0) : enemiesAlive;
  const own = state.side;
  let winner = null, reason = null;
  if (state.phase === 'planted' && t - state.plantTick >= T(cfg, 'spikeSec', ts)) { winner = 'attack'; reason = 'detonated'; }
  else if (defused) { winner = 'defense'; reason = 'defused'; }
  else if (state.phase === 'planted') {
    if (defenseAlive === 0) { winner = 'attack'; reason = own === 'defense' ? 'died' : 'eliminated'; }
  } else if (state.phase === 'live' || state.phase === 'barrier') {
    if (attackAlive === 0) { winner = 'defense'; reason = own === 'attack' ? 'died' : 'eliminated'; }
    else if (defenseAlive === 0) { winner = 'attack'; reason = own === 'defense' ? 'died' : 'eliminated'; }
    else if (state.phase === 'live' && t - state.liveTick >= T(cfg, 'roundSec', ts)) { winner = 'defense'; reason = 'timeout'; }
  }
  if (winner) {
    state.phase = 'ended'; state.endTick = t; state.winner = winner; state.reason = reason; state.holding = null;
    ev.push({ kind: 'roundEnd', winner, reason, win: winner === own });
  }
  state.events += ev.length;
  return ev;
}

// What the HUD needs (snapshot().round, copied to window.__aimRound every tick).
export function roundView(cfg, state, tickSec) {
  if (!state) return null;
  const t = state.tick, ts = tickSec, sec = (n) => Math.max(0, n * ts);
  let timeLeft = 0;
  if (state.phase === 'barrier') timeLeft = sec(T(cfg, 'barrierSec', ts) - t);
  else if (state.phase === 'live') timeLeft = sec(T(cfg, 'roundSec', ts) - (t - state.liveTick));
  else if (state.phase === 'planted') timeLeft = sec(T(cfg, 'spikeSec', ts) - (t - state.plantTick));
  const enemyCount = Math.max(0, num(cfg?.enemyCount, 5));
  return {
    map: cfg?.map ?? null, side: state.side, phase: state.phase, timeLeft,
    spikeSec: num(cfg?.spikeSec, ROUND_DEFAULTS.spikeSec),
    plant: state.plant / T(cfg, 'plantSec', ts), defuse: state.defuse / T(cfg, 'defuseSec', ts),
    checkpoint: state.checkpoint, holding: state.holding, zone: state.zone, near: state.near,
    carrying: state.spike.carrier === 'player', spike: state.spike,
    enemiesAlive: Math.max(0, enemyCount - state.enemiesDead), enemyCount, playerAlive: state.playerAlive,
    winner: state.winner, reason: state.reason, win: state.winner ? state.winner === state.side : null,
    done: state.done, tick: t,
  };
}
