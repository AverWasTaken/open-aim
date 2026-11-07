// Round mode bots (app/mods/aim-rounds/round-bots.mjs, the `roundBot` behaviour hooked in by
// tools/round_bots_patch.py). v0 = the contract plus the nav-missing fallback (M1 static bots):
// pure checks in node, then the real patched sim (scripts/sim-loader.mjs) on flat ground.
// The sim part needs the game files in site/ and is skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register, createRequire } from 'node:module';
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
  assert.deepEqual(list[0], { id: 1, spawnerId: 'sp', alive: true, x: 3, y: 1.5, z: -4, mode: 0, defusing: 1, seenTick: 4, nav: 0, node: -1, goal: -1, arrived: 1, moving: 0 });
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

// ================================================================ B2: movement on the real Ascent nav
// Pure checks against tools/round_navlib.mjs (the bake's own helpers), the il driving contract with a
// stub il, then the real patched sim on flat ground with the real Ascent nav graph: xz checks only
// (the flat plane keeps every bot at y 0; floor heights come from the nav). Real collision (A site
// floors, heaven, drops, the true floor height) is in scripts/test-round-bots-real.mjs.
const navlib = await import(pathToFileURL(path.join(root, 'tools', 'round_navlib.mjs')).href);
const I = bots.roundBotsInternals;
const ASCENT = JSON.parse(fs.readFileSync(path.join(MODS, 'aim-rounds', 'ascent.json'), 'utf-8'));
const { buildDoc } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
const NAV_BYTES = fs.readFileSync(path.join(MODS, 'aim-rounds', 'ascent.nav.bin'));
const NAV_AB = NAV_BYTES.buffer.slice(NAV_BYTES.byteOffset, NAV_BYTES.byteOffset + NAV_BYTES.byteLength);
const useNav = () => { globalThis.__aimRoundNav = { ascent: NAV_AB }; return I.navFor('ascent'); };
const DEF_BARS = ASCENT.barriers.filter((b) => b.team === 'defense');
const SUBST = [11378, 11575]; // "B site front" (node 13874, walk:false) -> nearest reachable nodes, 2.0 m
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// Three kept sets of 5 that cover all 15 setups, each mixing sites (forced: setups.groups/splits).
const SETS = [
  ['A site default', 'A site front', 'Market', 'B default', 'B back site'],
  ['A generator', 'A site tree side', 'Market back', 'B boathouse side', 'B site front'],
  ['A heaven', 'A heaven tree side', 'A rafters back', 'Pizza', 'B workshop'],
];
const PLANE = { id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 400, y: 0.4, z: 400 }, color: '#18222b', collidable: true };
function ascentDoc({ barrierSec = 20, set = null, flat = true, oneSpawn = false } = {}) {
  const doc = buildDoc(ASCENT, { side: 'attack', weapon: 'vandal', barrierSec });
  if (flat) doc.blocks = [PLANE];
  const r = doc.rules.round;
  if (set) {
    const byName = Object.fromEntries(Object.entries(r.setupBySpawner).map(([id, s]) => [s.name, id]));
    const ids = set.map((n) => byName[n]);
    assert.ok(ids.every(Boolean), 'setup names');
    r.setups = { groups: { all: ids }, splits: [[ids.length]], count: ids.length };
    doc.spawners = doc.spawners.filter((s) => ids.includes(s.id));
  }
  if (oneSpawn) r.spawns = { ...r.spawns, defense: [r.spawns.defense[0]] };
  return doc;
}
const ascentSim = (doc, seed, extra = {}) => sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed, ...extra });
const crossesBar = (a, b, bars = DEF_BARS) => bars.some((w) => navlib.segCross(a.x, a.z, b.x, b.z, w.a.x, w.a.z, w.b.x, w.b.z));
const segDist = (p, w) => {
  const vx = w.b.x - w.a.x, vz = w.b.z - w.a.z, l = vx * vx + vz * vz, t = Math.max(0, Math.min(1, ((p.x - w.a.x) * vx + (p.z - w.a.z) * vz) / l));
  return Math.hypot(p.x - (w.a.x + vx * t), p.z - (w.a.z + vz * t));
};
function sealFlood(N, mask) {
  const H = navlib.nodeIndex(N.g);
  const spawns = ASCENT.spawns.defense.map((p) => navlib.nearestNode(N.g, H, p.x, p.z, 1, p.y, 1.5));
  assert.ok(spawns.every((s) => s >= 0));
  return { spawns, all: navlib.flood(N.g, spawns, { types: navlib.TYPES.all, mask }), walkDrop: navlib.flood(N.g, spawns, { types: navlib.TYPES.walkDrop, mask }) };
}
const fakeRng = (u = 0.5) => ({ range: (a, b) => a + (b - a) * u });

