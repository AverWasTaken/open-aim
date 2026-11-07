// Crosshair spread (tools/feel_xbloom_patch.py): the sim's read-only aimErrDeg() accessor in the
// real patched sim (app/mods/next/js/CnrSARj_.js, loaded headless via scripts/sim-loader.mjs), and
// the patch script itself. Sim tests need the game files in site/; skipped without them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
// Live settings: game2 recoil, game movement (the play page's defaults).
const createSim = (doc, opts = {}) => sim.c(doc, { sensitivity: 1, zoomSensitivity: { ads: 1, scoped: 1 }, seed: 7, recoil: 'game2', movement: 'game', ...opts }); // OkAdunfX: c as p0

// Flat ground, player at the origin, no bots (nothing to hit, nothing random but recoil).
function flatDoc({ weapon = 'vandal', perfectAccuracy = false } = {}) {
  return {
    schemaVersion: 2, meta: { id: 'xbloom-test', name: 'xbloom test', seed: 1, createdAt: 0 },
    environment: { skyColor: '#111820', fogNear: 14, fogFar: 33, ambientIntensity: 1, keyLightIntensity: 1, fogEnabled: false },
    blocks: [{ id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 400, y: 0.4, z: 400 }, color: '#18222b', collidable: true }],
    playerSpawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 }, spawners: [], actors: [],
    rules: { duration: 300, scoring: 'clicking', weapon, playerMovable: true, fireMode: 'hold', buyMenu: false, limitedAmmo: false, ...(perfectAccuracy ? { perfectAccuracy: true } : {}) },
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
const shots = (ev) => ev.filter((e) => e.kind === 'shot');
const FIRE = { ...IDLE, fire: true };
const STRAFE = { ...IDLE, strafe: 1 };

test('calling aimErrDeg() every tick changes nothing: events, snapshot and saveState are identical', { skip }, () => {
  for (const weapon of ['vandal', 'phantom']) {
    const script = (i) => {
      const t = i % (TPS * 6);
      if (t < TPS) return IDLE;
      if (t < TPS * 2) return FIRE; // spray
      if (t < TPS * 3) return { ...STRAFE, strafe: t % 64 < 32 ? 1 : -1 }; // strafe
      if (t < TPS * 3.5) return { ...STRAFE, fire: true, forward: 1 }; // run and gun
      return IDLE; // rest
    };
    const run = (probe) => {
      const s = createSim(flatDoc({ weapon }));
      const seen = [];
      const ev = [];
      for (let i = 0; i < TPS * 14; i++) {
        if (i === TPS * 6) s.setZoomLevel(1); // second loop in ADS
        if (i === TPS * 12) s.setZoomLevel(0);
        if (probe) seen.push(s.aimErrDeg(), s.aimErrDeg());
        ev.push(...s.step(script(i)));
        if (probe) seen.push(s.aimErrDeg());
      }
      return { json: JSON.stringify({ ev, snap: s.snapshot(), save: s.saveState() }), seen, ev };
    };
    const a = run(false), b = run(true);
    assert.equal(a.json, b.json, `${weapon}: probing changed the run`);
    assert.ok(shots(a.ev).length > 20, `${weapon}: the script fired (${shots(a.ev).length} shots)`);
    assert.ok(b.seen.some((e) => e.fire > 0) && b.seen.some((e) => e.move > 0), `${weapon}: probe saw bloom and movement`);
    assert.ok(b.seen.every((e) => Number.isFinite(e.fire) && Number.isFinite(e.fireRaw) && Number.isFinite(e.move) && e.fire >= 0 && e.move >= 0));
  }
});

test('from rest, fireRaw is exactly the first shot\'s firingDeg (hip and ADS)', { skip }, () => {
  for (const weapon of ['vandal', 'phantom']) {
    for (const zoom of [0, 1]) {
      const s = createSim(flatDoc({ weapon }));
      s.setZoomLevel(zoom);
      play(s, TPS * 2);
      const e = s.aimErrDeg();
      assert.ok(e.fire < 1e-9, `${weapon} zoom ${zoom}: no bloom at rest (${e.fire})`);
      assert.equal(e.move, 0);
      let shot = null, before = null;
      for (let i = 0; i < TPS && !shot; i++) {
        before = s.aimErrDeg();
        shot = shots(s.step(FIRE))[0] ?? null;
      }
      assert.ok(shot, `${weapon} zoom ${zoom}: fired`);
      assert.ok(typeof shot.firingDeg === 'number' && shot.firingDeg > 0, `${weapon} zoom ${zoom}: shot has firingDeg`);
      assert.equal(before.fireRaw, shot.firingDeg, `${weapon} zoom ${zoom}`);
      assert.equal(before.fireRaw, e.fireRaw, 'resting value is stable');
    }
  }
});

