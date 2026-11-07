// Round mode nav header data (written by tools/round_nav.mjs into <map>.nav.bin) and the travel
// report / plots. Everything that needs a real sight ray lives here, so round_author.mjs --check
// and the app only read the result.
//
// Header fields (angles: SIM/bot convention, facingYaw = atan2(dx, dz), forward = (sin, cos)):
//   inputs:  { file, sha256 }  hash of the map json fields this data was derived from
//            (spawns, barriers, sites, setups, retake, attack); the round tests fail when it is stale.
//   setups:  { <name>: { group, node, walk, face, face2, faceNode, face2Node, spawnT } }
//            node  = nav node within 0.5 m xz / 0.3 m y of the spot, else -1
//            walk  = node reachable from the defender spawns on walk + drop edges with the
//                    defender barriers up (edges crossing them cut)
//            face  = direction to the node, among nodes within 30 m the bot can see from the spot
//                    (eye 1.6 m, target 1.0 m above the node floor, the bots' own sight test), that
//                    attackers reach first (attacker spawn field over walk, drop and jump-up edges,
//                    no barriers; arrival time = forward Dijkstra from the 5 attacker spawns)
//            face2 = same, best one at least 40 deg away from face, or null
//            spawnT = slowest of the 5 defender spawns to the spot (walk + drop, barriers up), s
//   staging: { <site>: [{ name, node, t, hidden, los: { body, head }, reach }] }  checks of the
//            authored retake points: t = walk + drop time to the site's goal nodes (s), los =
//            visible from 1 m above the site's centre floor node at 1.0 / 1.6 m above the point,
//            reach = reachable from the defender spawns on walk + drop edges
//   zones:   { <site>: { samples, noDefuseNode, bad: [[x,y,z], ...] } }  every nav node inside the
//            plant zone (and its y range) that attackers can reach on any edge kind = a place the
//            spike can lie; noDefuseNode = fraction with no walk + drop node (reachable from the
//            defender spawn) within 1.6 m xz and |dy| < 2 (round-core's defuse rule)
//   siteGoals: { <site>: { node, x, y, z } }  the nav node nearest the site centre on the zone floor
//   attack:  checks and derived spots for the attacker bots (map json `attack`, round mode R3), or
//            null when the map has no attack block. "Attackers walk" = walk + drop edges (what the
//            bots path on), from the 5 attacker spawns, no barriers.
//     plant:     { <site>: [{ name, node, margin, inZone, reach, nearOk, near, spawnT }] }
//                margin = xz distance from the node to the zone polygon's edge (m); inZone = node in
//                the polygon and the site's y range; reach = attackers walk there; nearOk = every node
//                attackers reach on any edge within PLANT_NEAR (xz, |dy| < 2) of the node is inside
//                the zone and defusable (= none of them is in zones.bad), so a bot that stops a bit
//                off the node still plants a defusable spike; spawnT = slowest attacker spawn (s)
//     staging:   { <site>: [{ route, entry: { name, node }, staging: [{ name, node, side, reach,
//                spawnT, wait: { node, t }, plantT: [s per plant spot], entryD: [m per plant spot] }] }] }
//                side = 'attack' | 'neutral' | 'defense' (barrier phase: reached from that team's
//                spawns over all edges with its barriers up, else neutral); wait = the node on the
//                attackers' barrier-phase side (walk + drop, attacker barriers up) with the shortest
//                walk + drop time to the staging point (where a bot waits for the barrier to drop),
//                t = that time; plantT = walk + drop time staging -> plant spot; entryD = closest xz
//                distance of that shortest path to the route's entry waypoint (the route is real
//                only when the bots' shortest path passes the entry)
//     postPlant: { <site>: { <plant name>: [{ node, x, y, z, d, seen }] } }  where attackers hold
//                after the plant: nodes POST_MIN..POST_MAX m (3D) from the plant node, attackers walk
//                there, open floor (8 walk neighbours), the bots' sight test from eye height (floor
//                + 1.6) to the spike (plant floor + 0.3) is clear; ranked by seen = how many of the
//                site's retake staging points see the spot (eye 1.6 at the point, 1.0 or 1.6 above
//                the spot; fewer first), then the attackers' side first (slowest attacker spawn ->
//                node walk + drop time, less first), then node; greedily POST_TOP of them at least
//                POST_GAP m apart and POST_SPREAD degrees apart as seen from the spike (crossfire)
import crypto from 'node:crypto';
import { reverseEdges } from '../app/mods/aim-rounds/round-nav.mjs';
import { TYPES, nodeIndex, nodesNear, nearestNode, flood, dijkstra, barrierMask, viaPath } from './round_navlib.mjs';
import { Img } from './round_png.mjs';