test('B2 barrier mask is navlib barrierMask bit for bit; the masked floods from the defender spawns match navlib (the seal holds)', () => {
  const N = useNav(), g = N.g;
  const bars = I.barriersOf({ side: 'attack', barriers: ASCENT.barriers });
  assert.deepEqual(bars.map((b) => b.id), DEF_BARS.map((b) => b.id));
  const m = I.maskFor(N, bars), want = navlib.barrierMask(g, DEF_BARS);
  assert.ok(Buffer.from(m).equals(Buffer.from(want)), 'mask differs from navlib');
  assert.ok(want.reduce((a, v) => a + v, 0) > 100, 'the defender barriers cut edges');
  assert.equal(I.maskFor(N, bars), m, 'cached');
  const { spawns, all, walkDrop } = sealFlood(N, want);
  const union = new Uint8Array(g.count);
  for (const s of spawns) { const r = I.reachFor(N, s, m); for (let i = 0; i < g.count; i++) union[i] |= r[i]; }
  let diff = 0;
  for (let i = 0; i < g.count; i++) if ((walkDrop[i] !== -2) !== (union[i] === 1)) diff++;
  assert.equal(diff, 0, 'walk+drop reach from the spawns');
  const a0 = ASCENT.spawns.attack[0], H = navlib.nodeIndex(g), atk = navlib.nearestNode(g, H, a0.x, a0.z, 1, a0.y, 1.5);
  assert.ok(atk >= 0);
  assert.equal(all[atk], -2, 'all-edge flood from the defender spawns never reaches the attacker spawn');
  assert.notEqual(navlib.flood(g, spawns, { types: navlib.TYPES.walkDrop })[atk], -2, 'without the mask it does');
});

const setupGoals = (N) => Object.entries(N.g.header.setups).map(([name, s]) => [name, s.walk ? s.node : null]);
test('B2 fields: equal to navlib dijkstra (incoming edges, walk+drop), and every node descends to the goal (masked and unmasked)', () => {
  const N = useNav(), g = N.g, m = I.maskFor(N, I.barriersOf({ side: 'attack', barriers: ASCENT.barriers }));
  const goals = setupGoals(N).map(([, n]) => n).filter((n) => n !== null).concat(SUBST);
  assert.equal(goals.length, 16);
  for (const goal of goals) for (const mask of [null, m]) {
    const F = I.fieldFor(N, goal, mask), ref = navlib.dijkstra(g, [goal], { types: navlib.TYPES.walkDrop, mask, toward: true, rev: N.rev });
    let bad = 0, reached = 0;
    for (let i = 0; i < g.count; i++) {
      if (!Number.isFinite(ref.dist[i])) { if (Number.isFinite(F.dist[i]) || F.via[i] !== -1) bad++; continue; }
      reached++;
      if (Math.abs(F.dist[i] - ref.dist[i]) > 1e-9) { bad++; continue; }
      if (i === goal) { if (F.via[i] !== -1) bad++; continue; }
      const e = F.viaE[i], j = F.via[i];
      if (e < g.edgeStart[i] || e >= g.edgeStart[i + 1] || g.edgeTo[e] !== j || g.edgeType[e] > 1 || (mask && mask[e]) || !(F.dist[j] < F.dist[i]) || Math.abs(F.dist[i] - g.edgeCost[e] - F.dist[j]) > 1e-9) bad++;
    }
    assert.equal(bad, 0, `goal ${goal} mask ${!!mask}: ${bad} bad nodes`);
    assert.ok(reached > 10000, `goal ${goal}: ${reached} nodes reach it`);
    // Full descents from a spread of nodes end at the goal.
    for (let i = 0; i < g.count; i += 997) if (Number.isFinite(F.dist[i])) { let k = i, n = 0; while (k !== goal && n++ < 5000) k = F.via[k]; assert.equal(k, goal); }
  }
});

