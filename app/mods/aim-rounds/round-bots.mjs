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
//            attack / attackData (defense side: roundPrepare's attacker plan + the map's attack data),
//            barriers, sites, setups, botStart ('spawn': kept spawners stand on distinct enemy
//            spawn points, see roundPrepare), setupBySpawner { [spawnerId]: {name, group, x, y, z} }
//            (name joins the nav header's setups[name]), retake { A: [{name,x,y,z}], B: […] } when
//            the map data has it.
//   state  = the live round state (round-core.mjs roundCreate): phase 'barrier'|'live'|'planted'|
//            'ended', tick, liveTick, plantTick, spike {carrier (bot id | 'player' | null), dropped,
//            planted {x,y,z,site}}, botPlant, defuse, checkpoint,
//            defuser (bot id or null), playerAlive, … READ ONLY for bots.
//   bots   = aimRoundBotList entries (below) or null during init.
// Other ctx keys roundBot can use (all already there, no patch): ctx.tick, ctx.elapsed,
//   ctx.profile (the PLAYER's weapon profile: runSpeed 5.4 with rifles, 6.75 melee; eyeHeightStand,
//   …), ctx.target.eye / ctx.target.canSee(pos) (the
//   player), ctx.enemyRank (rank id string, absent for "Default"), ctx.botMode (1 = Human-like
//   bots), ctx.speedScale (hit slow; absent = 1; il applies it itself), ctx.gameMovement (the
//   "game" movement setting; il then uses the game's acceleration model), ctx.ground(x, z, y, up,
//   down) -> floor y | null (only for ground movers when the scene has collision; never in init).
// ctx.round.bots entry: { id, spawnerId, alive, x, y, z, mode, defusing (0|1), seenTick, nav (0|1),
//   node, goal, arrived (0|1), moving (0|1), pushed (0|1), staged (0|1), cand, air (0|1), atStage (0|1),
//   go (0|1), fetch, planting (0|1) } (the last four: R3 attackers, below)
//   seenTick = the bot's shooter lastSeenTick (the shooter runs before roundBot in the template, so
//   "sees the player this tick" inside roundBotUpdate is actor.behavior.shooter.lastSeenTick ===
//   ctx.tick; in the snapshot a sighting on the previous tick reads seenTick === ctx.tick - 1).
//   mode     = ROUND_BOT_MODE: static 0 (no nav: M1 bot on its setup spot), walk 1, hold 2 (on its
//              setup), wait 3 (barrier phase, setup beyond a defender barrier: stands at the last
//              reachable node in front of it), stuck 4 (gave up after STUCK_MAX re-plans, stands),
//              stage 5 (B3: stands at its retake staging slot / where it stood when it counts as
//              staged in place / at its info-rotation point), cover 6 (B3: stands at its cover spot,
//              or at the spike as the defuse candidate before it starts), defuse 7 (B3: defusing).
//   nav      = 1 when the bot runs on the nav graph (decided once in init), else 0 (fallback).
//   node     = the bot's current nav node (tracked among graph neighbours), -1 without nav.
//   goal     = its setup's nav node (or the substitute, see below), -1 without nav.
//   arrived  = 1 once it reached its setup (stays 1; the fallback bot is there from the start).
//   moving   = the sim's own actor.moving flag (one tick old), used for yielding.
//   air      = 1 while il has the bot in the air (a drop): nobody yields to it.
//   pushed   = 1 once the bot pushes the retake (latched until the next plant; B3).
//   staged   = 1 while it counts as staged for the retake (at / <= 0.5 s from its slot, or staged in
//              place; B3).
//   cand     = the defuse candidate's id as this bot sees it (every bot computes the same), -1 none.
// io.bots entry: { id, spawnerId, alive, x, y, z, defusing (0|1), planting (0|1) } -> round-core's
//   bot defuse (it elects and confirms; the bots decide who walks to the spike) and bot plant (R3:
//   planting = 1 while an alive attacker carrier plants; defusing is 0 then).
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
// walk+drop edges. A setup node that can't be reached (walk:false, not a push spot; none on the shipped maps) is
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
// the goal gets [here, goal] with finish 'stop'. Speed: 6.75 m/s (knife run, = the nav's edgeCost
// basis) during the barrier phase, ctx.profile.runSpeed after the drop (= the player's weapon
// speed, 5.4 with rifles: arrivals ~1.25 x field then; il applies speedScale). On a new target node
// `stuck` is deleted (else il's auto-jump stays off).
// Goals are descriptors {field, stopT}: the bot walks down the field and its goal is reached at the
// first node whose field time is <= stopT (setups: single-node field, stopT 0 = the node itself).
// Spawn: seeded 0-0.6 s stagger (actor.rng) before the first step.
// Hold: on the setup, facing header setups[name].face (sim yaw, atan2(dx, dz)); with face2 it
// switches between the two every seeded 4-8 s. Without a header facing: toward the attacker spawn.
// Barrier phase: combatHold is ignored (bots keep walking and face where they walk).
// After the drop: the bot brakes while actor.combatHold === 1 and it is not airborne (as lN), so the
// shooter (which won't fire while the bot moves: speed, or moveDeg under "game" movement) can
// shoot; it faces the player while it sees them (shooter.lastSeenTick === ctx.tick) or holds
// combat, and walks on once the shooter lets go.
// Once the player is dead (after the plant the round goes on) bots ignore combatHold and sightings:
// the shooter keeps "seeing" the body, which would hold them in place for the rest of the round.
// Facing turns at most 540 deg/s.
// Yield: a walking bot brakes for a MOVING bot with a lower id that is within 0.9 m and ahead
// (60 deg cone, same floor; not in the air, not > 0.6 m below), at most 0.75 s in a row, then
// ignores yields for 1 s (passes through).
// Stuck: if the field value at the bot's node hasn't dropped by 0.2 s in 2 s of free walking, it
// re-finds its node globally (re-plan; in the barrier phase only among nodes reachable from its
// spawn inside the barriers); after 3 re-plans it stands where it is (mode stuck). Every goal
// change after that (the barrier drop, the plant, the push, a new defuse candidate, an info
// rotation) gives it one more try: re-find + walk; 2 s without progress -> stuck again. A straight
// line to its own node that would cross an active barrier is never taken (it stands instead).
// Never arrives or stands while airborne (a goal right under a drop: it would hang in the air).
// Dead: clears its flags; if it died in the air it finishes the fall (il with brake), as lN does
// under "game" movement (here in both modes: lN's default-mode dead bot keeps walking).
//
// ---------------------------------------------------------------- B3: rotation, retake, defuse
// All of it only when cfg.side === 'attack' (the bots defend) and the bot runs on the nav.
// Info rotation (live phase, before the plant): a bot of group 'mid' (cfg.setupBySpawner group)
// latches once per round when the snapshot shows a bot of a site group (a group with retake
// staging points, e.g. 'A'/'B'; never 'mid') that saw the player on the previous tick, itself in the
// live phase (seenTick === ctx.tick - 1 >= liveTick; several the same tick: the lowest id wins). It goes delay seconds after that
// sighting to the nearer (field time) staging point of that site and stands there (mode stage)
// facing the site. delay by ctx.enemyRank: iron/bronze never, silver/gold 6 s, platinum/diamond
// 4 s, ascendant/immortal 3 s, radiant 2 s, anything else (absent = the drill's own bots) 5 s. No
// re-rotation.
// Retake (from the first tick that sees phase 'planted'): spike field = one multi-source field to
// the defuse goal set: nav nodes reachable from the bots' spawn points within xz 1.2 / |dy| < 1.8
// of the spike, else within round-core's own rule (xz cfg.defuseRadius / |dy| < 2; selected within
// radius - 0.05 / 1.9). No such node (Ascent: a few
// stacked-crate tops that need 2+ jumps) -> nobody defuses there (cover set = nodes within xz 4 /
// |dy| < 3; the spike goes off). Plant-time fields live in a small LRU (8).
//   Latch (each bot computes the same from the snapshot, alive nav bots by id): a bot whose spike
//   time is <= the nearest staging point's spike time is staged where it stands; every other bot
//   gets the staging point (header staging / cfg.retake of the spike's site) with the lowest
//   travel + 2 s per bot already there, slot k = stop 1.2 k m (field time k * 1.2 / 6.75) short of
//   it. Cover = the first node on its spike-field chain (from its staging point, or where it
//   stands) 3-5 m from the spike and >= 1.5 m from earlier picks (else the one nearest 5 m among
//   5-8 m out; already closer than 3 m: where it stands; none: it stays at its staging point, or
//   without one where it stood at the plant; with no spike field at all it goes back to its setup). Player dead or no staging data: no staging, it pushes at once.
//   Push (latched, pushed = 1): player dead, OR only one bot alive, OR time left <= travel to the
//   spike (field x 6.75 / speed + 0.3 s) + defuse time left (defuseSec, minus the checkpoint once
//   reached) + 5 s, OR it is staged and (>= 2 alive bots are staged OR some bot has pushed).
//   Defuse candidate = the alive nav bot (not stuck, finite spike time) with the lowest spike time,
//   ties lowest id; latched while it stays eligible, then re-elected. After the push the candidate
//   walks to the spike goal set, the others to their cover spots (facing the spike).
//   Defuse: the candidate starts (actor.roundDefusing = 1, mode defuse) once it stands at the goal
//   (after the il move: xz <= 1.5, |dy| < 1.9 (fallback set: radius - 0.005 / 1.95), stopped, not airborne, combatHold !== 1) and the
//   player is dead or it hasn't seen them for >= 1 s. It then holds the flag every tick without
//   moving (no il) until the round ends, unless it sees the player and the rank isn't iron..gold or Default (absent):
//   then it stops to fight, except past the checkpoint with time left < defuse left + 1.5 s.
//
// ---------------------------------------------------------------- R3: attackers (defense side)
// Only when cfg.side === 'defense' (the player defends) and roundPrepare's plan cfg.attack = { site,
// carrierSpawner, routeBySpawner, lurker, gatherSec } exists (B3 retake / rotation stay off there).
// Data: nav header attack.staging[site] (routes: entry + staging nodes), attack.plant[site] (plant
// spots), attack.postPlant[site][plant name], header setups of group site (walk:true, not clear:false, reachable from
// the attacker spawns) as clear spots. No nav, no plan site or no data for it -> the fallback (static
// at its spawn, faces the player, never plants).
//   Init (no setup): route = cfg.attack.routeBySpawner[spawnerId] (unknown -> the site's first route);
//   route members = kept spawners on that route by id, member k gets slot node k: the staging points
//   first, then the nearest same-floor node (<= 4 m, |dy| <= 0.3) >= 1.2 m from every earlier slot
//   (no room: the staging point with a 1.2 m-per-row field stop). Slot beyond an active attacker
//   barrier -> it waits behind it: one wait node per route (the masked-reachable node with the lowest
//   time to the route's first staging point), slot nodes around it the same way. Clear spot = kept
//   spawners by id with the planned carrier last, i -> clear[i % len]. Every plan-site field (staging,
//   plant, clear, post-plant) is built here.
//   Live: walk to the slot (mode stage there, facing the route entry). atStage = the bot's node is
//   within 0.15 s (field) of its slot. go (latched, the same tick in every bot: snapshot + round state
//   only): any snapshot entry has go, OR every member (alive, nav, not stuck, not the lurker, not the
//   fetcher) is atStage, OR gatherSec after the drop AND >= ceil(members / 2) of them are atStage (no
//   members: gatherSec alone), OR gatherSec + GO_CAP (15 s) after the drop (a fight near staging can't
//   hold the team until the time-short rule), OR round time left < group travel (the carrier's
//   field time to its nearer plant spot, else the max over members; x 6.75 / run speed + 0.3 s) +
//   plantSec + 10 s. After go: the carrier (ctx.round.state.spike.carrier === actor.id; the view hides
//   it) walks to its plant spot (nearer by field, latched while it carries), everyone else (lurker
//   too) to its clear spot (facing the site centre).
//   Plant: the carrier stands on its plant node (xz <= 0.3, stopped, on the ground, in a plant zone)
//   and is not in combat (combatHold !== 1) unless time left < plantSec + 3 s -> planting = 1 and
//   actor.roundDefusing = 1 (hands busy: no fire). It holds both without moving (no il) until the
//   round leaves 'live' or it isn't the carrier any more; io.bots planting = 1, defusing = 0.
//   round-core counts the plant (its zone / alive rules) and plants at its position.
//   Post-plant (from the first tick that sees spike.planted): the plant spot = the plant node nearest
//   the spike; snapshot bots (nav) ordered planter first (planting in the snapshot), then by id; k ->
//   postPlant[k]; the rest (5th) hold their clear spot. They face the spike and fight via B2's brake.
//   Dropped spike (live): fetch set = attacker-reachable nodes within xz 1.0 / |dy| < 1.8 of it (LRU
//   of 8 multi-source fields); fetcher = the alive nav bot (not stuck) with the lowest fetch time,
//   ties lowest id, latched while eligible (published as fetch). The fetcher walks to the set
//   (round-core picks it up within 1.5 m / |dy| < 2; the new carrier then goes to plant if go is set,
//   else to its slot); the others keep their goals. Empty set -> lost (st.lost): everyone holds its
//   clear spot (fight / timeout). B routes: walk + drop edges only, so B Main enters the site from the
//   CT side like Mid Market (the B Main gap hop is not used).
//   GK astage 7 (fk 6e8+), wait (fk 7e8+), plant 8 (8e8+), clear 9 (9e8+), post 10 (10e8+), fetch 11
//   (11e8+); MODE plant 8 (planting), post 9 (holding a post-plant spot); stage / cover as above.
//   Flat state: atk, ri, sk, stopT, waitT, ci, lurk, go, atStage, planting, pi, fetch, lost, ppk, pn.
//   Snapshot (aimRoundBotList) adds atStage, go, fetch (-1 none), planting; all 0 / -1 on the attack
//   side.
// Flat state (nav mode): nav, mode, snap, spawn, goal, setup, wait, cur, tgt, tx, ty, tz, goT,
//   arrived, arriveT, fk, best, bestT, replans, yieldT, yieldCd, face, face2, face2On, faceSel,
//   altT, at (node it stopped on), gk (goal kind), lx, lz (look point), retries, real (on real
//   floors: floor-aware node tracking), B3: pk (plant tick
//   latched), sgi (staging index, -1 in place, -2 none), slotT, ipT, covT, cand, pushed, staged,
//   rotN (rotation node), rotT (tick it goes), rotI (site index), rotTrig (sighting tick)
//   + il's own (index, speed, finished, air, vy, jy, jb, stuck). -1 = none.

