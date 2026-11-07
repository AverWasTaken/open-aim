// Bot hit flash + death animation (tools/graphics_botfx_patch.py): the patch is in both copies of
// the mods CnrSARj_.js exactly once and only inside the actor renderer Uf (render side, no sim
// code), and the real patched renderer, driven headless with the real sim's snapshots, plays the
// humanoid death drop and white hit pulse, restores everything after, and leaves spheres (grid
// dots) exactly as before. Needs the game files in site/ for the renderer tests (skipped without them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPIES = [
  path.join(root, 'app', 'mods', 'next', 'js', 'CnrSARj_.js'),
  path.join(root, 'app', 'mods', '_assets', 'r20261021-1', 'next', 'js', 'CnrSARj_.js'),
];
const MARKER = '/* graphics-botfx */';
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js'));
const skip = !HAVE_SITE && 'no game files in site/';

// Fake clock for the wall-clock death timer (performance.now inside the patched renderer).
let clock = 1000;
globalThis.performance.now = () => clock;

let sim = null;
if (HAVE_SITE) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(COPIES[0]).href);
}

const count = (s, sub) => s.split(sub).length - 1;
const SNIPPETS = [
  MARKER,
  'aimBfxStart(t)',
  't.mesh.root.visible=aimBfxDying(t)||a}',
  'i.aimHitTick=H.tick,i.aimHitHead=H.hitPart==="head"',
  'l=a&&!i.mesh.skin?t?.hit??i.mesh.hitColor:r,',
  'aimCacheActorScale(i.mesh.pivot,J),aimBfxPivot(i,J),',
  'aimBfxGlow(i,s.tick+(+L||0),r)',
  'H.aimDie>=0||jQ(H.mesh,i,a,__aimCrouch)',
];

test('patch is in both copies once, the copies are byte-identical, and it only touches the renderer Uf', () => {
  const [a, b] = COPIES.map((p) => fs.readFileSync(p));
  assert.ok(a.equals(b), 'the two CnrSARj_.js copies differ');
  const src = a.toString('utf-8');
  for (const s of SNIPPETS) assert.equal(count(src, s), 1, `expected exactly one ${s}`);
  // Every aimBfx reference sits between the injected helpers and the end of Uf (its clear()).
  const start = src.indexOf(MARKER);
  const ufStart = src.indexOf('function Uf(A,g,D,w){');
  const ufEnd = src.indexOf('clear(){for(const s of B.values())M(s);B.clear()', ufStart);
  assert.ok(start >= 0 && ufStart > start && ufEnd > ufStart);
  let at = -1;
  while ((at = src.indexOf('aimBfx', at + 1)) >= 0) assert.ok(at > start && at < ufEnd, `aimBfx outside Uf at ${at}`);
  assert.equal(count(src, 'aimDie'), count(src.slice(start, ufEnd), 'aimDie'));
});