export const EYE = 1.6, BODY = 1.0, FACE_RANGE = 30, FACE2_MIN_DEG = 40;
export const DEFUSE_R = 1.6, DEFUSE_DY = 2;
export const ATTACKER_TYPES = [0, 1, 2]; // walk, drop, jump up (no 2-cell gap hops)
const r2 = (v) => Math.round(v * 100) / 100, r4 = (v) => Math.round(v * 1e4) / 1e4;

export const PLANT_MARGIN = 1.0, PLANT_NEAR = 1.0, SPIKE_H = 0.3;
export const POST_MIN = 6, POST_MAX = 20, POST_TOP = 4, POST_GAP = 4, POST_SPREAD = 20;

export function inputsHash(data) {
  const { spawns, barriers, sites, setups, retake, attack } = data;
  return crypto.createHash('sha256').update(JSON.stringify({ spawns, barriers, sites, setups, retake: retake ?? null, attack: attack ?? null })).digest('hex');
}
// xz distance from (x, z) to the nearest edge of a polygon.
export function polyEdgeDist(poly, x, z) {
  let m = Infinity;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [ax, az] = poly[b], [bx, bz] = poly[a], vx = bx - ax, vz = bz - az, l = vx * vx + vz * vz;
    const t = l > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l)) : 0;
    m = Math.min(m, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return m;
}
export function inPoly(poly, x, z) {
  let ins = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xi, zi] = poly[a], [xj, zj] = poly[b];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
}
const angDiff = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };

// Shared graph context for a map: spawn nodes, floods and fields used by every check.
export function navContext(g, data) {
  const H = nodeIndex(g), rev = reverseEdges(g);
  const snap = (p) => nearestNode(g, H, p.x, p.z, 0.5, p.y, 0.6);
  const sp = { attack: data.spawns.attack.map(snap), defense: data.spawns.defense.map(snap) };
  const defMask = barrierMask(g, data.barriers.filter((b) => b.team === 'defense'));
  const atkMask = barrierMask(g, data.barriers.filter((b) => b.team === 'attack'));
  const defWalk = flood(g, sp.defense, { types: TYPES.walkDrop });                    // live, no barriers
  const defWalkBar = flood(g, sp.defense, { types: TYPES.walkDrop, mask: defMask });   // barrier phase
  const atkAll = flood(g, sp.attack, { types: TYPES.all });
  // Site goal nodes: within the defuse radius of the centre, on the zone floor, defender-walkable.
  const sites = {};
  for (const s of data.sites) {
    const goal = nodesNear(g, H, s.center.x, s.center.z, DEFUSE_R).filter((i) => defWalk[i] !== -2 && g.y[i] >= s.y[0] && g.y[i] <= s.y[1]);
    if (!goal.length) throw new Error(`site ${s.id}: no defender-walkable node within ${DEFUSE_R} m of the centre`);
    const field = dijkstra(g, goal, { types: TYPES.walkDrop, toward: true, rev });
    sites[s.id] = { site: s, goal, centre: goal[0], field };
  }
  return { g, H, rev, sp, defMask, atkMask, defWalk, defWalkBar, atkAll, sites, snap };
}

