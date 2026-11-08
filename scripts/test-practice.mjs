// Practice mode checks (tools/practice_areas.mjs, app/practice-scene.js, tools/practice_patch.py):
// the areas file is current and sane, every generated scene passes the game's own scene validator,
// bad codes give null, the patched play page (both copies identical), and the bots in the real sim
// (scripts/sim-loader.mjs): they come back 1.5 s after every kill, the actor list never grows, the
// run never runs out of targets, and strafing bots stay on their checked lane.
// Runs in node only. Checks that need the game files in site/ are skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf-8').replace(/\r\n/g, '\n');
const MODS = path.join(root, 'app', 'mods');
const JS = [path.join('app', 'mods', 'next', 'js'), path.join('app', 'mods', '_assets', 'r20261021-1', 'next', 'js')];
const P = require(path.join(root, 'app', 'practice-scene.js'));
const areas = JSON.parse(read('app', 'mods', 'aim-practice', 'areas.json'));
const MAP_IDS = JSON.parse(read('app', 'mods', 'local-api', 'maps')).maps.map((m) => m.id);
const ALL_MAPS = ['ascent', 'bonsai', 'triad', 'plummet', 'jam', 'infinity', 'rook', 'duality', 'juliett'];
const docOf = (code) => { const e = P.practiceScene(MODS, code); assert.ok(e, `no scene for ${code}`); return JSON.parse(e.doc); };
const codes = function* () {
  for (const [map, m] of Object.entries(areas.maps)) for (const a of m.areas) {
    yield `practice-${map}-${a.id}-vandal-none-0`;
    yield `practice-${map}-${a.id}-sheriff-static-1`;
    yield `practice-${map}-${a.id}-operator-static-12`;
    yield `practice-${map}-${a.id}-vandal-strafe-5`;
    yield `practice-${map}-${a.id}-phantom-strafe-12`;
  }
};

// ---------------------------------------------------------------- data
test('areas.json is what tools/practice_areas.mjs writes', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'tools', 'practice_areas.mjs'), '--check'], { encoding: 'utf-8' });
  assert.match(out, /up to date/);
});

test('every map has >= 2 areas with plain unique names, >= 1 spot each, sane spawns, spots and lanes', () => {
  assert.deepEqual(Object.keys(areas.maps).sort(), [...ALL_MAPS].sort());
  assert.deepEqual([...MAP_IDS].sort(), [...ALL_MAPS].sort(), 'local-api/maps ids changed');
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const [map, m] of Object.entries(areas.maps)) {
    assert.ok(m.areas.length >= 2, `${map}: ${m.areas.length} areas`);
    const names = m.areas.map((a) => a.name), ids = m.areas.map((a) => a.id);
    assert.equal(new Set(names).size, names.length, `${map}: duplicate names ${names}`);
    assert.equal(new Set(ids).size, ids.length, `${map}: duplicate ids`);
    for (const a of m.areas) {
      assert.match(a.id, /^[a-z0-9]+$/);
      assert.match(a.name, /^[A-Za-z0-9 ()]+$/, `${map}: name not plain ASCII: ${a.name}`);
      assert.equal(a.env.map, map);
      assert.ok(num(a.spawn.x) && num(a.spawn.y) && num(a.spawn.z) && num(a.spawn.yaw));
      assert.ok(a.spots.length >= 1, `${map}/${a.id}: no spots`);
      for (const s of a.spots) {
        assert.ok(num(s.x) && num(s.y) && num(s.z));
        if (s.lane) {
          assert.equal(s.lane.length, 4);
          assert.ok(Math.abs(Math.hypot(s.lane[0], s.lane[1]) - 1) < 0.01, 'lane axis not unit');
          assert.ok(s.lane[2] <= 0 && s.lane[3] >= 0 && s.lane[3] - s.lane[2] >= 0.6 - 1e-9, `short lane ${s.lane}`);
        }
      }
      for (let i = 0; i < a.spots.length; i++) for (let j = i + 1; j < a.spots.length; j++) {
        const p = a.spots[i], q = a.spots[j];
        assert.ok(Math.hypot(p.x - q.x, p.z - q.z) >= 0.8 || Math.abs(p.y - q.y) >= 1, `${map}/${a.id}: spots ${i} and ${j} overlap`);
      }
    }
  }
});

