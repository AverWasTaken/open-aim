// Round mode bots: the `roundBot` behaviour (defenders walk to their setups, hold, retake, defuse).
// Pure module: imports nothing from the game bundles and does NOTHING at import time (no fetch, no
// parsing). BiMsX6Xn.js imports it statically on every page (lobby, Studio), and CnrSARj_.js imports
// the two list builders (tools/round_bots_patch.py). Its only import is ./round-nav.mjs (pure).
//
// ---------------------------------------------------------------- contract (B1; B2/B3 rely on it)
// Exports
//   roundBotInit(cfg, actor, ctx)            behaviour init. ctx.round.bots is null here (init runs
//                                            inside the spawn step, before the list is attached).
//   roundBotUpdate(cfg, actor, ctx, dt, il)  behaviour update, every tick, also for dead actors.
//                                            il = the game's mover il(state, opts, actor, ctx, dt);
//                                            with ctx.ground (round bots are ground movers, GB) it
//                                            follows the real floor (JU). Pattern: `lN` (path).
//   aimRoundBotList(actors)                  -> ctx.round.bots, built once per tick right before the
//                                            behaviour loop: positions are start-of-tick, fields the
//                                            bots publish are one tick old (same for every bot).
//   aimRoundIoBots(actors)                   -> io.bots for roundStep (end of tick, after shots).
//   roundBotsInternals                       test-only helpers (cache reset, nav/mask/field access).
// cfg (the behaviour's own entry in the actor template): { kind: 'roundBot' } (no fields yet).
// ctx.round (round runs only; the key is absent in every other scene):
//   cfg    = scene.rules.round: map, side, barrierSec, roundSec, spikeSec, defuseSec, …, spawns,
//            barriers, sites, setups, botStart ('spawn': kept spawners stand on distinct enemy
//            spawn points, see roundPrepare), setupBySpawner { [spawnerId]: {name, group, x, y, z} }
//            (name joins the nav header's setups[name]), retake { A: [{name,x,y,z}], B: […] } when
//            the map data has it.
//   state  = the live round state (round-core.mjs roundCreate): phase 'barrier'|'live'|'planted'|
//            'ended', tick, liveTick, plantTick, spike.planted {x,y,z,site}, defuse, checkpoint,
//            defuser (bot id or null), playerAlive, … READ ONLY for bots.
//   bots   = aimRoundBotList entries (below) or null during init.
// Other ctx keys roundBot can use (all already there, no patch): ctx.tick, ctx.elapsed,
//   ctx.profile (runSpeed, eyeHeightStand, …), ctx.target.eye / ctx.target.canSee(pos) (the
//   player), ctx.enemyRank (rank id string, absent for "Default"), ctx.botMode (1 = Human-like
//   bots), ctx.speedScale (hit slow; absent = 1; il applies it itself), ctx.gameMovement (the
//   "game" movement setting; il then uses the game's acceleration model), ctx.ground(x, z, y, up,
//   down) -> floor y | null (only for ground movers when the scene has collision; never in init).
// ctx.round.bots entry: { id, spawnerId, alive, x, y, z, mode, defusing (0|1), seenTick, nav (0|1),
//   node, goal, arrived (0|1), moving (0|1) }
//   seenTick = the bot's shooter lastSeenTick (the shooter runs before roundBot in the template, so
//   "sees the player this tick" inside roundBotUpdate is actor.behavior.shooter.lastSeenTick ===
//   ctx.tick).
//   mode     = ROUND_BOT_MODE: static 0 (no nav: M1 bot on its setup spot), walk 1, hold 2 (on its
//              setup), wait 3 (barrier phase, setup beyond a defender barrier: stands at the last
//              reachable node in front of it), stuck 4 (gave up after STUCK_MAX re-plans, stands).
//   nav      = 1 when the bot runs on the nav graph (decided once in init), else 0 (fallback).
//   node     = the bot's current nav node (tracked among graph neighbours), -1 without nav.
//   goal     = its setup's nav node (or the substitute, see below), -1 without nav.
//   arrived  = 1 once it reached its setup (stays 1; the fallback bot is there from the start).
//   moving   = the sim's own actor.moving flag (one tick old), used for yielding.
//   B3 adds its own published fields here (no bundle re-patch needed).
// io.bots entry: { id, alive, x, y, z, defusing (0|1) } -> round-core's bot defuse (it elects and
//   confirms; the bots decide who walks to the spike).
// Flat fields on the actor (top level; the sim's save copies the actor one level deep):
//   actor.roundDefusing  0|1  set by roundBot; the shooter (MN) neither fires nor stops-to-shoot
//                             while it is 1 (it takes effect from the next tick: roundBot runs after
//                             the shooter). round-core only counts a defuse from io.bots.
//   actor.roundHoldFire  0|1  set by roundBot to 1 during the barrier phase: the shooter re-rolls
//                             its reaction time every tick it sees the player, so it starts when the
//                             barriers drop. roundBot also clears behavior.shooter.peeked on those
//                             ticks, so the roll at the drop is a first sighting (Human-like bots
//                             would otherwise take it as a quick re-peek, 0.7x).
// Behaviour state actor.behavior.roundBot: FLAT values only (the sim's save copies behaviour state
//   one level deep; nested objects would be shared between saves). It is also the il state (never
//   nest il state), so these names are reserved for il: index, speed, finished, air, vy, jy, jb,
//   stuck. Nav graphs, distance fields and other derived data live in module-scope caches that
//   are pure functions of their inputs; no rng draw or branch may depend on whether a cache is warm,
//   and no mutable shared state between bots lives here (coordination goes through ctx.round.bots).
// Randomness: actor.rng only (per actor, saved/restored by the sim). Never Math.random.
// Nav: globalThis.__aimRoundNav[map] = ArrayBuffer of <map>.nav.bin (app/round-panel.js prefetches
//   it; node tests set it). Missing/bad nav -> the fallback below (M1 static bots). Decide nav vs
//   fallback ONCE per bot in roundBotInit and keep it in the flat state (a nav that arrives mid-run
//   must not switch a running round; a fetch can finish late on a cold first launch).
//
// ---------------------------------------------------------------- B2: movement
// Nav mode (st.nav = 1) is chosen in init when the nav parses, the bot's spawn point has a node
// and its setup (header setups[name].node, else the nearest node) can be reached from that node on
// walk+drop edges. A setup node that can't be reached (Ascent "B site front", walk:false) is
// replaced by the nearest reachable node within 2.5 m xz and |dy| <= 0.5; the bot holds there with
// the setup's facing. Otherwise the bot falls back to the v0 static bot (setup spot, faces the
// player). Nav mode never teleports.
// Graph: walk (0) and drop (1) edges only. Distance fields run over INCOMING edges (round-nav
// reverseEdges), per (map, goal node, barrier mask), in a module cache, all computed in init.
// Barrier mask: the enemy team's barriers (rules.round.barriers, team = the bots' side) cut every
// edge whose xz segment crosses a barrier segment while either end's floor y is in the barrier's
// y range (the same rule as tools/round_navlib.mjs edgeCutBy / barrierMask). During the barrier
// phase bots use the masked field, track their node only over unmasked edges and never take a
// straight line that crosses an active barrier. If the setup is beyond an active barrier (masked
// field = Infinity), the bot walks to the masked-reachable node with the lowest unmasked time to
// the setup (st.wait), waits there (mode wait) and goes on when the barriers drop.
// Movement: every tick the bot re-picks its target: the farthest of the next <= 8 nodes down the
// field whose straight xz line from the bot has a node of the same floor (|dy| <= 0.5 against
// the interpolated floor height) in every 0.5 m nav cell it crosses (sampled every 0.1 m), with no
// floor bend > 0.15 m along the chain, no non-walk edge before it, and (barrier phase) no barrier
// crossing. A drop edge is taken alone (the target is the drop's lower node; il walks off the
// ledge and falls). il gets [here, target, next] with index reset to 1, so it never reaches the
// last waypoint of an intermediate target (JU zeroes the speed there whatever `finish` is); only
// the goal gets [here, goal] with finish 'stop'. Speed = ctx.profile.runSpeed (il applies
// speedScale). On a new target node `stuck` is deleted (else il's auto-jump stays off).
// Spawn: seeded 0-0.6 s stagger (actor.rng) before the first step.
// Hold: on the setup, facing header setups[name].face (sim yaw, atan2(dx, dz)); with face2 it
// switches between the two every seeded 4-8 s. Without a header facing: toward the attacker spawn.
// Barrier phase: combatHold is ignored (bots keep walking and face where they walk).
// After the drop: the bot brakes while actor.combatHold === 1 and it is not airborne (as lN), so the
// shooter (which won't fire while the bot moves) can shoot; it faces the player while it sees them
// (shooter.lastSeenTick === ctx.tick) or holds combat, and walks on once the shooter lets go.
// Facing turns at most 540 deg/s.
// Yield: a walking bot brakes for a MOVING bot with a lower id that is within 0.9 m and ahead
// (60 deg cone, same floor), at most 0.75 s in a row, then ignores yields for 1 s (passes through).
// Stuck: if the field value at the bot's node hasn't dropped by 0.2 s in 2 s of free walking, it
// re-finds its node globally (re-plan); after 3 re-plans it stands where it is (mode stuck).
// Dead: clears its flags; if it died in the air it finishes the fall (il with brake), as lN.
// Flat state (nav mode): nav, mode, snap, spawn, goal, setup, wait, cur, tgt, tx, ty, tz, goT,
//   arrived, arriveT, fk, best, bestT, replans, yieldT, yieldCd, face, face2, face2On, faceSel,
//   altT + il's own (index, speed, finished, air, vy, jy, jb, stuck). -1 = none.

