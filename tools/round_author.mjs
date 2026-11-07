// Round mode map data (app/mods/aim-rounds/<map>.json), authored from the map files on disk.
//
//   node tools/round_author.mjs [--map ascent] [--image <barrier reference png>] [--plot <out.svg>] [--check]
//                               [--attack-plot <out.png>]
//
// Node only, no app or browser. Reads site/aim-maps/<map>.collision.json (pawn collision + the
// gameplay navmesh and BombsiteMarker volumes) and <map>.minimap.json (callout names + world spots).
//
// How the Ascent barriers were placed (reproducible, all inputs are in this file):
//  1. The user's top-down callout picture (800x400, red = defender side, green = attacker side,
//     grey = neutral, thick red/teal marks = defender/attacker barriers) is a reference only and is
//     not shipped. The pixel centres of its callout labels (LABELS) and of its barrier marks (MARKS,
//     found by colour segmentation: red r>200,g<110,b<110; teal r<110,g>170,b>150) are written down
//     below, so the data rebuilds without the picture.
//  2. A 2D similarity transform picture px -> world (x,z) is fitted by least squares to the labels
//     that also exist as game callouts (minimap.json, Chinese names mapped in CALLOUTS). Labels that
//     sit far from the game's callout spot (residual > 6 m on the first fit) are dropped and the fit
//     is redone; residuals are stored in the output (authoring.transform).
//  3. Each mark is moved into world space and snapped to the narrowest real choke within +-3 m
//     across the corridor: horizontal rays at 0.3/0.9/1.5 m above the floor, both ways along the
//     mark, against the pawn collision. The widest hit per side (+0.5 m into the wall) gives the
//     segment end points, so the segment spans the corridor at every height a player can be.
//     A mark whose rays don't hit walls on both sides within 20 m fails the build.
//     Collision = pawn set + greybox set (the game also walks on the art meshes, which are
//     meshopt-compressed in the GLB and not decoded here; greybox is the blockout of the same
//     walls), so segments reach 0.5 m into the walls to cover small differences.
//  4. Plant zones = the BombsiteMarker volumes (instances at the world origin are ignored), with
//     the floor height range sampled from the pawn collision inside the zone.
//  5. Spawns are a row of 5 points around each team's spawn callout (floor + clearance checked);
//     defender setup spots are spots of the shipped Ascent drills that lie on the defender side.
//  6. Retake staging points (where defender bots group up before retaking a planted site) are
//     authored in RETAKE below; how they were picked is written next to them.
//  7. Seal check: the real nav graph (app/mods/aim-rounds/<map>.nav.bin, tools/round_nav.mjs) is
//     flooded from each team's spawns with that team's barriers up, over walk edges only and over
//     all edges (walk, drop, jump, gap). No callout outside the team's side may be reached.
//     Needs the nav.bin (committed); it doesn't need the 57 MB pawn bake or any ray.
//     With --image, every spawn / setup spot is also checked against the picture's colours.
//  8. Attacker routes, staging points and plant spots (round mode R3) are authored in ATTACK below;
//     how they were picked is written next to them.
//
// --plot writes a top-down SVG (navmesh floor shaded by height, barriers, zones, spawns, setups;
// with --image the picture is drawn underneath, transformed, for checking by eye — keep that SVG
// local, the picture isn't ours to ship). --check rebuilds and fails if the stored file differs.
// --attack-plot writes a top-down PNG of the attacker data from the nav.bin header (header `attack`,
// so run tools/round_nav.mjs --reuse first): routes, entry waypoints, plant and post-plant spots.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseRoundNav } from '../app/mods/aim-rounds/round-nav.mjs';
import { TYPES, nodeIndex, nodesNear, nearestNode, flood, barrierMask } from './round_navlib.mjs';
import { attackPlot } from './round_navdata.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('--map', 'ascent');
const IMAGE = opt('--image');
const PLOT = opt('--plot');
const CHECK = args.includes('--check');
const ATTACK_PLOT = opt('--attack-plot');
const OUT = path.join(ROOT, 'app', 'mods', 'aim-rounds', `${MAP}.json`);