test('spray blooms above the resting error, 2 s of rest brings it back to 0', { skip }, (t) => {
  for (const weapon of ['vandal', 'phantom']) {
    for (const zoom of [0, 1]) {
      const s = createSim(flatDoc({ weapon }));
      s.setZoomLevel(zoom);
      play(s, TPS);
      const rest = s.aimErrDeg().fireRaw;
      let n = 0, i = 0;
      while (n < 5 && i++ < TPS * 2) n += shots(s.step(FIRE)).length;
      assert.equal(n, 5);
      const e = s.aimErrDeg();
      const want = zoom ? 0.05 : 0.2;
      assert.ok(e.fire > want, `${weapon} zoom ${zoom}: bloom after 5 shots ${e.fire.toFixed(3)} > ${want}`);
      assert.ok(Math.abs(e.fireRaw - rest - e.fire) < 1e-9, 'fire = fireRaw - resting');
      t.diagnostic(`${weapon} zoom ${zoom}: rest ${rest.toFixed(4)} deg, bloom after 5 shots ${e.fire.toFixed(4)} deg`);
      play(s, TPS * 2);
      const r = s.aimErrDeg();
      assert.ok(r.fire < 1e-6, `${weapon} zoom ${zoom}: back to rest (${r.fire})`);
      assert.ok(Math.abs(r.fireRaw - rest) < 1e-6);
    }
  }
});

test('movement error: > 0 while strafing, 0 at rest, hip and ADS', { skip }, (t) => {
  const s = createSim(flatDoc());
  play(s, TPS);
  assert.equal(s.aimErrDeg().move, 0);
  play(s, TPS / 2, STRAFE);
  const hip = s.aimErrDeg().move;
  assert.ok(hip > 0.5, `strafing hip move error ${hip}`);
  play(s, TPS);
  assert.equal(s.aimErrDeg().move, 0, 'stopped');
  s.setZoomLevel(1);
  play(s, TPS / 2, STRAFE);
  const ads = s.aimErrDeg().move;
  assert.ok(ads > 0 && Number.isFinite(ads), `strafing ADS move error ${ads} (hip ${hip})`);
  t.diagnostic(`move error strafing: hip ${hip.toFixed(3)} deg, ADS ${ads.toFixed(3)} deg`);
  play(s, TPS);
  assert.equal(s.aimErrDeg().move, 0);
});

test('perfect accuracy and legacy recoil/movement give 0 (nothing to show)', { skip }, () => {
  const all = (s) => { const e = s.aimErrDeg(); return e.fire + e.fireRaw + e.move; };
  const p = createSim(flatDoc({ perfectAccuracy: true }));
  let seen = 0;
  play(p, TPS, (i) => (i % 2 ? FIRE : STRAFE), (s) => { seen += all(s); });
  assert.equal(seen, 0);
  const legacy = createSim(flatDoc(), { recoil: 'legacy', movement: 'legacy' });
  let fl = 0;
  play(legacy, TPS, FIRE, (s) => { fl += s.aimErrDeg().fire + s.aimErrDeg().fireRaw; });
  assert.equal(fl, 0);
});

// ---- patch script ----
const DIRS = [path.join('next', 'js'), path.join('_assets', 'r20261021-1', 'next', 'js')];
const MODS = path.join(root, 'app', 'mods');
const read = (dir, f) => fs.readFileSync(path.join(MODS, dir, f), 'utf-8');
const count = (s, sub) => s.split(sub).length - 1;

test('patch: markers once in both copies, copies identical, main.js strings intact', () => {
  for (const f of ['CnrSARj_.js', 'OkAdunfX.js']) {
    const [a, b] = DIRS.map((d) => read(d, f).replace(/\r\n/g, '\n'));
    assert.equal(a, b, `${f} copies differ`);
  }
  const cnr = read(DIRS[0], 'CnrSARj_.js'), oka = read(DIRS[0], 'OkAdunfX.js');
  assert.equal(count(cnr, 'aimErrDeg(){'), 1);
  assert.equal(count(oka, 'function __aimXbloomStep('), 1);
  assert.equal(count(oka, '__aimXbloomStep(__aimXbBase.value,'), 1);
  assert.equal(count(oka, 't.adsSight.current.crosshairError=__aimXbloomErr(de,'), 1);
  // app/main.js rewrites these while serving OkAdunfX.js.
  assert.equal(count(oka, 'const ce=hs(de);for(const xe of Cn)'), 1);
  assert.equal(count(oka, 'xe.kind==="shot"&&(Kt.push(xe.tick*ve)'), 1);
});

test('patch: a second run refuses and writes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xbloom-'));
  try {
    for (const d of DIRS) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
      for (const f of ['CnrSARj_.js', 'OkAdunfX.js']) fs.copyFileSync(path.join(MODS, d, f), path.join(tmp, d, f));
    }
    const before = DIRS.map((d) => fs.readFileSync(path.join(tmp, d, 'OkAdunfX.js')));
    const r = spawnSync('python', ['-I', path.join(root, 'tools', 'feel_xbloom_patch.py'), '--mods', tmp], { encoding: 'utf-8' });
    if (r.error) return; // no python on this machine: nothing to check
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /already patched/);
    DIRS.forEach((d, i) => assert.ok(fs.readFileSync(path.join(tmp, d, 'OkAdunfX.js')).equals(before[i])));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