export function deriveHeader(g, T, data) {
  const C = navContext(g, data), { H } = C;
  const atkT = dijkstra(g, C.sp.attack, { types: ATTACKER_TYPES }).dist;
  const spawnFields = C.sp.defense.map((n) => dijkstra(g, [n], { types: TYPES.walkDrop, mask: C.defMask }).dist);
  const setups = {};
  for (const [group, list] of Object.entries(data.setups.defense)) for (const s of list) {
    const node = nearestNode(g, H, s.x, s.z, 0.5, s.y, 0.3);
    const fy = node >= 0 ? g.y[node] : s.y, eye = [s.x, fy + EYE, s.z];
    const cands = nodesNear(g, H, s.x, s.z, FACE_RANGE).filter((i) => Number.isFinite(atkT[i]) && Math.hypot(g.x[i] - s.x, g.z[i] - s.z) >= 1)
      .sort((p, q) => atkT[p] - atkT[q] || p - q);
    let face = null, face2 = null;
    for (const i of cands) {
      const a = Math.atan2(g.x[i] - s.x, g.z[i] - s.z);
      if (face && angDiff(a, face.a) < FACE2_MIN_DEG * Math.PI / 180) continue;
      if (!T.sight(eye, [g.x[i], g.y[i] + BODY, g.z[i]])) continue;
      if (!face) face = { a, i }; else { face2 = { a, i }; break; }
    }
    const walk = node >= 0 && C.defWalkBar[node] !== -2;
    setups[s.name] = {
      group, node, walk,
      face: face ? r4(face.a) : null, face2: face2 ? r4(face2.a) : null,
      faceNode: face ? face.i : -1, face2Node: face2 ? face2.i : -1,
      faceT: face ? r2(atkT[face.i]) : null,
      spawnT: node >= 0 && walk ? r2(Math.max(...spawnFields.map((f) => f[node]))) : null,
    };
  }
  const siteGoals = {}, staging = {}, zones = {};
  for (const [id, S] of Object.entries(C.sites)) {
    const c = S.centre, eye = [g.x[c], g.y[c] + BODY, g.z[c]];
    siteGoals[id] = { node: c, x: r2(g.x[c]), y: r2(g.y[c]), z: r2(g.z[c]) };
    staging[id] = (data.retake?.[id] ?? []).map((p) => {
      const node = nearestNode(g, H, p.x, p.z, 0.5, p.y, 0.3);
      const fy = node >= 0 ? g.y[node] : p.y;
      const los = { body: T.sight(eye, [p.x, fy + BODY, p.z]), head: T.sight(eye, [p.x, fy + EYE, p.z]) };
      return { name: p.name, node, t: node >= 0 && Number.isFinite(S.field.dist[node]) ? r2(S.field.dist[node]) : null, hidden: !los.body && !los.head, los, reach: node >= 0 && C.defWalk[node] !== -2 };
    });
    const s = S.site, bad = []; let samples = 0;
    for (let i = 0; i < g.count; i++) {
      if (C.atkAll[i] === -2 || g.y[i] < s.y[0] || g.y[i] > s.y[1] || !inPoly(s.zone, g.x[i], g.z[i])) continue;
      samples++;
      const ok = nodesNear(g, H, g.x[i], g.z[i], DEFUSE_R).some((j) => C.defWalk[j] !== -2 && Math.abs(g.y[j] - g.y[i]) < DEFUSE_DY);
      if (!ok) bad.push([r2(g.x[i]), r2(g.y[i]), r2(g.z[i])]);
    }
    zones[id] = { samples, noDefuseNode: samples ? r4(bad.length / samples) : 0, bad };
  }
  return { setups, staging, zones, siteGoals, attack: deriveAttack(g, T, data, C) };
}

// ---------------------------------------------------------------- attack side (R3)
// Floods / fields the attacker checks share (see the header comment, `attack`).
export function attackContext(g, data, C = navContext(g, data)) {
  return {
    atkWalk: flood(g, C.sp.attack, { types: TYPES.walkDrop }),                       // live
    atkWalkBar: flood(g, C.sp.attack, { types: TYPES.walkDrop, mask: C.atkMask }),   // barrier phase
    atkSide: flood(g, C.sp.attack, { types: TYPES.all, mask: C.atkMask }),
    defSide: flood(g, C.sp.defense, { types: TYPES.all, mask: C.defMask }),
    spawnT: C.sp.attack.map((n) => dijkstra(g, [n], { types: TYPES.walkDrop }).dist),
  };
}
export const sideOf = (A, i) => (A.defSide[i] !== -2 ? 'defense' : A.atkSide[i] !== -2 ? 'attack' : 'neutral');
const openFloor = (g, i) => { let d = 0; for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) if (g.edgeType[e] === 0) d++; return d >= 8; };
const inSite = (g, s, i) => inPoly(s.zone, g.x[i], g.z[i]) && g.y[i] >= s.y[0] && g.y[i] <= s.y[1];
// round-core's defuse rule from a defender-walkable node (same as header.zones).
const defusable = (C, i) => nodesNear(C.g, C.H, C.g.x[i], C.g.z[i], DEFUSE_R).some((j) => C.defWalk[j] !== -2 && Math.abs(C.g.y[j] - C.g.y[i]) < DEFUSE_DY);

export function plantCheck(g, C, A, s, node) {
  if (node < 0) return { node, margin: 0, inZone: false, reach: false, nearOk: false, near: 0, spawnT: null };
  const near = nodesNear(g, C.H, g.x[node], g.z[node], PLANT_NEAR).filter((j) => C.atkAll[j] !== -2 && Math.abs(g.y[j] - g.y[node]) < DEFUSE_DY);
  const reach = A.atkWalk[node] !== -2;
  return {
    node, margin: r2(inPoly(s.zone, g.x[node], g.z[node]) ? polyEdgeDist(s.zone, g.x[node], g.z[node]) : -polyEdgeDist(s.zone, g.x[node], g.z[node])),
    inZone: inSite(g, s, node), reach, nearOk: near.every((j) => inSite(g, s, j) && defusable(C, j)), near: near.length,
    spawnT: reach ? r2(Math.max(...A.spawnT.map((f) => f[node]))) : null,
  };
}

