"""Map scenes: a daytime sky colour per map instead of the scene's own sky colour.

Render-only (no sim, replay, RNG or scene hash change). Patches both copies of `BiMsX6Xn.js`.

The sky (three.js `scene.background`) came from each scene's `environment.skyColor`, so the same
map looked different per drill: Corrode (rook), Bind (duality) and Sunset (juliett) scenes
mostly use #ffffff (blown-out white horizon), Abyss (infinity), Summit (plummet), Split (bonsai)
and Ascent scenes #111820 (night navy over midday light). Now a scene with a known
`environment.map` uses that map's colour from one table, whichever drill, practice area or round
loaded it.

1. Before the stage factory `DU` it adds `aimSky`: the table `t` (map id -> #rrggbb) and
   `pick(env)`, which returns `window.__aimMapSky[map]` (a live override for tuning, e.g. over
   CDP) or `t[map]`, if that is a valid `#rrggbb` string; otherwise the scene's own `skyColor`.
   Any error also falls back to `skyColor`.
2. `DU` (stage creation) sets `background` from `aimSky.pick(n.environment)`.
3. `applyEnvironment` (scene switch) sets `background` from `aimSky.pick(E)`.

Fog colour still uses the scene's `skyColor` (fog is off in every shipped scene). Range drills
and Studio arenas without a map keep their own sky; a Studio drill on a map gets the map's sky.
The override is read when a stage is created or its environment applied, so after changing
`window.__aimMapSky` reload the drill to see it.

Marker: /* maps-sky */. A patched file is skipped, a half-patched file is an error, and with every
file already patched the script refuses to run.

Usage: python tools/map_sky_patch.py   (from the repo root)
       python tools/map_sky_patch.py --mods <dir>   (patch another copy of app/mods, for tests)
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"/* maps-sky */"
# Map id -> sky colour (sRGB hex). Daytime blues; triad's own scene colour was the reference.
# rook/duality/juliett: #2f5f96 read close to evening in the hp shots; #4a7fbf looks like day and
# still sets off their pale walls.
SKY = {
    "ascent": "#2c5689",
    "bonsai": "#3f73ad",
    "duality": "#4a7fbf",
    "infinity": "#3f73ad",
    "jam": "#3f73ad",
    "juliett": "#4a7fbf",
    "plummet": "#3f73ad",
    "rook": "#4a7fbf",
    "triad": "#33659e",
}
for k, v in SKY.items():
    assert re.fullmatch(r"[a-z]+", k) and re.fullmatch(r"#[0-9a-f]{6}", v), (k, v)
TABLE = ("{" + ",".join(f'{k}:"{v}"' for k, v in SKY.items()) + "}").encode()

AIMSKY = (MARKER + b"const aimSky={t:" + TABLE + b","
          b"pick(E){try{const m=E&&E.map,o=typeof window<\"u\"&&window.__aimMapSky,v=m&&(o&&o[m]||this.t[m]);"
          b"return typeof v==\"string\"&&/^#[0-9a-f]{6}$/i.test(v)?v:E.skyColor}catch{return E&&E.skyColor}}};")

FILES = {
    "BiMsX6Xn.js": [
        # 1. the per-map sky table + picker, right before the stage factory
        (b"function DU(n,e){", AIMSKY + b"function DU(n,e){"),
        # 2. stage creation
        (b"i.background=new _e(n.environment.skyColor),",
         b"i.background=new _e(aimSky.pick(n.environment)),"),
        # 3. applyEnvironment (scene switch)
        (b"A(),i.background=new _e(E.skyColor)}",
         b"A(),i.background=new _e(aimSky.pick(E))}"),
    ],
}
NEW_NAMES = [b"aimSky", b"__aimMapSky", MARKER]


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
    for n in NEW_NAMES:
        if n in data:
            raise SystemExit(f"{name}: {n!r} already present before patching")
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
    raise SystemExit("all files already patched (found /* maps-sky */)")
for name, paths, raws, out in todo:
    for p, raw in zip(paths, raws):
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
        print("patched", p)
