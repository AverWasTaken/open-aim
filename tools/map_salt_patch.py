"""Corrode (rook): salt crystals in pale salt colour instead of flat magenta.

Render-only (no sim, replay, RNG or scene hash change). Patches both copies of `BiMsX6Xn.js`.

Corrode's glTF material `MI_RockSalt` has no texture and a magenta base colour
([0.485, 0.072, 0.521]), so the salt crystals on the roof ridges (152 nodes, only on rook) showed
as flat magenta blobs. The lavender salt elsewhere is a real texture and is left alone.

In the map material conversion `tU` (glTF material -> the game's own map material), before the
new material copies the colour, a material named exactly `MI_RockSalt` with no colour map gets its
colour set to a pale lilac (linear .78, .72, .80). Vertex colours are not touched (turning them
off made the map look worse).

The script asserts the anchor count (1 per copy) and that `MI_RockSalt` is not in the file yet, so
it refuses to run twice. Keeps each copy's own line ends.

Usage: python tools/map_salt_patch.py   (from the repo root)
       python tools/map_salt_patch.py --mods <dir>   (patch another copy of app/mods, for tests)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

NAME = "BiMsX6Xn.js"
MARKER = b"MI_RockSalt"
OLD = b"const c=a;if(c.isMeshPhysicalMaterial)"
NEW = (b"const c=a;c.name===\"MI_RockSalt\"&&!c.map&&c.color&&c.color.setRGB(.78,.72,.80);"
       b"if(c.isMeshPhysicalMaterial)")

paths = [os.path.join(MODS, d, NAME) for d in DIRS]
raws = [open(p, "rb").read() for p in paths]
text = raws[0].replace(b"\r\n", b"\n")
for p, r in zip(paths[1:], raws[1:]):
    if r.replace(b"\r\n", b"\n") != text:
        raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
if text.count(MARKER) != 0:
    raise SystemExit(f"{NAME}: already patched (found {MARKER.decode()!r} {text.count(MARKER)} time(s)); restore the file first")
if text.count(OLD) != 1:
    raise SystemExit(f"{NAME}: expected exactly one match for {OLD!r}, found {text.count(OLD)}")
out = text.replace(OLD, NEW)
assert out.count(NEW) == 1 and out.count(MARKER) == 1 and out.count(OLD) == 0
for p, raw in zip(paths, raws):
    # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
    with open(p, "wb") as f:
        f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
    print("patched", p)
