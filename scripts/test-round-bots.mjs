// Round mode bots (app/mods/aim-rounds/round-bots.mjs, the `roundBot` behaviour hooked in by
// tools/round_bots_patch.py). v0 = the contract plus the nav-missing fallback (M1 static bots):
// pure checks in node, then the real patched sim (scripts/sim-loader.mjs) on flat ground.
// The sim part needs the game files in site/ and is skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(root, 'app', 'mods');
const bots = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-bots.mjs')).href);
const core = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-core.mjs')).href);
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js'));
let sim = null;
if (HAVE_SITE) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);
}
const skip = !HAVE_SITE && 'no game files in site/';
const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };

// ---------------------------------------------------------------- pure contract
const actor = (over = {}) => ({ id: 7, spawnerId: 'sp', alive: true, position: { x: 10, y: 0, z: 0 }, offset: { x: 0, y: 0, z: 0 }, behavior: {}, ...over });
const ctxOf = (phase, extra = {}) => ({
  tick: 5, round: { cfg: { setupBySpawner: { sp: { name: 'S', group: 'A', x: 3, y: 1.5, z: -4 } } }, state: { phase }, bots: null },
  target: { eye: { x: 3, y: 1.6, z: 6 }, canSee: () => true }, ...extra,
});

test('round-bots.mjs: exports the contract and does nothing at import time', () => {
  for (const f of ['roundBotInit', 'roundBotUpdate', 'aimRoundBotList', 'aimRoundIoBots']) assert.equal(typeof bots[f], 'function', f);
  const src = fs.readFileSync(path.join(MODS, 'aim-rounds', 'round-bots.mjs'), 'utf-8').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bimport\b[^;]*from\s+['"][^'"]*next\/js/.test(src), 'imports nothing from the bundles');
  assert.ok(!/fetch\(|Math\.random/.test(src), 'no fetch, no Math.random');
  assert.ok(!('__aimRoundNav' in globalThis), 'no nav lookup at import');
});

test('fallback init: on its setup spot, facing the player, hold fire during the barrier, flat state', () => {
  const a = actor();
  bots.roundBotInit({ kind: 'roundBot' }, a, ctxOf('barrier'));
  assert.deepEqual(a.position, { x: 3, y: 1.5, z: -4 });
  assert.equal(a.facingYaw, Math.atan2(0, 10)); // player straight ahead along +z (sim convention atan2(dx, dz))
  assert.equal(a.roundHoldFire, 1);
  assert.equal(a.roundDefusing, 0);
  for (const [k, v] of Object.entries(a.behavior.roundBot)) assert.equal(typeof v, 'number', `behaviour state ${k} is flat`);
  for (const k of ['index', 'speed', 'finished', 'air', 'vy', 'jy', 'jb', 'stuck']) assert.ok(!(k in a.behavior.roundBot), `${k} is reserved for il`);
  // No setup entry (not a round scene, or an unknown spawner): stays put, still faces the player.
  const b = actor({ spawnerId: 'other' });
  bots.roundBotInit({}, b, ctxOf('live'));
  assert.deepEqual(b.position, { x: 10, y: 0, z: 0 });
  assert.equal(b.roundHoldFire, 0);
  assert.ok(Math.abs(b.facingYaw - Math.atan2(-7, 6)) < 1e-12);
  // Outside a round scene (no ctx.round) init still works.
  const c = actor();
  bots.roundBotInit({}, c, { tick: 0, target: { eye: { x: 10, y: 1.6, z: 5 } } });
  assert.deepEqual(c.position, { x: 10, y: 0, z: 0 });
  assert.equal(c.roundHoldFire, 0);
});

test('fallback update: snaps to the floor once, keeps facing the player, hold fire follows the phase, dead clears flags', () => {
  const a = actor();
  bots.roundBotInit({}, a, ctxOf('barrier'));
  let calls = 0;
  const ground = (x, z, y, up, down) => { calls++; assert.deepEqual([x, z, y, up, down], [3, -4, 1.5, 2.5, 4]); return 1.25; };
  bots.roundBotUpdate({}, a, ctxOf('barrier', { ground }), 1 / TPS, () => assert.fail('v0 never moves'));
  assert.equal(a.position.y, 1.25);
  bots.roundBotUpdate({}, a, ctxOf('live', { ground, target: { eye: { x: 13, y: 1.6, z: -4 } } }), 1 / TPS, null);
  assert.equal(calls, 1, 'snapped once');
  assert.equal(a.roundHoldFire, 0);
  assert.equal(a.facingYaw, Math.atan2(10, 0));
  a.roundDefusing = 1;
  a.alive = false;
  bots.roundBotUpdate({}, a, ctxOf('barrier'), 1 / TPS, null);
  assert.equal(a.roundDefusing, 0);
  assert.equal(a.roundHoldFire, 0);
  // Without a ground function (no collision) nothing is snapped.
  const b = actor();
  bots.roundBotInit({}, b, ctxOf('live'));
  bots.roundBotUpdate({}, b, ctxOf('live'), 1 / TPS, null);
  assert.equal(b.position.y, 1.5);
});

test('aimRoundBotList / aimRoundIoBots: only round bots, flat entries', () => {
  const a = actor({ id: 1 }), b = actor({ id: 2, alive: false }), plain = actor({ id: 3 });
  bots.roundBotInit({}, a, ctxOf('live'));
  bots.roundBotInit({}, b, ctxOf('live'));
  a.roundDefusing = 1;
  a.behavior.shooter = { lastSeenTick: 4 };
  const list = bots.aimRoundBotList([a, plain, b]);
  assert.deepEqual(list.map((e) => e.id), [1, 2]);
  assert.deepEqual(list[0], { id: 1, spawnerId: 'sp', alive: true, x: 3, y: 1.5, z: -4, mode: 0, defusing: 1, seenTick: 4 });
  assert.equal(list[1].alive, false);
  assert.equal(list[1].seenTick, -1);
  assert.deepEqual(bots.aimRoundIoBots([plain, a, b]), [{ id: 1, alive: true, x: 3, y: 1.5, z: -4, defusing: 1 }, { id: 2, alive: false, x: 3, y: 1.5, z: -4, defusing: 0 }]);
});

// ---------------------------------------------------------------- real sim, flat ground
// Like scripts/test-round-sim.mjs flatDoc, with the round scene's bot setup: template
// [shooter, roundBot, respawn never], faceTarget off, spawners on their setup spots that
// roundPrepare moves onto 5 defender spawn points 30 m further out (botStart 'spawn').
function botDoc({ dist = 15, barrierSec = 2, spawnDelay = [0.1, 0.2], roundBot = true } = {}) {
  const spawners = [1, 2, 3, 4, 5].map((i) => ({ id: `d${i}`, kind: 'fixed', actorTemplateId: 'bot', position: { x: dist, y: 0, z: (i - 3) * 3 }, size: { x: 0, y: 0, z: 0 }, maxAlive: 1, spawnDelay, faceTarget: !roundBot, groundSnap: true }));
  const round = {
    map: 'test', side: 'attack', barrierSec, roundSec: 100, plantSec: 4, spikeSec: 45, defuseSec: 7, defuseCheckpointSec: 3.5, enemyCount: 5,
    spawns: { attack: [{ x: 0, y: 0, z: 0, yaw: 0 }], defense: [0, 1, 2, 3, 4].map((i) => ({ x: dist + 30, y: 0, z: (i - 2) * 2, yaw: 0 })) },
    barriers: [{ id: 'w', team: 'attack', a: { x: -10, z: -5 }, b: { x: 10, z: -5 }, y: [-1, 5] }],
    sites: [{ id: 'A', zone: [[-3, -3], [3, -3], [3, 3], [-3, 3]], y: [-1, 2], center: { x: 0, y: 0, z: 0 } }],
    setups: { groups: { all: spawners.map((s) => s.id) }, splits: [[5]], count: 5 },
    ...(roundBot ? { botStart: 'spawn', setupBySpawner: Object.fromEntries(spawners.map((s) => [s.id, { name: s.id, group: 'all', ...s.position }])) } : {}),
  };
  const behaviors = [{ kind: 'shooter', difficulty: 'hard', reaction: [0.2, 0.25], cadence: 'weapon', aimErrorDeg: 0.5, maxRangeM: 60, engage: 'stop', resumeDelay: [0.4, 0.8] }];
  if (roundBot) behaviors.push({ kind: 'roundBot' });
  behaviors.push({ kind: 'respawn', delay: [0.4, 0.9], mode: 'never' });
  return {
    schemaVersion: 2, meta: { id: 'round-bots-test', name: 'round bots test', seed: 1, createdAt: 0 },
    environment: { skyColor: '#111820', fogNear: 14, fogFar: 33, ambientIntensity: 1, keyLightIntensity: 1, fogEnabled: false },
    blocks: [{ id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 400, y: 0.4, z: 400 }, color: '#18222b', collidable: true }],
    playerSpawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 }, spawners,
    actors: [{ id: 'bot', name: 'Bot', body: { shape: 'humanoid', headSize: 1, bodyWidth: 0.44, bodyHeight: 0, look: 'bot', weapon: 'vandal' }, color: '#ff4655', behaviors, hitSlow: true }],
    rules: { duration: 300, scoring: 'clicking', weapon: 'vandal', playerMovable: true, fireMode: 'hold', playerDeath: 'endRound', buyMenu: false, round },
  };
}
const createSim = (doc, seed = 5) => sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed });
function play(s, ticks, input = IDLE, each = null) {
  const ev = [];
  for (let i = 0; i < ticks; i++) { ev.push(...s.step(typeof input === 'function' ? input(i) : input).map((e) => ({ ...e, at: s.tick }))); if (each) each(s, i); }
  return ev;
}

