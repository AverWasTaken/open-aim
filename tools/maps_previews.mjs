// Map previews: our own top-down picture of every map, drawn from the map's collision data (no
// Riot art), plus app/mods/aim-maps/maps.json, the shared map list (id, English name, preview
// image, world -> pixel transform) that the Practice panel (and later Round) uses.
//
//   node tools/maps_previews.mjs            write app/mods/aim-maps/<map>.preview.png + maps.json
//   node tools/maps_previews.mjs --check    exit 1 unless the committed files match what would be
//                                           written (compares maps.json text and the sha256 of the
//                                           DECODED pixels, not the PNG bytes). ~45 s on hp with the
//                                           terrain cache warm.
//   --only ascent,jam   limit to some maps    --out <dir>   write somewhere else (spikes)
// Runs on hp (it decodes the map GLBs the first time); never on the user's PC.
//
// Geometry:
//  - 8 maps: the navmesh in <map>.collision.json (sets.gameplay instances whose prim name contains
//    "NavMesh"). Per pixel the highest navmesh surface wins.
//  - rook (Corrode) has no navmesh: the game's pawn triangles (tools/round_terrain.mjs loadTerrain,
//    cached in %TEMP%), floors with |normal.y| > 0.7, per pixel the LOWEST floor with >= 2 m of
//    empty space above it and no wall through it at body height (drops roofs, slab undersides and
//    the ground outside the map's walls), within the practice points' height range.
//  Then a flood fill from the minimap callouts and the practice spawns (steps of at most 0.5 m
//  between neighbouring pixels) drops unreachable islands.
//  Perches: the navmesh leaves out crates and ledges that some practice bots stand on. For a spot
//  that is off the drawn floor, the pawn floor under it (same rules as rook, nearest the spot's
//  height) is added, spread over undrawn pixels within 1.5 m of the spot's height.
//  Floors get 5 flat tones by height (darker = lower); coverage edges and ledges get a light
//  outline, slope band changes a dark line; the background is transparent.
//
// Orientation matches the in-game minimap (attackers at the bottom): the minimap.json transform and
// the rotation table Gs from Dc2Dm9E6.js (functions bl/qs, lifted at run time):
//   u0 = x*scaleU + offsetU, v0 = z*scaleV + offsetV; k = Gs[map] ?? 0
//   k=0 (u0,v0)  k=1 (1-v0,u0)  k=2 (1-u0,1-v0)  k=3 (v0,1-u0)
//   pixel = mm.scale * (u - mm.u0, v - mm.v0)
// maps.json world = the same as one affine: px = a*x + b*z + c, py = d*x + e*z + f (x, z in metres).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { constSrc, fnSrc, mapFile, loadTerrain } from './round_terrain.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAPS = [
  ['ascent', 'Ascent'], ['bonsai', 'Split'], ['triad', 'Haven'], ['plummet', 'Summit'], ['jam', 'Lotus'],
  ['infinity', 'Abyss'], ['rook', 'Corrode'], ['duality', 'Bind'], ['juliett', 'Sunset'],
];
const NO_NAVMESH = new Set(['rook']);
const LONG_SIDE = 640;      // px on the long side
const PAD = 12;             // px around the content
const PROBE = 0.25;         // m per cell for the first (bounds) pass
const MAX_STEP = 0.5;       // m between neighbouring pixels (flood fill; more = a ledge)
const CLEAR = 2.0;          // m of empty space above a floor (pawn floors)
const PERCH_M2 = 120;       // most area one perch may add
const MAX_PNG = 150 * 1024;

// Colours (RGBA). Fixed tones picked to sit on the theme's dark surfaces (theme-esports.css
// --es-bg #090b0f / --es-panel #10131a): floors lighter than the panel, darker = lower.
const TONES = [[0x1f, 0x24, 0x2d], [0x2a, 0x30, 0x3c], [0x36, 0x3e, 0x4c], [0x43, 0x4c, 0x5d], [0x51, 0x5b, 0x6f]];
const OUTLINE = [0x9a, 0xa1, 0xae]; // = --es-muted
const STEPLINE = [0x18, 0x1c, 0x23]; // tone change on a slope

