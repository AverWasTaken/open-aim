// Round mode nav graph bake: app/mods/aim-rounds/<map>.nav.bin from the map's real collision.
//
//   node tools/round_nav.mjs [--map ascent] [--reuse]
//
// Runs the game's own nav builder Vv (lifted at runtime from OkAdunfX.js, with its BVH helpers
// from BiMsX6Xn.js) on the pawn collision from tools/round_terrain.mjs, from the attacker spawn
// and from the defender spawn (app/mods/aim-rounds/<map>.json spawns[team][0]), and merges the two
// graphs by (0.5 m cell, floor height). Same parameters as the game's call: stepUp .5, jumpUp 1.1,
// maxDrop 4.5, runSpeed 6.75, gravity 24.456521739, jumpSeconds .45; maxNodes 5e6 and a box of
// the map's callouts +-40 m (y -15..40). Vv stores no edge kind, so edgeType is geometric:
// 0 walk (neighbour cell, |dy| <= .5), 1 drop (dy < -.5), 2 jump up (dy > .5), 3 gap (2-cell hop).
// Fails if a run is truncated, a spawn is off the graph, or the spawns can't reach each other.
//
// Takes ~2-3 minutes and one CPU core; it lowers its own priority to below normal.
// --reuse keeps the graph of the existing nav.bin and only rewrites the header (derived data).
// The header records sha256 of the collision inputs; scripts/test-round-nav.mjs fails when they
// change, then re-run this tool (the triangle cache in %TEMP% is keyed by the same hashes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, loadTerrain, fnSrc, constSrc, importAlias, mapFile } from './round_terrain.mjs';
import { parseRoundNav, writeRoundNav } from '../app/mods/aim-rounds/round-nav.mjs';
import { TYPES, nodeIndex, nearestNode, flood } from './round_navlib.mjs';

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: run anyway */ }

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('--map', 'ascent');
const REUSE = args.includes('--reuse');
const DATA = path.join(ROOT, 'app', 'mods', 'aim-rounds', `${MAP}.json`);
const OUT = path.join(ROOT, 'app', 'mods', 'aim-rounds', `${MAP}.nav.bin`);
const JS = path.join(ROOT, 'app', 'mods', 'next', 'js');

export const BAKE = { stepUp: 0.5, jumpUp: 1.1, maxDrop: 4.5, runSpeed: 6.75, gravity: 24.456521739, jumpSeconds: 0.45, maxNodes: 5e6 };
// Known-good graph sizes (the M1 seal check graph); a different count fails the bake.
const EXPECT = { ascent: { count: 21746, edgeCount: 161371 } };

const log = (...a) => console.log(...a);
const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

// Bake box: the map's callouts +-40 m, floor heights -15..40.
function bakeBounds() {
  const mini = JSON.parse(fs.readFileSync(mapFile(MAP, 'minimap.json'), 'utf8'));
  const xs = mini.callouts.map((c) => c.x), zs = mini.callouts.map((c) => c.z);
  const r = (v) => Math.round(v * 100) / 100;
  return { minX: r(Math.min(...xs) - 40), maxX: r(Math.max(...xs) + 40), minZ: r(Math.min(...zs) - 40), maxZ: r(Math.max(...zs) + 40), minY: -15, maxY: 40 };
}

// The game's Vv, in the vm context that already holds the lifted BVH helpers.
function liftVv(ctx) {
  const O = fs.readFileSync(path.join(JS, 'OkAdunfX.js'), 'utf8'), B = fs.readFileSync(path.join(JS, 'BiMsX6Xn.js'), 'utf8');
  const i = O.indexOf('const mr=.5,');
  if (i < 0 || O.indexOf('const mr=.5,', i + 1) >= 0) throw new Error('lift: Vv constants (const mr=.5,) not found once in OkAdunfX.js');
  const consts = O.slice(i, O.indexOf(';', i) + 1).replace(/^const /, 'var ');
  const vv = fnSrc(O, 'Vv', { generator: true });
  if (!vv) throw new Error('lift: function*Vv missing in OkAdunfX.js');
  // Vv's imports from BiMsX6Xn.js, resolved through the two modules' import/export lists.
  const alias = ['ls', 'bd', 'kd', 'br'].map((n) => [n, importAlias(O, B, 'BiMsX6Xn.js', n)]);
  const extra = alias.filter(([, local]) => !(local in ctx)).map(([, local]) => constSrc(B, local));
  vm.runInContext([...extra, consts, vv, ...alias.map(([n, l]) => `var ${n}=${l};`)].join('\n'), ctx, { filename: 'OkAdunfX.lifted.js' });
  return ctx.Vv;
}

