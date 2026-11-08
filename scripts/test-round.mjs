// Round mode checks (tools/round_patch.py, app/mods/aim-rounds/, app/round-scene.js):
// the controller (the same round-core.mjs module the sim imports) driven tick by tick the way the
// patched sim calls it (move -> revert check -> fire checks -> roundStep), the Ascent data, the
// generated scene (run through the game's own scene validator), and the patched game scripts
// (hooks present, guarded so scenes without rules.round run unchanged, both copies identical).
// Runs in node only. Checks that need the game files in site/ are skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf-8').replace(/\r\n/g, '\n');
const MODS = path.join(root, 'app', 'mods');
const JS = [path.join('app', 'mods', 'next', 'js'), path.join('app', 'mods', '_assets', 'r20261021-1', 'next', 'js')];
const core = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-core.mjs')).href);
const { roundScene, parseCode, buildDoc } = require(path.join(root, 'app', 'round-scene.js'));
const data = JSON.parse(read('app', 'mods', 'aim-rounds', 'ascent.json'));
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'aim-maps', 'ascent.collision.json'));

const TS = 1 / 128; // the sim's tick (BiMsX6Xn.js: ii = 1/wc, wc = 128)
const sec = (s) => Math.round(s / TS);

// ---------------------------------------------------------------- harness
// Mirrors the patched sim step: remember x/z, move, revert when the round blocks the move, then
// (end of step) roundStep with this tick's kills and the held keys.
function makeRound(over = {}) {
  const doc = JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-20').doc);
  const cfg = { ...doc.rules.round, ...over };
  const st = core.roundCreate(cfg, TS);
  const site = cfg.sites.find((s) => s.id === 'A');
  const player = { x: cfg.spawns.attack[0].x, y: cfg.spawns.attack[0].y, z: cfg.spawns.attack[0].z, speed: 0, grounded: true, health: 100 };
  let tick = 0;
  const step = ({ move = null, kills = 0, hold = {}, speed = 0 } = {}) => {
    tick += 1;
    if (move) {
      const x0 = player.x, z0 = player.z;
      player.x += move[0]; player.z += move[1];
      if (core.roundFrozen(st) || core.roundBlocksMove(cfg, st, x0, z0, player.x, player.z, player.y)) { player.x = x0; player.z = z0; }
    }
    player.speed = speed;
    return core.roundStep(cfg, st, { tick, tickSec: TS, player: { ...player }, kills, hold });
  };
  const run = (n, o) => { const ev = []; for (let i = 0; i < n; i++) ev.push(...step(o)); return ev; };
  const toSite = (id = 'A') => { const s = cfg.sites.find((q) => q.id === id); Object.assign(player, { x: s.center.x, y: s.center.y, z: s.center.z }); };
  return { cfg, st, player, step, run, toSite, site, get tick() { return tick; } };
}
const view = (r) => core.roundView(r.cfg, r.st, TS);

// ---------------------------------------------------------------- data + scene
test('Ascent round data: 5 spawns per team, both sites, barriers for both teams', () => {
  assert.equal(data.schema, 1);
  assert.equal(data.map, 'ascent');
  for (const team of ['attack', 'defense']) {
    assert.equal(data.spawns[team].length, 5);
    for (const p of data.spawns[team]) for (const k of ['x', 'y', 'z', 'yaw']) assert.ok(Number.isFinite(p[k]), `${team} spawn ${k}`);
    assert.ok(data.barriers.filter((b) => b.team === team).length >= 4, `${team} barriers`);
  }
  assert.deepEqual(data.sites.map((s) => s.id), ['A', 'B']);
  for (const s of data.sites) { assert.ok(s.zone.length >= 3); assert.ok(s.y[0] < s.center.y && s.center.y < s.y[1]); }
  for (const b of data.barriers) {
    assert.ok(Math.hypot(b.a.x - b.b.x, b.a.z - b.b.z) > 1);
    // Feet on the floor on either side (and jumping 1.5 m) are inside the wall's height range.
    const [lo, hi] = data.authoring.barriers[b.id].floors;
    assert.ok(b.y[0] <= lo - 0.5 && b.y[1] >= hi + 3, `${b.id} height ${b.y} vs floors ${lo}..${hi}`);
  }
  const groups = data.setups.defense;
  assert.ok(groups.A.length >= 3 && groups.B.length >= 3 && groups.mid.length >= 1);
  for (const s of data.setups.splits) assert.equal(s.reduce((a, b) => a + b, 0), 5);
  // The seal check of the authoring tool passed when the file was written.
  for (const team of ['attack', 'defense']) assert.deepEqual(data.authoring.seal[team].leaks, []);
});

test('the stored Ascent data is what tools/round_author.mjs builds', { skip: !HAVE_SITE && 'no game files in site/' }, () => {
  execFileSync(process.execPath, [path.join(root, 'tools', 'round_author.mjs'), '--check'], { stdio: 'pipe' });
});

test('round codes: only known maps/sides/weapons/barrier times', () => {
  assert.deepEqual(parseCode('round-ascent-attack-vandal-20'), { map: 'ascent', side: 'attack', weapon: 'vandal', barrierSec: 20 });
  assert.deepEqual(parseCode('round-ascent-defense-vandal-20'), { map: 'ascent', side: 'defense', weapon: 'vandal', barrierSec: 20 });
  assert.deepEqual(parseCode('round-rook-defense-sheriff-30'), { map: 'rook', side: 'defense', weapon: 'sheriff', barrierSec: 30 });
  for (const bad of ['round-ascent-attack-vandal-25', 'round-ascent-retake-vandal-20', 'round-ascent-defence-vandal-20', 'round-ascent-attack-knife-20', 'round-../x-attack-vandal-20', 'x', '']) assert.equal(parseCode(bad), null, bad);
  assert.equal(roundScene(MODS, 'round-nomap-attack-vandal-20'), null);
  assert.equal(roundScene(MODS, 'round-nomap-defense-vandal-20'), null);
  assert.equal(roundScene(MODS, 'd43f842fb33e4d46'), null);
  // Both sides build on both maps; the defense scene's bots stand on the attacker spawns.
  for (const map of ['ascent', 'rook']) for (const side of ['attack', 'defense']) {
    const env = roundScene(MODS, `round-${map}-${side}-vandal-20`), doc = JSON.parse(env.doc);
    assert.equal(doc.rules.round.side, side, `${map} ${side}`);
    if (side === 'defense') {
      const data = JSON.parse(fs.readFileSync(path.join(MODS, 'aim-rounds', `${map}.json`), 'utf-8'));
      assert.deepEqual(doc.spawners.map((s) => s.position), data.spawns.attack.map((p) => ({ x: p.x, y: p.y, z: p.z })), `${map}: attacker spawns`);
      assert.deepEqual(doc.rules.round.attackData, data.attack, `${map}: attack data`);
      assert.deepEqual(doc.playerSpawn.position, { x: data.spawns.defense[0].x, y: data.spawns.defense[0].y, z: data.spawns.defense[0].z });
    }
  }
});

test('generated scene: brief card text (name, description with map, side, weapon, barrier, goal, keys)', () => {
  const env = roundScene(MODS, 'round-ascent-attack-operator-10');
  assert.equal(env.name, 'Round: Ascent (Attack)');
  assert.equal(env.description, [
    'Ascent · Attack · Operator · 10 s barrier.',
    'Plant the spike. Defenders hold the sites.',
    'Enter: start · Hold 4: plant · Esc: menu',
  ].join('\n'));
  assert.ok(!/[—–]/.test(env.name + env.description), 'no dashes');
  assert.match(roundScene(MODS, 'round-ascent-attack-vandal-20').description, /^Ascent · Attack · Vandal · 20 s barrier\./);
  // Defense: the defender's goal and the defuse key; the map name comes from the map data.
  for (const [code, name, line1] of [
    ['round-ascent-defense-vandal-20', 'Round: Ascent (Defense)', 'Ascent · Defense · Vandal · 20 s barrier.'],
    ['round-rook-defense-sheriff-30', 'Round: Corrode (Defense)', 'Corrode · Defense · Sheriff · 30 s barrier.'],
  ]) {
    const d = roundScene(MODS, code);
    assert.equal(d.name, name);
    assert.equal(d.description, [line1, 'Stop the plant, or defuse it.', 'Enter: start · Hold F: defuse · Esc: menu'].join('\n'));
    assert.ok(!/[—–]/.test(d.name + d.description), 'no dashes');
  }
});

test('generated scene: envelope, rules.round, 5 kept spawners after prep, no respawn', () => {
  const env = roundScene(MODS, 'round-ascent-attack-operator-10');
  assert.equal(env.shareCode, 'round-ascent-attack-operator-10');
  assert.equal(env.docBytes, Buffer.byteLength(env.doc));
  const doc = JSON.parse(env.doc);
  assert.equal(doc.environment.map, 'ascent');
  assert.equal(doc.rules.weapon, 'operator');
  assert.equal(doc.rules.fireMode, 'single');
  assert.equal(doc.rules.round.barrierSec, 10);
  assert.equal(doc.rules.playerDeath, 'endRound');
  assert.ok(doc.actors[0].behaviors.some((b) => b.kind === 'respawn' && b.mode === 'never'));
  const ids = Object.values(doc.rules.round.setups.groups).flat();
  assert.equal(new Set(ids).size, doc.spawners.length);
  const prepped = core.roundPrepare(doc, 12345);
  assert.equal(prepped.spawners.length, 5);
});