import { parseRoundNav, reverseEdges, NAV_WALK, NAV_DROP } from './round-nav.mjs';

export const ROUND_BOT_MODE = { static: 0, walk: 1, hold: 2, wait: 3, stuck: 4 };
const MODE = ROUND_BOT_MODE;

const RUN_SPEED = 6.75;
const TURN_RATE = (540 * Math.PI) / 180; // rad/s
const LOOK_AHEAD = 8;
const STAGGER_SEC = 0.6;
const YIELD_DIST = 0.9, YIELD_MAX = 0.75, YIELD_COOLDOWN = 1, YIELD_COS = 0.5;
const STUCK_SEC = 2, STUCK_GAIN = 0.2, STUCK_MAX = 3;
const HOLD_LEAVE = 1.5; // m from the goal before a holding bot walks back
const ALT_MIN = 4, ALT_MAX = 8;
const SUBST_R = 2.5, SUBST_DY = 0.5;
const LINE_STEP = 0.1, LINE_DY = 0.5, BEND_DY = 0.15;
const WD = (1 << NAV_WALK) | (1 << NAV_DROP);
const FAR = 1e9; // 'no value yet' in the flat state (Infinity would not survive a JSON copy)

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function setupOf(ctx, actor) {
  const s = ctx?.round?.cfg?.setupBySpawner?.[actor.spawnerId];
  return s && finite(s.x) && finite(s.y) && finite(s.z) ? s : null;
}