import { parseRoundNav, reverseEdges, NAV_WALK, NAV_DROP } from './round-nav.mjs';

export const ROUND_BOT_MODE = { static: 0, walk: 1, hold: 2, wait: 3, stuck: 4, stage: 5, cover: 6, defuse: 7, plant: 8, post: 9 };
const MODE = ROUND_BOT_MODE;
// Goal kinds (st.gk): what the current goal descriptor is. 7.. = R3 attackers (defense side).
const GK = { setup: 0, wait: 1, stage: 2, place: 3, spike: 4, cover: 5, rotate: 6, astage: 7, plant: 8, clear: 9, post: 10, fetch: 11 };
const STOPPED = new Set([MODE.hold, MODE.wait, MODE.stage, MODE.cover, MODE.post]);

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
// B3
const STAGE_SLOT = 1.2, STAGE_NEAR = 0.5, STAGE_COST = 2; // STAGE_NEAR: field s from its slot that counts as staged
const PUSH_MARGIN = 5, ACCEL_MARGIN = 0.3;
const COVER_MIN = 3, COVER_MAX = 5, COVER_WIDE = 8, COVER_SEP = 1.5;
// Defuse goal sets: tight (start within 1.5 / 1.9), else round-core's own rule (r = cfg.defuseRadius,
// default 1.6; |dy| < 2): set within r - 0.05 / 1.9, start within r - 0.005 / 1.95 (il leaves the
// bot <= 0.02 m from its node).
const GOAL_XZ = 1.2, GOAL_DY = 1.8, FULL_SET_M = 0.05, FULL_DY = 1.9, NEAR_XZ = 4, NEAR_DY = 3, CORE_RADIUS = 1.6;
const DEFUSE_XZ = 1.5, DEFUSE_DY = 1.9, DEFUSE_FULL_M = 0.005, DEFUSE_FULL_DY = 1.95, UNSEEN_SEC = 1, FIGHT_MARGIN = 1.5;
const FACE_SPIKE_M = 15;
const PLANT_LRU = 8;
const LOW_RANKS = new Set(['iron', 'bronze', 'silver', 'gold']); // keep defusing while seen
// Default (no ctx.enemyRank; also '' / an unknown id, as for the rotation delay) is a mid/low rank
// here (reaction 0.35-0.5 s): it keeps defusing like iron..gold.
const keepsDefusingSeen = (rank) => typeof rank !== 'string' || !Object.prototype.hasOwnProperty.call(ROT_DELAY, rank) || LOW_RANKS.has(rank);
const ROT_DELAY = { iron: -1, bronze: -1, silver: 6, gold: 6, platinum: 4, diamond: 4, ascendant: 3, immortal: 3, radiant: 2 };
const ROT_DEFAULT = 5;
const ROUND_DEF = { spikeSec: 45, defuseSec: 7, defuseCheckpointSec: 3.5, roundSec: 100, plantSec: 4 }; // = round-core ROUND_DEFAULTS
// R3 attackers
const GO_MARGIN = 10, GO_CAP = 15, GATHER_DEF = 20, AT_STAGE = 0.15, PLANT_AT = 0.3, PLANT_PRESS = 3;
const FETCH_XZ = 1.0, FETCH_DY = 1.8, FETCH_LRU = 8;
// The game mover's step-up (il / JU: a walking bot climbs at most 0.45 m; the nav was baked with
// 0.5): attackers path only over walk edges that rise <= STEP_MAX, and a straight line may not cross
// a floor step of more than RISER (up or down) between two 0.1 m samples (an oblique crossing of a
// ramp's side, or a line along a step's seam; ramps rise ~0.21 per 0.5 m cell and pass). The bot
// then takes the next nav edge. (The drops through the floor this was first blamed on are the
// sub-millimetre gaps between floor and ramp triangles, fixed by groundCtx below.)
const STEP_MAX = 0.45, RISER = 0.25;
// Ground gaps (R4e): some maps (Split) leave 0.3-0.8 mm strips between a flat floor's triangles and a
// ramp's. ctx.ground casts one vertical ray, which misses inside such a strip; il's mover (JU) then
// finds the surface far below (Split: y 2.42 under the map) and drops the bot through. groundCtx
// gives il a ctx whose ground is unchanged when the ray hits; on a miss it probes GAP_EPS to both
// sides along x and along z (fixed order) and, only when BOTH probes of one axis hit (a hole
// narrower than 2 * GAP_EPS, not a ledge edge or an overhang's rim), returns the highest probe hit.
// st.gfix counts the rescues. A run with no rescue is bit-identical to plain ctx.ground. (Not
// covered: the < 1 mm^2 corner where two strips meet at right angles; the safety net below is the
// backstop there. The wrapper is built per bot update: a small object + closure.)
const GAP_EPS = 0.002;
// Safety net (R4e): a real-floor bot, not airborne, with no nav node of its floor within LOW_XZ
// (|dy| <= LOW_DY; the sweeps' off-floor rule) but nav floor above it, for LOW_TICKS ticks in a
// row, is under the floor: it stands (no il) meanwhile, then is put back on its last on-floor node
// st.okN (st.lowN counts it); without one it gives up (stuck).
const LOW_XZ = 0.75, LOW_DY = 0.5, LOW_TICKS = 16;
// Edge e (from -> to) usable: drop edges always; walk edges unless strict and rising > STEP_MAX.
const stepOk = (g, e, from, to, strict) => !strict || g.edgeType[e] !== NAV_WALK || g.y[to] - g.y[from] <= STEP_MAX;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (finite(v) ? v : d);
const tickSecOf = (ctx) => (ctx.tick > 0 && finite(ctx.elapsed) && ctx.elapsed > 0 ? ctx.elapsed / ctx.tick : 1 / 128);
const ticksOf = (sec, ts) => Math.max(1, Math.round(sec / ts)); // round-core's T()
// ctx for il with the gap-safe ground (GAP_EPS above); ctx itself when there is no ground.
function groundCtx(ctx, st) {
  const ground = ctx.ground;
  if (typeof ground !== 'function') return ctx;
  const g2 = (x, z, y, up, down) => {
    const h = ground(x, z, y, up, down);
    if (h !== null && h !== undefined) return h;
    const xp = ground(x + GAP_EPS, z, y, up, down), xm = ground(x - GAP_EPS, z, y, up, down);
    const zp = ground(x, z + GAP_EPS, y, up, down), zm = ground(x, z - GAP_EPS, y, up, down);
    const hit = (v) => v !== null && v !== undefined;
    if (!(hit(xp) && hit(xm)) && !(hit(zp) && hit(zm))) return h;
    let best = null;
    for (const v of [xp, xm, zp, zm]) if (hit(v) && (best === null || v > best)) best = v;
    st.gfix = (st.gfix | 0) + 1;
    return best;
  };
  return Object.create(ctx, { ground: { value: g2 } });
}
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
  return { g, rev: reverseEdges(g), header: h, cell, ox, oz, i0, j0, W, H, head, next, masks: new Map(), fields: new Map(), reach: new Map(), plant: new Map(), fetch: new Map(), perCfg: new WeakMap() };
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
// Cached per cfg object (the scene's rules.round never changes during a run), with its cache key.
let BARS = new WeakMap(), BAR_KEYS = new WeakMap();
function barriersOf(cfg) {
  if (cfg && typeof cfg === 'object' && BARS.has(cfg)) return BARS.get(cfg);
  const team = cfg?.side === 'defense' ? 'attack' : 'defense';
  const bars = (cfg?.barriers ?? []).filter((b) => b && b.team === team && b.a && b.b && finite(b.a.x) && finite(b.a.z) && finite(b.b.x) && finite(b.b.z));
  if (cfg && typeof cfg === 'object') BARS.set(cfg, bars);
  return bars;
}
function barKey(bars) {
  let k = BAR_KEYS.get(bars);
  if (k === undefined) { k = bars.map((b) => `${b.a.x},${b.a.z},${b.b.x},${b.b.z},${Array.isArray(b.y) ? b.y.join('/') : '*'}`).join(';'); BAR_KEYS.set(bars, k); }
  return k;
}
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
// strict (R3 attackers): only walk edges the mover can climb (stepOk).
function fieldFor(N, goal, mask, strict = 0) {
  const key = `${goal}|${maskId(mask)}${strict ? '|s' : ''}`;
  let f = N.fields.get(key);
  if (f) return f;
  f = dijkstra(N, [goal], mask, strict);
  f.goal = goal;
  N.fields.set(key, f);
  return f;
}
// Multi-source field (every node of `src` at 0; goal -1): the spike's defuse goal set.
function fieldMulti(N, src, strict = 0) {
  const f = dijkstra(N, src, null, strict);
  f.goal = -1;
  return f;
}
function dijkstra(N, src, mask, strict = 0) {
  const g = N.g, R = N.rev, n = g.count;
  const dist = new Float64Array(n).fill(Infinity), via = new Int32Array(n).fill(-1), viaE = new Int32Array(n).fill(-1), done = new Uint8Array(n), h = new Heap();
  for (const s of src) { dist[s] = 0; h.push(0, s); }
  while (h.size) {
    const i = h.pop();
    if (done[i]) continue;
    done[i] = 1;
    const di = dist[i];
    for (let p = R.revStart[i]; p < R.revStart[i + 1]; p++) {
      const e = R.revEdge[p];
      if (!(WD >> g.edgeType[e] & 1) || (mask && mask[e])) continue;
      const j = R.revFrom[p], nd = di + g.edgeCost[e];
      if (strict && !stepOk(g, e, j, i, 1)) continue;
      if (nd < dist[j]) { dist[j] = nd; via[j] = i; viaE[j] = e; h.push(nd, j); }
    }
  }
  return { goal: -1, dist, via, viaE };
}
// Nodes reachable FROM src over walk+drop edges not cut by mask (1 = reached).
function reachFor(N, src, mask, strict = 0) {
  const key = `${src}|${maskId(mask)}${strict ? '|s' : ''}`;
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
      if (strict && !stepOk(g, e, i, j, 1)) continue;
      if (!r[j]) { r[j] = 1; q.push(j); }
    }
  }
  N.reach.set(key, r);
  return r;
}

