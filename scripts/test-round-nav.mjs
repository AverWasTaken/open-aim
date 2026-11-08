import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseRoundNav, writeRoundNav, reverseEdges } from "../app/mods/aim-rounds/round-nav.mjs";
import { terrainSources, loadTerrain } from "../tools/round_terrain.mjs";
import { TYPES, nodeIndex, nodesNear, nearestNode, flood, dijkstra, viaPath, barrierMask, edgeCutBy } from "../tools/round_navlib.mjs";
import { inputsHash, inPoly, polyEdgeDist, attackEntryTimes, navContext, barrierSamples } from "../tools/round_navdata.mjs";
import { LOOK } from "./round-look.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUNDS = path.join(root, "app", "mods", "aim-rounds");

// Every map with Round mode data (<map>.json + <map>.nav.bin) is tested; each needs an entry here.
//   count/edgeCount: the baked graph (a re-bake must repeat it; tools/round_nav.mjs EXPECT has the same)
//   notWalk: setups defenders can't walk to (known); routes: attacker route names per site
//   setupTiming: setups held before the first attacker can reach the zone with the shortest barrier
//   (spawnT <= 10 s + attackers' fastest barrier -> zone time) and at least one per site hidden from
//   the attacker barriers (R4 setup rules); Ascent predates the rules
//   minTris: lower bounds for the real collision's pawn / projectile triangle counts
//   ropes: rope links in the seal check (maps with a <map>.ropes.json, Split)
//   look: { site, points: {name: [x, z]} (scripts/round-look.mjs: the attacker's way into the site, snapped
//   to the nav), minSeen }: at least minSeen of the site's pre-round setups (push spots don't count) are
//   seen from those points (real sight rays): the user's
//   "the star was the ONLY enemy I saw" on Ascent B (old spots sat in the sunken site, facing the lane)
const EXPECT = {
  ascent: { count: 21746, edgeCount: 161371, notWalk: [], routes: { A: ["A Main", "Mid Cubby"], B: ["B Main", "Mid Market"] }, setupTiming: false, minTris: [1e6, 1e6],
    look: { site: "B", points: LOOK.ascent.B, minSeen: 9 } },
  rook: { count: 21693, edgeCount: 162053, notWalk: [], routes: { A: ["A Main", "A Link"], B: ["B Main", "B Link"] }, setupTiming: true, minTris: [1e6, 1e6] },
  bonsai: { count: 17913, edgeCount: 131407, notWalk: [], routes: { A: ["A Main", "A Ramps"], B: ["B Garage", "Mid Mail"] }, setupTiming: true, minTris: [1e6, 1e6], ropes: 7 },
};
const MAPS = fs.readdirSync(ROUNDS).filter((f) => /^[a-z0-9]+\.json$/.test(f)).map((f) => f.slice(0, -5))
  .filter((m) => fs.existsSync(path.join(ROUNDS, `${m}.nav.bin`))).sort();

test("round nav file round-trips and reverse edges match", () => {
  // 3 nodes: 0 -walk-> 1, 1 -walk-> 0, 1 -drop-> 2 (one-way)
  const g = { x: [0, 0.5, 1], y: [2, 2, 0.5], z: [0, 0, 0], edgeStart: [0, 1, 3, 3], edgeTo: [1, 0, 2], edgeCost: [0.074, 0.074, 0.4], edgeType: [0, 0, 1] };
  const bin = writeRoundNav(g, { map: "t", cell: 0.5 });
  const r = parseRoundNav(bin);
  assert.equal(r.header.map, "t");
  assert.equal(r.count, 3); assert.equal(r.edgeCount, 3);
  assert.deepEqual(Array.from(r.edgeTo), [1, 0, 2]);
  assert.deepEqual(Array.from(r.edgeType), [0, 0, 1]);
  assert.ok(Math.abs(r.y[2] - 0.5) < 1e-6 && Math.abs(r.edgeCost[2] - 0.4) < 1e-6);
  const rev = reverseEdges(r);
  const inc = (i) => Array.from(rev.revFrom.slice(rev.revStart[i], rev.revStart[i + 1]));
  assert.deepEqual(inc(0), [1]); assert.deepEqual(inc(1), [0]); assert.deepEqual(inc(2), [1]);
  assert.throws(() => parseRoundNav(new Uint8Array(16)), /bad magic/);
});

test("every map with round data has an EXPECT entry (ascent and rook at least)", () => {
  for (const m of ["ascent", "rook"]) assert.ok(MAPS.includes(m), `${m} has json + nav.bin`);
  for (const m of MAPS) assert.ok(EXPECT[m], `scripts/test-round-nav.mjs EXPECT has no entry for ${m}`);
});

