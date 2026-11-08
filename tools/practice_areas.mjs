// Practice areas: where you start and where the bots can stand on each map, for Practice mode
// (app/practice-scene.js builds the scenes, app/practice-panel.js lists the areas).
//
//   node tools/practice_areas.mjs           write app/mods/aim-practice/areas.json
//   node tools/practice_areas.mjs --check   exit 1 if the file is not what this script would write
//
// Source: app/mods/aim-ranks/spot-alts.json (tools/spot_alts.mjs). Every entry there is one shipped
// pre-aim drill (easy and hard variants are separate entries). For each entry the drill doc is read
// from site/prod-api/.../scenes/<code> or scenarios/*.json (by item.shareCode).
// - An area is one route: entries are grouped by their cleaned English route name ("简单-DDY's
//   pre-aim: Haven A Long attack (random)" -> "A Long"). Groups with the same player spawn (within
//   0.3 m) whose spots mostly overlap are the same route under two names and are merged.
//   Two different routes with the same name get the nearest English callout (aim-maps minimap) to
//   their spawn added ("A Retake from A Tower").
// - spawn = the drill's player spawn {x,y,z,yaw}; env = that drill's environment (lighting differs per map).
// - spots = the drill's static bot spots (same rule as spot_alts.mjs staticSpots: fixed spawners of
//   humanoids with only shooter/respawn behaviours), authored positions, deduped across the
//   group's drills (0.8 m: two bodies never overlap), sorted by distance from the spawn (practice-scene takes the first N).
//   Spots whose feet are inside a solid non-ground block of their drill are dropped (Practice scenes
//   have no blocks). snap:false when the drill's spawner had groundSnap off.
// - lane = the authored point's checked movement lane [ax,az,min,max] (spot-alts lanes[id][0]),
//   dropped when shorter than 0.6 m or when it comes within 0.7 m of another kept spot or lane (lanes were only checked
//   against the spots of their own drill).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "app", "mods", "aim-practice", "areas.json");
const CHECK = process.argv.includes("--check");

export const MAPS = [
  ["ascent", "Ascent"], ["bonsai", "Split"], ["triad", "Haven"], ["plummet", "Summit"], ["jam", "Lotus"],
  ["infinity", "Abyss"], ["rook", "Corrode"], ["duality", "Bind"], ["juliett", "Sunset"],
];

// Cleaned route name -> final name, per map. Applied before grouping.
const RENAME = {
  "duality:A through Showers": "A Showers",
  "duality:A through A Short": "A Short",
  "triad:Garage Push": "Garage",
  "triad:Mid to Garage": "Garage",
  "rook:A Split through Mid": "Mid to A",
  "jam:A Main": "A Site",
};

// Shortest lane (m) a strafing bot gets; practice-scene swings bots over at most 1.5 m of it.
export const MIN_LANE = 0.6;

const SMALL = new Set(["from", "through", "to", "via", "and", "of"]);
export function cleanName(raw, mapName) {
  let s = String(raw || "");
  s = s.replace(/^\s*(简单|困难)\s*-?\s*/, "");
  s = s.replace(/^DDY's pre-aim:\s*/i, "");
  s = s.replace(new RegExp(`^${mapName}\\b\\s*`, "i"), "");
  s = s.replace(/^[—–-]\s*/, "");
  s = s.replace(/^Pre-aim an?\s+/i, "");
  s = s.replace(/\((random|bots shoot)\)/gi, "");
  s = s.replace(/:?\s*\bpre-aim\b/gi, "");
  s = s.replace(/\battack\b/gi, "");
  s = s.replace(/\s+/g, " ").trim().replace(/[:\-—–]+$/, "").trim();
  s = s.split(" ").map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
  if (/^[ABC]$/.test(s)) s += " Site";
  return s;
}

function staticSpots(doc) {
  if (!doc?.environment?.map || !Array.isArray(doc.spawners) || !Array.isArray(doc.actors)) return [];
  const tm = new Map(doc.actors.map((a) => [a.id, a]));
  const out = doc.spawners.filter((s) => {
    const t = tm.get(s.actorTemplateId);
    return s.kind === "fixed" && s.maxAlive >= 1 && t?.body?.shape === "humanoid" && t.behaviors.length > 0 &&
      t.behaviors.every((b) => b.kind === "shooter" || b.kind === "respawn");
  });
  return out.length >= 5 ? out : [];
}

function loadDocs() {
  const docs = new Map();
  const docOf = (scene) => (typeof scene?.doc === "string" ? JSON.parse(scene.doc) : scene?.doc);
  const dir = path.join(ROOT, "site", "prod-api", "api", "v1", "public", "val", "aimlab", "scenes");
  for (const code of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    try { docs.set(code, docOf(JSON.parse(fs.readFileSync(path.join(dir, code), "utf-8")).data)); } catch {}
  }
  const sdir = path.join(ROOT, "scenarios");
  for (const f of fs.readdirSync(sdir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(sdir, f), "utf-8").replace(/^﻿/, ""));
      if (d?.item?.shareCode && !docs.has(d.item.shareCode)) docs.set(d.item.shareCode, docOf(d.scene));
    } catch {}
  }
  return docs;
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const dxz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// Feet inside a solid block (not the drill's ground plane): the drill's invisible walls are gone in
// Practice, so such a spot would stand where the drill's own geometry was.
function insideBlock(doc, p) {
  for (const b of doc.blocks || []) {
    if (b.shape === "plane" || b.id === "ground" || !b.size || !b.position) continue;
    const r = b.rotationY || 0, dx = p.x - b.position.x, dz = p.z - b.position.z;
    const lx = dx * Math.cos(r) - dz * Math.sin(r), lz = dx * Math.sin(r) + dz * Math.cos(r);
    if (Math.abs(lx) > b.size.x / 2 || Math.abs(lz) > b.size.z / 2) continue;
    const bot = b.position.y - b.size.y / 2, top = b.position.y + b.size.y / 2;
    if (bot < p.y + 1.0 && top > p.y + 0.3) return true;
  }
  return false;
}

