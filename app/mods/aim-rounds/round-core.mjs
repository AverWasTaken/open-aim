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
//
// Bot defuse (attack side: the defending bots defuse the player's spike). io.bots (built by the
// sim from every roundBot actor at the end of the tick, app/mods/aim-rounds/round-bots.mjs) =
// [{id, alive, x, y, z, defusing}]. A bot's defuse counts only while it is alive, reports
// defusing = 1 and stands within defuseRadius (xz) and |dy| < 2 of the spike. Election: the current
// defuser (state.defuser) keeps it while it still qualifies, else the lowest qualifying id. A new
// defuser, or no defuser, drops the progress to the checkpoint (if reached) or 0, as when the
// player lets go; a new defuser's tick then counts. Bots never set state.holding (the player can
// still shoot them). A defuser killed on its finishing tick is dead in io.bots: no defuse.
//
// Bot carrier and bot plant (defense side: the attacking bots carry and plant the spike; R3). io.bots
// entries then also carry spawnerId (string) and planting (0|1; a missing field = 0 = never plants).
// Bot ids are numbers, so a bot carrier never clashes with 'player'. Everything below happens only
// on the defense side and only when io.bots is an array; the attack side ignores spawnerId and
// planting. Order inside roundStep (after the barrier -> live switch):
//   1. carrier check: a carrier bot that is alive in io.bots refreshes state.carrierAt {x,y,z}; one
//      that is dead (or missing) drops the spike at its io.bots position (dead entries keep their
//      last position), or at carrierAt when it is missing; carrier -> null, botPlant -> 0. The spike
//      lies where the bot was: one killed mid-drop leaves it in the air (as the player's drop does).
//   2. pickup: a dropped spike goes to the lowest-id living bot within pickupRadius (xz) and
//      |dy| < 2 of it (a bot killed this tick is dead in io.bots and can't pick it up). A pickup on
//      the drop tick is allowed. The bots' fetch target must be within 1.0 m of the spike; a spike
//      no bot can reach stays where it is (the attackers can then only win by eliminating).
//   3. election: no carrier, nothing dropped or planted -> the living bot whose spawnerId is
//      cfg.attack.carrierSpawner (roundPrepare's plan); without it (dead, not spawned yet, no plan)
//      the lowest living id, but only once every bot has spawned (io.bots.length >= enemyCount) or
//      the round is live, so a late-spawning planned carrier is not passed over.
//   4. (after the player's plant / defuse) bot plant: while live, the carrier bot alive in io.bots,
//      planting = 1 and standing in a plant zone (roundZoneAt at its position): botPlant += 1, else
//      botPlant = 0 (only death or leaving the zone / letting go stops it; being shot doesn't). A
//      carrier that got the spike this tick (pickup or election) starts counting next tick. At
//      plantSec ticks: planted = {bot position, site}, carrier -> null, roundPlant event (bot: true).
//      A plant that completes on the round timer's last tick counts (planted beats timeout); a
//      planter killed on its finishing tick is dead in io.bots: no plant. The player's defuse can
//      start on the next tick.
// state.botPlant is separate from the player's state.plant; the view shows only botPlanting
// (botPlant > 0) and never which bot carries the spike (view.spike.carrier is 'player' or null).
// state.plantCue = {pan, gain} | null: the enemy plant sound (plantCue below), set at the end of
// each tick's plant / defuse steps. state.useHeld = the player's use key this tick (view.useHeld,
// for the in-app check; it is the player's own input, nothing about the bots).

