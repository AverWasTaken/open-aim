// Round mode nav graph file (<map>.nav.bin), format v1, little-endian.
// Made by tools/round_nav.mjs from the map's real collision with the game's own nav builder.
//   "RNAV" | u32 version | u32 headerLen | header JSON (UTF-8) | zero pad to 4
//   f32 x[n] | f32 y[n] | f32 z[n] | i32 edgeStart[n+1] | i32 edgeTo[e] | f32 edgeCost[e] | u8 edgeType[e]
// edgeCost is seconds at run speed. edgeType: 0 walk, 1 drop, 2 jump, 3 gap/other.
// y is the floor height under the node (player feet).

export const NAV_WALK = 0, NAV_DROP = 1, NAV_JUMP = 2, NAV_GAP = 3;
const MAGIC = 0x56414e52; // "RNAV"

const pad4 = (n) => (n + 3) & ~3;

export function parseRoundNav(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  if (ab.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error("round nav: bad magic");
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error("round nav: unsupported version " + version);
  const headerLen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 12, headerLen)));
  const n = header.count, e = header.edgeCount;
  let o = pad4(12 + headerLen);
  const take = (Type, len) => { const a = new Type(ab.slice(o, o + len * Type.BYTES_PER_ELEMENT)); o += pad4(len * Type.BYTES_PER_ELEMENT); return a; };
  const x = take(Float32Array, n), y = take(Float32Array, n), z = take(Float32Array, n);
  const edgeStart = take(Int32Array, n + 1), edgeTo = take(Int32Array, e), edgeCost = take(Float32Array, e), edgeType = take(Uint8Array, e);
  if (o > ab.byteLength || edgeStart[n] !== e) throw new Error("round nav: truncated file");
  return { header, count: n, edgeCount: e, x, y, z, edgeStart, edgeTo, edgeCost, edgeType };
}

export function writeRoundNav(g, header) {
  const n = g.x.length, e = g.edgeTo.length;
  const h = new TextEncoder().encode(JSON.stringify({ ...header, count: n, edgeCount: e }));
  const parts = [g.x, g.y, g.z].map((a) => Float32Array.from(a))
    .concat([Int32Array.from(g.edgeStart), Int32Array.from(g.edgeTo), Float32Array.from(g.edgeCost), Uint8Array.from(g.edgeType)]);
  let size = pad4(12 + h.length);
  for (const p of parts) size += pad4(p.byteLength);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 1, true); dv.setUint32(8, h.length, true);
  out.set(h, 12);
  let o = pad4(12 + h.length);
  for (const p of parts) { out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o); o += pad4(p.byteLength); }
  return out;
}

// Incoming-edge (reverse) CSR. Distance-to-goal fields must run over these: drop edges are one-way.
export function reverseEdges(g) {
  const n = g.count, e = g.edgeCount, revStart = new Int32Array(n + 1), revFrom = new Int32Array(e), revEdge = new Int32Array(e);
  for (let k = 0; k < e; k++) revStart[g.edgeTo[k] + 1]++;
  for (let i = 0; i < n; i++) revStart[i + 1] += revStart[i];
  const fill = revStart.slice(0, n);
  for (let i = 0; i < n; i++) for (let k = g.edgeStart[i]; k < g.edgeStart[i + 1]; k++) {
    const p = fill[g.edgeTo[k]]++; revFrom[p] = i; revEdge[p] = k;
  }
  return { revStart, revFrom, revEdge };
}
