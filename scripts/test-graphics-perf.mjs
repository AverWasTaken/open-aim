// Checks for the graphics perf fixes (tools/graphics_warm_patch.py, tools/graphics_leak_patch.py,
// app/mods/aim-ui/bot-visibility.mjs time-sliced build, app/mods/aim-tracers/renderer.mjs warm draw).
// The live checks (no new program on the first shot, textures flat over retries) run in the app on
// hp: see tools/README.md "graphics perf".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = [path.join('app', 'mods', 'next', 'js'), path.join('app', 'mods', '_assets', 'r20261021-1', 'next', 'js')];
const lf = (p) => fs.readFileSync(path.join(root, p), 'utf-8').replace(/\r\n/g, '\n');
const count = (s, x) => s.split(x).length - 1;

const EDITS = {
  'OkAdunfX.js': {
    marker: '/* graphics-warm */',
    present: [
      'function B(T,X,N,W,te,__aimOut){/* graphics-warm */globalThis.__aimFxWarmN=(globalThis.__aimFxWarmN|0)+1;T.warmScene.clear()',
      'X.setRenderTarget(__aimOut??null),X.setScissorTest(!0),X.setScissor(0,0,1,1),T.tonePass.mat.uniforms.exposure.value=0,X.render(T.lightPass.scene,T.quadCam),X.render(T.tonePass.scene,T.quadCam),T.tonePass.mat.uniforms.exposure.value=1,X.setScissorTest(!1)',
      'q.__aimWarmKey!==(q.__aimWarmKey=T.toneMapping+"|"+T.outputColorSpace+"|"+(Oe?.uuid??"null"))&&(y=!0),y&&(y=!1,B(q,T,Re,W.scene,le,Oe))',
    ],
    gone: ['function B(T,X,N,W,te){', 'y&&(y=!1,B(q,T,Re,W.scene,le))'],
  },
  'BiMsX6Xn.js': {
    marker: '/* graphics-leak */',
    present: ['return s.dispose(),a.dispose(),o.texture.__aimRT=o/* graphics-leak */,o.texture}', 'dispose(){g&&(g.__aimRT?.dispose(),g.dispose()),p?.dispose()}'],
    gone: ['return s.dispose(),a.dispose(),o.texture}', 'dispose(){g?.dispose(),p?.dispose()}'],
  },
  'CnrSARj_.js': {
    marker: '/* graphics-leak */',
    present: ['Y.material.dispose();/* graphics-leak */s.mesh.skin?.skeleton?.dispose();A.root.remove(s.mesh.root)}'],
    gone: ['M=s=>{for(const Y of s.mesh.parts)Y.material.dispose();A.root.remove(s.mesh.root)}'],
  },
};

for (const [file, e] of Object.entries(EDITS)) {
  test(`${file}: perf patch applied once, both copies identical`, () => {
    const [a, b] = JS.map((d) => lf(path.join(d, file)));
    assert.equal(a, b, `${file} copies differ`);
    assert.equal(count(a, e.marker), 1, `marker ${e.marker}`);
    for (const s of e.present) assert.equal(count(a, s), 1, `expected once: ${s.slice(0, 70)}`);
    for (const s of e.gone) assert.equal(count(a, s), 0, `old code still there: ${s.slice(0, 70)}`);
  });
}

