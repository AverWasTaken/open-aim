// Round mode in the real sim: loads the patched game sim (app/mods/next/js/CnrSARj_.js) headless
// (scripts/sim-loader.mjs stubs the app shell chunk) and plays small round scenes on flat ground
// with the sim's own movement, shooting, bots and save/restore. Needs the game files in site/
// (a few chunks the mods folder doesn't carry); skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js'));
let sim = null;
if (HAVE_SITE) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(path.join(root, 'app', 'mods', 'next', 'js', 'CnrSARj_.js')).href);
}
const skip = !HAVE_SITE && 'no game files in site/';
const createSim = (doc, seed = 5) => sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed }); // OkAdunfX: c as p0
const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };

// Flat ground, player at the origin looking down -z (yaw 0), an attacker barrier across z = -5,
// plant zone A around the spawn, 5 defenders on fixed spots `dist` metres away along +x.
function flatDoc({ dist = 120, spawnDelay = [0.1, 0.2], barrierSec = 1, sideways = false } = {}) {
  const spawners = [1, 2, 3, 4, 5].map((i) => ({ id: `d${i}`, kind: 'fixed', actorTemplateId: 'bot', position: { x: dist, y: 0, z: (i - 3) * 3 }, size: { x: 0, y: 0, z: 0 }, maxAlive: 1, spawnDelay, faceTarget: true, groundSnap: true }));
  const round = {
    map: 'test', side: 'attack', barrierSec, roundSec: 100, plantSec: 4, spikeSec: 45, defuseSec: 7, defuseCheckpointSec: 3.5, enemyCount: 5,
    spawns: { attack: [{ x: 0, y: 0, z: 0, yaw: 0 }], defense: [{ x: dist, y: 0, z: 0, yaw: 0 }] },
    barriers: [sideways
      ? { id: 'w', team: 'attack', a: { x: -5, z: -10 }, b: { x: -5, z: 10 }, y: [-1, 5] }
      : { id: 'w', team: 'attack', a: { x: -10, z: -5 }, b: { x: 10, z: -5 }, y: [-1, 5] }],
    sites: [{ id: 'A', zone: [[-3, -3], [3, -3], [3, 3], [-3, 3]], y: [-1, 2], center: { x: 0, y: 0, z: 0 } }],
    setups: { groups: { all: spawners.map((s) => s.id) }, splits: [[5]], count: 5 },
  };
  return {
    schemaVersion: 2, meta: { id: 'round-test', name: 'round test', seed: 1, createdAt: 0 },
    environment: { skyColor: '#111820', fogNear: 14, fogFar: 33, ambientIntensity: 1, keyLightIntensity: 1, fogEnabled: false },
    blocks: [{ id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 400, y: 0.4, z: 400 }, color: '#18222b', collidable: true }],
    playerSpawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 }, spawners,
    actors: [{ id: 'bot', name: 'Bot', body: { shape: 'humanoid', headSize: 1, bodyWidth: 0.44, bodyHeight: 0, look: 'bot', weapon: 'vandal' }, color: '#ff4655',
      behaviors: [{ kind: 'shooter', difficulty: 'hard', reaction: [0.2, 0.25], cadence: 'weapon', aimErrorDeg: 0.5, maxRangeM: 60, engage: 'stop', resumeDelay: [0.4, 0.8] }, { kind: 'respawn', delay: [0.4, 0.9], mode: 'never' }], hitSlow: true }],
    rules: { duration: 300, scoring: 'clicking', weapon: 'vandal', playerMovable: true, fireMode: 'hold', playerDeath: 'endRound', buyMenu: false, round },
  };
}
function play(s, ticks, input = IDLE, each = null) {
  const ev = [];
  for (let i = 0; i < ticks; i++) {
    if (each) each(s, i);
    ev.push(...s.step(typeof input === 'function' ? input(i) : input));
  }
  return ev;
}

test('a drill without a round is untouched: snapshot().round is null, no round events, same run twice', { skip }, () => {
  const ts = JSON.parse(fs.readFileSync(path.join(root, 'app', 'training-set.json'), 'utf-8'));
  const doc = JSON.parse(Object.values(ts.scenes).find((s) => !JSON.parse(s.doc).environment.map).doc);
  const runs = [createSim(doc, 77), createSim(doc, 77)].map((s) => {
    const ev = play(s, 600, (i) => ({ ...IDLE, forward: i % 200 < 100 ? 1 : 0, mouseDx: i % 50 === 0 ? 20 : 0, fire: i % 7 === 0 }));
    const snap = s.snapshot();
    assert.equal(snap.round, null);
    assert.equal(s.saveState().aimRound, undefined);
    assert.ok(!ev.some((e) => String(e.kind).startsWith('round')));
    return JSON.stringify({ ev, p: snap.player.position, a: snap.actors.map((a) => [a.alive, a.position]) });
  });
  assert.equal(runs[0], runs[1]);
});