function initBot(name, { phase = 'barrier', spawn = 0, doc = ascentDoc() } = {}) {
  const r = doc.rules.round, sid = Object.keys(r.setupBySpawner).find((id) => r.setupBySpawner[id].name === name);
  const p = ASCENT.spawns.defense[spawn];
  const a = { id: 3, spawnerId: sid, alive: true, position: { x: p.x, y: p.y, z: p.z }, offset: { x: 0, y: 0, z: 0 }, behavior: {}, rng: fakeRng() };
  const ctx = { tick: 20, elapsed: 20 / TPS, round: { cfg: r, state: { phase }, bots: null }, profile: { runSpeed: 6.75 }, target: { eye: { x: 0, y: 3.6, z: 0 }, canSee: () => false } };
  bots.roundBotInit({ kind: 'roundBot' }, a, ctx);
  return { a, ctx, st: a.behavior.roundBot, r };
}
test('B2 init: nav mode for every Ascent setup, no teleport, il state as lN.init, flat finite state; "B site front" holds on a reachable node; bad/missing nav -> fallback', () => {
  const N = useNav();
  for (const [name, node] of setupGoals(N)) {
    for (let spawn = 0; spawn < 5; spawn++) {
      const { a, st } = initBot(name, { spawn });
      const p = ASCENT.spawns.defense[spawn];
      assert.equal(st.nav, 1, `${name}: nav mode`);
      assert.deepEqual(a.position, { x: p.x, y: p.y, z: p.z }, 'never teleports in nav mode');
      assert.equal(st.mode, I.MODE.walk);
      assert.equal(st.index, 0); assert.equal(st.speed, 0); assert.equal(st.finished, false);
      for (const k of ['air', 'vy', 'jy', 'jb', 'stuck']) assert.ok(!(k in st), `${k} left to il`);
      for (const [k, v] of Object.entries(st)) assert.ok((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean', `state ${k} = ${v}`);
      if (node === null) { assert.ok(SUBST.includes(st.goal), `${name}: substitute ${st.goal}`); assert.equal(st.setup, N.g.header.setups[name].node); }
      else assert.equal(st.goal, node, name);
      assert.equal(st.wait, -1, `${name}: reachable inside the barriers`);
      assert.equal(st.face, N.g.header.setups[name].face);
      assert.ok(st.goT >= 20 / TPS && st.goT - 20 / TPS <= I.STAGGER_SEC + 1e-12, 'stagger 0-0.6 s');
      assert.ok(Number.isFinite(a.facingYaw));
    }
  }
  // Without the nav (or with a broken file) the bot is the v0 fallback: on its setup spot.
  for (const nav of [{}, { ascent: new ArrayBuffer(64) }, { ascent: new Uint8Array([1, 2, 3]).buffer }]) {
    globalThis.__aimRoundNav = nav;
    const { a, st, r } = initBot('Market');
    const s = r.setupBySpawner[a.spawnerId];
    assert.equal(st.nav, 0); assert.equal(st.mode, I.MODE.static);
    assert.deepEqual(a.position, { x: s.x, y: s.y, z: s.z });
  }
  useNav();
});

test('B2 update drives il like lN: [here, target, next] + finish run + index 1 while walking, [here, goal] + stop at the end; brake on combatHold only after the barrier; yield max 0.75 s', () => {
  const N = useNav(), g = N.g;
  const { a, ctx, st } = initBot('B default');
  const calls = [];
  const il = (state, opts) => { calls.push({ opts, index: state.index, finished: state.finished, same: state === st }); };
  const step = (phase, over = {}) => { ctx.tick++; ctx.elapsed = ctx.tick / TPS; ctx.round.state.phase = phase; Object.assign(ctx, over); calls.length = 0; bots.roundBotUpdate({}, a, ctx, 1 / TPS, il); return calls[0]; };
  // Stagger: no il call before goT.
  assert.ok(st.goT > ctx.elapsed);
  assert.equal(step('barrier'), undefined, 'stands during the stagger');
  for (let i = 0; i < 128 && ctx.elapsed + 1 / TPS < st.goT; i++) step('barrier');
  let c = step('barrier');
  assert.ok(c && c.same, 'il state is behavior.roundBot itself');
  assert.equal(c.opts.waypoints.length, 3); assert.equal(c.opts.finish, 'run'); assert.equal(c.index, 1); assert.equal(c.finished, false);
  assert.equal(c.opts.speed, 6.75); assert.equal(c.opts.loop, false); assert.ok(!c.opts.brake);
  assert.deepEqual(c.opts.waypoints[0], a.position);
  const tgt = c.opts.waypoints[1], d = Math.hypot(tgt.x - a.position.x, tgt.z - a.position.z);
  assert.ok(d > 1, `target ${d.toFixed(2)} m ahead (look-ahead)`);
  a.combatHold = 1;
  assert.ok(!step('barrier').opts.brake, 'combatHold ignored in the barrier phase');
  assert.equal(step('live').opts.brake, true, 'brake on combatHold after the drop');
  st.air = 1; assert.ok(!step('live').opts.brake, 'no brake in the air (lN)'); delete st.air;
  a.combatHold = 0;
  ctx.profile = { runSpeed: 5 }; ctx.speedScale = 0.5;
  assert.equal(step('live').opts.speed, 5, 'run speed from the profile; il applies speedScale itself');
  delete ctx.speedScale; ctx.profile = { runSpeed: 6.75 };
  // Yield: a moving bot with a lower id 0.5 m ahead -> brake, at most 0.75 s, then pass.
  const other = () => ({ id: 1, alive: true, moving: 1, x: a.position.x + ((tgt.x - a.position.x) / d) * 0.5, y: a.position.y, z: a.position.z + ((tgt.z - a.position.z) / d) * 0.5 });
  let braked = 0;
  for (let i = 0; i < 128; i++) { ctx.round.bots = [other()]; if (step('live').opts.brake) braked++; else break; }
  assert.equal(braked, Math.floor(0.75 * TPS), 'yields 0.75 s');
  ctx.round.bots = [{ ...other(), id: 9 }];
  st.yieldCd = -1;
  assert.ok(!step('live').opts.brake, 'no yield to a higher id');
  ctx.round.bots = [{ ...other(), moving: 0 }];
  assert.ok(!step('live').opts.brake, 'no yield to a standing bot');
  ctx.round.bots = [other()];
  assert.equal(step('live').opts.brake, true, 'yields again after the cooldown');
  ctx.round.bots = null;
  // Near the goal: [here, goal] with finish stop.
  const goal = st.goal;
  a.position = { x: g.x[goal] + 0.6, y: g.y[goal], z: g.z[goal] };
  c = step('live');
  assert.equal(c.opts.waypoints.length, 2); assert.equal(c.opts.finish, 'stop');
  assert.deepEqual(c.opts.waypoints[1], { x: g.x[goal], y: g.y[goal], z: g.z[goal] });
  // il reports the goal reached -> hold; il is not called any more; it turns to the setup angle.
  a.position = { x: g.x[goal], y: g.y[goal], z: g.z[goal] };
  ctx.tick++; ctx.elapsed = ctx.tick / TPS;
  bots.roundBotUpdate({}, a, ctx, 1 / TPS, (s) => { s.finished = true; s.speed = 0; });
  assert.equal(st.mode, I.MODE.hold); assert.equal(st.arrived, 1);
  assert.equal(step('live'), undefined, 'holding: no il call');
  for (let i = 0; i < 128; i++) step('live');
  assert.ok(Math.abs(wrapA(a.facingYaw - st.face)) < 1e-9 || Math.abs(wrapA(a.facingYaw - st.face2)) < 1e-9, 'holds its angle');
  // Dead in the air: finishes the fall with brake.
  a.alive = false; st.air = 1; calls.length = 0;
  bots.roundBotUpdate({}, a, ctx, 1 / TPS, il);
  assert.equal(calls.length, 1); assert.equal(calls[0].opts.brake, true); assert.equal(a.roundHoldFire, 0);
});

test('B2 stuck: a bot that makes no progress re-plans every 2 s, then stands where it is (no teleport, no more il calls)', () => {
  useNav();
  const { a, ctx, st } = initBot('Market');
  const p0 = { ...a.position };
  let calls = 0;
  const replanAt = [];
  for (let i = 0; i < TPS * 9; i++) {
    ctx.tick++; ctx.elapsed = ctx.tick / TPS; ctx.round.state.phase = 'barrier';
    const before = st.replans;
    bots.roundBotUpdate({}, a, ctx, 1 / TPS, () => { calls++; }); // il that never moves the bot
    if (st.replans > before) replanAt.push(ctx.elapsed - st.goT);
    if (st.mode === I.MODE.stuck) break;
  }
  assert.equal(st.replans, 3);
  assert.equal(st.mode, I.MODE.stuck);
  assert.equal(replanAt.length, 3);
  replanAt.forEach((t, k) => assert.ok(Math.abs(t - 2 * (k + 1)) < 0.05, `re-plan ${k + 1} at ${t.toFixed(3)} s`));
  const n = calls;
  for (let i = 0; i < TPS * 2; i++) { ctx.tick++; ctx.elapsed = ctx.tick / TPS; ctx.round.state.phase = 'live'; bots.roundBotUpdate({}, a, ctx, 1 / TPS, () => { calls++; }); }
  assert.equal(calls, n, 'stuck: no il calls');
  assert.deepEqual(a.position, p0, 'never teleported');
  assert.equal(st.speed, 0);
});

// A flat-ground run with the real Ascent nav and per-tick checks. Returns per-bot results.
function runFlat(doc, seed, ticks, { each = null, extra = {} } = {}) {
  const N = useNav(), g = N.g, H = navlib.nodeIndex(g), s = ascentSim(doc, seed, extra), res = new Map();
  const seal = sealFlood(N, I.maskFor(N, I.barriersOf(doc.rules.round))).all;
  const prev = new Map();
  for (let i = 0; i < ticks; i++) {
    s.step(IDLE);
    const st = s.saveState(), phase = s.snapshot().round.phase;
    for (const a of st.actors) {
      const b = a.behavior.roundBot, q = prev.get(a.id), p = a.position;
      if (!res.has(a.id)) res.set(a.id, { id: a.id, spawnerId: a.spawnerId, name: doc.rules.round.setupBySpawner[a.spawnerId].name, maxYield: 0, maxStep: 0, maxTurn: 0, crossed: 0, offNode: 0, outside: 0 });
      const r = res.get(a.id);
      r.b = b; r.p = { ...p }; r.yaw = a.facingYaw;
      assert.equal(b.nav, 1, 'nav mode');
      const near = navlib.nodesNear(g, H, p.x, p.z, 0.36).some((k) => Math.abs(g.y[k] - g.y[b.cur]) <= 0.6 || (b.tgt >= 0 && Math.abs(g.y[k] - g.y[b.tgt]) <= 0.6));
      if (!near) r.offNode++;
      if (phase === 'barrier' && seal[b.cur] === -2) r.outside++;
      r.maxYield = Math.max(r.maxYield, b.yieldT);
      if (q) {
        r.maxStep = Math.max(r.maxStep, Math.hypot(p.x - q.p.x, p.z - q.p.z));
        r.maxTurn = Math.max(r.maxTurn, Math.abs(wrapA(a.facingYaw - q.yaw)));
        if (phase === 'barrier' && crossesBar(q.p, p)) r.crossed++;
      }
      prev.set(a.id, { p: { ...p }, yaw: a.facingYaw });
    }
    if (each) each(s, st, i, phase);
  }
  return { s, res: [...res.values()] };
}
function checkWalk(results, { barrierSec, label }) {
  assert.equal(results.length, 5, `${label}: 5 bots`);
  for (const r of results) {
    const tag = `${label} ${r.name}`;
    assert.equal(r.offNode, 0, `${tag}: ticks off the nav floor`);
    assert.equal(r.outside, 0, `${tag}: node outside the defender seal flood in the barrier phase`);
    assert.equal(r.crossed, 0, `${tag}: crossed a defender barrier in the barrier phase`);
    assert.ok(r.maxStep < 0.1, `${tag}: max step ${r.maxStep} (no teleport)`);
    assert.ok(r.maxTurn <= I.TURN_RATE / TPS + 1e-9, `${tag}: turn ${r.maxTurn} per tick`);
    assert.ok(r.maxYield <= I.YIELD_MAX + 1 / TPS, `${tag}: yielded ${r.maxYield} s in a row`);
    assert.equal(r.b.replans, 0, `${tag}: re-plans`);
    if (barrierSec) assert.ok(r.b.arrived === 1 && r.b.arriveT < barrierSec, `${tag}: arrived at ${r.b.arriveT}`);
  }
  const still = results.filter((r) => r.b.mode === I.MODE.hold || r.b.mode === I.MODE.wait);
  for (const a of still) for (const b of still) if (a.id < b.id) assert.ok(Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) >= 0.8, `${label}: ${a.name} and ${b.name} stand within 0.8 m`);
}

test('B2 flat Ascent, 20 s barrier: every setup reached before the drop; per tick on the nav floor, inside the seal, never across a barrier, no teleport, turn rate capped; holds its angle', { skip }, () => {
  const g = useNav().g;
  SETS.forEach((set, k) => {
    const { res } = runFlat(ascentDoc({ barrierSec: 20, set }), 31 + k, TPS * 21);
    checkWalk(res, { barrierSec: 20, label: `flat set ${k}` });
    for (const r of res) {
      assert.equal(r.b.mode, I.MODE.hold, `${r.name} holds`);
      assert.ok(Math.hypot(r.p.x - g.x[r.b.goal], r.p.z - g.z[r.b.goal]) < 0.05, `${r.name} on its node`);
      const off = Math.min(Math.abs(wrapA(r.yaw - r.b.face)), Math.abs(wrapA(r.yaw - r.b.face2)));
      assert.ok(off < (8 * Math.PI) / 180, `${r.name}: facing ${off} rad off its angle`);
      if (r.name === 'B site front') assert.ok(SUBST.includes(r.b.goal));
    }
  });
});

test('B2 flat: five bots from one spawn point yield and pass (<= 0.75 s in a row), all arrive; save mid-yield -> restore -> identical', { skip }, () => {
  const doc = ascentDoc({ barrierSec: 20, set: SETS[0], oneSpawn: true });
  let saved = null, savedAt = -1, chunk = null;
  const rec = [];
  const { s, res } = runFlat(doc, 5, TPS * 21, {
    each: (q, st, i) => {
      if (!saved && st.actors.some((a) => a.behavior.roundBot.yieldT > 0)) { saved = st; savedAt = i; }
      if (saved && i > savedAt && i <= savedAt + TPS) rec.push(JSON.stringify(q.snapshot().actors));
      if (saved && i === savedAt + TPS) chunk = JSON.stringify(q.saveState());
    },
  });
  checkWalk(res, { barrierSec: 20, label: 'one spawn' });
  assert.ok(saved, 'some bot yielded');
  s.restoreState(saved);
  const again = [];
  for (let i = 0; i < TPS; i++) { s.step(IDLE); again.push(JSON.stringify(s.snapshot().actors)); }
  assert.deepEqual(again, rec);
  assert.equal(JSON.stringify(s.saveState()), chunk);
});

test('B2 flat: same seed with cold and warm nav caches -> identical run (events, snapshots, state)', { skip }, () => {
  const run = (cold) => {
    if (cold) I.resetCaches();
    useNav();
    const s = ascentSim(ascentDoc({ barrierSec: 10, set: SETS[1] }), 77), out = [];
    for (let i = 0; i < TPS * 14; i++) out.push(JSON.stringify(s.step(IDLE)), JSON.stringify(s.snapshot().actors));
    return out.join('\n') + JSON.stringify(s.saveState());
  };
  const a = run(true), b = run(false);
  assert.ok(a === b, 'cold and warm runs differ');
});

test('B2 flat, both movement modes: in the barrier phase bots that see the player keep walking and hold fire; after the drop they brake on combatHold, face the player and shoot; then walk on to their setups', { skip }, () => {
  for (const extra of [{}, { movement: 'game' }]) combatRun(extra);
});
function combatRun(extra) {
  const s = ascentSim(ascentDoc({ barrierSec: 2, set: SETS[0] }), 9, extra);
  for (let i = 0; i < TPS; i++) s.step(IDLE);
  // Put the player in the open 12 m in front of the defender spawn (flat ground: every bot sees them).
  const sp = ASCENT.spawns.defense[0];
  let st = s.saveState();
  st.player.position = { x: sp.x + 12, y: 0, z: sp.z };
  s.restoreState(st);
  const pos0 = new Map(s.saveState().actors.map((a) => [a.id, { ...a.position }]));
  const ev = [];
  let live = -1, seen = 0;
  for (let i = 0; live < 0 && i < TPS * 2; i++) {
    ev.push(...s.step(IDLE));
    if (s.snapshot().round.phase !== 'barrier') live = s.tick;
    else for (const a of s.saveState().actors) if (a.behavior.shooter.lastSeenTick === s.tick) seen++;
  }
  assert.ok(live > 0);
  assert.ok(seen > 0, 'they see the player in the barrier phase');
  assert.ok(!ev.some((e) => e.kind === 'enemyShot'), 'no shots in the barrier phase');
  const moved = s.saveState().actors.filter((a) => Math.hypot(a.position.x - pos0.get(a.id).x, a.position.z - pos0.get(a.id).z) > 2);
  assert.equal(moved.length, 5, 'all kept walking');
  // After the drop: the first shot within reaction (<= 0.5 s) + 0.5 s, from a bot that braked and faces the player.
  let shot = null;
  for (let i = 0; !shot && i < TPS * 2; i++) {
    shot = s.step(IDLE).find((e) => e.kind === 'enemyShot') ?? null;
    if (shot) {
      const q = s.saveState(), a = q.actors.find((x) => x.id === shot.actorId), p = q.player.position;
      assert.ok(a.behavior.roundBot.speed < 2, `shooter speed ${a.behavior.roundBot.speed}`);
      assert.equal(a.combatHold, 1);
      const want = Math.atan2(p.x - a.position.x, p.z - a.position.z);
      assert.ok(Math.abs(wrapA(a.facingYaw - want)) < (15 * Math.PI) / 180, 'faces the player');
    }
  }
  assert.ok(shot && s.tick - live <= TPS, `first shot ${shot ? s.tick - live : '-'} ticks after the drop`);
  // Player gone (back to the attacker spawn, > 60 m away): they walk on and reach their setups.
  st = s.saveState();
  st.player.position = { x: ASCENT.spawns.attack[0].x, y: 0, z: ASCENT.spawns.attack[0].z };
  s.restoreState(st);
  for (let i = 0; i < TPS * 18; i++) s.step(IDLE);
  for (const a of s.saveState().actors) if (a.alive) assert.equal(a.behavior.roundBot.mode, I.MODE.hold, `${a.spawnerId} reached its setup`);
}

// A test-only setup just past def-mid (attacker side): the bot must wait at the barrier.
function beyondMid(N) {
  const w = DEF_BARS.find((b) => b.id === 'def-mid'), g = N.g;
  const k = I.nodesNear(N, w.a.x + 3, (w.a.z + w.b.z) / 2, 2).find((i) => g.y[i] >= w.y[0] && g.y[i] <= w.y[1] && g.x[i] > w.a.x + 2);
  assert.ok(k >= 0, 'a node past def-mid');
  return { w, k };
}
test('B2 flat: a setup beyond def-mid -> the bot waits at the barrier (never crosses it) and goes on after the drop', { skip }, () => {
  const N = useNav(), g = N.g, { w, k } = beyondMid(N);
  const doc = ascentDoc({ barrierSec: 20, set: SETS[2] });
  const sid = Object.keys(doc.rules.round.setupBySpawner).find((id) => doc.rules.round.setupBySpawner[id].name === 'Pizza');
  doc.rules.round.setupBySpawner[sid] = { name: 'test: past def-mid', group: 'mid', x: g.x[k], y: g.y[k], z: g.z[k] };
  let atDrop = null;
  const { res } = runFlat(doc, 13, TPS * 30, { each: (q, st, i, phase) => { if (!atDrop && phase !== 'barrier') atDrop = st.actors.find((a) => a.spawnerId === sid); } });
  const r = res.find((x) => x.spawnerId === sid);
  assert.ok(r.b.wait >= 0, 'has a wait node');
  assert.equal(r.crossed, 0, 'crossed in the barrier phase');
  assert.equal(r.outside, 0);
  assert.equal(atDrop.behavior.roundBot.mode, I.MODE.wait, 'waiting when the barriers drop');
  assert.ok(segDist(atDrop.position, w) < 2, `waits ${segDist(atDrop.position, w).toFixed(2)} m from the line`);
  assert.equal(r.b.mode, I.MODE.hold, 'reached the setup after the drop');
  assert.ok(Math.hypot(r.p.x - g.x[k], r.p.z - g.z[k]) < 0.05);
  assert.ok(r.b.arriveT > 20 && r.b.arriveT < 26, `arrived ${r.b.arriveT}`);
});