test('generated scene: round bots walk from the defender spawns (roundBot after the shooter, faceTarget off, setups by spawner)', () => {
  const doc = JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-20').doc);
  assert.deepEqual(doc.actors[0].behaviors.map((b) => b.kind), ['shooter', 'roundBot', 'respawn']);
  assert.ok(doc.spawners.every((s) => s.faceTarget === false));
  const r = doc.rules.round;
  assert.equal(r.botStart, 'spawn');
  assert.deepEqual(Object.keys(r.setupBySpawner).sort(), doc.spawners.map((s) => s.id).sort());
  for (const [g, spots] of Object.entries(data.setups.defense)) spots.forEach((p, i) => {
    assert.deepEqual(r.setupBySpawner[`round-${g}-${i + 1}`], { name: p.name, group: g, x: p.x, y: p.y, z: p.z });
  });
  assert.equal('retake' in r, !!data.retake);
  const retake = { A: [{ name: 'A1', x: 1, y: 2, z: 3 }], B: [] };
  assert.deepEqual(buildDoc({ ...data, retake }, { side: 'attack', weapon: 'vandal', barrierSec: 20 }).rules.round.retake, retake);
  // Prepared: the 5 kept bots start on the 5 defender spawn points, one each.
  for (const seed of [1, 2, 3, 99]) {
    const p = core.roundPrepare(doc, seed);
    const at = p.spawners.map((s) => data.spawns.defense.findIndex((q) => q.x === s.position.x && q.y === s.position.y && q.z === s.position.z));
    assert.deepEqual([...at].sort(), [0, 1, 2, 3, 4], `seed ${seed}: ${at}`);
  }
});