export const ROUND_DEFAULTS = {
  barrierSec: 20, roundSec: 100, plantSec: 4, spikeSec: 45, defuseSec: 7, defuseCheckpointSec: 3.5,
  endHoldSec: 3, defuseRadius: 1.6, defuseFacingDeg: 60, pickupRadius: 1.5, holdMaxSpeed: 3.2, barrierPad: 0.4,
  blastRadius: 35,
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
// cfg.botStart === 'spawn': the kept spawners then move onto distinct enemy spawn points (a seeded
// shuffle of cfg.spawns[enemy side], given out in kept order; round-robin if there are fewer points
// than bots); the roundBot behaviour walks them to their setup (cfg.setupBySpawner). These draws
// come after the M1 ones, so the player spawn and the kept setups are the same as without it.
// cfg.side === 'defense': the attacker bots' plan, cfg.attack = { site, carrierSpawner,
// routeBySpawner, lurker, gatherSec } (attackPlan below), drawn after all of the above, so the player
// spawn and the kept spawners don't change. The attack side's output is unchanged (no cfg.attack).
export const ATTACK_LURK_P = 0.3, ATTACK_GATHER_SEC = [5, 20];
// Always exactly 6 draws (site, carrier, main route, lurk roll, lurker, gather), with or without
// cfg.attackData, so adding the map's attack data never changes the site / carrier of a seed.
// cfg.attackData = { routes: { <site>: [{ name, entry, staging: […] }] }, plant: { <site>: […] } }
// (the map json's `attack` block). kept = the kept spawner ids (sorted here).
//   site           one of cfg.sites' ids (sorted), or null
//   carrierSpawner one of the kept spawners, or null when none are kept
//   routeBySpawner { <spawnerId>: route name | null }: every bot takes the main route, the lurker
//                  the next one (when the site has 2+ routes); null without attackData
//   lurker         with probability ATTACK_LURK_P one kept non-carrier spawner, else null
//   gatherSec      how long after the barriers drop the group waits at staging at most (s)
function attackPlan(cfg, kept, r) {
  const u = { site: r(), carrier: r(), route: r(), lurk: r(), lurker: r(), gather: r() };
  const ids = kept.slice().sort();
  const sites = (cfg.sites ?? []).map((s) => s?.id).filter((id) => typeof id === 'string').sort();
  const site = sites.length ? sites[Math.floor(u.site * sites.length)] : null;
  const carrierSpawner = ids.length ? ids[Math.floor(u.carrier * ids.length)] : null;
  const others = ids.filter((id) => id !== carrierSpawner);
  const lurker = u.lurk < ATTACK_LURK_P && others.length ? others[Math.floor(u.lurker * others.length)] : null;
  const routes = site && Array.isArray(cfg.attackData?.routes?.[site]) ? cfg.attackData.routes[site] : [];
  const names = routes.map((rt) => rt?.name).filter((n) => typeof n === 'string');
  const main = names.length ? Math.floor(u.route * names.length) : -1;
  const routeBySpawner = {};
  for (const id of ids) routeBySpawner[id] = main < 0 ? null : names[id === lurker ? (main + 1) % names.length : main];
  const [g0, g1] = ATTACK_GATHER_SEC;
  return { site, carrierSpawner, routeBySpawner, lurker, gatherSec: Math.round((g0 + u.gather * (g1 - g0)) * 10) / 10 };
}
export function roundPrepare(doc, seed) {
  const cfg = doc?.rules?.round;
  if (!cfg || typeof cfg !== 'object' || cfg.prepared) return doc; // prepared docs pass through
  const r = rng(Number.isFinite(seed) ? seed : 1);
  const own = cfg.spawns?.[cfg.side === 'defense' ? 'defense' : 'attack'];
  let playerSpawn = doc.playerSpawn;
  if (Array.isArray(own) && own.length) {
    const p = own[Math.floor(r() * own.length)];
    playerSpawn = { position: { x: p.x, y: p.y, z: p.z }, yaw: p.yaw };
  }
  const groups = cfg.setups?.groups;
  let spawners = doc.spawners, kept = [];
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
    const pts = cfg.botStart === 'spawn' ? cfg.spawns?.[cfg.side === 'defense' ? 'attack' : 'defense'] : null;
    if (Array.isArray(pts) && pts.length) {
      const order = shuffle(pts, r), at = new Map();
      [...keep].forEach((id, i) => at.set(id, order[i % order.length]));
      spawners = spawners.map((s) => { const p = at.get(s.id); return p ? { ...s, position: { x: p.x, y: p.y, z: p.z } } : s; });
    }
    kept = [...keep];
  }
  if (cfg.side === 'defense') {
    const attack = attackPlan(cfg, kept, r);
    return { ...doc, playerSpawn, spawners, rules: { ...doc.rules, round: { ...cfg, prepared: true, attack } } };
  }
  return { ...doc, playerSpawn, spawners, rules: { ...doc.rules, round: { ...cfg, prepared: true } } };
}