// ---------------------------------------------------------------- per-map hand input
const MAPS = {
  ascent: {
    name: 'Ascent',
    // English name -> game callout (minimap.json, Chinese).
    CALLOUTS: {
      'Attacker Spawn': '攻方 重生点', 'Defender Spawn': '守方 重生点',
      'A Site': 'A区 部署区', 'A Tree': 'A区 树木', 'A Lobby': 'A区 大厅', 'A Main': 'A区 大道',
      'A Window': 'A区 窗口', 'A Garden': 'A区 花园', 'A Rafters': 'A区 高台', 'A Wine': 'A区 酒庄',
      'B Site': 'B区 部署区', 'B Lobby': 'B区 大厅', 'B Main': 'B区 大道', 'Boat House': 'B区 船屋',
      'Mid Bottom': '中区 坡底', 'Mid Top': '中区 坡顶', 'Mid Catwalk': '中区 窄道', 'Mid Cubby': '中区 小房间',
      'Mid Market': '中区 市场', 'Mid Courtyard': '中区 庭院', 'Mid Link': '中区 小道', 'Mid Plaza': '中区 比萨',
    },
    // Label centres in the reference picture (px), measured on the picture.
    LABELS: {
      'Defender Spawn': [412, 30.5], 'B Site': [276, 105], 'Boat House': [230, 101], 'Mid Market': [361, 108.5],
      'Mid Plaza': [399, 118], 'A Window': [470, 92], 'A Garden': [459, 107.5], 'A Rafters': [537, 92],
      'A Site': [534, 133], 'A Tree': [471.5, 153], 'B Main': [296, 155], 'Mid Bottom': [389, 157],
      'Mid Courtyard': [382, 192], 'Mid Cubby': [456, 184], 'A Main': [517.5, 188.5], 'A Wine': [560.5, 187],
      'Mid Link': [345, 204.5], 'B Lobby': [301.5, 222], 'Mid Catwalk': [419, 207.5], 'A Lobby': [484, 236.5],
      'Mid Top': [433, 265], 'Attacker Spawn': [351.5, 329],
    },
    // Barrier marks in the picture (px end points). The B Site mark is 3 dashes, each snapped on
    // its own (B Main has two doorways into B Site); dashes that snap to the same doorway merge.
    // `floor` = expected floor height near a mark (B has a roof above the doorways).
    // Mid Link and Mid Top marks are split by their labels and used whole.
    MARKS: [
      { id: 'def-b1', team: 'defense', name: 'B Site / B Main', a: [273, 141], b: [284, 141], floor: 1 },
      { id: 'def-b2', team: 'defense', name: 'B Site / B Main', a: [292, 141], b: [303, 141], floor: 1 },
      { id: 'def-b3', team: 'defense', name: 'B Site / B Main (right)', a: [315, 141], b: [326, 141], floor: 1 },
      { id: 'def-mid', team: 'defense', name: 'Mid Bottom / Market', a: [379, 141.5], b: [398, 141.5] },
      { id: 'def-tree', team: 'defense', name: 'A Tree / Mid Cubby', a: [451, 165.5], b: [459, 165.5] },
      { id: 'def-a', team: 'defense', name: 'A Site / A Main', a: [525, 172.5], b: [539, 172.5] },
      { id: 'atk-bmain', team: 'attack', name: 'B Lobby / B Main', a: [275, 188.5], b: [285, 188.5] },
      { id: 'atk-link', team: 'attack', name: 'B Lobby / Mid Link', a: [330, 198], b: [330, 209] },
      { id: 'atk-midtop', team: 'attack', name: 'Mid Top', a: [441.5, 253], b: [441.5, 273] },
      { id: 'atk-amain', team: 'attack', name: 'A Lobby / A Main', a: [469, 223.5], b: [498, 223.5] },
    ],
    SPAWNS: { attack: 'Attacker Spawn', defense: 'Defender Spawn' },
    // Barrier phase side of each callout (from the picture: red / green / grey).
    SIDES: {
      'Attacker Spawn': 'attack', 'B Lobby': 'attack', 'A Lobby': 'attack',
      'Defender Spawn': 'defense', 'B Site': 'defense', 'Boat House': 'defense', 'Mid Market': 'defense', 'Mid Plaza': 'defense',
      'A Garden': 'defense', 'A Window': 'defense', 'A Rafters': 'defense', 'A Site': 'defense', 'A Tree': 'defense',
      'B Main': 'neutral', 'Mid Bottom': 'neutral', 'Mid Courtyard': 'neutral', 'Mid Link': 'neutral', 'Mid Cubby': 'neutral',
      'Mid Catwalk': 'neutral', 'Mid Top': 'neutral', 'A Main': 'neutral', 'A Wine': 'neutral',
    },
    // Defender setup spots (x,y,z) from the shipped Ascent drills (codes in comments).
    SETUPS: {
      A: [[-69.7, 5.0, -63.3, 'A site default'], [-66.5, 5.0, -55.5, 'A site front'], [-65.2, 5.29, -69.1, 'A generator'],
        [-72.6, 5.11, -52.3, 'A site tree side'], [-78.8, 8.28, -58.8, 'A heaven'], [-79.5, 8.09, -52.7, 'A heaven tree side'],
        [-83.2, 8.09, -67.3, 'A rafters back']], // 1b59…
      mid: [[-72.6, 3.0, 0.7, 'Market'], [-80.8, 3.0, 4.7, 'Market back'], [-72.6, 3.0, -18.0, 'Pizza']], // 0466…, 54d7…
      B: [[-82.7, -1.0, 25.3, 'B default'], [-86.6, -0.95, 30.4, 'B back site'], [-76.7, -0.98, 34.1, 'B boathouse side'],
        [-69.1, 0.96, 23.7, 'B site front'], [-76.3, 1.0, 20.8, 'B workshop']], // 54d7…, 302e…
    },
    // Default defender splits [A, mid, B] (seeded pick at round start).
    SPLITS: [[2, 1, 2], [2, 1, 2], [3, 0, 2], [2, 0, 3], [1, 1, 3], [3, 1, 1]],
    // Retake staging points, 2 per site (x, floor y, z on the nav graph). Picked by computation on
    // the real nav graph: nodes 2.5-4 s (walk + drop) from the site centre, reachable from the
    // defender spawn inside the defender barriers, outside the plant zone, on open floor, and hidden
    // from 1 m above the site centre (the bots' sight ray to 1.0 and 1.6 m above the node); per
    // approach the one closest to 3 s with the least detour from the defender's own route
    // (`node tools/round_nav.mjs --candidates A` lists them; A heaven, A tree and B CT are the top
    // picks). On Ascent B has a single defender-side doorway, so every low-detour B candidate shares
    // one entry group (the other groups come in from the back, ~5 s detour); B market is the node on
    // the route from Mid Market (3.45 s), about 3 m before that route joins the CT one. tools/round_nav.mjs re-checks all four (header `staging`).
    RETAKE: {
      A: [[-82.83, 8.09, -50.33, 'A heaven'], [-61.33, 4.0, -46.83, 'A tree']],
      B: [[-86.33, 1.0, 13.17, 'B CT'], [-81.33, 1.0, 10.17, 'B market']],
    },
    // Attacker bot data (round mode R3, the player defends): 2 routes per site, each with 3 staging
    // points where the attackers group up and an entry waypoint the route passes; 2 plant spots per
    // site. All picked by computation on the real nav graph (tools/round_navdata.mjs):
    //  - staging: attackStagingCandidates() around the route's callout spot (A Main, Mid Cubby,
    //    B Main, Mid Bottom; all neutral in SIDES, never the defender side): open floor, reached from
    //    all 5 attacker spawns on walk + drop edges; nearest the callout, greedily 1.5 m apart.
    //  - entry: a node on the bots' shortest walk + drop path from the staging point to the site:
    //    A Main = the A Main doorway (def-a), Mid Cubby = A Tree (defender side), B Main = the right
    //    B Main doorway (def-b3; walk + drop paths from B Main into B all use it and come in past
    //    B CT), Mid Market = Market (defender side; the route stages at Mid Bottom).
    //  - plant: plantCandidates(): at least 1 m inside the zone, every attacker node within 1 m in
    //    the zone and defusable, open floor. "default" = the candidate nearest the site goal, the
    //    second about 6 m away on another part of the site (A: by the generator, B: boathouse side).
    // tools/round_nav.mjs (--reuse) derives the checks and the post-plant spots (header `attack`).
    ATTACK: {
      routes: {
        A: [
          { name: 'A Main', entry: [-55.33, 4.0, -59.33, 'A Main door'], staging: [[-47.33, 4.0, -53.33, 'A Main 1'], [-45.83, 4.0, -53.33, 'A Main 2'], [-47.33, 4.0, -51.83, 'A Main 3']] },
          { name: 'Mid Cubby', entry: [-56.83, 4.0, -40.83, 'A Tree'], staging: [[-51.33, 4.0, -33.83, 'Mid Cubby 1'], [-51.33, 4.0, -35.33, 'Mid Cubby 2'], [-49.83, 4.0, -33.83, 'Mid Cubby 3']] },
        ],
        B: [
          { name: 'B Main', entry: [-63.83, 1.0, 13.17, 'B Main door'], staging: [[-58.33, 1.0, 19.67, 'B Main 1'], [-58.33, 1.0, 21.17, 'B Main 2'], [-59.83, 1.0, 19.67, 'B Main 3']] },
          { name: 'Mid Market', entry: [-72.83, 3.0, -3.83, 'Market'], staging: [[-59.33, 2.0, -11.33, 'Mid Bottom 1'], [-60.83, 2.0, -11.33, 'Mid Bottom 2'], [-59.33, 2.0, -9.83, 'Mid Bottom 3']] },
        ],
      },
      plant: {
        A: [[-71.83, 5.0, -60.83, 'A default'], [-68.33, 5.0, -66.33, 'A generator']],
        B: [[-78.83, -1.07, 30.17, 'B default'], [-77.33, -0.99, 36.17, 'B boathouse']],
      },
    },
  },
};
const M = MAPS[MAP];
if (!M) throw new Error(`no hand input for map ${MAP}`);