// Face the player (sim convention: facingYaw = atan2(dx, dz), like the spawners' faceTarget).
function facePlayer(actor, ctx) {
  const e = ctx?.target?.eye;
  if (!e) return;
  const dx = e.x - actor.position.x, dz = e.z - actor.position.z;
  if (dx !== 0 || dz !== 0) actor.facingYaw = Math.atan2(dx, dz);
}

const holdFire = (ctx) => (ctx?.round?.state?.phase === 'barrier' ? 1 : 0);

// ---------------------------------------------------------------- nav caches (pure)
let NAVS = new WeakMap(); // nav buffer -> nav data | null

function navFor(map) {
  const buf = globalThis.__aimRoundNav?.[map];
  if (!buf || typeof buf !== 'object' || !(buf instanceof ArrayBuffer || ArrayBuffer.isView(buf))) return null;
  if (NAVS.has(buf)) return NAVS.get(buf);
  let N = null;
  try { N = buildNav(buf); } catch { N = null; }
  NAVS.set(buf, N);
  return N;
}

function buildNav(buf) {
  const g = parseRoundNav(buf);
  const n = g.count;
  if (!n) return null;
  const h = g.header && typeof g.header === 'object' ? g.header : {};
  const cell = finite(h.cell) && h.cell > 0 ? h.cell : 0.5;
  let ox = h.originX, oz = h.originZ;
  if (!finite(ox) || !finite(oz)) { ox = Infinity; oz = Infinity; for (let i = 0; i < n; i++) { ox = Math.min(ox, g.x[i]); oz = Math.min(oz, g.z[i]); } }
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  const ci = new Int32Array(n), cj = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    ci[i] = Math.round((g.x[i] - ox) / cell); cj[i] = Math.round((g.z[i] - oz) / cell);
    i0 = Math.min(i0, ci[i]); j0 = Math.min(j0, cj[i]); i1 = Math.max(i1, ci[i]); j1 = Math.max(j1, cj[i]);
  }
  const W = i1 - i0 + 1, H = j1 - j0 + 1, head = new Int32Array(W * H).fill(-1), next = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) { const c = (ci[i] - i0) * H + (cj[i] - j0); next[i] = head[c]; head[c] = i; }
  return { g, rev: reverseEdges(g), header: h, cell, ox, oz, i0, j0, W, H, head, next, masks: new Map(), fields: new Map(), reach: new Map() };
}

// First node of the nav cell holding (x, z), or -1; walk the list with N.next.
function cellHead(N, x, z) {
  const i = Math.round((x - N.ox) / N.cell) - N.i0, j = Math.round((z - N.oz) / N.cell) - N.j0;
  return i < 0 || j < 0 || i >= N.W || j >= N.H ? -1 : N.head[i * N.H + j];
}
// Is there a node of floor height ~y in the cell holding (x, z)?
function cellHasFloor(N, x, z, y, dy) {
  for (let k = cellHead(N, x, z); k >= 0; k = N.next[k]) if (Math.abs(N.g.y[k] - y) <= dy) return true;
  return false;
}