// Distance from point q to segment a-b (XZ).
function segDist(q, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z, L = vx * vx + vz * vz;
  const t = L > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.z - a.z) * vz) / L)) : 0;
  return Math.hypot(q.x - (a.x + t * vx), q.z - (a.z + t * vz));
}
const laneEnds = (s) => [{ x: s.x + s.lane[0] * s.lane[2], z: s.z + s.lane[1] * s.lane[2] }, { x: s.x + s.lane[0] * s.lane[3], z: s.z + s.lane[1] * s.lane[3] }];
function segSeg(a0, a1, b0, b1) { return Math.min(segDist(a0, b0, b1), segDist(a1, b0, b1), segDist(b0, a0, a1), segDist(b1, a0, a1)); }

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

export function build() {
  const alts = JSON.parse(fs.readFileSync(path.join(ROOT, "app", "mods", "aim-ranks", "spot-alts.json"), "utf-8"));
  const docs = loadDocs();
  const mapName = Object.fromEntries(MAPS);
  const out = { version: 1, about: "Practice areas per map: player spawn and bot spots (with checked strafe lanes) from the shipped pre-aim drills; made by tools/practice_areas.mjs", maps: {} };
  const report = [];
  for (const [map, name] of MAPS) {
    // 1. Entries -> route groups by cleaned name.
    const groups = new Map();
    for (const key of Object.keys(alts.scenes).sort()) {
      const e = alts.scenes[key];
      if (e.map !== map) continue;
      const code = e.codes.find((c) => docs.has(c));
      if (!code) throw new Error(`no drill doc for spot-alts entry ${key} (${e.codes.join(",")})`);
      const doc = docs.get(code);
      let route = cleanName(e.name, name);
      route = RENAME[`${map}:${route}`] ?? route;
      const spots = [];
      for (const s of staticSpots(doc)) {
        const p = { x: s.position.x, y: s.position.y, z: s.position.z };
        if (insideBlock(doc, p)) continue;
        let lane = e.lanes?.[s.id]?.[0] ?? null;
        if (lane && lane[3] - lane[2] < MIN_LANE) lane = null; // too short to strafe on
        spots.push({ ...p, snap: s.groundSnap !== false, lane: lane ? [r4(lane[0]), r4(lane[1]), r3(lane[2]), r3(lane[3])] : null });
      }
      const ps = doc.playerSpawn;
      const g = groups.get(route) ?? { name: route, members: [] };
      g.members.push({ key, code, env: { ...doc.environment, map }, spawn: { x: ps.position.x, y: ps.position.y, z: ps.position.z, yaw: ps.yaw ?? 0 }, spots });
      groups.set(route, g);
    }
    // 2. Split groups whose members have clearly different spawns (same name, different route).
    let areas = [];
    for (const g of groups.values()) {
      const parts = [];
      for (const m of g.members) {
        const p = parts.find((q) => dxz(q.members[0].spawn, m.spawn) < 1.5);
        if (p) p.members.push(m); else parts.push({ name: g.name, members: [m] });
      }
      areas.push(...parts);
    }
    // 3. Merge areas with the same spawn and mostly shared spots (one route, two names).
    const overlap = (a, b) => {
      const sa = a.members.flatMap((m) => m.spots), sb = b.members.flatMap((m) => m.spots);
      const shared = sa.filter((p) => sb.some((q) => dxz(p, q) < 0.5)).length;
      return shared / Math.max(1, Math.min(sa.length, sb.length));
    };
    for (let i = 0; i < areas.length; i++) for (let j = areas.length - 1; j > i; j--) {
      if (dxz(areas[i].members[0].spawn, areas[j].members[0].spawn) < 0.3 && overlap(areas[i], areas[j]) >= 0.5) {
        const keep = areas[i].name.length <= areas[j].name.length ? areas[i].name : areas[j].name;
        areas[i] = { name: keep, members: [...areas[i].members, ...areas[j].members] };
        areas.splice(j, 1);
      }
    }
    // 4. Same name, different route: add the nearest callout to the spawn.
    let callouts = [];
    try { callouts = JSON.parse(fs.readFileSync(path.join(ROOT, "app", "mods", "aim-maps", `${map}.minimap.json`), "utf-8")).callouts || []; } catch {}
    const nearest = (p) => callouts.filter((c) => /^[\x20-\x7e]+$/.test(c.name)).reduce((b, c) => (!b || dxz(c, p) < dxz(b, p) ? c : b), null)?.name;
    const byName = new Map();
    for (const a of areas) byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
    for (const [n, list] of byName) if (list.length > 1) for (const a of list) {
      const c = nearest(a.members[0].spawn) ?? "Spawn";
      a.name = / from /.test(n) ? `${n} (${c})` : `${n} from ${c}`;
    }
    // 5. Final area: spawn of the first member (sorted by entry key), spots deduped and sorted.
    const result = [];
    for (const a of areas) {
      a.members.sort((p, q) => (p.key < q.key ? -1 : 1));
      const spawn = a.members[0].spawn;
      const spots = [];
      for (const m of a.members) for (const s of m.spots) if (!spots.some((q) => dxz(q, s) < 0.8 && Math.abs(q.y - s.y) < 1)) spots.push({ ...s });
      spots.sort((p, q) => dxz(p, spawn) - dxz(q, spawn) || p.x - q.x || p.z - q.z);
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        if (!s.lane) continue;
        const [e0, e1] = laneEnds(s);
        let bad = false;
        for (let j = 0; j < spots.length && !bad; j++) {
          if (j === i) continue;
          const o = spots[j];
          if (Math.abs(o.y - s.y) > 2) continue;
          if (segDist(o, e0, e1) < 0.7) bad = true;
          else if (j < i && o.lane) { const [o0, o1] = laneEnds(o); if (segSeg(e0, e1, o0, o1) < 0.7) bad = true; }
        }
        if (bad) s.lane = null;
      }
      result.push({
        id: slug(a.name), name: a.name, drills: a.members.map((m) => m.code), env: a.members[0].env,
        spawn: { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw },
        spots: spots.map((s) => {
          const o = { x: s.x, y: s.y, z: s.z };
          if (!s.snap) o.snap = false;
          if (s.lane) o.lane = s.lane;
          return o;
        }),
      });
    }
    result.sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0));
    const ids = new Set();
    for (const a of result) { if (ids.has(a.id)) throw new Error(`${map}: duplicate area id ${a.id}`); ids.add(a.id); }
    out.maps[map] = { name, areas: result };
    report.push(`${name.padEnd(8)} ${result.length} areas: ${result.map((a) => `${a.name} (${a.spots.length} spots, ${a.spots.filter((s) => s.lane).length} lanes)`).join(", ")}`);
  }
  return { out, report };
}

