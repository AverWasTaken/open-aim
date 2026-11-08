// The six "*-peekers" map drills (scenarios/*-peekers.json, made by tools/peek_cover.mjs): bots start
// hidden on a cover point next to their spot and peek out, instead of standing in the open.
// Checked with the real map collision (tools/round_terrain.mjs) passed into the real patched sim:
//  - the scenario files and their spot-score entries are up to date with tools/peek_cover.mjs
//    (tools/data/peek-viewpoints.json); shareCode / meta.id / seed / rules unchanged;
//  - every pool spawner sits on its path's first point (cover), size 0, path loop, no strafe; a spot
//    restored to the original strafe keeps the original spawner + actor-1; every bot moves (a path with
//    >= 2 distinct waypoints, or strafe) and no unengaged bot stands still longer than its longest pause;
//  - in the sim every bot is born hidden from its spot's reference viewpoints (first-sight point on
//    the planner route + route samples; the tool's partial/no-cover spots as reported), and a bot with
//    cover is visible from the first-sight point within a few seconds;
//  - a refill after a kill comes from cover again; same seed = same run;
//  - share of an unengaged loop a covered bot spends hidden from its first-sight point (printed).
// Terrain decoding is CPU heavy the first time (cached in the OS temp folder): run on hp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js'));
const PC = await import(pathToFileURL(path.join(root, 'tools', 'peek_cover.mjs')).href);
const { loadTerrain, terrainSources } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
const DATA = PC.readData(root);
const haveMaps = PC.STEMS.every((s) => terrainSources(DATA.drills[s].map, root));
const skip = (!HAVE_SITE && 'no game files in site/') || (!haveMaps && 'no map files');

let sim = null;
if (!skip) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(path.join(root, 'app', 'mods', 'next', 'js', 'CnrSARj_.js')).href);
}

const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
const RAD_PER_COUNT = (0.07 * Math.PI) / 180;
const terrains = new Map();
const terrainOf = async (map) => {
  if (!terrains.has(map)) terrains.set(map, await loadTerrain(map, { root }));
  return terrains.get(map);
};
const simTerrain = (T) => ({ pawn: T.pawn, projectile: T.projectile, projectileVolumeStart: T.projectileVolumeStart });
const createSim = (doc, T, seed, extra = {}) => sim.c(structuredClone(doc), { sensitivity: 1, zoomSensitivity: 1, seed, terrain: simTerrain(T), ...extra });

let results = null;
const generated = async () => (results ??= await PC.generate({ root, terrain: terrainOf }));

test('scenario files + spot scores are up to date with tools/peek_cover.mjs; ids, seed, rules kept', { skip }, async () => {
  const res = await generated();
  const key = PC.aimSpotKeyFn(root);
  const scores = JSON.parse(fs.readFileSync(PC.SCORES, 'utf-8')).scenes;
  assert.deepEqual(res.filter((r) => r.stale).map((r) => r.stem), [], 'run node tools/peek_cover.mjs (on hp)');
  assert.equal(PC.scoresText(res, root).text.replace(/\r\n/g, '\n'), fs.readFileSync(PC.SCORES, 'utf-8').replace(/\r\n/g, '\n'), 'spot-scores.json up to date');
  for (const r of res) {
    const { data, doc } = PC.readScenario(r.stem, root);
    assert.equal(data.scene.shareCode, r.entry.shareCode, r.stem);
    assert.equal(doc.meta.id, `set-${r.entry.shareCode}`, r.stem);
    assert.equal(data.item.sceneKey, doc.meta.id, r.stem);
    assert.equal(data.scene.docBytes, Buffer.byteLength(data.scene.doc), r.stem);
    assert.equal(data.item.docBytes, data.scene.docBytes, r.stem);
    assert.equal(data.scene.blockCount, doc.blocks.length, r.stem);
    assert.deepEqual(doc.playerSpawn, r.entry.source.playerSpawn, r.stem);
    assert.equal(doc.rules.playerDeath, 'endRound', r.stem);
    assert.equal(doc.rules.duration, 90, r.stem);
    // Flat 0.5 spot scores under the new doc's key: no spot bias on these drills.
    const e = scores[key(doc)];
    assert.ok(e, `${r.stem}: spot-score entry for the new key`);
    assert.deepEqual(e.codes, [r.entry.shareCode]);
    assert.deepEqual(e.ids, [doc.meta.id]);
    assert.deepEqual(Object.keys(e.scores).sort(), [...doc.rules.spawnerPick.pool].sort());
    assert.ok(Object.values(e.scores).every((v) => v === 0.5), `${r.stem}: flat scores`);
    assert.equal(Object.values(scores).filter((v) => v.codes.includes(r.entry.shareCode)).length, 1, `${r.stem}: one entry`);
  }
});