// Nodes within xz radius r of (x, z), filtered by |dy| <= maxDy when y is given; nearest first
// (ties: lowest id).
function nodesNear(N, x, z, r, y = null, maxDy = Infinity) {
  const g = N.g, out = [], c = Math.ceil(r / N.cell) + 1;
  const bi = Math.round((x - N.ox) / N.cell) - N.i0, bj = Math.round((z - N.oz) / N.cell) - N.j0;
  for (let i = Math.max(0, bi - c); i <= Math.min(N.W - 1, bi + c); i++) for (let j = Math.max(0, bj - c); j <= Math.min(N.H - 1, bj + c); j++) {
    for (let k = N.head[i * N.H + j]; k >= 0; k = N.next[k]) {
      const d = Math.hypot(g.x[k] - x, g.z[k] - z);
      if (d <= r && (y === null || Math.abs(g.y[k] - y) <= maxDy)) out.push([k, d]);
    }
  }
  return out.sort((p, q) => p[1] - q[1] || p[0] - q[0]).map((p) => p[0]);
}
function nearestNode(N, x, z, r, y = null, maxDy = Infinity) {
  const l = nodesNear(N, x, z, r, y, maxDy);
  return l.length ? l[0] : -1;
}

// ---------------------------------------------------------------- barriers (= tools/round_navlib.mjs)
const orient = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = orient(cx, cz, dx, dz, ax, az), d2 = orient(cx, cz, dx, dz, bx, bz), d3 = orient(ax, az, bx, bz, cx, cz), d4 = orient(ax, az, bx, bz, dx, dz);
  if (d1 === 0 && d2 === 0) return false;
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}
const inBarY = (b, y) => !Array.isArray(b.y) || (y >= b.y[0] && y <= b.y[1]);
// A move/line from (ax, az) at floor ya to (bx, bz) at floor yb is cut by a barrier when it crosses
// the segment and either floor height is inside the barrier's y range (navlib edgeCutBy).
function lineCut(bars, ax, az, ya, bx, bz, yb) {
  for (const b of bars) if ((inBarY(b, ya) || inBarY(b, yb)) && segCross(ax, az, bx, bz, b.a.x, b.a.z, b.b.x, b.b.z)) return true;
  return false;
}
// The barriers that hold the bots in: the enemy team's (the bots defend when the player attacks).
function barriersOf(cfg) {
  const team = cfg?.side === 'defense' ? 'attack' : 'defense';
  return (cfg?.barriers ?? []).filter((b) => b && b.team === team && b.a && b.b && finite(b.a.x) && finite(b.a.z) && finite(b.b.x) && finite(b.b.z));
}
const barKey = (bars) => bars.map((b) => `${b.a.x},${b.a.z},${b.b.x},${b.b.z},${Array.isArray(b.y) ? b.y.join('/') : '*'}`).join(';');
// Per-edge cut flags (1 = blocked) for a barrier list; null when there are no barriers.
function maskFor(N, bars) {
  if (!bars.length) return null;
  const key = barKey(bars);
  let m = N.masks.get(key);
  if (m) return m;
  const g = N.g;
  m = new Uint8Array(g.edgeCount);
  for (let i = 0; i < g.count; i++) for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
    const j = g.edgeTo[e];
    if (lineCut(bars, g.x[i], g.z[i], g.y[i], g.x[j], g.z[j], g.y[j])) m[e] = 1;
  }
  N.masks.set(key, m);
  MASK_IDS.set(m, key);
  return m;
}
let MASK_IDS = new WeakMap(), maskSeq = 0; // mask array -> cache key part
function maskId(mask) {
  if (!mask) return '';
  let k = MASK_IDS.get(mask);
  if (k === undefined) { k = `#${++maskSeq}`; MASK_IDS.set(mask, k); } // a mask from elsewhere (tests)
  return k;
}

// ---------------------------------------------------------------- fields
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = v.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] < key || (k[p] === key && v[p] <= val)) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = v.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && (k[c + 1] < k[c] || (k[c + 1] === k[c] && v[c + 1] < v[c]))) c++;
        if (k[c] > lk || (k[c] === lk && v[c] >= lv)) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}
// Time (s) from every node to `goal` over walk+drop edges not cut by `mask` (incoming edges), with
// via[i] = the next node toward the goal and viaE[i] = the edge i -> via[i] (-1 at the goal or
// when unreachable).
function fieldFor(N, goal, mask) {
  const key = `${goal}|${maskId(mask)}`;
  let f = N.fields.get(key);
  if (f) return f;
  const g = N.g, R = N.rev, n = g.count;
  const dist = new Float64Array(n).fill(Infinity), via = new Int32Array(n).fill(-1), viaE = new Int32Array(n).fill(-1), done = new Uint8Array(n), h = new Heap();
  dist[goal] = 0; h.push(0, goal);
  while (h.size) {
    const i = h.pop();
    if (done[i]) continue;
    done[i] = 1;
    const di = dist[i];
    for (let p = R.revStart[i]; p < R.revStart[i + 1]; p++) {
      const e = R.revEdge[p];
      if (!(WD >> g.edgeType[e] & 1) || (mask && mask[e])) continue;
      const j = R.revFrom[p], nd = di + g.edgeCost[e];
      if (nd < dist[j]) { dist[j] = nd; via[j] = i; viaE[j] = e; h.push(nd, j); }
    }
  }
  f = { goal, dist, via, viaE };
  N.fields.set(key, f);
  return f;
}
// Nodes reachable FROM src over walk+drop edges not cut by mask (1 = reached).
function reachFor(N, src, mask) {
  const key = `${src}|${maskId(mask)}`;
  let r = N.reach.get(key);
  if (r) return r;
  const g = N.g;
  r = new Uint8Array(g.count);
  const q = [src]; r[src] = 1;
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
      if (!(WD >> g.edgeType[e] & 1) || (mask && mask[e])) continue;
      const j = g.edgeTo[e];
      if (!r[j]) { r[j] = 1; q.push(j); }
    }
  }
  N.reach.set(key, r);
  return r;
}

