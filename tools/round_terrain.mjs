// Round mode: the game's real collision world in plain node (no app, no browser).
//
//   import { loadTerrain } from './round_terrain.mjs';
//   const T = await loadTerrain('ascent');      // null when site/aim-maps/<map>.* is missing
//   T.pawn / T.projectile                       // BVHs, built on first use with the game's own builder
//   T.ray(T.pawn, [x, y, z], [dx, dy, dz], max) // -> hit distance or -1 (the game's own BVH raycast)
//
// How it is built (all game code is lifted from the repo's bundles at runtime, nothing is copied):
//  1. <map>.glb is decoded with the meshopt decoder that ships inside BiMsX6Xn.js
//     (EXT_meshopt_compression + KHR_mesh_quantization).
//  2. The mesh walk mirrors the game's loader: a mesh is named after its nearest ancestor with '#',
//     VLayer_ meshes and the collision file's noCollision names are skipped, winding flips when the
//     node matrix mirrors.
//  3. The game's terrain worker (site/assets/C-Ox_Jol.js) turns that plus <map>.collision.json into
//     the pawn and projectile triangle sets, exactly as in the app.
//  4. The pawn/projectile BVHs are built with the game's builder `ff` and rays use `Al`
//     (both lifted from BiMsX6Xn.js).
// The triangle sets are cached outside the repo in %TEMP%/open-aim-round-cache/<map>-<sha>.bin
// (sha over the map files, the worker and the bundle), so later loads skip steps 1-3.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = (root) => path.join(root, 'app', 'mods', 'next', 'js');
export const CACHE_DIR = path.join(os.tmpdir(), 'open-aim-round-cache');

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Text inputs are hashed with CRLF folded to LF so a Windows checkout (CRLF) and a Linux one agree.
export const fileSha = (file) => {
  const buf = fs.readFileSync(file);
  return /\.(js|mjs|json)$/i.test(file) ? sha256(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')) : sha256(buf);
};

// Map file: app/mods/aim-maps overrides site/aim-maps (same as the app's static server).
export function mapFile(map, ext, root = ROOT) {
  const mod = path.join(root, 'app', 'mods', 'aim-maps', `${map}.${ext}`);
  return fs.existsSync(mod) ? mod : path.join(root, 'site', 'aim-maps', `${map}.${ext}`);
}

// ---------------------------------------------------------------- lifting from the bundles
// Source of `function name(...){...}` (or `function*name`) at top level of a minified bundle.
export function fnSrc(src, name, { generator = false } = {}) {
  const key = generator ? `function*${name}(` : `function ${name}(`;
  const i = src.indexOf(key);
  if (i < 0) return null;
  if (src.indexOf(key, i + 1) >= 0) throw new Error(`lift: ${key} found twice`);
  let d = 0, k = src.indexOf('{', src.indexOf(')', i));
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') d++; else if (c === '}' && --d === 0) break; }
  return src.slice(i, k + 1);
}
// One declarator `name=<expr>` of a top-level const/let list, as `var name=<expr>;`.
export function constSrc(src, name) {
  const re = new RegExp(`(?:const |let |var |,)${name.replace(/\$/g, '\\$')}=`, 'g');
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) throw new Error(`lift: const ${name} found ${hits.length} times`);
  const s = hits[0].index + hits[0][0].length;
  let d = 0, k = s;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (d === 0 && (c === ',' || c === ';')) break;
  }
  return `var ${name}=${src.slice(s, k)};`;
}
// Module-level import/export alias maps: local name in `importer` -> local name in `exporter`.
export function importAlias(importerSrc, exporterSrc, exporterFile, localName) {
  const imp = importerSrc.match(new RegExp(`import\\{([^}]*)\\}from"\\./${exporterFile.replace('.', '\\.')}"`));
  const ex = exporterSrc.match(/export\{([^}]*)\}/);
  if (!imp || !ex) throw new Error(`lift: no import/export list for ${exporterFile}`);
  const table = (list) => Object.fromEntries(list.split(',').map((p) => { const [a, b] = p.split(' as ').map((t) => t.trim()); return [b ?? a, a]; }));
  const exported = table(imp[1])[localName];
  const local = exported && table(ex[1])[exported];
  if (!local) throw new Error(`lift: ${localName} not imported from ${exporterFile}`);
  return local;
}