export function deriveAttack(g, T, data, C = navContext(g, data)) {
  const atk = data.attack;
  if (!atk) return null;
  const A = attackContext(g, data, C), { H } = C;
  const snap = (p) => nearestNode(g, H, p.x, p.z, 0.5, p.y, 0.3);
  const plant = {}, staging = {}, postPlant = {};
  for (const [id, list] of Object.entries(atk.plant)) {
    const s = data.sites.find((q) => q.id === id);
    plant[id] = list.map((p) => ({ name: p.name, ...plantCheck(g, C, A, s, snap(p)) }));
  }
  for (const [id, routes] of Object.entries(atk.routes)) {
    const pn = (plant[id] ?? []).map((p) => p.node);
    staging[id] = routes.map((rt) => {
      const e = rt.entry;
      const points = rt.staging.map((p) => {
        const node = snap(p);
        if (node < 0) return { name: p.name, node, side: null, reach: false, spawnT: null, wait: null, plantT: [], entryD: [] };
        const fwd = dijkstra(g, [node], { types: TYPES.walkDrop });
        const back = dijkstra(g, [node], { types: TYPES.walkDrop, toward: true, rev: C.rev });
        let w = -1;
        for (let i = 0; i < g.count; i++) if (A.atkWalkBar[i] !== -2 && Number.isFinite(back.dist[i]) && (w < 0 || back.dist[i] < back.dist[w])) w = i;
        const reach = A.spawnT.every((f) => Number.isFinite(f[node]));
        return {
          name: p.name, node, side: sideOf(A, node), reach,
          spawnT: reach ? r2(Math.max(...A.spawnT.map((f) => f[node]))) : null,
          wait: w >= 0 ? { node: w, t: r2(back.dist[w]) } : null,
          plantT: pn.map((n) => (n >= 0 && Number.isFinite(fwd.dist[n]) ? r2(fwd.dist[n]) : null)),
          entryD: pn.map((n) => (n >= 0 && Number.isFinite(fwd.dist[n]) ? r2(Math.min(...viaPath(fwd.via, n).map((q) => Math.hypot(g.x[q] - e.x, g.z[q] - e.z)))) : null)),
        };
      });
      return { route: rt.name, entry: { name: e.name, node: snap(e) }, staging: points };
    });
  }
  for (const [id, list] of Object.entries(plant)) {
    postPlant[id] = {};
    const views = (data.retake?.[id] ?? []).map((q) => [q.x, q.y + EYE, q.z]);
    for (const p of list) {
      if (p.node < 0) { postPlant[id][p.name] = []; continue; }
      const px = g.x[p.node], py = g.y[p.node], pz = g.z[p.node], spike = [px, py + SPIKE_H, pz];
      const cands = [];
      for (const i of nodesNear(g, H, px, pz, POST_MAX)) {
        const d = Math.hypot(g.x[i] - px, g.y[i] - py, g.z[i] - pz);
        // attackers walk there from every spawn (also keeps t finite for the sort)
        if (d < POST_MIN || d > POST_MAX || A.atkWalk[i] === -2 || !openFloor(g, i) || !A.spawnT.every((f) => Number.isFinite(f[i]))) continue;
        if (!T.sight([g.x[i], g.y[i] + EYE, g.z[i]], spike)) continue;
        const seen = views.filter((v) => T.sight(v, [g.x[i], g.y[i] + BODY, g.z[i]]) || T.sight(v, [g.x[i], g.y[i] + EYE, g.z[i]])).length;
        cands.push({ i, d, seen, t: Math.max(...A.spawnT.map((f) => f[i])), a: Math.atan2(g.x[i] - px, g.z[i] - pz) });
      }
      cands.sort((a, b) => a.seen - b.seen || a.t - b.t || a.i - b.i);
      const pick = [];
      for (const k of cands) {
        if (pick.length >= POST_TOP) break;
        if (pick.some((q) => Math.hypot(g.x[q.i] - g.x[k.i], g.z[q.i] - g.z[k.i]) < POST_GAP || angDiff(q.a, k.a) < POST_SPREAD * Math.PI / 180)) continue;
        pick.push(k);
      }
      postPlant[id][p.name] = pick.map((k) => ({ node: k.i, x: r2(g.x[k.i]), y: r2(g.y[k.i]), z: r2(g.z[k.i]), d: r2(k.d), seen: k.seen }));
    }
  }
  return { plant, staging, postPlant };
}