test('generated scene passes the game\'s own scene validator', { skip: !fs.existsSync(path.join(root, JS[0], 'D_iGclxB.js')) && 'no validator' }, async () => {
  const src = read(JS[0], 'D_iGclxB.js').replace(/^import \{mapIds as localMapIds\} from "\/local\/map-registry\.mjs";/m, 'const localMapIds=["ascent"];');
  assert.ok(src.startsWith('const localMapIds'), 'validator import line changed');
  const tmp = path.join(os.tmpdir(), `aim-round-validator-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    const { p: validate } = await import(pathToFileURL(tmp).href);
    // The harness itself: a shipped drill passes, a broken one doesn't.
    const ts = JSON.parse(read('app', 'training-set.json'));
    validate(Object.values(ts.scenes)[0].doc);
    assert.throws(() => validate(JSON.stringify({ schemaVersion: 2 })));
    for (const w of ['vandal', 'sheriff', 'operator']) for (const b of [10, 20, 30]) {
      const doc = JSON.parse(roundScene(MODS, `round-ascent-attack-${w}-${b}`).doc);
      validate(JSON.stringify(doc)); // the validator takes the doc text; throws on an invalid scene
      validate(JSON.stringify(core.roundPrepare(doc, 7)));
    }
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('roundPrepare: seeded, re-rolls per seed, keeps the split, spawns the player on a team spawn', () => {
  const doc = JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-20').doc);
  const groups = doc.rules.round.setups.groups;
  const groupOf = (id) => Object.keys(groups).find((g) => groups[g].includes(id));
  const a = core.roundPrepare(doc, 99), b = core.roundPrepare(doc, 99);
  assert.deepEqual(a, b);
  const seen = new Set(), spawns = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const p = core.roundPrepare(doc, seed);
    assert.equal(p.spawners.length, 5);
    const split = Object.keys(groups).map((g) => p.spawners.filter((s) => groupOf(s.id) === g).length);
    assert.ok(doc.rules.round.setups.splits.some((s) => s.join() === split.join()), `split ${split}`);
    assert.ok(doc.rules.round.spawns.attack.some((s) => s.x === p.playerSpawn.position.x && s.z === p.playerSpawn.position.z));
    seen.add(p.spawners.map((s) => s.id).sort().join());
    spawns.add(p.playerSpawn.position.x);
  }
  assert.ok(seen.size > 20, 'setups vary with the seed');
  assert.ok(spawns.size > 1, 'player spawn varies with the seed');
  // No round: the scene is untouched (same object).
  const plain = { rules: { duration: 60 }, spawners: [] };
  assert.equal(core.roundPrepare(plain, 5), plain);
  // A prepared scene passes through (the play page prepares it, the sim sees it again).
  assert.equal(a.rules.round.prepared, true);
  assert.equal(core.roundPrepare(a, 5), a);
});

// ---------------------------------------------------------------- controller
test('barrier phase lasts barrierSec, no fire / bot fire / plant during it', () => {
  const r = makeRound();
  assert.equal(r.st.phase, 'barrier');
  assert.ok(core.roundNoFire(r.st) && core.roundBotsHold(r.st));
  r.toSite();
  r.run(sec(20) - 1, { hold: { plant: true } });
  assert.equal(r.st.phase, 'barrier');
  assert.equal(r.st.plant, 0);
  const ev = r.step({ hold: { plant: true } });
  assert.equal(r.st.phase, 'live');
  assert.deepEqual(ev.map((e) => e.kind), ['roundPhase']);
  assert.ok(!core.roundBotsHold(r.st));
  assert.equal(Math.round(view(r).timeLeft), 100);
});

test('plant: 4 s held in a zone; release, running, jumping or leaving the zone restart it', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1));
  r.toSite('B');
  r.run(sec(3), { hold: { plant: true } });
  assert.equal(r.st.holding, 'plant');
  assert.ok(core.roundNoFire(r.st), 'no shooting while planting');
  assert.ok(core.roundBlocksUse(r.st));
  r.step({ hold: { plant: false } });
  assert.equal(r.st.plant, 0, 'release cancels');
  r.run(sec(2), { hold: { plant: true } });
  r.step({ hold: { plant: true }, speed: 5.4 });
  assert.equal(r.st.plant, 0, 'running cancels');
  r.run(sec(2), { hold: { plant: true } });
  r.player.grounded = false; r.step({ hold: { plant: true } }); r.player.grounded = true;
  assert.equal(r.st.plant, 0, 'jumping cancels');
  r.run(sec(1), { hold: { plant: true }, speed: 2.5 }); // walking still plants
  assert.ok(r.st.plant > 0);
  r.player.knife = true; r.step({ hold: { plant: true } }); r.player.knife = false;
  assert.equal(r.st.plant, 0, 'switching to the knife cancels');
  r.run(sec(1), { hold: { plant: true } });
  assert.ok(r.st.plant > 0);
  const out = { ...r.player }; r.player.x = 0; r.player.z = 0;
  r.step({ hold: { plant: true } });
  assert.equal(r.st.plant, 0, 'outside the zone: no plant');
  Object.assign(r.player, out);
  const n = sec(4);
  r.run(n - 1, { hold: { plant: true } });
  assert.equal(r.st.phase, 'live');
  const ev = r.step({ hold: { plant: true } });
  assert.equal(r.st.phase, 'planted');
  assert.deepEqual(ev[0], { kind: 'roundPlant', site: 'B' });
  assert.equal(r.st.spike.planted.site, 'B');
  assert.equal(r.st.spike.carrier, null);
  assert.equal(Math.round(view(r).timeLeft), 45);
});

test('detonation 45 s after the plant wins the round; done after the end hold', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.toSite('A');
  r.run(sec(4), { hold: { plant: true } });
  assert.equal(r.st.phase, 'planted');
  r.run(sec(45) - 1);
  assert.equal(r.st.phase, 'planted');
  const ev = r.step();
  assert.deepEqual(ev, [{ kind: 'roundEnd', winner: 'attack', reason: 'detonated', win: true }]);
  assert.equal(view(r).win, true);
  assert.equal(r.st.done, false);
  r.run(sec(3));
  assert.equal(r.st.done, true);
  assert.ok(core.roundNoFire(r.st) && core.roundBotsHold(r.st));
});

test('end reasons: eliminated, died, timeout; same-tick precedence', () => {
  let r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.run(10);
  r.step({ kills: 3 }); assert.equal(view(r).enemiesAlive, 2);
  let ev = r.step({ kills: 2 });
  assert.equal(ev[0].reason, 'eliminated'); assert.equal(ev[0].win, true);

  r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.player.health = 0;
  ev = r.step();
  assert.deepEqual(ev[0], { kind: 'roundEnd', winner: 'defense', reason: 'died', win: false });

  r = makeRound({ barrierSec: 1 });
  r.run(sec(1));
  r.run(sec(100) - 1); assert.equal(r.st.phase, 'live');
  ev = r.step();
  assert.equal(ev[0].reason, 'timeout'); assert.equal(ev[0].win, false);

  // Elimination beats the timer on the same tick.
  r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.run(sec(100) - 1);
  ev = r.step({ kills: 5 });
  assert.equal(ev[0].reason, 'eliminated');

  // Both teams gone on the same tick before the plant: defenders win.
  r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.player.health = 0;
  ev = r.step({ kills: 5 });
  assert.equal(ev[0].winner, 'defense');

  // Last defender killed after the plant: attackers win at once.
  r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.toSite(); r.run(sec(4), { hold: { plant: true } });
  r.step({ kills: 4 }); assert.equal(r.st.phase, 'planted');
  ev = r.step({ kills: 1 });
  assert.equal(ev[0].reason, 'eliminated'); assert.equal(ev[0].win, true);

  // Detonation beats a last-tick kill.
  r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.toSite(); r.run(sec(4), { hold: { plant: true } });
  r.run(sec(45) - 1);
  ev = r.step({ kills: 5 });
  assert.equal(ev[0].reason, 'detonated');
});

test('player death after the plant: round goes on, player frozen and harmless, spike decides', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.toSite(); r.run(sec(4), { hold: { plant: true } });
  r.player.health = 0;
  let ev = r.step();
  assert.deepEqual(ev, []);
  assert.equal(r.st.phase, 'planted');
  assert.ok(core.roundFrozen(r.st) && core.roundNoFire(r.st) && core.roundBotsHold(r.st));
  const at = { x: r.player.x, z: r.player.z };
  r.run(50, { move: [0.05, 0.05] });
  assert.deepEqual({ x: r.player.x, z: r.player.z }, at, 'dead player does not move');
  ev = r.run(sec(45));
  assert.equal(ev.at(-1).reason, 'detonated');
  assert.equal(view(r).win, true);
});

test('player death before the plant drops the spike', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.player.health = 0; r.step();
  assert.equal(r.st.spike.carrier, null);
  assert.ok(r.st.spike.dropped);
});

test('defuse: 7 s, checkpoint at 3.5 s keeps half on release, before it a release resets', () => {
  // Defense side controller (the lobby offers it in milestone 3): plant made by hand.
  const cfg = { ...JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-10').doc).rules.round, side: 'defense', barrierSec: 1 };
  const st = core.roundCreate(cfg, TS);
  const s = cfg.sites[0];
  const p = { x: s.center.x, y: s.center.y, z: s.center.z, speed: 0, grounded: true, health: 100 };
  let tick = 0;
  const step = (hold = {}, kills = 0) => core.roundStep(cfg, st, { tick: ++tick, tickSec: TS, player: p, kills, hold });
  for (let i = 0; i < sec(1); i++) step();
  st.phase = 'planted'; st.plantTick = tick; st.spike.planted = { x: p.x, y: p.y, z: p.z, site: s.id };
  for (let i = 0; i < sec(2); i++) step({ use: true });
  assert.equal(st.holding, 'defuse');
  step({}); assert.equal(st.defuse, 0, 'release before the checkpoint resets');
  for (let i = 0; i < sec(3.5); i++) step({ use: true });
  assert.ok(st.checkpoint);
  step({}); assert.equal(st.defuse, sec(3.5), 'release after the checkpoint keeps half');
  // Pause: no ticks at all, then resume without the key: still at the checkpoint.
  step({}); assert.equal(st.defuse, sec(3.5));
  for (let i = 0; i < sec(3.5) - 1; i++) step({ use: true });
  assert.equal(st.phase, 'planted');
  const ev = step({ use: true });
  assert.deepEqual(ev[0], { kind: 'roundEnd', winner: 'defense', reason: 'defused', win: true });
});

test('a defuse finishing on the detonation tick loses', () => {
  const cfg = { ...JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-10').doc).rules.round, side: 'defense', barrierSec: 1, spikeSec: 7 };
  const st = core.roundCreate(cfg, TS);
  const s = cfg.sites[1];
  const p = { x: s.center.x, y: s.center.y, z: s.center.z, speed: 0, grounded: true, health: 100 };
  let tick = 0;
  const step = (hold = {}) => core.roundStep(cfg, st, { tick: ++tick, tickSec: TS, player: p, kills: 0, hold });
  for (let i = 0; i < sec(1); i++) step();
  st.phase = 'planted'; st.plantTick = tick; st.spike.planted = { x: p.x, y: p.y, z: p.z, site: s.id };
  let ev = [];
  for (let i = 0; i < sec(7); i++) ev = step({ use: true });
  assert.equal(ev[0].reason, 'detonated');
});

test('no shot on the tick the plant key goes down in a zone; none outside a zone or without the spike', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1));
  assert.equal(core.roundNoFire(r.st, { plant: true }, r.cfg, { x: 0, y: 2, z: 0 }), false, 'outside a zone the key does nothing');
  r.toSite();
  assert.equal(core.roundNoFire(r.st, { plant: false }, r.cfg, r.player), false);
  assert.equal(core.roundNoFire(r.st, { plant: true }, r.cfg, r.player), true);
  r.st.spike.carrier = null;
  assert.equal(core.roundNoFire(r.st, { plant: true }, r.cfg, r.player), false, 'no spike, no plant');
});

test('defuse needs you within reach and facing the spike', () => {
  const cfg = { ...JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-10').doc).rules.round, side: 'defense', barrierSec: 1 };
  const st = core.roundCreate(cfg, TS);
  const s = cfg.sites[0];
  const sp = { x: s.center.x, y: s.center.y, z: s.center.z };
  let tick = 0;
  const at = (dx, dz, yaw) => { core.roundStep(cfg, st, { tick: ++tick, tickSec: TS, player: { x: sp.x + dx, y: sp.y, z: sp.z + dz, yaw, speed: 0, grounded: true, health: 100 }, kills: 0, hold: { use: true } }); return st.near; };
  for (let i = 0; i < sec(1); i++) at(0, 0, 0);
  st.phase = 'planted'; st.plantTick = tick; st.spike.planted = { ...sp, site: s.id };
  // The game's forward is (-sin yaw, -cos yaw): yaw 0 looks down -z.
  assert.equal(at(0, 1.2, 0), true, 'facing it from 1.2 m');
  assert.equal(at(0, 1.2, Math.PI), false, 'back turned');
  assert.equal(at(0, 2.5, 0), false, 'too far');
  assert.equal(at(0.2, 0.2, Math.PI), true, 'standing on it');
});

// ---------------------------------------------------------------- bot defuse (attack side)
// The player plants at A, then io.bots (what the sim builds from the roundBot actors) drive the
// defuse. bot(id, dx, opts) = a bot dx metres (x) from the spike.
function plantedRound(over = {}) {
  const r = makeRound({ barrierSec: 1, ...over });
  r.run(sec(1)); r.toSite(); r.run(sec(4), { hold: { plant: true } });
  assert.equal(r.st.phase, 'planted');
  const sp = r.st.spike.planted;
  const bot = (id, dx = 0.5, o = {}) => ({ id, alive: true, x: sp.x + dx, y: sp.y, z: sp.z, defusing: 1, ...o });
  let tick = r.tick;
  const step = (bots, kills = 0) => core.roundStep(r.cfg, r.st, { tick: ++tick, tickSec: TS, player: { ...r.player }, kills, hold: {}, bots });
  const run = (n, bots) => { let ev = []; for (let i = 0; i < n; i++) ev = ev.concat(step(typeof bots === 'function' ? bots(i) : bots)); return ev; };
  return { ...r, sp, bot, step, run };
}

test('bot defuse: 7 s by a bot at the spike, the player can still shoot, ROUND LOST "defused"', () => {
  const r = plantedRound();
  r.run(sec(3), [r.bot(4)]);
  assert.equal(r.st.defuser, 4);
  assert.equal(r.st.holding, null, 'bots never set holding');
  assert.equal(core.roundNoFire(r.st, {}, r.cfg, r.player), false, 'the player can shoot the defuser');
  const v = view(r);
  assert.equal(v.botDefusing, true);
  assert.equal(v.defuser, 4);
  assert.ok(Math.abs(v.defuse - 3 / 7) < 1e-9);
  r.run(sec(4) - 1, [r.bot(4)]);
  assert.equal(r.st.phase, 'planted');
  const ev = r.step([r.bot(4)]);
  assert.deepEqual(ev, [{ kind: 'roundEnd', winner: 'defense', reason: 'defused', win: false }]);
  assert.equal(view(r).botDefusing, false, 'not after the end');
});

test('bot defuse only counts alive, defusing bots within reach (xz 1.6 m, |dy| < 2); never on the defense side', () => {
  const r = plantedRound();
  for (const bots of [[r.bot(1, 1.7)], [r.bot(1, 0.2, { alive: false })], [r.bot(1, 0.2, { defusing: 0 })], [r.bot(1, 0, { y: r.sp.y + 2 })], [], undefined, [{ id: 2 }]]) {
    r.run(sec(1), bots);
    assert.equal(r.st.defuse, 0, JSON.stringify(bots));
    assert.equal(r.st.defuser, null);
  }
  r.run(sec(1), [r.bot(1, 1.55), r.bot(2, 0, { y: r.sp.y + 1.9 })]);
  assert.equal(r.st.defuse, sec(1));
  // Defense side: the bots are attackers; io.bots never defuses.
  const cfg = { ...r.cfg, side: 'defense' };
  const st = core.roundCreate(cfg, TS);
  st.phase = 'planted'; st.plantTick = 1; st.spike.planted = { ...r.sp };
  for (let t = 2; t < 200; t++) core.roundStep(cfg, st, { tick: t, tickSec: TS, player: { x: 0, y: 0, z: 0, health: 100 }, kills: 0, hold: {}, bots: [r.bot(1)] });
  assert.equal(st.defuse, 0);
  assert.equal(st.defuser, null);
});

test('bot defuse election: the current defuser keeps it, else the lowest id; a switch or a stop drops to the checkpoint or 0', () => {
  const r = plantedRound();
  r.run(sec(1), [r.bot(5), r.bot(3)]);
  assert.equal(r.st.defuser, 3, 'lowest id');
  r.run(sec(1), [r.bot(5), r.bot(3), r.bot(1)]);
  assert.equal(r.st.defuser, 3, 'kept while it still defuses');
  assert.equal(r.st.defuse, sec(2));
  r.step([r.bot(5), r.bot(1)]);
  assert.equal(r.st.defuser, 1, 'switch to the lowest remaining');
  assert.equal(r.st.defuse, 1, 'before the checkpoint a switch starts over (this tick counts)');
  r.step([]);
  assert.equal(r.st.defuse, 0);
  assert.equal(r.st.defuser, null);
  // Past the checkpoint: the defuser dies, the next one starts from 3.5 s and needs 3.5 s more.
  r.run(sec(4), [r.bot(2)]);
  assert.ok(r.st.checkpoint);
  r.step([r.bot(2, 0.5, { alive: false }), r.bot(4, -0.5)]);
  assert.equal(r.st.defuser, 4);
  assert.equal(r.st.defuse, sec(3.5) + 1);
  r.step([r.bot(4, -0.5, { defusing: 0 })]);
  assert.equal(r.st.defuse, sec(3.5), 'a stop past the checkpoint keeps half');
  let ev = r.run(sec(3.5) - 1, [r.bot(4)]);
  assert.equal(r.st.phase, 'planted');
  ev = r.step([r.bot(4)]);
  assert.equal(ev[0].reason, 'defused');
  // Save/restore keeps the defuser (round state is JSON-cloned).
  assert.equal(core.roundClone(r.st).defuser, 4);
});

test('bot defuse, same tick: detonation beats it; a defuser killed on its last tick defuses nothing; defused beats eliminations', () => {
  // Finishing on the detonation tick: detonated.
  const a = plantedRound({ spikeSec: 7 });
  let ev = a.run(sec(7) - 1, [a.bot(1)]);
  assert.equal(a.st.phase, 'planted');
  ev = a.step([a.bot(1)]);
  assert.equal(ev[0].reason, 'detonated');
  assert.equal(ev[0].win, true);
  // Killed on the tick it would finish (the last bot alive, 5th kill): no defuse, attackers win.
  const b = plantedRound();
  b.run(sec(7) - 1, [b.bot(1)], 0);
  b.st.enemiesDead = 4;
  ev = b.step([b.bot(1, 0.5, { alive: false })], 1);
  assert.deepEqual(ev, [{ kind: 'roundEnd', winner: 'attack', reason: 'eliminated', win: true }]);
  // The defuse finishes on the tick the kill count reaches 5 (the defuser is alive in io.bots): defused.
  const c = plantedRound();
  c.run(sec(7) - 1, [c.bot(1)]);
  c.st.enemiesDead = 4;
  ev = c.step([c.bot(1)], 1);
  assert.equal(ev[0].reason, 'defused');
});

test('use key near your own spike (attack side) neither blocks your shots nor weapon pickup; pickup only blocked while holding', () => {
  const r = plantedRound();
  r.step([]);
  assert.equal(r.st.near, true, 'standing on the spike');
  assert.equal(core.roundNoFire(r.st, { use: true }, r.cfg, r.player), false);
  assert.equal(core.roundBlocksUse(r.st), false, 'planted phase: pickup works');
  // Defense side: the same key near the spike means defuse.
  const st = { ...r.st, side: 'defense' };
  assert.equal(core.roundNoFire(st, { use: true }, r.cfg, r.player), true);
  assert.equal(core.roundBlocksUse(st), true);
  assert.equal(core.roundBlocksUse({ ...st, near: false }), false);
  assert.equal(core.roundBlocksUse({ ...r.st, holding: 'plant' }), true);
  assert.equal(core.roundBlocksUse({ ...r.st, phase: 'barrier', near: false }), false);
});

test('blast: only on the detonation tick, only inside the radius', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.toSite(); r.run(sec(4), { hold: { plant: true } });
  r.run(sec(45) - 1);
  assert.equal(core.roundBlast(r.cfg, r.st, r.player), false);
  r.step();
  assert.equal(core.roundBlast(r.cfg, r.st, r.player), true);
  assert.equal(core.roundBlast(r.cfg, r.st, { x: r.player.x + 40, y: r.player.y, z: r.player.z }), false);
  r.step();
  assert.equal(core.roundBlast(r.cfg, r.st, r.player), false, 'once');
});

test('pause during a plant: no ticks, then the key is up -> the plant starts over', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.toSite();
  r.run(sec(3), { hold: { plant: true } });
  const before = r.st.plant;
  assert.ok(before > 0);
  // (pause: the sim is not stepped; held keys are cleared on blur / lost pointer lock)
  r.step({ hold: { plant: false } });
  assert.equal(r.st.plant, 0);
  assert.equal(r.st.phase, 'live');
});

test('save/restore copies the round state; restart starts a fresh round', () => {
  const r = makeRound({ barrierSec: 1 });
  r.run(sec(1)); r.toSite(); r.run(sec(4), { hold: { plant: true } });
  const saved = core.roundClone(r.st);
  r.run(sec(10));
  assert.notDeepEqual(r.st.tick, saved.tick);
  assert.equal(saved.phase, 'planted');
  saved.spike.planted.x += 1;
  assert.notEqual(saved.spike.planted.x, r.st.spike.planted.x, 'deep copy');
  const fresh = core.roundCreate(r.cfg, TS);
  assert.equal(fresh.phase, 'barrier');
  assert.equal(fresh.spike.carrier, 'player');
  assert.equal(fresh.spike.planted, null);
});

// ---------------------------------------------------------------- barriers
function sideOf(b, x, z) { return Math.sign((b.b.x - b.a.x) * (z - b.a.z) - (b.b.z - b.a.z) * (x - b.a.x)); }
test('barriers: crossing, sprinting, diagonal into the ends, wall hugging, jumping are all stopped', () => {
  const cfg = JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-20').doc).rules.round;
  const st = core.roundCreate(cfg, TS);
  for (const b of cfg.barriers.filter((q) => q.team === 'attack')) {
    const mx = (b.a.x + b.b.x) / 2, mz = (b.a.z + b.b.z) / 2, y = (b.y[0] + b.y[1]) / 2 - 1.5;
    const dx = b.b.x - b.a.x, dz = b.b.z - b.a.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
    // Straight through the middle: one big step and many small sprint steps.
    assert.ok(core.roundBlocksMove(cfg, st, mx + nx, mz + nz, mx - nx, mz - nz, y), `${b.id} big step`);
    for (const [label, start, dir, len] of [
      ['sprint', [mx + nx * 3, mz + nz * 3], [-nx, -nz], 6],
      ['diagonal to end a', [b.a.x + nx * 2 + ux, b.a.z + nz * 2 + uz], [-(nx + ux * 0.3), -(nz + uz * 0.3)], 5],
      ['diagonal to end b', [b.b.x + nx * 2 - ux, b.b.z + nz * 2 - uz], [-(nx - ux * 0.3), -(nz - uz * 0.3)], 5],
      ['hugging the barrier', [b.a.x + nx * 0.6 + ux * 0.5, b.a.z + nz * 0.6 + uz * 0.5], [ux - nx * 0.05, uz - nz * 0.05], L],
    ]) {
      for (const sgn of [1, -1]) {
        let x = start[0], z = start[1];
        if (sgn < 0) { x = 2 * mx - x; z = 2 * mz - z; } // same from the other side
        const s0 = sideOf(b, x, z);
        const dl = Math.hypot(dir[0], dir[1]), stepLen = 6.75 * TS;
        for (let i = 0; i < len / stepLen; i++) {
          const x1 = x + (dir[0] / dl) * stepLen * sgn, z1 = z + (dir[1] / dl) * stepLen * sgn;
          if (!core.roundBlocksMove(cfg, st, x, z, x1, z1, y)) { x = x1; z = z1; }
        }
        const along = ((x - b.a.x) * ux + (z - b.a.z) * uz) / L;
        if (along > 0 && along < 1) assert.equal(sideOf(b, x, z), s0, `${b.id} ${label} (${sgn > 0 ? 'front' : 'back'}) crossed`);
      }
    }
    // Jumping (feet up to 1.5 m above the floor) is still inside the wall's height.
    assert.ok(core.roundBlocksMove(cfg, st, mx + nx * 0.5, mz + nz * 0.5, mx - nx * 0.5, mz - nz * 0.5, b.y[0] + 0.5 + 1.5));
    // A different floor far above/below is not blocked; the other team's barriers never block us.
    assert.ok(!core.roundBlocksMove(cfg, st, mx + nx, mz + nz, mx - nx, mz - nz, b.y[1] + 3));
    // Walking along it is fine.
    assert.ok(!core.roundBlocksMove(cfg, st, mx + nx * 2, mz + nz * 2, mx + nx * 2 + ux, mz + nz * 2 + uz, y));
  }
  for (const b of cfg.barriers.filter((q) => q.team === 'defense')) {
    const mx = (b.a.x + b.b.x) / 2, mz = (b.a.z + b.b.z) / 2, nx = -(b.b.z - b.a.z), nz = b.b.x - b.a.x, L = Math.hypot(nx, nz);
    assert.ok(!core.roundBlocksMove(cfg, st, mx + nx / L, mz + nz / L, mx - nx / L, mz - nz / L, b.y[0] + 0.5), `${b.id} is the other team's`);
  }
  // After the drop nothing blocks.
  st.phase = 'live';
  const b = cfg.barriers.find((q) => q.team === 'attack');
  assert.ok(!core.roundBlocksMove(cfg, st, b.a.x, b.a.z - 1, b.b.x, b.b.z + 1, b.y[0] + 0.5));
});