// ---- bot visibility: the time-sliced build gives the same triangles / BVH / answers ----
class M4 {
  constructor(e) { this.elements = e ? [...e] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  clone() { return new M4(this.elements); }
  copy(m) { this.elements = [...m.elements]; return this; }
  determinant() { const e = this.elements; return e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]); }
}
function rng(seed) { return () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((seed >>> 0) % 100000) / 100000; }; }
function stubMap(seed, meshes = 24, tris = 400) {
  const r = rng(seed), map = { name: 'map:stub', visible: true, parent: null, updateMatrixWorld() {}, traverse(f) { f(this); for (const m of list) f(m); } }, list = [];
  for (let k = 0; k < meshes; k++) {
    const pos = [];
    for (let t = 0; t < tris; t++) {
      const cx = (r() - 0.5) * 80, cy = r() * 6, cz = (r() - 0.5) * 80, s = 1 + r() * 4;
      pos.push(cx, cy, cz, cx + s, cy, cz + (r() - 0.5), cx, cy + s, cz + (r() - 0.5));
    }
    const a = new Float32Array(pos);
    const position = { version: 0, count: a.length / 3, getX: (i) => a[i * 3], getY: (i) => a[i * 3 + 1], getZ: (i) => a[i * 3 + 2] };
    const mw = new M4(); mw.elements[12] = (r() - 0.5) * 4; mw.elements[14] = (r() - 0.5) * 4;
    list.push({ isMesh: true, visible: true, parent: map, layers: { mask: 1 }, matrixWorld: mw, material: { side: k % 3 === 0 ? 2 : 0, opacity: 1, visible: true },
      geometry: { attributes: { position }, index: null, drawRange: { start: 0, count: Infinity } } });
  }
  return map;
}
function queries(vis) {
  const out = [], r = rng(7);
  for (let i = 0; i < 300; i++) {
    const eye = [(r() - 0.5) * 60, 1.6, (r() - 0.5) * 60];
    vis.begin({ matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, eye[0], eye[1], eye[2], 1] }, near: 0.05, layers: { mask: 1 } });
    out.push(vis.hidden({ id: i }, (r() - 0.5) * 60, 1 + r(), (r() - 0.5) * 60, 0.6));
  }
  return out;
}
const { createBotVisibility } = await import(pathToFileURL(path.join(root, 'app', 'mods', 'aim-ui', 'bot-visibility.mjs')).href);

test('bot visibility: same BVH and answers whatever the slice length (build mode)', async () => {
  const runs = [];
  for (const sliceMs of [0, 8, 1e9]) {
    const vis = createBotVisibility({ allowBuild: true, sliceMs });
    await vis.setMap(stubMap(11));
    assert.equal(vis.snapshot().ready, true);
    runs.push({ map: JSON.stringify(vis.exportMap()), tris: vis.snapshot().triangles, q: queries(vis) });
  }
  assert.ok(runs[0].tris > 5000, `stub too small (${runs[0].tris})`);
  assert.ok(runs[0].q.some(Boolean) && runs[0].q.some((x) => !x), 'queries should give both answers');
  for (const r of runs.slice(1)) { assert.ok(r.map === runs[0].map, 'BVH export differs between slice lengths'); assert.equal(r.tris, runs[0].tris); assert.deepEqual(r.q, runs[0].q); }
});

test('bot visibility: same result from the occlusion file (game mode), and it yields while building', async () => {
  const builder = createBotVisibility({ allowBuild: true, sliceMs: 1e9 });
  await builder.setMap(stubMap(5));
  const file = builder.exportMap();
  const old = globalThis.fetch;
  globalThis.fetch = async (url) => { assert.equal(url, '/aim-occlusion/stub.json'); return { ok: true, json: async () => JSON.parse(JSON.stringify(file)) }; };
  try {
    const runs = [];
    for (const sliceMs of [0, 1e9]) {
      const vis = createBotVisibility({ sliceMs });
      const p = vis.setMap(stubMap(5));
      if (sliceMs === 0) {
        let done = false; p.then(() => { done = true; });
        await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
        assert.equal(done, false, 'a 0 ms slice should yield to the event loop during the build');
      }
      await p;
      runs.push({ map: JSON.stringify(vis.exportMap()), q: queries(vis) });
    }
    assert.ok(runs[0].map === runs[1].map, 'occlusion-file build differs between slice lengths');
    const set = (m) => JSON.parse(m).triangles.map(String).sort().join(';');
    assert.ok(set(runs[0].map) === set(JSON.stringify(file)), 'occlusion-file build lost or added triangles');
    assert.deepEqual(runs[0].q, runs[1].q);
  } finally { globalThis.fetch = old; }
});

test('bot visibility: a newer setMap cancels the running build', async () => {
  const ref = createBotVisibility({ allowBuild: true, sliceMs: 1e9 });
  await ref.setMap(stubMap(3));
  const vis = createBotVisibility({ allowBuild: true, sliceMs: 0 });
  const a = vis.setMap(stubMap(2)), b = vis.setMap(stubMap(3));
  await Promise.all([a, b]);
  assert.ok(JSON.stringify(vis.exportMap()) === JSON.stringify(ref.exportMap()), 'cancelled build leaked into the result');
  assert.equal(vis.snapshot().triangles, ref.snapshot().triangles);
});

