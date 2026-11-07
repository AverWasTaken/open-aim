import test from "node:test";
import assert from "node:assert/strict";
import { parseRoundNav, writeRoundNav, reverseEdges } from "../app/mods/aim-rounds/round-nav.mjs";

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