// ---------------------------------------------------------------- B3 data (pure caches)
// Per scene cfg (rules.round never changes during a run) on this nav.
function perCfg(N, cfg) {
  let c = N.perCfg.get(cfg);
  if (!c) { c = {}; N.perCfg.set(cfg, c); }
  return c;
}
// Retake staging nodes per site id: nav header staging[site][j].node, else the nearest node to
// cfg.retake[site][j] (ascent.json retake).
function stagingFor(N, cfg) {
  const c = perCfg(N, cfg);
  if (c.staging) return c.staging;
  const g = N.g, hs = N.header.staging && typeof N.header.staging === 'object' ? N.header.staging : {}, cr = cfg.retake && typeof cfg.retake === 'object' ? cfg.retake : {};
  const out = {};
  for (const id of new Set([...Object.keys(hs), ...Object.keys(cr)])) {
    const list = [];
    const src = Array.isArray(hs[id]) && hs[id].length ? hs[id] : Array.isArray(cr[id]) ? cr[id] : [];
    for (const e of src) {
      let k = e && Number.isInteger(e.node) && e.node >= 0 && e.node < g.count ? e.node : -1;
      if (k < 0 && e && finite(e.x) && finite(e.z)) k = nearestNode(N, e.x, e.z, 1, finite(e.y) ? e.y : null, 1.5);
      if (k >= 0 && !list.includes(k)) list.push(k);
    }
    out[id] = list;
  }
  return (c.staging = out);
}
// Nodes reachable (walk+drop) from the bots' team spawn points (union), or null without any. On the
// defense side (R3 attackers) over climbable edges only (strict).
function reachUnion(N, cfg) {
  const c = perCfg(N, cfg);
  if (c.reach !== undefined) return c.reach;
  let u = null;
  const pts = cfg.spawns?.[cfg.side === 'defense' ? 'attack' : 'defense'] ?? [];
  c.reachKey = (Array.isArray(pts) ? pts : []).map((p) => `${p?.x},${p?.y},${p?.z}`).join(';');
  for (const p of pts) {
    if (!p || !finite(p.x) || !finite(p.z)) continue;
    let k = nearestNode(N, p.x, p.z, 1.5, finite(p.y) ? p.y : null, 1.5);
    if (k < 0) k = nearestNode(N, p.x, p.z, 1.5);
    if (k < 0) continue;
    const r = reachFor(N, k, null, cfg.side === 'defense' ? 1 : 0);
    if (!u) u = new Uint8Array(N.g.count);
    for (let i = 0; i < r.length; i++) if (r[i]) u[i] = 1;
  }
  return (c.reach = u);
}
// The planted spike's goal data: kind 'defuse' (set = reachable nodes within xz 1.2 / |dy| < 1.8,
// else xz 1.6 / |dy| < 2), 'near' (no defuse node: cover set xz 4 / |dy| < 3) or 'none'; field =
// multi-source field to the set (null for 'none'). LRU of PLANT_LRU entries (pure: an evicted
// entry is rebuilt the same).
function spikeData(N, cfg, sp) {
  const R = reachUnion(N, cfg), radius = num(cfg.defuseRadius, CORE_RADIUS);
  const key = `${perCfg(N, cfg).reachKey}|${radius}|${sp.x},${sp.y},${sp.z}`, L = N.plant; // every input of the result
  let d = L.get(key);
  if (d) { L.delete(key); L.set(key, d); return d; }
  const g = N.g;
  const around = (r, dy) => nodesNear(N, sp.x, sp.z, r).filter((k) => (!R || R[k] === 1) && Math.abs(g.y[k] - sp.y) < dy);
  let set = around(Math.min(GOAL_XZ, radius - FULL_SET_M), GOAL_DY), kind = 'defuse', full = 0;
  if (!set.length) { set = around(radius - FULL_SET_M, FULL_DY); full = 1; }
  if (!set.length) { set = around(NEAR_XZ, NEAR_DY); kind = set.length ? 'near' : 'none'; }
  d = { key, kind, full, reach: full ? radius - DEFUSE_FULL_M : Math.min(DEFUSE_XZ, radius - DEFUSE_FULL_M), reachDy: full ? DEFUSE_FULL_DY : DEFUSE_DY, set, field: set.length ? fieldMulti(N, set) : null };
  L.set(key, d);
  while (L.size > PLANT_LRU) L.delete(L.keys().next().value);
  return d;
}

