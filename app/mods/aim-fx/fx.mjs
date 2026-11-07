// Combat feedback effects (render only): wall impact sparks + dust, bot hit sparks, kill burst,
// optional enemy muzzle flash. Loaded by the play page (OkAdunfX, tools/graphics_fx_patch.py) with a
// dynamic import; the page passes in its own three.js constructors, so this file imports nothing
// and touches no browser globals at load time (it imports cold in node, see
// scripts/test-graphics-fx.mjs).
//
// Everything is drawn from fixed GPU pools (4 meshes, one draw call each, hidden while idle). A spawn
// writes a few vertex attributes; the motion runs in the vertex shader from the spawn time, so the
// CPU cost per frame is one uniform write and a short loop over slot end times. Nothing is allocated
// per hit after start-up. Time is performance.now() based (the sim clock resets on retry).

export const SETTINGS_KEY = 'aim-fx-settings-v1';
export const DEFAULTS = Object.freeze({impactSparks: true, killBurst: true, enemyMuzzle: false, hitSpark: true});

// Pool sizes. A spark burst is SPARKS_PER_BURST streak quads.
export const LIMITS = Object.freeze({sparkBursts: 32, puffs: 32, kills: 8, flashes: 8});
const SPARKS_PER_BURST = 8;
const HIDE = -1e6; // start time of an unused quad (the vertex shader collapses it)

function readSettings() {
  const out = {...DEFAULTS};
  try {
    const ls = globalThis.localStorage;
    const raw = ls && ls.getItem(SETTINGS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') for (const k of Object.keys(DEFAULTS)) if (typeof v[k] === 'boolean') out[k] = v[k];
    }
  } catch { /* defaults */ }
  return out;
}

// Small deterministic-free random (Math.random is fine: render only, never sim RNG).
const rnd = (a, b) => a + Math.random() * (b - a);

// --- shaders -------------------------------------------------------------------------------------
// Shared attribute layout per vertex (all four corners of a quad carry the same values):
//   position (vec3) spawn point; aDir (vec4) xyz direction, w speed or size; aT (vec4) x start time
//   (s), y life (s), z variant/seed, w width or tint; aCorner (vec2, static) quad corner.
const HEAD = `
uniform float uTime;
attribute vec4 aDir;
attribute vec4 aT;
attribute vec2 aCorner;
varying vec2 vUv;
varying float vU;
varying float vVar;
`;