test('barrier phase: walking, sprinting, jumping and strafing into the barrier never crosses it; after the drop you can', { skip }, () => {
  for (const sideways of [false, true]) {
    const s = createSim(flatDoc({ barrierSec: 6, sideways }));
    // yaw 0 looks down -z; sideways barrier is at x = -5 (strafe left).
    const push = sideways ? { ...IDLE, strafe: -1 } : { ...IDLE, forward: 1 };
    let maxPast = -Infinity;
    const past = () => { const p = s.snapshot().player.position; return sideways ? -5 - p.x : -5 - p.z; };
    // Always pushing into it, zig-zagging along it (diagonal runs at the wall), jumping, some walking.
    const zig = (i) => (i % 60 < 30 ? 1 : -1);
    play(s, TPS * 5.5, (i) => (sideways
      ? { ...push, forward: zig(i), jump: i % 40 === 0, walk: i % 200 > 150 }
      : { ...push, strafe: zig(i), jump: i % 40 === 0, walk: i % 200 > 150 }), () => { maxPast = Math.max(maxPast, past()); });
    assert.equal(s.snapshot().round.phase, 'barrier');
    assert.ok(maxPast < -0.3, `${sideways ? 'sideways' : 'front'} barrier: got ${maxPast.toFixed(2)} m past it`);
    assert.ok(maxPast > -1, 'the player did reach the barrier');
    play(s, TPS * 2, push);
    assert.equal(s.snapshot().round.phase, 'live');
    assert.ok(past() > 1, 'crossed after the drop');
  }
});

test('no shooting by anyone during the barrier phase; bots shoot after the drop', { skip }, () => {
  const s = createSim(flatDoc({ dist: 15, barrierSec: 2 }));
  const before = play(s, TPS * 2 - 2, (i) => ({ ...IDLE, fire: true, mouseDx: i % 3 }));
  assert.ok(!before.some((e) => e.kind === 'shot'), 'player shot during the barrier phase');
  assert.ok(!before.some((e) => e.kind === 'enemyShot'), 'bot shot during the barrier phase');
  assert.ok(before.some((e) => e.kind === 'spawn'));
  const after = play(s, TPS * 3);
  assert.ok(after.some((e) => e.kind === 'enemyShot'), 'bots shoot once the barriers drop');
});

test('plant in the real sim: 4 s held; no shot on the first held tick or while planting; knife cancels', { skip }, () => {
  const s = createSim(flatDoc());
  play(s, TPS + 1);
  assert.equal(s.snapshot().round.phase, 'live');
  // Fire and the plant key on the same tick: no shot.
  s.setRoundHold({ plant: true });
  let ev = s.step({ ...IDLE, fire: true });
  assert.ok(!ev.some((e) => e.kind === 'shot'), 'shot on the first plant tick');
  ev = play(s, TPS * 2, { ...IDLE, fire: true });
  assert.ok(!ev.some((e) => e.kind === 'shot'), 'shot while planting');
  assert.equal(s.snapshot().round.holding, 'plant');
  // Knife out: the plant starts over.
  assert.ok(s.requestSwitch('melee'));
  play(s, 64);
  assert.equal(s.snapshot().round.plant, 0, 'knife cancels');
  s.requestSwitch('primary');
  play(s, TPS * 1.5);
  s.setRoundHold({ plant: false });
  ev = play(s, 32, { ...IDLE, fire: true });
  assert.ok(ev.some((e) => e.kind === 'shot'), 'shooting works again without the hold');
  s.setRoundHold({ plant: true });
  play(s, TPS * 4 - 1);
  assert.equal(s.snapshot().round.phase, 'live');
  play(s, 1);
  const r = s.snapshot().round;
  assert.equal(r.phase, 'planted');
  assert.equal(r.spike.planted.site, 'A');
});

test('save/restore brings the round back (the play page\'s opening step does save -> step -> restore)', { skip }, () => {
  const s = createSim(flatDoc());
  play(s, TPS + 1);
  s.setRoundHold({ plant: true });
  play(s, TPS * 2);
  const saved = s.saveState();
  const at = JSON.stringify(s.snapshot().round);
  play(s, TPS * 3);
  assert.equal(s.snapshot().round.phase, 'planted');
  s.restoreState(saved);
  assert.equal(JSON.stringify(s.snapshot().round), at);
  // The hold is cleared on restore (keys are read again before the next step).
  play(s, 2);
  assert.equal(s.snapshot().round.plant, 0);
});

test('death after the plant: the round goes on, the player can\'t move or jump, the spike wins it', { skip }, () => {
  // Bots appear 6 s in, after the plant (barrier 1 s + plant 4 s), 12 m away, and shoot well.
  const s = createSim(flatDoc({ dist: 12, spawnDelay: [6, 6.1] }));
  play(s, TPS + 1);
  s.setRoundHold({ plant: true });
  play(s, TPS * 4);
  s.setRoundHold({ plant: false });
  assert.equal(s.snapshot().round.phase, 'planted');
  let dead = false;
  play(s, TPS * 10, IDLE, (q) => { dead ||= !q.snapshot().round.playerAlive; });
  assert.ok(dead, 'the bots killed the player');
  const r = s.snapshot().round;
  assert.equal(r.phase, 'planted');
  const p0 = s.snapshot().player.position;
  let maxY = p0.y;
  play(s, TPS * 2, (i) => ({ ...IDLE, forward: 1, strafe: 1, jump: i % 30 === 0, fire: true }), (q) => { maxY = Math.max(maxY, q.snapshot().player.position.y); });
  const p1 = s.snapshot().player.position;
  assert.ok(Math.hypot(p1.x - p0.x, p1.z - p0.z) < 1e-6, 'dead player moved');
  assert.ok(maxY <= p0.y + 1e-6, 'dead player jumped');
  const ev = play(s, TPS * 40);
  assert.ok(!ev.some((e) => e.kind === 'shot'));
  const end = s.snapshot().round;
  assert.equal(end.reason, 'detonated');
  assert.equal(end.win, true);
  play(s, TPS * 4 + 2);
  assert.equal(s.snapshot().round.done, true);
});