// ---------------------------------------------------------------- patched game scripts
const CNR = read(JS[0], 'CnrSARj_.js'), OKA = read(JS[0], 'OkAdunfX.js'), CHJ = read(JS[0], 'ChJ6FlD4.js'), HWN = read(JS[0], 'Hwnlm6zD.js');

test('both copies of the patched scripts are identical (apart from line ends)', () => {
  for (const f of ['CnrSARj_.js', 'OkAdunfX.js', 'ChJ6FlD4.js', 'Hwnlm6zD.js']) assert.equal(read(JS[0], f), read(JS[1], f), f);
});

test('sim hooks are present and every one is guarded by the round state', () => {
  const imp = /import \{([^}]*)\} from "\/aim-rounds\/round-core\.mjs";/.exec(CNR);
  assert.ok(imp, 'round-core import');
  for (const pair of imp[1].split(',')) assert.equal(typeof core[pair.split(' as ')[0].trim()], 'function', pair);
  assert.ok(CNR.includes('A=A.rules?.round?aimRoundPrepare(A,g.seed??A.meta.seed):A;'));
  assert.ok(CNR.includes('let aimRd=aimRdCfg?aimRoundCreate(aimRdCfg,AA):null'));
  // Every call into round-core other than prep/create sits behind aimRd!==null.
  const calls = [...CNR.matchAll(/aimRound(Step|View|BlocksMove|Frozen|NoFire|BotsHold|BlocksUse)\(/g)];
  assert.ok(calls.length >= 7);
  for (const m of calls) {
    const before = CNR.slice(Math.max(0, m.index - 480), m.index);
    assert.ok(/aimRd!==null(&&|\?|\)\{|&&\()/.test(before) || /aimRd!==null&&\(aimRoundFrozen\(aimRd\)\|\|$/.test(before), `unguarded ${m[0]} near …${before.slice(-80)}`);
  }
  assert.ok(CNR.includes('saveState(){return aimRdSave(vP('));
  assert.ok(CNR.includes('restoreState(c){aimRd!==null&&c.aimRound&&(aimRd=aimRoundClone(c.aimRound))'));
  assert.ok(CNR.includes('snapshot(){return{round:aimRd!==null?aimRoundView(aimRdCfg,aimRd,AA):null,'));
  // Without a round, the save adds nothing.
  const aimRdSave = (s, r) => (r && (s.aimRound = 1), s);
  assert.deepEqual(aimRdSave({ tick: 1 }, null), { tick: 1 });
});

test('play page hooks: no replay, held keys, end via the round, visuals, results', async () => {
  for (const s of [
    "import {createRoundVisual as __aimRoundVisual} from '/aim-rounds/round-visual.mjs';",
    'Je=F.rules.round?null:h0(F,de,{',
    'window.__aimRoundOn&&de.setRoundHold?.({plant:se.aimHeldCode("Digit4"),use:se.aimHeld("use")});const Ze=de.step(je);',
    'return{aimHeld($){return re($)},aimHeldCode($){return o.has($)},get zoomLevel(){',
    'if(Ae.round){!St&&Ae.round.done&&(St=!0,Du(__aimRoundFinish(Ae.round)));return}const Xr=',
    'if(!St&&!Ae.round&&Ze.some(he=>he.kind==="playerFell")){',
    'threat:Bs,...__aimRoundOutcome()}',
    'function Tb(e,t){if(t.round)return __aimRoundHighlight(t.round);',
    'function Sb(e,t){if(t.round)return __aimRoundVerdict(t.round);',
    '__aimRoundStart(F,r.scene),',
    'function Hr(){__aimRoundStop(),',
    'for(const he of Ze)he.kind==="kill"&&!he.aimBlast&&(ge+=1);',
    "import {roundPrepare as __aimRoundPrepare} from '/aim-rounds/round-core.mjs';",
    'function To(F,Z=null){F=F?.rules?.round?__aimRoundPrepare(F,F.meta.seed):F;',
  ]) assert.ok(OKA.includes(s), s);
  // main.js still finds its two frame-loop strings.
  const main = read('app', 'main.js');
  for (const k of ['SHOT_LOOP_FROM', 'ROUTE_LOOP_FROM']) {
    const v = new RegExp(`const ${k} = ('[^']*'|"[^"]*");`).exec(main)[1];
    assert.ok(OKA.includes(eval(v)), k);
  }
  // The tail helpers: outcome mapping and texts.
  const tail = OKA.slice(OKA.indexOf('/* aim-round (tools/round_patch.py)'));
  const win = { __aimRoundText: null };
  const fns = new Function('window', `${tail};return{__aimRoundFinish,__aimRoundOutcome,__aimRoundText,__aimRoundHighlight,__aimRoundVerdict};`)(win);
  assert.equal(fns.__aimRoundOutcome().round, undefined);
  assert.equal(fns.__aimRoundFinish({ win: true, reason: 'detonated', side: 'attack', map: 'ascent' }), 'cleared');
  assert.deepEqual(fns.__aimRoundOutcome(), { round: { win: true, reason: 'detonated', side: 'attack', map: 'ascent' } });
  assert.equal(fns.__aimRoundFinish({ win: false, reason: 'timeout' }), 'time');
  assert.equal(fns.__aimRoundFinish({ win: false, reason: 'died' }), 'died');
  assert.equal(fns.__aimRoundFinish({ win: false, reason: 'defused' }), 'died');
  assert.equal(fns.__aimRoundText({ win: true, reason: 'eliminated' }), 'All enemies eliminated');
  assert.equal(fns.__aimRoundText({ win: false, reason: 'died' }), 'You died');
  assert.equal(fns.__aimRoundHighlight({ win: false, reason: 'timeout' }).title, 'Round lost');
  assert.ok(CHJ.includes('window.__aimLaunchScene=function(o){') && CHJ.includes('Qa(o.shareCode,"plaza");return!0};'));
  assert.ok(HWN.includes("function Wo(cb){if(cb&&cb.round)return{"));
  const vis = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-visual.mjs')).href);
  assert.equal(typeof vis.createRoundVisual, 'function');
});

test('round_patch.py refuses to run twice', { skip: !process.env.PATH && 'no PATH' }, () => {
  let out = '';
  try { execFileSync('python', ['-I', path.join(root, 'tools', 'round_patch.py')], { stdio: 'pipe' }); } catch (e) { out = String(e.stderr || '') + String(e.stdout || ''); }
  assert.match(out, /already patched/);
});

test('round visuals build, update and dispose with three.js-like classes', async () => {
  const { createRoundVisual } = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-visual.mjs')).href);
  class V3 { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { Object.assign(this, { x, y, z }); return this; } copy(o) { return this.set(o.x, o.y, o.z); } setScalar(s) { return this.set(s, s, s); } }
  class Obj { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.scale = new V3(); this.visible = true; } add(...c) { this.children.push(...c); } remove(c) { this.children = this.children.filter((x) => x !== c); } updateMatrixWorld() {} }
  let disposed = 0;
  class G { dispose() { disposed++; } }
  const THREE = { Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }, Group: Obj, PlaneGeometry: G, SphereGeometry: G, BoxGeometry: G, CylinderGeometry: G, MeshBasicMaterial: class extends G { constructor(o) { super(); Object.assign(this, o); } }, DoubleSide: 2 };
  const scene = new Obj();
  const cfg = JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-20').doc).rules.round;
  const v = createRoundVisual(THREE, scene, cfg);
  assert.equal(scene.children.length, 1);
  const r = scene.children[0];
  v.update({ phase: 'barrier', spike: { carrier: 'player' } }, 0);
  assert.equal(r.children[0].visible, true);
  v.update({ phase: 'planted', timeLeft: 30, spike: { planted: { x: 1, y: 2, z: 3 } } }, 1.1);
  assert.equal(r.children[0].visible, false);
  assert.equal(r.children[1].visible, true);
  v.update({ phase: 'ended', reason: 'detonated', spike: { planted: { x: 1, y: 2, z: 3 } } }, 2);
  v.update({ phase: 'ended', reason: 'detonated', spike: { planted: { x: 1, y: 2, z: 3 } } }, 2.5);
  v.dispose();
  assert.equal(scene.children.length, 0);
  assert.ok(disposed > 10);
});