test('the patch script refuses to run twice (on a temp copy, never the repo files)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimbfx-'));
  try {
    const rels = [['next', 'js'], ['_assets', 'r20261021-1', 'next', 'js']];
    rels.forEach((rel, k) => {
      fs.mkdirSync(path.join(tmp, ...rel), { recursive: true });
      fs.copyFileSync(COPIES[k], path.join(tmp, ...rel, 'CnrSARj_.js'));
    });
    const r = spawnSync('python', ['-I', path.join(root, 'tools', 'graphics_botfx_patch.py'), '--mods', tmp], { encoding: 'utf-8' });
    assert.ok(!r.error, `python not runnable: ${r.error}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /already patched/);
    rels.forEach((rel, k) => assert.ok(fs.readFileSync(path.join(tmp, ...rel, 'CnrSARj_.js')).equals(fs.readFileSync(COPIES[k])), 'nothing written'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- renderer, headless ----
const ID = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };
function sceneDoc(pred) {
  const ts = JSON.parse(fs.readFileSync(path.join(root, 'app', 'training-set.json'), 'utf-8'));
  return Object.values(ts.scenes).map((s) => JSON.parse(s.doc)).find((d) => !d.environment.map && pred(d));
}
// Real sim snapshot after a few idle ticks, plus the renderer and its per-actor roots by actor id.
function setup(shape) {
  const doc = sceneDoc((d) => d.actors.length > 0 && d.actors.every((a) => a.body.shape === shape));
  assert.ok(doc, `a shipped ${shape} drill`);
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed: 3 });
  let snap = null;
  for (let i = 0; i < 200; i++) {
    s.step(IDLE);
    snap = s.snapshot();
    if (snap.actors.some((a) => a.alive && a.visible)) break;
  }
  const actor = snap.actors.find((a) => a.alive && a.visible);
  assert.ok(actor, 'a live actor');
  const scene = sim.h(doc);
  const cam = { position: { set() {} }, rotation: { set() {} }, updateMatrixWorld() {}, projectionMatrix: { elements: [1e-4, 0, 0, 0, 0, 1e-4, 0, 0, 0, 0, 1e-4, 0, 0, 0, 0, 1] } /* frustum = +-10 km box: nothing culled */, matrixWorldInverse: { elements: ID() } };
  const r = sim.i(scene, cam, {}, doc.rules);
  const before = new Set(scene.root.children);
  r.apply(snap, [], 0.5, null, null);
  const added = scene.root.children.filter((c) => !before.has(c));
  // The renderer adds one root per actor, in snapshot order.
  const live = snap.actors.filter((a) => scene.actorTemplates.has(a.templateId));
  const rootOf = new Map(live.map((a, k) => [a.id, added[k]]));
  return { doc, snap, scene, r, actor, root: rootOf.get(actor.id) };
}
const at = (snap, tick, id, patch) => ({ ...snap, tick, actors: snap.actors.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
const pivotOf = (root) => root.children[0];
const mat = (root) => {
  let m = null;
  root.traverse((o) => { if (!m && (o.isSkinnedMesh || o.isMesh) && o.material?.emissive) m = o.material; });
  return m;
};
const lum = (c) => c.r + c.g + c.b;

test('sphere (grid dot): no new fx, a kill hides it at once as before', { skip }, () => {
  const { snap, r, actor, root } = setup('sphere');
  const pivot = pivotOf(root);
  const s0 = pivot.scale.x;
  const e0 = mat(root).emissive.clone();
  const T = snap.tick;
  clock = 5000;
  r.apply(at(snap, T + 1, actor.id, { alive: false }), [], 0, null, null);
  assert.equal(root.visible, false, 'hidden at the kill (no pop)');
  clock += 30; r.apply(at(snap, T + 2, actor.id, { alive: false }), [], 0, null, null);
  assert.equal(root.visible, false);
  assert.equal(pivot.scale.x, s0);
  assert.ok(mat(root).emissive.equals(e0), 'no glow');
});

test('a time-out (hidden at death) is not animated; a respawn cancels a running death', { skip }, () => {
  const { snap, r, actor, root } = setup('humanoid');
  const T = snap.tick;
  const s0 = pivotOf(root).scale.x;
  clock = 9000;
  r.apply(at(snap, T + 1, actor.id, { alive: false, visible: false }), [], 0, null, null);
  assert.equal(root.visible, false);
  // Back alive, then killed, then respawned (new bornTick) 20 ms later.
  r.apply(at(snap, T + 2, actor.id, { bornTick: T + 2 }), [], 0, null, null);
  const y0 = root.position.y, yaw0 = root.rotation.y;
  r.apply(at(snap, T + 3, actor.id, { bornTick: T + 2, alive: false }), [], 0, null, null);
  clock += 20; r.apply(at(snap, T + 4, actor.id, { bornTick: T + 2, alive: false }), [], 0, null, null);
  assert.ok(pivotOf(root).rotation.x !== 0 && root.visible, 'dying');
  clock += 10; r.apply(at(snap, T + 5, actor.id, { bornTick: T + 5 }), [], 0, null, null);
  assert.equal(root.visible, true);
  const s = pivotOf(root).scale;
  assert.equal(s.x, s.y);
  assert.equal(s.x, s0, 'scale restored');
  assert.equal(root.position.y, y0, 'sunk position restored (respawn at the same spot)');
  assert.equal(root.rotation.y, yaw0, 'yaw restored');
});

test('sphere hit: origin look (hit colour for the flash ticks, emissive untouched)', { skip }, () => {
  const { snap, r, actor, root } = setup('sphere');
  const m = mat(root);
  const T = snap.tick;
  r.apply(at(snap, T + 1, actor.id, {}), [], 0, null, null);
  const base = m.emissive.clone();
  const color = m.color.getHex();
  const shot = { tick: T + 2, kind: 'shot', hitActorId: actor.id, hitPart: 'body' };
  r.apply(at(snap, T + 2, actor.id, {}), [shot], 0, null, null);
  assert.ok(m.emissive.equals(base), 'no emissive pulse');
  assert.notEqual(m.color.getHex(), color, "the game's own hit colour");
  for (let k = 3; k < 40; k++) r.apply(at(snap, T + k, actor.id, {}), [], 0, null, null);
  assert.ok(m.emissive.equals(base));
  assert.equal(m.color.getHex(), color, 'colour back');
});

test('humanoid: kill drops (sinks, squashes, pose frozen, white-hot) and is gone after 220 ms', { skip }, () => {
  const { snap, r, actor, root } = setup('humanoid');
  const pivot = pivotOf(root);
  const T = snap.tick;
  r.apply(at(snap, T + 1, actor.id, {}), [], 0, null, null);
  const y0 = root.position.y;
  const s0 = pivot.scale.x;
  clock = 20000;
  r.apply(at(snap, T + 2, actor.id, { alive: false }), [], 0, null, null);
  assert.equal(root.visible, true);
  clock += 110; r.apply(at(snap, T + 3, actor.id, { alive: false }), [], 0, null, null);
  assert.ok(root.position.y < y0 - 0.05, `sinks (${root.position.y} vs ${y0})`);
  assert.ok(pivot.scale.y < s0 * 0.95, 'squashes');
  assert.ok(pivot.rotation.x !== 0, 'tips');
  assert.ok(lum(mat(root).emissive) > 1.5, 'white-hot');
  clock += 100; r.apply(at(snap, T + 4, actor.id, { alive: false }), [], 0, null, null);
  assert.ok(pivot.scale.y < s0 * 0.3, 'shrinks away at the end');
  clock += 20; r.apply(at(snap, T + 5, actor.id, { alive: false }), [], 0, null, null);
  assert.equal(root.visible, false, 'gone after 220 ms');
  assert.equal(pivot.rotation.x, 0);
  assert.equal(pivot.scale.y, s0);
  assert.equal(lum(mat(root).emissive), 0, 'emissive back to black');
});

test('humanoid hit: white pulse (holds, then eases out) instead of the inverted tint; headshot stronger and longer', { skip }, () => {
  const { snap, r, actor, root } = setup('humanoid');
  const m = mat(root);
  const T = snap.tick;
  r.apply(at(snap, T + 1, actor.id, {}), [], 0, null, null);
  const color = m.color.clone();
  const lumAt = (tick) => { r.apply(at(snap, tick, actor.id, {}), [], 0, null, null); return lum(m.emissive); };
  const pulse = (part, tick) => {
    r.apply(at(snap, tick, actor.id, {}), [{ tick, kind: 'shot', hitActorId: actor.id, hitPart: part }], 0, null, null);
    const p = lum(m.emissive);
    assert.ok(m.color.equals(color), 'colour untouched (no inverted tint)');
    const held = lumAt(tick + 4);
    const t19 = lumAt(tick + 19);
    for (let k = 20; k < 40; k++) r.apply(at(snap, tick + k, actor.id, {}), [], 0, null, null);
    assert.equal(lum(m.emissive), 0, 'emissive restored');
    assert.ok(m.color.equals(color), 'colour restored');
    return { p, held, t19 };
  };
  const body = pulse('body', T + 2);
  const head = pulse('head', T + 50);
  assert.ok(body.p > 1, `body pulse visible (${body.p})`);
  assert.equal(body.held, body.p, 'body pulse holds its peak for 4 ticks (~31 ms)');
  assert.ok(head.p > body.p * 1.3, 'headshot brighter');
  assert.equal(body.t19, 0, 'body pulse over by 19 ticks');
  assert.ok(head.t19 > 0, 'headshot pulse still going at 19 ticks');
});

test('hit and kill on the same tick: white-hot drop, then everything restored', { skip }, () => {
  const { snap, r, actor, root } = setup('humanoid');
  const m = mat(root);
  const T = snap.tick;
  r.apply(at(snap, T + 1, actor.id, {}), [], 0, null, null);
  const color = m.color.clone();
  clock = 40000;
  r.apply(at(snap, T + 2, actor.id, { alive: false }), [{ tick: T + 2, kind: 'shot', hitActorId: actor.id, hitPart: 'head' }], 0, null, null);
  assert.equal(root.visible, true);
  assert.ok(lum(m.emissive) > 1.5, 'white-hot');
  for (let k = 3; k < 40; k++) { clock += 10; r.apply(at(snap, T + k, actor.id, { alive: false }), [], 0, null, null); }
  assert.equal(root.visible, false, 'gone');
  assert.equal(lum(m.emissive), 0, 'emissive back to black');
  assert.ok(m.color.equals(color), 'colour untouched');
});

test('clear() drops all death/flash state (replay seek)', { skip }, () => {
  const { snap, r, actor, scene } = setup('humanoid');
  const T = snap.tick;
  r.apply(at(snap, T + 1, actor.id, { alive: false }), [], 0, null, null);
  r.clear();
  const before = new Set(scene.root.children);
  r.apply(at(snap, T + 2, actor.id, { alive: false }), [], 0, null, null);
  const added = scene.root.children.filter((c) => !before.has(c));
  const live = snap.actors.filter((a) => scene.actorTemplates.has(a.templateId));
  const root = added[live.findIndex((a) => a.id === actor.id)];
  assert.equal(root.visible, false, 'a fresh renderer does not animate an already-dead actor');
});
