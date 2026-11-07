"""Texture leaks on retry: free the PMREM render target and removed bots' bone textures.

Render-only (no sim, replay or RNG change). Patches both copies of each bundle.

1. `BiMsX6Xn.js`: the map environment map is made by `aL()` with PMREMGenerator
   `fromEquirectangular()`, which returns a render target; only its `.texture` was kept, and the
   lighting rig's `dispose()` freed just that texture, so the target (framebuffer + depth buffer)
   leaked once per drill start/retry. The texture now keeps its target as `__aimRT`, and
   `dispose()` frees the target first, then the texture. Only `scene.environment` holds the
   texture besides the rig, and the rig is disposed when the scene is replaced.
2. `CnrSARj_.js`: actor removal in the actor renderer `Uf` (`M=`, used by `clear()` and when an
   actor leaves) disposed the part materials but never the skeleton, so each humanoid's bone
   texture leaked (~7 per Ascent retry). Every humanoid builds its own skeleton (`Lo()`); spheres
   have `skin: null`. A removed mesh is no longer drawn, so three.js won't recreate the texture.

Each file has its own marker: a file that is already patched is skipped, a half-patched file is
an error. With every file already patched the script refuses to run.

Usage: python tools/graphics_leak_patch.py   (from the repo root)
       python tools/graphics_leak_patch.py --mods <dir>   (patch another copy of app/mods, for tests)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"/* graphics-leak */"

FILES = {
    "BiMsX6Xn.js": [
        # 1. keep the PMREM render target on the returned texture
        (b"const o=a.fromEquirectangular(s);return s.dispose(),a.dispose(),o.texture}",
         b"const o=a.fromEquirectangular(s);return s.dispose(),a.dispose(),o.texture.__aimRT=o" + MARKER + b",o.texture}"),
        # 1b. the lighting rig frees the target, then the texture
        (b"dispose(){g?.dispose(),p?.dispose()}",
         b"dispose(){g&&(g.__aimRT?.dispose(),g.dispose()),p?.dispose()}"),
    ],
    "CnrSARj_.js": [
        # 2. removed actors free their skeleton's bone texture
        (b"M=s=>{for(const Y of s.mesh.parts)Y.material.dispose();A.root.remove(s.mesh.root)}",
         b"M=s=>{for(const Y of s.mesh.parts)Y.material.dispose();" + MARKER + b"s.mesh.skin?.skeleton?.dispose();A.root.remove(s.mesh.root)}"),
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
    raise SystemExit("all files already patched (found /* graphics-leak */)")
for name, paths, raws, out in todo:
    for p, raw in zip(paths, raws):
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
        print("patched", p)