test('roundPrepare with botStart spawn: kept spawners on distinct defender spawn points, same keep/player spawn as before', () => {
  const doc = botDoc();
  for (let seed = 1; seed <= 20; seed++) {
    const p = core.roundPrepare(doc, seed);
    const pts = p.spawners.map((s) => `${s.position.x},${s.position.z}`);
    assert.equal(new Set(pts).size, 5, 'distinct spawn points');
    for (const s of p.spawners) assert.ok(doc.rules.round.spawns.defense.some((q) => q.x === s.position.x && q.z === s.position.z));
    const m1 = core.roundPrepare({ ...doc, rules: { ...doc.rules, round: { ...doc.rules.round, botStart: undefined } } }, seed);
    assert.deepEqual(p.playerSpawn, m1.playerSpawn);
    assert.deepEqual(p.spawners.map((s) => s.id), m1.spawners.map((s) => s.id));
  }
});

test('real sim, no nav (fallback): bots appear on their setup spots and face the player every tick', { skip }, () => {
  const doc = botDoc({ dist: 15 });
  const s = createSim(doc);
  const setups = doc.rules.round.setupBySpawner;
  let checked = 0;
  const ev = play(s, TPS * 3, (i) => ({ ...IDLE, strafe: i % 128 < 64 ? 1 : -1 }), (q) => {
    const snap = q.snapshot(), p = snap.player.position;
    for (const a of snap.actors) {
      if (!a.alive) continue;
      const want = Math.atan2(p.x - a.position.x, p.z - a.position.z);
      const d = Math.abs(Math.atan2(Math.sin(a.facingYaw - want), Math.cos(a.facingYaw - want)));
      assert.ok(d < 0.02, `bot ${a.id} faces ${a.facingYaw.toFixed(3)}, player at ${want.toFixed(3)}`);
      checked++;
    }
  });
  const spawns = ev.filter((e) => e.kind === 'spawn');
  assert.equal(spawns.length, 5);
  const snap = s.snapshot();
  for (const a of snap.actors) {
    const st = setups[a.spawnerId];
    assert.ok(Math.hypot(a.position.x - st.x, a.position.z - st.z) < 1e-9, `${a.spawnerId} on its setup`);
    assert.ok(Math.abs(a.position.y) < 0.05, 'on the floor');
  }
  assert.ok(checked > 5 * TPS * 2);
});

