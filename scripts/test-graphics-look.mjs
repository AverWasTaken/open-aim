// Tests for tools/graphics_look_patch.py (range-drill floor tint under Enhanced lighting).
// Checks the patched bundle text (both copies identical, every edit present once) and runs the
// patched aimLt object from the bundle against stub three.js objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODS = process.env.AIM_MODS_DIR || path.join(ROOT, "app", "mods");
const COPIES = [path.join(MODS, "next", "js", "BiMsX6Xn.js"), path.join(MODS, "_assets", "r20261021-1", "next", "js", "BiMsX6Xn.js")];
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const src = read(COPIES[0]);
const count = (s, sub) => s.split(sub).length - 1;

test("both BiMsX6Xn copies are identical", () => {
  assert.equal(read(COPIES[1]), src);
});

test("each look patch edit is present exactly once", () => {
  assert.equal(count(src, "/* graphics-look */"), 1, "marker");
  for (const s of [
    "lmChroma:.6,aniso:4,floor:",
    "fl:new Map,floor(c,E,S){",
    "drop(S){",
    "tint(){try{const e=this.enhanced();",
    "apply(){const m=this.sync(),l=this.look,n=this.renderer;this.tint();Gu.lmScale.value=",
    "mount(E){d&&i.remove(d.root),d=E,aimLt.floor(c,E,i),i.add(E.root),i.fog=E.fog",
  ]) assert.equal(count(src, s), 1, s);
  assert.equal(count(src, "mount(E){d&&i.remove(d.root),d=E,i.add(E.root)"), 0, "old mount gone");
});

// ---- run the patched aimLt object ----
function loadAimLt(store) {
  const a = src.indexOf("const aimLt={");
  const b = src.indexOf("};aimLt.sync()", a);
  assert.ok(a >= 0 && b > a, "aimLt object found");
  const body = src.slice(a, b + 2);
  const Gu = { lmScale: { value: 0 }, lmChroma: { value: 0 } };
  const localStorage = { getItem: (k) => store[k] ?? null };
  // eslint-disable-next-line no-new-func
  const lt = new Function("Gu", "Lm", "FA", "Qn", "oL", "localStorage", `${body}return aimLt;`)(Gu, 5, 4, 0, 1, localStorage);
  return lt;
}
class Color {
  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  multiplyScalar(k) { this.r *= k; this.g *= k; this.b *= k; return this; }
}
class Mat {
  constructor(c) { this.isMaterial = true; this.color = new Color(c, c, c); this.disposed = 0; this.onBeforeCompile = () => {}; this.customProgramCacheKey = () => "k"; }
  clone() { const m = new Mat(0); m.color.copy(this.color); return m; }
  dispose() { this.disposed++; }
}
const STAGE = { children: [1] };
const RANGE = { lightingVersion: 2, ambientIntensity: 1.55, keyLightIntensity: 2.2, skyColor: "#111820" };
function built(c = 0.6) {
  const ground = { isMesh: true, material: new Mat(c) };
  const back = { isMesh: true, material: new Mat(0.02) };
  return { ground, back, blocks: new Map([["ground", ground], ["backdrop", back]]) };
}

test("Enhanced range drill: only the ground gets a darker copy of its material", () => {
  const lt = loadAimLt({});
  const k = lt.look.floor;
  assert.ok(k >= 0.3 && k <= 0.7, "floor multiplier in the plausible range [.3,.7]");
  const s = built();
  const base = s.ground.material, backMat = s.back.material;
  lt.floor(RANGE, s, STAGE);
  assert.notEqual(s.ground.material, base, "ground has its own material");
  assert.ok(Math.abs(s.ground.material.color.r - 0.6 * k) < 1e-12);
  assert.equal(base.color.r, 0.6, "cached material untouched");
  assert.equal(s.ground.material.onBeforeCompile, base.onBeforeCompile, "shader hook kept");
  assert.equal(s.ground.material.customProgramCacheKey, base.customProgramCacheKey);
  assert.equal(s.back.material, backMat);
  assert.equal(backMat.color.r, 0.02, "backdrop untouched");
  // mounting the same scene again does not darken twice
  lt.floor(RANGE, s, STAGE);
  assert.ok(Math.abs(s.ground.material.color.r - 0.6 * k) < 1e-12);
});

