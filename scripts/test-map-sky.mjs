// Tests for tools/map_sky_patch.py (daytime sky colour per map, render only).
// Checks the patched bundle text (both copies identical, every edit present once, old code gone),
// runs the patched aimSky object from the bundle, checks every shipped map has a sky, and runs the
// patch script on temp copies (clean -> same bytes as the repo files; patched -> refuses).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODS = process.env.AIM_MODS_DIR || path.join(ROOT, "app", "mods");
const RELS = [["next", "js"], ["_assets", "r20261021-1", "next", "js"]];
const COPIES = RELS.map((r) => path.join(MODS, ...r, "BiMsX6Xn.js"));
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const src = read(COPIES[0]);
const count = (s, sub) => s.split(sub).length - 1;
const HEX = /^#[0-9a-f]{6}$/i;
const PY = process.platform === "win32" ? "python" : "python3";

const EDITS = [
  ["function DU(n,e){", "function DU(n,e){"], // anchor kept, aimSky goes right before it
  ["i.background=new _e(n.environment.skyColor),", "i.background=new _e(aimSky.pick(n.environment)),"],
  ["A(),i.background=new _e(E.skyColor)}", "A(),i.background=new _e(aimSky.pick(E))}"],
];

test("both BiMsX6Xn copies are identical", () => {
  assert.equal(read(COPIES[1]), src);
});

test("each sky edit is present exactly once and the old background code is gone", () => {
  assert.equal(count(src, "/* maps-sky */"), 1, "marker");
  assert.equal(count(src, "/* maps-sky */const aimSky={t:{"), 1, "aimSky object");
  assert.equal(count(src, "}}};function DU(n,e){"), 1, "aimSky sits right before DU");
  for (const [, now] of EDITS.slice(1)) assert.equal(count(src, now), 1, now);
  for (const [old] of EDITS.slice(1)) assert.equal(count(src, old), 0, `old ${old}`);
  // fog keeps the scene's own colour
  assert.equal(count(src, "new KA(new _e(n.environment.skyColor).getHex(),n.environment.fogNear"), 1, "fog untouched");
  // nothing else reads the picker or the override
  assert.equal(count(src, "aimSky.pick("), 2);
  assert.equal(count(src, "__aimMapSky"), 1);
});

// ---- run the patched aimSky object ----
function loadAimSky(win) {
  const a = src.indexOf("const aimSky={");
  const b = src.indexOf("};function DU(n,e){", a);
  assert.ok(a >= 0 && b > a, "aimSky object found");
  // eslint-disable-next-line no-new-func
  return new Function("window", `${src.slice(a, b + 2)}return aimSky;`)(win);
}

test("table: valid colours, no white or near-black, plausibly blue", () => {
  const sky = loadAimSky(undefined);
  for (const [map, c] of Object.entries(sky.t)) {
    assert.match(c, HEX, map);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    assert.ok(b > r && b > g, `${map} ${c} is blue-ish`);
    assert.ok(Math.max(r, g, b) <= 0xe0, `${map} ${c} not blown-out white`);
    assert.ok(Math.max(r, g, b) >= 0x40, `${map} ${c} not night-black`);
  }
});

test("the bundle table matches SKY in tools/map_sky_patch.py", () => {
  const py = fs.readFileSync(path.join(ROOT, "tools", "map_sky_patch.py"), "utf8");
  const block = py.match(/^SKY = \{([\s\S]*?)^\}/m);
  assert.ok(block, "SKY block in the script");
  const want = Object.fromEntries([...block[1].matchAll(/"([a-z]+)":\s*"(#[0-9a-f]{6})"/g)].map((m) => [m[1], m[2]]));
  assert.ok(Object.keys(want).length >= 5);
  assert.deepEqual({ ...loadAimSky(undefined).t }, want);
});

test("every shipped map has a sky entry", () => {
  const sky = loadAimSky(undefined);
  const maps = new Set();
  const mapsJson = path.join(MODS, "aim-maps", "maps.json");
  if (fs.existsSync(mapsJson)) {
    const j = JSON.parse(fs.readFileSync(mapsJson, "utf8"));
    for (const m of Array.isArray(j) ? j : j.maps || []) if (m && m.id) maps.add(m.id);
  }
  const ts = path.join(ROOT, "app", "training-set.json");
  if (fs.existsSync(ts)) {
    for (const s of Object.values(JSON.parse(fs.readFileSync(ts, "utf8")).scenes)) {
      const m = JSON.parse(s.doc).environment?.map;
      if (m) maps.add(m);
    }
  }
  assert.ok(maps.size >= 5, `found the map list (${[...maps]})`);
  for (const m of maps) assert.ok(HEX.test(sky.t[m] || ""), `sky for ${m}`);
});