// ---------------------------------------------------------------- minimap transform (lifted)
let liftCache = null;
export function liftMinimap(root = ROOT) {
  if (liftCache && liftCache.root === root) return liftCache;
  const src = fs.readFileSync(path.join(root, 'app', 'mods', 'next', 'js', 'Dc2Dm9E6.js'), 'utf8');
  const ctx = { Math };
  vm.createContext(ctx);
  vm.runInContext([constSrc(src, 'Gs'), fnSrc(src, 'bl'), fnSrc(src, 'qs'), 'var __q=qs,__b=bl,__G=Gs;'].join('\n'), ctx);
  liftCache = { root, qs: ctx.__q, bl: ctx.__b, Gs: ctx.__G };
  return liftCache;
}

// ---------------------------------------------------------------- geometry
function navmeshTris(map, root) {
  const col = JSON.parse(fs.readFileSync(mapFile(map, 'collision.json', root), 'utf8'));
  const set = col.sets.gameplay, out = [];
  for (let i = 0; set && i < set.count; i++) {
    const prim = col.prims[set.prim[i]];
    if (!/NavMesh/.test(prim.name)) continue;
    const m = set.m.slice(i * 12, i * 12 + 12);
    for (const k of prim.idx) {
      const x = prim.pos[k * 3], y = prim.pos[k * 3 + 1], z = prim.pos[k * 3 + 2];
      out.push(m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]);
    }
  }
  return Float64Array.from(out);
}

// Triangle kinds: 1 floor (|ny| > 0.7), 2 slope/ceiling (blocks headroom), 3 wall (|ny| < 0.3), 0 degenerate.
function classify(tris) {
  const n = tris.length / 9, kind = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    const a = Math.abs(ny / l);
    kind[t] = a > 0.7 ? 1 : a >= 0.3 ? 2 : 3;
  }
  return kind;
}

// Raster a triangle soup onto a grid: P(x,z) -> (gx, gy) affine {a,b,c,d,e,f}; visit(cell, h) per
// covered cell centre, h = interpolated world y.
function rasterTri(tris, o, T, W, H, visit) {
  const X = [], Y = [], Hh = [];
  for (let q = 0; q < 3; q++) {
    const x = tris[o + q * 3], y = tris[o + q * 3 + 1], z = tris[o + q * 3 + 2];
    X.push(T.a * x + T.b * z + T.c); Y.push(T.d * x + T.e * z + T.f); Hh.push(y);
  }
  const den = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2]);
  if (Math.abs(den) < 1e-12) return;
  const x0 = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2]))), x1 = Math.min(W - 1, Math.ceil(Math.max(X[0], X[1], X[2])));
  const y0 = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2]))), y1 = Math.min(H - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
  const eps = -1e-9;
  for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
    const px = gx + 0.5, py = gy + 0.5;
    const l0 = ((Y[1] - Y[2]) * (px - X[2]) + (X[2] - X[1]) * (py - Y[2])) / den;
    const l1 = ((Y[2] - Y[0]) * (px - X[2]) + (X[0] - X[2]) * (py - Y[2])) / den;
    const l2 = 1 - l0 - l1;
    if (l0 < eps || l1 < eps || l2 < eps) continue;
    visit(gy * W + gx, l0 * Hh[0] + l1 * Hh[1] + l2 * Hh[2]);
  }
}