// ---------------------------------------------------------------- scenes
test('codes: valid ones build, bad ones give null', () => {
  const a = areas.maps.juliett.areas[0];
  assert.ok(P.practiceScene(MODS, `practice-juliett-${a.id}-vandal-strafe-5`));
  for (const bad of [
    '', 'practice', `practice-juliett-${a.id}-vandal-static-0`, `practice-juliett-${a.id}-vandal-static-13`,
    `practice-juliett-${a.id}-vandal-static-123`, `practice-juliett-${a.id}-knife-static-3`, `practice-juliett-${a.id}-vandal-fly-3`,
    'practice-juliett-nosucharea-vandal-static-3', `practice-nosuchmap-${a.id}-vandal-static-3`, `practice-Juliett-${a.id}-vandal-static-3`,
    `practice-juliett-${a.id}-vandal-static-3-x`, `practice-../juliett-${a.id}-vandal-static-3`, `round-juliett-${a.id}-vandal-static-3`,
    'round-ascent-attack-vandal-20',
  ]) assert.equal(P.practiceScene(MODS, bad), null, bad);
  // none ignores the count; the area's spot count caps it.
  assert.equal(docOf(`practice-juliett-${a.id}-vandal-none-7`).spawners.length, 0);
  const few = { id: 'x', spots: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0, lane: [1, 0, -1, 1] }] };
  assert.equal(P.pickSpots(few, { bots: 'static', count: 12 }).length, 2);
  assert.deepEqual(P.pickSpots(few, { bots: 'strafe', count: 1 }), [few.spots[1]], 'strafe takes lane spots first');
  assert.equal(P.parseCode(`practice-juliett-${a.id}-vandal-none-0`).count, 0);
});

test('practice codes never collide with shipped drill codes, round codes or spot-variation ids', () => {
  const sceneDir = path.join(root, 'site', 'prod-api', 'api', 'v1', 'public', 'val', 'aimlab', 'scenes');
  const shipped = new Set(fs.existsSync(sceneDir) ? fs.readdirSync(sceneDir) : []);
  for (const f of fs.readdirSync(path.join(root, 'scenarios')).filter((f) => f.endsWith('.json'))) shipped.add(JSON.parse(read('scenarios', f)).item.shareCode);
  if (fs.existsSync(path.join(root, 'app', 'training-set.json'))) for (const c of Object.keys(JSON.parse(read('app', 'training-set.json')).scenes)) shipped.add(c);
  const alts = JSON.parse(read('app', 'mods', 'aim-ranks', 'spot-alts.json'));
  const altIds = new Set(Object.values(alts.scenes).flatMap((e) => e.ids));
  const roundScene = require(path.join(root, 'app', 'round-scene.js')).roundScene;
  for (const code of codes()) {
    assert.ok(!shipped.has(code), code);
    assert.equal(roundScene(MODS, code), null, code);
    const doc = docOf(code);
    assert.ok(doc.meta.id.startsWith('practice-') && !altIds.has(doc.meta.id));
  }
});