test('every pool spawner starts on its path loop (cover first), size 0, no strafe, shooter kept; restored spots = original; every bot moves', { skip }, async () => {
  const res = await generated();
  for (const stem of PC.STEMS) {
    const { doc } = PC.readScenario(stem, root);
    const src = DATA.drills[stem].source;
    const info = new Map(res.find((r) => r.stem === stem).infos.map((f) => [f.id, f]));
    const shooter = src.actors[0].behaviors.find((b) => b.kind === 'shooter');
    const actors = new Map(doc.actors.map((a) => [a.id, a]));
    for (const id of doc.rules.spawnerPick.pool) {
      const s = doc.spawners.find((x) => x.id === id);
      const o = src.spawners.find((x) => x.id === id);
      const a = actors.get(s.actorTemplateId);
      assert.ok(a, `${stem} ${id}: actor`);
      // Still-check on the doc: every pool bot has a path with >= 2 distinct waypoints, or strafe.
      const pth = a.behaviors.find((b) => b.kind === 'path');
      const distinct = pth ? new Set(pth.waypoints.map((w) => `${w.x},${w.y},${w.z}`)).size : 0;
      assert.ok(distinct >= 2 || a.behaviors.some((b) => b.kind === 'strafe'), `${stem} ${id}: bot moves (path ${distinct} distinct points, no strafe)`);
      const rs = info.get(id).restored;
      if (rs && rs.kind !== 'a') {
        // Restored strafe (b, c): the exact original spawner (+ rotationY for c) and the original actor-1.
        const want = structuredClone(o);
        if (rs.kind === 'c') want.rotationY = rs.rotationY;
        assert.deepEqual(s, want, `${stem} ${id}: restored spawner = original`);
        assert.equal(s.actorTemplateId, PC.STRAFE_ACTOR);
        assert.deepEqual(a, src.actors.find((x) => x.id === PC.STRAFE_ACTOR), `${stem} ${id}: restored actor = original actor-1`);
        continue;
      }
      assert.equal(s.kind, 'area');
      assert.deepEqual(s.size, { x: 0, y: 0, z: 0 });
      for (const k of ['maxAlive', 'spawnDelay', 'faceTarget', 'groundSnap', 'name']) assert.deepEqual(s[k], o[k], `${stem} ${id} ${k}`);
      const path0 = a.behaviors.find((b) => b.kind === 'path');
      assert.ok(path0 && path0.loop === true && path0.counterStrafe === true && path0.speed === 5.4, `${stem} ${id}: path loop`);
      assert.ok(!a.behaviors.some((b) => b.kind === 'strafe'), `${stem} ${id}: no strafe`);
      assert.deepEqual(a.behaviors.find((b) => b.kind === 'shooter'), shooter, `${stem} ${id}: shooter unchanged`);
      const w0 = path0.waypoints[0];
      assert.ok(Math.abs(s.position.x - w0.x) < 1e-6 && Math.abs(s.position.z - w0.z) < 1e-6 && Math.abs(s.position.y - 0.3 - w0.y) < 1e-6, `${stem} ${id}: spawner on waypoint 0`);
      assert.ok(path0.waypoints.length >= 2 && path0.pauses.length === path0.waypoints.length, `${stem} ${id}: pauses`);
    }
  }
});

