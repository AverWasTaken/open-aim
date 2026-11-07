// Round mode nav header data (written by tools/round_nav.mjs into <map>.nav.bin) and the travel
// report / plots. Everything that needs a real sight ray lives here, so round_author.mjs --check
// and the app only read the result.
//
// Header fields (angles: SIM/bot convention, facingYaw = atan2(dx, dz), forward = (sin, cos)):
//   inputs:  { file, sha256 }  hash of the map json fields this data was derived from
//            (spawns, barriers, sites, setups, retake); the round tests fail when it is stale.
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
import crypto from 'node:crypto';
import { reverseEdges } from '../app/mods/aim-rounds/round-nav.mjs';
import { TYPES, nodeIndex, nodesNear, nearestNode, flood, dijkstra, barrierMask, viaPath } from './round_navlib.mjs';
import { Img } from './round_png.mjs';

export const EYE = 1.6, BODY = 1.0, FACE_RANGE = 30, FACE2_MIN_DEG = 40;
export const DEFUSE_R = 1.6, DEFUSE_DY = 2;
export const ATTACKER_TYPES = [0, 1, 2]; // walk, drop, jump up (no 2-cell gap hops)
const r2 = (v) => Math.round(v * 100) / 100, r4 = (v) => Math.round(v * 1e4) / 1e4;

export function inputsHash(data) {
  const { spawns, barriers, sites, setups, retake } = data;
  return crypto.createHash('sha256').update(JSON.stringify({ spawns, barriers, sites, setups, retake: retake ?? null })).digest('hex');
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
  return { setups, staging, zones, siteGoals };
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