// ---------------------------------------------------------------- collision
const col = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'aim-maps', `${MAP}.collision.json`), 'utf8'));
const mini = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'aim-maps', `${MAP}.minimap.json`), 'utf8'));
function instances(setName, filter) {
  const set = col.sets[setName], out = [];
  for (let i = 0; i < set.count; i++) {
    const prim = col.prims[set.prim[i]];
    if (filter && !filter(prim.name, i)) continue;
    out.push({ i, prim, m: set.m.slice(i * 12, i * 12 + 12) });
  }
  return out;
}
function trisOf(list) {
  const out = [];
  for (const { prim, m } of list) {
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    const v = (k) => {
      const x = prim.pos[k * 3], y = prim.pos[k * 3 + 1], z = prim.pos[k * 3 + 2];
      return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
    };
    for (let t = 0; t < prim.idx.length; t += 3) {
      const a = v(prim.idx[t]), b = v(prim.idx[t + 1]), c = v(prim.idx[t + 2]);
      out.push(det < 0 ? [a, c, b] : [a, b, c]);
    }
  }
  return out;
}
// The game's walk world is the pawn set plus the map's art meshes (meshopt-compressed GLB, not
// decoded here). The greybox set (the level blockout) stands in for the art: floors and walls.
const pawn = [...trisOf(instances('pawn')), ...trisOf(instances('greybox'))];
const nav = trisOf(instances('gameplay', (n) => /NavMesh/.test(n)));
const box3 = (t) => [Math.min(t[0][0], t[1][0], t[2][0]), Math.max(t[0][0], t[1][0], t[2][0]), Math.min(t[0][2], t[1][2], t[2][2]), Math.max(t[0][2], t[1][2], t[2][2])];
const pawnBox = pawn.map(box3);

// Möller–Trumbore, both faces. Returns distance or -1.
function ray(o, d, tri, max) {
  const [a, b, c] = tri;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det, s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return -1;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 1e-6 && t <= max ? t : -1;
}
function cast(o, d, max) {
  let best = -1;
  const x0 = Math.min(o[0], o[0] + d[0] * max), x1 = Math.max(o[0], o[0] + d[0] * max);
  const z0 = Math.min(o[2], o[2] + d[2] * max), z1 = Math.max(o[2], o[2] + d[2] * max);
  for (let i = 0; i < pawn.length; i++) {
    const b = pawnBox[i];
    if (b[1] < x0 || b[0] > x1 || b[3] < z0 || b[2] > z1) continue;
    const t = ray(o, d, pawn[i], best < 0 ? max : best);
    if (t >= 0) best = t;
  }
  return best;
}
// Floor: the highest up-facing pawn surface at or below `from` (default: just above the navmesh).
function navHeight(x, z) {
  let best = null;
  for (const t of nav) { const h = ray([x, 200, z], [0, -1, 0], t, 400); if (h >= 0) { const y = 200 - h; if (best === null || y > best) best = y; } }
  return best;
}
function floorAt(x, z, from = null) {
  const top = from ?? ((navHeight(x, z) ?? 20) + 0.3);
  const h = cast([x, top, z], [0, -1, 0], 30);
  return h < 0 ? null : +(top - h).toFixed(3);
}