test('shell files are wired into main.js and the build', () => {
  const main = read('app', 'main.js');
  assert.match(main, /\["ROUND PANEL", ROUND_PANEL_JS\]/);
  assert.match(main, /\["ROUND HUD", ROUND_HUD_JS\]/);
  assert.match(main, /trainingSet\.scenes\[code\] \|\| rounds\.roundScene\(MODS, code\)/);
  const pkg = JSON.parse(read('app', 'package.json'));
  for (const f of ['round-panel.js', 'round-hud.js', 'round-scene.js']) assert.ok(pkg.build.files.includes(f), f);
  assert.ok(pkg.build.extraResources.some((e) => e.from === 'mods'), 'mods (aim-rounds) ship as extra resources');
  assert.match(read('app', 'lobby-bar.js'), /Round \(beta\)/);
});

// ---------------------------------------------------------------- R3 S2: attack plan, bot carrier / drop / pickup / plant (defense side)
// Pure node: hand-built io.bots ({id, spawnerId, alive, x, y, z, defusing, planting}); the real bots
// publish spawnerId / planting from R3 step S3 on.
const { createHash } = await import('node:crypto');
const SPAWNERS = ['round-spawn-1', 'round-spawn-2', 'round-spawn-3', 'round-spawn-4', 'round-spawn-5'];
const defDoc = (attackData = null) => {
  const d = buildDoc(data, { side: 'defense', weapon: 'vandal', barrierSec: 20 });
  if (attackData) d.rules.round.attackData = attackData;
  else delete d.rules.round.attackData; // buildDoc adds the map's attack data on the defense side (R3 S3)
  return d;
};
// sha256 (first 16 hex) of JSON.stringify(roundPrepare(doc, seed)), seeds 1..20, computed on 1d040e8
// (before R3): the attack doc of round-ascent-attack-vandal-20, and the defense doc (buildDoc) with
// rules.round.attack and rules.round.attackData deleted.
const FROZEN_PREPARE = {
  attack: ['0a7382415e8b8a27', '326759ed4bd2eb0a', '5a2c67e679348198', 'c030352a142aea93', '4a06ddaff7f86fc0', '5fefcbe7368622cc', '8b24c23f07728e9b', 'ddcd183327472202', '7bba2c922402d7b8', '516b69d97a093379',
    'efa2ea8a29bc972b', '6c2a5ea308e9b3ea', 'afd8212ffdda8975', 'd158e63b3d4d4271', 'c82104713f0e0502', '634b7ccfbe80a8f3', 'eeb122c2822d1afd', 'd2dbfd1bba6e01fe', '7c4792e5510d9027', '931406121cac768e'],
  defense: ['238952ef37dc2568', '44410f22d07cab0c', 'c4ec0a789ce91868', 'f4e2722f52eb70fe', 'f4e2722f52eb70fe', '7c3bbebd448b44af', 'c4ec0a789ce91868', '44410f22d07cab0c', '44410f22d07cab0c', '7c3bbebd448b44af',
    'f4e2722f52eb70fe', '7c3bbebd448b44af', '44410f22d07cab0c', '238952ef37dc2568', '7c3bbebd448b44af', '7c3bbebd448b44af', 'f4e2722f52eb70fe', '238952ef37dc2568', 'f4e2722f52eb70fe', '44410f22d07cab0c'],
};
const PLANT_A = data.attack.plant.A[0]; // in zone A, 1 m+ from its edge
const OFF_SITE = { x: -60, y: 4, z: -60 };  // A Main, outside every zone
// 5 attacker bots, ids 1..5 in spawner order, at the attacker spawn; over[id] overrides fields.
const atkBots = (cfg, over = {}) => SPAWNERS.map((s, k) => {
  const p = cfg.spawns.attack[k];
  return { id: k + 1, spawnerId: s, alive: true, x: p.x, y: p.y, z: p.z, defusing: 0, planting: 0, ...(over[k + 1] || {}) };
});
const at = (p, o = {}) => ({ x: p.x, y: p.y, z: p.z, ...o });
function makeDefense({ seed = 1, attackData = data.attack, over = {} } = {}) {
  const doc = core.roundPrepare(defDoc(attackData), seed);
  const cfg = { ...doc.rules.round, ...over };
  const st = core.roundCreate(cfg, TS);
  const ps = cfg.spawns.defense[0];
  const player = { x: ps.x, y: ps.y, z: ps.z, yaw: 0, speed: 0, grounded: true, health: 100 };
  const r = { doc, cfg, st, player, tick: 0 };
  r.step = (bots, { kills = 0, hold = {} } = {}) => {
    const ev = core.roundStep(cfg, r.st, { tick: ++r.tick, tickSec: TS, player: { ...player }, kills, hold, bots });
    assert.notEqual(typeof core.roundView(cfg, r.st, TS).spike.carrier, 'number', 'the view never shows which bot carries the spike');
    return ev;
  };
  r.run = (n, bots, o) => { let ev = []; for (let i = 0; i < n; i++) ev = ev.concat(r.step(typeof bots === 'function' ? bots(i) : bots, o)); return ev; };
  r.toLive = (bots) => r.run(sec(20) - r.tick, bots);
  return r;
}
const dview = (r) => core.roundView(r.cfg, r.st, TS);
// A seed whose planned carrier is not round-spawn-1 (so it has a higher id than bot 1).
const SEED = Array.from({ length: 50 }, (_, i) => i + 1).find((s) => core.roundPrepare(defDoc(data.attack), s).rules.round.attack.carrierSpawner !== 'round-spawn-1');
const carrierId = (r) => SPAWNERS.indexOf(r.cfg.attack.carrierSpawner) + 1;

