// Combat feedback effects checks (tools/graphics_fx_patch.py, tools/graphics_holes_patch.py,
// app/mods/aim-fx/fx.mjs): the hooks are in both copies of the play page script exactly once and the
// copies are identical; the patch scripts refuse a second run; fx.mjs imports cold in node and its
// pools never grow (stub three.js constructors); the pooled bullet hole renderer (the real l1 code
// from the bundle, run with stubs) caps at 64 meshes and reuses them. Node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(ROOT, 'app', 'mods');
const COPIES = [path.join(MODS, 'next', 'js', 'OkAdunfX.js'), path.join(MODS, '_assets', 'r20261021-1', 'next', 'js', 'OkAdunfX.js')];
const FX = path.join(MODS, 'aim-fx', 'fx.mjs');
const read = p => fs.readFileSync(p, 'latin1');
const count = (s, sub) => s.split(sub).length - 1;

test('both OkAdunfX copies are byte-identical', () => {
  assert.ok(fs.readFileSync(COPIES[0]).equals(fs.readFileSync(COPIES[1])));
});

test('fx hooks are present exactly once in both copies', () => {
  const hooks = [
    'u=l1(r.scene,r.camera),__aimFx=__aimFxBoot(r),',
    '...l.warmUp?.()??[],...__aimFx.warmUp());',
    'Os=void 0,u.clear(),__aimFx.clear(),',
    '__aimFx.frame(r.camera),r.render(),h.render(r.renderer),r.present()',
    'Hr(),u.dispose(),__aimFx.dispose(),c.dispose(),',
    'o.dispose=()=>{o.dead=!0;call("dispose");o.impl=null};',
    '__aimN=ce.look!=="off"||Os?Ns(F,Z):null;ce.look!=="off"&&u.spawn(F,__aimN,fe,ce);__aimFx.wallImpact({point:F,normal:__aimN,dir:Z})}',
    '__aimFx.hit({point:Be.hitPoint,part:Be.hitPart??"body"})',
    '__aimFx.hit({point:yn.point,part:yn.part})',
    'he.kind==="kill"&&(Qn+=1,__aimFxKill(__aimFx,he,Ze,Ae,Ds,__aimDotTemplates));',
    'yn.id===he.actorId);__aimFxEnemy(__aimFx,Be,Ae);',
    'function __aimFxBoot(r){',
    'function __aimFxKill(fx,k,evs,snap,scene,dots){',
    'function __aimFxEnemy(fx,a,snap){',
    'import("/aim-fx/fx.mjs")',
    // holes pool
    '__aimHoleFree=[],h=p=>{e.remove(p.mesh),__aimHoleFree.push(p.mesh)}',
    'else if(r.length+__aimHoleFree.length<64)E=new mt(o(),i(new dt(bl)));',
    'dispose(){d();for(const q of __aimHoleFree)q.material.dispose();',
  ];
  for (const file of COPIES) {
    const s = read(file);
    for (const h of hooks) assert.equal(count(s, h), 1, `${path.basename(path.dirname(path.dirname(file)))}: ${h}`);
    // the old per-hole allocation and the old Us body are gone
    assert.equal(count(s, 'new dt(m.tint):new dt(bl),E=new mt(o(),i(C))'), 0);
    assert.equal(count(s, 'p.mesh.material.dispose()},d=()=>'), 0);
    // strings other teams / app/main.js rely on are untouched
    assert.equal(count(s, 'const ce=hs(de);for(const xe of Cn)'), 1);
    assert.equal(count(s, 'xe.kind==="shot"&&(Kt.push(xe.tick*ve)'), 1);
    // no static import of the fx module (a broken fx file must not stop the game loading)
    assert.equal(count(s, "from '/aim-fx/"), 0);
    assert.equal(count(s, 'from "/aim-fx/'), 0);
  }
});