// Plant spot candidates for a site (how the authored ATTACK plant spots in round_author.mjs were
// picked): attackers walk there, at least PLANT_MARGIN inside the zone polygon and inside its y range,
// nearOk (plantCheck), open floor; nearest to the site goal first.
export function plantCandidates(g, data, siteId, { C = navContext(g, data), A = attackContext(g, data, C) } = {}) {
  const S = C.sites[siteId], s = S.site, c = S.centre, out = [];
  for (let i = 0; i < g.count; i++) {
    if (A.atkWalk[i] === -2 || !inSite(g, s, i) || polyEdgeDist(s.zone, g.x[i], g.z[i]) < PLANT_MARGIN || !openFloor(g, i)) continue;
    const k = plantCheck(g, C, A, s, i);
    if (!k.nearOk) continue;
    out.push({ node: i, x: r2(g.x[i]), y: r2(g.y[i]), z: r2(g.z[i]), d: r2(Math.hypot(g.x[i] - g.x[c], g.z[i] - g.z[c])), margin: k.margin, spawnT: k.spawnT });
  }
  return out.sort((a, b) => a.d - b.d || a.node - b.node);
}
// Attacker staging candidates near a spot (how the authored ATTACK staging points were picked):
// within r m (xz) of (x, z), open floor, never on the defender side, attackers walk there from all 5
// spawns; nearest to the spot first.
export function attackStagingCandidates(g, data, x, z, { r = 4, C = navContext(g, data), A = attackContext(g, data, C) } = {}) {
  return nodesNear(g, C.H, x, z, r).filter((i) => openFloor(g, i) && sideOf(A, i) !== 'defense' && A.spawnT.every((f) => Number.isFinite(f[i])))
    .map((i) => ({ node: i, x: r2(g.x[i]), y: r2(g.y[i]), z: r2(g.z[i]), side: sideOf(A, i), d: r2(Math.hypot(g.x[i] - x, g.z[i] - z)), spawnT: r2(Math.max(...A.spawnT.map((f) => f[i]))) }));
}

// Travel-time report (seconds on edgeCost, i.e. run speed 6.75 m/s).
export function travelReport(g, data, header) {
  const C = navContext(g, data), { H } = C, out = { setups: {}, barriers: {}, sites: {}, spawnToSite: {} };
  const defF = C.sp.defense.map((n) => dijkstra(g, [n], { types: TYPES.walkDrop, mask: C.defMask }).dist);
  for (const [name, s] of Object.entries(header.setups)) {
    if (s.node < 0) { out.setups[name] = { group: s.group, walk: s.walk, min: null, max: null }; continue; }
    const ts = defF.map((f) => f[s.node]), fin = (v) => (Number.isFinite(v) ? r2(v) : null);
    out.setups[name] = { group: s.group, walk: s.walk, min: fin(Math.min(...ts)), max: fin(Math.max(...ts)) };
  }
  for (const b of data.barriers.filter((q) => q.team === 'attack')) {
    const near = [];
    for (const i of nodesNear(g, H, (b.a.x + b.b.x) / 2, (b.a.z + b.b.z) / 2, Math.hypot(b.b.x - b.a.x, b.b.z - b.a.z) / 2 + 1.5)) {
      const vx = b.b.x - b.a.x, vz = b.b.z - b.a.z, l = vx * vx + vz * vz, t = Math.max(0, Math.min(1, ((g.x[i] - b.a.x) * vx + (g.z[i] - b.a.z) * vz) / l));
      if (Math.hypot(g.x[i] - b.a.x - vx * t, g.z[i] - b.a.z - vz * t) <= 1.0 && g.y[i] >= b.y[0] && g.y[i] <= b.y[1]) near.push(i);
    }
    const per = C.sp.attack.map((n) => {
      const all = dijkstra(g, [n], { types: TYPES.all, mask: C.atkMask }).dist, wd = dijkstra(g, [n], { types: TYPES.walkDrop, mask: C.atkMask }).dist;
      return [Math.min(...near.map((i) => all[i])), Math.min(...near.map((i) => wd[i]))];
    });
    out.barriers[b.id] = { name: b.name, all: [r2(Math.min(...per.map((p) => p[0]))), r2(Math.max(...per.map((p) => p[0])))], walkDrop: [r2(Math.min(...per.map((p) => p[1]))), r2(Math.max(...per.map((p) => p[1])))] };
  }
  for (const [id, S] of Object.entries(C.sites)) {
    let worst = null;
    for (const [name, s] of Object.entries(header.setups)) {
      if (!s.walk) continue;
      const t = S.field.dist[s.node];
      if (!worst || t > worst.t) worst = { name, t };
    }
    out.sites[id] = { worstSetup: worst.name, t: r2(worst.t), plusDefuse: r2(worst.t + 7), budget: 45 };
    out.spawnToSite[id] = r2(Math.max(...C.sp.defense.map((n) => S.field.dist[n])));
  }
  return out;
}

