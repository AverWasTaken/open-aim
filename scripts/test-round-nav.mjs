import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoundNav, writeRoundNav, reverseEdges } from "../app/mods/aim-rounds/round-nav.mjs";
import { terrainSources } from "../tools/round_terrain.mjs";
import { TYPES, nodeIndex, nearestNode, flood } from "../tools/round_navlib.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HAVE_SITE = fs.existsSync(path.join(root, "site", "aim-maps", "ascent.collision.json"));
const NAV_FILE = path.join(root, "app", "mods", "aim-rounds", "ascent.nav.bin");
const data = JSON.parse(fs.readFileSync(path.join(root, "app", "mods", "aim-rounds", "ascent.json"), "utf8"));
const nav = parseRoundNav(fs.readFileSync(NAV_FILE));

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

test("ascent.nav.bin was baked from the current collision files", { skip: !HAVE_SITE && "no game files in site/" }, () => {
  const src = terrainSources("ascent", root);
  const h = nav.header;
  assert.equal(h.map, "ascent");
  assert.equal(h.source.file, src.collision.file);
  const stale = "the map collision changed since the nav bake: rerun node tools/round_nav.mjs";
  assert.equal(h.source.sha256, src.collision.sha256, stale);
  assert.equal(h.source.glb.sha256, src.glb.sha256, stale);
  assert.equal(h.source.worker.sha256, src.worker.sha256, stale);
});

test("ascent.nav.bin graph is sane", () => {
  const g = nav, h = g.header;
  // Same graph as the M1 seal check (Vv from both spawns, merged).
  assert.equal(g.count, 21746, "node count");
  assert.equal(g.edgeCount, 161371, "edge count");
  assert.deepEqual(
    { stepUp: h.bake.stepUp, jumpUp: h.bake.jumpUp, maxDrop: h.bake.maxDrop, runSpeed: h.bake.runSpeed, gravity: h.bake.gravity, jumpSeconds: h.bake.jumpSeconds },
    { stepUp: 0.5, jumpUp: 1.1, maxDrop: 4.5, runSpeed: 6.75, gravity: 24.456521739, jumpSeconds: 0.45 });
  assert.ok(h.bake.runs.length === 2 && h.bake.runs.every((r) => !r.truncated), "no truncated Vv run");
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
    // B's centre point is on a crate with no node; the nearest floor node is ~1.1 m away.
    const c = nearestNode(g, H, s.center.x, s.center.z, 3.0, (s.y[0] + s.y[1]) / 2, (s.y[1] - s.y[0]) / 2 + 0.5);
    assert.ok(c >= 0, `site ${s.id} centre on the graph`);
    assert.notEqual(fa[c], -2, `attackers reach site ${s.id}`);
    assert.notEqual(fdw[c], -2, `defenders reach site ${s.id} on walk+drop edges`);
  }
});
