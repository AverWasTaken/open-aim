"""Rank picker on play: every lobby launch of a VALORANT Training drill asks the rank picker first.

Edits the mods ChJ6FlD4.js in place (both paths, kept byte-identical), like tools/loadsafe_patch.py.
Run it after loadsafe_patch.py (order in tools/README.md):

    python -I tools/rankpick_patch.py

ChJ6FlD4.js (HallView), wl(R): the one function every lobby launch of a training drill goes through
(cards, quick start, favourites, records drawer, history, replay "play this", ball view). At its
start it now hands the item to window.__aimPlayGate(item, go) (app/rank-picker.js), which either
calls go(item) at once (no bots, no twin) or opens the picker and calls go(chosen item) from the
tile click, so the fullscreen request in wl still runs inside a user gesture. go re-enters wl with
__aimGo set, and the original body runs unchanged; wl reads only named fields of R, so __aimGo is
never saved anywhere. Without rank-picker.js (window.__aimPlayGate missing) wl works as before.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"__aimPlayGate"
CHJ = [
    (b"function wl(R){document.documentElement.requestFullscreen?.().catch(()=>{}),yt.begin({shareCode:R.shareCode,mapId:R.mapId,title:R.name,",
     b"function wl(R){if(window.__aimPlayGate&&!R.__aimGo){window.__aimPlayGate(R,aimX=>wl({...aimX,__aimGo:1}));return}"
     b"document.documentElement.requestFullscreen?.().catch(()=>{}),yt.begin({shareCode:R.shareCode,mapId:R.mapId,title:R.name,"),
]


def patch(name, patches, marker):
    """Return (paths, patched bytes) for both copies of `name`; writes nothing."""
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raw = open(paths[0], "rb").read()
    for p in paths[1:]:
        if open(p, "rb").read() != raw:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    # Windows checkouts get CRLF (.gitattributes text=auto); patch in LF and convert back.
    crlf = b"\r\n" in raw
    data = raw.replace(b"\r\n", b"\n")
    if marker in data:
        raise SystemExit(f"{name}: already patched (found {marker.decode()})")
    for old, new in patches:
        if data.count(old) != 1:
            raise SystemExit(f"{name}: expected exactly one match for {old[:60]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    if crlf:
        data = data.replace(b"\n", b"\r\n")
    return paths, data


paths, data = patch("ChJ6FlD4.js", CHJ, MARKER)
for p in paths:
    with open(p, "wb") as f:
        f.write(data)
    print("patched", p)