// BVH builder + raycast + box/kill-volume tests from BiMsX6Xn.js, in one vm context.
const LIB_FNS = ['ff', 'Al', 'Af', 'Hg', 'Qg', 'sd', 'Jx', 'F8', 'TF'];
const LIB_CONSTS = ['kx', 'cn', 'Gx', 'kg', 'En', 'dn', 'jx', 'qu', 'Yu', 'Wu'];
export function gameLib(root = ROOT) {
  const B = fs.readFileSync(path.join(JS(root), 'BiMsX6Xn.js'), 'utf8');
  const parts = [];
  for (const n of LIB_CONSTS) parts.push(constSrc(B, n));
  for (const n of LIB_FNS) { const s = fnSrc(B, n); if (!s) throw new Error(`lift: function ${n} missing in BiMsX6Xn.js`); parts.push(s); }
  const ctx = { Math, Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array, Map, Set, Array, Error, Number, Infinity, NaN, console };
  vm.createContext(ctx);
  vm.runInContext(parts.join('\n'), ctx, { filename: 'BiMsX6Xn.lifted.js' });
  return { ctx, bundle: B };
}

// meshopt decoder object from BiMsX6Xn.js (the game's own copy of meshoptimizer's decoder).
async function meshoptDecoder(B) {
  const i = B.indexOf('WebAssembly.validate');
  const st = B.lastIndexOf('(function(){', i);
  const endMarker = '}})();';
  const en = B.indexOf(endMarker, B.indexOf('decodeGltfBufferAsync:function', i)) + endMarker.length;
  if (i < 0 || st < 0 || en < endMarker.length) throw new Error('lift: meshopt decoder not found in BiMsX6Xn.js');
  const M = new Function(`return ${B.slice(st, en)}`)(); // eslint-disable-line no-new-func
  await M.ready;
  return M;
}