// ---------------------------------------------------------------- node tracking + target
const dxz = (g, i, x, z) => Math.hypot(g.x[i] - x, g.z[i] - z);

// The bot's node, re-picked among its graph neighbours (outgoing walk/drop up to 2 hops, incoming
// walk 1 hop, edges allowed by mask), nearest in xz; ties keep the earlier candidate (cur first).
function trackNode(N, cur, x, z, mask) {
  const g = N.g, R = N.rev;
  let best = cur, bd = dxz(g, cur, x, z);
  const take = (j) => { const d = dxz(g, j, x, z); if (d < bd) { bd = d; best = j; } };
  for (let e = g.edgeStart[cur]; e < g.edgeStart[cur + 1]; e++) {
    if (!(WD >> g.edgeType[e] & 1) || (mask && mask[e])) continue;
    const j = g.edgeTo[e];
    take(j);
    for (let e2 = g.edgeStart[j]; e2 < g.edgeStart[j + 1]; e2++) if ((WD >> g.edgeType[e2] & 1) && !(mask && mask[e2])) take(g.edgeTo[e2]);
  }
  for (let p = R.revStart[cur]; p < R.revStart[cur + 1]; p++) {
    const e = R.revEdge[p];
    if (g.edgeType[e] === NAV_WALK && !(mask && mask[e])) take(R.revFrom[p]);
  }
  return best;
}
// Global re-find (init / lost / re-plan): nearest node within r, on the bot's floor when the bot
// stands on the nav's floors (real collision); xz only otherwise (flat test ground).
function refindNode(N, x, y, z, r, hint) {
  const onNav = hint >= 0 && Math.abs(N.g.y[hint] - y) < 0.8;
  const k = onNav ? nearestNode(N, x, z, r, y, 1) : -1;
  return k >= 0 ? k : nearestNode(N, x, z, r);
}

// Straight xz line from (x0, z0) to node k: every 0.5 m cell on it has a node of the same floor
// (floor height interpolated from y0 to y[k]).
function lineOnFloor(N, x0, z0, y0, k) {
  const g = N.g, x1 = g.x[k], z1 = g.z[k], y1 = g.y[k], len = Math.hypot(x1 - x0, z1 - z0), steps = Math.max(1, Math.ceil(len / LINE_STEP));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (!cellHasFloor(N, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, y0 + (y1 - y0) * t, LINE_DY)) return false;
  }
  return true;
}

// The node to steer to this tick, plus the node after it (-1 when the target is the goal).
function pickTarget(N, F, cur, x, z, bars) {
  const g = N.g;
  if (cur === F.goal || F.viaE[cur] < 0) return [cur, -1];
  const y0 = g.y[cur], chain = [cur], cum = [0];
  let best = -1;
  for (let k = 1, n = cur; k <= LOOK_AHEAD && n !== F.goal; k++) {
    const e = F.viaE[n], m = F.via[n];
    if (e < 0) break;
    const cut = bars.length > 0 && lineCut(bars, x, z, y0, g.x[m], g.z[m], g.y[m]);
    if (g.edgeType[e] !== NAV_WALK) { if (k === 1 && !cut) best = m; break; }
    chain.push(m); cum.push(cum[k - 1] + Math.hypot(g.x[m] - g.x[n], g.z[m] - g.z[n]));
    let ok = !cut;
    for (let q = 1; ok && q < k; q++) {
      const want = y0 + (g.y[m] - y0) * (cum[k] > 0 ? cum[q] / cum[k] : 0);
      if (Math.abs(g.y[chain[q]] - want) > BEND_DY) ok = false;
    }
    if (ok && !lineOnFloor(N, x, z, y0, m)) ok = false;
    if (!ok) { if (k === 1 && !cut) best = m; break; }
    best = m; n = m;
  }
  if (best < 0) best = cur;
  return [best, best === F.goal ? -1 : F.via[best]];
}

// ---------------------------------------------------------------- facing
function turnTo(actor, want, dt) {
  if (!finite(want)) return;
  const cur = finite(actor.facingYaw) ? actor.facingYaw : want, d = wrap(want - cur), max = TURN_RATE * dt;
  actor.facingYaw = wrap(cur + Math.max(-max, Math.min(max, d)));
}
function yawTo(actor, x, z) {
  const dx = x - actor.position.x, dz = z - actor.position.z;
  return dx * dx + dz * dz > 1e-6 ? Math.atan2(dx, dz) : NaN;
}