// Spark streak: head flies out with drag and a little gravity, tail lags 24 ms behind, so streaks
// start long and shrink as they slow down. Width never drops below ~1.2 px.
const SPARK_VS = HEAD + `
float travel(float t, float speed){ const float k = 10.0; return speed * (1.0 - exp(-k * t)) / k; }
void main(){
  float age = uTime - aT.x;
  if (age < 0.0 || age > aT.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vU = age / aT.y; vVar = aT.z; vUv = aCorner;
  float lag = max(age - 0.024, 0.0);
  vec3 g = vec3(0.0, -5.0, 0.0);
  vec3 head = position + aDir.xyz * travel(age, aDir.w) + g * age * age;
  vec3 tail = position + aDir.xyz * travel(lag, aDir.w) + g * lag * lag;
  vec3 hv = (modelViewMatrix * vec4(head, 1.0)).xyz;
  vec3 tv = (modelViewMatrix * vec4(tail, 1.0)).xyz;
  vec3 axis = hv - tv;
  float len = length(axis);
  vec3 dirV = (modelViewMatrix * vec4(aDir.xyz, 0.0)).xyz;
  vec3 ax = len > 1e-5 ? axis / len : normalize(dirV + vec3(1e-4));
  float w = max(aT.w * (1.0 - 0.45 * vU), -hv.z * 0.0011);
  if (len < w * 2.0) tv = hv - ax * w * 2.0;
  vec3 sd = cross(ax, normalize(hv));
  float sl = length(sd);
  sd = sl > 1e-5 ? sd / sl : vec3(1.0, 0.0, 0.0);
  vec3 p = mix(tv, hv, aCorner.y) + sd * aCorner.x * w;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;
const SPARK_FS = `
varying vec2 vUv;
varying float vU;
varying float vVar;
void main(){
  float across = 1.0 - abs(vUv.x);
  across *= across;
  float along = mix(0.2, 1.0, vUv.y);
  float fade = (1.0 - vU); fade *= fade;
  vec3 warm = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.62, 0.22), vVar);
  vec3 hot = vec3(1.0, 0.96, 0.86);
  vec3 col = mix(warm, hot, clamp(vUv.y * 1.3 - vU * 1.6, 0.0, 1.0));
  gl_FragColor = vec4(col, across * along * fade);
}`;

// Camera-facing quad of half-size aDir.w (m), pulled `pull` m toward the camera (so it isn't buried
// in the surface or body it belongs to) with its on-screen size kept.
const billboardVS = pull => HEAD + `
void main(){
  float age = uTime - aT.x;
  if (age < 0.0 || age > aT.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 cq = vec2(aCorner.x, aCorner.y * 2.0 - 1.0); // corners are (-1|1, 0|1); billboards want -1..1
  vU = age / aT.y; vVar = aT.z; vUv = cq;
  vec3 c = (modelViewMatrix * vec4(position + aDir.xyz * age, 1.0)).xyz;
  float d = length(c);
  float pl = clamp(d - 0.25, 0.0, ${pull});
  float k = d > 1e-4 ? (d - pl) / d : 1.0;
  float hs = aDir.w * SIZE_CURVE;
  vec3 p = c * k + vec3(cq * hs * k, 0.0);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

// Dust puff: faint grey, grows 40% -> 100%, fades out. Normal blending.
const PUFF_VS = billboardVS('0.06').replace('SIZE_CURVE', '(0.4 + 0.6 * (1.0 - (1.0 - vU) * (1.0 - vU)))');
const PUFF_FS = `
varying vec2 vUv;
varying float vU;
varying float vVar;
void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float soft = 1.0 - smoothstep(0.15, 1.0, r);
  float a = soft * soft * (1.0 - vU) * (0.16 + 0.06 * vVar);
  gl_FragColor = vec4(vec3(0.62, 0.6, 0.57), a);
}`;

// Kill burst: one thin ring that expands fast and thins out, plus a short white core flash.
// aT.w = 1 for a headshot kill (gold tint).
const KILL_VS = billboardVS('0.5').replace('SIZE_CURVE', '1.0').replace('varying float vVar;', 'varying float vVar;\nvarying float vHead;').replace('vUv = cq;', 'vUv = cq; vHead = aT.w;');
const KILL_FS = `
varying vec2 vUv;
varying float vU;
varying float vVar;
varying float vHead;
void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float e = 1.0 - (1.0 - vU) * (1.0 - vU) * (1.0 - vU);
  float R = mix(0.16, 0.92, e);
  float th = mix(0.11, 0.025, vU);
  float x = (r - R) / th;
  float ring = exp(-x * x) * (1.0 - vU) * (1.0 - vU);
  float inner = (1.0 - smoothstep(0.0, R, r)) * 0.18 * (1.0 - vU);
  float core = clamp(1.0 - vU * 3.2, 0.0, 1.0);
  core = core * core * exp(-r * r * 22.0);
  vec3 white = vec3(1.0, 0.98, 0.95);
  vec3 gold = vec3(1.0, 0.78, 0.32);
  vec3 col = mix(white, gold, vHead * smoothstep(0.0, 0.25, r));
  float a = clamp(ring + inner + core, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
}`;

// Enemy muzzle flash: short 4-point star + glow, warm yellow. aT.z = rotation seed.
const FLASH_VS = billboardVS('0.15').replace('SIZE_CURVE', '(1.0 - 0.35 * vU)');
const FLASH_FS = `
varying vec2 vUv;
varying float vU;
varying float vVar;
void main(){
  float r = length(vUv);
  if (r > 1.0) discard;
  float ang = atan(vUv.y, vUv.x + 1e-5) + vVar * 6.2832;
  float star = pow(abs(cos(ang * 2.0)), 10.0) * (1.0 - smoothstep(0.0, 1.0, r));
  float glow = exp(-r * r * 9.0);
  float a = clamp((star * 0.9 + glow) * (1.0 - vU), 0.0, 1.0);
  vec3 col = mix(vec3(1.0, 0.62, 0.22), vec3(1.0, 0.95, 0.8), glow);
  gl_FragColor = vec4(col, a);
}`;

// --- pools ---------------------------------------------------------------------------------------
// A pool of `quads` quads in one mesh. Quads are written in groups of `group` (one slot = one
// spawn). Oldest slot is reused when all are busy.
// Marks quads [q, q + n) of a per-vertex attribute (itemSize) for upload.
function mark(a, size, q, n) { a.addUpdateRange?.(q * 4 * size, n * 4 * size); a.needsUpdate = true; }

function makePool(T, {quads, group, vs, fs, blending, name}) {
  const verts = quads * 4;
  const pos = new Float32Array(verts * 3), dir = new Float32Array(verts * 4), tt = new Float32Array(verts * 4);
  const corner = new Float32Array(verts * 2), index = new Uint16Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    const v = q * 4;
    corner.set([-1, 0, 1, 0, -1, 1, 1, 1], v * 2);
    index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6);
  }
  for (let v = 0; v < verts; v++) tt[v * 4] = HIDE;
  const geometry = new T.BufferGeometry();
  const aPos = new T.BufferAttribute(pos, 3), aDir = new T.BufferAttribute(dir, 4), aT = new T.BufferAttribute(tt, 4);
  for (const a of [aPos, aDir, aT]) a.setUsage?.(35048); // DynamicDrawUsage
  geometry.setAttribute('position', aPos);
  geometry.setAttribute('aDir', aDir);
  geometry.setAttribute('aT', aT);
  geometry.setAttribute('aCorner', new T.BufferAttribute(corner, 2));
  geometry.setIndex(new T.BufferAttribute(index, 1));
  const uniforms = {uTime: {value: 0}};
  const material = new T.ShaderMaterial({
    vertexShader: vs, fragmentShader: fs, uniforms,
    transparent: true, depthTest: true, depthWrite: false, blending, toneMapped: false, fog: false,
  });
  const mesh = new T.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.raycast = () => {}; // shader-positioned quads: never a ray target
  mesh.renderOrder = 9; // after bullet holes (8)
  mesh.visible = false;
  mesh.name = name;
  const slots = quads / group, ends = new Float64Array(slots);
  let cursor = 0, liveUntil = 0;
  const pool = {
    mesh, geometry, material, uniforms, slots,
    // Next slot (round robin = oldest first). Returns the first quad index.
    take(now, life) {
      const s = cursor;
      cursor = (cursor + 1) % slots;
      ends[s] = now + life;
      if (now + life > liveUntil) liveUntil = now + life;
      mesh.visible = true;
      return s * group;
    },
    // Writes quad q: point p, direction d (xyz) + w, timing t0/life, z variant, w width/tint.
    write(q, px, py, pz, dx, dy, dz, dw, t0, life, z, w) {
      for (let k = 0; k < 4; k++) {
        const v = q * 4 + k;
        pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz;
        dir[v * 4] = dx; dir[v * 4 + 1] = dy; dir[v * 4 + 2] = dz; dir[v * 4 + 3] = dw;
        tt[v * 4] = t0; tt[v * 4 + 1] = life; tt[v * 4 + 2] = z; tt[v * 4 + 3] = w;
      }
    },
    // Marks quads [q, q + n) for upload.
    dirty(q, n) {
      mark(aPos, 3, q, n); mark(aDir, 4, q, n); mark(aT, 4, q, n);
    },
    active(now) { let n = 0; for (let s = 0; s < slots; s++) if (ends[s] > now) n++; return n; },
    frame(time) {
      uniforms.uTime.value = time;
      if (mesh.visible && time > liveUntil) mesh.visible = false;
    },
    clear() {
      ends.fill(0); liveUntil = 0; cursor = 0; mesh.visible = false;
      for (let v = 0; v < verts; v++) tt[v * 4] = HIDE;
      aT.clearUpdateRanges?.();
      aT.needsUpdate = true;
    },
    dispose() { geometry.dispose?.(); material.dispose?.(); },
  };
  return pool;
}