export function roundCreate(cfg, tickSec) {
  const side = cfg?.side === 'defense' ? 'defense' : 'attack';
  return {
    phase: 'barrier', tick: 0, liveTick: 0, plantTick: -1, endTick: -1, done: false,
    side, playerAlive: true, enemiesDead: 0,
    spike: { carrier: side === 'attack' ? 'player' : null, dropped: null, planted: null },
    plant: 0, defuse: 0, checkpoint: false, holding: null, zone: null, near: false, defuser: null,
    botPlant: 0, carrierAt: null, plantCue: null, useHeld: false,
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
// No player shots: barrier phase, round over, dead, or a plant/defuse hold in progress. With the
// held keys and the player's position (feet) the hold that starts on this tick counts too (the
// use key near the spike only means "defuse" for a defending player).
export function roundNoFire(state, hold, cfg, pos) {
  if (!state) return false;
  if (state.phase === 'barrier' || state.phase === 'ended' || !state.playerAlive || state.holding !== null) return true;
  if (hold?.plant && cfg && pos && state.phase === 'live' && state.spike.carrier === 'player' && roundZoneAt(cfg, pos.x, pos.y, pos.z)) return true;
  return !!(hold?.use && state.near && state.side === 'defense');
}
// Detonation tick: true when `pos` (the player or a bot) is inside the blast; the sim then kills it.
export function roundBlast(cfg, state, pos) {
  const sp = state?.spike?.planted;
  if (!sp || state.reason !== 'detonated' || state.endTick !== state.tick || !pos) return false;
  return Math.hypot(pos.x - sp.x, pos.y - sp.y, pos.z - sp.z) <= num(cfg?.blastRadius, ROUND_DEFAULTS.blastRadius);
}
// Bots don't hurt the player: barrier phase, round over, or the player is already dead.
export function roundBotsHold(state) { return !!state && (state.phase === 'barrier' || state.phase === 'ended' || !state.playerAlive); }
// The use key doesn't pick weapons up while a plant / defuse is held, or while it could start a
// defuse (defending player near the spike).
export function roundBlocksUse(state) { return !!state && (state.holding !== null || (state.side === 'defense' && state.near)); }

const finiteNum = (v) => typeof v === 'number' && Number.isFinite(v);
// The bot whose defuse counts this tick (see the top comment), or null.
function electDefuser(cfg, state, bots) {
  const sp = state.spike.planted;
  if (!sp || !Array.isArray(bots)) return null;
  const r = num(cfg?.defuseRadius, ROUND_DEFAULTS.defuseRadius);
  let best = null;
  for (const b of bots) {
    if (!b || b.alive !== true || b.defusing !== 1 || !finiteNum(b.x) || !finiteNum(b.y) || !finiteNum(b.z)) continue;
    if (Math.hypot(b.x - sp.x, b.z - sp.z) > r || Math.abs(b.y - sp.y) >= 2) continue;
    if (b.id === state.defuser) return b;
    if (best === null || b.id < best.id) best = b;
  }
  return best;
}

const finiteXYZ = (b) => finiteNum(b.x) && finiteNum(b.y) && finiteNum(b.z);
const liveBot = (b) => !!b && b.alive === true && finiteNum(b.id) && finiteXYZ(b);
// Defense side: carrier check, drop, pickup, election (steps 1-3 in the top comment). Returns true
// when a bot got the spike this tick (its plant starts counting next tick).
function botCarrier(cfg, state, bots, enemyCount) {
  const sp = state.spike;
  if (finiteNum(sp.carrier)) {
    const b = bots.find((q) => q && q.id === sp.carrier);
    if (liveBot(b)) state.carrierAt = { x: b.x, y: b.y, z: b.z };
    else {
      const at = b && finiteXYZ(b) ? { x: b.x, y: b.y, z: b.z } : state.carrierAt;
      sp.carrier = null; state.carrierAt = null; state.botPlant = 0;
      sp.dropped = at ? { x: at.x, y: at.y, z: at.z } : null;
    }
  }
  if (sp.dropped && !sp.planted) {
    const d = sp.dropped, r = num(cfg?.pickupRadius, ROUND_DEFAULTS.pickupRadius);
    let best = null;
    for (const b of bots) {
      if (!liveBot(b) || Math.hypot(b.x - d.x, b.z - d.z) > r || Math.abs(b.y - d.y) >= 2) continue;
      if (best === null || b.id < best.id) best = b;
    }
    if (best) { sp.carrier = best.id; sp.dropped = null; state.carrierAt = { x: best.x, y: best.y, z: best.z }; return true; }
  }
  if (sp.carrier === null && !sp.dropped && !sp.planted) {
    const want = cfg?.attack?.carrierSpawner;
    let pick = null;
    for (const b of bots) if (liveBot(b) && want != null && b.spawnerId === want && (pick === null || b.id < pick.id)) pick = b;
    if (!pick && (bots.length >= enemyCount || state.phase !== 'barrier')) for (const b of bots) if (liveBot(b) && (pick === null || b.id < pick.id)) pick = b;
    if (pick) { sp.carrier = pick.id; state.carrierAt = { x: pick.x, y: pick.y, z: pick.z }; return true; }
  }
  return false;
}

// The enemy plant sound for a defending player (round-hud.js plays it), or null. Only while a bot
// plant is counting (live, botPlant > 0), the player is alive and the planter (carrierAt, refreshed
// this tick) is within PLANT_CUE_M (3D). pan = how far to the player's right the planter is (xz dot
// of the direction with the player's right vector (cos yaw, -sin yaw); forward is (-sin yaw, -cos
// yaw)), -1..1 in 0.25 steps; gain = 1 - d / PLANT_CUE_M in 0.1 steps (at least 0.1). Quantised and
// no position, so the HUD learns no more than a stereo sound would tell.
const PLANT_CUE_M = 30;
function plantCue(cfg, state, p) {
  const c = state.carrierAt;
  if (state.side !== 'defense' || state.phase !== 'live' || !(state.botPlant > 0) || !state.playerAlive || !c || !p) return null;
  const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z, d = Math.hypot(dx, dy, dz), h = Math.hypot(dx, dz);
  if (!(d <= PLANT_CUE_M)) return null;
  const yaw = Number.isFinite(p.yaw) ? p.yaw : 0;
  const right = h > 1e-6 ? (Math.cos(yaw) * dx - Math.sin(yaw) * dz) / h : 0;
  const pan = Math.round(right * 4) / 4 + 0, gain = Math.max(0.1, Math.round((1 - d / PLANT_CUE_M) * 10) / 10);
  return { pan, gain };
}

// One sim tick. io = { tick, tickSec, player:{x,y,z,yaw,speed,grounded,health,knife}, kills, hold:{plant,use},
// bots:[{id,alive,x,y,z,defusing,spawnerId,planting}] (optional; bot defuse, bot carrier / plant) }.
// knife: the melee weapon is out (switching to it cancels a plant / defuse).
// Returns events for this tick ({kind:'roundPhase'|'roundPlant'|'roundDefuse'|'roundEnd', …}).
export function roundStep(cfg, state, io) {
  const ev = [];
  if (!state) return ev;
  const t = io.tick, ts = io.tickSec;
  state.tick = t;
  if (state.phase === 'ended') {
    if (!state.done && t - state.endTick >= T(cfg, 'endHoldSec', ts)) state.done = true;
    state.holding = null; state.plantCue = null; state.useHeld = false;
    // Dying after the end (the blast) still freezes the player for the end banner.
    if ((io.player?.health ?? 1) <= 0) state.playerAlive = false;
    return ev;
  }
  const p = io.player, hold = io.hold ?? {};
  state.useHeld = !!hold.use;
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
  // Bot carrier, drop, pickup, election (defense side; see the top comment).
  const fresh = state.side === 'defense' && Array.isArray(io.bots) ? botCarrier(cfg, state, io.bots, enemyCount) : false;

  const steady = state.playerAlive && p.grounded !== false && !p.knife && (p.speed ?? 0) <= num(cfg?.holdMaxSpeed, ROUND_DEFAULTS.holdMaxSpeed);
  state.zone = state.playerAlive ? roundZoneAt(cfg, p.x, p.y, p.z) : null;
  const sp = state.spike.planted;
  state.near = false;
  if (sp && state.playerAlive && Math.abs(p.y - sp.y) < 2) {
    // Within reach and facing it (the game's forward is (-sin yaw, -cos yaw)); right on top of it
    // any direction counts.
    const dx = sp.x - p.x, dz = sp.z - p.z, d = Math.hypot(dx, dz);
    if (d <= num(cfg?.defuseRadius, ROUND_DEFAULTS.defuseRadius)) {
      const yaw = Number.isFinite(p.yaw) ? p.yaw : null;
      const cos = yaw === null || d < 0.6 ? 1 : (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d;
      state.near = cos >= Math.cos((num(cfg?.defuseFacingDeg, ROUND_DEFAULTS.defuseFacingDeg) * Math.PI) / 180);
    }
  }
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

  // Defuse: hold use near the planted spike (defending player), or a defending bot defusing it
  // (attacking player; see the top comment). Past the checkpoint a release keeps half the progress.
  const bot = state.phase === 'planted' && state.side === 'attack' ? electDefuser(cfg, state, io.bots) : null;
  const dropped = () => (state.checkpoint ? T(cfg, 'defuseCheckpointSec', ts) : 0);
  if (state.phase === 'planted' && state.side === 'defense' && state.near && steady && hold.use) {
    state.holding = 'defuse';
    state.defuse += 1;
    if (state.defuse >= T(cfg, 'defuseCheckpointSec', ts)) state.checkpoint = true;
    if (state.defuse >= T(cfg, 'defuseSec', ts)) defused = true;
  } else if (bot) {
    if (bot.id !== state.defuser) state.defuse = dropped();
    state.defuser = bot.id;
    state.defuse += 1;
    if (state.defuse >= T(cfg, 'defuseCheckpointSec', ts)) state.checkpoint = true;
    if (state.defuse >= T(cfg, 'defuseSec', ts)) defused = true;
  } else if (state.phase === 'planted') {
    state.defuse = dropped();
  }
  if (!bot) state.defuser = null;

  // Bot plant (defense side, step 4 in the top comment). Separate from the player's state.plant.
  if (state.side === 'defense') {
    const c = state.spike.carrier;
    const b = state.phase === 'live' && !fresh && finiteNum(c) && Array.isArray(io.bots) ? io.bots.find((q) => q && q.id === c) : null;
    const site = liveBot(b) && b.planting === 1 ? roundZoneAt(cfg, b.x, b.y, b.z) : null;
    if (site) {
      state.botPlant = (state.botPlant | 0) + 1;
      if (state.botPlant >= T(cfg, 'plantSec', ts)) {
        state.phase = 'planted'; state.plantTick = t; state.botPlant = 0;
        state.spike.carrier = null; state.carrierAt = null;
        state.spike.planted = { x: b.x, y: b.y, z: b.z, site };
        ev.push({ kind: 'roundPlant', site, bot: true });
      }
    } else state.botPlant = 0;
  }
  state.plantCue = plantCue(cfg, state, p);

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

// Site ids of a round config in data order (['A', 'B'] today), for the HUD's "Take the spike to
// A or B site" hint. One frozen array per cfg object (cached), so roundView allocates nothing for it.
const SITE_IDS = new WeakMap();
function siteIds(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  let ids = SITE_IDS.get(cfg);
  if (!ids) {
    ids = Object.freeze((Array.isArray(cfg.sites) ? cfg.sites : []).map((s) => s?.id).filter((id) => typeof id === 'string' && id !== ''));
    SITE_IDS.set(cfg, ids);
  }
  return ids;
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
    map: cfg?.map ?? null, sites: siteIds(cfg), side: state.side, phase: state.phase, timeLeft,
    spikeSec: num(cfg?.spikeSec, ROUND_DEFAULTS.spikeSec),
    plant: state.plant / T(cfg, 'plantSec', ts), defuse: state.defuse / T(cfg, 'defuseSec', ts),
    checkpoint: state.checkpoint, holding: state.holding, zone: state.zone, near: state.near,
    botDefusing: state.phase === 'planted' && state.defuser != null, defuser: state.defuser ?? null,
    botPlanting: state.phase === 'live' && (state.botPlant | 0) > 0,
    // the enemy plant sound ({pan, gain} or null, see plantCue) and the player's own use key
    plantCue: state.plantCue ? { pan: state.plantCue.pan, gain: state.plantCue.gain } : null,
    useHeld: state.useHeld === true,
    // never which bot carries it (defense side): carrier is 'player' or null
    carrying: state.spike.carrier === 'player',
    spike: { carrier: state.spike.carrier === 'player' ? 'player' : null, dropped: state.spike.dropped, planted: state.spike.planted },
    enemiesAlive: Math.max(0, enemyCount - state.enemiesDead), enemyCount, playerAlive: state.playerAlive,
    winner: state.winner, reason: state.reason, win: state.winner ? state.winner === state.side : null,
    done: state.done, tick: t,
  };
}