test("live switch Enhanced -> Original -> Enhanced via apply()", () => {
  const store = {};
  const lt = loadAimLt(store);
  const s = built();
  const base = s.ground.material;
  lt.floor(RANGE, s, STAGE);
  const copy = s.ground.material;
  store["aim-map-lighting"] = "original";
  lt.apply();
  assert.equal(s.ground.material, base, "Original: game material back");
  assert.equal(copy.disposed, 1, "copy freed");
  assert.equal(base.color.r, 0.6);
  delete store["aim-map-lighting"];
  lt.apply();
  assert.notEqual(s.ground.material, base);
  assert.ok(Math.abs(s.ground.material.color.r - 0.6 * lt.look.floor) < 1e-12);
});

test("Original lighting: the range drill floor is never touched", () => {
  const lt = loadAimLt({ "aim-map-lighting": "original" });
  const s = built();
  const base = s.ground.material;
  lt.floor(RANGE, s, STAGE);
  assert.equal(s.ground.material, base);
  assert.equal(base.color.r, 0.6);
});

test("scenes without the legacy signature are unchanged", () => {
  const cases = [
    { lightingVersion: 2, ambientIntensity: 1, keyLightIntensity: 1, studioArenaSize: 40 }, // Studio arena
    { ambientIntensity: 1.55, keyLightIntensity: 2.2 }, // official drill, no lightingVersion
    { ambientIntensity: 6, keyLightIntensity: 1 }, // official grid drill
    { ...RANGE, map: "ascent" }, // map scene
    { ...RANGE, ambientIntensity: 1.5 },
  ];
  for (const env of cases) {
    const lt = loadAimLt({});
    const s = built();
    const base = s.ground.material;
    lt.floor(env, s, STAGE);
    lt.apply();
    assert.equal(s.ground.material, base, JSON.stringify(env));
    assert.equal(base.color.r, 0.6);
  }
  // no ground block / no blocks map
  const lt = loadAimLt({});
  lt.floor(RANGE, { blocks: new Map() }, STAGE);
  lt.floor(RANGE, {}, STAGE);
  lt.floor(RANGE, null, STAGE);
  assert.equal(lt.fl.size, 0);
});

test("next scene: previous copy is freed and the old mesh gets its material back", () => {
  const lt = loadAimLt({});
  const a = built();
  const baseA = a.ground.material;
  lt.floor(RANGE, a, STAGE);
  const copyA = a.ground.material;
  const b = built(0.3);
  lt.floor({ lightingVersion: 2, ambientIntensity: 1, keyLightIntensity: 1 }, b, STAGE);
  assert.equal(copyA.disposed, 1);
  assert.equal(a.ground.material, baseA);
  assert.equal(lt.fl.size, 0);
  const c = built(0.5);
  lt.floor(RANGE, c, STAGE);
  assert.ok(Math.abs(c.ground.material.color.r - 0.5 * lt.look.floor) < 1e-12);
});

test("stages are independent; a disposed stage is forgotten; errors never escape", () => {
  const lt = loadAimLt({});
  const game = { children: [1] }, replay = { children: [1] };
  const a = built(), b = built(0.4);
  lt.floor(RANGE, a, game);
  lt.floor(RANGE, b, replay);
  assert.ok(Math.abs(a.ground.material.color.r - 0.6 * lt.look.floor) < 1e-12, "game floor stays dark");
  assert.ok(Math.abs(b.ground.material.color.r - 0.4 * lt.look.floor) < 1e-12);
  const copyB = b.ground.material;
  replay.children.length = 0; // DU.dispose() -> scene.clear()
  lt.floor(RANGE, a, game);
  assert.equal(lt.fl.size, 1);
  assert.equal(copyB.disposed, 1);
  const bad = { isMesh: true, material: { isMaterial: true, color: new Color(1, 1, 1), clone() { throw new Error("boom"); } } };
  const err = console.error; console.error = () => {};
  try {
    assert.doesNotThrow(() => lt.floor(RANGE, { blocks: new Map([["ground", bad]]) }, { children: [1] }));
    assert.doesNotThrow(() => lt.apply());
  } finally { console.error = err; }
});