test('R3 roundPrepare: attack side, defense spawns and spawners byte-identical to before (seeds 1-20); attack data adds no draws', () => {
  const atk = JSON.parse(roundScene(MODS, 'round-ascent-attack-vandal-20').doc);
  const h = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
  for (let s = 1; s <= 20; s++) {
    const a = core.roundPrepare(atk, s);
    assert.equal(h(a), FROZEN_PREPARE.attack[s - 1], `attack seed ${s}`);
    assert.equal('attack' in a.rules.round, false, 'no plan on the attack side');
    const d = core.roundPrepare(defDoc(), s);
    assert.ok(d.rules.round.attack, 'defense side has a plan');
    delete d.rules.round.attack;
    delete d.rules.round.attackData;
    assert.equal(h(d), FROZEN_PREPARE.defense[s - 1], `defense seed ${s}`);
    const w = core.roundPrepare(defDoc(data.attack), s);
    assert.deepEqual(w.playerSpawn, d.playerSpawn, 'attackData does not move the player spawn');
    assert.deepEqual(w.spawners, d.spawners, 'attackData does not change the spawners');
  }
});

test('R3 attack plan: site, carrier spawner, routes, lurker, gather time; deterministic; same draws without attackData', () => {
  const sites = new Set(); let lurk = 0, noLurk = 0;
  for (let s = 1; s <= 60; s++) {
    const a = core.roundPrepare(defDoc(data.attack), s).rules.round.attack;
    assert.deepEqual(core.roundPrepare(defDoc(data.attack), s).rules.round.attack, a, 'same seed, same plan');
    assert.ok(['A', 'B'].includes(a.site)); sites.add(a.site);
    assert.ok(SPAWNERS.includes(a.carrierSpawner));
    assert.deepEqual(Object.keys(a.routeBySpawner).sort(), SPAWNERS);
    const names = data.attack.routes[a.site].map((q) => q.name), main = a.routeBySpawner[a.carrierSpawner];
    assert.ok(names.includes(main), 'carrier on one of the site routes');
    for (const id of SPAWNERS) assert.equal(a.routeBySpawner[id], id === a.lurker ? names.find((n) => n !== main) : main, `${id} route`);
    if (a.lurker === null) noLurk++; else { lurk++; assert.ok(SPAWNERS.includes(a.lurker) && a.lurker !== a.carrierSpawner, 'lurker is a non-carrier'); }
    assert.ok(a.gatherSec >= 5 && a.gatherSec <= 20, `gatherSec ${a.gatherSec}`);
    const b = core.roundPrepare(defDoc(), s).rules.round.attack;
    assert.deepEqual({ ...b, routeBySpawner: null }, { ...a, routeBySpawner: null }, 'without attackData: same site / carrier / lurker / gather');
    assert.ok(Object.values(b.routeBySpawner).every((v) => v === null), 'no routes without attackData');
  }
  assert.equal(sites.size, 2, 'both sites get picked');
  assert.ok(lurk > 0 && noLurk > 0, `lurker sometimes (${lurk} of 60)`);
  // prepared docs pass through unchanged
  const p = core.roundPrepare(defDoc(data.attack), 3);
  assert.equal(core.roundPrepare(p, 9), p);
});

test('R3 bot carrier election: the planned spawner beats a lower id; else the lowest living id once all spawned or live', () => {
  const r = makeDefense({ seed: SEED }), c = carrierId(r), all = atkBots(r.cfg);
  assert.ok(c > 1);
  assert.equal(r.st.spike.carrier, null, 'no carrier before the bots exist');
  r.step(all.filter((b) => b.id !== c).slice(0, 2));
  assert.equal(r.st.spike.carrier, null, 'barrier phase, planned carrier not spawned yet, not all spawned: wait');
  r.step(all);
  assert.equal(r.st.spike.carrier, c, 'planned carrier beats a lower id');
  assert.deepEqual(r.st.carrierAt, at(all[c - 1]));
  const v = dview(r);
  assert.equal(v.spike.carrier, null); assert.equal(v.carrying, false); assert.equal('carrierAt' in v, false);
  // keeps it while alive (election doesn't re-run)
  r.run(10, atkBots(r.cfg, { 1: { x: all[0].x + 0.1 } }));
  assert.equal(r.st.spike.carrier, c);

  // the planned carrier is dead when the bots spawn: lowest living id (bot 1 dead too -> 2, unless 2 is planned)
  const r2 = makeDefense({ seed: SEED });
  r2.step(atkBots(r2.cfg, { [c]: { alive: false }, 1: { alive: false } }));
  assert.equal(r2.st.spike.carrier, c === 2 ? 3 : 2);

  // the planned carrier never spawns: 4 bots wait through the barrier phase, then the lowest at live
  const r3 = makeDefense({ seed: SEED }), four = all.filter((b) => b.id !== c);
  r3.run(sec(20) - 1, four);
  assert.equal(r3.st.spike.carrier, null);
  r3.step(four);
  assert.equal(r3.st.phase, 'live');
  assert.equal(r3.st.spike.carrier, 1);
  // elected on the live tick while already planting on site: counts from the next tick
  const onSite = four.map((b) => (b.id === 1 ? { ...b, ...at(PLANT_A), planting: 1 } : b));
  const r5 = makeDefense({ seed: SEED });
  r5.run(sec(20) - 1, four);
  r5.step(onSite);
  assert.equal(r5.st.spike.carrier, 1); assert.equal(r5.st.botPlant, 0, 'not on the election tick');
  r5.step(onSite);
  assert.equal(r5.st.botPlant, 1, 'from the next tick');

  // no plan (cfg.attack missing): lowest living id once all 5 are in io.bots
  const r4 = makeDefense({ seed: SEED, over: { attack: undefined } });
  r4.step(all.slice(1));
  assert.equal(r4.st.spike.carrier, null);
  r4.step(all);
  assert.equal(r4.st.spike.carrier, 1);
});

// A live defense round whose carrier stands on the A plant spot.
function carrierOnSite(seed = SEED) {
  const r = makeDefense({ seed }), c = carrierId(r);
  r.toLive(atkBots(r.cfg));
  assert.equal(r.st.phase, 'live'); assert.equal(r.st.spike.carrier, c);
  r.bots = (o = {}, others = {}) => atkBots(r.cfg, { ...others, [c]: { ...at(PLANT_A), planting: 1, ...o } });
  return { r, c };
}