// ---- custom tracers: one empty draw on the first active frame compiles the program ----
test('custom tracers: warm draw on the first active frame, again only after a tone mapping / target change', async () => {
  const store = { 'es-advanced-tracers-v1': JSON.stringify({ mode: 'custom' }) };
  globalThis.localStorage ??= { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const { createTracers } = await import(pathToFileURL(path.join(root, 'app', 'mods', 'aim-tracers', 'renderer.mjs')).href);
  const made = [];
  class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    addScaledVector(v, k) { return this.set(this.x + v.x * k, this.y + v.y * k, this.z + v.z * k); }
    subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
    crossVectors(a, b) { return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length() { return Math.sqrt(this.lengthSq()); }
    multiplyScalar(k) { return this.set(this.x * k, this.y * k, this.z * k); }
    divideScalar(k) { return this.multiplyScalar(1 / k); }
    normalize() { return this.divideScalar(this.length() || 1); }
    distanceToSquared(v) { return (this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2; }
    distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
    setFromMatrixPosition(m) { const e = m.elements; return this.set(e[12], e[13], e[14]); }
    setFromMatrixColumn(m, i) { const e = m.elements; return this.set(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]); }
  }
  class Geo { constructor() { this.drawRange = { start: 0, count: Infinity }; } setAttribute() {} setIndex() {} setDrawRange(s, c) { this.drawRange = { start: s, count: c }; } dispose() {} }
  class Attr { constructor(a, n) { this.array = a; this.itemSize = n; this.ranges = []; this.needsUpdate = false; made.push(this); } setUsage() { return this; } clearUpdateRanges() { this.ranges = []; } addUpdateRange(s, c) { this.ranges.push([s, c]); } }
  class Mat { constructor(o) { Object.assign(this, o); } dispose() {} }
  class Mesh { constructor(g, m) { this.geometry = g; this.material = m; } }
  class Scene { constructor() { this.children = []; } add(m) { this.children.push(m); } }
  const T = { Vector3: V3, BufferGeometry: Geo, BufferAttribute: Attr, ShaderMaterial: Mat, Mesh, Scene, DynamicDrawUsage: 35048, AdditiveBlending: 2, NormalBlending: 1, DoubleSide: 2 };
  const tracers = createTracers(T, { muzzle: () => new V3(0, 1.5, 0) });
  assert.equal(tracers.active, true, 'custom mode from localStorage');
  const draws = [];
  const renderer = { toneMapping: 4, outputColorSpace: 'srgb', autoClear: true, target: null, getRenderTarget() { return this.target; }, render(scene) { draws.push(scene.children[0].geometry.drawRange.count); } };
  const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] } };
  tracers.frame({ enabled: true, time: 0 });
  tracers.render(renderer, camera);
  assert.deepEqual(draws, [0], 'one empty warm draw on the first frame');
  tracers.frame({ enabled: true, time: 0.01 }); tracers.render(renderer, camera);
  assert.deepEqual(draws, [0], 'no draw when nothing is live and nothing changed');
  renderer.toneMapping = 7; tracers.frame({ enabled: true, time: 0.02 }); tracers.render(renderer, camera);
  assert.deepEqual(draws, [0, 0], 'tone mapping change re-warms');
  renderer.target = { uuid: 'rt-1' }; tracers.frame({ enabled: true, time: 0.03 }); tracers.render(renderer, camera);
  assert.deepEqual(draws, [0, 0, 0], 'target change re-warms');
  // A live trail still draws as before: 6 indices, position/colour ranges updated.
  tracers.shoot({ source: 'player', weapon: 'vandal', at: 0.03, seed: 1, origin: { x: 0, y: 1.6, z: 0 }, direction: { x: 0, y: 0, z: -1 }, hitPoint: { x: 0, y: 1.5, z: -40 } });
  tracers.frame({ enabled: true, time: 0.05 }); tracers.render(renderer, camera);
  assert.deepEqual(draws, [0, 0, 0, 6], 'one live trail = 6 indices');
  assert.equal(tracers.stats().drawn, 1);
  const [pos, col] = made; // position, color4 (created in that order)
  assert.deepEqual([pos.ranges, pos.needsUpdate, col.ranges, col.needsUpdate], [[[0, 12]], true, [[0, 16]], true]);
  assert.ok(Number.isFinite(pos.array[0]) && pos.array.slice(0, 12).some((v) => v !== 0), 'trail vertices written');
  tracers.frame({ enabled: true, time: 0.5 }); tracers.render(renderer, camera);
  assert.deepEqual(draws, [0, 0, 0, 6], 'expired trail and nothing changed: no draw');
  tracers.dispose?.();
});