// ---------------------------------------------------------------- init
// Nav mode decision + all fields (computed here, not at the barrier drop). Returns false for the
// fallback.
function navInit(actor, ctx, s, st) {
  const cfg = ctx.round.cfg, N = navFor(cfg.map);
  if (!N) return false;
  const g = N.g, p = actor.position;
  let spawn = nearestNode(N, p.x, p.z, 1.5, p.y, 1.5);
  if (spawn < 0) spawn = nearestNode(N, p.x, p.z, 1.5);
  if (spawn < 0) return false;
  const hs = N.header.setups && typeof N.header.setups === 'object' ? N.header.setups[s.name] : null;
  let setup = hs && Number.isInteger(hs.node) && hs.node >= 0 && hs.node < g.count ? hs.node : -1;
  if (setup < 0) setup = nearestNode(N, s.x, s.z, 0.75, s.y, 1);
  if (setup < 0) return false;
  const reach = reachFor(N, spawn, null);
  let goal = setup;
  if (!reach[goal]) goal = nodesNear(N, g.x[setup], g.z[setup], SUBST_R, g.y[setup], SUBST_DY).find((k) => reach[k]) ?? -1;
  if (goal < 0) return false;
  const Fu = fieldFor(N, goal, null);
  if (!finite(Fu.dist[spawn])) return false;
  const mask = maskFor(N, barriersOf(cfg));
  let wait = -1;
  if (mask) {
    const Fm = fieldFor(N, goal, mask);
    if (!finite(Fm.dist[spawn])) {
      const rm = reachFor(N, spawn, mask);
      let bt = Infinity;
      for (let i = 0; i < g.count; i++) if (rm[i] && Fu.dist[i] < bt) { bt = Fu.dist[i]; wait = i; }
      if (wait < 0) return false;
      fieldFor(N, wait, mask);
    }
  }
  let face = hs && finite(hs.face) ? hs.face : NaN;
  if (!finite(face)) {
    const a = cfg.spawns?.[cfg.side === 'defense' ? 'defense' : 'attack']?.[0];
    face = a && finite(a.x) && finite(a.z) ? Math.atan2(a.x - g.x[goal], a.z - g.z[goal]) : 0;
  }
  const face2 = hs && finite(hs.face2) ? hs.face2 : face;
  Object.assign(st, {
    nav: 1, mode: MODE.walk, spawn, setup, goal, wait, cur: spawn, tgt: -1, tx: p.x, ty: p.y, tz: p.z,
    goT: ctx.elapsed + actor.rng.range(0, STAGGER_SEC), arrived: 0, arriveT: -1, fk: -1, best: FAR, bestT: ctx.elapsed,
    replans: 0, yieldT: 0, yieldCd: -1, face, face2, face2On: hs && finite(hs.face2) ? 1 : 0, faceSel: 0, altT: -1,
    index: 0, speed: 0, finished: false,
  });
  // Initial facing: down the route (a few nodes ahead on the barrier-phase field).
  const F0 = wait >= 0 ? fieldFor(N, wait, mask) : fieldFor(N, goal, holdFire(ctx) ? mask : null);
  let k = spawn;
  for (let i = 0; i < 6 && F0.via[k] >= 0; i++) k = F0.via[k];
  const y0 = yawTo(actor, g.x[k], g.z[k]);
  actor.facingYaw = finite(y0) ? y0 : face;
  return true;
}

export function roundBotInit(cfg, actor, ctx) {
  const st = { mode: MODE.static, snap: 0, nav: 0, arrived: 0 };
  actor.behavior.roundBot = st;
  actor.roundDefusing = 0;
  actor.roundHoldFire = holdFire(ctx);
  const s = setupOf(ctx, actor);
  if (s && ctx.round?.cfg && navInit(actor, ctx, s, st)) return;
  if (s) {
    actor.position = { x: s.x, y: s.y, z: s.z };
    st.snap = 1; // the setup's y is approximate: snap to the floor on the first update (ctx.ground)
    st.arrived = 1;
  }
  facePlayer(actor, ctx);
}

// ---------------------------------------------------------------- update
function shouldYield(actor, ctx, st) {
  const list = ctx.round?.bots;
  if (!Array.isArray(list) || ctx.elapsed < st.yieldCd) return false;
  const p = actor.position;
  let ux = st.tx - p.x, uz = st.tz - p.z;
  const ul = Math.hypot(ux, uz);
  if (ul < 1e-6) return false;
  ux /= ul; uz /= ul;
  for (const o of list) {
    if (!o || o.id === actor.id || !o.alive || o.moving !== 1 || !(o.id < actor.id)) continue;
    const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
    if (d > YIELD_DIST || d < 1e-6 || Math.abs(o.y - p.y) > 1.5) continue;
    if ((dx * ux + dz * uz) / d > YIELD_COS) return true;
  }
  return false;
}