test('R3 bot plant: counts only live, alive, planting = 1, in a zone; 4 s plants at the bot, roundPlant (bot), carrier cleared', () => {
  const r = makeDefense({ seed: SEED }), c = carrierId(r);
  // barrier phase: planting in the zone does nothing
  r.run(sec(1), atkBots(r.cfg, { [c]: { ...at(PLANT_A), planting: 1 } }));
  assert.equal(r.st.botPlant, 0);
  r.toLive(atkBots(r.cfg));
  const bots = (o) => atkBots(r.cfg, { [c]: { ...at(PLANT_A), planting: 1, ...o } });
  r.run(10, bots({ planting: 0 }));
  assert.equal(r.st.botPlant, 0, 'not while planting = 0');
  r.run(10, bots({ planting: undefined }));
  assert.equal(r.st.botPlant, 0, 'a bot without the planting field never plants');
  r.run(10, bots({ ...at(OFF_SITE) }));
  assert.equal(r.st.botPlant, 0, 'not outside a zone');
  r.run(10, atkBots(r.cfg, { [c === 1 ? 2 : 1]: { ...at(PLANT_A), planting: 1 } }));
  assert.equal(r.st.botPlant, 0, 'a non-carrier planting does nothing');
  r.run(sec(1), bots());
  assert.equal(r.st.botPlant, sec(1));
  let v = dview(r);
  assert.equal(v.botPlanting, true); assert.equal(v.plant, 0, 'view.plant stays the player\'s'); assert.equal(v.holding, null);
  r.step(bots({ ...at(OFF_SITE) }));
  assert.equal(r.st.botPlant, 0, 'leaving the zone resets it');
  assert.equal(dview(r).botPlanting, false);
  const ev = r.run(sec(4) - 1, bots());
  assert.equal(r.st.phase, 'live');
  const last = r.step(bots({ x: PLANT_A.x + 0.2 }));
  assert.deepEqual([...ev, ...last].filter((e) => e.kind === 'roundPlant'), [{ kind: 'roundPlant', site: 'A', bot: true }]);
  assert.equal(r.st.phase, 'planted'); assert.equal(r.st.plantTick, r.tick);
  assert.deepEqual(r.st.spike.planted, { x: PLANT_A.x + 0.2, y: PLANT_A.y, z: PLANT_A.z, site: 'A' });
  assert.equal(r.st.spike.carrier, null); assert.equal(r.st.carrierAt, null); assert.equal(r.st.botPlant, 0);
  v = dview(r);
  assert.equal(v.botPlanting, false); assert.equal(v.phase, 'planted');
  assert.deepEqual(v.spike, { carrier: null, dropped: null, planted: r.st.spike.planted });
  // no second plant, no re-election after the plant
  r.run(10, bots());
  assert.equal(r.st.spike.carrier, null); assert.equal(r.st.botPlant, 0);
});

test('S4 enemy plant sound: plantCue {pan, gain} only while a bot plant counts within 30 m of the living player; pan follows the player\'s yaw; no position in the view; save/restore', () => {
  const { r, c } = carrierOnSite();
  const cue = () => dview(r).plantCue;
  // Player 10 m from the plant spot (east of it, +x), facing -z (yaw 0): the planter is to the left.
  Object.assign(r.player, { x: PLANT_A.x + 10, y: PLANT_A.y, z: PLANT_A.z, yaw: 0 });
  r.step(r.bots({ planting: 0 }));
  assert.equal(cue(), null, 'no plant counting -> no cue');
  r.step(r.bots());
  assert.ok(r.st.botPlant > 0);
  assert.deepEqual(cue(), { pan: -1, gain: 0.7 }, 'planter 10 m to the left');
  // Facing +z (yaw pi): the same planter is now on the right.
  r.player.yaw = Math.PI; r.step(r.bots());
  assert.deepEqual(cue(), { pan: 1, gain: 0.7 }, 'yaw pi: on the right');
  // Planter to the player's right at yaw pi/2 (forward -x, right -z).
  Object.assign(r.player, { x: PLANT_A.x, z: PLANT_A.z + 20, yaw: Math.PI / 2 }); r.step(r.bots());
  assert.deepEqual(cue(), { pan: 1, gain: 0.3 }, 'yaw pi/2, planter 20 m on -z: right');
  // Straight ahead, quantised: 0.25 steps, 0.1 gain steps, at least 0.1.
  Object.assign(r.player, { x: PLANT_A.x, z: PLANT_A.z + 29.9, yaw: 0 }); r.step(r.bots());
  assert.deepEqual(cue(), { pan: 0, gain: 0.1 }, 'ahead, near the edge');
  for (let k = 0; k < 40; k++) {
    Object.assign(r.player, { x: PLANT_A.x + Math.cos(k) * (2 + k * 0.6), z: PLANT_A.z + Math.sin(k) * (2 + k * 0.6), yaw: k * 0.37 }); r.step(r.bots());
    const q = cue();
    if (q === null) { assert.ok(Math.hypot(r.player.x - PLANT_A.x, r.player.z - PLANT_A.z) > 30, `k ${k}: null only beyond 30 m`); continue; }
    assert.deepEqual(Object.keys(q).sort(), ['gain', 'pan'], 'no position keys');
    assert.equal(q.pan * 4, Math.round(q.pan * 4)); assert.ok(q.pan >= -1 && q.pan <= 1);
    assert.equal(Math.round(q.gain * 10) / 10, q.gain); assert.ok(q.gain >= 0.1 && q.gain <= 1);
  }
  // Beyond 30 m (3D): null.
  Object.assign(r.player, { x: PLANT_A.x + 30.5, z: PLANT_A.z, yaw: 0 }); r.step(r.bots());
  assert.equal(cue(), null, 'beyond 30 m');
  // Save -> step -> restore keeps it (plain JSON state).
  Object.assign(r.player, { x: PLANT_A.x + 5, z: PLANT_A.z }); r.step(r.bots());
  const saved = core.roundClone(r.st), want = cue();
  assert.ok(want);
  r.st = core.roundClone(saved);
  assert.deepEqual(cue(), want, 'restored');
  // Dead player: null (the round ends: the player is the only defender).
  r.step(r.bots(), {}); r.player.health = 0; r.step(r.bots());
  assert.equal(cue(), null, 'dead player / round over');
  // The view never names the carrier, carrierAt stays out of it.
  assert.equal('carrierAt' in dview(r), false);
  assert.equal(c > 0, true);
});

test('S4 plantCue: never on the attack side, never in the barrier phase, cleared by the plant; useHeld mirrors the use key', () => {
  // Attack side: the player plants; useHeld still mirrors the key, no cue.
  const a = makeRound();
  a.run(sec(21));
  a.step({ hold: { use: true } });
  assert.equal(view(a).plantCue, null); assert.equal(view(a).useHeld, true);
  a.step({ hold: {} });
  assert.equal(view(a).useHeld, false);
  // Barrier phase on defense: a planting carrier nearby gives no cue.
  const r = makeDefense({ seed: SEED }), c = carrierId(r);
  Object.assign(r.player, { x: PLANT_A.x + 3, y: PLANT_A.y, z: PLANT_A.z });
  r.run(sec(1), atkBots(r.cfg, { [c]: { ...at(PLANT_A), planting: 1 } }));
  assert.equal(dview(r).plantCue, null, 'barrier');
  r.step(atkBots(r.cfg), { hold: { use: true } });
  assert.equal(dview(r).useHeld, true, 'useHeld on defense');
  r.toLive(atkBots(r.cfg));
  const bots = atkBots(r.cfg, { [c]: { ...at(PLANT_A), planting: 1 } });
  r.run(sec(4) - 1, bots);
  assert.ok(dview(r).plantCue, 'cue while planting');
  r.step(bots);
  assert.equal(r.st.phase, 'planted');
  assert.equal(dview(r).plantCue, null, 'cleared on the plant tick');
});

test('R3 carrier death drops the spike at its io.bots position and resets the plant; a missing carrier drops at carrierAt', () => {
  const { r, c } = carrierOnSite();
  r.run(sec(2), r.bots());
  assert.equal(r.st.botPlant, sec(2));
  r.step(r.bots({ alive: false, x: PLANT_A.x + 0.3 }), { kills: 1 });
  assert.equal(r.st.spike.carrier, null);
  assert.deepEqual(r.st.spike.dropped, { x: PLANT_A.x + 0.3, y: PLANT_A.y, z: PLANT_A.z });
  assert.equal(r.st.botPlant, 0); assert.equal(r.st.carrierAt, null);
  assert.equal(dview(r).botPlanting, false);
  assert.deepEqual(dview(r).spike.dropped, r.st.spike.dropped);

  const m = carrierOnSite().r;
  m.run(5, m.bots({ x: PLANT_A.x - 0.4 }));
  assert.deepEqual(m.st.carrierAt, at(PLANT_A, { x: PLANT_A.x - 0.4 }), 'carrierAt follows the live carrier');
  m.step(atkBots(m.cfg).filter((b) => b.id !== c));
  assert.deepEqual(m.st.spike.dropped, at(PLANT_A, { x: PLANT_A.x - 0.4 }), 'missing from io.bots: dropped at carrierAt');
  assert.equal(m.st.spike.carrier, null);
});