test('patch scripts refuse to run twice', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimfx-'));
  try {
    for (const rel of [['next', 'js'], ['_assets', 'r20261021-1', 'next', 'js']]) {
      fs.mkdirSync(path.join(tmp, ...rel), { recursive: true });
      fs.copyFileSync(path.join(MODS, ...rel, 'OkAdunfX.js'), path.join(tmp, ...rel, 'OkAdunfX.js'));
    }
    for (const script of ['graphics_fx_patch.py', 'graphics_holes_patch.py']) {
      let failed = false, out = '';
      try { execFileSync('python', ['-I', path.join(ROOT, 'tools', script), '--mods', tmp], { stdio: 'pipe' }); }
      catch (e) { failed = true; out = String(e.stderr) + String(e.stdout); }
      assert.ok(failed, `${script} ran twice`);
      assert.match(out, /already patched/);
    }
    // nothing was written
    assert.ok(fs.readFileSync(path.join(tmp, 'next', 'js', 'OkAdunfX.js')).equals(fs.readFileSync(COPIES[0])));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---- fx.mjs with stub three.js constructors ----------------------------------------------------
function stubThree() {
  const made = { geometry: 0, attribute: 0, material: 0, mesh: 0, group: 0 };
  class BufferAttribute {
    constructor(array, itemSize) { made.attribute++; this.array = array; this.itemSize = itemSize; this.ranges = []; this.version = 0; }
    setUsage() { return this; }
    addUpdateRange(start, n) { this.ranges.push([start, n]); }
    clearUpdateRanges() { this.ranges.length = 0; }
    set needsUpdate(v) { if (v) this.version++; }
  }
  class BufferGeometry {
    constructor() { made.geometry++; this.attributes = {}; }
    setAttribute(n, a) { this.attributes[n] = a; return this; }
    setIndex(a) { this.index = a; return this; }
    dispose() { this.disposed = true; }
  }
  class ShaderMaterial { constructor(p) { made.material++; Object.assign(this, p); } dispose() { this.disposed = true; } }
  class Obj { constructor() { this.parent = null; this.children = []; this.visible = true; } add(o) { o.parent?.remove(o); o.parent = this; this.children.push(o); return this; } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); o.parent = null; return this; } }
  class Mesh extends Obj { constructor(g, m) { super(); made.mesh++; this.geometry = g; this.material = m; } }
  class Group extends Obj { constructor() { super(); made.group++; } }
  return { T: { BufferGeometry, BufferAttribute, ShaderMaterial, Mesh, Group, Vector3: class {} }, made, Obj };
}

let fakeNow = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => fakeNow }, configurable: true, writable: true });
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