// ---------------------------------------------------------------- picture -> world transform
const callout = Object.fromEntries(mini.callouts.map((c) => [c.name, [c.x, c.z]]));
function fitSimilarity(keys) {
  const pts = keys.map((k) => [...M.LABELS[k], ...callout[M.CALLOUTS[k]]]);
  const n = pts.length; let mu = 0, mv = 0, mx = 0, mz = 0;
  for (const [u, v, x, z] of pts) { mu += u / n; mv += v / n; mx += x / n; mz += z / n; }
  let a = 0, b = 0, d = 0;
  for (const [u, v, x, z] of pts) { const U = u - mu, V = v - mv, X = x - mx, Z = z - mz; a += U * X + V * Z; b += U * Z - V * X; d += U * U + V * V; }
  const A = a / d, B = b / d;
  const f = (u, v) => [A * (u - mu) - B * (v - mv) + mx, B * (u - mu) + A * (v - mv) + mz];
  const inv = (x, z) => { const X = x - mx, Z = z - mz, s = A * A + B * B; return [(A * X + B * Z) / s + mu, (-B * X + A * Z) / s + mv]; };
  const residuals = Object.fromEntries(keys.map((k) => { const w = f(...M.LABELS[k]); const c = callout[M.CALLOUTS[k]]; return [k, +Math.hypot(w[0] - c[0], w[1] - c[1]).toFixed(2)]; }));
  return { f, inv, A, B, mu, mv, mx, mz, residuals, metresPerPx: Math.hypot(A, B), rotationDeg: Math.atan2(B, A) * 180 / Math.PI };
}
let keys = Object.keys(M.LABELS).filter((k) => callout[M.CALLOUTS[k]]);
const first = fitSimilarity(keys);
const dropped = keys.filter((k) => first.residuals[k] > 6);
keys = keys.filter((k) => !dropped.includes(k));
const T = fitSimilarity(keys);
const rms = Math.sqrt(Object.values(T.residuals).reduce((s, r) => s + r * r, 0) / keys.length);

// ---------------------------------------------------------------- barriers (snap to choke)
const r2 = (v) => +v.toFixed(2);
function snapBarrier(mark) {
  const a = T.f(...mark.a), b = T.f(...mark.b);
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz); dx /= L; dz /= L;
  const nx = -dz, nz = dx;
  let best = null;
  for (let t = -3; t <= 3.001; t += 0.25) {
    const px = c[0] + nx * t, pz = c[1] + nz * t;
    const fy = floorAt(px, pz, mark.floor === undefined ? null : mark.floor + 1.5);
    if (fy === null) continue;
    let plus = 0, minus = 0, ok = true;
    for (const h of [0.3, 0.9, 1.5]) {
      const o = [px, fy + h, pz];
      const p1 = cast(o, [dx, 0, dz], 20), m1 = cast(o, [-dx, 0, -dz], 20);
      if (p1 < 0 || m1 < 0) { ok = false; break; }
      plus = Math.max(plus, p1); minus = Math.max(minus, m1);
    }
    if (!ok) continue;
    const width = plus + minus;
    if (!best || width < best.width - 0.05) best = { t, width, px, pz, fy, plus, minus };
  }
  if (!best) throw new Error(`barrier ${mark.id}: no closed choke within 3 m of the mark`);
  const { px, pz, fy, plus, minus } = best;
  // Height range: the floors on both sides of the line (1 and 2.5 m out, across the opening),
  // from 1 m under the lowest to 4.5 m over the highest, so feet on either side are inside it.
  const floors = [fy];
  for (const side of [-1, 1]) for (const out of [1, 2.5]) for (const k of [-0.6, -0.3, 0, 0.3, 0.6]) {
    const along = k > 0 ? k * plus : k * minus;
    const f = floorAt(px + nx * out * side + dx * along, pz + nz * out * side + dz * along, fy + 2.2);
    if (f !== null && Math.abs(f - fy) < 2.5) floors.push(f);
  }
  const lo = Math.min(...floors), hi = Math.max(...floors);
  return {
    id: mark.id, team: mark.team, name: mark.name,
    a: { x: r2(px - dx * (minus + 0.5)), z: r2(pz - dz * (minus + 0.5)) },
    b: { x: r2(px + dx * (plus + 0.5)), z: r2(pz + dz * (plus + 0.5)) },
    y: [r2(lo - 1), r2(hi + 4.5)],
    width: r2(best.width), shift: r2(best.t), floors: [r2(lo), r2(hi)],
    mark: { a: mark.a, b: mark.b, world: { x: r2(c[0]), z: r2(c[1]) } },
  };
}
const barriers = [];
for (const b of M.MARKS.map(snapBarrier)) {
  const same = barriers.find((o) => o.team === b.team && Math.hypot(o.a.x - b.a.x, o.a.z - b.a.z) + Math.hypot(o.b.x - b.b.x, o.b.z - b.b.z) < 2);
  if (!same) barriers.push(b);
}