test('real sim: no bot shots in the barrier phase and the reaction time starts at the drop (M1 bots fired on the first live tick)', { skip }, () => {
  const firstShot = (roundBot) => {
    const s = createSim(botDoc({ dist: 15, barrierSec: 2, roundBot }));
    let live = -1;
    const ev = play(s, TPS * 4, IDLE, (q) => { if (live < 0 && q.snapshot().round.phase === 'live') live = q.tick; });
    assert.ok(live > 0);
    const shots = ev.filter((e) => e.kind === 'enemyShot');
    assert.ok(shots.length > 0, 'bots shoot once the barriers drop');
    assert.ok(shots[0].at > live, 'no shot in the barrier phase');
    return shots[0].at - live;
  };
  const m1 = firstShot(false), r2 = firstShot(true);
  assert.ok(r2 >= Math.floor(0.2 * TPS), `round bots wait their reaction time after the drop (${r2} ticks)`);
  assert.ok(m1 < r2, `M1 control fired after ${m1} ticks`);
});

test('real sim: a bot with roundDefusing = 1 never shoots (it still tracks the player)', { skip }, () => {
  const s = createSim(botDoc({ dist: 15, barrierSec: 1 }));
  play(s, TPS / 2);
  const st = s.saveState();
  assert.equal(st.actors.length, 5);
  for (const a of st.actors) { assert.equal(a.roundDefusing, 0); a.roundDefusing = 1; }
  s.restoreState(st);
  const ev = play(s, TPS * 4);
  assert.ok(!ev.some((e) => e.kind === 'enemyShot'), 'a defusing bot fired');
  assert.ok(s.saveState().actors.every((a) => a.behavior.shooter.lastSeenTick > TPS), 'still sees the player');
  // Control: the same run without the flag shoots.
  const c = createSim(botDoc({ dist: 15, barrierSec: 1 }));
  assert.ok(play(c, TPS * 4.5).some((e) => e.kind === 'enemyShot'));
});

