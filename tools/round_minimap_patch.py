"""Round mode minimap markers (R3 S4a): site letters A/B and the spike on the in-game minimap.

Edits the mods copies of OkAdunfX.js in place (both paths, kept byte-identical). Run it after
round_patch.py (it anchors on round_patch's import line; order in tools/README.md):

    python -I tools/round_minimap_patch.py

Refuses to run twice (marker: the /aim-rounds/round-minimap.mjs import) and refuses to run before
round_patch.py. Every match is checked before anything is written. `--mods <dir>` patches another
copy (tests); `--print-pairs` prints the (old, new) pairs as JSON and writes nothing.

The drawing code lives in app/mods/aim-rounds/round-minimap.mjs (header comment = contract). The
data is window.__aimRoundMarks, set by round-visual.mjs only while a round scene runs; it is null
in normal drills, and then every patched spot below does what it did before (the overlay calls are
skipped and the redraw keys get "" appended).

OkAdunfX.js, minimap component (small corner map v(), big map m(), redraw loop I()):
  1. import drawMiniMarks / drawBigMarks / roundMarksKey (inserted before round_patch's
     round-core import, the file's first line);
  2. small map: the bot-overlay block builds its world->screen mapper N (rotation, zoom, centre)
     when there are round marks OR bots, and calls the marker overlay with it before the bots, so
     markers stay upright and bots draw on top. Bots are drawn exactly as before;
  3. small-map redraw key gains roundMarksKey(O) (O = performance.now() already in scope), so a
     spike change redraws the map even while the player stands still;
  4. big-map redraw key gains the same suffix;
  5. big map: marker overlay after the callout labels, before the bots (map image space).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
PRINT_PAIRS = "--print-pairs" in sys.argv
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

ROUND_IMPORT = b"import {roundPrepare as __aimRoundPrepare} from '/aim-rounds/round-core.mjs';"
SMALL_MAPPER = (b"const me=t.rotates?Cl(U,k.yaw):0,se=Math.cos(me),T=Math.sin(me),X=ue*B,"
                b"N=(W,te)=>{const q=Hn(U,W,te),ne=(q.u-ee)*X,ie=(q.v-oe)*X;return[H/2+ne*se-ie*T,H/2+ne*T+ie*se]};")

OKA = [
    # 1. Import.
    (ROUND_IMPORT,
     b"import {drawMiniMarks as __aimMiniMarks,drawBigMarks as __aimBigMarks,roundMarksKey as __aimMarksKey}"
     b" from '/aim-rounds/round-minimap.mjs';" + ROUND_IMPORT),
    # 2. Small map overlay (mapper shared with the bots).
    (b"if(L.restore(),t.showBots&&t.bots){" + SMALL_MAPPER + b"f(L,t.bots,k,N,H/2,D)}",
     b"const __m=window.__aimRoundMarks;if(L.restore(),__m||t.showBots&&t.bots){" + SMALL_MAPPER +
     b"__m&&__aimMiniMarks(L,__m,N,H/2,D),t.showBots&&t.bots&&f(L,t.bots,k,N,H/2,D)}"),
    # 3. Small map redraw key.
    (b"key:E(r.value,t.rotates)+y()+U",
     b"key:E(r.value,t.rotates)+y()+U+__aimMarksKey(O)"),
    # 4. Big map redraw key.
    (b"key:E(u.value,!1)+U",
     b"key:E(u.value,!1)+U+__aimMarksKey(O)"),
    # 5. Big map overlay (after callouts, before bots).
    (b"const H=t.showBots?t.bots:null;if(H){",
     b"const __m2=window.__aimRoundMarks;__m2&&__aimBigMarks(k,__m2,(x,z)=>{const q=Hn(U,x,z);return[q.u*D,q.v*D]},L);"
     b"const H=t.showBots?t.bots:null;if(H){"),
]

PATCHES = {"OkAdunfX.js": OKA}
MARKERS = {"OkAdunfX.js": b"/aim-rounds/round-minimap.mjs"}

if PRINT_PAIRS:
    print(json.dumps({n: [[o.decode("utf-8"), w.decode("utf-8")] for o, w in p] for n, p in PATCHES.items()}))
    sys.exit(0)


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


files = {n: load(n) for n in PATCHES}
for n, marker in MARKERS.items():
    if marker in files[n][2]:
        raise SystemExit(f"{n}: already patched (found {marker.decode()})")
if ROUND_IMPORT not in files["OkAdunfX.js"][2]:
    raise SystemExit("OkAdunfX.js: run tools/round_patch.py first")

out = {n: apply(n, files[n][2], PATCHES[n]) for n in PATCHES}
for n, data in out.items():
    paths, raws, _ = files[n]
    for p, raw in zip(paths, raws):
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(data.replace(b"\n", b"\r\n") if b"\r\n" in raw else data)
        print("patched", p)