function arrive(actor, ctx, st, goal) {
  st.mode = goal === st.goal ? MODE.hold : MODE.wait;
  st.speed = 0;
  if (st.mode === MODE.hold && st.arrived !== 1) {
    st.arrived = 1; st.arriveT = ctx.elapsed;
    if (st.face2On === 1) st.altT = ctx.elapsed + actor.rng.range(ALT_MIN, ALT_MAX);
  }
}

function navUpdate(actor, ctx, dt, il, st) {
  const cfg = ctx.round?.cfg, N = cfg ? navFor(cfg.map) : null;
  if (!N) { st.speed = 0; return; } // the nav went away mid-run (never in the app): stand
  const g = N.g, p = actor.position, barrier = ctx.round.state?.phase === 'barrier';
  const bars = barrier ? barriersOf(cfg) : [], mask = barrier ? maskFor(N, bars) : null;
  if (st.mode === MODE.stuck) { st.speed = 0; faceIdle(actor, ctx, st, dt, barrier); return; }

  // Node tracking (neighbours only; global re-find when lost).
  st.cur = trackNode(N, st.cur, p.x, p.z, mask);
  if (dxz(g, st.cur, p.x, p.z) > 1) { const k = refindNode(N, p.x, p.y, p.z, 2.5, st.cur); if (k >= 0) st.cur = k; }

  // Field: barrier phase -> masked to the setup, or to the wait node when the setup is beyond a
  // barrier; after the drop -> unmasked to the setup.
  let F = fieldFor(N, st.goal, mask);
  if (barrier && !finite(F.dist[st.cur]) && st.wait >= 0) F = fieldFor(N, st.wait, mask);
  const goal = F.goal, fk = goal * 2 + (barrier ? 1 : 0);
  if (fk !== st.fk) {
    st.fk = fk; st.best = FAR; st.bestT = ctx.elapsed;
    if (st.mode === MODE.hold || st.mode === MODE.wait) { if (goal !== (st.mode === MODE.hold ? st.goal : st.wait) || dxz(g, goal, p.x, p.z) > 0.1) st.mode = MODE.walk; }
  }
  if (!finite(F.dist[st.cur])) { st.speed = 0; faceIdle(actor, ctx, st, dt, barrier); return; } // cut off (never on Ascent)

  if (st.mode === MODE.hold || st.mode === MODE.wait) {
    if (dxz(g, goal, p.x, p.z) <= HOLD_LEAVE) { faceIdle(actor, ctx, st, dt, barrier); return; }
    st.mode = MODE.walk; st.best = FAR; st.bestT = ctx.elapsed;
  }

  // Walk.
  if (ctx.elapsed < st.goT) { st.bestT = ctx.elapsed; faceIdle(actor, ctx, st, dt, barrier); return; } // spawn stagger
  const [t, t2] = pickTarget(N, F, st.cur, p.x, p.z, bars);
  if (t !== st.tgt) { delete st.stuck; st.tgt = t; }
  st.tx = g.x[t]; st.ty = g.y[t]; st.tz = g.z[t];
  if (t === goal && dxz(g, goal, p.x, p.z) <= 0.02 && (st.speed ?? 0) <= 0.05) { arrive(actor, ctx, st, goal); faceIdle(actor, ctx, st, dt, barrier); return; }
  const combat = !barrier && actor.combatHold === 1 && st.air !== 1;
  let yieldNow = false;
  if (!combat && shouldYield(actor, ctx, st)) {
    st.yieldT += dt;
    if (st.yieldT > YIELD_MAX) { st.yieldT = 0; st.yieldCd = ctx.elapsed + YIELD_COOLDOWN; } else yieldNow = true;
  } else st.yieldT = 0;
  const brake = combat || yieldNow;
  const way = [{ x: p.x, y: p.y, z: p.z }, { x: st.tx, y: st.ty, z: st.tz }];
  if (t2 >= 0) way.push({ x: g.x[t2], y: g.y[t2], z: g.z[t2] });
  st.finished = false; st.index = 1;
  const speed = finite(ctx.profile?.runSpeed) ? ctx.profile.runSpeed : RUN_SPEED;
  if (typeof il === 'function') il(st, { waypoints: way, loop: false, speed, finish: t2 >= 0 ? 'run' : 'stop', ...(brake ? { brake: true } : {}) }, actor, ctx, dt);
  if (t === goal && st.finished === true) arrive(actor, ctx, st, goal);

  // Stuck: no progress down the field in STUCK_SEC of free walking -> re-plan, then give up.
  const fv = F.dist[st.cur];
  if (brake || st.air === 1) st.bestT = ctx.elapsed;
  else if (fv < st.best - STUCK_GAIN) { st.best = fv; st.bestT = ctx.elapsed; }
  else if (st.mode === MODE.walk && ctx.elapsed - st.bestT > STUCK_SEC) {
    st.replans += 1;
    const k = refindNode(N, p.x, p.y, p.z, 2.5, st.cur);
    if (k >= 0) st.cur = k;
    st.best = F.dist[st.cur]; st.bestT = ctx.elapsed;
    if (st.replans >= STUCK_MAX) { st.mode = MODE.stuck; st.speed = 0; }
  }

  // Facing.
  if (!barrier && (actor.combatHold === 1 || actor.behavior.shooter?.lastSeenTick === ctx.tick)) facePlayerCapped(actor, ctx, dt);
  else if (st.mode === MODE.walk) turnTo(actor, yawTo(actor, st.tx, st.tz), dt);
  else faceIdle(actor, ctx, st, dt, barrier);
}