test("pick: map scenes get the table colour, whatever the scene's own sky", () => {
  const sky = loadAimSky({});
  assert.equal(sky.pick({ map: "rook", skyColor: "#ffffff" }), sky.t.rook);
  assert.equal(sky.pick({ map: "infinity", skyColor: "#111820" }), sky.t.infinity);
  assert.equal(sky.pick({ map: "triad", skyColor: "#33659e" }), sky.t.triad);
  // no window at all (e.g. a worker) still works
  assert.equal(loadAimSky(undefined).pick({ map: "ascent", skyColor: "#111820" }), sky.t.ascent);
});

test("pick: non-map scenes keep their own sky (range drills, Studio arenas)", () => {
  const sky = loadAimSky({ __aimMapSky: { rook: "#123456" } });
  assert.equal(sky.pick({ skyColor: "#111820" }), "#111820");
  assert.equal(sky.pick({ map: "", skyColor: "#abcdef" }), "#abcdef");
  assert.equal(sky.pick({ map: null, skyColor: "#abcdef", studioArenaSize: 40 }), "#abcdef");
  assert.equal(sky.pick({ map: "nomap", skyColor: "#010203" }), "#010203", "unknown map");
  for (const m of ["__proto__", "constructor", "toString", "hasOwnProperty"]) assert.equal(sky.pick({ map: m, skyColor: "#010203" }), "#010203", m);
});

test("pick: window.__aimMapSky overrides one map; bad values fall back to the scene sky", () => {
  const win = { __aimMapSky: { rook: "#4A80C0" } };
  const sky = loadAimSky(win);
  assert.equal(sky.pick({ map: "rook", skyColor: "#ffffff" }), "#4A80C0");
  assert.equal(sky.pick({ map: "duality", skyColor: "#ffffff" }), sky.t.duality, "other maps still use the table");
  win.__aimMapSky = { rook: "blue" };
  assert.equal(sky.pick({ map: "rook", skyColor: "#ffffff" }), "#ffffff");
  win.__aimMapSky = { rook: 123 };
  assert.equal(sky.pick({ map: "rook", skyColor: "#ffffff" }), "#ffffff");
  win.__aimMapSky = null;
  assert.equal(sky.pick({ map: "rook", skyColor: "#ffffff" }), sky.t.rook);
  win.__aimMapSky = "junk";
  assert.equal(sky.pick({ map: "rook", skyColor: "#ffffff" }), sky.t.rook);
});

test("pick never throws", () => {
  const throwing = {};
  Object.defineProperty(throwing, "__aimMapSky", { get() { throw new Error("boom"); } });
  const sky = loadAimSky(throwing);
  assert.equal(sky.pick({ map: "rook", skyColor: "#ffffff" }), "#ffffff");
  assert.equal(sky.pick(undefined), undefined);
  assert.equal(sky.pick(null), null);
  assert.equal(loadAimSky({}).pick(undefined), undefined);
});

// ---- the patch script, on temp copies (never the repo files) ----
function tmpMods(text) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aimsky-"));
  RELS.forEach((rel) => {
    fs.mkdirSync(path.join(tmp, ...rel), { recursive: true });
    fs.writeFileSync(path.join(tmp, ...rel, "BiMsX6Xn.js"), text);
  });
  return tmp;
}
const runPatch = (tmp) => spawnSync(PY, ["-I", path.join(ROOT, "tools", "map_sky_patch.py"), "--mods", tmp], { encoding: "utf-8" });

test("patch script: a clean copy patches to exactly the repo bytes", () => {
  const a = src.indexOf("/* maps-sky */");
  const b = src.indexOf("function DU(n,e){", a);
  let clean = src.slice(0, a) + src.slice(b);
  for (const [old, now] of EDITS.slice(1)) clean = clean.replace(now, old);
  assert.equal(count(clean, "aimSky"), 0);
  const tmp = tmpMods(clean);
  try {
    const r = runPatch(tmp);
    assert.ok(!r.error, `python not runnable: ${r.error}`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const rel of RELS) assert.equal(read(path.join(tmp, ...rel, "BiMsX6Xn.js")), src, rel.join("/"));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("patch script refuses to run twice and writes nothing", () => {
  const tmp = tmpMods(src);
  try {
    const r = runPatch(tmp);
    assert.ok(!r.error, `python not runnable: ${r.error}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /already patched/);
    for (const rel of RELS) assert.equal(read(path.join(tmp, ...rel, "BiMsX6Xn.js")), src);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
