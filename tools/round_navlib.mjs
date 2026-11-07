// Round mode nav graph helpers for the node tools and tests (not shipped in the app).
// Graph = parseRoundNav() result (app/mods/aim-rounds/round-nav.mjs).
import { reverseEdges } from '../app/mods/aim-rounds/round-nav.mjs';

export const TYPES = { walk: [0], walkDrop: [0, 1], all: [0, 1, 2, 3] };
const typeMask = (types) => types.reduce((m, t) => m | (1 << t), 0);

// Spatial hash on 1 m cells for nearest-node queries.
export function nodeIndex(g) {
  const H = new Map();
  for (let i = 0; i < g.count; i++) {
    const k = Math.floor(g.x[i]) * 65536 + Math.floor(g.z[i]);
    const l = H.get(k); if (l) l.push(i); else H.set(k, [i]);
  }
  return H;
}
// Nodes within xz radius r of (x, z) (and |dy| <= maxDy of y when y is given), nearest first.
export function nodesNear(g, H, x, z, r, y = null, maxDy = Infinity) {
  const out = [];
  for (let a = Math.floor(x - r); a <= Math.floor(x + r); a++) for (let b = Math.floor(z - r); b <= Math.floor(z + r); b++) {
    for (const i of H.get(a * 65536 + b) || []) {
      const d = Math.hypot(g.x[i] - x, g.z[i] - z);
      if (d <= r && (y === null || Math.abs(g.y[i] - y) <= maxDy)) out.push([i, d]);
    }
  }
  return out.sort((p, q) => p[1] - q[1] || p[0] - q[0]).map(([i]) => i);
}
export function nearestNode(g, H, x, z, r, y = null, maxDy = Infinity) {
  const l = nodesNear(g, H, x, z, r, y, maxDy);
  return l.length ? l[0] : -1;
}

// ---------------------------------------------------------------- barriers
const orient = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
export function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = orient(cx, cz, dx, dz, ax, az), d2 = orient(cx, cz, dx, dz, bx, bz), d3 = orient(ax, az, bx, bz, cx, cz), d4 = orient(ax, az, bx, bz, dx, dz);
  if (d1 === 0 && d2 === 0) return false;
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}
// Edge i->j is cut by a barrier when its xz segment crosses the barrier segment and either end's
// floor height is inside the barrier's y range (the seal check's strict rule).
export function edgeCutBy(g, bars, i, j) {
  for (const b of bars) {
    const inY = !Array.isArray(b.y) || (g.y[i] >= b.y[0] && g.y[i] <= b.y[1]) || (g.y[j] >= b.y[0] && g.y[j] <= b.y[1]);
    if (inY && segCross(g.x[i], g.z[i], g.x[j], g.z[j], b.a.x, b.a.z, b.b.x, b.b.z)) return b;
  }
  return null;
}
// Per-edge cut flags for a barrier list (1 = blocked).
export function barrierMask(g, bars) {
  const m = new Uint8Array(g.edgeCount);
  if (!bars.length) return m;
  for (let i = 0; i < g.count; i++) for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) if (edgeCutBy(g, bars, i, g.edgeTo[e])) m[e] = 1;
  return m;
}

// ---------------------------------------------------------------- searches
// BFS flood from sources over the given edge types, skipping masked edges. Returns parent array
// (-2 = not reached, -1 = source).
export function flood(g, srcs, { types = TYPES.all, mask = null } = {}) {
  const tm = typeMask(types), par = new Int32Array(g.count).fill(-2), q = [];
  for (const s of srcs) if (s >= 0 && par[s] === -2) { par[s] = -1; q.push(s); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
      if (!(tm >> g.edgeType[e] & 1) || (mask && mask[e])) continue;
      const j = g.edgeTo[e]; if (par[j] !== -2) continue;
      par[j] = i; q.push(j);
    }
  }
  return par;
}

// Binary heap keyed by Float64 distance.
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = v.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = v.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}
// Dijkstra over edgeCost (seconds). forward: time FROM the sources to every node.
// reverse (toward=true): time from every node TO the sources, over incoming edges.
export function dijkstra(g, srcs, { types = TYPES.all, mask = null, toward = false, rev = null, maxT = Infinity } = {}) {
  const tm = typeMask(types), dist = new Float64Array(g.count).fill(Infinity), via = new Int32Array(g.count).fill(-1), h = new Heap();
  const R = toward ? rev || reverseEdges(g) : null;
  for (const s of srcs) if (s >= 0 && dist[s] > 0) { dist[s] = 0; h.push(0, s); }
  while (h.size) {
    const i = h.pop(), di = dist[i];
    if (di > maxT) break;
    if (toward) {
      for (let p = R.revStart[i]; p < R.revStart[i + 1]; p++) {
        const e = R.revEdge[p]; if (!(tm >> g.edgeType[e] & 1) || (mask && mask[e])) continue;
        const j = R.revFrom[p], nd = di + g.edgeCost[e];
        if (nd < dist[j]) { dist[j] = nd; via[j] = i; h.push(nd, j); }
      }
    } else {
      for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
        if (!(tm >> g.edgeType[e] & 1) || (mask && mask[e])) continue;
        const j = g.edgeTo[e], nd = di + g.edgeCost[e];
        if (nd < dist[j]) { dist[j] = nd; via[j] = i; h.push(nd, j); }
      }
    }
  }
  return { dist, via };
}
// Path by following `via` (node -> next toward the sources for toward=true, or -> previous for forward).
export function viaPath(via, i) { const p = []; while (i >= 0 && p.length < 1e6) { p.push(i); i = via[i]; } return p; }
