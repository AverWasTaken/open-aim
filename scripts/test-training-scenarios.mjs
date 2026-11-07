// Every drill in scenarios/ through the game's own code, headless:
//  - the game's scene validator (app/mods/next/js/D_iGclxB.js) accepts its doc;
//  - the real patched sim (app/mods/next/js/CnrSARj_.js, loaded by scripts/sim-loader.mjs) runs it
//    for 5 s idle and 5 s firing without throwing, and bots spawn;
//  - each new drill (NEW below) can be won: a simple aim helper (turns the view onto a bot's head or
//    body with mouse counts, fires in the same tick) gets kills, and the drill's own rule works
//    (counter-strafe fire window jams, the Operator needs its scope, peekers shoot back).
// Map drills run without map walls: sim-loader.mjs stubs /local/map-registry.mjs, so only the doc's
// own blocks collide. The new drills are all arena drills, so their checks are complete.
// Reads scenarios/*.json directly (no build step). Needs the game files in site/ for the sim and
// validator imports (docs/game-files.md); skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parseName, shooterStats } = require(path.join(root, 'app', 'drill-variants.js'));
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js'));
const VALIDATOR = path.join(root, 'app', 'mods', 'next', 'js', 'D_iGclxB.js');
const skip = !HAVE_SITE && 'no game files in site/';

let sim = null;
if (HAVE_SITE) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(path.join(root, 'app', 'mods', 'next', 'js', 'CnrSARj_.js')).href);
}

const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
const RAD_PER_COUNT = (0.07 * Math.PI) / 180; // sensitivity 1: one mouse count turns the view 0.07 degrees
const EYE = 1.75; // standing eye height (shot origin y)
const HEAD = 1.86; // middle of a humanoid head above its feet, at scale 1 (head spans ~1.72-2.0)
const BODY = 1.2;
// OkAdunfX: c as p0. Each sim gets its own copy of the doc: runs must not share state through it.
const createSim = (doc, seed = 7) => sim.c(structuredClone(doc), { sensitivity: 1, zoomSensitivity: 1, seed });

const SCENARIOS = fs.readdirSync(path.join(root, 'scenarios')).filter((f) => f.endsWith('.json')).sort().map((file) => {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', file), 'utf-8').replace(/^﻿/, ''));
  return { file, item: data.item, scene: data.scene, doc: JSON.parse(data.scene.doc) };
});
const byFile = (f) => {
  const s = SCENARIOS.find((x) => x.file === `${f}.json`);
  assert.ok(s, `scenarios/${f}.json exists`);
  return s;
};

// The drills added in the 2026-11 training pack. All arena drills, lobby type "basic".
const NEW = ['counter-strafe-taps', 'jiggle-peek-duels', 'long-range-taps', 'sheriff-one-taps', 'operator-angle-hold', 'spray-transfer'];

// Mouse counts that put the crosshair on actor `a` at height `h` (metres above its feet, x scale).
function aimAt(snap, a, h) {
  const p = snap.player;
  const dx = a.position.x - p.position.x;
  const dz = a.position.z - p.position.z;
  const dy = a.position.y + h * (a.scale || 1) - (p.position.y + EYE);
  const yaw = Math.atan2(-dx, -dz); // yaw 0 looks down -z; +mouseDx lowers yaw
  const pitch = Math.atan2(dy, Math.hypot(dx, dz)); // +mouseDy lowers pitch
  // A shot leaves along view + recoil (+ spread): aim the view against the current recoil.
  return { mouseDx: -(yaw - p.recoilYaw - p.yaw) / RAD_PER_COUNT, mouseDy: -(pitch - p.recoilPitch - p.pitch) / RAD_PER_COUNT };
}

// Plays `sec` seconds. policy(snap, tick, target) -> input (or null for idle); target = the alive,
// shown bot with the lowest id. Stops at the first playerDead. Returns event counts + shots.
function play(doc, sec, policy, { seed = 7, each = null } = {}) {
  const s = createSim(doc, seed);
  const n = {};
  const shots = [];
  for (let i = 0; i < sec * TPS; i++) {
    const snap = s.snapshot();
    const target = snap.actors.filter((a) => a.alive && a.visible).sort((a, b) => a.id - b.id)[0] || null;
    if (each) each(s, snap, i);
    const input = { ...IDLE, ...(policy(snap, i, target) || {}) };
    for (const e of s.step(input)) {
      n[e.kind] = (n[e.kind] || 0) + 1;
      if (e.kind === 'shot') shots.push(e);
    }
    if (n.playerDead) break;
  }
  return { n, shots, sim: s };
}