test('docs: no shooter, respawning bots, 24 h, rules.practice, no blocks, no player death, envelope shape', () => {
  let strafers = 0;
  for (const code of codes()) {
    const env = P.practiceScene(MODS, code);
    for (const k of ['authorNickname', 'description', 'name', 'sceneHash', 'sceneKey', 'doc']) assert.equal(typeof env[k], 'string', k);
    assert.equal(env.shareCode, code);
    assert.equal(env.playCount, 0); // the brief card calls playCount.toLocaleString() when there is an author
    assert.equal(env.docBytes, Buffer.byteLength(env.doc));
    const doc = JSON.parse(env.doc);
    const opts = P.parseCode(code);
    assert.equal(doc.rules.duration, 86400);
    assert.equal(doc.rules.practice, true);
    assert.equal(doc.rules.round, undefined);
    assert.equal(doc.rules.playerDeath, undefined);
    assert.equal(doc.rules.weapon, opts.weapon);
    assert.deepEqual(doc.blocks, []);
    assert.equal(doc.environment.map, opts.map);
    const area = areas.maps[opts.map].areas.find((a) => a.id === opts.area);
    assert.deepEqual(doc.playerSpawn, { position: { x: area.spawn.x, y: area.spawn.y, z: area.spawn.z }, yaw: area.spawn.yaw });
    assert.equal(doc.spawners.length, Math.min(opts.count, area.spots.length));
    const tm = new Map(doc.actors.map((a) => [a.id, a]));
    for (const s of doc.spawners) {
      assert.equal(s.kind, 'fixed');
      assert.equal(s.maxAlive, 1);
      assert.deepEqual(s.spawnDelay, [0.3, 0.3]);
      const t = tm.get(s.actorTemplateId);
      assert.ok(t, 'template');
      assert.ok(!t.behaviors.some((b) => b.kind === 'shooter'), 'bots never shoot');
      const resp = t.behaviors.filter((b) => b.kind === 'respawn');
      assert.equal(resp.length, 1);
      assert.deepEqual(resp[0].delay, [1.5, 1.5]);
      const strafe = t.behaviors.find((b) => b.kind === 'strafe');
      assert.equal(resp[0].mode, strafe ? 'reSpawner' : 'inPlace');
      if (strafe) {
        strafers++;
        assert.equal(opts.bots, 'strafe');
        assert.ok(strafe.travel[1] <= P.MAX_SWING + 1e-9 && strafe.travel[0] > 0 && strafe.travel[0] <= strafe.travel[1]);
        // The swing (+-travel/2 around home along the right vector of rotationY) stays on the lane.
        const spot = area.spots.find((p) => p.lane && Math.abs(p.x + p.lane[0] * (p.lane[2] + p.lane[3]) / 2 - s.position.x) < 0.002 && Math.abs(p.z + p.lane[1] * (p.lane[2] + p.lane[3]) / 2 - s.position.z) < 0.002);
        assert.ok(spot, 'strafer home is a lane middle');
        const [ax, az, lo, hi] = spot.lane;
        assert.ok(Math.abs(Math.cos(s.rotationY) - ax) < 0.002 && Math.abs(-Math.sin(s.rotationY) - az) < 0.002, 'right vector = lane axis');
        assert.ok(strafe.travel[1] / 2 <= (hi - lo) / 2 + 1e-6);
      }
    }
  }
  assert.ok(strafers > 0);
});

