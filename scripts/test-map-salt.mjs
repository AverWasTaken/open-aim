// Tests for tools/map_salt_patch.py (Corrode MI_RockSalt crystals recoloured from magenta, render only).
// Checks the patched bundle text (both copies identical, inserted code once, unpatched anchor gone,
// node --check passes), runs the inserted expression on fake materials, and runs the patch script on
// temp copies (clean -> same bytes as the repo files; patched -> refuses).
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
const PY = process.platform === "win32" ? "python" : "python3";

const OLD = "const c=a;if(c.isMeshPhysicalMaterial)";
const INSERT = 'c.name==="MI_RockSalt"&&!c.map&&c.color&&c.color.setRGB(.78,.72,.80);';
const NEW = "const c=a;" + INSERT + "if(c.isMeshPhysicalMaterial)";

test("both BiMsX6Xn copies are identical", () => {
  assert.equal(read(COPIES[1]), src);
});

test("the salt recolour is present exactly once and the unpatched anchor is gone", () => {
  assert.equal(count(src, NEW), 1, "patched anchor");
  assert.equal(count(src, INSERT), 1, "inserted code");
  assert.equal(count(src, "MI_RockSalt"), 1, "only one MI_RockSalt reference");
  assert.equal(count(src, OLD), 0, "unpatched anchor");
  // it sits in tU (the map material conversion), before the new material copies the colour
  const i = src.indexOf(NEW);
  assert.ok(src.lastIndexOf("function tU(n){", i) > i - 400, "inside tU");
  assert.ok(src.indexOf("color:c.color,", i) > i, "before the material copies c.color");
  assert.equal(count(src, "vertexColors:c.vertexColors"), 1, "vertex colours untouched");
});

test("both copies pass node --check", () => {
  for (const p of COPIES) {
    const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf-8" });
    assert.equal(r.status, 0, `${p}: ${r.stderr}`);
  }
});

test("the inserted code recolours only MI_RockSalt without a map", () => {
  // eslint-disable-next-line no-new-func
  const run = new Function("a", `const c=a;${INSERT}return c;`);
  const col = () => ({ v: null, setRGB(r, g, b) { this.v = [r, g, b]; return this; } });
  assert.deepEqual(run({ name: "MI_RockSalt", map: null, color: col() }).color.v, [0.78, 0.72, 0.8]);
  assert.equal(run({ name: "MI_RockSalt", map: {}, color: col() }).color.v, null, "textured salt untouched");
  assert.equal(run({ name: "MI_RockSalt_Overlay", map: null, color: col() }).color.v, null, "other names untouched");
  assert.equal(run({ name: "MI_Rock", map: null, color: col() }).color.v, null);
  assert.doesNotThrow(() => run({ name: "MI_RockSalt", map: null }), "no colour: no throw");
});

// ---- the patch script, on temp copies (never the repo files) ----
function tmpMods(text, crlf = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aimsalt-"));
  RELS.forEach((rel, k) => {
    fs.mkdirSync(path.join(tmp, ...rel), { recursive: true });
    fs.writeFileSync(path.join(tmp, ...rel, "BiMsX6Xn.js"), crlf && k === 1 ? text.replace(/\n/g, "\r\n") : text);
  });
  return tmp;
}
const runPatch = (tmp) => spawnSync(PY, ["-I", path.join(ROOT, "tools", "map_salt_patch.py"), "--mods", tmp], { encoding: "utf-8" });

test("patch script: a clean copy patches to exactly the repo bytes, keeping line ends", () => {
  const clean = src.replace(NEW, OLD);
  assert.equal(count(clean, "MI_RockSalt"), 0);
  const tmp = tmpMods(clean, true);
  try {
    const r = runPatch(tmp);
    assert.ok(!r.error, `python not runnable: ${r.error}`);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const rel of RELS) assert.equal(read(path.join(tmp, ...rel, "BiMsX6Xn.js")), src, rel.join("/"));
    const raw1 = fs.readFileSync(path.join(tmp, ...RELS[1], "BiMsX6Xn.js"), "utf8");
    assert.ok(raw1.includes("\r\n"), "CRLF copy keeps CRLF");
    assert.ok(!fs.readFileSync(path.join(tmp, ...RELS[0], "BiMsX6Xn.js"), "utf8").includes("\r\n"), "LF copy keeps LF");
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