// ---------------------------------------------------------------- R3 attacker data (pure caches)
// The plan's site on this nav (per scene cfg): routes [{name, entry, staging: [nodes]}] (header
// attack.staging[site]), plant [{name, node}] (header attack.plant[site]), post [[nodes] per plant
// spot] (header attack.postPlant[site][plant name]), clear [nodes] (header setups of group site,
// walk:true, not clear:false, reachable from the attacker spawns, header key order), center {x, z} (the site's
// centre, else its first plant spot). null without a plan site, routes or plant spots.
function atkData(N, cfg) {
  const c = perCfg(N, cfg);
  if (c.atk !== undefined) return c.atk;
  const g = N.g, ha = N.header.attack, site = typeof cfg.attack?.site === 'string' ? cfg.attack.site : null;
  const ok = (k) => Number.isInteger(k) && k >= 0 && k < g.count;
  let out = null;
  if (site && ha && typeof ha === 'object') {
    const R = reachUnion(N, cfg), reached = (k) => ok(k) && (!R || R[k] === 1);
    const routes = (Array.isArray(ha.staging?.[site]) ? ha.staging[site] : [])
      .map((r) => ({ name: r?.route, entry: ok(r?.entry?.node) ? r.entry.node : -1, staging: (Array.isArray(r?.staging) ? r.staging : []).map((s) => s?.node).filter(reached) }))
      .filter((r) => typeof r.name === 'string' && r.staging.length);
    const plant = (Array.isArray(ha.plant?.[site]) ? ha.plant[site] : []).filter((p) => p && typeof p.name === 'string' && reached(p.node)).map((p) => ({ name: p.name, node: p.node }));
    const post = plant.map((p) => (Array.isArray(ha.postPlant?.[site]?.[p.name]) ? ha.postPlant[site][p.name] : []).map((e) => e?.node).filter(reached));
    const hs = N.header.setups && typeof N.header.setups === 'object' ? N.header.setups : {};
    const clear = Object.keys(hs).filter((n) => hs[n]?.group === site && hs[n].walk === true && hs[n].clear !== false && reached(hs[n].node)).map((n) => hs[n].node);
    const sc = (cfg.sites ?? []).find((s) => s && s.id === site)?.center;
    if (routes.length && plant.length) out = { site, routes, plant, post, clear, center: sc && finite(sc.x) && finite(sc.z) ? { x: sc.x, z: sc.z } : { x: g.x[plant[0].node], z: g.z[plant[0].node] } };
  }
  return (c.atk = out);
}
// A dropped spike's fetch data: set = attacker-reachable nodes within xz 1.0 / |dy| < 1.8 of it
// (round-core's pickup is 1.5 / 2), field = multi-source field to the set, null when the set is
// empty (the spike is lost: no bot can pick it up). LRU of FETCH_LRU entries (pure).
function fetchData(N, cfg, sp) {
  const R = reachUnion(N, cfg), key = `${perCfg(N, cfg).reachKey}|${sp.x},${sp.y},${sp.z}`, L = N.fetch;
  let d = L.get(key);
  if (d) { L.delete(key); L.set(key, d); return d; }
  const g = N.g, set = nodesNear(N, sp.x, sp.z, FETCH_XZ).filter((k) => (!R || R[k] === 1) && Math.abs(g.y[k] - sp.y) < FETCH_DY);
  d = { key, set, field: set.length ? fieldMulti(N, set, 1) : null };
  L.set(key, d);
  while (L.size > FETCH_LRU) L.delete(L.keys().next().value);
  return d;
}
// Nodes reachable without crossing an active barrier from any of the bots' team spawn points
// (union), or null without barriers / spawns.
function maskedReachUnion(N, cfg, mask) {
  const c = perCfg(N, cfg);
  if (c.mreach !== undefined) return c.mreach;
  let u = null;
  if (mask) for (const p of cfg.spawns?.[cfg.side === 'defense' ? 'attack' : 'defense'] ?? []) {
    if (!p || !finite(p.x) || !finite(p.z)) continue;
    let k = nearestNode(N, p.x, p.z, 1.5, finite(p.y) ? p.y : null, 1.5);
    if (k < 0) k = nearestNode(N, p.x, p.z, 1.5);
    if (k < 0) continue;
    const r = reachFor(N, k, mask, 1);
    if (!u) u = new Uint8Array(N.g.count);
    for (let i = 0; i < r.length; i++) if (r[i]) u[i] = 1;
  }
  return (c.mreach = u);
}
// Slot nodes for `count` bots around base nodes: slot i < bases.length = bases[i]; then, in order,
// the nearest node (xz <= SLOT_R, |dy| <= SLOT_DY of its base bases[i % len], in `ok`) at least
// STAGE_SLOT m (xz) from every earlier slot; -1 when there is no room (the caller falls back).
const SLOT_R = 4, SLOT_DY = 0.3;
function slotNodes(N, bases, count, ok) {
  const g = N.g, out = [];
  const far = (k) => out.every((q) => q < 0 || Math.hypot(g.x[q] - g.x[k], g.z[q] - g.z[k]) >= STAGE_SLOT);
  for (let i = 0; i < count; i++) {
    if (i < bases.length) { out.push(bases[i]); continue; }
    const b = bases[i % bases.length];
    out.push(nodesNear(N, g.x[b], g.z[b], SLOT_R, g.y[b], SLOT_DY).find((k) => (!ok || ok[k] === 1) && far(k)) ?? -1);
  }
  return out;
}
// round-core's roundZoneAt (plant zones): polygon xz + the site's y range.
function zoneAt(cfg, x, y, z) {
  for (const s of cfg?.sites ?? []) {
    if (!s || !Array.isArray(s.zone)) continue;
    let inside = false;
    for (let i = 0, j = s.zone.length - 1; i < s.zone.length; j = i++) {
      const [xi, zi] = s.zone[i], [xj, zj] = s.zone[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside && (!s.y || (y >= s.y[0] && y <= s.y[1]))) return s.id;
  }
  return null;
}

// ---------------------------------------------------------------- node tracking + target
const dxz = (g, i, x, z) => Math.hypot(g.x[i] - x, g.z[i] - z);

// The bot's node, re-picked among its graph neighbours (outgoing walk/drop up to 2 hops, incoming
// walk 1 hop, edges allowed by mask), nearest in xz; ties keep the earlier candidate (cur first).
// With y given (the bot is known to walk on the nav's real floors, st.real) and the bot within
// 0.8 m of cur's floor, only nodes of its own floor (|dy| < 0.8) count, so the landing node of a
// drop next to a ledge is not taken before the bot has actually dropped (it would steer the bot
// off the ledge). y null (flat test ground: bot y unrelated to the nav's): xz only.
function trackNode(N, cur, x, z, mask, y = null) {
  const g = N.g, R = N.rev, floor = y !== null && Math.abs(g.y[cur] - y) < 0.8;
  let best = cur, bd = dxz(g, cur, x, z);
  const take = (j) => { if (floor && Math.abs(g.y[j] - y) >= 0.8) return; const d = dxz(g, j, x, z); if (d < bd) { bd = d; best = j; } };
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
// Global re-find (lost / re-plan): nearest node within r, on the bot's floor when the bot stands
// on the nav's floors (real collision), xz only otherwise (flat test ground); only nodes in `ok`
// (barrier phase: masked-reachable from the bot's spawn, so it never lands beyond a barrier).
function refindNode(N, x, y, z, r, hint, ok) {
  const onNav = hint >= 0 && Math.abs(N.g.y[hint] - y) < 0.8;
  const pick = (l) => l.find((k) => !ok || ok[k] === 1) ?? -1;
  const k = onNav ? pick(nodesNear(N, x, z, r, y, 1)) : -1;
  return k >= 0 ? k : pick(nodesNear(N, x, z, r));
}

// Straight xz line from (x0, z0) to node k: every 0.5 m cell on it has a node of the same floor
// (floor height interpolated from y0 to y[k]).
// riser > 0 (R3 attackers): also the floor under the line (per sample: the cell's node nearest the
// interpolated height) may not change by more than riser between two samples.
function lineOnFloor(N, x0, z0, y0, k, riser = 0) {
  const g = N.g, x1 = g.x[k], z1 = g.z[k], y1 = g.y[k], len = Math.hypot(x1 - x0, z1 - z0), steps = Math.max(1, Math.ceil(len / LINE_STEP));
  let prev = NaN;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, want = y0 + (y1 - y0) * t;
    if (!riser) { if (!cellHasFloor(N, x, z, want, LINE_DY)) return false; continue; }
    let f = NaN, fd = Infinity;
    for (let c = cellHead(N, x, z); c >= 0; c = N.next[c]) { const d = Math.abs(g.y[c] - want); if (d <= LINE_DY && d < fd) { fd = d; f = g.y[c]; } }
    if (!finite(f) || (finite(prev) && Math.abs(f - prev) > riser)) return false;
    prev = f;
  }
  return true;
}

// The node to steer to this tick, plus the node after it (-1 when the target is the goal: the first
// node down the field whose time is <= stopT, or a node with no way on).
function pickTarget(N, F, cur, x, z, bars, stopT = 0, riser = 0) {
  const g = N.g, end = (n) => F.viaE[n] < 0 || F.dist[n] <= stopT;
  if (end(cur)) return [cur, -1];
  const y0 = g.y[cur], chain = [cur], cum = [0];
  let best = -1;
  for (let k = 1, n = cur; k <= LOOK_AHEAD && !end(n); k++) {
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
    if (ok && !lineOnFloor(N, x, z, y0, m, riser)) ok = false;
    if (!ok) { if (k === 1 && !cut) best = m; break; }
    best = m; n = m;
  }
  if (best < 0) {
    if (bars.length > 0 && lineCut(bars, x, z, y0, g.x[cur], g.z[cur], y0)) return [-1, -1]; // stand
    best = cur;
  }
  return [best, end(best) ? -1 : F.via[best]];
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
  // B3 data that doesn't depend on the plant: staging fields, the team's reachable set (all here,
  // not at the plant, so the plant tick only builds the spike field).
  for (const list of Object.values(stagingFor(N, cfg))) for (const k of list) fieldFor(N, k, null);
  reachUnion(N, cfg);
  Object.assign(st, {
    nav: 1, mode: MODE.walk, spawn, setup, goal, wait, cur: spawn, tgt: -1, tx: p.x, ty: p.y, tz: p.z,
    goT: ctx.elapsed + actor.rng.range(0, STAGGER_SEC), arrived: 0, arriveT: -1, fk: -1, best: FAR, bestT: ctx.elapsed,
    replans: 0, yieldT: 0, yieldCd: -1, face, face2, face2On: hs && finite(hs.face2) ? 1 : 0, faceSel: 0, altT: -1,
    at: -1, gk: GK.setup, lx: FAR, lz: FAR, retries: 0, real: 0, gfix: 0, okN: -1, lowT: 0, lowN: 0,
    pk: -1, sgi: -2, slotT: 0, ipT: -1, covT: -1, cand: -1, pushed: 0, staged: 0, rotN: -1, rotT: -1, rotI: -1, rotTrig: -1,
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

// R3 attacker init (defense side; the bot has no setup): goal = its staging slot on its plan route,
// wait node + slot when the slot is beyond an active attacker barrier, all plan-site fields here.
// Returns false for the fallback (static at its spawn, never plants).
function atkInit(actor, ctx, st) {
  const cfg = ctx.round.cfg, N = navFor(cfg.map);
  if (!N) return false;
  const A = atkData(N, cfg);
  if (!A) return false;
  const g = N.g, p = actor.position;
  let spawn = nearestNode(N, p.x, p.z, 1.5, p.y, 1.5);
  if (spawn < 0) spawn = nearestNode(N, p.x, p.z, 1.5);
  if (spawn < 0) return false;
  // Route + slot from the plan only (ctx.round.bots is null in init): route members = kept
  // spawners on the same route, by spawnerId; slot k -> staging[k % len], k / len rows of 1.2 m.
  const rbs = cfg.attack.routeBySpawner && typeof cfg.attack.routeBySpawner === 'object' ? cfg.attack.routeBySpawner : {};
  const routeOf = (id) => Math.max(0, A.routes.findIndex((r) => r.name === rbs[id]));
  // roundPrepare keys every kept spawner; a bot missing from the plan joins the list itself (two
  // such bots could share a slot; can't happen with roundPrepare's plan).
  const ids = Object.keys(rbs).includes(actor.spawnerId) ? Object.keys(rbs).sort() : [...Object.keys(rbs), actor.spawnerId].sort();
  const ri = routeOf(actor.spawnerId), mine = ids.filter((id) => routeOf(id) === ri), k = mine.indexOf(actor.spawnerId);
  const stg = A.routes[ri].staging, slots = slotNodes(N, stg, mine.length, reachUnion(N, cfg));
  // No room for a slot node: the staging point, stopping 1.2 m per row short of it (field time).
  const goal = slots[k] >= 0 ? slots[k] : stg[k % stg.length], stopT = slots[k] >= 0 ? 0 : (Math.floor(k / stg.length) * STAGE_SLOT) / RUN_SPEED;
  const reach = reachFor(N, spawn, null, 1);
  if (!reach[goal] || !finite(fieldFor(N, goal, null, 1).dist[spawn])) return false;
  const mask = maskFor(N, barriersOf(cfg));
  // Slot beyond an active barrier: wait behind it. One wait node per route (the barrier-side node
  // with the lowest time to the route's first staging point), slot nodes around it. Routes can share
  // a wait node (Split: A Main and A Ramps both wait at atk-a-main), so the slots are counted over
  // every bot whose route has this wait node (by spawnerId), not over the route's members only.
  let wait = -1, waitT = 0;
  if (mask && !finite(fieldFor(N, goal, mask, 1).dist[spawn])) {
    const rm = maskedReachUnion(N, cfg, mask);
    const waitOf = (r) => {
      const Fu = fieldFor(N, A.routes[r].staging[0], null, 1);
      let w = -1, bt = Infinity;
      if (rm) for (let i = 0; i < g.count; i++) if (rm[i] && Fu.dist[i] < bt) { bt = Fu.dist[i]; w = i; }
      return w;
    };
    const w0 = waitOf(ri), wr = new Map([[ri, w0]]);
    const grp = ids.filter((id) => { const r = routeOf(id); if (!wr.has(r)) wr.set(r, waitOf(r)); return wr.get(r) === w0; });
    const kw = w0 >= 0 ? grp.indexOf(actor.spawnerId) : k; // no wait node: per route, as before
    const ws = w0 >= 0 ? slotNodes(N, [w0], grp.length, rm)[kw] : -1;
    if (ws >= 0 && finite(fieldFor(N, ws, mask, 1).dist[spawn])) wait = ws;
    else {
      // Fallback (no route wait node reachable from here): this bot's own best node, a field-time row.
      const own = reachFor(N, spawn, mask, 1), Fg = fieldFor(N, goal, null, 1);
      let bt = Infinity;
      for (let i = 0; i < g.count; i++) if (own[i] && Fg.dist[i] < bt) { bt = Fg.dist[i]; wait = i; }
      if (wait < 0) return false;
      waitT = (kw * STAGE_SLOT) / RUN_SPEED;
    }
    fieldFor(N, wait, mask, 1);
  }
  // Clear spot: kept spawners by id with the planned carrier last; index -> clear[i % len].
  const cs = cfg.attack.carrierSpawner, order = ids.filter((id) => id !== cs).concat(ids.includes(cs) ? [cs] : []);
  const ci = A.clear.length ? A.clear[order.indexOf(actor.spawnerId) % A.clear.length] : -1;
  // Every plan-site field now (not at the go / plant tick): staging, plant spots, clear, post-plant.
  for (const r of A.routes) for (const n of r.staging) fieldFor(N, n, null, 1);
  for (const pl of A.plant) fieldFor(N, pl.node, null, 1);
  for (const n of A.clear) fieldFor(N, n, null, 1);
  for (const l of A.post) for (const n of l) fieldFor(N, n, null, 1);
  const entry = A.routes[ri].entry, lx = entry >= 0 ? g.x[entry] : A.center.x, lz = entry >= 0 ? g.z[entry] : A.center.z;
  const face = Math.atan2(lx - g.x[goal], lz - g.z[goal]);
  Object.assign(st, {
    nav: 1, mode: MODE.walk, spawn, setup: goal, goal, wait, cur: spawn, tgt: -1, tx: p.x, ty: p.y, tz: p.z,
    goT: ctx.elapsed + actor.rng.range(0, STAGGER_SEC), arrived: 0, arriveT: -1, fk: -1, best: FAR, bestT: ctx.elapsed,
    replans: 0, yieldT: 0, yieldCd: -1, face, face2: face, face2On: 0, faceSel: 0, altT: -1,
    at: -1, gk: GK.astage, lx, lz, retries: 0, real: 0, gfix: 0, okN: -1, lowT: 0, lowN: 0,
    pk: -1, sgi: -2, slotT: 0, ipT: -1, covT: -1, cand: -1, pushed: 0, staged: 0, rotN: -1, rotT: -1, rotI: -1, rotTrig: -1,
    atk: 1, ri, sk: k, stopT, waitT, ci,
    lurk: cfg.attack.lurker === actor.spawnerId ? 1 : 0, go: 0, atStage: 0, planting: 0, pi: -1, fetch: -1, lost: 0, ppk: -1, pn: -1,
    index: 0, speed: 0, finished: false,
  });
  const F0 = wait >= 0 ? fieldFor(N, wait, mask, 1) : fieldFor(N, goal, holdFire(ctx) ? mask : null, 1);
  let n = spawn;
  for (let i = 0; i < 6 && F0.via[n] >= 0; i++) n = F0.via[n];
  const y0 = yawTo(actor, g.x[n], g.z[n]);
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
  if (!s && ctx.round?.cfg?.side === 'defense' && ctx.round.cfg.attack && typeof ctx.round.cfg.attack === 'object' && atkInit(actor, ctx, st)) return;
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
    if (!o || o.id === actor.id || !o.alive || o.moving !== 1 || !(o.id < actor.id) || o.air === 1 || o.y < p.y - 0.6) continue; // not to a bot falling / below
    const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
    if (d > YIELD_DIST || d < 1e-6 || Math.abs(o.y - p.y) > 1.5) continue;
    if ((dx * ux + dz * uz) / d > YIELD_COS) return true;
  }
  return false;
}

function arrive(actor, ctx, st, kind, node) {
  st.mode = kind === GK.setup ? MODE.hold : kind === GK.wait ? MODE.wait
    : kind === GK.spike || kind === GK.cover || kind === GK.plant || kind === GK.clear || kind === GK.fetch ? MODE.cover
      : kind === GK.post ? MODE.post : MODE.stage;
  st.at = node;
  st.speed = 0;
  if (st.mode === MODE.hold && st.arrived !== 1) {
    st.arrived = 1; st.arriveT = ctx.elapsed;
    if (st.face2On === 1) st.altT = ctx.elapsed + actor.rng.range(ALT_MIN, ALT_MAX);
  }
}

// ---------------------------------------------------------------- B3: plan (rotation, retake, candidate, push)
const runSpeed = (ctx, barrier) => (barrier ? RUN_SPEED : finite(ctx.profile?.runSpeed) ? ctx.profile.runSpeed : RUN_SPEED);
const lastSeen = (actor) => (finite(actor.behavior?.shooter?.lastSeenTick) ? actor.behavior.shooter.lastSeenTick : -1e9);
const spikeLeft = (ctx, cfg, rs) => num(cfg.spikeSec, ROUND_DEF.spikeSec) - (ctx.tick - rs.plantTick) * tickSecOf(ctx);

// The snapshot as every bot sees it: alive bots by id (the own entry from its state when the
// snapshot is missing, e.g. a unit test without a list).
function snapshotOf(ctx, actor, st) {
  const raw = Array.isArray(ctx.round?.bots) ? ctx.round.bots : [];
  const list = raw.filter((o) => o && o.alive === true).sort((a, b) => a.id - b.id);
  if (!list.some((o) => o.id === actor.id)) {
    list.push({ id: actor.id, spawnerId: actor.spawnerId, alive: true, nav: 1, node: st.cur, mode: st.mode, staged: st.staged, pushed: st.pushed, cand: st.cand, atStage: st.atStage === 1 ? 1 : 0, go: st.go === 1 ? 1 : 0, fetch: Number.isInteger(st.fetch) ? st.fetch : -1, planting: st.planting === 1 ? 1 : 0 });
    list.sort((a, b) => a.id - b.id);
  }
  return list;
}

// Defuse candidate: keep `prev` while it is eligible, else the eligible bot with the lowest spike
// time (ties: lowest id). Eligible = alive, on the nav, not stuck, finite spike time.
function electCand(list, F, prev, count) {
  if (!F) return -1;
  const ok = (o) => o.nav === 1 && o.mode !== MODE.stuck && Number.isInteger(o.node) && o.node >= 0 && o.node < count && finite(F.dist[o.node]);
  const p = list.find((o) => o.id === prev);
  if (p && ok(p)) return prev;
  let best = null;
  for (const o of list) if (ok(o) && (best === null || F.dist[o.node] < F.dist[best.node])) best = o; // list is by id: ties keep the lower
  return best ? best.id : -1;
}

// The plant-time latch: staging point + slot, staged-in-place, cover stop (one greedy pass over
// the snapshot, the same in every bot).
function latchRetake(N, actor, st, sd, stg, sp, list, rs) {
  Object.assign(st, { pk: rs.plantTick, pushed: 0, staged: 0, sgi: -2, slotT: 0, ipT: -1, covT: -1, cand: -1 });
  const g = N.g, F = sd.field, stF = stg.map((k) => fieldFor(N, k, null));
  let stT = Infinity;
  if (F) for (const k of stg) stT = Math.min(stT, F.dist[k]);
  const used = stg.map(() => 0), picks = [];
  for (const o of list) {
    if (o.nav !== 1 || !Number.isInteger(o.node) || o.node < 0 || o.node >= g.count) continue;
    let sgi = -2, slotT = 0, ipT = -1, start = o.node;
    const ts = F ? F.dist[o.node] : Infinity;
    if (rs.playerAlive !== false && stg.length) {
      if (finite(ts) && ts <= stT) { sgi = -1; ipT = ts; }
      else {
        let bc = Infinity;
        stF.forEach((f, j) => { const c = f.dist[o.node] + STAGE_COST * used[j]; if (c < bc) { bc = c; sgi = j; } });
        if (sgi >= 0) { slotT = (STAGE_SLOT * used[sgi]) / RUN_SPEED; used[sgi] += 1; start = stg[sgi]; } else sgi = -2;
      }
    }
    let covT = -1;
    if (F && finite(F.dist[start])) {
      // On its chain: the first node 3-5 m out that is >= 1.5 m from earlier picks; else the one
      // nearest 5 m among 5-8 m out; already closer than 3 m: where it stands.
      const free = (n) => picks.every((q) => Math.hypot(g.x[q] - g.x[n], g.z[q] - g.z[n]) >= COVER_SEP);
      let pick = -1, wide = -1, wd = Infinity;
      for (let n = start, i = 0; i < g.count; i++) {
        const d = Math.hypot(g.x[n] - sp.x, g.z[n] - sp.z);
        if (d >= COVER_MIN && d <= COVER_MAX && free(n)) { pick = n; break; }
        if (d > COVER_MAX && d <= COVER_WIDE && d < wd && free(n)) { wide = n; wd = d; }
        if (F.viaE[n] < 0) break;
        n = F.via[n];
      }
      if (pick < 0) pick = wide;
      if (pick < 0 && Math.hypot(g.x[start] - sp.x, g.z[start] - sp.z) < COVER_MIN) pick = start;
      if (pick >= 0) { covT = F.dist[pick]; picks.push(pick); }
    }
    if (o.id === actor.id) Object.assign(st, { sgi, slotT, ipT: finite(ts) ? ts : ipT, covT });
  }
  if (st.sgi === -2) st.pushed = 1;
  if (st.sgi === -1) st.staged = 1;
}

// Retake bookkeeping for this tick (attack side, spike planted). Returns {sd, sp, goal} or null.
function retakePlan(N, actor, ctx, st, cfg, rs) {
  const sp = rs.spike?.planted;
  if (cfg.side !== 'attack' || !sp || !finite(sp.x) || !finite(sp.y) || !finite(sp.z) || !Number.isInteger(rs.plantTick) || rs.plantTick < 0) return null;
  const sd = spikeData(N, cfg, sp), F = sd.field;
  const stg = stagingFor(N, cfg)[sp.site] ?? [];
  const list = snapshotOf(ctx, actor, st);
  if (st.pk !== rs.plantTick) latchRetake(N, actor, st, sd, stg, sp, list, rs);
  st.cand = sd.kind === 'defuse' ? electCand(list, F, st.cand, N.g.count) : -1;
  if (st.pushed !== 1) {
    if (st.sgi === -1) st.staged = 1;
    else if (st.sgi >= 0) st.staged = fieldFor(N, stg[st.sgi], null).dist[st.cur] - st.slotT <= STAGE_NEAR ? 1 : 0;
    let alive = 0, staged = 0, anyPushed = false;
    for (const o of list) { alive++; if (o.staged === 1) staged++; if (o.pushed === 1) anyPushed = true; }
    const travel = F && finite(F.dist[st.cur]) ? (F.dist[st.cur] * RUN_SPEED) / runSpeed(ctx, false) + ACCEL_MARGIN : 0;
    const defuse = num(cfg.defuseSec, ROUND_DEF.defuseSec) - (rs.checkpoint === true ? num(cfg.defuseCheckpointSec, ROUND_DEF.defuseCheckpointSec) : 0);
    if (rs.playerAlive === false || alive <= 1 || spikeLeft(ctx, cfg, rs) <= travel + defuse + PUSH_MARGIN || (st.staged === 1 && (staged >= 2 || anyPushed))) st.pushed = 1;
  }
  const stageGoal = () => {
    if (st.sgi >= 0) return { F: fieldFor(N, stg[st.sgi], null), stopT: st.slotT, kind: GK.stage, fk: 1e8 + st.sgi };
    if (st.sgi === -1 && F) return { F, stopT: st.ipT, kind: GK.place, fk: 2e8 };
    return null;
  };
  // No staging point and no cover (player dead, no staging data, crowded approach): stand where it
  // was at the plant if that is on the spike field; else (kind 'none') back to its setup goal.
  const placeGoal = () => (F && st.ipT >= 0 ? { F, stopT: st.ipT, kind: GK.place, fk: 2e8 } : null);
  let goal;
  if (st.pushed !== 1) goal = stageGoal();
  else if (F && sd.kind === 'defuse' && st.cand === actor.id) goal = { F, stopT: 0, kind: GK.spike, fk: 3e8 };
  else if (F && st.covT >= 0) goal = { F, stopT: st.covT, kind: GK.cover, fk: 4e8 };
  else goal = stageGoal() ?? placeGoal();
  return { sd, sp, goal };
}

// Info rotation latch (live phase, before the plant; mid bots only; once per round).
function rotationLatch(N, actor, ctx, st, cfg, rs) {
  if (cfg.side !== 'attack' || rs.phase !== 'live' || st.rotN >= 0 || rs.spike?.planted) return;
  const own = cfg.setupBySpawner?.[actor.spawnerId];
  if (!own || own.group !== 'mid') return;
  const rank = typeof ctx.enemyRank === 'string' ? ctx.enemyRank : '';
  const delay = Object.prototype.hasOwnProperty.call(ROT_DELAY, rank) ? ROT_DELAY[rank] : ROT_DEFAULT;
  if (delay < 0 || !Array.isArray(ctx.round?.bots) || !(ctx.tick - 1 >= rs.liveTick)) return; // a sighting in the live phase only
  const stages = stagingFor(N, cfg);
  let trig = null;
  for (const o of ctx.round.bots) {
    if (!o || o.alive !== true || o.seenTick !== ctx.tick - 1 || o.id === actor.id) continue;
    const grp = cfg.setupBySpawner?.[o.spawnerId]?.group;
    if (typeof grp !== 'string' || grp === 'mid' || !stages[grp]?.length) continue;
    if (trig === null || o.id < trig.id) trig = { id: o.id, site: grp };
  }
  if (!trig) return;
  let bj = -1, bt = Infinity;
  stages[trig.site].forEach((k, j) => { const t = fieldFor(N, k, null).dist[st.cur]; if (t < bt) { bt = t; bj = j; } });
  if (bj < 0) return; // can't get there
  const sighting = ctx.tick - 1;
  Object.assign(st, { rotN: stages[trig.site][bj], rotT: sighting + Math.round(delay / tickSecOf(ctx)), rotI: (cfg.sites ?? []).findIndex((s) => s && s.id === trig.site), rotTrig: sighting });
}

// ---------------------------------------------------------------- R3: attackers (defense side)
// This tick's goal (+ look point st.lx/lz, flags atStage / fetch / lost / go / post-plant latch),
// from the snapshot, the round state and the bot's own flat state only.
function attackTick(N, actor, ctx, st, cfg, rs, barrier, mask) {
  const A = atkData(N, cfg), g = N.g, ts = tickSecOf(ctx), list = snapshotOf(ctx, actor, st);
  const sp = rs.spike ?? {}, carrier = Number.isInteger(sp.carrier) ? sp.carrier : null, mine = carrier === actor.id, live = rs.phase === 'live';
  const stageF = fieldFor(N, st.goal, null, 1);
  st.atStage = st.air !== 1 && stageF.dist[st.cur] - st.stopT <= AT_STAGE ? 1 : 0;
  if (!mine) st.pi = -1;
  // Dropped spike (live): the fetcher keeps the job while eligible, else the lowest fetch time.
  const dr = live && sp.dropped && finite(sp.dropped.x) && finite(sp.dropped.y) && finite(sp.dropped.z) ? sp.dropped : null;
  const fd = dr ? fetchData(N, cfg, dr) : null;
  st.fetch = fd && fd.field ? electCand(list, fd.field, st.fetch, g.count) : -1;
  st.lost = fd && !fd.field ? 1 : 0;
  // Go (latched, the same tick in every bot).
  if (st.go !== 1 && live) {
    const lurker = typeof cfg.attack?.lurker === 'string' ? cfg.attack.lurker : null, plantF = A.plant.map((pl) => fieldFor(N, pl.node, null, 1));
    const tOf = (o) => (Number.isInteger(o.node) && o.node >= 0 && o.node < g.count ? Math.min(...plantF.map((f) => f.dist[o.node])) : Infinity);
    const c = carrier !== null ? list.find((o) => o.id === carrier) ?? null : null;
    let anyGo = false, all = true, members = 0, staged = 0, travel = c ? tOf(c) : -Infinity;
    for (const o of list) {
      if (o.go === 1) anyGo = true;
      if (o.nav !== 1 || o.mode === MODE.stuck || o.spawnerId === lurker || o.id === st.fetch) continue;
      members++;
      if (o.atStage === 1) staged++; else all = false;
      if (!c) { const t = tOf(o); if (finite(t)) travel = Math.max(travel, t); }
    }
    const sec = finite(travel) ? (travel * RUN_SPEED) / runSpeed(ctx, false) + ACCEL_MARGIN : 0;
    const liveT = (ctx.tick - rs.liveTick) * ts, left = num(cfg.roundSec, ROUND_DEF.roundSec) - liveT;
    const gather = num(cfg.attack?.gatherSec, GATHER_DEF), half = liveT >= gather && staged >= Math.ceil(members / 2);
    if (anyGo || all || half || liveT >= gather + GO_CAP || left < sec + num(cfg.plantSec, ROUND_DEF.plantSec) + GO_MARGIN) st.go = 1;
  }
  // Post-plant latch (first tick that sees the plant): the planter first, then by id -> the plant
  // spot's post-plant spots in order; the rest hold their clear spot.
  const planted = sp.planted && finite(sp.planted.x) && finite(sp.planted.y) && finite(sp.planted.z) && Number.isInteger(rs.plantTick) && rs.plantTick >= 0 ? sp.planted : null;
  if (planted && st.ppk !== rs.plantTick) {
    let pi = 0, bd = Infinity;
    A.plant.forEach((pl, j) => { const d = Math.hypot(g.x[pl.node] - planted.x, g.z[pl.node] - planted.z) + Math.abs(g.y[pl.node] - planted.y); if (d < bd) { bd = d; pi = j; } });
    const order = list.filter((o) => o.nav === 1).sort((a, b) => (b.planting === 1 ? 1 : 0) - (a.planting === 1 ? 1 : 0) || a.id - b.id);
    const k = order.findIndex((o) => o.id === actor.id), spots = A.post[pi] ?? [];
    st.ppk = rs.plantTick; st.pn = k >= 0 && k < spots.length ? spots[k] : -1;
  }
  const stageGoal = () => {
    if (barrier && mask) {
      const Fm = fieldFor(N, st.goal, mask, 1);
      if (!finite(Fm.dist[st.cur]) && st.wait >= 0) return { F: fieldFor(N, st.wait, mask, 1), stopT: st.waitT, kind: GK.wait, fk: 7e8 + st.wait };
      return { F: Fm, stopT: st.stopT, kind: GK.astage, fk: 6e8 + st.goal * 2 + 1 };
    }
    return { F: stageF, stopT: st.stopT, kind: GK.astage, fk: 6e8 + st.goal * 2 };
  };
  // No clear spots on the site (never on Ascent: A 7, B 4 site-area spots): null -> the bot's staging slot.
  const clearGoal = () => (st.ci >= 0 ? { F: fieldFor(N, st.ci, null, 1), stopT: 0, kind: GK.clear, fk: 9e8 + st.ci } : null);
  const plantGoal = () => {
    if (st.pi < 0) { let bt = Infinity; A.plant.forEach((pl, j) => { const t = fieldFor(N, pl.node, null, 1).dist[st.cur]; if (t < bt) { bt = t; st.pi = j; } }); }
    if (st.pi < 0) return null;
    const n = A.plant[st.pi].node;
    return { F: fieldFor(N, n, null, 1), stopT: 0, kind: GK.plant, fk: 8e8 + n };
  };
  const ent = A.routes[st.ri]?.entry ?? -1;
  let goal = null, lx = ent >= 0 ? g.x[ent] : A.center.x, lz = ent >= 0 ? g.z[ent] : A.center.z;
  if (planted) {
    goal = st.pn >= 0 ? { F: fieldFor(N, st.pn, null, 1), stopT: 0, kind: GK.post, fk: 10e8 + st.pn } : clearGoal();
  } else if (!barrier && fd) {
    // fk per drop position (a new drop re-arms a stuck fetcher even when its set starts the same).
    if (fd.field && st.fetch === actor.id) goal = { F: fd.field, stopT: 0, kind: GK.fetch, fk: 11e8 + ((fd.set[0] * 977 + Math.round(dr.x * 10) * 131 + Math.round(dr.z * 10) * 17 + Math.round(dr.y * 10)) & 0x3ffffff) };
    else if (!fd.field || st.go === 1) goal = clearGoal(); // spike lost: everyone to the clear spots
  } else if (!barrier && st.go === 1) goal = mine ? plantGoal() : clearGoal();
  if (planted) { lx = planted.x; lz = planted.z; } else if (goal && goal.kind !== GK.fetch) { lx = A.center.x; lz = A.center.z; }
  st.lx = lx; st.lz = lz;
  return { goal: goal ?? stageGoal() };
}

// Start planting (after the il move): the carrier at its latched plant node (xz <= 0.3), stopped,
// on the ground, in a plant zone, live, and not in combat (unless time left < plantSec + 3 s).
function tryPlant(N, actor, ctx, st, cfg, rs, G) {
  if (G.kind !== GK.plant || st.mode !== MODE.cover || rs.phase !== 'live' || rs.spike?.carrier !== actor.id || st.planting === 1 || st.pi < 0) return;
  if ((st.speed ?? 0) > 0.05 || st.air === 1) return;
  const A = atkData(N, cfg), p = actor.position, n = A?.plant[st.pi]?.node;
  if (!Number.isInteger(n) || dxz(N.g, n, p.x, p.z) > PLANT_AT || zoneAt(cfg, p.x, p.y, p.z) === null) return;
  const left = num(cfg.roundSec, ROUND_DEF.roundSec) - (ctx.tick - rs.liveTick) * tickSecOf(ctx);
  if (actor.combatHold === 1 && left >= num(cfg.plantSec, ROUND_DEF.plantSec) + PLANT_PRESS) return;
  st.planting = 1; actor.roundDefusing = 1; st.mode = MODE.plant;
}

// The goal descriptor for this tick: retake, else info rotation, else setup / wait (B2).
function goalFor(N, ctx, st, rs, barrier, mask, plan) {
  if (plan?.goal) return plan.goal;
  if (!barrier && st.rotN >= 0 && rs.phase === 'live' && ctx.tick >= st.rotT) return { F: fieldFor(N, st.rotN, null), stopT: 0, kind: GK.rotate, fk: 5e8 + st.rotN };
  let F = fieldFor(N, st.goal, mask), kind = GK.setup;
  if (barrier && !finite(F.dist[st.cur]) && st.wait >= 0) { F = fieldFor(N, st.wait, mask); kind = GK.wait; }
  return { F, stopT: 0, kind, fk: F.goal * 2 + (barrier ? 1 : 0) };
}

const inReach = (p, plan) => Math.hypot(p.x - plan.sp.x, p.z - plan.sp.z) <= plan.sd.reach && Math.abs(p.y - plan.sp.y) < plan.sd.reachDy;

// Start defusing (after the il move): candidate at the spike goal, stopped, on the ground, not in
// combat, and the player dead or unseen for >= 1 s.
function tryDefuse(actor, ctx, st, rs, plan, G) {
  if (!plan || G.kind !== GK.spike || st.mode !== MODE.cover || rs.phase !== 'planted' || actor.roundDefusing === 1) return;
  if ((st.speed ?? 0) > 0.05 || st.air === 1 || (actor.combatHold === 1 && rs.playerAlive !== false) || !inReach(actor.position, plan)) return;
  if (rs.playerAlive !== false && ctx.tick - lastSeen(actor) < ticksOf(UNSEEN_SEC, tickSecOf(ctx))) return;
  actor.roundDefusing = 1;
  st.mode = MODE.defuse;
}
// Keep defusing this tick? (Seen by the player: iron..gold and Default keep on; higher ranks stop to fight
// unless past the checkpoint with too little time to restart.)
function keepDefusing(actor, ctx, st, cfg, rs, plan) {
  if (!plan || rs.phase !== 'planted' || st.cand !== actor.id || !inReach(actor.position, plan)) return false;
  if (rs.playerAlive === false || actor.behavior?.shooter?.lastSeenTick !== ctx.tick) return true;
  if (keepsDefusingSeen(ctx.enemyRank)) return true;
  const ts = tickSecOf(ctx), left = (ticksOf(num(cfg.defuseSec, ROUND_DEF.defuseSec), ts) - (rs.defuse ?? 0)) * ts;
  return rs.checkpoint === true && spikeLeft(ctx, cfg, rs) < left + FIGHT_MARGIN;
}

function navUpdate(actor, ctx, dt, il, st) {
  const cfg = ctx.round?.cfg, N = cfg ? navFor(cfg.map) : null;
  if (!N) { st.speed = 0; return; } // the nav went away mid-run (never in the app): stand
  const g = N.g, p = actor.position, rs = ctx.round.state ?? {}, barrier = rs.phase === 'barrier';
  const bars = barrier ? barriersOf(cfg) : [], mask = barrier ? maskFor(N, bars) : null;
  const okNodes = mask ? reachFor(N, st.spawn, mask, st.atk === 1 ? 1 : 0) : null;
  // No fighting in the barrier phase, nor once the player is dead (after the plant the round goes
  // on, and the shooter keeps "seeing" the body: combatHold / lastSeenTick stay set).
  const calm = barrier || rs.playerAlive === false;

  // B3 bookkeeping (from the snapshot and the round state).
  const plan = retakePlan(N, actor, ctx, st, cfg, rs);
  if (!plan) rotationLatch(N, actor, ctx, st, cfg, rs);
  if (plan) { st.lx = plan.sp.x; st.lz = plan.sp.z; }
  else if (st.rotN >= 0 && st.rotI >= 0 && finite(cfg.sites?.[st.rotI]?.center?.x)) { st.lx = cfg.sites[st.rotI].center.x; st.lz = cfg.sites[st.rotI].center.z; }
  // R3 attackers (defense side): their own plan (B3 is attack side only: plan / rotation stay off).
  const ap = st.atk === 1 && cfg.side === 'defense' ? attackTick(N, actor, ctx, st, cfg, rs, barrier, mask) : null;
  const gp = plan ?? ap;

  // Planting: stand still (no il) while the carrier keeps the spike and the round is live.
  if (st.planting === 1) {
    if (ap && rs.phase === 'live' && rs.spike?.carrier === actor.id) {
      st.speed = 0; st.mode = MODE.plant; actor.roundDefusing = 1;
      turnTo(actor, yawTo(actor, st.lx, st.lz), dt);
      return;
    }
    st.planting = 0; actor.roundDefusing = 0;
    if (st.mode === MODE.plant) st.mode = MODE.walk;
  }

  // Defusing: stand still (no il) while it goes on.
  if (actor.roundDefusing === 1) {
    if (keepDefusing(actor, ctx, st, cfg, rs, plan)) { st.speed = 0; st.mode = MODE.defuse; turnTo(actor, yawTo(actor, plan.sp.x, plan.sp.z), dt); return; }
    actor.roundDefusing = 0;
    if (st.mode === MODE.defuse) st.mode = MODE.cover;
  }

  // Stuck: stands, until the goal changes (drop, plant, push, candidate, rotation): one more try.
  if (st.mode === MODE.stuck) {
    if (goalFor(N, ctx, st, rs, barrier, mask, gp).fk === st.fk) { st.speed = 0; faceIdle(actor, ctx, st, dt, calm); return; }
    st.mode = MODE.walk; st.replans = STUCK_MAX - 1; st.retries += 1;
    const k = refindNode(N, p.x, p.y, p.z, 2.5, st.cur, okNodes);
    if (k >= 0) st.cur = k;
  }

  // Node tracking (neighbours only; global re-find when lost). st.real latches once the bot stands
  // exactly on a nav floor that is clearly not y 0 (real collision; never on flat test ground).
  if (st.real !== 1 && st.air !== 1 && Math.abs(g.y[st.cur]) > 1 && Math.abs(p.y - g.y[st.cur]) < 0.05) st.real = 1;
  st.cur = trackNode(N, st.cur, p.x, p.z, mask, st.real === 1 ? p.y : null);
  if (dxz(g, st.cur, p.x, p.z) > 1) { const k = refindNode(N, p.x, p.y, p.z, 2.5, st.cur, okNodes); if (k >= 0) st.cur = k; }
  const gctx = groundCtx(ctx, st);

  // Safety net (LOW_* above): under the nav floor -> stand, then back onto the last on-floor node.
  if (st.real === 1 && gctx !== ctx && st.air !== 1) {
    if (Math.abs(p.y - g.y[st.cur]) < LOW_DY && dxz(g, st.cur, p.x, p.z) <= 1) { st.okN = st.cur; st.lowT = 0; }
    else if (nodesNear(N, p.x, p.z, LOW_XZ, p.y, LOW_DY).length === 0 && nodesNear(N, p.x, p.z, LOW_XZ).some((k) => g.y[k] > p.y + LOW_DY)) {
      st.lowT = (st.lowT | 0) + 1; st.speed = 0;
      if (st.lowT >= LOW_TICKS) {
        st.lowT = 0;
        const k = Number.isInteger(st.okN) ? st.okN : -1;
        if (k >= 0) {
          const y = gctx.ground(g.x[k], g.z[k], g.y[k], 0.5, 0.5);
          actor.position = { x: g.x[k], y: finite(y) ? y : g.y[k], z: g.z[k] };
          delete st.air; delete st.vy; delete st.jy; delete st.jb; delete st.stuck;
          st.cur = k; st.tgt = -1; st.best = FAR; st.bestT = ctx.elapsed; st.lowN = (st.lowN | 0) + 1;
        } else st.mode = MODE.stuck;
      }
      faceIdle(actor, ctx, st, dt, calm);
      return;
    } else st.lowT = 0;
  }

  // Goal descriptor {field, stopT}: barrier phase -> masked to the setup, or to the wait node when
  // the setup is beyond a barrier; after the drop -> unmasked to the setup; B3 goals override.
  const G = goalFor(N, ctx, st, rs, barrier, mask, gp), F = G.F, stopT = G.stopT;
  const act = () => (ap ? tryPlant(N, actor, ctx, st, cfg, rs, G) : tryDefuse(actor, ctx, st, rs, plan, G));
  st.gk = G.kind;
  if (G.fk !== st.fk) {
    st.fk = G.fk; st.best = FAR; st.bestT = ctx.elapsed;
    if (STOPPED.has(st.mode)) {
      if (st.at >= 0 && F.dist[st.at] <= stopT && dxz(g, st.at, p.x, p.z) <= 0.1) arrive(actor, ctx, st, G.kind, st.at);
      else st.mode = MODE.walk;
    }
  }
  if (!finite(F.dist[st.cur])) { st.speed = 0; faceIdle(actor, ctx, st, dt, calm); return; } // cut off (never on Ascent)

  if (STOPPED.has(st.mode)) {
    if (st.air !== 1 && dxz(g, st.at >= 0 ? st.at : st.cur, p.x, p.z) <= HOLD_LEAVE) { act(); faceIdle(actor, ctx, st, dt, calm); return; }
    st.mode = MODE.walk; st.best = FAR; st.bestT = ctx.elapsed;
  }

  // Walk.
  if (ctx.elapsed < st.goT) { st.bestT = ctx.elapsed; faceIdle(actor, ctx, st, dt, calm); return; } // spawn stagger
  const [t, t2] = pickTarget(N, F, st.cur, p.x, p.z, bars, stopT, st.atk === 1 ? RISER : 0);
  if (t < 0) { st.speed = 0; st.bestT = ctx.elapsed; faceIdle(actor, ctx, st, dt, calm); return; } // never across a barrier
  if (t !== st.tgt) { delete st.stuck; st.tgt = t; }
  st.tx = g.x[t]; st.ty = g.y[t]; st.tz = g.z[t];
  if (t2 < 0 && st.air !== 1 && dxz(g, t, p.x, p.z) <= 0.02 && (st.speed ?? 0) <= 0.05) { arrive(actor, ctx, st, G.kind, t); act(); faceIdle(actor, ctx, st, dt, calm); return; }
  const combat = !calm && actor.combatHold === 1 && st.air !== 1;
  let yieldNow = false;
  if (!combat && shouldYield(actor, ctx, st)) {
    st.yieldT += dt;
    if (st.yieldT > YIELD_MAX) { st.yieldT = 0; st.yieldCd = ctx.elapsed + YIELD_COOLDOWN; } else yieldNow = true;
  } else st.yieldT = 0;
  const brake = combat || yieldNow;
  const way = [{ x: p.x, y: p.y, z: p.z }, { x: st.tx, y: st.ty, z: st.tz }];
  if (t2 >= 0) way.push({ x: g.x[t2], y: g.y[t2], z: g.z[t2] });
  st.finished = false; st.index = 1;
  if (typeof il === 'function') il(st, { waypoints: way, loop: false, speed: runSpeed(ctx, barrier), finish: t2 >= 0 ? 'run' : 'stop', ...(brake ? { brake: true } : {}) }, actor, gctx, dt);
  if (t2 < 0 && st.finished === true && st.air !== 1) arrive(actor, ctx, st, G.kind, t);

  // Stuck: no progress down the field in STUCK_SEC of free walking -> re-plan, then give up.
  const fv = F.dist[st.cur];
  if (brake || st.air === 1) st.bestT = ctx.elapsed;
  else if (fv < st.best - STUCK_GAIN) { st.best = fv; st.bestT = ctx.elapsed; }
  else if (st.mode === MODE.walk && ctx.elapsed - st.bestT > STUCK_SEC) {
    st.replans += 1;
    const k = refindNode(N, p.x, p.y, p.z, 2.5, st.cur, okNodes);
    if (k >= 0) st.cur = k;
    st.best = F.dist[st.cur]; st.bestT = ctx.elapsed;
    if (st.replans >= STUCK_MAX) { st.mode = MODE.stuck; st.speed = 0; }
  }

  // Defuse / plant start (after the move), then facing.
  act();
  if (!calm && (actor.combatHold === 1 || actor.behavior.shooter?.lastSeenTick === ctx.tick)) facePlayerCapped(actor, ctx, dt);
  else if (st.mode === MODE.walk) {
    const spike = plan && st.pushed === 1 && Math.hypot(plan.sp.x - p.x, plan.sp.z - p.z) <= FACE_SPIKE_M;
    turnTo(actor, spike ? yawTo(actor, plan.sp.x, plan.sp.z) : yawTo(actor, st.tx, st.tz), dt);
  } else faceIdle(actor, ctx, st, dt, calm);
}

function facePlayerCapped(actor, ctx, dt) {
  const e = ctx?.target?.eye;
  if (e) turnTo(actor, yawTo(actor, e.x, e.z), dt);
}

// Facing while not walking (calm = barrier phase or player dead: no combat facing): the player in
// combat, else the setup's angle (hold:
// face / face2 by turns; wait: toward the setup; stage / cover / defuse: the look point = the
// spike, or the site of an info rotation; stagger: down the route).
function faceIdle(actor, ctx, st, dt, calm) {
  if (!calm && (actor.combatHold === 1 || actor.behavior.shooter?.lastSeenTick === ctx.tick)) { facePlayerCapped(actor, ctx, dt); return; }
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
    return;
  }
  if ((st.mode === MODE.stage || st.mode === MODE.cover || st.mode === MODE.defuse || st.mode === MODE.post || st.mode === MODE.plant) && st.lx < FAR / 2) turnTo(actor, yawTo(actor, st.lx, st.lz), dt);
  // walk during the stagger: keep the initial facing (down the route).
}

export function roundBotUpdate(cfg, actor, ctx, dt, il) {
  const st = actor.behavior?.roundBot;
  if (!st) return;
  if (!actor.alive) {
    actor.roundDefusing = 0; actor.roundHoldFire = 0;
    if (st.planting === 1) st.planting = 0;
    // Died in the air: finish the fall with brake (lN's dead-mid-air handling) so it doesn't hang.
    if (st.nav === 1) {
      st.speed = 0;
      if (st.air === 1 && typeof il === 'function') {
        st.finished = false; st.index = 1;
        const p = actor.position;
        il(st, { waypoints: [{ x: p.x, y: p.y, z: p.z }, { x: st.tx, y: st.ty, z: st.tz }], loop: false, speed: 0, brake: true }, actor, groundCtx(ctx, st), dt);
      }
    }
    return;
  }
  actor.roundHoldFire = holdFire(ctx);
  if (actor.roundHoldFire === 1 && actor.behavior.shooter) actor.behavior.shooter.peeked = false;
  if (st.nav === 1) { navUpdate(actor, ctx, dt, il, st); return; }
  if (st.snap === 1 && typeof ctx.ground === 'function') {
    const p = actor.position;
    const g = groundCtx(ctx, st).ground(p.x, p.z, p.y, 2.5, 4); // the spawn snap's reach (BiMsX6Xn db: up 2.5, down 4)
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
      pushed: s.pushed === 1 ? 1 : 0, staged: s.staged === 1 ? 1 : 0, cand: Number.isInteger(s.cand) ? s.cand : -1, air: s.air === 1 ? 1 : 0,
      atStage: s.atStage === 1 ? 1 : 0, go: s.go === 1 ? 1 : 0, fetch: Number.isInteger(s.fetch) ? s.fetch : -1, planting: s.planting === 1 ? 1 : 0,
    });
  }
  return out;
}