test('every generated scene passes the game\'s own scene validator (all 9 maps)', { skip: !fs.existsSync(path.join(root, JS[0], 'D_iGclxB.js')) && 'no validator' }, async () => {
  const src = read(JS[0], 'D_iGclxB.js').replace(/^import \{mapIds as localMapIds\} from "\/local\/map-registry\.mjs";/m, `const localMapIds=${JSON.stringify(ALL_MAPS)};`);
  assert.ok(src.startsWith('const localMapIds'), 'validator import line changed');
  const tmp = path.join(os.tmpdir(), `aim-practice-validator-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    const { p: validate } = await import(pathToFileURL(tmp).href);
    assert.throws(() => validate(JSON.stringify({ schemaVersion: 2 })));
    assert.throws(() => validate(JSON.stringify({ ...docOf(`practice-ascent-${areas.maps.ascent.areas[0].id}-vandal-static-3`), environment: { map: 'nosuchmap' } })));
    let n = 0;
    for (const code of codes()) { validate(P.practiceScene(MODS, code).doc); n++; }
    assert.ok(n >= 9 * 2 * 5);
  } finally { fs.rmSync(tmp, { force: true }); }
});

// ---------------------------------------------------------------- shell + patch
test('main.js serves practice scenes and injects the panel; package.json ships both files', () => {
  const main = read('app', 'main.js');
  assert.match(main, /require\("\.\/practice-scene"\)/);
  assert.match(main, /rounds\.roundScene\(MODS, code\) \|\| practice\.practiceScene\(MODS, code\)/);
  assert.match(main, /\["PRACTICE PANEL", PRACTICE_PANEL_JS\]/);
  const pkg = JSON.parse(read('app', 'package.json'));
  for (const f of ['practice-scene.js', 'practice-panel.js']) assert.ok(pkg.build.files.includes(f), f);
  const panel = read('app', 'practice-panel.js');
  for (const id of ALL_MAPS) assert.ok(panel.includes(`["${id}",`), `panel lists ${id}`);
  // A launch without a map id races the map download and drops back to the lobby (cold map).
  assert.match(panel, /__aimLaunchScene\(\{ shareCode: code, .*, mapId: cur\.map \}\)/);
  assert.doesNotMatch(panel, /mapId: null/);
  assert.match(read('app', 'lobby-bar.js'), /__aimPracticePanel\?\.open\(\)/);
});

test('play page patched once in both copies (replay off, run flag, no timer chip), copies identical', () => {
  const a = read(JS[0], 'OkAdunfX.js'), b = read(JS[1], 'OkAdunfX.js');
  assert.equal(a, b);
  const count = (s) => a.split(s).length - 1;
  assert.equal(count('Je=F.rules.round?null:h0(F,de,{'), 1); // round_patch's line, untouched (test-round looks for it)
  assert.equal(count('rulesVersion:Z.rulesVersion}:{}}),F.rules.practice&&(Je=null),Ve=av(F),'), 1);
  // ...and the drop sits right after that recorder line, inside the same To() statement.
  const je = a.indexOf('Je=F.rules.round?null:h0(F,de,{'), drop = a.indexOf('F.rules.practice&&(Je=null)');
  assert.ok(je > 0 && drop > je && drop - je < 600 && !a.slice(je, drop).includes(';'));
  assert.equal(count('window.__aimPracticeOn=!!F?.rules?.practice;window.__aimRoundOn=!!cfg;if(!cfg)return;'), 1);
  assert.equal(count('window.__aimRoundOn=!1;window.__aimPracticeOn=!1;window.__aimRound=null;'), 1);
  assert.equal(count('function rM(e){if(window.__aimRoundOn||window.__aimPracticeOn)return['), 1);
  assert.equal(count('__aimPracticeOn'), 3);
  // Running it again refuses and changes nothing.
  const py = process.platform === 'win32' ? 'python' : 'python3';
  let refused = false;
  try { execFileSync(py, ['-I', path.join(root, 'tools', 'practice_patch.py')], { stdio: 'pipe' }); } catch (e) { refused = /already patched/.test(String(e.stderr)); }
  assert.ok(refused, 'second run must refuse');
  assert.equal(read(JS[0], 'OkAdunfX.js'), a);
});

// ---------------------------------------------------------------- real sim
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
const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
const createSim = (doc, bots, seed = 5) => sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed, ...(bots ? { bots } : {}) });
const play = (s, n, input = IDLE) => { const ev = []; for (let i = 0; i < n; i++) ev.push(...s.step(input)); return ev; };

// A real practice doc moved onto flat ground: same templates and spawners, player at the origin,
// every spot at its offset from the area spawn (y 0), no map.
function flat(code) {
  const doc = docOf(code);
  const o = doc.playerSpawn.position;
  doc.environment = { skyColor: '#111820', fogNear: 14, fogFar: 33, ambientIntensity: 1, keyLightIntensity: 1, fogEnabled: false };
  doc.blocks = [{ id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 400, y: 0.4, z: 400 }, color: '#18222b', collidable: true }];
  for (const s of doc.spawners) s.position = { x: s.position.x - o.x, y: 0, z: s.position.z - o.z };
  doc.playerSpawn = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  return doc;
}
function kill(s, pred) {
  const st = s.saveState();
  let n = 0;
  for (const a of st.actors) if (a.alive && pred(a)) { a.alive = false; a.health = 0; n++; }
  s.restoreState(st);
  return n;
}

for (const bots of [undefined, 'human']) {
  test(`sim (${bots ?? 'classic'} bots): killed bots are back 1.5 s later, 20 times; the actor list never grows; never out of targets`, { skip }, () => {
    const a = areas.maps.juliett.areas.find((x) => x.id === 'bmain') ?? areas.maps.juliett.areas[0];
    for (const kind of ['static', 'strafe']) {
      const doc = flat(`practice-juliett-${a.id}-vandal-${kind}-5`);
      const s = createSim(doc, bots);
      play(s, Math.ceil(0.5 * TPS));
      let snap = s.snapshot();
      assert.equal(snap.actors.length, 5, `${kind}: all 5 spawned`);
      assert.ok(snap.actors.every((x) => x.alive));
      for (let round = 0; round < 20; round++) {
        const victim = snap.actors[round % 5].id;
        assert.equal(kill(s, (x) => x.id === victim), 1);
        let back = -1;
        for (let t = 1; t <= Math.ceil(2 * TPS); t++) {
          s.step(IDLE);
          assert.equal(s.targetsExhausted(), false);
          const v = s.snapshot().actors.find((x) => x.id === victim);
          if (v.alive && v.visible !== false) { back = t; break; }
        }
        assert.ok(back > 0, `${kind} round ${round}: not back within 2 s`);
        // The respawn timer starts on the first tick that sees the bot dead (+1 tick); a reSpawner
        // bot is shown on the spawner pass after it revives (+1 more).
        assert.ok(Math.abs(back / TPS - 1.5) <= (kind === 'strafe' ? 2 : 1) / TPS + 1e-9, `${kind} round ${round}: back after ${(back / TPS).toFixed(3)} s`);
        snap = s.snapshot();
        assert.equal(snap.actors.length, 5, 'actor list grew');
        const v = snap.actors.find((x) => x.id === victim);
        const sp = doc.spawners.find((x) => x.id === v.spawnerId);
        if (kind === 'strafe' && sp.rotationY !== undefined) assert.ok(Math.hypot(v.position.x - sp.position.x, v.position.z - sp.position.z) < 0.05, 'strafer comes back at its home');
        play(s, 37);
      }
    }
  });

  test(`sim (${bots ?? 'classic'} bots): a real shot kill also brings the bot back after 1.5 s`, { skip }, () => {
    const a = areas.maps.juliett.areas[0];
    const doc = flat(`practice-juliett-${a.id}-vandal-static-1`);
    doc.spawners[0].position = { x: 0, y: 0, z: -8 }; // straight ahead (yaw 0 looks down -z)
    const s = createSim(doc, bots);
    play(s, Math.ceil(0.5 * TPS));
    let killedAt = -1;
    for (let t = 0; t < 3 * TPS && killedAt < 0; t++) {
      const ev = s.step({ ...IDLE, fire: true });
      if (ev.some((e) => e.kind === 'kill')) killedAt = t;
    }
    assert.ok(killedAt >= 0, 'no kill from shooting a bot 8 m ahead');
    let back = -1;
    for (let t = 1; t <= 2 * TPS && back < 0; t++) { s.step(IDLE); if (s.snapshot().actors[0].alive) back = t; }
    assert.ok(back > 0 && Math.abs(back / TPS - 1.5) <= 1 / TPS + 1e-9, `back after ${(back / TPS).toFixed(3)} s`);
    assert.equal(s.snapshot().actors.length, 1);
    assert.equal(s.targetsExhausted(), false);
  });

  test(`sim (${bots ?? 'classic'} bots): strafing bots stay on their lane for 60 s (+-travel/2 along the lane axis)`, { skip }, () => {
    let checked = 0;
    for (const [map, m] of Object.entries(areas.maps)) {
      const a = m.areas[0];
      const doc = flat(`practice-${map}-${a.id}-vandal-strafe-12`);
      const tm = new Map(doc.actors.map((x) => [x.id, x]));
      const s = createSim(doc, bots);
      const far = new Map(), side = new Map();
      for (let t = 0; t < 60 * TPS; t++) {
        s.step(IDLE);
        if (t % 8) continue;
        for (const x of s.snapshot().actors) {
          const sp = doc.spawners.find((q) => q.id === x.spawnerId);
          if (!tm.get(sp.actorTemplateId).behaviors.some((b) => b.kind === 'strafe')) continue;
          const dx = x.position.x - sp.position.x, dz = x.position.z - sp.position.z;
          const ax = Math.cos(sp.rotationY), az = -Math.sin(sp.rotationY);
          far.set(sp.id, Math.max(far.get(sp.id) ?? 0, Math.abs(dx * ax + dz * az)));
          side.set(sp.id, Math.max(side.get(sp.id) ?? 0, Math.abs(-dx * az + dz * ax)));
        }
      }
      for (const sp of doc.spawners) {
        const strafe = tm.get(sp.actorTemplateId).behaviors.find((b) => b.kind === 'strafe');
        if (!strafe) continue;
        checked++;
        assert.ok(far.get(sp.id) <= strafe.travel[1] / 2 + 0.05, `${map} ${sp.id}: ${far.get(sp.id)?.toFixed(3)} m along the lane > ${strafe.travel[1] / 2}`);
        assert.ok(far.get(sp.id) >= 0.15, `${map} ${sp.id}: never moved`);
        assert.ok(side.get(sp.id) <= 0.05, `${map} ${sp.id}: ${side.get(sp.id)?.toFixed(3)} m off the lane axis`);
      }
    }
    assert.ok(checked >= 9);
  });
}