test('real sim: save -> step -> restore -> step equals step -> step with round bots', { skip }, () => {
  const s = createSim(botDoc({ dist: 15, barrierSec: 1 }), 21);
  play(s, TPS);
  const saved = s.saveState();
  const a = JSON.stringify(play(s, TPS * 2, (i) => ({ ...IDLE, strafe: i % 50 < 25 ? 1 : -1, fire: i % 9 === 0 })));
  const endA = JSON.stringify(s.saveState());
  s.restoreState(saved);
  const b = JSON.stringify(play(s, TPS * 2, (i) => ({ ...IDLE, strafe: i % 50 < 25 ? 1 : -1, fire: i % 9 === 0 })));
  assert.equal(b, a);
  assert.equal(JSON.stringify(s.saveState()), endA);
});

test('round_bots_patch.py: refuses to run twice; both bundle copies byte-identical and carry the hook', () => {
  let out = '';
  try { execFileSync('python', ['-I', path.join(root, 'tools', 'round_bots_patch.py')], { stdio: 'pipe' }); } catch (e) { out = String(e.stderr || '') + String(e.stdout || ''); }
  assert.match(out, /already patched/);
  const want = {
    'BiMsX6Xn.js': ['from "/aim-rounds/round-bots.mjs";import {maps as localMaps}', 'roundBot:{init:(c,a,x)=>aimRoundBotInit(c,a,x),update:(c,a,x,d)=>aimRoundBotUpdate(c,a,x,d,il)}', 'n.behavior.replay,n.behavior.roundBot]', '||e.roundDefusing===1)return;', '||e.roundHoldFire===1){'],
    'CnrSARj_.js': ['import {aimRoundBotList,aimRoundIoBots} from "/aim-rounds/round-bots.mjs";', '...aimRd!==null?{round:{cfg:aimRdCfg,state:aimRd,bots:null}}:{},', '||G.kind==="roundBot")', 'x.round&&(x.round.bots=aimRoundBotList(iA));const rA=', 'bots:aimRoundIoBots(iA)});'],
    'D_iGclxB.js': ['et.includes(a.kind)||a.kind==="roundBot"||n('],
  };
  for (const [f, marks] of Object.entries(want)) {
    const a = fs.readFileSync(path.join(MODS, 'next', 'js', f)), b = fs.readFileSync(path.join(MODS, '_assets', 'r20261021-1', 'next', 'js', f));
    assert.ok(a.equals(b), `${f} copies differ`);
    for (const m of marks) assert.equal(a.toString('utf-8').split(m).length - 1, 1, `${f}: ${m}`);
  }
});

