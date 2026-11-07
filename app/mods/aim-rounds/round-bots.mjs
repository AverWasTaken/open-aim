// Round mode bots: the `roundBot` behaviour (defenders walk to their setups, hold, retake, defuse).
// Pure module: imports nothing from the game bundles and does NOTHING at import time (no fetch, no
// parsing). BiMsX6Xn.js imports it statically on every page (lobby, Studio), and CnrSARj_.js imports
// the two list builders (tools/round_bots_patch.py).
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
//   bots), ctx.speedScale (hit slow; absent = 1), ctx.ground(x, z, y, up, down) -> floor y | null
//   (only for ground movers when the scene has collision; never during init).
// ctx.round.bots entry: { id, spawnerId, alive, x, y, z, mode, defusing (0|1), seenTick }
//   seenTick = the bot's shooter lastSeenTick (the shooter runs before roundBot in the template, so
//   "sees the player this tick" inside roundBotUpdate is actor.behavior.shooter.lastSeenTick ===
//   ctx.tick). B2/B3 add their own published fields here (no bundle re-patch needed).
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
// Behaviour state actor.behavior.roundBot: FLAT numbers only (the sim's save copies behaviour state
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
// v0 (B1): only the fallback: init puts the bot on its setup spot, every tick it faces the player
// and is snapped to the floor once; roundHoldFire during the barrier. B2 adds movement.

export const ROUND_BOT_MODE = { static: 0 };

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

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

export function roundBotInit(cfg, actor, ctx) {
  const st = { mode: ROUND_BOT_MODE.static, snap: 0 };
  actor.behavior.roundBot = st;
  actor.roundDefusing = 0;
  actor.roundHoldFire = holdFire(ctx);
  const s = setupOf(ctx, actor);
  if (s) {
    actor.position = { x: s.x, y: s.y, z: s.z };
    st.snap = 1; // the setup's y is approximate: snap to the floor on the first update (ctx.ground)
  }
  facePlayer(actor, ctx);
}

export function roundBotUpdate(cfg, actor, ctx, dt, il) {
  const st = actor.behavior?.roundBot;
  if (!st) return;
  if (!actor.alive) { actor.roundDefusing = 0; actor.roundHoldFire = 0; return; }
  actor.roundHoldFire = holdFire(ctx);
  if (actor.roundHoldFire === 1 && actor.behavior.shooter) actor.behavior.shooter.peeked = false;
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