test('detonation: the player and bots inside the blast die, the player stays put; a restart is a fresh round', { skip }, () => {
  // Bots 20 m away (inside the 35 m blast) that never see the player in time: they spawn late.
  const doc = flatDoc({ dist: 20, spawnDelay: [40, 40.1] });
  const s = createSim(doc);
  play(s, TPS + 1);
  s.setRoundHold({ plant: true });
  play(s, TPS * 4);
  s.setRoundHold({ plant: false });
  const ev = play(s, TPS * 45);
  const snap = s.snapshot();
  assert.equal(snap.round.reason, 'detonated');
  assert.equal(snap.player.health, 0);
  assert.equal(snap.round.playerAlive, false);
  assert.equal(snap.round.enemiesAlive, 0);
  assert.ok(snap.actors.every((a) => !a.alive), 'bots in the blast die');
  assert.equal(ev.filter((e) => e.kind === 'kill' && e.aimBlast).length, 5);
  assert.equal(snap.round.kills, 0, "blast kills are not the player's kills (they only count in enemiesAlive)");
  assert.ok(Math.abs(snap.round.plantClock - 96) < 0.05, `plant clock ${snap.round.plantClock}: about 4 s into the round`);
  const p0 = snap.player.position;
  let maxY = p0.y;
  play(s, TPS, (i) => ({ ...IDLE, forward: 1, jump: i % 20 === 0 }), (q) => { maxY = Math.max(maxY, q.snapshot().player.position.y); });
  const p1 = s.snapshot().player.position;
  assert.ok(Math.hypot(p1.x - p0.x, p1.z - p0.z) < 1e-6 && maxY <= p0.y + 1e-6, 'blasted player moved');
  const again = createSim(doc, 6);
  play(again, 2);
  const r = again.snapshot().round;
  assert.equal(r.phase, 'barrier');
  assert.equal(r.carrying, true);
  assert.equal(r.spike.planted, null);
});

test('the sim prepares a raw round scene itself and leaves a prepared one alone', { skip }, async () => {
  const core = await import(pathToFileURL(path.join(root, 'app', 'mods', 'aim-rounds', 'round-core.mjs')).href);
  const doc = flatDoc();
  doc.spawners.push(...[6, 7, 8].map((i) => ({ ...doc.spawners[0], id: `d${i}`, position: { x: 120, y: 0, z: i * 3 } })));
  doc.rules.round.setups.groups.all.push('d6', 'd7', 'd8');
  const raw = createSim(doc, 9);
  play(raw, TPS);
  assert.equal(raw.snapshot().actors.length, 5);
  const prepped = core.roundPrepare(doc, 9);
  assert.equal(core.roundPrepare(prepped, 1234), prepped);
  const s = createSim(prepped, 9);
  play(s, TPS);
  assert.deepEqual(s.snapshot().actors.map((a) => a.spawnerId).sort(), prepped.spawners.map((x) => x.id).sort());
});

test("R5 stats: shooting a bot dead counts in round.kills (the play page's kill events, same tick)", { skip }, () => {
  // One harmless bot 8 m straight ahead (the player looks down -z), the other four far away.
  const doc = flatDoc({ dist: 120 });
  doc.actors.push({ ...doc.actors[0], id: 'dummy', behaviors: [{ kind: 'respawn', delay: [0.4, 0.9], mode: 'never' }] });
  doc.spawners[2] = { ...doc.spawners[2], actorTemplateId: 'dummy', position: { x: 0, y: 0, z: -8 } };
  const s = createSim(doc);
  play(s, TPS + 2);
  assert.equal(s.snapshot().round.phase, 'live');
  const ev = play(s, TPS * 2, (i) => ({ ...IDLE, fire: i % 16 < 2 }));
  const kills = ev.filter((e) => e.kind === 'kill' && !e.aimBlast).length;
  const r = s.snapshot().round;
  assert.ok(kills >= 1, `the dummy died (${ev.filter((e) => e.kind === 'shot').length} shots)`);
  assert.equal(r.kills, kills);
  assert.equal(r.enemiesAlive, 5 - kills);
  assert.ok(ev.some((e) => e.kind === 'shot' && e.hitActorId !== null && typeof e.hitPart === 'string'), 'shot events carry hitActorId / hitPart (round-hud counts HS from them)');
});