for (const MAP of MAPS) {
  const HAVE_SITE = fs.existsSync(path.join(root, "site", "aim-maps", `${MAP}.collision.json`));
  const NAV_FILE = path.join(ROUNDS, `${MAP}.nav.bin`);
  const data = JSON.parse(fs.readFileSync(path.join(ROUNDS, `${MAP}.json`), "utf8"));
  const nav = parseRoundNav(fs.readFileSync(NAV_FILE));
  const E = EXPECT[MAP] ?? {};
  const T_ = `[${MAP}]`;

  test(`${T_} nav.bin was baked from the current collision files`, { skip: !HAVE_SITE && "no game files in site/" }, () => {
    const src = terrainSources(MAP, root);
    const h = nav.header;
    assert.equal(h.map, MAP);
    assert.equal(h.source.file, src.collision.file);
    const stale = `the map collision changed since the nav bake: rerun node tools/round_nav.mjs --map ${MAP}`;
    assert.equal(h.source.sha256, src.collision.sha256, stale);
    assert.equal(h.source.glb.sha256, src.glb.sha256, stale);
    assert.equal(h.source.worker.sha256, src.worker.sha256, stale);
  });

  test(`${T_} nav.bin graph is sane`, () => {
    const g = nav, h = g.header;
    // Same graph as the committed bake (Vv from both spawns, merged).
    assert.equal(g.count, E.count, "node count");
    assert.equal(g.edgeCount, E.edgeCount, "edge count");
    assert.deepEqual(
      { stepUp: h.bake.stepUp, jumpUp: h.bake.jumpUp, maxDrop: h.bake.maxDrop, runSpeed: h.bake.runSpeed, gravity: h.bake.gravity, jumpSeconds: h.bake.jumpSeconds },
      { stepUp: 0.5, jumpUp: 1.1, maxDrop: 4.5, runSpeed: 6.75, gravity: 24.456521739, jumpSeconds: 0.45 });
    assert.ok(h.bake.runs.length === 2 && h.bake.runs.every((r) => !r.truncated), "no truncated Vv run");
    // The graph is grown from each team's first spawn: moving one needs a full bake.
    for (const r of h.bake.runs) {
      const p = data.spawns[r.team][0];
      assert.deepEqual(r.start, { x: p.x, y: p.y, z: p.z }, `${r.team} spawn moved since the bake: rerun node tools/round_nav.mjs --map ${MAP} (full bake)`);
    }
    assert.equal(h.cell, 0.5);
    for (let i = 0; i < g.count; i++) {
      assert.ok(g.edgeStart[i + 1] >= g.edgeStart[i]);
      const u = (g.x[i] - h.originX) / h.cell, v = (g.z[i] - h.originZ) / h.cell;
      if (Math.abs(u - Math.round(u)) > 2e-3 || Math.abs(v - Math.round(v)) > 2e-3) assert.fail(`node ${i} off the 0.5 m grid`);
    }
    const types = [0, 0, 0, 0];
    for (let i = 0; i < g.count; i++) for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
      const j = g.edgeTo[e], t = g.edgeType[e];
      if (!(j >= 0 && j < g.count && j !== i)) assert.fail(`edge ${e} bad target`);
      if (!(g.edgeCost[e] > 0 && g.edgeCost[e] < 5)) assert.fail(`edge ${e} cost ${g.edgeCost[e]}`);
      const dxz = Math.hypot(g.x[j] - g.x[i], g.z[j] - g.z[i]), dy = g.y[j] - g.y[i];
      const want = dxz > 0.75 ? 3 : dy > 0.5 ? 2 : dy < -0.5 ? 1 : 0;
      // The bake classified in float64; skip edges within float32 rounding of a threshold.
      const edge = Math.abs(dxz - 0.75) < 1e-3 || Math.abs(Math.abs(dy) - 0.5) < 1e-3;
      if (t !== want && !edge) assert.fail(`edge ${e} type ${t}, geometry says ${want}`);
      types[t]++;
    }
    assert.ok(types[0] > 0.95 * g.edgeCount, "mostly walk edges");
    // Every spawn is on the graph and the two sides (and both sites) are connected.
    const H = nodeIndex(g), snap = (p) => nearestNode(g, H, p.x, p.z, 0.5, p.y, 0.6);
    const sp = { attack: data.spawns.attack.map(snap), defense: data.spawns.defense.map(snap) };
    for (const team of ["attack", "defense"]) sp[team].forEach((n, k) => assert.ok(n >= 0, `${team} spawn ${k} on the graph`));
    const fa = flood(g, sp.attack, { types: TYPES.all }), fd = flood(g, sp.defense, { types: TYPES.all });
    for (const n of sp.defense) assert.notEqual(fa[n], -2, "attacker spawn reaches the defender spawn");
    for (const n of sp.attack) assert.notEqual(fd[n], -2, "defender spawn reaches the attacker spawn");
    const fdw = flood(g, sp.defense, { types: TYPES.walkDrop });
    for (const s of data.sites) {
      // Ascent B's centre point is on a crate with no node; the nearest floor node is ~1.1 m away.
      const c = nearestNode(g, H, s.center.x, s.center.z, 3.0, (s.y[0] + s.y[1]) / 2, (s.y[1] - s.y[0]) / 2 + 0.5);
      assert.ok(c >= 0, `site ${s.id} centre on the graph`);
      assert.notEqual(fa[c], -2, `attackers reach site ${s.id}`);
      assert.notEqual(fdw[c], -2, `defenders reach site ${s.id} on walk+drop edges`);
    }
  });

  test(`${T_} nav header data was derived from the current ${MAP}.json; seal check clean`, () => {
    const h = nav.header;
    assert.equal(h.inputs.file, `app/mods/aim-rounds/${MAP}.json`);
    assert.equal(h.inputs.sha256, inputsHash(data), `spawns/barriers/sites/setups/retake/attack changed: rerun node tools/round_nav.mjs --map ${MAP} --reuse (a full bake without --reuse if the first spawn of a team moved)`);
    // round_author's seal check ran on this graph: no leak, every own callout reached.
    assert.deepEqual(data.authoring.seal.nav, { file: `app/mods/aim-rounds/${MAP}.nav.bin`, nodes: nav.count, edges: nav.edgeCount });
    for (const team of ["attack", "defense"]) {
      for (const mode of ["walk", "all"]) {
        assert.deepEqual(data.authoring.seal[team][mode].leaks, [], `${team} ${mode} leaks`);
        assert.ok(data.authoring.seal[team][mode].nodes > 1000);
      }
      assert.deepEqual(data.authoring.seal[team].unreached, [], `${team} reaches all its own callouts`);
    }
  });

  // Barriers from the map's SM_Barrier prims (BARRIERS 'collision') or world marks checked by the same
  // flood rule (MARK_TEAMS, Split) must each cut >= 5 walk edges (the team-by-flood rule). Ascent's
  // picture marks are exempt: def-b1 is a dash over a doorway with no nav edges under it (harmless, kept
  // so ascent.json stays as it is).
  const fromPrims = data.barriers.every((b) => Number.isInteger(data.authoring.barriers[b.id]?.prim));
  const markTeams = data.barriers.every((b) => data.authoring.barriers[b.id]?.floodTeam === b.team);
  const strict = fromPrims || markTeams;
  test(`${T_} barriers: both teams, unique ids${strict ? ", each cuts real walk edges" : ""}`, () => {
    const ids = data.barriers.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, "unique barrier ids");
    for (const team of ["attack", "defense"]) assert.ok(data.barriers.some((b) => b.team === team), `${team} barriers`);
    if (MAP === "rook") assert.ok(fromPrims, "rook barriers come from the map's SM_Barrier prims");
    if (MAP === "bonsai") assert.ok(markTeams, "bonsai barrier marks carry the flood team they were checked with");
    if (strict) for (const b of data.barriers) {
      let cut = 0;
      for (let i = 0; i < nav.count; i++) for (let e = nav.edgeStart[i]; e < nav.edgeStart[i + 1]; e++) if (nav.edgeType[e] === 0 && edgeCutBy(nav, [b], i, nav.edgeTo[e])) cut++;
      assert.ok(cut >= 5, `${b.id} cuts ${cut} walk edges`);
    }
  });

  let pushC = null;
  const pushCtx = () => (pushC ??= navContext(nav, data));
  test(`${T_} setups: groups, splits, facing, walk reachability, enough walkable spots for every split`, () => {
    const hs = nav.header.setups, deg = Math.PI / 180;
    const groups = Object.keys(data.setups.defense);
    // Group keys: the site ids plus an optional "mid" (round-bots rotates "mid" by name).
    assert.deepEqual(groups.filter((k) => k !== "mid").sort(), data.sites.map((s) => s.id).sort());
    for (const sp of data.setups.splits) {
      assert.equal(sp.length, groups.length, `split ${sp} has one count per group`);
      assert.equal(sp.reduce((a, b) => a + b, 0), 5, `split ${sp} sums to 5`);
    }
    const names = Object.values(data.setups.defense).flat().map((s) => s.name);
    assert.equal(new Set(names).size, names.length, "setup names unique on the map");
    assert.deepEqual(Object.keys(hs).sort(), [...names].sort());
    for (const [group, list] of Object.entries(data.setups.defense)) for (const s of list) {
      const h = hs[s.name];
      assert.equal(h.group, group);
      assert.equal(h.clear === false, s.clear === false, `${s.name} header clear flag matches the json`);
      if ((E.notWalk ?? []).includes(s.name)) { assert.equal(h.walk, false, `${s.name} known not walkable`); continue; }
      if (s.push === true) {
        // After-barrier spot: past the defender barriers (walk:false with them up), reachable once they
        // drop (round-bots wait mode: the bot waits behind its barrier, walks on at the drop), never a
        // clear spot for attackers, and clear of the attacker barriers (>= 8 m).
        assert.equal(h.push, true, `${s.name} header push flag`);
        assert.equal(h.walk, false, `${s.name} push spot is past a defender barrier`);
        assert.equal(s.clear, false, `${s.name} push spot is clear:false`);
        assert.ok(h.node >= 0 && Math.hypot(nav.x[h.node] - s.x, nav.z[h.node] - s.z) <= 0.5 && Math.abs(nav.y[h.node] - s.y) <= 0.3, `${s.name} node near the spot`);
        assert.notEqual(pushCtx().defWalk[h.node], -2, `${s.name} reachable from the defender spawn once the barriers drop`);
        for (const b of data.barriers.filter((w) => w.team === "attack")) {
          const ax = b.a.x, az = b.a.z, dx = b.b.x - ax, dz = b.b.z - az, L = dx * dx + dz * dz;
          const t = L > 0 ? Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.z - az) * dz) / L)) : 0;
          assert.ok(Math.hypot(s.x - ax - t * dx, s.z - az - t * dz) >= 8, `${s.name} within 8 m of attacker barrier ${b.id}`);
        }
        assert.ok(Number.isFinite(h.face), `${s.name} face`);
        continue;
      }
      assert.equal(h.push, undefined, `${s.name} header push flag only on push spots`);
      assert.ok(h.walk, `${s.name} walkable from the defender spawn inside the defender barriers`);
      assert.ok(h.node >= 0 && h.node < nav.count, `${s.name} node`);
      assert.ok(Math.hypot(nav.x[h.node] - s.x, nav.z[h.node] - s.z) <= 0.5 && Math.abs(nav.y[h.node] - s.y) <= 0.3, `${s.name} node near the spot`);
      assert.ok(Number.isFinite(h.face) && Math.abs(h.face) <= Math.PI, `${s.name} face`);
      if (Number.isFinite(s.faceHint)) { // json faceHint: face within 35 deg of it
        let d = Math.abs(h.face - s.faceHint * deg) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
        assert.ok(d <= 35 * deg + 1e-3, `${s.name} face ${(h.face / deg).toFixed(0)} deg, hint ${s.faceHint}`);
      }
      if (h.face2 !== null) {
        let d = Math.abs(h.face2 - h.face) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
        assert.ok(d >= 40 * deg - 1e-3, `${s.name} face2 at least 40 deg from face`);
      }
      // face points at the node it was picked from (sim convention atan2(dx, dz))
      const f = h.faceNode;
      assert.ok(Math.abs(Math.atan2(nav.x[f] - s.x, nav.z[f] - s.z) - h.face) < 1e-3, `${s.name} face matches faceNode`);
      assert.ok(Math.hypot(nav.x[f] - s.x, nav.z[f] - s.z) <= 30, `${s.name} face target within 30 m`);
      assert.ok(h.spawnT > 0 && h.spawnT < 20, `${s.name} reached from the defender spawn in ${h.spawnT} s`);
    }
    // Every split must find enough walkable setups in each group.
    groups.forEach((group, k) => {
      const need = Math.max(...data.setups.splits.map((sp) => sp[k]));
      const have = data.setups.defense[group].filter((s) => hs[s.name].walk).length;
      assert.ok(have >= need, `group ${group}: ${have} walkable setups, a split needs ${need}`);
    });
  });

  test(`${T_} every setup reaches its site goal over walk + drop edges (mid: a site goal)`, () => {
    const C = navContext(nav, data);
    for (const [group, list] of Object.entries(data.setups.defense)) for (const s of list) {
      const h = nav.header.setups[s.name];
      if (h.node < 0 || (E.notWalk ?? []).includes(s.name)) continue; // known not walkable (none on the shipped maps)
      const ok = group === "mid" ? Object.values(C.sites).some((S) => Number.isFinite(S.field.dist[h.node])) : Number.isFinite(C.sites[group].field.dist[h.node]);
      assert.ok(ok, `${s.name} (${group}) can't walk to its site goal`);
    }
  });

  if (E.ropes) test(`${T_} ropes: every rope linked, none crosses a barrier or lies off its side within 8 m`, () => {
    const r = data.authoring.ropes;
    assert.equal(r.length, E.ropes);
    assert.equal(data.authoring.seal.ropeLinks, E.ropes);
    for (const q of r) {
      assert.ok(q.bottom >= 0 && q.top >= 0, `${q.rope} has nav nodes at both ends`);
      for (const n of q.near) assert.ok(!n.cross && n.ownSide, `${q.rope} vs ${n.barrier}: cross ${n.cross}, own side ${n.ownSide}`);
    }
  });

  if (E.setupTiming) test(`${T_} setups are held before the first attacker can reach the site (10 s barrier)`, () => {
    const entry = attackEntryTimes(nav, data, navContext(nav, data));
    for (const s of data.sites) {
      assert.ok(Number.isFinite(entry[s.id]) && entry[s.id] > 2, `attackers' barrier -> zone ${s.id} ${entry[s.id]} s`);
      for (const p of data.setups.defense[s.id]) {
        const h = nav.header.setups[p.name];
        assert.ok(h.spawnT <= 10 + entry[s.id], `${p.name}: spawnT ${h.spawnT} s > 10 + ${entry[s.id]} s`);
      }
    }
    for (const p of data.setups.defense.mid ?? []) assert.ok(nav.header.setups[p.name].spawnT <= 10, `${p.name} held within the barrier`);
  });

  test(`${T_} retake staging points are hidden, reachable and 2.5-4 s from the site`, () => {
    const st = nav.header.staging;
    assert.deepEqual(Object.keys(data.retake).sort(), data.sites.map((s) => s.id).sort(), "retake keys = site ids");
    for (const [site, list] of Object.entries(data.retake)) {
      assert.equal(list.length, 2, `${site}: 2 staging points`);
      list.forEach((p, k) => {
        const h = st[site][k];
        assert.equal(h.name, p.name);
        assert.ok(h.node >= 0, `${p.name} on the graph`);
        assert.ok(h.reach, `${p.name} reachable from the defender spawn on walk + drop edges`);
        assert.ok(h.t >= 2.5 && h.t <= 4, `${p.name} ${h.t} s from site ${site}`);
        assert.ok(h.hidden, `${p.name} hidden from the site centre`);
        const z = data.sites.find((s) => s.id === site).zone;
        assert.ok(!inPoly(z, p.x, p.z), `${p.name} outside the plant zone`);
      });
      const [a, b] = list;
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 5, `${site} staging points apart`);
    }
  });

  test(`${T_} plant zones: almost every spike spot has a defender-walkable node in defuse range`, () => {
    const H = nodeIndex(nav);
    for (const s of data.sites) {
      const z = nav.header.zones[s.id];
      assert.ok(z.samples > 300, `zone ${s.id} spike spots`);
      assert.ok(z.noDefuseNode >= 0 && z.noDefuseNode <= 0.02, `zone ${s.id} no-defuse fraction ${z.noDefuseNode}`);
      assert.equal(z.bad.length, Math.round(z.noDefuseNode * z.samples));
      const g = nav.header.siteGoals[s.id];
      assert.ok(g.node >= 0 && Math.hypot(g.x - s.center.x, g.z - s.center.z) <= 1.6, `site ${s.id} goal node`);
      assert.equal(nearestNode(nav, H, g.x, g.z, 0.05), g.node);
    }
  });

  // ---------------------------------------------------------------- attacker data (round mode R3)
  // Recomputed here from the graph (not read from the header's own flags): routes, staging, plant spots.
  const atkCtx = (() => {
    const g = nav, H = nodeIndex(g), snap = (p) => nearestNode(g, H, p.x, p.z, 0.5, p.y, 0.6);
    const sp = { attack: data.spawns.attack.map(snap), defense: data.spawns.defense.map(snap) };
    const bars = (team) => barrierMask(g, data.barriers.filter((b) => b.team === team));
    return {
      H, sp,
      defSide: flood(g, sp.defense, { types: TYPES.all, mask: bars("defense") }),    // defender side in the barrier phase
      atkBar: flood(g, sp.attack, { types: TYPES.walkDrop, mask: bars("attack") }),  // where attackers walk in the barrier phase
      atkAll: flood(g, sp.attack, { types: TYPES.all }),
      defWalk: flood(g, sp.defense, { types: TYPES.walkDrop }),
      spawnT: sp.attack.map((n) => dijkstra(g, [n], { types: TYPES.walkDrop }).dist),
    };
  })();
  const nodeAt = (p, dy = 0.3) => nearestNode(nav, atkCtx.H, p.x, p.z, 0.5, p.y, dy);
  const inSiteZone = (s, i) => inPoly(s.zone, nav.x[i], nav.z[i]) && nav.y[i] >= s.y[0] && nav.y[i] <= s.y[1];

  test(`${T_} attack data: 2 routes per site with 3 staging points, 2 plant spots per site`, () => {
    const a = data.attack;
    assert.ok(a, `${MAP}.json has an attack block`);
    const ids = data.sites.map((s) => s.id).sort();
    assert.deepEqual(Object.keys(a.routes).sort(), ids);
    for (const [site, names] of Object.entries(E.routes)) assert.deepEqual(a.routes[site].map((r) => r.name), names);
    for (const list of Object.values(a.routes)) for (const r of list) {
      assert.equal(r.staging.length, 3, `${r.name}: 3 staging points`);
      for (const p of [r.entry, ...r.staging]) assert.ok(typeof p.name === "string" && [p.x, p.y, p.z].every(Number.isFinite), `${r.name}: ${p.name}`);
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(Math.hypot(r.staging[i].x - r.staging[j].x, r.staging[i].z - r.staging[j].z) >= 1.4, `${r.name} staging points apart`);
    }
    assert.deepEqual(Object.keys(a.plant).sort(), ids);
    for (const list of Object.values(a.plant)) assert.equal(list.length, 2);
    // the header mirrors the data
    const h = nav.header.attack;
    for (const [site, list] of Object.entries(a.routes)) assert.deepEqual(h.staging[site].map((r) => r.route), list.map((r) => r.name));
    for (const [site, list] of Object.entries(a.plant)) assert.deepEqual(h.plant[site].map((p) => p.name), list.map((p) => p.name));
  });

  test(`${T_} attack staging: never on the defender side, reached from every attacker spawn, wait node behind the attacker barriers`, () => {
    const h = nav.header.attack;
    for (const [site, list] of Object.entries(data.attack.routes)) list.forEach((r, k) => {
      const hr = h.staging[site][k];
      assert.ok(nodeAt(r.entry, 0.6) >= 0, `${r.name} entry ${r.entry.name} on the graph`);
      r.staging.forEach((p, j) => {
        const n = nodeAt(p), hs = hr.staging[j];
        assert.ok(n >= 0, `${p.name} on the graph`);
        assert.equal(hs.node, n);
        assert.equal(atkCtx.defSide[n], -2, `${p.name} is not on the defender side`);
        assert.notEqual(hs.side, "defense");
        atkCtx.spawnT.forEach((f, s) => assert.ok(Number.isFinite(f[n]), `${p.name} reached from attacker spawn ${s} on walk + drop edges`));
        // barrier phase: the wait node is on the attackers' side and leads to the staging point.
        assert.ok(hs.wait && hs.wait.node >= 0, `${p.name} wait node`);
        assert.notEqual(atkCtx.atkBar[hs.wait.node], -2, `${p.name} wait node reached with the attacker barriers up`);
        const toStage = dijkstra(nav, [hs.wait.node], { types: TYPES.walkDrop }).dist[n];
        assert.ok(Math.abs(toStage - hs.wait.t) < 0.02 && hs.wait.t < 10, `${p.name} wait node ${hs.wait.t} s from staging`);
      });
    });
  });

  test(`${T_} attack routes: the bots' shortest path staging -> every plant spot passes within 3 m of the entry`, () => {
    for (const [site, list] of Object.entries(data.attack.routes)) for (const r of list) for (const p of r.staging) {
      const f = dijkstra(nav, [nodeAt(p)], { types: TYPES.walkDrop });
      for (const q of data.attack.plant[site]) {
        const pn = nodeAt(q);
        assert.ok(Number.isFinite(f.dist[pn]), `${p.name} -> ${q.name} walkable`);
        const d = Math.min(...viaPath(f.via, pn).map((i) => Math.hypot(nav.x[i] - r.entry.x, nav.z[i] - r.entry.z)));
        assert.ok(d <= 3, `${r.name}: ${p.name} -> ${q.name} passes ${d.toFixed(2)} m from ${r.entry.name}`);
      }
    }
  });

  test(`${T_} plant spots: 1 m inside the zone, every attacker node within 1 m in the zone, defusable, walkable for attackers`, () => {
    const bad = new Set(Object.values(nav.header.zones).flatMap((z) => z.bad.map((b) => b.join(","))));
    const r2 = (v) => Math.round(v * 100) / 100;
    for (const [site, list] of Object.entries(data.attack.plant)) {
      const s = data.sites.find((q) => q.id === site);
      list.forEach((p, k) => {
        const n = nodeAt(p), hp = nav.header.attack.plant[site][k];
        assert.ok(n >= 0 && hp.node === n, `${p.name} on the graph`);
        assert.ok(inPoly(s.zone, nav.x[n], nav.z[n]) && polyEdgeDist(s.zone, nav.x[n], nav.z[n]) >= 1.0, `${p.name} at least 1 m inside the zone polygon`);
        assert.ok(nav.y[n] >= s.y[0] && nav.y[n] <= s.y[1], `${p.name} inside the zone's y range`);
        atkCtx.spawnT.forEach((f, i) => assert.ok(Number.isFinite(f[n]), `${p.name} reached from attacker spawn ${i} on walk + drop edges`));
        const near = nodesNear(nav, atkCtx.H, nav.x[n], nav.z[n], 1.0).filter((j) => atkCtx.atkAll[j] !== -2 && Math.abs(nav.y[j] - nav.y[n]) < 2);
        assert.ok(near.length >= 4, `${p.name}: attacker nodes around it`);
        for (const j of near) {
          assert.ok(inSiteZone(s, j), `${p.name}: node ${j} within 1 m is in the zone`);
          assert.ok(!bad.has([r2(nav.x[j]), r2(nav.y[j]), r2(nav.z[j])].join(",")), `${p.name}: node ${j} not in zones.bad`);
          const def = nodesNear(nav, atkCtx.H, nav.x[j], nav.z[j], 1.6).some((q) => atkCtx.defWalk[q] !== -2 && Math.abs(nav.y[q] - nav.y[j]) < 2);
          assert.ok(def, `${p.name}: node ${j} defusable (defender walk node within 1.6 m)`);
        }
        assert.ok(hp.inZone && hp.reach && hp.nearOk && hp.margin >= 1.0, `${p.name} header checks`);
      });
    }
  });

  test(`${T_} post-plant spots: 3-4 per plant spot, 6-20 m away, attackers walk there, 4 m apart`, () => {
    for (const [site, list] of Object.entries(data.attack.plant)) for (const p of list) {
      const post = nav.header.attack.postPlant[site][p.name], pn = nodeAt(p);
      assert.ok(post.length >= 3 && post.length <= 4, `${p.name}: ${post.length} post-plant spots`);
      for (const q of post) {
        const d = Math.hypot(nav.x[q.node] - nav.x[pn], nav.y[q.node] - nav.y[pn], nav.z[q.node] - nav.z[pn]);
        assert.ok(d >= 6 - 1e-6 && d <= 20 + 1e-6, `${p.name}: post-plant ${q.node} ${d.toFixed(2)} m away`);
        assert.ok(Math.abs(nav.x[q.node] - q.x) < 0.01 && Math.abs(nav.z[q.node] - q.z) < 0.01, "post-plant xyz is its node");
        atkCtx.spawnT.forEach((f, i) => assert.ok(Number.isFinite(f[q.node]), `${p.name}: post-plant ${q.node} reached from attacker spawn ${i}`));
      }
      for (let i = 0; i < post.length; i++) for (let j = i + 1; j < post.length; j++) assert.ok(Math.hypot(post[i].x - post[j].x, post[i].z - post[j].z) >= 4, `${p.name}: post-plant spots 4 m apart`);
    }
  });

  // ---------------------------------------------------------------- real collision (never skipped)
  // loadTerrain is the base of the bake, of round_author's terrain mode and of the bots' real-collision
  // tests. It builds the triangle cache when it is missing (~30 s per map), so these always run when
  // the map files are in site/; a cache that can't be built fails here with the reason.
  let terrain = null;
  const warm = async () => {
    if (terrain) return terrain;
    try { terrain = await loadTerrain(MAP, { root }); } catch (e) { assert.fail(`${MAP}: the terrain triangle cache can't be built (${e.message}); tools/round_terrain.mjs loadTerrain`); }
    assert.ok(terrain, `${MAP}: map files missing for loadTerrain`);
    return terrain;
  };

  test(`${T_} loadTerrain: the game's pawn collision has the floor where the nav says`, { skip: !HAVE_SITE && "no game files in site/" }, async (t) => {
    const T = await warm();
    assert.ok(T.pawnTris.length / 9 > E.minTris[0] && T.projectileTris.length / 9 > E.minTris[1], `triangles: pawn ${T.pawnTris.length / 9}, projectile ${T.projectileTris.length / 9}`);
    const H = nodeIndex(nav);
    for (const p of [data.spawns.defense[0], data.spawns.attack[0]]) {
      const n = nearestNode(nav, H, p.x, p.z, 0.5, p.y, 0.6);
      const top = nav.y[n] + 1.5, d = T.ray(T.pawn, [nav.x[n], top, nav.z[n]], [0, -1, 0], 5);
      assert.ok(d > 0 && Math.abs(top - d - nav.y[n]) < 0.05, `floor under node ${n}`);
    }
    t.diagnostic(`${MAP}: real collision loaded (${T.pawnTris.length / 9} pawn / ${T.projectileTris.length / 9} projectile triangles)`);
    console.log(`${MAP}: real collision loaded (${T.pawnTris.length / 9} pawn / ${T.projectileTris.length / 9} projectile triangles)`);
  });

  // R4 setup rule (real sight rays): per site at least one setup that no attacker-barrier sample point
  // sees (eye 1.6 / body 1.0 m above the spot), so attackers waiting at their barriers can't spot every
  // defender of a site.
  if (E.setupTiming) test(`${T_} every site has a setup hidden from the attacker barriers (real collision sight rays)`, { skip: !HAVE_SITE && "no game files in site/" }, async (t) => {
    const T = await warm(), H = nodeIndex(nav);
    const pts = data.barriers.filter((b) => b.team === "attack").flatMap((b) => barrierSamples(nav, H, b));
    assert.ok(pts.length >= 6, "attacker barrier sample points");
    let rays = 0;
    const see = (a, b) => { rays++; return T.sight(a, b); };
    for (const s of data.sites) {
      const hidden = data.setups.defense[s.id].filter((p) => pts.every((q) => !see(q, [p.x, p.y + 1.6, p.z]) && !see(q, [p.x, p.y + 1.0, p.z])));
      assert.ok(hidden.length >= 1, `site ${s.id}: no setup hidden from the attacker barriers`);
    }
    t.diagnostic(`${MAP}: setup hidden-from-attacker-barrier check: ${rays} rays`);
    console.log(`${MAP}: setup hidden-from-attacker-barrier check: ${rays} rays`);
  });

  // E.look (real sight rays, the bots' own sight test): from the attacker's way into the site (eye
  // 1.6 m) at least minSeen of the site's setups are visible (body 1.0 or head 1.6 m above the spot).
  if (E.look) test(`${T_} ${E.look.site} setups an attacker sees on the way in (real collision sight rays)`, { skip: !HAVE_SITE && "no game files in site/" }, async (t) => {
    const T = await warm(), H = nodeIndex(nav);
    const eyes = Object.entries(E.look.points).map(([name, [x, z]]) => {
      const k = nearestNode(nav, H, x, z, 2);
      assert.ok(k >= 0, `look point ${name} on the nav`);
      return [nav.x[k], nav.y[k] + 1.6, nav.z[k]];
    });
    const list = data.setups.defense[E.look.site].filter((p) => p.push !== true);
    const seen = list.filter((p) => eyes.some((e) => T.sight(e, [p.x, p.y + 1.0, p.z]) || T.sight(e, [p.x, p.y + 1.6, p.z])));
    const msg = `${MAP} ${E.look.site}: ${seen.length}/${list.length} setups seen on the way in; hidden: ${list.filter((p) => !seen.includes(p)).map((p) => p.name).join(", ") || "none"}`;
    assert.ok(seen.length >= E.look.minSeen, msg);
    t.diagnostic(msg);
    console.log(msg);
  });

  // The sight half of the post-plant data, re-run against the real projectile collision (the bots' own
  // sight test): eye 1.6 m above the spot's floor, spike 0.3 m above the plant spot's floor.
  test(`${T_} post-plant spots see the spike (real collision sight rays)`, { skip: !HAVE_SITE && "no game files in site/" }, async (t) => {
    const T = await warm();
    let rays = 0;
    for (const [site, list] of Object.entries(data.attack.plant)) for (const p of list) {
      const pn = nodeAt(p), spike = [nav.x[pn], nav.y[pn] + 0.3, nav.z[pn]];
      for (const q of nav.header.attack.postPlant[site][p.name]) {
        rays++;
        assert.ok(T.sight([q.x, nav.y[q.node] + 1.6, q.z], spike), `${p.name}: post-plant ${q.node} sees the spike`);
      }
      // the check can fail: the defender spawn (behind walls) doesn't see the spike
      const d = data.spawns.defense[0];
      assert.equal(T.sight([d.x, d.y + 1.6, d.z], spike), false, `${p.name}: not seen from the defender spawn`);
    }
    t.diagnostic(`${MAP}: post-plant sight re-checked with real collision: ${rays} rays`);
    console.log(`${MAP}: post-plant sight re-checked with real collision: ${rays} rays`);
  });

  // round_author --check: its ray-free part (seal, barrier teams) and, with the cache warmed above, the
  // full rebuild + compare ("is up to date"; terrain maps rebuild against the real collision).
  test(`${T_} the stored ${MAP}.json is what tools/round_author.mjs builds (--check, full)`, { skip: !HAVE_SITE && "no game files in site/" }, async (t) => {
    await warm();
    const out = execFileSync(process.execPath, [path.join(root, "tools", "round_author.mjs"), "--check", "--map", MAP], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(out, /ray-free check ok/);
    assert.match(out, /is up to date/, "the full rebuild check ran (not only the ray-free part)");
    t.diagnostic(`${MAP}: round_author --check full rebuild ran`);
    console.log(`${MAP}: round_author --check: ${out.split("\n").slice(0, 2).join(" | ")}`);
  });
}