test('fx.mjs imports cold in node (no browser globals at load)', () => {
  const src = fs.readFileSync(FX, 'utf8');
  assert.equal(/^\s*import\s/m.test(src), false, 'fx.mjs must not import anything');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify(pathToFileURL(FX).href)}).then(m=>console.log(typeof m.createFx, typeof window, typeof localStorage))`]).toString().trim();
  assert.equal(out, 'function undefined undefined');
  assert.equal(/\bhalf\b/.test(src.replace(/\/\/.*$/gm, '')), false, 'GLSL reserved word "half"');
});

test('fx pools: no allocation after start, caps hold, clear() works', async () => {
  const { createFx, LIMITS } = await import(pathToFileURL(FX).href);
  const { T, made, Obj } = stubThree();
  const scene = new Obj();
  const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 5, 1] } };
  store.clear();
  const fx = createFx(T, { scene, camera });
  assert.equal(scene.children.length, 1, 'one group in the scene');
  assert.equal(fx.group.children.length, 4);
  const after = { ...made };
  assert.equal(after.mesh, 4); assert.equal(after.material, 4); assert.equal(after.geometry, 4);
  for (const m of fx.group.children) assert.equal(m.visible, false, 'idle meshes hidden');

  for (let i = 0; i < 500; i++) {
    fakeNow += 3;
    fx.wallImpact({ point: { x: i % 7, y: 1, z: -3 }, normal: i % 2 ? { x: 0, y: 0, z: 1 } : null, dir: { x: 0, y: 0, z: -1 } });
    fx.hit({ point: { x: 0, y: 1.2, z: -4 }, part: i % 3 ? 'body' : 'head' });
    if (i % 10 === 0) fx.kill({ position: { x: 0, y: 1.1, z: -4 }, headshot: i % 20 === 0 });
    fx.enemyShot({ origin: { x: 0, y: 1.45, z: -10 }, dir: { x: 0, y: 0, z: 1 } });
    fx.frame(camera);
  }
  assert.deepEqual({ ...made }, after, 'no constructor calls after start-up');
  const s = fx.stats;
  assert.equal(s.spawned.wall, 500); assert.equal(s.spawned.hit, 500); assert.equal(s.spawned.kill, 50);
  assert.equal(s.spawned.enemy, 0, 'enemy muzzle is off by default');
  assert.ok(s.active > 0 && s.active <= LIMITS.sparkBursts + LIMITS.puffs + LIMITS.kills + LIMITS.flashes, `active ${s.active}`);
  assert.ok(Number.isFinite(s.frameMs));
  const sparks = fx.pools.sparks;
  assert.equal(sparks.geometry.attributes.position.array.length, LIMITS.sparkBursts * 8 * 4 * 3, 'spark buffer size fixed');
  assert.equal(sparks.mesh.visible, true);

  // everything expires on its own and the meshes hide again
  fakeNow += 2000; fx.frame(camera);
  assert.equal(fx.stats.active, 0);
  for (const m of fx.group.children) assert.equal(m.visible, false);

  // clear(): hides, resets, re-reads settings
  fx.kill({ position: { x: 0, y: 1, z: 0 }, headshot: false });
  store.set('aim-fx-settings-v1', JSON.stringify({ impactSparks: false, killBurst: false, enemyMuzzle: true, hitSpark: false }));
  fx.clear();
  assert.equal(fx.stats.active, 0);
  for (const m of fx.group.children) assert.equal(m.visible, false);
  const aT = fx.pools.kills.geometry.attributes.aT.array;
  for (let v = 0; v < aT.length; v += 4) assert.ok(aT[v] < -1e5, 'cleared quads hidden in the shader');
  const before = { ...fx.stats.spawned };
  fx.wallImpact({ point: { x: 0, y: 0, z: 0 }, normal: null, dir: { x: 1, y: 0, z: 0 } });
  fx.hit({ point: { x: 0, y: 0, z: 0 }, part: 'head' });
  fx.kill({ position: { x: 0, y: 0, z: 0 }, headshot: true });
  fx.enemyShot({ origin: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 } });
  assert.deepEqual(fx.stats.spawned, { ...before, enemy: before.enemy + 1 }, 'settings honoured after clear()');
  assert.equal(fx.wants('enemyMuzzle'), true);

  // bad input never throws
  fx.wallImpact(null); fx.wallImpact({ point: { x: NaN, y: 0, z: 0 } }); fx.hit({}); fx.kill({ position: null });

  // warm-up meshes: one per material, separate from the live meshes, reused
  const w1 = fx.warmUp(), w2 = fx.warmUp();
  assert.equal(w1.length, 4);
  assert.deepEqual(w1, w2);
  for (const m of w1) assert.ok(!fx.group.children.includes(m));

  // the group comes back if something removes it from the scene
  scene.remove(fx.group); fx.frame(camera);
  assert.equal(fx.group.parent, scene);
  assert.equal(fx.stats.api, fx, 'debug handle');
  assert.equal(JSON.parse(JSON.stringify(fx.stats)).api, undefined);

  // dispose(): out of the scene, GPU objects freed, later frames do nothing
  fx.dispose();
  assert.equal(fx.group.parent, null);
  for (const p of Object.values(fx.pools)) { assert.ok(p.geometry.disposed); assert.ok(p.material.disposed); }
  fx.frame(camera);
  assert.equal(fx.group.parent, null);
  store.clear();
});

// ---- pooled bullet holes: the real l1 from the bundle with stubs --------------------------------
function loadHoles() {
  const s = fs.readFileSync(COPIES[0], 'utf8');
  const start = s.indexOf('function l1(e,t){'), end = s.indexOf('const Zl=', start);
  const src = s.slice(start, end);
  const made = { mesh: 0, material: 0, color: 0, disposed: 0 };
  class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } normalize() { return this; } }
  class Q { setFromUnitVectors() { return this; } setFromAxisAngle() { return this; } copy() { return this; } multiply() { return this; } }
  class Color { constructor(v) { made.color++; this.v = v; } set(v) { this.v = v; return this; } }
  class Mat { constructor(p) { made.material++; Object.assign(this, { opacity: 1 }, p); } dispose() { made.disposed++; } }
  class Mesh { constructor(g, m) { made.mesh++; this.geometry = g; this.material = m; this.position = new V3(); this.quaternion = new Q(); this.scale = new V3(); } }
  class Geo { constructor() {} dispose() {} }
  let onTex = null;
  const canvasTex = { name: 'canvas', dispose() {} };
  const env = {
    a1: () => canvasTex, Fc: (url, cb) => { onTex = cb; return { name: 'loaded', dispose() {} }; }, B0: 'hole.png', vo: 'srgb',
    is: Geo, jr: Q, ze: V3, os: Mat, mt: Mesh, dt: Color, n1: -5, s1: -20, An: 2, bl: 0xffffff,
    Tc: v => v, Sc: () => ({ x: 0, y: 0, z: 1 }), ql: new V3(0, 0, 1), r1: () => 0, V0: 1, W0: () => 1, E0: () => 1,
    o1: 8, ve: 1 / 128, H0: (f, l) => 1 - f / l,
  };
  const l1 = new Function(...Object.keys(env), `${src}\nreturn l1;`)(...Object.values(env));
  return { l1, made, loadTexture: () => onTex?.({ name: 'loaded', colorSpace: '', dispose() {} }) };
}

test('bullet holes: at most 64 meshes, reused, same per-hole materials', () => {
  const { l1, made, loadTexture } = loadHoles();
  const kids = new Set();
  const scene = { add: m => kids.add(m), remove: m => kids.delete(m) };
  const camera = { position: { x: 0, y: 1.6, z: 0 } };
  const holes = l1(scene, camera);
  const look = { look: 'default', seconds: 10, scale: 1 }, tinted = { look: 'tinted', tint: 0xff0000, seconds: 10, scale: 1 };
  for (let i = 0; i < 200; i++) holes.spawn({ x: i, y: 1, z: -5 }, null, i, i % 2 ? tinted : look);
  assert.equal(made.mesh, 64); assert.equal(made.material, 64);
  assert.equal(kids.size, 64, 'oldest holes recycled');
  assert.equal(made.disposed, 0);
  const last = [...kids].at(-1);
  assert.equal(last.material.color.v, 0xff0000, 'tint applied on reuse');
  // fade: update runs opacity like before
  holes.update(199 + 640);
  for (const m of kids) assert.ok(m.material.opacity >= 0 && m.material.opacity <= 1);
  // everything expires -> free list, no dispose
  holes.update(199 + 128 * 20);
  assert.equal(kids.size, 0); assert.equal(made.disposed, 0);
  // texture arrives: reused holes switch to it
  loadTexture();
  const meshesBefore = made.mesh, colorsBefore = made.color;
  for (let i = 0; i < 100; i++) holes.spawn({ x: i, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, 3000 + i, look);
  assert.equal(made.mesh, meshesBefore, 'no new meshes after warm pool');
  assert.equal(made.color, colorsBefore, 'no new colours per hole');
  for (const m of kids) { assert.equal(m.material.map.name, 'loaded'); assert.equal(m.material.opacity, 1); assert.equal(m.material.color.v, 0xffffff); }
  // off: nothing spawns
  holes.spawn({ x: 0, y: 0, z: 0 }, null, 1, { look: 'off' });
  assert.equal(kids.size, 64);
  holes.clear();
  assert.equal(kids.size, 0);
  holes.dispose();
  assert.equal(made.disposed, 64, 'dispose frees every pooled material');
});

// ---- the kill / enemy-shot helpers from the bundle tail, with stubs ----------------------------
function loadHelpers(headY) {
  const s = fs.readFileSync(COPIES[0], 'utf8');
  const line = name => { const i = s.indexOf(`function ${name}(`); assert.ok(i > 0, name); return s.slice(i, s.indexOf('\n', i)); };
  const isGrid = (id, actors, templates) => actors.some(a => a.id === id && templates.has(a.templateId));
  const Is = () => (headY === undefined ? null : { x: 0, y: headY, z: 0 });
  return new Function('__aimIsGridTargetActor', 'Is', `${line('__aimFxKill')}\n${line('__aimFxEnemy')}\nreturn {__aimFxKill,__aimFxEnemy};`)(isGrid, Is);
}

test('kill helper: grid dots skipped, chest height, headshot from pellets / also', () => {
  const calls = [];
  const fx = { kill: o => calls.push(o), enemyShot: o => calls.push(o), wants: k => k === 'enemyMuzzle' };
  const actor = (id, templateId, y = 0) => ({ id, templateId, position: { x: 1, y, z: 2 }, offset: { x: 0.5, y: 0, z: 0 }, scale: 1, behavior: {} });
  const snap = { actors: [actor(1, 'bot'), actor(2, 'dot'), actor(3, 'bot', 1)], player: { position: { x: 0, y: 0, z: 0 } } };
  const scene = { actors: [{ id: 'bot', body: { shape: 'humanoid' } }, { id: 'dot', body: { shape: 'sphere' } }] };
  const dots = new Set(['dot']);
  const { __aimFxKill, __aimFxEnemy } = loadHelpers(1.6);
  __aimFxKill(fx, { kind: 'kill', actorId: 2 }, [], snap, scene, dots);
  assert.equal(calls.length, 0, 'grid dot: no kill fx');
  __aimFxKill(fx, { kind: 'kill', actorId: 1 }, [{ kind: 'shot', hitActorId: 1, hitPart: 'body' }], snap, scene, dots);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].position, { x: 1.5, y: 1.6 * 0.72, z: 2 });
  assert.equal(calls[0].headshot, false);
  __aimFxKill(fx, { kind: 'kill', actorId: 1 }, [{ kind: 'shot', hitActorId: 9, hitPart: 'head', pellets: [{ hitActorId: 1, hitPart: 'head' }] }], snap, scene, dots);
  assert.equal(calls[1].headshot, true, 'pellet headshot');
  __aimFxKill(fx, { kind: 'kill', actorId: 1, aimBlast: true }, [{ kind: 'shot', hitActorId: 5, hitPart: 'body', also: [{ actorId: 1, part: 'head' }] }], snap, scene, dots);
  assert.equal(calls[2].headshot, true, 'penetration headshot; spike-blast kill still shows');
  // no head point: fallback chest height 1.12 m above the feet
  const plain = loadHelpers(undefined);
  plain.__aimFxKill(fx, { kind: 'kill', actorId: 3 }, [], snap, scene, dots);
  assert.ok(Math.abs(calls[3].position.y - 2.12) < 1e-9);
  // unknown actor / broken input: nothing, no throw
  __aimFxKill(fx, { kind: 'kill', actorId: 42 }, [], snap, scene, dots);
  __aimFxKill(fx, null, null, null, null, null);
  assert.equal(calls.length, 4);
  // enemy shot: origin at eye height, aimed at the player
  __aimFxEnemy(fx, snap.actors[0], snap);
  assert.deepEqual(calls[4].origin, { x: 1.5, y: 1.45, z: 2 });
  __aimFxEnemy({ ...fx, wants: () => false }, snap.actors[0], snap);
  __aimFxEnemy(fx, undefined, snap);
  assert.equal(calls.length, 5);
});

test('fx: shotgun-style bursts are thinned; billboard shaders use centred corners', async () => {
  const { createFx } = await import(pathToFileURL(FX).href);
  const { T } = stubThree();
  const fx = createFx(T, {});
  fakeNow += 5000;
  for (let i = 0; i < 12; i++) fx.wallImpact({ point: { x: i, y: 1, z: -3 }, normal: null, dir: { x: 0, y: 0, z: -1 } });
  assert.equal(fx.stats.spawned.wall, 12);
  const tt = fx.pools.sparks.geometry.attributes.aT.array, per = 8 * 4 * 4; // floats per burst slot
  const live = slot => { let n = 0; for (let q = 0; q < 8; q++) if (tt[slot * per + q * 16] > -1e5) n++; return n; };
  assert.equal(live(0), 7); assert.equal(live(1), 7); assert.equal(live(2), 3); assert.equal(live(11), 3);
  let puffs = 0; const pt = fx.pools.puffs.geometry.attributes.aT.array;
  for (let q = 0; q < 32; q++) if (pt[q * 16] > -1e5) puffs++;
  assert.equal(puffs, 4, 'at most 4 dust puffs per blast');
  for (const name of ['puffs', 'kills', 'flashes']) {
    const vs = fx.pools[name].material.vertexShader;
    assert.match(vs, /vec2 cq = vec2\(aCorner\.x, aCorner\.y \* 2\.0 - 1\.0\)/);
    assert.match(vs, /vec3\(cq \* hs \* k, 0\.0\)/);
  }
  assert.match(fx.pools.kills.material.vertexShader, /vHead = aT\.w;/);
  assert.match(fx.pools.kills.material.fragmentShader, /varying float vHead;/);
  fx.dispose();
});

test('spark streak quads are wound CCW (front-facing; the material culls back faces)', async () => {
  const { createFx } = await import(pathToFileURL(FX).href);
  const { T } = stubThree();
  const fx = createFx(T, {});
  const vs = fx.pools.sparks.material.vertexShader;
  // The JS mirror below follows these exact shader lines.
  assert.match(vs, /vec3 sd = cross\(normalize\(hv\), ax\);/);
  assert.match(vs, /vec3 p = mix\(tv, hv, aCorner\.y\) \+ sd \* aCorner\.x \* w;/);
  assert.notEqual(fx.pools.sparks.material.side, 2, 'single-sided material: winding matters');
  const corner = fx.pools.sparks.geometry.attributes.aCorner.array, index = fx.pools.sparks.geometry.index.array;
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  // view space (camera at origin looking -z); streaks 3 m away in 8 screen directions
  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2, hv = [0.05 * Math.cos(ang), 0.05 * Math.sin(ang), -3], tv = [0, 0, -3];
    const ax = norm(hv.map((x, i) => x - tv[i])), sd = norm(cross(norm(hv), ax)), w = 0.01;
    const P = [0, 1, 2, 3].map((v) => { const cx = corner[v * 2], cy = corner[v * 2 + 1];
      const p = tv.map((t, i) => t + (hv[i] - t) * cy + sd[i] * cx * w); return [p[0] / -p[2], p[1] / -p[2]]; });
    for (let t = 0; t < 6; t += 3) {
      const [a, b, c] = [P[index[t]], P[index[t + 1]], P[index[t + 2]]];
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      assert.ok(area > 0, `streak dir ${k}, triangle ${t / 3}: clockwise (would be culled)`);
    }
  }
  fx.dispose();
});