// ---------------------------------------------------------------- plots
export function plots(g, data, header, dir, map) {
  const C = navContext(g, data), files = [];
  const draw = (box, S, title, file) => {
    const [x0, x1, z0, z1] = box, W = Math.ceil((x1 - x0) * S), Hh = Math.ceil((z1 - z0) * S) + 34;
    const im = new Img(W, Hh), px = (x) => (x - x0) * S, pz = (z) => (z - z0) * S + 34;
    const order = [...Array(g.count).keys()].filter((i) => g.x[i] >= x0 && g.x[i] <= x1 && g.z[i] >= z0 && g.z[i] <= z1).sort((a, b) => g.y[a] - g.y[b]);
    const cs = Math.max(2, Math.round(S * 0.5));
    for (const i of order) { const v = Math.round(55 + Math.max(0, Math.min(1, (g.y[i] + 2) / 12)) * 90); im.rect(px(g.x[i]), pz(g.z[i]), cs, [v, v, v + 8]); }
    for (const s of data.sites) { const p = s.zone; for (let k = 0; k < p.length; k++) { const q = p[(k + 1) % p.length]; im.line(px(p[k][0]), pz(p[k][1]), px(q[0]), pz(q[1]), [250, 220, 40], 2); } }
    for (const [id, z] of Object.entries(header.zones)) for (const [x, , zz] of z.bad) im.rect(px(x), pz(zz), cs + 1, [235, 60, 60]);
    for (const b of data.barriers) { const c = b.team === 'attack' ? [255, 160, 0] : [0, 220, 230]; im.line(px(b.a.x), pz(b.a.z), px(b.b.x), pz(b.b.z), c, 3); }
    for (const [id, sg] of Object.entries(header.siteGoals)) { im.circle(px(sg.x), pz(sg.z), DEFUSE_R * S, [250, 220, 40], 2); im.label(px(sg.x) - 4, pz(sg.z) - 5, id, [250, 220, 40], 3); }
    // staging: point, path to the site goal
    for (const [id, list] of Object.entries(header.staging)) list.forEach((st, k) => {
      const p = data.retake[id][k];
      if (st.node >= 0) { const path = viaPath(C.sites[id].field.via, st.node); for (let m = 1; m < path.length; m++) im.line(px(g.x[path[m - 1]]), pz(g.z[path[m - 1]]), px(g.x[path[m]]), pz(g.z[path[m]]), [80, 200, 255], 1); }
      im.rect(px(p.x), pz(p.z), 9, [0, 0, 0]); im.rect(px(p.x), pz(p.z), 7, st.hidden ? [80, 200, 255] : [255, 0, 255]);
      im.label(px(p.x) + 7, pz(p.z) + 4, `${p.name} ${st.t} S`, [80, 200, 255], 2);
    });
    // setups: face (green, 5 m) and face2 (yellow, 3.5 m) arrows
    for (const list of Object.values(data.setups.defense)) for (const s of list) {
      const h = header.setups[s.name], X = px(s.x), Z = pz(s.z);
      if (h.face2 !== null) im.arrow(X, Z, X + Math.sin(h.face2) * 3.5 * S, Z + Math.cos(h.face2) * 3.5 * S, [240, 220, 60], 2);
      if (h.face !== null) im.arrow(X, Z, X + Math.sin(h.face) * 5 * S, Z + Math.cos(h.face) * 5 * S, [60, 240, 90], 2);
      im.rect(X, Z, 8, [0, 0, 0]); im.rect(X, Z, 6, h.walk ? [60, 240, 90] : [235, 60, 60]);
      im.label(X + 6, Z - 12, s.name, h.walk ? [200, 255, 200] : [255, 140, 140], 2);
    }
    for (const side of ['attack', 'defense']) for (const s of data.spawns[side]) im.circle(px(s.x), pz(s.z), 4, [255, 255, 255]);
    title.split('|').forEach((t, k) => im.text(6, 4 + k * 13, t, [255, 255, 255], 2));
    im.save(file); files.push(file);
  };
  const legend = 'X RIGHT Z DOWN. GREEN ARROW FACE, YELLOW FACE2, RED DOT WALK=FALSE.|BLUE STAGING (+PATH TO SITE). RED CELLS = SPIKE SPOT WITH NO DEFUSE NODE';
  const xs = Array.from(g.x), zs = Array.from(g.z);
  draw([Math.min(...xs) - 3, Math.max(...xs) + 3, Math.min(...zs) - 3, Math.max(...zs) + 3], 6, `${map} ROUND NAV. ${legend}`, `${dir}/${map}-nav-overview.png`);
  for (const s of data.sites) {
    const xsS = [s.zone[0][0], s.zone[2][0], ...(data.retake?.[s.id] ?? []).map((p) => p.x)], zsS = [s.zone[0][1], s.zone[2][1], ...(data.retake?.[s.id] ?? []).map((p) => p.z)];
    draw([Math.min(...xsS) - 14, Math.max(...xsS) + 14, Math.min(...zsS) - 14, Math.max(...zsS) + 14], 16, `${map} SITE ${s.id}. ${legend}`, `${dir}/${map}-nav-site-${s.id}.png`);
  }
  return files;
}