test('R3 pickup: lowest living id within pickupRadius (xz) and |dy| < 2; on the drop tick too; the new carrier plants from the next tick', () => {
  const { r, c } = carrierOnSite();
  const d = { x: PLANT_A.x, y: PLANT_A.y, z: PLANT_A.z };
  r.step(r.bots({ alive: false }), { kills: 1 });
  assert.deepEqual(r.st.spike.dropped, d);
  const others = SPAWNERS.map((_, k) => k + 1).filter((id) => id !== c);   // 4 living bots, ascending
  const [a, b, e, f] = others;
  const near = {
    [c]: { ...at(d), alive: false },                              // dead, right on it
    [a]: { ...at(d, { x: d.x + 1.6 }) },                          // 1.6 m: outside
    [b]: { ...at(d, { x: d.x + 0.3, y: d.y + 2.2 }) },            // |dy| >= 2
    [e]: { ...at(d, { x: d.x + 1.0, z: d.z + 1.0 }) },            // 1.41 m: inside
    [f]: { ...at(d, { x: d.x - 0.5 }) },                          // 0.5 m: inside
  };
  r.step(atkBots(r.cfg, near));
  assert.equal(r.st.spike.carrier, e, 'lowest id inside the radius');
  assert.equal(r.st.spike.dropped, null);
  assert.deepEqual(r.st.carrierAt, at(near[e]));
  assert.equal(r.st.botPlant, 0);

  // pickup on the drop tick; the new carrier's planting counts from the next tick
  const q = carrierOnSite();
  q.r.run(sec(1), q.r.bots());
  const n = q.c === 1 ? 2 : 1;
  q.r.step(q.r.bots({ alive: false }, { [n]: { ...at(PLANT_A, { x: PLANT_A.x + 0.5 }), planting: 1 } }), { kills: 1 });
  assert.equal(q.r.st.spike.carrier, n, 'picked up on the drop tick');
  assert.equal(q.r.st.spike.dropped, null);
  assert.equal(q.r.st.botPlant, 0, 'not on the pickup tick');
  q.r.step(q.r.bots({ alive: false }, { [n]: { ...at(PLANT_A, { x: PLANT_A.x + 0.5 }), planting: 1 } }));
  assert.equal(q.r.st.botPlant, 1, 'from the next tick');
});

test('R3 same tick: a bot plant on the timeout tick counts; a planter killed on its last tick plants nothing; plant + player death = died', () => {
  // timeout tick
  const t = carrierOnSite();
  t.r.run(sec(100) - sec(4), t.r.bots({ planting: 0 }));
  assert.equal(t.r.st.phase, 'live');
  const ev = t.r.run(sec(4), t.r.bots());
  assert.equal(t.r.tick - t.r.st.liveTick, sec(100), 'the plant finished on the round timer\'s last tick');
  assert.equal(t.r.st.phase, 'planted');
  assert.equal(ev.some((e) => e.kind === 'roundEnd'), false, 'no timeout');

  // killed on the finishing tick
  const k = carrierOnSite();
  k.r.run(sec(4) - 1, k.r.bots());
  const ev2 = k.r.step(k.r.bots({ alive: false }), { kills: 1 });
  assert.equal(ev2.some((e) => e.kind === 'roundPlant'), false);
  assert.equal(k.r.st.phase, 'live');
  assert.deepEqual(k.r.st.spike.dropped, at(PLANT_A));

  // the plant completes on the tick the player dies
  const p = carrierOnSite();
  p.r.run(sec(4) - 1, p.r.bots());
  p.r.player.health = 0;
  const ev3 = p.r.step(p.r.bots());
  assert.deepEqual(ev3.map((e) => e.kind), ['roundPlant', 'roundEnd']);
  assert.equal(p.r.st.winner, 'attack'); assert.equal(p.r.st.reason, 'died');
});

test('R3 the defending player defuses a bot plant (from the next tick), ROUND WON "defused"', () => {
  const { r } = carrierOnSite();
  r.run(sec(4), r.bots());
  assert.equal(r.st.phase, 'planted');
  Object.assign(r.player, { x: PLANT_A.x + 0.3, y: PLANT_A.y, z: PLANT_A.z });
  const ev = r.run(sec(7), r.bots({ planting: 0 }), { hold: { use: true } });
  assert.equal(r.st.phase, 'ended');
  assert.equal(r.st.winner, 'defense'); assert.equal(r.st.reason, 'defused');
  assert.deepEqual(ev.filter((e) => e.kind === 'roundEnd'), [{ kind: 'roundEnd', winner: 'defense', reason: 'defused', win: true }]);
});

test('R3 attack side ignores spawnerId / planting in io.bots', () => {
  const r = makeRound();
  const bots = (cfg) => atkBots(cfg, { 1: { ...at(PLANT_A), planting: 1 }, 2: { ...at(PLANT_A), planting: 1, spawnerId: 'round-A-1' } });
  let tick = 0;
  for (let i = 0; i < sec(20) + sec(5); i++) core.roundStep(r.cfg, r.st, { tick: ++tick, tickSec: TS, player: { ...r.player }, kills: 0, hold: {}, bots: bots(r.cfg) });
  assert.equal(r.st.phase, 'live');
  assert.equal(r.st.spike.carrier, 'player');
  assert.equal(r.st.botPlant, 0); assert.equal(r.st.carrierAt, null);
  assert.equal(core.roundView(r.cfg, r.st, TS).spike.carrier, 'player');
});

test('R3 save -> step -> restore mid-plant (carrierAt set) matches a straight run', () => {
  const ioAt = (r, i) => ({ bots: i === 40 ? r.bots({ alive: false }) : i > 40 ? atkBots(r.cfg, { [carrierId(r)]: { alive: false }, [carrierId(r) === 1 ? 2 : 1]: { ...at(PLANT_A), planting: 1 } }) : r.bots() });
  const a = carrierOnSite().r, b = carrierOnSite().r;
  a.run(sec(1), a.bots()); b.run(sec(1), b.bots());
  assert.ok(b.st.carrierAt && b.st.botPlant > 0);
  for (let i = 0; i < 80; i++) {
    a.step(ioAt(a, i).bots, { kills: i === 40 ? 1 : 0 });
    if (i % 7 === 3) {
      const saved = core.roundClone(b.st), t0 = b.tick;
      b.step(atkBots(b.cfg, { [carrierId(b)]: { alive: false } }), { kills: 1 });   // a different future
      b.st = saved; b.tick = t0;
    }
    b.step(ioAt(b, i).bots, { kills: i === 40 ? 1 : 0 });
    assert.deepEqual(b.st, a.st, `tick ${i}`);
  }
  assert.ok(a.st.spike.carrier !== null && a.st.botPlant > 0, 'dropped, picked up, planting again');
});

// ---------------------------------------------------------------- R4: every map with round data
// Each app/mods/aim-rounds/<map>.json builds a round scene (round-<map>-attack-…) that roundPrepare
// accepts: groups and splits match, 5 bots kept on the defender spawns, the scene validator passes.
// (The defense-side code is not enabled yet; scripts/test-round-nav.mjs checks the map data itself.)
test('R4 every map with round data builds a round scene that roundPrepare and the validator accept', async () => {
  const maps = fs.readdirSync(path.join(MODS, 'aim-rounds')).filter((f) => /^[a-z0-9]+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
  assert.ok(maps.includes('ascent') && maps.includes('rook'), `maps: ${maps}`);
  let validate = null, tmp = null;
  if (fs.existsSync(path.join(root, JS[0], 'D_iGclxB.js'))) {
    const src = read(JS[0], 'D_iGclxB.js').replace(/^import \{mapIds as localMapIds\} from "\/local\/map-registry\.mjs";/m, `const localMapIds=${JSON.stringify(maps)};`);
    tmp = path.join(os.tmpdir(), `aim-round-validator-maps-${process.pid}.mjs`);
    fs.writeFileSync(tmp, src);
    ({ p: validate } = await import(pathToFileURL(tmp).href));
  }
  try {
    for (const map of maps) {
      const md = JSON.parse(read('app', 'mods', 'aim-rounds', `${map}.json`));
      assert.equal(md.schema, 1); assert.equal(md.map, map);
      const env = roundScene(MODS, `round-${map}-attack-vandal-20`);
      assert.ok(env, `round-${map}-attack-vandal-20 resolves`);
      const doc = JSON.parse(env.doc), r = doc.rules.round;
      assert.equal(doc.environment.map, map);
      assert.equal(r.map, map);
      assert.deepEqual(r.sites.map((s) => s.id), md.sites.map((s) => s.id));
      for (const team of ['attack', 'defense']) assert.equal(r.spawns[team].length, 5, `${map} ${team} spawns`);
      const groups = Object.keys(r.setups.groups);
      assert.deepEqual(groups, Object.keys(md.setups.defense));
      assert.ok(r.setups.splits.length > 0);
      for (const sp of r.setups.splits) { assert.equal(sp.length, groups.length, `${map} split ${sp}`); assert.equal(sp.reduce((a, b) => a + b, 0), 5, `${map} split ${sp}`); }
      if (md.retake) assert.deepEqual(Object.keys(r.retake).sort(), md.sites.map((s) => s.id).sort());
      const groupOf = (id) => groups.find((g) => r.setups.groups[g].includes(id));
      for (const seed of [1, 2, 3, 99]) {
        const p = core.roundPrepare(doc, seed);
        assert.equal(p.spawners.length, 5, `${map} seed ${seed}`);
        const split = groups.map((g) => p.spawners.filter((s) => groupOf(s.id) === g).length);
        assert.ok(r.setups.splits.some((s) => s.join() === split.join()), `${map} seed ${seed}: split ${split}`);
        const at = p.spawners.map((s) => md.spawns.defense.findIndex((q) => q.x === s.position.x && q.y === s.position.y && q.z === s.position.z));
        assert.deepEqual([...at].sort(), [0, 1, 2, 3, 4], `${map} seed ${seed}: bots on the defender spawns`);
        if (validate) validate(JSON.stringify(p));
      }
      if (validate) validate(env.doc);
    }
  } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
});