// Aims at the target every tick, fires every `gap` ticks (gap 0 = hold the trigger while on a bot).
const shooterPolicy = (h, gap) => {
  let next = 0;
  return (snap, i, t) => {
    if (!t) return null;
    const inp = aimAt(snap, t, h);
    if (i >= next) {
      inp.fire = true;
      next = i + gap;
    }
    return inp;
  };
};

test('every scenario file is a valid drill doc (game scene validator)', { skip: !fs.existsSync(VALIDATOR) && 'no validator' }, async () => {
  // The validator imports the map list from /local/map-registry.mjs (fetched in the app). Feed it
  // the app's real list (app/mods/local-api/maps overrides site/local-api/maps).
  const mapsFile = [path.join(root, 'app', 'mods', 'local-api', 'maps'), path.join(root, 'site', 'local-api', 'maps')].find((f) => fs.existsSync(f));
  const mapIds = mapsFile ? JSON.parse(fs.readFileSync(mapsFile, 'utf-8')).maps.map((m) => m.id) : [...new Set(SCENARIOS.map((s) => s.doc.environment?.map).filter(Boolean))];
  const src = fs.readFileSync(VALIDATOR, 'utf-8').replace(/^import \{mapIds as localMapIds\} from "\/local\/map-registry\.mjs";/m, `const localMapIds=${JSON.stringify(mapIds)};`);
  assert.ok(src.startsWith('const localMapIds'), 'validator import line changed');
  const tmp = path.join(os.tmpdir(), `aim-training-validator-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    const { p: validate } = await import(pathToFileURL(tmp).href);
    assert.throws(() => validate(JSON.stringify({ schemaVersion: 2 })), 'the harness rejects a broken doc');
    for (const s of SCENARIOS) {
      assert.doesNotThrow(() => validate(s.scene.doc), s.file);
      if (s.doc.environment?.map) assert.ok(mapIds.includes(s.doc.environment.map), `${s.file}: map ${s.doc.environment.map} is a known map`);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('every scenario runs 5 s idle and 5 s firing in the real sim, and bots spawn', { skip }, () => {
  assert.ok(SCENARIOS.length >= 37);
  for (const s of SCENARIOS) {
    const idle = play(s.doc, 5, () => null, { seed: 3 });
    const firing = play(s.doc, 5, (snap, i) => ({ fire: i % 16 === 0, mouseDx: i % 64 < 32 ? 2 : -2 }), { seed: 3 });
    for (const r of [idle, firing]) {
      assert.ok((r.n.spawn || 0) > 0 && r.sim.snapshot().actors.length > 0, `${s.file}: bots spawned`);
    }
    assert.ok(firing.n.shot > 0 || firing.n.jam > 0, `${s.file}: the trigger does something`);
  }
});

test('new drills: lobby entries read right (plain names, arena, basic, not an Easy/Hard twin)', () => {
  for (const f of NEW) {
    const { item, scene, doc } = byFile(f);
    assert.equal(item.type, 'basic', f);
    assert.equal(item.mapId, null, f);
    assert.equal(doc.environment.map, undefined, f);
    assert.equal(parseName(item.name).label, null, `${f}: no 简单/普通/中等/困难 prefix`);
    assert.ok(!/[—–]/.test(item.description + item.name), `${f}: no dashes in UI text`);
    assert.ok(item.description.length <= 160, `${f}: short description`);
    assert.equal(scene.docBytes, Buffer.byteLength(scene.doc), f);
    assert.equal(item.docBytes, scene.docBytes, f);
    assert.equal(scene.blockCount, doc.blocks.length, f);
    assert.equal(doc.meta.id, item.sceneKey, f);
    assert.equal(doc.meta.name, item.name, f);
  }
});

test('Counter-strafe taps: shots fire right after a stop, jam when standing still, and it can be won', { skip }, () => {
  const { doc } = byFile('counter-strafe-taps');
  assert.equal(doc.rules.weapon, 'vandal');
  assert.equal(doc.rules.fireMode, 'single');
  assert.equal(doc.rules.playerMovable, true);
  assert.equal(doc.rules.fireWindowSec, 0.3);
  // Strafe 0.3 s, let go, fire 0.1 s later: a shot. Then stand 1 s and fire: a jam, no shot.
  const ev = [];
  const s = createSim(doc, 5);
  for (let i = 0; i < TPS * 2; i++) {
    const strafe = i >= 64 && i < 64 + 38 ? 1 : 0;
    const fire = i === 64 + 38 + 13 || i === 64 + 38 + 13 + TPS;
    for (const e of s.step({ ...IDLE, strafe, fire })) if (e.kind === 'shot' || e.kind === 'jam') ev.push([i, e.kind]);
  }
  assert.deepEqual(ev, [[115, 'shot'], [243, 'jam']]);
  // The player can't walk off: lane walls keep them near the spawn.
  const walk = play(doc, 4, (snap, i) => ({ strafe: i < 2 * TPS ? 1 : -1, forward: i % TPS < 64 ? 1 : -1 }));
  const p = walk.sim.snapshot().player.position;
  assert.ok(Math.abs(p.x) < 3.3 && p.z > 7.5 && p.z < 16.5, `stays in the lane: ${JSON.stringify(p)}`);
  // Strafe 40 ticks, stop, tap the head once the player has slowed down.
  const r = play(doc, 10, (snap, i, t) => {
    const strafe = i % 96 < 40 ? (Math.floor(i / 96) % 2 ? 1 : -1) : 0;
    if (!t) return { strafe };
    const v = Math.hypot(snap.player.velocity.x, snap.player.velocity.y);
    return { strafe, ...aimAt(snap, t, HEAD), fire: strafe === 0 && v < 0.3 && i % 96 < 60 };
  });
  assert.ok(r.n.kill >= 5, `kills: ${JSON.stringify(r.n)}`);
  assert.ok(r.shots.every((e) => e.hitPart !== 'body'), 'taps land on heads');
});

test('Jiggle-peek duels: peekers shoot back, the player can win duels', { skip }, () => {
  const { doc } = byFile('jiggle-peek-duels');
  assert.equal(doc.rules.weapon, 'vandal');
  assert.equal(doc.rules.playerDeath, 'endRound');
  assert.ok(doc.actors.every((a) => a.behaviors.some((b) => b.kind === 'shooter' && b.engage === 'stop')));
  assert.ok(doc.actors.every((a) => a.behaviors.some((b) => b.kind === 'cross' && b.pauses?.length >= 5)), 'two jiggles, then the peek');
  // With an idle player, the first peeker (Studio silver reaction) shows a shoulder twice, hides in
  // between, then swings wide and shoots. Offset = metres from its wall's middle (walls at x -6/0/6).
  const s = createSim(doc, 7);
  const seen = [];
  for (let i = 0; i < 10 * TPS; i++) {
    const ev = s.step(IDLE);
    const a = s.snapshot().actors.find((x) => x.alive);
    if (a) {
      const off = Math.round(Math.abs(a.position.x - Math.round(a.position.x / 6) * 6) * 10) / 10;
      if (seen.at(-1) !== off) seen.push(off);
    }
    if (ev.some((e) => e.kind === 'enemyShot')) break;
  }
  const marks = seen.map((o) => (o <= 0.4 ? 'hidden' : o === 1.5 ? 'shoulder' : o >= 2.1 ? 'wide' : null)).filter((m, i, all) => m && m !== all.slice(0, i).filter(Boolean).at(-1));
  // (it passes 1.5 m once more on the way out to the wide peek)
  assert.deepEqual(marks, ['hidden', 'shoulder', 'hidden', 'shoulder', 'hidden', 'shoulder', 'wide'], `route before the first shot: ${seen.join(' ')}`);
  // Standing still and not shooting: a peeker comes out and kills the player.
  const idle = play(doc, 30, () => null);
  assert.ok(idle.n.enemyShot > 0 && idle.n.playerDead === 1, `bots shoot back: ${JSON.stringify(idle.n)}`);
  // Taps at the head while a bot is out: wins duels before dying.
  for (const seed of [7, 9]) {
    const r = play(doc, 20, shooterPolicy(HEAD, 32), { seed });
    assert.ok(r.n.kill >= 3, `seed ${seed}: ${JSON.stringify(r.n)}`);
  }
});

test('Long-range taps: bots 35-50 m away, one Vandal head tap kills', { skip }, () => {
  const { doc } = byFile('long-range-taps');
  assert.equal(doc.rules.weapon, 'vandal');
  assert.equal(doc.rules.fireMode, 'single');
  assert.ok(doc.actors[0].health <= 160);
  const dist = [];
  const r = play(doc, 10, shooterPolicy(HEAD, 24), {
    each: (s, snap) => snap.actors.filter((a) => a.alive).forEach((a) => dist.push(Math.hypot(a.position.x - snap.player.position.x, a.position.z - snap.player.position.z))),
  });
  assert.ok(Math.min(...dist) >= 34 && Math.max(...dist) <= 51, `distances ${Math.min(...dist)}-${Math.max(...dist)}`);
  assert.ok(r.n.kill >= 10, JSON.stringify(r.n));
  assert.equal(r.n.kill, r.shots.filter((e) => e.hitPart === 'head').length, 'every head tap is a kill');
});

test('Sheriff one-taps: Sheriff, strafing bots, head kills, body shots do not', { skip }, () => {
  const { doc } = byFile('sheriff-one-taps');
  assert.equal(doc.rules.weapon, 'sheriff');
  assert.equal(doc.rules.fireMode, 'single');
  assert.ok(doc.actors[0].health <= 145, 'Sheriff head (145 past 30 m) always kills');
  assert.ok(doc.actors[0].health > 55, 'one body shot never kills');
  assert.ok(doc.actors[0].behaviors.some((b) => b.kind === 'strafe'));
  const heads = play(doc, 10, shooterPolicy(HEAD, 48));
  assert.ok(heads.n.kill >= 5, JSON.stringify(heads.n));
  const bodies = play(doc, 3, shooterPolicy(BODY, 600)); // one body shot only
  assert.equal(bodies.shots.length, 1);
  assert.equal(bodies.shots[0].hitPart, 'body');
  assert.equal(bodies.n.kill || 0, 0);
});

test('Operator angle hold: Operator, bots cross the gap, a scoped body shot kills', { skip }, () => {
  const { doc } = byFile('operator-angle-hold');
  assert.equal(doc.rules.weapon, 'operator');
  assert.equal(doc.rules.fireMode, 'single');
  assert.ok(!doc.rules.perfectAccuracy, 'unscoped shots are inaccurate: scope in');
  assert.ok(doc.actors.every((a) => (a.health ?? 150) <= 150), 'Operator body (150) kills');
  // The Operator fires about every 1.7 s; shooting sooner gives 1 degree of spread even scoped.
  const r = play(doc, 30, shooterPolicy(BODY, 240), { each: (s) => s.setZoomLevel(1) });
  assert.ok(r.n.kill >= 3, JSON.stringify(r.n));
  assert.ok(r.shots.filter((e) => e.hitPart === 'body').length <= r.n.kill, 'every body hit kills');
  assert.ok(r.shots.every((e) => e.spreadDeg < 0.5), 'scoped shots are accurate');
  const hip = play(doc, 10, shooterPolicy(BODY, 240), { each: (s) => s.setZoomLevel(0) });
  assert.ok(hip.shots.length > 0 && hip.shots.every((e) => e.spreadDeg > 2), 'unscoped shots spread');
});

test('Spray transfer: a row of 4 close bots, two body hits each, one spray clears it', { skip }, () => {
  const { doc } = byFile('spray-transfer');
  assert.equal(doc.rules.weapon, 'vandal');
  assert.equal(doc.rules.fireMode, 'hold');
  assert.equal(doc.spawners.length, 4);
  assert.ok(doc.actors[0].health >= 70 && doc.actors[0].health <= 80, 'two Vandal body hits (40) kill, one does not');
  const xs = doc.spawners.map((s) => s.position.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 0.8 && xs[i] - xs[i - 1] <= 1.5, 'bots 0.8-1.5 m apart');
  // Hold the trigger on the body of the lowest-id bot until all four are down.
  let cleared = -1;
  const r = play(doc, 6, shooterPolicy(BODY, 0), {
    each: (s, snap, i) => {
      if (cleared < 0 && i > TPS && snap.actors.length >= 4 && snap.actors.every((a) => !a.alive)) cleared = i;
    },
  });
  assert.ok(r.n.kill >= 4, JSON.stringify(r.n));
  assert.ok(cleared > 0, 'all four down at once');
});

test('new drills whose bots shoot back carry shooter stats (rank picker)', () => {
  for (const f of NEW) {
    const { doc } = byFile(f);
    const shoots = shooterStats(doc).length > 0;
    assert.equal(shoots, f === 'jiggle-peek-duels', `${f}: shoots back = ${shoots}`);
  }
});
