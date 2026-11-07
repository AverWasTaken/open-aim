// A/B parity for tools/round_bots_patch.py: normal drills run exactly as they did before the
// patch. The test rebuilds the un-patched BiMsX6Xn.js / CnrSARj_.js / D_iGclxB.js in a temp folder
// by undoing the script's own (old, new) pairs (`--print-pairs`), loads both sims in this process
// (scripts/sim-loader.mjs resolves ./X.js from the importing file's folder first) and compares
// events, snapshots and the saved state of several drills tick for tick: path, cross and
// strafe/jump bots, shooters (also Human-like bots with an enemy rank, game movement), respawns.
// It only proves that THIS patch changes nothing for them. Needs the game files in site/ and Python.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(root, 'app', 'mods', 'next', 'js');
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js'));
const skip = !HAVE_SITE && 'no game files in site/';
const FILES = ['BiMsX6Xn.js', 'CnrSARj_.js', 'D_iGclxB.js'];

let patched = null, pristine = null, tmp = null;
if (HAVE_SITE) {
  const pairs = JSON.parse(execFileSync('python', ['-I', path.join(root, 'tools', 'round_bots_patch.py'), '--print-pairs'], { encoding: 'utf-8' }));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-round-bots-ab-'));
  for (const f of FILES) {
    const now = fs.readFileSync(path.join(JS, f), 'utf-8');
    let old = now;
    for (const [o, n] of [...pairs[f]].reverse()) {
      assert.equal(old.split(n).length - 1, 1, `${f}: patched text must hold exactly one ${n.slice(0, 60)}`);
      old = old.replace(n, () => o);
    }
    // Forward again must give the current file back (the pairs describe the whole patch).
    let again = old;
    for (const [o, n] of pairs[f]) { assert.equal(again.split(o).length - 1, 1, `${f}: un-patched text must hold exactly one ${o.slice(0, 60)}`); again = again.replace(o, () => n); }
    assert.equal(again, now, `${f}: the pairs don't rebuild the patched file`);
    fs.writeFileSync(path.join(tmp, f), old);
  }
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  patched = await import(pathToFileURL(path.join(JS, 'CnrSARj_.js')).href);
  pristine = await import(pathToFileURL(path.join(tmp, 'CnrSARj_.js')).href);
}

const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
const input = (i) => ({ ...IDLE, forward: i % 300 < 120 ? 1 : i % 300 < 160 ? -1 : 0, strafe: i % 90 < 30 ? 1 : i % 90 < 60 ? -1 : 0,
  mouseDx: i % 40 === 0 ? 25 : i % 40 === 20 ? -25 : 0, mouseDy: i % 70 === 0 ? 3 : 0, jump: i % 211 === 0, crouch: i % 400 > 380, fire: i % 6 < 3 });

// Synthetic path drill (the shipped set has no `path` bots): two patrolling shooters on flat ground.
function pathDoc() {
  const wp = (z) => [{ x: -6, y: 0, z }, { x: 6, y: 0, z }, { x: 6, y: 0, z: z - 4 }, { x: -6, y: 0, z: z - 4 }];
  return {
    schemaVersion: 2, meta: { id: 'ab-path', name: 'ab path', seed: 3, createdAt: 0 },
    environment: { skyColor: '#111820', fogNear: 14, fogFar: 33, ambientIntensity: 1, keyLightIntensity: 1, fogEnabled: false },
    blocks: [{ id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 80, y: 0.4, z: 80 }, color: '#18222b', collidable: true },
      { id: 'wall', shape: 'box', position: { x: 2, y: 1, z: -12 }, rotationY: 0, size: { x: 3, y: 2, z: 0.5 }, color: '#333333', collidable: true }],
    playerSpawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    spawners: [1, 2].map((i) => ({ id: `s${i}`, kind: 'fixed', actorTemplateId: `t${i}`, position: { x: -6, y: 0, z: -10 - i * 6 }, size: { x: 0, y: 0, z: 0 }, maxAlive: 1, spawnDelay: [0.2, 0.6], faceTarget: true, groundSnap: true })),
    actors: [1, 2].map((i) => ({ id: `t${i}`, name: `T${i}`, body: { shape: 'humanoid', headSize: 1, bodyWidth: 0.44, bodyHeight: 0, look: 'bot', weapon: 'vandal' }, color: '#ff4655',
      behaviors: [{ kind: 'path', waypoints: wp(-10 - i * 6), loop: true, speed: 4 + i, pauses: [{ at: 1, wait: 0.5 }] },
        { kind: 'shooter', difficulty: 'hard', reaction: [0.3, 0.45], cadence: 'weapon', aimErrorDeg: 2, maxRangeM: 60, engage: 'stop', resumeDelay: [0.4, 0.8] },
        { kind: 'respawn', delay: [0.5, 1], mode: 'reSpawner' }], hitSlow: true })),
    rules: { duration: 60, scoring: 'clicking', weapon: 'vandal', playerMovable: true, fireMode: 'hold', playerDeath: 'none', buyMenu: false },
  };
}

