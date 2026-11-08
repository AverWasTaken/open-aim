// Round mode: check defender setup spots before writing them into tools/round_author.mjs SETUPS.
// Per spot: nav node and floor, walk (reachable inside the defender barriers), spawnT, the facing
// round_navdata deriveHeader would give it (face / face2 and the node it looks at), whether it is open
// floor, which defender barriers it sees / is seen from, hidden from the attacker barriers, and which
// of the attacker's look points (scripts/round-look.mjs) see it (real sight rays, eye 1.6 m -> body
// 1.0 / head 1.6 m). Spots are checked as if they were the group's whole list (A / mid unchanged).
// Heavy-ish (sight rays against the real collision, ~20 s): run it on hp.
//   node scripts/round-setup-check.mjs [--map ascent] [--group B] [--spots spots.json]
// spots.json: [[x, y, z, "name", {push|clear|faceHint}?], ...] (the SETUPS row format); without --spots
// it checks the group's current spots from app/mods/aim-rounds/<map>.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTerrain } from '../tools/round_terrain.mjs';
import { parseRoundNav } from '../app/mods/aim-rounds/round-nav.mjs';
import { deriveHeader, setupCandidates } from '../tools/round_navdata.mjs';
import { LOOK } from './round-look.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MAP = arg('--map', 'ascent'), GROUP = arg('--group', 'B'), SPOTS = arg('--spots', null);
const dir = path.join(root, 'app', 'mods', 'aim-rounds');
const data = JSON.parse(fs.readFileSync(path.join(dir, `${MAP}.json`), 'utf8'));
const g = parseRoundNav(fs.readFileSync(path.join(dir, `${MAP}.nav.bin`)));
const T = await loadTerrain(MAP, { root, log: () => {} });
if (!T) throw new Error(`no map files for ${MAP} in site/aim-maps`);
const rows = SPOTS ? JSON.parse(fs.readFileSync(SPOTS, 'utf8'))
  : data.setups.defense[GROUP].map((s) => [s.x, s.y, s.z, s.name, { push: s.push, clear: s.clear, faceHint: s.faceHint }]);
const d2 = JSON.parse(JSON.stringify(data));
d2.setups.defense[GROUP] = rows.map(([x, y, z, name, f]) => ({ name, x, y, z, ...(f?.push === true ? { push: true } : {}), ...(f?.clear === false ? { clear: false } : {}), ...(Number.isFinite(f?.faceHint) ? { faceHint: f.faceHint } : {}) }));
const h = deriveHeader(g, T, d2).setups;
const site = data.sites.some((s) => s.id === GROUP);
const hints = site ? setupCandidates(g, T, d2, GROUP, { hints: rows.map(([x, y, z, name]) => [x, y, z, name]) }).hints : [];
const look = Object.entries(LOOK[MAP]?.[GROUP] ?? {}).map(([name, [x, z]]) => {
  let best = -1, bd = 4; // nearest node within 2 m (xz)
  for (let i = 0; i < g.count; i++) { const d = (g.x[i] - x) ** 2 + (g.z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return best < 0 ? null : { name, eye: [g.x[best], g.y[best] + 1.6, g.z[best]] };
}).filter(Boolean);
const deg = (a) => (a === null ? '-' : Math.round(a * 180 / Math.PI));
for (const [x, y, z, name, f] of rows) {
  const s = h[name], ny = s.node >= 0 ? g.y[s.node] : y;
  const seenFrom = look.filter((v) => T.sight(v.eye, [x, ny + 1.0, z]) || T.sight(v.eye, [x, ny + 1.6, z])).map((v) => v.name);
  const k = hints.find((q) => q.name === name) ?? {};
  const fn = s.faceNode >= 0 ? `${g.x[s.faceNode].toFixed(1)},${g.z[s.faceNode].toFixed(1)}` : '-';
  console.log(`${name.padEnd(22)} node ${String(s.node).padStart(6)} y ${ny.toFixed(2)} walk ${s.walk}${f?.push ? ' (push)' : ''} spawnT ${s.spawnT} `
    + `face ${deg(s.face)} -> ${fn} face2 ${deg(s.face2)} faceT ${s.faceT}${site ? ` | open ${k.open} sees ${(k.sees ?? []).join('+') || '-'} seenBy ${(k.seenBy ?? []).join('+') || '-'} hiddenAtk ${k.hiddenAtk}` : ''}`
    + `${look.length ? ` | seen from ${seenFrom.join(', ') || 'none'}` : ''}`);
}