function bake(T) {
  const bounds = bakeBounds();
  const Vv = liftVv(T.lib);
  const pawn = T.pawn;
  const starts = ['attack', 'defense'].map((team) => ({ team, x: data.spawns[team][0].x, y: data.spawns[team][0].y, z: data.spawns[team][0].z }));
  const key = (x, y, z) => `${Math.round(x * 2)},${Math.round(z * 2)},${Math.round(y * 100)}`;
  const X = [], Y = [], Z = [], idx = new Map(), adj = [], runs = [];
  const id = (x, y, z) => {
    const k = key(x, y, z); let i = idx.get(k);
    if (i === undefined) { i = X.length; idx.set(k, i); X.push(x); Y.push(y); Z.push(z); adj.push(new Map()); }
    return i;
  };
  for (const st of starts) {
    const t0 = Date.now();
    const gen = Vv(pawn, { x: st.x, y: st.y, z: st.z }, { bounds, ...BAKE });
    let r; while (!(r = gen.next()).done); const g = r.value;
    if (!g) throw new Error(`${st.team} spawn (${st.x}, ${st.y}, ${st.z}) is not on the nav`);
    if (g.truncated) throw new Error(`${st.team} run truncated at ${g.count} nodes`);
    const loc = new Int32Array(g.count);
    for (let i = 0; i < g.count; i++) loc[i] = id(g.x[i], g.y[i], g.z[i]);
    for (let i = 0; i < g.count; i++) for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
      const to = loc[g.edgeTo[e]], m = adj[loc[i]], c = g.edgeCost[e];
      if (!m.has(to) || m.get(to) > c) m.set(to, c);
    }
    runs.push({ team: st.team, start: { x: st.x, y: st.y, z: st.z }, nodes: g.count, edges: g.edgeStart[g.count], truncated: !!g.truncated, ms: Date.now() - t0 });
    log(`  Vv from ${st.team} spawn: ${g.count} nodes, ${g.edgeStart[g.count]} edges, ${Date.now() - t0} ms`);
  }
  const N = X.length, edgeStart = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) edgeStart[i + 1] = edgeStart[i] + adj[i].size;
  const edgeTo = [], edgeCost = [], edgeType = [];
  for (let i = 0; i < N; i++) for (const [to, c] of adj[i]) {
    const dxz = Math.hypot(X[to] - X[i], Z[to] - Z[i]), dy = Y[to] - Y[i];
    edgeTo.push(to); edgeCost.push(c); edgeType.push(dxz > 0.75 ? 3 : dy > 0.5 ? 2 : dy < -0.5 ? 1 : 0);
  }
  // Grid origin: Vv puts cell (i, j) at floor(minX) + .173 + i * .5 (same for z).
  const cell = 0.5, ox = Math.floor(bounds.minX) + 0.173, oz = Math.floor(bounds.minZ) + 0.173;
  for (let i = 0; i < N; i++) {
    if (Math.abs((X[i] - ox) / cell - Math.round((X[i] - ox) / cell)) > 1e-3 || Math.abs((Z[i] - oz) / cell - Math.round((Z[i] - oz) / cell)) > 1e-3) throw new Error(`node ${i} off the grid`);
  }
  return {
    graph: { x: X, y: Y, z: Z, edgeStart, edgeTo, edgeCost, edgeType },
    header: { cell, originX: +ox.toFixed(3), originZ: +oz.toFixed(3), bake: { ...BAKE, bounds, runs } },
  };
}

// Sanity checks every bake must pass (also run on --reuse).
function checkGraph(g) {
  const H = nodeIndex(g), errs = [];
  const snap = (p) => nearestNode(g, H, p.x, p.z, 0.5, p.y, 0.6);
  const sp = {};
  for (const team of ['attack', 'defense']) {
    sp[team] = data.spawns[team].map(snap);
    sp[team].forEach((n, k) => { if (n < 0) errs.push(`${team} spawn ${k} is off the graph`); });
  }
  const fa = flood(g, sp.attack, { types: TYPES.all }), fd = flood(g, sp.defense, { types: TYPES.all });
  if (sp.defense[0] >= 0 && fa[sp.defense[0]] === -2) errs.push('attacker spawn cannot reach the defender spawn');
  if (sp.attack[0] >= 0 && fd[sp.attack[0]] === -2) errs.push('defender spawn cannot reach the attacker spawn');
  const ex = EXPECT[MAP];
  if (ex && (ex.count !== g.count || ex.edgeCount !== g.edgeCount)) errs.push(`graph is ${g.count} nodes / ${g.edgeCount} edges, expected ${ex.count} / ${ex.edgeCount}`);
  return errs;
}

async function main() {
  const t0 = Date.now();
  const T = await loadTerrain(MAP, { log });
  if (!T) throw new Error(`no map files for ${MAP} in site/aim-maps`);
  let graph, header;
  if (REUSE) {
    const old = parseRoundNav(fs.readFileSync(OUT));
    for (const k of ['collision', 'glb', 'worker']) {
      const want = k === 'collision' ? old.header.source.sha256 : old.header.source[k]?.sha256;
      if (want !== T.sources[k].sha256) throw new Error(`--reuse: ${k} changed since the bake; run without --reuse`);
    }
    graph = old;
    const { map, count, edgeCount, ...rest } = old.header;
    header = { cell: rest.cell, originX: rest.originX, originZ: rest.originZ, bake: rest.bake };
    log(`reusing graph of ${path.relative(ROOT, OUT)} (${old.count} nodes)`);
  } else {
    log(`baking ${MAP} nav (below-normal priority) ...`);
    ({ graph, header } = bake(T));
  }
  const bin0 = writeRoundNav(graph, header);
  const g = parseRoundNav(bin0);
  const errs = checkGraph(g);
  if (errs.length) throw new Error('nav check failed:\n  ' + errs.join('\n  '));
  const S = T.sources;
  const full = {
    map: MAP, ...header,
    source: { file: S.collision.file, sha256: S.collision.sha256, glb: { file: S.glb.file, sha256: S.glb.sha256 }, worker: { file: S.worker.file, sha256: S.worker.sha256 } },
    tool: 'tools/round_nav.mjs',
  };
  const bin = writeRoundNav(graph, full);
  fs.writeFileSync(OUT, bin);
  const tc = [0, 0, 0, 0]; for (const t of g.edgeType) tc[t]++;
  log(`wrote ${path.relative(ROOT, OUT)}: ${g.count} nodes, ${g.edgeCount} edges (walk/drop/jump/gap ${tc.join('/')}), ${(bin.length / 1048576).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