function digest(sim, doc, opts, ticks) {
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, ...opts });
  const h = crypto.createHash('sha256');
  let events = 0;
  for (let i = 0; i < ticks; i++) {
    const ev = s.step(input(i));
    events += ev.length;
    h.update(JSON.stringify(ev));
    if (i % 16 === 0) {
      const snap = s.snapshot();
      h.update(JSON.stringify({ p: snap.player, a: snap.actors.map((a) => [a.id, a.alive, a.position, a.facingYaw, a.health]) }));
    }
  }
  h.update(JSON.stringify(s.saveState()));
  return { hash: h.digest('hex'), events };
}

function drills() {
  const ts = JSON.parse(fs.readFileSync(path.join(root, 'app', 'training-set.json'), 'utf-8'));
  const docs = Object.values(ts.scenes).map((s) => JSON.parse(s.doc));
  const kinds = (d) => new Set(d.actors.flatMap((a) => a.behaviors.map((b) => b.kind)));
  const pick = (want) => docs.find((d) => want.every((k) => kinds(d).has(k)));
  const out = [['path + shooter (synthetic)', pathDoc()]];
  for (const want of [['cross', 'shooter'], ['cross', 'jump', 'shooter'], ['shooter', 'strafe'], ['respawn', 'shooter'], ['jump', 'strafe'], ['sway']]) {
    const d = pick(want);
    if (d) out.push([want.join(' + '), d]);
  }
  return out;
}

test('round_bots_patch.py pairs rebuild the un-patched bundles exactly', { skip }, () => {
  for (const f of FILES) {
    const a = fs.readFileSync(path.join(JS, f), 'utf-8'), b = fs.readFileSync(path.join(tmp, f), 'utf-8');
    assert.notEqual(a, b, `${f} is patched`);
    for (const m of ['round-bots.mjs', 'roundBot:', 'kind==="roundBot"', 'roundDefusing', 'roundHoldFire', 'aimRoundBotList']) assert.ok(!b.includes(m), `${f} rebuilt copy still has ${m}`);
  }
});

test('the two sims are separate module copies: only the patched one knows roundBot', { skip }, () => {
  const doc = pathDoc();
  doc.actors[0].behaviors.splice(2, 0, { kind: 'roundBot' });
  const run = (sim) => { const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed: 4 }); for (let i = 0; i < 256; i++) s.step(IDLE); return s.snapshot().actors.length; };
  assert.ok(run(patched) > 0);
  assert.throws(() => run(pristine));
});

test('normal drills run tick-for-tick the same before and after round_bots_patch.py', { skip }, () => {
  const list = drills();
  assert.ok(list.length >= 6, `found ${list.length} drills`);
  const optsList = [{ seed: 11 }, { seed: 12, bots: 'human', enemyRank: 'gold', movement: 'game' }, { seed: 13, bots: 'human', enemyRank: 'radiant' }];
  for (const [name, doc] of list) {
    for (const opts of optsList) {
      const a = digest(pristine, doc, opts, 128 * 12);
      const b = digest(patched, doc, opts, 128 * 12);
      assert.equal(b.hash, a.hash, `${name} ${JSON.stringify(opts)}: patched run differs`);
      assert.ok(a.events > 0, `${name}: no events at all`);
    }
  }
  // Control: the digest does see differences (another seed changes it).
  const [, doc] = list[0];
  assert.notEqual(digest(patched, doc, { seed: 11 }, 128 * 4).hash, digest(patched, doc, { seed: 99 }, 128 * 4).hash);
});

test.after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