// Standable floors of the game's pawn triangles per cell: Map cell -> ascending heights of floors
// with CLEAR m of nothing above them and no wall crossing the cell at body height (walls are
// vertical, so they are sampled on their own plane every ~half cell; without them the floor inside
// and outside the map would join up). Floors outside yWin are dropped (the lid over the level,
// distant terrain).
function floorLayers(P, kind, T, W, H, yWin) {
  const floors = new Map(), block = new Map(), walls = new Map();
  const add = (m, i, h) => { const a = m.get(i); if (a) a.push(h); else m.set(i, [h]); };
  const cellM = 1 / Math.hypot(T.a, T.b); // metres per cell
  const n = P.length / 9;
  for (let t = 0; t < n; t++) {
    const k = kind[t], o = t * 9;
    if (!k) continue;
    if (k < 3) { rasterTri(P, o, T, W, H, (i, h) => { add(block, i, h); if (k === 1) add(floors, i, h); }); continue; }
    const e1 = Math.hypot(P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]);
    const e2 = Math.hypot(P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]);
    const nu = Math.min(400, Math.ceil(e1 / (cellM * 0.5)) + 1), nv = Math.min(400, Math.ceil(e2 / (cellM * 0.5)) + 1);
    let last = -1, lastH = NaN;
    for (let iu = 0; iu <= nu; iu++) for (let iv = 0; iv <= nv - iu * nv / nu + 1e-9; iv++) {
      const a = iu / nu, b = iv / nv;
      if (a + b > 1 + 1e-9) continue;
      const x = P[o] + a * (P[o + 3] - P[o]) + b * (P[o + 6] - P[o]);
      const y = P[o + 1] + a * (P[o + 4] - P[o + 1]) + b * (P[o + 7] - P[o + 1]);
      const z = P[o + 2] + a * (P[o + 5] - P[o + 2]) + b * (P[o + 8] - P[o + 2]);
      const gx = Math.floor(T.a * x + T.b * z + T.c), gy = Math.floor(T.d * x + T.e * z + T.f);
      if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
      const i = gy * W + gx, hq = Math.round(y * 10) / 10;
      if (i === last && hq === lastH) continue;
      last = i; lastH = hq;
      add(walls, i, hq);
    }
  }
  const out = new Map();
  for (const [i, fl] of floors) {
    fl.sort((p, q) => p - q);
    const all = block.get(i).sort((p, q) => p - q), wl = walls.get(i), ok = [];
    for (const h of fl) {
      if (h < yWin[0] || h > yWin[1]) continue;
      let good = true;
      for (const b of all) { if (b > h + 0.05 && b < h + CLEAR) { good = false; break; } if (b >= h + CLEAR) break; }
      if (good && wl) for (const b of wl) if (b > h + 0.3 && b < h + 1.8) { good = false; break; }
      if (good) ok.push(h);
    }
    if (ok.length) out.set(i, ok);
  }
  return out;
}

// Height field (NaN = empty) for one grid: navmesh = highest surface; rook = lowest standable floor.
function heightField(G, T, W, H, layers = null) {
  const hf = new Float64Array(W * H).fill(NaN);
  if (!G.lowest) {
    const n = G.tris.length / 9;
    for (let t = 0; t < n; t++) rasterTri(G.tris, t * 9, T, W, H, (i, h) => { if (!(hf[i] >= h)) hf[i] = h; });
    return hf;
  }
  for (const [i, ok] of layers ?? floorLayers(G.pawn.tris, G.pawn.kind, T, W, H, G.yWin)) hf[i] = ok[0];
  return hf;
}

// Perches: a practice spot whose cell (or a cell next to it) is not drawn stands on something the
// navmesh leaves out (a crate, a ledge). Draw that surface: from the spot, the standable pawn floor
// nearest the spot's height, spread over undrawn cells with steps <= MAX_STEP, within 1.5 m of the
// spot's height and at most PERCH_M2.
const nearKept = (keep, W, H, [fx, fy], r = 1) => {
  const gx = Math.floor(fx), gy = Math.floor(fy);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = gx + dx, y = gy + dy;
    if (x >= 0 && y >= 0 && x < W && y < H && keep[y * W + x]) return true;
  }
  return false;
};
function addPerches(hf, keep, W, H, T, spots, layersOf) {
  let layers = null, added = 0;
  const maxCells = PERCH_M2 / ((1 / Math.hypot(T.a, T.b)) ** 2);
  for (const s of spots) {
    const fx = T.a * s.x + T.b * s.z + T.c, fy = T.d * s.x + T.e * s.z + T.f, gx = Math.floor(fx), gy = Math.floor(fy);
    if (nearKept(keep, W, H, [fx, fy]) || gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
    layers ??= layersOf();
    const pick = (i, near, tol) => { let b = NaN; for (const h of layers.get(i) ?? []) if (Math.abs(h - near) <= tol && !(Math.abs(b - near) <= Math.abs(h - near))) b = h; return b; };
    const i0 = gy * W + gx, h0 = pick(i0, s.y, 1.0);
    if (Number.isNaN(h0)) continue;
    const stack = [i0], mine = [i0];
    hf[i0] = h0; keep[i0] = 1;
    while (stack.length && mine.length < maxCells) {
      const i = stack.pop(), x = i % W, y = (i - x) / W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || keep[j]) continue;
        const h = pick(j, hf[i], MAX_STEP);
        if (Number.isNaN(h) || Math.abs(h - s.y) > 1.5) continue;
        hf[j] = h; keep[j] = 1; stack.push(j); mine.push(j);
      }
    }
    added += mine.length;
  }
  return added;
}