function facePlayerCapped(actor, ctx, dt) {
  const e = ctx?.target?.eye;
  if (e) turnTo(actor, yawTo(actor, e.x, e.z), dt);
}

// Facing while not walking: the player in combat (after the drop), else the setup's angle (hold:
// face / face2 by turns; wait: toward the setup; stagger: down the route).
function faceIdle(actor, ctx, st, dt, barrier) {
  if (!barrier && (actor.combatHold === 1 || actor.behavior.shooter?.lastSeenTick === ctx.tick)) { facePlayerCapped(actor, ctx, dt); return; }
  if (st.mode === MODE.hold || st.mode === MODE.stuck) {
    if (st.mode === MODE.hold && st.face2On === 1 && st.altT >= 0 && ctx.elapsed >= st.altT) {
      st.faceSel = st.faceSel === 1 ? 0 : 1;
      st.altT = ctx.elapsed + actor.rng.range(ALT_MIN, ALT_MAX);
    }
    turnTo(actor, st.faceSel === 1 ? st.face2 : st.face, dt);
    return;
  }
  if (st.mode === MODE.wait) {
    const N = navFor(ctx.round.cfg.map);
    if (N) turnTo(actor, yawTo(actor, N.g.x[st.goal], N.g.z[st.goal]), dt);
  }
  // walk during the stagger: keep the initial facing (down the route).
}

export function roundBotUpdate(cfg, actor, ctx, dt, il) {
  const st = actor.behavior?.roundBot;
  if (!st) return;
  if (!actor.alive) {
    actor.roundDefusing = 0; actor.roundHoldFire = 0;
    // Died in the air: finish the fall with brake (lN's dead-mid-air handling) so it doesn't hang.
    if (st.nav === 1) {
      st.speed = 0;
      if (st.air === 1 && typeof il === 'function') {
        st.finished = false; st.index = 1;
        const p = actor.position;
        il(st, { waypoints: [{ x: p.x, y: p.y, z: p.z }, { x: st.tx, y: st.ty, z: st.tz }], loop: false, speed: 0, brake: true }, actor, ctx, dt);
      }
    }
    return;
  }
  actor.roundHoldFire = holdFire(ctx);
  if (actor.roundHoldFire === 1 && actor.behavior.shooter) actor.behavior.shooter.peeked = false;
  if (st.nav === 1) { navUpdate(actor, ctx, dt, il, st); return; }
  if (st.snap === 1 && typeof ctx.ground === 'function') {
    const p = actor.position;
    const g = ctx.ground(p.x, p.z, p.y, 2.5, 4); // the spawn snap's reach (BiMsX6Xn db: up 2.5, down 4)
    if (g !== null && finite(g)) actor.position = { x: p.x, y: g, z: p.z };
    st.snap = 0;
  }
  facePlayer(actor, ctx);
}

export function aimRoundBotList(actors) {
  const out = [];
  for (const a of actors) {
    const s = a.behavior?.roundBot;
    if (!s) continue;
    out.push({
      id: a.id, spawnerId: a.spawnerId ?? null, alive: a.alive === true,
      x: a.position.x, y: a.position.y, z: a.position.z,
      mode: s.mode, defusing: a.roundDefusing === 1 ? 1 : 0, seenTick: a.behavior.shooter?.lastSeenTick ?? -1,
      nav: s.nav === 1 ? 1 : 0, node: s.nav === 1 ? s.cur : -1, goal: s.nav === 1 ? s.goal : -1,
      arrived: s.arrived === 1 ? 1 : 0, moving: a.moving === true ? 1 : 0,
    });
  }
  return out;
}

export function aimRoundIoBots(actors) {
  const out = [];
  for (const a of actors) {
    if (!a.behavior?.roundBot) continue;
    out.push({ id: a.id, alive: a.alive === true, x: a.position.x, y: a.position.y, z: a.position.z, defusing: a.roundDefusing === 1 ? 1 : 0 });
  }
  return out;
}

// Test-only access to the module caches and helpers (pure; nothing here runs at import time).
export const roundBotsInternals = {
  resetCaches() { NAVS = new WeakMap(); MASK_IDS = new WeakMap(); },
  navFor, maskFor, fieldFor, reachFor, barriersOf, nearestNode, nodesNear, cellHasFloor, lineCut, pickTarget, trackNode,
  MODE, RUN_SPEED, TURN_RATE, YIELD_DIST, YIELD_MAX, STAGGER_SEC,
};