// Top-down plot of the attacker data (header.attack): routes (staging -> plant paths), entry
// waypoints, plant spots, post-plant spots with a line to their plant spot.
export function attackPlot(g, data, header, file, map = data.map) {
  const at = header.attack;
  if (!at) throw new Error('attackPlot: header has no attack data');
  const pts = [...data.sites.flatMap((s) => s.zone), ...data.spawns.attack.map((p) => [p.x, p.z])];
  const x0 = Math.min(...pts.map((p) => p[0])) - 12, x1 = Math.max(...pts.map((p) => p[0])) + 12;
  const z0 = Math.min(...pts.map((p) => p[1])) - 12, z1 = Math.max(...pts.map((p) => p[1])) + 12, S = 7;
  const W = Math.ceil((x1 - x0) * S), Hh = Math.ceil((z1 - z0) * S) + 52;
  const im = new Img(W, Hh), px = (x) => (x - x0) * S, pz = (z) => (z - z0) * S + 52;
  const order = [...Array(g.count).keys()].filter((i) => g.x[i] >= x0 && g.x[i] <= x1 && g.z[i] >= z0 && g.z[i] <= z1).sort((a, b) => g.y[a] - g.y[b]);
  for (const i of order) { const v = Math.round(50 + Math.max(0, Math.min(1, (g.y[i] + 2) / 12)) * 80); im.rect(px(g.x[i]), pz(g.z[i]), 4, [v, v, v + 8]); }
  for (const s of data.sites) { const p = s.zone; for (let k = 0; k < p.length; k++) { const q = p[(k + 1) % p.length]; im.line(px(p[k][0]), pz(p[k][1]), px(q[0]), pz(q[1]), [250, 220, 40], 2); } }
  for (const b of data.barriers) im.line(px(b.a.x), pz(b.a.z), px(b.b.x), pz(b.b.z), b.team === 'attack' ? [255, 160, 0] : [0, 220, 230], 3);
  for (const s of data.spawns.attack) im.circle(px(s.x), pz(s.z), 4, [255, 255, 255]);
  const routeCol = [[90, 255, 120], [255, 120, 255]];
  for (const [id, routes] of Object.entries(at.staging)) routes.forEach((rt, k) => {
    const col = routeCol[k % 2], pn = at.plant[id].map((p) => p.node).filter((n) => n >= 0);
    for (const st of rt.staging) {
      if (st.node < 0) continue;
      const f = dijkstra(g, [st.node], { types: TYPES.walkDrop });
      for (const n of pn) { const path = viaPath(f.via, n); for (let m = 1; m < path.length; m++) im.line(px(g.x[path[m - 1]]), pz(g.z[path[m - 1]]), px(g.x[path[m]]), pz(g.z[path[m]]), col.map((c) => c * 0.6), 1); }
      if (st.wait && st.wait.node !== st.node) { const w = st.wait.node; im.rect(px(g.x[w]), pz(g.z[w]), 6, [255, 160, 0]); }
    }
    for (const st of rt.staging) if (st.node >= 0) { im.rect(px(g.x[st.node]), pz(g.z[st.node]), 9, [0, 0, 0]); im.rect(px(g.x[st.node]), pz(g.z[st.node]), 7, col); }
    const s0 = rt.staging.find((q) => q.node >= 0);
    if (s0) im.label(px(g.x[s0.node]) + 8, pz(g.z[s0.node]) - 4, `${id} ${rt.route}`, col, 2);
    const e = data.attack.routes[id][k].entry;
    im.circle(px(e.x), pz(e.z), 3 * S, col, 2); im.label(px(e.x) + 3 * S + 3, pz(e.z) - 4, `ENTRY ${e.name}`, col, 2);
  });
  for (const [id, list] of Object.entries(at.plant)) list.forEach((p) => {
    if (p.node < 0) return;
    const X = px(g.x[p.node]), Z = pz(g.z[p.node]);
    for (const q of at.postPlant[id][p.name]) {
      im.line(X, Z, px(q.x), pz(q.z), [80, 170, 255], 1);
      im.rect(px(q.x), pz(q.z), 9, [0, 0, 0]); im.rect(px(q.x), pz(q.z), 7, q.seen ? [150, 200, 255] : [60, 140, 255]);
    }
    im.circle(X, Z, DEFUSE_R * S, [255, 60, 60], 2); im.rect(X, Z, 7, [255, 60, 60]);
    im.label(X + 8, Z + 6, p.name, [255, 120, 120], 2);
  });
  [`${map} ATTACK DATA. X RIGHT, Z DOWN. WHITE RINGS = ATTACKER SPAWNS.`,
    'GREEN/PINK = ROUTES - SQUARES STAGING, LINES PATH TO PLANT, RING ENTRY.',
    'RED = PLANT SPOT (RING = DEFUSE RADIUS). BLUE = POST-PLANT SPOT.',
    'BARRIERS - ORANGE ATTACKER, CYAN DEFENDER. ORANGE SQUARE = WAIT NODE.'].forEach((t, k) => im.text(6, 4 + k * 12, t, [255, 255, 255], 2));
  im.save(file);
  return file;
}