// Keep only cells reachable from the seeds with height steps <= MAX_STEP (4-neighbour).
function floodKeep(hf, W, H, seeds) {
  const keep = new Uint8Array(W * H), stack = [];
  for (const [gx, gy] of seeds) {
    // nearest filled cell within 6 cells of the seed
    let best = -1, bd = Infinity;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const x = Math.floor(gx) + dx, y = Math.floor(gy) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H || Number.isNaN(hf[y * W + x])) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = y * W + x; }
    }
    if (best >= 0 && !keep[best]) { keep[best] = 1; stack.push(best); }
  }
  while (stack.length) {
    const i = stack.pop(), x = i % W, y = (i - x) / W, h = hf[i];
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) if (j >= 0 && !keep[j] && Math.abs(hf[j] - h) <= MAX_STEP) { keep[j] = 1; stack.push(j); }
  }
  return keep;
}

const r6 = (v) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };

// ---------------------------------------------------------------- one map
export async function buildMap(map, name, { root = ROOT, areas, log = () => {} } = {}) {
  const mini = JSON.parse(fs.readFileSync(mapFile(map, 'minimap.json', root), 'utf8'));
  const L = liftMinimap(root);
  const k = L.bl(mini);
  const tf = mini.transform;
  if (Math.abs(tf.scaleU - tf.scaleV) > 1e-12) throw new Error(`${map}: non-square minimap scale`);
  // (x,z) -> (u,v) as an affine: u = A*x + B*z + C, v = D*x + E*z + F (equal to the lifted qs).
  const su = tf.scaleU, sv = tf.scaleV, ou = tf.offsetU, ov = tf.offsetV;
  const UV = [
    { A: su, B: 0, C: ou, D: 0, E: sv, F: ov },
    { A: 0, B: -sv, C: 1 - ov, D: su, E: 0, F: ou },
    { A: -su, B: 0, C: 1 - ou, D: 0, E: -sv, F: 1 - ov },
    { A: 0, B: sv, C: ov, D: -su, E: 0, F: 1 - ou },
  ][k];
  for (const c of mini.callouts) { // the affine must be the game's qs
    const q = L.qs(mini, c.x, c.z), u = UV.A * c.x + UV.B * c.z + UV.C, v = UV.D * c.x + UV.E * c.z + UV.F;
    if (Math.abs(q.u - u) > 1e-9 || Math.abs(q.v - v) > 1e-9) throw new Error(`${map}: affine != qs`);
  }
  const uvOf = (x, z) => [UV.A * x + UV.B * z + UV.C, UV.D * x + UV.E * z + UV.F];
  const gridT = (s, u0, v0) => ({ a: s * UV.A, b: s * UV.B, c: s * (UV.C - u0), d: s * UV.D, e: s * UV.E, f: s * (UV.F - v0) });

  // geometry
  let G;
  if (NO_NAVMESH.has(map)) {
    const T = await loadTerrain(map, { root, log });
    if (!T) throw new Error(`${map}: terrain files missing`);
    G = { tris: T.pawnTris, lowest: true, pawn: { tris: T.pawnTris, kind: classify(T.pawnTris) } };
  } else {
    G = { tris: navmeshTris(map, root), lowest: false, pawn: null };
    if (!G.tris.length) throw new Error(`${map}: no navmesh`);
  }
  const pawn = async () => {
    if (!G.pawn) {
      const T = await loadTerrain(map, { root, log });
      if (!T) throw new Error(`${map}: terrain files missing`);
      G.pawn = { tris: T.pawnTris, kind: classify(T.pawnTris) };
    }
    return G.pawn;
  };

  // points that must be in the picture: callouts, practice spawns and spots
  const pts = [];
  const seedsXZ = mini.callouts.map((c) => [c.x, c.z]);
  const ys = [], spots = [];
  for (const a of areas?.maps?.[map]?.areas ?? []) {
    pts.push([a.spawn.x, a.spawn.z]); seedsXZ.push([a.spawn.x, a.spawn.z]); ys.push(a.spawn.y);
    for (const s of a.spots) { pts.push([s.x, s.z]); ys.push(s.y); spots.push(s); }
  }
  // Pawn floors far above or below every practice point are out of the map (the lid over the
  // level, distant terrain).
  G.yWin = ys.length ? [Math.min(...ys) - 4, Math.max(...ys) + 6] : [-Infinity, Infinity];

  // pass 1: probe grid over the geometry (rook: the points' box + 20 m) to find the kept bounds
  const s1 = 1 / (su * PROBE); // probe cells per unit of u
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const grow = (u, v) => { uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); };
  if (G.lowest) {
    for (const [x, z] of [...pts, ...mini.callouts.map((c) => [c.x, c.z])]) { const [u, v] = uvOf(x, z); grow(u, v); }
    const m = 20 * su; uMin -= m; uMax += m; vMin -= m; vMax += m;
  } else {
    for (let i = 0; i < G.tris.length; i += 3) { const [u, v] = uvOf(G.tris[i], G.tris[i + 2]); grow(u, v); }
  }
  const W1 = Math.ceil((uMax - uMin) * s1) + 1, H1 = Math.ceil((vMax - vMin) * s1) + 1;
  const T1 = gridT(s1, uMin, vMin);
  const hf1 = heightField(G, T1, W1, H1);
  const toG = (T, [x, z]) => [T.a * x + T.b * z + T.c, T.d * x + T.e * z + T.f];
  const keep1 = floodKeep(hf1, W1, H1, seedsXZ.map((p) => toG(T1, p)));
  let ku0 = Infinity, ku1 = -Infinity, kv0 = Infinity, kv1 = -Infinity;
  for (let i = 0; i < keep1.length; i++) if (keep1[i]) {
    const gx = i % W1, gy = (i - gx) / W1;
    ku0 = Math.min(ku0, uMin + gx / s1); ku1 = Math.max(ku1, uMin + (gx + 1) / s1);
    kv0 = Math.min(kv0, vMin + gy / s1); kv1 = Math.max(kv1, vMin + (gy + 1) / s1);
  }
  // the practice points always fit; a callout only when there is kept floor near it (plummet's
  // Attacker Spawn callout sits off the navmesh and would leave an empty corner)
  for (const c of mini.callouts) { const [gx, gy] = toG(T1, [c.x, c.z]); if (nearKept(keep1, W1, H1, [gx, gy], 6)) pts.push([c.x, c.z]); }
  for (const [x, z] of pts) { const [u, v] = uvOf(x, z); ku0 = Math.min(ku0, u); ku1 = Math.max(ku1, u); kv0 = Math.min(kv0, v); kv1 = Math.max(kv1, v); }

  // pass 2: the final image
  const S = (LONG_SIDE - 2 * PAD) / Math.max(ku1 - ku0, kv1 - kv0);
  const W = Math.round((ku1 - ku0) * S) + 2 * PAD, H = Math.round((kv1 - kv0) * S) + 2 * PAD;
  const mm = { scale: r6(S), u0: r6(ku0 - PAD / S), v0: r6(kv0 - PAD / S) };
  const T = gridT(mm.scale, mm.u0, mm.v0);
  let layers = G.lowest ? floorLayers(G.pawn.tris, G.pawn.kind, T, W, H, G.yWin) : null;
  const hf = heightField(G, T, W, H, layers);
  const keep = floodKeep(hf, W, H, seedsXZ.map((p) => toG(T, p)));
  if (!layers && spots.some((s) => !nearKept(keep, W, H, toG(T, [s.x, s.z])))) { // terrain only when needed
    const P2 = await pawn();
    layers = floorLayers(P2.tris, P2.kind, T, W, H, G.yWin);
  }
  const perch = layers ? addPerches(hf, keep, W, H, T, spots, () => layers) : 0;

  // tones: 5 equal height bands between the 2nd and 98th percentile of kept heights
  const hs = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) hs.push(hf[i]);
  if (!hs.length) throw new Error(`${map}: no floor kept`);
  hs.sort((p, q) => p - q);
  const lo = hs[Math.floor(hs.length * 0.02)], hi = hs[Math.floor(hs.length * 0.98)];
  const tone = new Int8Array(W * H).fill(-1);
  for (let i = 0; i < keep.length; i++) if (keep[i]) tone[i] = hi > lo ? Math.max(0, Math.min(4, Math.floor((hf[i] - lo) / (hi - lo) * 5))) : 2;

  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    if (tone[i] < 0) continue;
    const x = i % W, y = (i - x) / W, h = hf[i];
    let edge = false, step = false;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j < 0 || tone[j] < 0) { edge = true; break; }
      if (h - hf[j] > MAX_STEP) edge = true;                // top of a ledge
      else if (tone[j] > tone[i]) step = true;              // foot of a slope band
    }
    const c = edge ? OUTLINE : step ? STEPLINE : TONES[tone[i]];
    px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
  }
  const world = { a: r6(T.a), b: r6(T.b), c: r6(T.c), d: r6(T.d), e: r6(T.e), f: r6(T.f) };
  log(`${map}: ${W}x${H}, ${hs.length} floor px (${perch} perch), heights ${lo?.toFixed(1)}..${hi?.toFixed(1)} m, k=${k}`);
  return {
    entry: { id: map, name, preview: `/aim-maps/${map}.preview.png`, size: [W, H], world, mm, pixels: pixelSha(px) },
    rgba: px, w: W, h: H,
  };
}