export function aimRoundIoBots(actors) {
  const out = [];
  for (const a of actors) {
    const s = a.behavior?.roundBot;
    if (!s) continue;
    out.push({ id: a.id, spawnerId: a.spawnerId ?? null, alive: a.alive === true, x: a.position.x, y: a.position.y, z: a.position.z, defusing: a.roundDefusing === 1 && s.planting !== 1 ? 1 : 0, planting: a.alive === true && s.planting === 1 ? 1 : 0 });
  }
  return out;
}

// Test-only access to the module caches and helpers (pure; nothing here runs at import time).
export const roundBotsInternals = {
  resetCaches() { NAVS = new WeakMap(); MASK_IDS = new WeakMap(); BARS = new WeakMap(); BAR_KEYS = new WeakMap(); },
  navFor, maskFor, fieldFor, fieldMulti, reachFor, barriersOf, nearestNode, nodesNear, cellHasFloor, lineCut, pickTarget, trackNode,
  groundCtx, GAP_EPS, LOW_TICKS,
  stagingFor, reachUnion, spikeData, electCand, keepsDefusingSeen, plantCacheSize: (N) => N.plant.size,
  atkData, fetchData, zoneAt, fetchCacheSize: (N) => N.fetch.size,
  MODE, GK, RUN_SPEED, TURN_RATE, YIELD_DIST, YIELD_MAX, STAGGER_SEC, STUCK_MAX, ROT_DELAY, ROT_DEFAULT, PLANT_LRU,
  DEFUSE_XZ, DEFUSE_DY, COVER_MIN, COVER_MAX, COVER_SEP, STAGE_NEAR,
  STAGE_SLOT, AT_STAGE, PLANT_AT, PLANT_PRESS, GO_MARGIN, FETCH_XZ, FETCH_DY, FETCH_LRU,
};