// --- public --------------------------------------------------------------------------------------
// T: three.js constructors {Vector3, BufferGeometry, BufferAttribute, ShaderMaterial, Mesh, Group, ...}.
// ctx: {scene, camera, renderer} of the play page viewport (all optional; scene is needed to show).
export function createFx(T, ctx = {}) {
  const now0 = () => (globalThis.performance?.now?.() ?? Date.now());
  const t0 = now0();
  const clock = () => (now0() - t0) / 1000;
  const sparks = makePool(T, {quads: LIMITS.sparkBursts * SPARKS_PER_BURST, group: SPARKS_PER_BURST, vs: SPARK_VS, fs: SPARK_FS, blending: 2, name: 'aim-fx-sparks'});
  const puffs = makePool(T, {quads: LIMITS.puffs, group: 1, vs: PUFF_VS, fs: PUFF_FS, blending: 1, name: 'aim-fx-dust'});
  const kills = makePool(T, {quads: LIMITS.kills, group: 1, vs: KILL_VS, fs: KILL_FS, blending: 2, name: 'aim-fx-kill'});
  const flashes = makePool(T, {quads: LIMITS.flashes, group: 1, vs: FLASH_VS, fs: FLASH_FS, blending: 2, name: 'aim-fx-muzzle'});
  const pools = [puffs, sparks, kills, flashes];
  const group = new T.Group();
  group.name = 'aim-fx';
  for (const p of pools) group.add(p.mesh);
  if (ctx.scene) ctx.scene.add(group);

  let settings = null;
  const cfg = () => (settings ??= readSettings());
  const stats = {loaded: true, spawned: {wall: 0, hit: 0, kill: 0, enemy: 0}, active: 0, frameMs: 0};
  try { if (typeof window !== 'undefined') window.__aimFxStats = stats; } catch { /* no window */ }

  // Camera position from its world matrix (no Vector3 needed).
  const eye = [0, 0, 0];
  const readEye = cam => {
    const e = cam?.matrixWorld?.elements;
    if (e) { eye[0] = e[12]; eye[1] = e[13]; eye[2] = e[14]; return true; }
    return false;
  };

  // Writes one burst of o.n streaks into the next spark slot. (nx,ny,nz) unit surface normal,
  // (rx,ry,rz) preferred direction; spread mixes in random directions.
  function sparkBurst(o) {
    const t = clock();
    const q0 = sparks.take(t, o.lifeMax + 0.03);
    for (let i = 0; i < SPARKS_PER_BURST; i++) {
      const q = q0 + i;
      if (i >= o.n) { sparks.write(q, 0, 0, 0, 0, 0, 0, 0, HIDE, 0, 0, 0); continue; }
      // random unit vector
      let ux = rnd(-1, 1), uy = rnd(-1, 1), uz = rnd(-1, 1);
      let ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      let dx = o.rx + ux * o.spread, dy = o.ry + uy * o.spread + o.lift, dz = o.rz + uz * o.spread;
      // keep it on the open side of the surface
      const along = dx * o.nx + dy * o.ny + dz * o.nz;
      if (along < 0.15) { dx += o.nx * (0.15 - along); dy += o.ny * (0.15 - along); dz += o.nz * (0.15 - along); }
      const dl = Math.hypot(dx, dy, dz) || 1;
      sparks.write(q, o.px + o.nx * 0.01, o.py + o.ny * 0.01, o.pz + o.nz * 0.01,
        dx / dl, dy / dl, dz / dl, rnd(o.speedMin, o.speedMax),
        t + rnd(0, 0.008), rnd(o.lifeMin, o.lifeMax), Math.random(), o.width * rnd(0.75, 1.15));
    }
    sparks.dirty(q0, SPARKS_PER_BURST);
  }

  let burstAt = -1, burstCount = 0;
  const finite = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

  // Wall impact: bright streaks mostly along the ricochet direction + a faint dust puff.
  // {point, normal (unit, may be null), dir (shot direction, any length)}
  function wallImpact(o) {
    if (!o || !finite(o.point) || !cfg().impactSparks) return;
    let dx = 0, dy = 0, dz = -1;
    if (finite(o.dir)) { const l = Math.hypot(o.dir.x, o.dir.y, o.dir.z); if (l > 1e-6) { dx = o.dir.x / l; dy = o.dir.y / l; dz = o.dir.z / l; } }
    let nx = -dx, ny = -dy, nz = -dz;
    if (finite(o.normal)) {
      const l = Math.hypot(o.normal.x, o.normal.y, o.normal.z);
      if (l > 1e-6) { nx = o.normal.x / l; ny = o.normal.y / l; nz = o.normal.z / l; }
      // face the shooter
      if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    }
    // ricochet: reflect the shot about the surface, pulled toward the normal
    const dn = dx * nx + dy * ny + dz * nz;
    let rx = dx - 2 * dn * nx, ry = dy - 2 * dn * ny, rz = dz - 2 * dn * nz;
    rx = rx * 0.55 + nx * 0.45; ry = ry * 0.55 + ny * 0.45; rz = rz * 0.55 + nz * 0.45;
    const p = o.point, t = clock();
    // Many impacts at once (shotgun pellets, wallbang holes): thinner bursts and fewer puffs, so
    // one blast doesn't recycle every slot.
    if (t - burstAt > 0.004) { burstAt = t; burstCount = 0; }
    burstCount++;
    sparkBurst({n: burstCount <= 2 ? 7 : 3, px: p.x, py: p.y, pz: p.z, nx, ny, nz, rx, ry, rz, spread: 0.75, lift: 0.1,
      speedMin: 3.5, speedMax: 9, lifeMin: 0.08, lifeMax: 0.2, width: 0.011});
    stats.spawned.wall++;
    if (burstCount > 4) return;
    const q = puffs.take(t, 0.42);
    puffs.write(q, p.x + nx * 0.05, p.y + ny * 0.05, p.z + nz * 0.05,
      nx * 0.35, ny * 0.35 + 0.12, nz * 0.35, rnd(0.16, 0.22), t, rnd(0.34, 0.42), Math.random(), 0);
    puffs.dirty(q, 1);
  }

  // Bot hit: a few short white-hot streaks toward the shooter (body), a little more for the head.
  function hit(o) {
    if (!o || !finite(o.point) || !cfg().hitSpark) return;
    const p = o.point;
    let nx = 0, ny = 1, nz = 0;
    if (readEye(ctx.camera)) {
      const ex = eye[0] - p.x, ey = eye[1] - p.y, ez = eye[2] - p.z, l = Math.hypot(ex, ey, ez);
      if (l > 1e-4) { nx = ex / l; ny = ey / l; nz = ez / l; }
    }
    const head = o.part === 'head';
    sparkBurst({n: head ? 6 : 4, px: p.x, py: p.y, pz: p.z, nx, ny, nz, rx: nx, ry: ny, rz: nz, spread: 1.1, lift: 0.15,
      speedMin: 2.5, speedMax: head ? 6.5 : 5, lifeMin: 0.06, lifeMax: head ? 0.15 : 0.12, width: 0.009});
    stats.spawned.hit++;
  }

  // Kill: ring + flash at chest height. {position, headshot}
  function kill(o) {
    if (!o || !finite(o.position) || !cfg().killBurst) return;
    const p = o.position, t = clock(), q = kills.take(t, 0.27);
    kills.write(q, p.x, p.y, p.z, 0, 0.25, 0, o.headshot ? 0.62 : 0.55, t, 0.26, Math.random(), o.headshot ? 1 : 0);
    kills.dirty(q, 1);
    stats.spawned.kill++;
  }

  // Enemy muzzle flash. {origin (bot eye/gun height), dir (toward the target)}
  function enemyShot(o) {
    if (!o || !finite(o.origin) || !cfg().enemyMuzzle) return;
    let dx = 0, dy = 0, dz = 0;
    if (finite(o.dir)) { const l = Math.hypot(o.dir.x, o.dir.y, o.dir.z); if (l > 1e-6) { dx = o.dir.x / l; dy = o.dir.y / l; dz = o.dir.z / l; } }
    const p = o.origin, t = clock(), q = flashes.take(t, 0.07);
    // in front of the body, a bit below eye height
    flashes.write(q, p.x + dx * 0.55, p.y + dy * 0.55 - 0.12, p.z + dz * 0.55, 0, 0, 0, 0.2, t, 0.06, Math.random(), 0);
    flashes.dirty(q, 1);
    stats.spawned.enemy++;
  }

  const warm = [];
  function warmUp() {
    // One mesh per material for the page's GPU prewarm (it re-parents what it gets, so these are
    // separate meshes sharing the pool geometry/material; all quads are hidden by the shader).
    if (!warm.length) for (const p of pools) { const m = new T.Mesh(p.geometry, p.material); m.frustumCulled = false; m.raycast = () => {}; m.name = p.mesh.name + '-warm'; warm.push(m); }
    for (const m of warm) m.visible = true;
    return warm.slice();
  }

  // Compile our 4 programs right away when the renderer is reachable (no first-hit hitch even
  // if the page's prewarm ran before this module finished loading).
  function compileNow() {
    const r = ctx.renderer;
    if (!r || typeof r.compile !== 'function' || !ctx.camera) return false;
    const vis = pools.map(p => p.mesh.visible);
    for (const p of pools) p.mesh.visible = true;
    try { r.compile(group, ctx.camera, ctx.scene ?? null); return true; } catch { return false; }
    finally { pools.forEach((p, i) => { p.mesh.visible = vis[i]; }); }
  }

  let frameAvg = 0;
  function frame(camera) {
    if (disposed) return;
    const a = now0();
    if (ctx.scene && group.parent !== ctx.scene) ctx.scene.add(group);
    const time = (a - t0) / 1000;
    let active = 0;
    for (const p of pools) { p.frame(time); if (p.mesh.visible) active += p.active(time); }
    stats.active = active;
    const ms = now0() - a;
    frameAvg = frameAvg * 0.95 + ms * 0.05;
    stats.frameMs = frameAvg;
  }

  function clear() {
    settings = null;
    for (const p of pools) p.clear();
    stats.active = 0;
  }

  function wants(key) { return !!cfg()[key]; }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    group.parent?.remove?.(group);
    for (const p of pools) p.dispose();
    try { if (typeof window !== 'undefined' && window.__aimFxStats === stats) window.__aimFxStats = {...stats, loaded: false}; } catch { /* no window */ }
  }

  const api = {
    warmUp, clear, frame, hit, wallImpact, kill, enemyShot, wants, dispose, compileNow,
    get settings() { return cfg(); },
    stats, group, pools: {sparks, puffs, kills, flashes},
  };
  // Debug / test handle (not enumerable, so JSON of the stats stays plain).
  Object.defineProperty(stats, 'api', {value: api, enumerable: false});
  return api;
}