// ---------------------------------------------------------------- PNG (RGBA, filter 0)
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};
export function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// Decoder for 8-bit RGB/RGBA non-interlaced PNGs (all five filters). Returns {w, h, rgba}.
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9];
      if (data[8] !== 8 || (ct !== 6 && ct !== 2) || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * h) throw new Error('PNG data size');
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  if (bpp === 4) return { w, h, rgba: out };
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1]; rgba[i * 4 + 2] = out[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
  return { w, h, rgba };
}
export const pixelSha = (rgba) => crypto.createHash('sha256').update(rgba).digest('hex').slice(0, 16);

// One map per line, LF.
export const mapsJsonText = (entries) => `[\n${entries.map((e) => ` ${JSON.stringify(e)}`).join(',\n')}\n]\n`;

// ---------------------------------------------------------------- cli
async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
  const outDir = opt('--out') ? path.resolve(opt('--out')) : path.join(ROOT, 'app', 'mods', 'aim-maps');
  const areas = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'mods', 'aim-practice', 'areas.json'), 'utf8'));
  const jsonFile = path.join(outDir, 'maps.json');
  const old = fs.existsSync(jsonFile) ? JSON.parse(fs.readFileSync(jsonFile, 'utf8')) : [];
  const entries = [], bad = [];
  for (const [id, name] of MAPS) {
    if (only && !only.has(id)) { const e = old.find((x) => x.id === id); if (e) entries.push(e); continue; }
    const pngFile = path.join(outDir, `${id}.preview.png`);
    const r = await buildMap(id, name, { areas, log: (s) => console.log(s) });
    entries.push(r.entry);
    if (check) {
      if (!fs.existsSync(pngFile)) { bad.push(`${id}: missing preview.png`); continue; }
      const d = decodePng(fs.readFileSync(pngFile));
      if (d.w !== r.w || d.h !== r.h || pixelSha(d.rgba) !== r.entry.pixels) bad.push(`${id}: preview.png out of date`);
      continue;
    }
    const png = encodePng(r.rgba, r.w, r.h);
    if (png.length > MAX_PNG) throw new Error(`${id}: preview.png is ${png.length} bytes (> ${MAX_PNG})`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(pngFile, png);
    console.log(`${id}: wrote ${path.relative(ROOT, pngFile)} (${png.length} bytes)`);
  }
  const text = mapsJsonText(entries);
  if (check) {
    const cur = fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== text) bad.push('maps.json out of date');
    if (bad.length) { console.error(`map previews: ${bad.join('; ')}. Run node tools/maps_previews.mjs`); process.exit(1); }
    console.log('map previews up to date');
    return;
  }
  fs.writeFileSync(jsonFile, text);
  console.log(`wrote ${path.relative(ROOT, jsonFile)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