// Per drill: idle run with terrain, every bot's birth spot hidden as the tool reports, peeks out.
// Classic bots with the drill's own spot pick, then every pool spot at once (no pick) for Classic and
// Human-like bots at Radiant and Iron (Human-like scales pauses 0.6-1.4x and adds a start hesitation).
const MODES = [
  { label: 'classic, picked spots', all: false, extra: {}, limit: 4 },
  { label: 'classic, every pool spot', all: true, extra: {}, limit: 4 },
  { label: 'human-like radiant, every pool spot', all: true, extra: { bots: 'human', enemyRank: 'radiant' }, limit: 5.5 },
  { label: 'human-like iron, every pool spot', all: true, extra: { bots: 'human', enemyRank: 'iron' }, limit: 5.5 },
];
// Longest allowed still span: the largest configured wait (path pause or strafe dwell) x 1.4
// (Human-like pause scale 0.6-1.4) + 0.5 s (start hesitation <= 0.25 s, braking, sampling).
let STILL_MAX = 0;
test('bots are born hidden from the player route and peek out (real map collision in the sim)', { skip, timeout: 850000 }, async () => {
  const res = await generated();
  const lines = [];
  let longest = 0, maxStill = 0;
  for (const r of res) for (const a of r.doc.actors) for (const b of a.behaviors) {
    if (b.kind === 'path') for (const p of b.pauses ?? []) longest = Math.max(longest, p.wait);
    if (b.kind === 'strafe') longest = Math.max(longest, ...b.dwell);
  }
  STILL_MAX = longest * 1.4 + 0.5;
  for (const mode of MODES) {
    let hidTicks = 0, allTicks = 0;
    for (const r of res) {
      const T = await terrainOf(r.entry.map);
      const geo = PC.geometry(T);
      const info = new Map(r.infos.map((f) => [f.id, f]));
      const vps = new Map(r.infos.map((f) => [f.id, PC.viewpoints(r.entry, f.id)]));
      const doc = structuredClone(r.doc);
      // Lotus spawner-16 can see the player spawn (in the original drill too): left out of the
      // every-spot runs so the idle player lives and the other spots get checked.
      const SEES_SPAWN = r.stem === 'lotus-b-attack-peekers' ? 'spawner-16' : null;
      if (mode.all) {
        delete doc.rules.spawnerPick;
        if (SEES_SPAWN) doc.spawners = doc.spawners.filter((x) => x.id !== SEES_SPAWN);
      }
      const s = createSim(doc, T, 11, mode.extra);
      const bots = new Map();
      const SEC = 14;
      let deadAt = -1;
      for (let i = 0; i < SEC * TPS; i++) {
        const snap = s.snapshot();
        const pe = [snap.player.position.x, snap.player.position.y + 1.75, snap.player.position.z];
        for (const a of snap.actors) {
          if (!a.alive || !a.visible) continue;
          let b = bots.get(a.id);
          if (!b) { b = { sp: a.spawnerId, born: i, firstSeen: -1, hid: 0, n: 0, last: null, still: 0, maxStill: 0, sees: false }; bots.set(a.id, b); }
          const age = i - b.born;
          // Longest span standing exactly still (a paused path bot does not move at all).
          if (b.last && Math.hypot(a.position.x - b.last.x, a.position.z - b.last.z) < 1e-6) b.maxStill = Math.max(b.maxStill, ++b.still);
          else b.still = 0;
          b.last = { x: a.position.x, z: a.position.z };
          // Picked-spot runs: a bot that can see the player's eye may hold still to fight (engaged).
          if (!mode.all && !b.sees && i % 8 === 0) b.sees = T.sight([a.position.x, a.position.y + PC.G.HEAD, a.position.z], pe);
          const vp = vps.get(a.spawnerId);
          if (age === 8) b.p0 = { ...a.position };
          if (!vp || age < 8 || (age % 4 !== 0 && b.firstSeen >= 0)) continue;
          const seen = geo.seen(vp.first, a.position);
          if (seen && b.firstSeen < 0) b.firstSeen = age;
          if (age % 4 === 0) { b.n++; if (!seen) b.hid++; }
        }
        if (s.step(IDLE).some((e) => e.kind === 'playerDead')) { deadAt = i; break; }
      }
      let born = 0, hiddenAll = 0, partial = 0, open = 0;
      const late = [], still = [];
      for (const b of bots.values()) {
        const f = info.get(b.sp), vp = vps.get(b.sp);
        assert.ok(b.p0, `${mode.label} ${r.stem} ${b.sp}: lived 8 ticks`);
        born++;
        if (!b.sees && b.maxStill > STILL_MAX * TPS) still.push(`${b.sp} ${(b.maxStill / TPS).toFixed(2)} s`);
        if (!f.cover) { open++; continue; }
        const hidFirst = !geo.seen(vp.first, b.p0);
        const hidSamples = vp.samples.filter((e) => !geo.seen(e, b.p0)).length;
        assert.ok(hidFirst, `${mode.label} ${r.stem} ${b.sp}: born hidden from its first-sight point`);
        assert.ok(hidSamples >= f.hiddenSamples, `${mode.label} ${r.stem} ${b.sp}: hidden from ${hidSamples}/${vp.samples.length} route samples, tool said ${f.hiddenSamples}`);
        if (hidSamples === vp.samples.length) hiddenAll++; else partial++;
        if (f.spotSeen) {
          const lived = (deadAt >= 0 ? deadAt : SEC * TPS) - b.born; // run ends at the player's death
          if ((b.firstSeen < 0 && lived > mode.limit * TPS) || b.firstSeen > mode.limit * TPS) late.push(`${b.sp} ${b.firstSeen < 0 ? 'never' : (b.firstSeen / TPS).toFixed(2) + ' s'}`);
          hidTicks += b.hid; allTicks += b.n;
        }
      }
      // Only a picked Lotus round with spawner-16 in it may end early.
      const pickedSees = !mode.all && SEES_SPAWN && [...bots.values()].some((b) => b.sp === SEES_SPAWN);
      assert.ok(deadAt < 0 || pickedSees, `${mode.label} ${r.stem}: idle player at spawn shot dead at ${(deadAt / TPS).toFixed(2)} s`);
      if (mode.all) assert.equal(born, r.doc.rules.spawnerPick.pool.length - (SEES_SPAWN ? 1 : 0), `${mode.label} ${r.stem}: every pool spot spawned`);
      else assert.ok(born >= r.doc.rules.spawnerPick.count, `${mode.label} ${r.stem}: ${born} bots born`);
      assert.deepEqual(late, [], `${mode.label} ${r.stem}: covered bots visible from the first-sight point within ${mode.limit} s`);
      assert.deepEqual(still, [], `${mode.label} ${r.stem}: unengaged bots standing still longer than ${STILL_MAX.toFixed(2)} s`);
      maxStill = Math.max(maxStill, ...[...bots.values()].filter((b) => !b.sees).map((b) => b.maxStill));
      lines.push(`[${mode.label}] ${r.stem}: born ${born}, hidden from all viewpoints ${hiddenAll}, partial ${partial}, no cover ${open}${deadAt >= 0 ? `, player at spawn shot dead at ${(deadAt / TPS).toFixed(1)} s` : ''}`);
    }
    const share = (100 * hidTicks) / Math.max(1, allTicks);
    lines.push(`[${mode.label}] covered bots hidden from their first-sight point: ${share.toFixed(1)}% of ${allTicks} samples`);
    // Rhythm guard: mostly hidden, but they do come out (target ~60%).
    assert.ok(share >= 50 && share <= 75, `${mode.label}: hidden share ${share.toFixed(1)}%`);
  }
  lines.push(`longest unengaged still span ${(maxStill / TPS).toFixed(2)} s (limit ${STILL_MAX.toFixed(2)} s)`);
  console.log(lines.join(String.fromCharCode(10)));
});