// Retake staging candidates for a site (how the authored RETAKE points in round_author.mjs were
// picked): nodes 2.5-4 s (walk + drop) from the site goal, reachable from the defender spawn with
// the defender barriers up, outside the plant zone, open floor (8 walk neighbours), hidden from
// 1 m above the site goal node at 1.0 and 1.6 m above the node. Grouped by the first path node inside
// the zone (4 m); within a group ranked by |t - 3| + detour from the defenders' own spawn route.
export function stagingCandidates(g, T, data, siteId, { top = 6 } = {}) {
  const C = navContext(g, data), S = C.sites[siteId], s = S.site, c = S.centre;
  const eye = [g.x[c], g.y[c] + BODY, g.z[c]];
  const fromSp = dijkstra(g, C.sp.defense, { types: TYPES.walkDrop }).dist;
  const tG = Math.min(...S.goal.map((i) => fromSp[i]));
  const defSide = flood(g, C.sp.defense, { types: TYPES.all, mask: C.defMask });
  const groups = [];
  for (let i = 0; i < g.count; i++) {
    const t = S.field.dist[i];
    if (!(t >= 2.5 && t <= 4) || C.defWalk[i] === -2 || defSide[i] === -2 || inPoly(s.zone, g.x[i], g.z[i])) continue;
    let deg = 0; for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) if (g.edgeType[e] === 0) deg++;
    if (deg < 8) continue;
    if (T.sight(eye, [g.x[i], g.y[i] + BODY, g.z[i]]) || T.sight(eye, [g.x[i], g.y[i] + EYE, g.z[i]])) continue;
    const path = viaPath(S.field.via, i), en = path.find((k) => inPoly(s.zone, g.x[k], g.z[k])) ?? path[path.length - 1];
    const k = { node: i, x: r2(g.x[i]), y: r2(g.y[i]), z: r2(g.z[i]), t: r2(t), detour: r2(fromSp[i] + t - tG), entry: [r2(g.x[en]), r2(g.y[en]), r2(g.z[en])] };
    let q = groups.find((q) => Math.hypot(q.entry[0] - k.entry[0], q.entry[2] - k.entry[2]) < 4 && Math.abs(q.entry[1] - k.entry[1]) < 1.5);
    if (!q) { q = { entry: k.entry, list: [] }; groups.push(q); }
    q.list.push(k);
  }
  for (const q of groups) q.list.sort((a, b) => (Math.abs(a.t - 3) + a.detour) - (Math.abs(b.t - 3) + b.detour) || a.node - b.node);
  return groups.sort((a, b) => b.list.length - a.list.length).map((q) => ({ entry: q.entry, count: q.list.length, best: q.list.slice(0, top) }));
}