test('real sim: a bot with roundDefusing = 1 at the spike defuses it through io.bots; the player keeps shooting; killing it drops the progress', { skip }, () => {
  // Bots 80 m out (beyond their 60 m range); bot d3 stands 1.1 m from where the player plants.
  const doc = botDoc({ dist: 80, barrierSec: 1 });
  doc.rules.round.setupBySpawner.d3 = { name: 'd3', group: 'all', x: 1, y: 0, z: 0.5 };
  const s = createSim(doc, 8);
  play(s, TPS / 2);
  const st = s.saveState();
  const d3 = st.actors.find((a) => a.spawnerId === 'd3');
  assert.ok(Math.hypot(d3.position.x - 1, d3.position.z - 0.5) < 1e-9, 'd3 on its spot');
  d3.roundDefusing = 1;
  s.restoreState(st);
  play(s, TPS / 2 + 1);
  s.setRoundHold({ plant: true });
  play(s, TPS * 4);
  s.setRoundHold({ plant: false });
  let r = s.snapshot().round;
  assert.equal(r.phase, 'planted');
  // Defusing: progress, botDefusing, the player is not holding and can shoot.
  const ev = play(s, TPS * 3, (i) => ({ ...IDLE, fire: i % 20 === 0, mouseDx: i % 20 === 0 ? 40 : 0 }));
  r = s.snapshot().round;
  assert.equal(r.botDefusing, true);
  assert.equal(r.defuser, d3.id);
  assert.equal(r.holding, null);
  assert.ok(r.defuse > 0.4 && r.defuse < 0.5, `defuse ${r.defuse}`);
  assert.ok(ev.some((e) => e.kind === 'shot'), 'the player shoots while a bot defuses');
  // Kill the defuser (save -> edit -> restore): before the checkpoint the progress drops to 0.
  const st2 = s.saveState();
  const a = st2.actors.find((x) => x.id === d3.id);
  a.alive = false; a.health = 0;
  s.restoreState(st2);
  play(s, 2);
  r = s.snapshot().round;
  assert.equal(r.botDefusing, false);
  assert.equal(r.defuse, 0);
  assert.equal(s.saveState().actors.find((x) => x.id === d3.id).roundDefusing, 0, 'dead bots stop defusing');
  // Without the kill the bot finishes: round lost, "defused".
  s.restoreState(st);
  play(s, TPS / 2 + 1);
  s.setRoundHold({ plant: true });
  play(s, TPS * 4);
  s.setRoundHold({ plant: false });
  play(s, TPS * 7 + 2);
  r = s.snapshot().round;
  assert.equal(r.reason, 'defused');
  assert.equal(r.win, false);
});

test('real sim, Human-like bots: the reaction at the barrier drop is a first sighting (no 0.7x re-peek discount)', { skip }, () => {
  // Iron reaction [0.9, 1.1]; the Human-like roll never goes below 0.9 x 0.9 s (a re-peek: x0.7).
  for (const seed of [3, 4, 5, 6]) {
    const s = sim.c(botDoc({ dist: 15, barrierSec: 2 }), { sensitivity: 1, zoomSensitivity: 1, seed, bots: 'human', enemyRank: 'iron' });
    let live = -1;
    const ev = play(s, TPS * 2 - 4);
    const st = s.saveState();
    assert.ok(st.actors.every((a) => a.roundHoldFire === 1 && a.behavior.shooter.peeked === false && a.behavior.shooter.lastSeenTick === s.tick), 'barrier: seen, flag on, not "peeked"');
    ev.push(...play(s, TPS * 3, IDLE, (q) => { if (live < 0 && q.snapshot().round.phase === 'live') live = q.tick; }));
    const shot = ev.find((e) => e.kind === 'enemyShot');
    assert.ok(shot && live > 0, `seed ${seed}: a shot after the drop`);
    assert.ok(shot.at - live >= Math.floor(0.81 * TPS), `seed ${seed}: first shot ${shot.at - live} ticks after the drop`);
  }
});