test('a refill after a kill comes from cover again; same seed = same run', { skip, timeout: 300000 }, async () => {
  const stem = 'corrode-mid-to-a-peekers';
  const res = await generated();
  const r = res.find((x) => x.stem === stem);
  const T = await terrainOf(r.entry.map);
  const geo = PC.geometry(T);
  const f = r.infos.find((x) => x.cover && x.spotSeen && x.hiddenSamples === x.samples);
  assert.ok(f, 'a fully covered spot');
  const vp = PC.viewpoints(r.entry, f.id);
  // One spot, the player standing on its first-sight point (looking at the spot), tapping heads.
  const doc = structuredClone(r.doc);
  doc.spawners = doc.spawners.filter((x) => x.id === f.id);
  delete doc.rules.spawnerPick;
  doc.playerSpawn = { position: { x: vp.from[0], y: vp.from[1] + 0.05, z: vp.from[2] }, yaw: doc.playerSpawn.yaw };
  const sp = doc.spawners.find((x) => x.id === f.id);
  const tapper = (snap) => {
    const a = snap.actors.find((x) => x.alive && x.visible);
    if (!a || !geo.seen(vp.first, a.position)) return IDLE;
    const p = snap.player, dx = a.position.x - p.position.x, dz = a.position.z - p.position.z;
    const dy = a.position.y + 1.86 * (a.scale || 1) - (p.position.y + 1.75);
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return { ...IDLE, fire: true, mouseDx: -(yaw - p.recoilYaw - p.yaw) / RAD_PER_COUNT, mouseDy: -(pitch - p.recoilPitch - p.pitch) / RAD_PER_COUNT };
  };
  const run = () => {
    const s = createSim(doc, T, 5);
    const births = [];
    let kills = 0, dead = false, trace = '';
    for (let i = 0; i < 20 * TPS && births.length < 3 && !dead; i++) {
      const snap = s.snapshot();
      for (const a of snap.actors) {
        if (!a.alive || !a.visible || births.some((b) => b.key === `${a.id}:${a.bornTick}`)) continue;
        births.push({ key: `${a.id}:${a.bornTick}`, tick: i, p: { ...a.position }, seen: geo.seen(vp.first, { ...a.position, y: sp.position.y - 0.3 }) });
      }
      if (i % 32 === 0) trace += snap.actors.map((a) => `${a.alive ? 1 : 0}${a.position.x.toFixed(3)},${a.position.z.toFixed(3)}`).join('|') + ';';
      for (const e of s.step(tapper(snap))) {
        if (e.kind === 'kill') kills++;
        if (e.kind === 'playerDead') dead = true;
      }
    }
    return { births, kills, dead, trace };
  };
  const a = run();
  assert.ok(a.kills >= 1, `kills ${a.kills}, player dead ${a.dead}`);
  assert.ok(a.births.length >= 2, `a refill came: ${a.births.length} lives`);
  for (const b of a.births) {
    assert.ok(Math.hypot(b.p.x - sp.position.x, b.p.z - sp.position.z) < 0.05, `life at tick ${b.tick} starts on the cover point`);
    assert.equal(b.seen, false, `life at tick ${b.tick} starts hidden from the first-sight point`);
  }
  const b = run();
  assert.equal(b.trace, a.trace, 'same seed, same run');
});