// ---------------------------------------------------------------- GLB -> art triangles
function artTriangles(M, glb, col) {
  const jl = glb.readUInt32LE(12), j = JSON.parse(glb.subarray(20, 20 + jl).toString());
  const BIN = glb.subarray(20 + jl + 8, 20 + jl + 8 + glb.readUInt32LE(20 + jl));
  const bvCache = new Map();
  const bv = (i) => {
    if (bvCache.has(i)) return bvCache.get(i);
    const v = j.bufferViews[i], e = v.extensions && v.extensions.EXT_meshopt_compression; let out;
    if (e) {
      const src = BIN.subarray(e.byteOffset || 0, (e.byteOffset || 0) + e.byteLength);
      out = new Uint8Array(e.count * e.byteStride);
      M.decodeGltfBuffer(out, e.count, e.byteStride, src, e.mode, e.filter || 'NONE');
    } else out = new Uint8Array(BIN.buffer, BIN.byteOffset + (v.byteOffset || 0), v.byteLength);
    bvCache.set(i, out); return out;
  };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }, SZ = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }, NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
  const accCache = new Map();
  const acc = (i) => {
    if (accCache.has(i)) return accCache.get(i);
    const a = j.accessors[i], raw = bv(a.bufferView), nc = NC[a.type], sz = SZ[a.componentType], v = j.bufferViews[a.bufferView];
    const stride = v.byteStride || v.extensions?.EXT_meshopt_compression?.byteStride || sz * nc;
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), out = new Float64Array(a.count * nc);
    const rd = { 5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true), 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true) }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < nc; c++) {
      let x = rd((a.byteOffset || 0) + k * stride + c * sz);
      if (a.normalized) x = Math.max(x / NORM[a.componentType], -1);
      out[k * nc + c] = x;
    }
    accCache.set(i, out); return out;
  };
  const compose = (n) => {
    if (n.matrix) return n.matrix.slice();
    const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    const [x, y, z, w] = r, x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1];
  };
  const mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  const noCol = new Set(col.noCollision || []);
  const parts = []; let total = 0;
  const walk = (ni, parent, collName) => {
    const n = j.nodes[ni], m = mul(parent, compose(n));
    const nm = n.name && n.name.includes('#') ? n.name : collName; // a node's own '#' name wins over ancestors
    if (n.mesh != null) {
      const name = nm || n.name || '', hash = name.indexOf('#');
      const skip = name.startsWith('VLayer_') || (noCol.size > 0 && hash > 0 && noCol.has(name.slice(0, hash)));
      if (!skip) {
        const mir = det3(m) < 0;
        for (const p of j.meshes[n.mesh].primitives) {
          if (p.mode != null && p.mode !== 4) continue;
          const P = acc(p.attributes.POSITION), I = p.indices != null ? acc(p.indices) : null;
          const cnt = Math.floor((I ? I.length : P.length / 3) / 3), out = new Float32Array(cnt * 9);
          for (let g = 0; g < cnt; g++) for (let q = 0; q < 3; q++) {
            const E = g * 3 + (mir && q > 0 ? 3 - q : q), vi = I ? I[E] : E, x = P[3 * vi], y = P[3 * vi + 1], z = P[3 * vi + 2], C = g * 9 + q * 3;
            out[C] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[C + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[C + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          }
          parts.push(out); total += out.length;
        }
      }
    }
    for (const c of n.children || []) walk(c, m, nm);
  };
  for (const r of j.scenes[j.scene || 0].nodes) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], '');
  const art = new Float32Array(total); let o = 0;
  for (const p of parts) { art.set(p, o); o += p.length; }
  return art;
}

// The game's terrain worker, run once in a vm with a `self` shim.
function runTerrainWorker(workerSrc, col, art) {
  let result = null;
  const self = { postMessage: (m) => { if (m.kind === 'done') result = m.terrain; else if (m.kind === 'failed') throw new Error(`terrain worker: ${m.error}`); } };
  vm.runInNewContext(workerSrc, { self, Math, Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array, Map, Set, Array, Error, String, Number, Object, JSON, console }, { filename: 'C-Ox_Jol.js' });
  self.onmessage({ data: { doc: col, art } });
  if (!result) throw new Error('terrain worker returned nothing');
  return result;
}

// ---------------------------------------------------------------- cache file
// u32 magic "RTRI" | u32 pawnFloats | u32 projectileFloats | i32 projectileVolumeStart | f32 pawn | f32 projectile
const CMAGIC = 0x49525452;
function readCache(file) {
  const b = fs.readFileSync(file);
  if (b.length < 16 || b.readUInt32LE(0) !== CMAGIC) return null;
  const np = b.readUInt32LE(4), nq = b.readUInt32LE(8), vs = b.readInt32LE(12);
  if (b.length !== 16 + 4 * (np + nq)) return null;
  const ab = b.buffer.slice(b.byteOffset + 16, b.byteOffset + b.length);
  return { pawnTris: new Float32Array(ab, 0, np), projectileTris: new Float32Array(ab, np * 4, nq), projectileVolumeStart: vs };
}
function writeCache(file, t) {
  const h = Buffer.alloc(16);
  h.writeUInt32LE(CMAGIC, 0); h.writeUInt32LE(t.pawnTris.length, 4); h.writeUInt32LE(t.projectileTris.length, 8); h.writeInt32LE(t.projectileVolumeStart ?? -1, 12);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat([h, Buffer.from(t.pawnTris.buffer, t.pawnTris.byteOffset, t.pawnTris.byteLength), Buffer.from(t.projectileTris.buffer, t.projectileTris.byteOffset, t.projectileTris.byteLength)]));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- public
