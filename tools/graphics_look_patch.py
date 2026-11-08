"""Range drills: tone down the blown-out white floor under Enhanced map lighting.

Render-only (no sim, replay or RNG change). Patches both copies of `BiMsX6Xn.js`.

The shipped range drills (Micro flicks, Drift, strafers...) store the old default light values
(ambient 1.55, key 2.2) but are tagged `lightingVersion: 2`, so the game uses them as raw
multipliers (x1.55 / x2.2 instead of x1 / x1, see `Jt` in D_iGclxB). Non-map scenes have no tone
mapping, so the light grey floor clips to flat white. Target colours look right as they are, so
only the floor changes.

1. `aimLt` (the Enhanced / Original lighting object) gets `look.floor` (floor colour multiplier)
   and two helpers:
   - `floor(env, built, stage)`: called when a built scene is mounted. If the scene has that
     exact signature (no map, lightingVersion 2, ambient 1.55, key 2.2) and a block with id
     `ground` (one mesh), it remembers that mesh and its material for that stage (the game and
     the replay viewer each have their own stage); otherwise it forgets that stage's previous
     one. Stages that were disposed (no children left) are forgotten too.
   - `tint()`: Enhanced: the ground mesh gets its own copy of the material (other blocks of the
     same colour share the cached one) with colour x `look.floor`. Original: the mesh gets the
     game's own material back, untouched. Called by `floor()` and `apply()`, so the lighting
     setting switches live.
2. `apply()` calls `tint()` first.
3. The stage's `mount()` calls `aimLt.floor(<current environment>, <built scene>, <stage scene>)`
   before adding the blocks to the scene.

Both helpers catch their own errors (logged), so a failure can never stop a scene from mounting
or `apply()` from setting tone mapping. Latent: a patterned ground (`surface` set) would keep its
seam colour undimmed; no shipped drill with the signature has one.

Changing only `material.color` keeps three.js's shader program (no recompile, no hitch).
Studio arenas (ambient/key 1/1), official non-map drills (no lightingVersion) and map scenes
don't match the signature and are unchanged; Original lighting is unchanged everywhere.

Marker: /* graphics-look */. A patched file is skipped, a half-patched file is an error, and with
every file already patched the script refuses to run.

Usage: python tools/graphics_look_patch.py   (from the repo root)
       python tools/graphics_look_patch.py --mods <dir>   (patch another copy of app/mods, for tests)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"/* graphics-look */"
FLOOR = b".46"  # floor colour multiplier (linear), Enhanced + legacy-lit range drills only.
# Lit floor today ~1.33 linear (albedo .64 x irradiance 6.53 / pi); x.46 -> ~.61 linear = sRGB ~205.

FILES = {
    "BiMsX6Xn.js": [
        # 1. look.floor + floor()/tint() on aimLt
        (b"look:{sat:1.2,contrast:.25,exposure:1.35,lmScale:1,lmChroma:.6,aniso:4},",
         b"look:{sat:1.2,contrast:.25,exposure:1.35,lmScale:1,lmChroma:.6,aniso:4,floor:" + FLOOR + b"},"),
        (b"seen:new Set,ref:new WeakMap,track(t,g,L){",
         MARKER + b"fl:new Map,"
         b"floor(c,E,S){try{for(const[k]of this.fl)k!==S&&!k.children.length&&this.drop(k);"
         b"const o=this.fl.get(S),g=c&&!c.map&&c.lightingVersion===2&&c.ambientIntensity===1.55&&c.keyLightIntensity===2.2&&E&&E.blocks&&E.blocks.get&&E.blocks.get(\"ground\");"
         b"if(o){if(g===o.mesh)return this.tint();this.drop(S)}"
         b"g&&g.isMesh&&g.material&&g.material.isMaterial&&g.material.color&&this.fl.set(S,{mesh:g,base:g.material,mat:null});this.tint()}"
         b"catch(e){console.error(\"aimLt.floor\",e)}},"
         b"drop(S){const o=this.fl.get(S);o&&o.mat&&(o.mesh.material=o.base,o.mat.dispose());this.fl.delete(S)},"
         b"tint(){try{const e=this.enhanced();for(const f of this.fl.values()){"
         b"if(e){if(!f.mat){const m=f.base.clone();m.onBeforeCompile=f.base.onBeforeCompile;m.customProgramCacheKey=f.base.customProgramCacheKey;f.mat=m;f.mesh.material=m}"
         b"f.mat.color.copy(f.base.color).multiplyScalar(this.look.floor)}"
         b"else if(f.mat){f.mesh.material=f.base;f.mat.dispose();f.mat=null}}}"
         b"catch(e){console.error(\"aimLt.tint\",e)}},"
         b"seen:new Set,ref:new WeakMap,track(t,g,L){"),
        # 2. apply() re-tints (live Enhanced/Original switch)
        (b"apply(){const m=this.sync(),l=this.look,n=this.renderer;Gu.lmScale.value=",
         b"apply(){const m=this.sync(),l=this.look,n=this.renderer;this.tint();Gu.lmScale.value="),
        # 3. mount() hands the built scene + current environment to aimLt
        (b"mount(E){d&&i.remove(d.root),d=E,i.add(E.root),i.fog=E.fog",
         b"mount(E){d&&i.remove(d.root),d=E,aimLt.floor(c,E,i),i.add(E.root),i.fog=E.fog"),
    ],
}


def load(name):
    """Both copies of `name` as (paths, raws, LF text); the copies must match apart from line ends."""
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raws = [open(p, "rb").read() for p in paths]
    text = raws[0].replace(b"\r\n", b"\n")
    for p, r in zip(paths[1:], raws[1:]):
        if r.replace(b"\r\n", b"\n") != text:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    return paths, raws, text


def apply(name, data, patches):
    for old, new in patches:
        if data.count(old) != 1:
            raise SystemExit(f"{name}: expected exactly one match for {old[:70]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    return data


todo = []
for name, patches in FILES.items():
    paths, raws, text = load(name)
    if MARKER in text:
        missing = [new for _, new in patches if text.count(new) != 1]
        if missing:
            raise SystemExit(f"{name}: half patched (marker present, {len(missing)} edit(s) missing); restore the file first")
        print("already patched, skipped", name)
        continue
    todo.append((name, paths, raws, apply(name, text, patches)))
if not todo:
    raise SystemExit("all files already patched (found /* graphics-look */)")
for name, paths, raws, out in todo:
    for p, raw in zip(paths, raws):
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
        print("patched", p)
