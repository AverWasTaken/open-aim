// Stop to shot (app/shooting-error.js) against the real patched sim (app/mods/next/js/CnrSARj_.js,
// loaded headless via scripts/sim-loader.mjs): strafe, stop (release or counter-strafe), fire a
// set time after the movement error is back to zero. The sim's snapshot goes to __aimTick every
// 2 ticks (a 64 fps frame), then that frame's shot events to __aimShot, like the game's frame
// loop. Needs the game files in site/; skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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
const MS = 1000 / 128;
const CLEAN = 0.01; // same "still" line as shooting-error.js
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
const createSim = (doc) => sim.c(doc, { sensitivity: 1, zoomSensitivity: { ads: 1, scoped: 1 }, seed: 7, recoil: 'game2', movement: 'game' });
function flatDoc(weapon) {
  return {
    schemaVersion: 2, meta: { id: 'cstrafe-test', name: 'cstrafe test', seed: 1, createdAt: 0 },
    environment: { skyColor: '#111820', fogNear: 14, fogFar: 33, ambientIntensity: 1, keyLightIntensity: 1, fogEnabled: false },
    blocks: [{ id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 400, y: 0.4, z: 400 }, color: '#18222b', collidable: true }],
    playerSpawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 }, spawners: [], actors: [],
    rules: { duration: 300, scoring: 'clicking', weapon, playerMovable: true, fireMode: 'hold', buyMenu: false, limitedAmmo: false },
  };
}

// shooting-error.js in its own vm (its own window), with a round running
function loadGraph() {
  const listeners = {};
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; }, innerHeight: 1000, devicePixelRatio: 1 };
  const document = { querySelector: () => null, querySelectorAll: () => [], hidden: false, body: { appendChild() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app', 'shooting-error.js'), 'utf-8'), {
    window, document, console, localStorage: { getItem: () => null, setItem() {} }, performance: { now: () => 0 },
    setInterval: () => 0, setTimeout: () => 0, requestAnimationFrame: () => 0,
  });
  listeners['aim-round-phase']({ detail: { phase: 'running', previous: 'idle', mapId: 'range' } });
  return window;
}

// Strafe right for 500 ms, then stop (counter: hold left until the movement error is zero,
// else just let go), and fire `after` ticks after the first tick with zero movement error.
function run(weapon, counter, after) {
  const s = createSim(flatDoc(weapon));
  const w = loadGraph();
  let pending = [], accurate = -1, released = -1, shotTick = -1, shotMove = null, sawMe = false;
  for (let i = 0; i < 128 * 3; i++) {
    let input = IDLE;
    if (i >= 64 && i < 128) input = { ...IDLE, strafe: 1 };
    else if (i >= 128 && accurate < 0 && counter) input = { ...IDLE, strafe: -1 };
    else if (accurate >= 0 && shotTick < 0 && i >= accurate + after) input = { ...IDLE, fire: true };
    if (i === 128) released = i;
    for (const e of s.step(input)) if (e.kind === 'shot') { pending.push(e); if (shotTick < 0) { shotTick = e.tick; shotMove = e.moveDeg; } }
    const snap = s.snapshot();
    if (typeof snap.player?.meDeg === 'number') sawMe = true;
    if (i > 128 && accurate < 0 && snap.player.meDeg <= CLEAN) accurate = snap.tick;
    if (i % 2 === 1) {
      w.__aimTick(snap);
      for (const e of pending) w.__aimShot(e);
      pending = [];
    }
  }
  return { stops: JSON.parse(JSON.stringify(w.__aimShotGraph.stops())), accurate, released, shotTick, shotMove, sawMe };
}

for (const weapon of ['vandal', 'sheriff']) {
  for (const counter of [false, true]) {
    test(`${weapon}, ${counter ? 'counter-strafe' : 'release'}, fire 150 ms after accurate: one entry of about 150 ms`, { skip }, () => {
      const after = Math.round(150 / MS);
      const r = run(weapon, counter, after);
      assert.ok(r.sawMe, 'snapshot carries player.meDeg');
      assert.ok(r.accurate > 0, 'movement error went back to zero');
      const stopMs = (r.accurate - r.released) * MS;
      assert.ok(stopMs > 40 && stopMs < 250, `stop took ${stopMs} ms`);
      assert.ok(r.shotTick > 0, 'fired');
      assert.ok(r.shotMove <= CLEAN, `shot was still (moveDeg ${r.shotMove})`);
      assert.equal(r.stops.length, 1, JSON.stringify(r.stops));
      assert.equal(r.stops[0].early, false);
      const want = (r.shotTick - r.accurate) * MS;
      assert.ok(Math.abs(r.stops[0].ms - want) <= MS + 1, `got ${r.stops[0].ms} ms, want ${want} ±${MS + 1}`);
    });
  }
}

test('vandal, fire while still sliding after release: early entry, no stop-to-shot', { skip }, () => {
  const s = createSim(flatDoc('vandal'));
  const w = loadGraph();
  let pending = [], firstShot = null;
  for (let i = 0; i < 128 * 3; i++) {
    let input = IDLE;
    if (i >= 64 && i < 128) input = { ...IDLE, strafe: 1 };
    if (i === 130) input = { ...IDLE, fire: true }; // 15 ms after letting go: still moving
    for (const e of s.step(input)) if (e.kind === 'shot') { pending.push(e); firstShot ??= e; }
    if (i % 2 === 1) {
      w.__aimTick(s.snapshot());
      for (const e of pending) w.__aimShot(e);
      pending = [];
    }
  }
  assert.ok(firstShot && firstShot.moveDeg > CLEAN, 'the shot was a moving shot');
  const stops = JSON.parse(JSON.stringify(w.__aimShotGraph.stops()));
  assert.equal(stops.length, 1, JSON.stringify(stops));
  assert.equal(stops[0].early, true);
  assert.ok(stops[0].ms < 0, `ms ${stops[0].ms}`);
});