// ---------------------------------------------------------------- sites / plant zones
function siteZones() {
  const out = [];
  for (const { prim, m } of instances('gameplay', (n) => /^BombsiteMarker_0_Bombsite[A-Z]$/.test(n))) {
    if (Math.abs(m[3]) < 1e-6 && Math.abs(m[11]) < 1e-6) continue; // parked at the world origin
    const tris = trisOf([{ prim, m }]);
    const xs = tris.flat().map((v) => v[0]), zs = tris.flat().map((v) => v[2]), ys = tris.flat().map((v) => v[1]);
    const id = prim.name.slice(-1);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const heights = [];
    for (let x = x0 + 0.5; x < x1; x += 1) for (let z = z0 + 0.5; z < z1; z += 1) {
      const f = floorAt(x, z, Math.max(...ys) + 2);
      if (f !== null) heights.push(f);
    }
    heights.sort((p, q) => p - q);
    const lo = heights[Math.floor(heights.length * 0.02)], hi = heights[Math.floor(heights.length * 0.98)];
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    out.push({
      id, zone: [[r2(x0), r2(z0)], [r2(x1), r2(z0)], [r2(x1), r2(z1)], [r2(x0), r2(z1)]],
      y: [r2(lo - 0.3), r2(hi + 0.6)],
      center: { x: r2(cx), y: floorAt(cx, cz, Math.max(...ys) + 2) ?? r2(lo), z: r2(cz) },
    });
  }
  return out.sort((p, q) => p.id.localeCompare(q.id));
}
const sites = siteZones();

// ---------------------------------------------------------------- spawns, setups
const yawTo = (dx, dz) => r2(Math.atan2(-dx, -dz)); // the game's forward is (-sin yaw, -cos yaw)
function clearance(x, y, z) {
  let min = 99;
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; const h = cast([x, y + 0.9, z], [Math.cos(a), 0, Math.sin(a)], 3); if (h >= 0) min = Math.min(min, h); }
  return min;
}
function spawnRow(name, facing) {
  const [cx, cz] = callout[M.CALLOUTS[name]];
  const pts = [];
  // Rows across the facing direction; try a few rows until 5 clear points are found.
  const fx = facing[0] - cx, fz = facing[1] - cz, fl = Math.hypot(fx, fz);
  const ux = fx / fl, uz = fz / fl, sx = -uz, sz = ux;
  for (const row of [0, -2, 2, -4, 4]) for (const off of [0, -1.6, 1.6, -3.2, 3.2, -4.8, 4.8]) {
    if (pts.length >= 5) break;
    const x = cx + ux * row + sx * off, z = cz + uz * row + sz * off;
    const y = floorAt(x, z);
    if (y === null || clearance(x, y, z) < 0.8) continue;
    if (pts.some((p) => Math.hypot(p.x - x, p.z - z) < 1.4)) continue;
    pts.push({ x: r2(x), y, z: r2(z), yaw: yawTo(ux, uz) });
  }
  if (pts.length < 5) throw new Error(`spawn ${name}: only ${pts.length} clear points`);
  return pts;
}
const mid = callout[M.CALLOUTS['Mid Courtyard']] ?? [0, 0];
const spawns = { attack: spawnRow(M.SPAWNS.attack, mid), defense: spawnRow(M.SPAWNS.defense, mid) };
const setups = {};
for (const [group, list] of Object.entries(M.SETUPS)) {
  setups[group] = list.map(([x, y, z, name]) => {
    const f = floorAt(x, z, y + 1.2);
    if (f === null || Math.abs(f - y) > 0.6) throw new Error(`setup ${name}: no floor near y=${y} (got ${f})`);
    return { name, x, y: f, z };
  });
}
const retake = {};
for (const [site, list] of Object.entries(M.RETAKE ?? {})) {
  retake[site] = list.map(([x, y, z, name]) => {
    const f = floorAt(x, z, y + 1.2);
    if (f === null || Math.abs(f - y) > 0.6) throw new Error(`retake ${name}: no floor near y=${y} (got ${f})`);
    return { name, x, y: f, z };
  });
}
// Attacker routes / plant spots (round mode R3): same floor check as the retake points.
const floored = ([x, y, z, name], what) => {
  const f = floorAt(x, z, y + 1.2);
  if (f === null || Math.abs(f - y) > 0.6) throw new Error(`${what} ${name}: no floor near y=${y} (got ${f})`);
  return { name, x, y: f, z };
};
let attack = null;
if (M.ATTACK) {
  attack = { routes: {}, plant: {} };
  for (const [site, list] of Object.entries(M.ATTACK.routes)) {
    attack.routes[site] = list.map((rt) => ({ name: rt.name, entry: floored(rt.entry, 'attack entry'), staging: rt.staging.map((p) => floored(p, 'attack staging')) }));
  }
  for (const [site, list] of Object.entries(M.ATTACK.plant)) attack.plant[site] = list.map((p) => floored(p, 'plant spot'));
}