// Inputs that decide the triangle sets, with their sha256 (also the nav bake's provenance).
export function terrainSources(map, root = ROOT) {
  const files = { collision: mapFile(map, 'collision.json', root), glb: mapFile(map, 'glb', root), worker: path.join(root, 'site', 'assets', 'C-Ox_Jol.js') };
  for (const f of Object.values(files)) if (!fs.existsSync(f)) return null;
  const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
  return Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { file: rel(f), path: f, sha256: fileSha(f) }]));
}

// Cache file for the current inputs (null when the map files are missing).
export function terrainCacheFile(map, root = ROOT, src = terrainSources(map, root)) {
  if (!src) return null;
  const bundle = fs.readFileSync(path.join(JS(root), 'BiMsX6Xn.js'));
  const key = sha256([src.collision.sha256, src.glb.sha256, src.worker.sha256, sha256(bundle)].join('|')).slice(0, 16);
  return path.join(CACHE_DIR, `${map}-${key}.bin`);
}

export async function loadTerrain(map, { root = ROOT, cache = true, log = () => {} } = {}) {
  const src = terrainSources(map, root);
  if (!src) return null;
  const lib = gameLib(root);
  const cacheFile = terrainCacheFile(map, root, src);
  let tris = cache && fs.existsSync(cacheFile) ? readCache(cacheFile) : null;
  const t0 = Date.now();
  if (tris) log(`terrain ${map}: cached triangles ${cacheFile}`);
  else {
    const col = JSON.parse(fs.readFileSync(src.collision.path, 'utf8'));
    const M = await meshoptDecoder(lib.bundle);
    const art = artTriangles(M, fs.readFileSync(src.glb.path), col);
    const T = runTerrainWorker(fs.readFileSync(src.worker.path, 'utf8'), col, art);
    tris = { pawnTris: Float32Array.from(T.pawn.tris), projectileTris: Float32Array.from(T.projectile.tris), projectileVolumeStart: T.projectileVolumeStart ?? -1 };
    log(`terrain ${map}: decoded ${art.length / 9} art triangles, built triangle sets in ${Date.now() - t0} ms`);
    if (cache) writeCache(cacheFile, tris);
  }
  const bvh = {};
  const build = (k) => { if (!bvh[k]) { const t = Date.now(); bvh[k] = lib.ctx.ff(tris[`${k}Tris`]); log(`terrain ${map}: ${k} BVH ${Date.now() - t} ms`); } return bvh[k]; };
  return {
    map, sources: src, cacheFile, lib: lib.ctx,
    pawnTris: tris.pawnTris, projectileTris: tris.projectileTris, projectileVolumeStart: tris.projectileVolumeStart,
    get pawn() { return build('pawn'); },
    get projectile() { return build('projectile'); },
    // The game's BVH raycast `Al`. Returns the hit distance along the (unit) direction, or -1.
    // minNy (optional): only surfaces whose normal y is at least this count (the game passes
    // cos(44.765 deg) for floor probes).
    ray(world, o, d, max = Infinity, minNy = -Infinity) { const h = lib.ctx.Al(world, o[0], o[1], o[2], d[0], d[1], d[2], max, minNy); return h ? h.t : -1; },
    rayHit(world, o, d, max = Infinity, minNy = -Infinity) { return lib.ctx.Al(world, o[0], o[1], o[2], d[0], d[1], d[2], max, minNy) || null; },
    // Bot line of sight, as the sim's target.canSee: projectile world, the projectile "volume"
    // triangles (sightSkip = projectileVolumeStart..count) don't block, ray stops 0.05 m short.
    sight(a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], j = Math.hypot(dx, dy, dz);
      if (j < 1e-6) return true;
      const w = this.projectile, vs = tris.projectileVolumeStart, stop = j - 0.05;
      const h = lib.ctx.Al(w, a[0], a[1], a[2], dx / j, dy / j, dz / j, j, -Infinity, stop, vs >= 0 ? vs : 0, vs >= 0 ? w.count : 0);
      return !(h && h.t < stop);
    },
  };
}