function serialize(out) {
  // One area per line keeps diffs readable.
  const lines = ["{", `  "version": ${out.version},`, `  "about": ${JSON.stringify(out.about)},`, `  "maps": {`];
  const maps = Object.entries(out.maps);
  maps.forEach(([id, m], i) => {
    lines.push(`    ${JSON.stringify(id)}: { "name": ${JSON.stringify(m.name)}, "areas": [`);
    m.areas.forEach((a, j) => lines.push(`      ${JSON.stringify(a)}${j < m.areas.length - 1 ? "," : ""}`));
    lines.push(`    ] }${i < maps.length - 1 ? "," : ""}`);
  });
  lines.push("  }", "}", "");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, report } = build();
  const text = serialize(out);
  if (CHECK) {
    let cur = null;
    try { cur = fs.readFileSync(OUT, "utf-8").replace(/\r\n/g, "\n"); } catch {} // Windows checkouts may give CRLF
    if (cur !== text) { console.log(`FAIL ${path.relative(ROOT, OUT)} is out of date: run node tools/practice_areas.mjs`); process.exit(1); }
    console.log(`ok   ${path.relative(ROOT, OUT)} up to date`);
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
    for (const l of report) console.log(l);
    console.log(`wrote ${path.relative(ROOT, OUT)}`);
  }
}

export { serialize, OUT };