// ---------------------------------------------------------------- seal check (real nav graph)
// Flood the baked nav graph from each team's 5 spawns with that team's barriers up (an edge is cut
// when its xz segment crosses a barrier and either end's floor is inside the barrier's y range),
// once over walk edges and once over all edges. A callout is reached when a node within 1 m of its
// spot (on the floor of the nearest node within 4 m) is reached. Any callout outside the team's own
// side reached = leak = failure. Own callouts not reached are listed (walk-only can miss some).
const NAV_FILE = path.join(ROOT, 'app', 'mods', 'aim-rounds', `${MAP}.nav.bin`);
const sealReport = {};
if (!fs.existsSync(NAV_FILE)) {
  console.error(`seal check: no ${path.relative(ROOT, NAV_FILE)}; write this file, run node tools/round_nav.mjs, then run this again`);
  process.exitCode = 1;
} else {
  const g = parseRoundNav(fs.readFileSync(NAV_FILE)), H = nodeIndex(g);
  sealReport.nav = { file: path.relative(ROOT, NAV_FILE).split(path.sep).join('/'), nodes: g.count, edges: g.edgeCount };
  const sample = (x, z) => {
    const n = nearestNode(g, H, x, z, 4); if (n < 0) return [];
    const l = nodesNear(g, H, x, z, 1, g.y[n], 0.6); return l.length ? l : [n];
  };
  const spots = Object.entries(M.CALLOUTS).filter(([name]) => M.SIDES[name] && callout[M.CALLOUTS[name]])
    .map(([name, cn]) => ({ name, side: M.SIDES[name], nodes: sample(...callout[cn]) }));
  for (const team of ['attack', 'defense']) {
    const sp = spawns[team].map((p) => nearestNode(g, H, p.x, p.z, 0.75, p.y, 1));
    if (sp.some((n) => n < 0)) { console.error(`seal check: a ${team} spawn is off the nav graph`); process.exitCode = 1; }
    const mask = barrierMask(g, barriers.filter((b) => b.team === team));
    const res = {};
    for (const [mode, types] of [['walk', TYPES.walk], ['all', TYPES.all]]) {
      const par = flood(g, sp, { types, mask });
      let nodes = 0; for (let i = 0; i < g.count; i++) if (par[i] !== -2) nodes++;
      const leaks = [], unreached = [];
      for (const c of spots) {
        const hit = c.nodes.some((i) => par[i] !== -2);
        if (c.side !== team && hit) leaks.push(c.name);
        if (c.side === team && !hit) unreached.push(c.name);
      }
      res[mode] = { nodes, leaks, unreached };
    }
    const leaks = [...new Set([...res.walk.leaks, ...res.all.leaks])];
    sealReport[team] = { nodes: res.all.nodes, leaks, unreached: res.all.unreached, walk: res.walk, all: res.all };
    if (leaks.length) { console.error(`seal check: ${team} barriers leak into ${leaks.join(', ')}`); process.exitCode = 1; }
  }
}

// ---------------------------------------------------------------- optional picture checks
let picture = null;
if (IMAGE) {
  picture = decodePng(fs.readFileSync(IMAGE));
  // Majority colour within 6 px (labels are grey boxes drawn over the areas).
  const pxSide = (X, Y) => {
    if (X < 0 || Y < 0 || X >= picture.w || Y >= picture.h) return 'void';
    const o = (Y * picture.w + X) * 4, [r, g, b, a] = picture.data.subarray(o, o + 4);
    if (a < 128) return 'void';
    if (r > 235 && g > 235 && b > 235) return null; // label text
    if (r > g + 20 && r > b + 10) return 'defense';
    if (g > r + 20) return 'attack';
    return 'neutral';
  };
  const side = (x, z) => {
    const [u, v] = T.inv(x, z), n = {};
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      if (dx * dx + dy * dy > 36) continue;
      const k = pxSide(Math.round(u) + dx, Math.round(v) + dy); if (k) n[k] = (n[k] || 0) + 1;
    }
    return Object.entries(n).sort((p, q) => q[1] - p[1])[0]?.[0] ?? 'void';
  };
  const bad = [];
  for (const p of spawns.attack) if (side(p.x, p.z) !== 'attack') bad.push(`attacker spawn ${p.x},${p.z}: ${side(p.x, p.z)}`);
  for (const p of spawns.defense) if (side(p.x, p.z) !== 'defense') bad.push(`defender spawn ${p.x},${p.z}: ${side(p.x, p.z)}`);
  for (const list of Object.values(setups)) for (const p of list) if (side(p.x, p.z) !== 'defense') bad.push(`setup ${p.name}: ${side(p.x, p.z)}`);
  for (const s of sites) if (side(s.center.x, s.center.z) !== 'defense') bad.push(`site ${s.id}: ${side(s.center.x, s.center.z)}`);
  if (bad.length) { console.error('picture check failed:\n  ' + bad.join('\n  ')); process.exitCode = 1; }
  else console.log('picture check: spawns, setups and sites are on the right side');
}

// ---------------------------------------------------------------- output
const data = {
  schema: 1, map: MAP, name: M.name,
  // attack = the team that carries the spike. Both lists hold 5 points with the facing yaw.
  spawns,
  // Barrier phase walls: a team can't cross its own segments until the barriers drop.
  barriers: barriers.map(({ mark, shift, floors, ...b }) => b),
  sites,
  setups: { defense: setups, splits: M.SPLITS },
  // Retake staging points per site (defender bots group here before retaking a planted site).
  retake,
  // Attacker bots (the player defends): routes per site (name, entry waypoint, staging points) and
  // plant spots per site. round-scene (R3 step S4) copies it into rules.round.attackData; header `attack` in
  // <map>.nav.bin holds the checks and the post-plant spots.
  ...(attack ? { attack } : {}),
  authoring: {
    tool: 'tools/round_author.mjs',
    transform: {
      metresPerPx: r2(T.metresPerPx), rotationDeg: r2(T.rotationDeg), rmsM: r2(rms),
      residualsM: T.residuals, dropped: Object.fromEntries(dropped.map((k) => [k, first.residuals[k]])),
    },
    barriers: Object.fromEntries(barriers.map((b) => [b.id, { mark: b.mark, shiftM: b.shift, widthM: b.width, floors: b.floors }])),
    seal: sealReport,
  },
};
const text = JSON.stringify(data, null, 1) + '\n';
if (CHECK) {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (old !== text) { console.error(`${path.relative(ROOT, OUT)} is out of date: rerun node tools/round_author.mjs`); process.exit(1); }
  console.log(`${path.relative(ROOT, OUT)} is up to date`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}
console.log(`transform: ${T.metresPerPx.toFixed(3)} m/px, rotation ${T.rotationDeg.toFixed(1)} deg, rms ${rms.toFixed(2)} m over ${keys.length} callouts; dropped ${dropped.join(', ') || 'none'}`);
for (const b of barriers) console.log(`  ${b.id.padEnd(11)} ${b.name.padEnd(20)} width ${b.width.toFixed(2)} m, moved ${b.shift} m across, floors ${b.floors[0]}..${b.floors[1]}, wall y ${b.y[0]}..${b.y[1]}`);
for (const team of ['attack', 'defense']) {
  const r = sealReport[team]; if (!r) continue;
  console.log(`  seal ${team}: walk ${r.walk.nodes} / all edges ${r.all.nodes} nav nodes reached, leaks: ${r.leaks.join(', ') || 'none'}, own callouts not reached: ${r.unreached.join(', ') || 'none'} (walk only: ${r.walk.unreached.join(', ') || 'none'})`);
}
for (const s of sites) console.log(`  site ${s.id}: zone x ${s.zone[0][0]}..${s.zone[2][0]} z ${s.zone[0][1]}..${s.zone[2][1]}, floor ${s.y[0]}..${s.y[1]}`);
if (PLOT) {
  fs.writeFileSync(PLOT, plotSvg());
  const png = PLOT.replace(/[.]svg$/i, '') + '.png';
  fs.writeFileSync(png, plotPng());
  console.log(`plot: ${PLOT} and ${png}`);
}
if (ATTACK_PLOT && fs.existsSync(NAV_FILE)) {
  const g = parseRoundNav(fs.readFileSync(NAV_FILE));
  if (!g.header.attack) { console.error('attack plot: the nav.bin header has no attack data; run node tools/round_nav.mjs --reuse'); process.exitCode = 1; }
  else console.log(`attack plot: ${attackPlot(g, data, g.header, ATTACK_PLOT, M.name.toUpperCase())}`);
}

// ---------------------------------------------------------------- plot
function plotSvg() {
  const S = 6, x0 = -125, x1 = 25, z0 = -85, z1 = 55; // world box; screen: right = -z, down = +x (like the picture)
  const W = (z1 - z0) * S, H = (x1 - x0) * S;
  const P = (x, z) => [((z1 - z) * S).toFixed(1), ((x - x0) * S).toFixed(1)];
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="11">`, `<rect width="${W}" height="${H}" fill="#101418"/>`];
  if (picture) {
    // Picture px -> screen: world = T.f(px); screen = P(world). Both are similarities, so one matrix.
    const o = P(...T.f(0, 0)).map(Number), ex = P(...T.f(1, 0)).map(Number), ey = P(...T.f(0, 1)).map(Number);
    const png = encodePng(picture);
    out.push(`<image href="data:image/png;base64,${png.toString('base64')}" width="${picture.w}" height="${picture.h}" opacity="0.45" transform="matrix(${ex[0] - o[0]} ${ex[1] - o[1]} ${ey[0] - o[0]} ${ey[1] - o[1]} ${o[0]} ${o[1]})"/>`);
  }
  const ys = nav.flat().map((v) => v[1]); const ylo = Math.min(...ys), yhi = Math.max(...ys);
  for (const t of nav) {
    const y = (t[0][1] + t[1][1] + t[2][1]) / 3, k = (y - ylo) / (yhi - ylo || 1);
    const c = `rgb(${Math.round(60 + 120 * k)},${Math.round(70 + 110 * k)},${Math.round(90 + 60 * k)})`;
    out.push(`<polygon points="${t.map((v) => P(v[0], v[2]).join(',')).join(' ')}" fill="${c}" stroke="${c}" stroke-width="0.4"/>`);
  }
  for (const s of sites) {
    out.push(`<polygon points="${s.zone.map(([x, z]) => P(x, z).join(',')).join(' ')}" fill="rgba(255,190,40,0.25)" stroke="#ffbe28" stroke-width="2"/>`);
    const [sx, sy] = P(s.center.x, s.center.z); out.push(`<text x="${sx}" y="${sy}" fill="#ffbe28" font-size="22" text-anchor="middle">${s.id}</text>`);
  }
  for (const b of barriers) {
    const col = b.team === 'defense' ? '#ff4655' : '#20e0b4';
    const [ax, ay] = P(b.a.x, b.a.z), [bx, by] = P(b.b.x, b.b.z);
    out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${col}" stroke-width="4"/>`);
    const [mx, my] = P(b.mark.world.x, b.mark.world.z); out.push(`<circle cx="${mx}" cy="${my}" r="3" fill="none" stroke="#fff"/>`);
    out.push(`<text x="${(+ax + +bx) / 2 + 6}" y="${(+ay + +by) / 2 - 6}" fill="${col}">${b.id} ${b.width.toFixed(1)}m</text>`);
  }
  for (const [team, list] of Object.entries(spawns)) for (const p of list) {
    const [x, y] = P(p.x, p.z); const col = team === 'attack' ? '#20e0b4' : '#ff4655';
    const [fx, fy] = P(p.x - Math.sin(p.yaw) * 2, p.z - Math.cos(p.yaw) * 2);
    out.push(`<circle cx="${x}" cy="${y}" r="4" fill="${col}"/><line x1="${x}" y1="${y}" x2="${fx}" y2="${fy}" stroke="${col}"/>`);
  }
  for (const [group, list] of Object.entries(setups)) for (const p of list) {
    const [x, y] = P(p.x, p.z);
    out.push(`<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="#ff8a00" stroke="#000"/><text x="${+x + 6}" y="${+y + 4}" fill="#ffd9a8" font-size="9">${group}: ${p.name}</text>`);
  }
  for (const c of mini.callouts) { const [x, y] = P(c.x, c.z); out.push(`<text x="${x}" y="${y}" fill="rgba(255,255,255,0.5)" font-size="9" text-anchor="middle">${Object.keys(M.CALLOUTS).find((k) => M.CALLOUTS[k] === c.name) ?? ''}</text>`); }
  out.push(`<text x="8" y="16" fill="#fff">${M.name} round data — navmesh floor (dark = low), barriers red = defender / teal = attacker (white ring = picture mark), yellow = plant zones, dots = spawns, orange = defender setups</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// Same picture as the SVG, rasterised in plain JS (no text), so it can be looked at anywhere.
function plotPng() {
  const S = 6, x0 = -125, x1 = 25, z0 = -85, z1 = 55;
  const w = (z1 - z0) * S, h = (x1 - x0) * S, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([16, 20, 24, 255], i * 4);
  const P = (x, z) => [(z1 - z) * S, (x - x0) * S];
  const put = (X, Y, c, a = 1) => {
    X = Math.round(X); Y = Math.round(Y); if (X < 0 || Y < 0 || X >= w || Y >= h) return;
    const o = (Y * w + X) * 4; for (let k = 0; k < 3; k++) data[o + k] = Math.round(data[o + k] * (1 - a) + c[k] * a);
  };
  const tri = (pts, c, a = 1) => {
    const [p, q, r] = pts; const minX = Math.floor(Math.min(p[0], q[0], r[0])), maxX = Math.ceil(Math.max(p[0], q[0], r[0]));
    const minY = Math.floor(Math.min(p[1], q[1], r[1])), maxY = Math.ceil(Math.max(p[1], q[1], r[1]));
    const area = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); if (Math.abs(area) < 1e-9) return;
    for (let Y = minY; Y <= maxY; Y++) for (let X = minX; X <= maxX; X++) {
      const w0 = ((q[0] - X) * (r[1] - Y) - (q[1] - Y) * (r[0] - X)) / area, w1 = ((r[0] - X) * (p[1] - Y) - (r[1] - Y) * (p[0] - X)) / area;
      if (w0 >= -0.02 && w1 >= -0.02 && w0 + w1 <= 1.02) put(X, Y, c, a);
    }
  };
  const line = (a, b, c, th = 2) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) + 1; for (let i = 0; i <= n; i++) { const X = a[0] + (b[0] - a[0]) * i / n, Y = a[1] + (b[1] - a[1]) * i / n; for (let dy = -th; dy <= th; dy++) for (let dx = -th; dx <= th; dx++) if (dx * dx + dy * dy <= th * th) put(X + dx, Y + dy, c); } };
  const dot = (p, c, rad = 4) => { for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) if (dx * dx + dy * dy <= rad * rad) put(p[0] + dx, p[1] + dy, c); };
  if (picture) {
    // Inverse map every plot pixel into the picture (nearest), blended at 45 %.
    for (let Y = 0; Y < h; Y++) for (let X = 0; X < w; X++) {
      const x = Y / S + x0, z = z1 - X / S; const [u, v] = T.inv(x, z); const U = Math.round(u), V = Math.round(v);
      if (U < 0 || V < 0 || U >= picture.w || V >= picture.h) continue;
      const o = (V * picture.w + U) * 4; if (picture.data[o + 3] < 128) continue;
      put(X, Y, [picture.data[o], picture.data[o + 1], picture.data[o + 2]], 0.45);
    }
  }
  const ys = nav.flat().map((v) => v[1]); const ylo = Math.min(...ys), yhi = Math.max(...ys);
  for (const t of nav) {
    const k = ((t[0][1] + t[1][1] + t[2][1]) / 3 - ylo) / (yhi - ylo || 1);
    tri(t.map((v) => P(v[0], v[2])), [60 + 120 * k, 70 + 110 * k, 90 + 60 * k], 0.6);
  }
  for (const s of sites) { const z = s.zone.map(([x, zz]) => P(x, zz)); tri([z[0], z[1], z[2]], [255, 190, 40], 0.25); tri([z[0], z[2], z[3]], [255, 190, 40], 0.25); for (let i = 0; i < 4; i++) line(z[i], z[(i + 1) % 4], [255, 190, 40], 1); }
  for (const b of barriers) { line(P(b.a.x, b.a.z), P(b.b.x, b.b.z), b.team === 'defense' ? [255, 70, 85] : [32, 224, 180], 2); dot(P(b.mark.world.x, b.mark.world.z), [255, 255, 255], 2); }
  for (const [team, list] of Object.entries(spawns)) for (const p of list) { const c = team === 'attack' ? [32, 224, 180] : [255, 70, 85]; dot(P(p.x, p.z), c, 4); line(P(p.x, p.z), P(p.x - Math.sin(p.yaw) * 2, p.z - Math.cos(p.yaw) * 2), c, 1); }
  for (const list of Object.values(setups)) for (const p of list) { dot(P(p.x, p.z), [0, 0, 0], 5); dot(P(p.x, p.z), [255, 138, 0], 4); }
  return encodePng({ w, h, data });
}

// ---------------------------------------------------------------- tiny PNG codec (8-bit RGB/RGBA)
function decodePng(buf) {
  let p = 8, w, h, ct, bd, il; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6) || il) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, not interlaced)');
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < bpp ? line[x * bpp + k] : 255;
    prev = line;
  }
  return { w, h, data: out };
}
function encodePng({ w, h, data }) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
