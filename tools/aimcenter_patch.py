"""Crosshair/aim centre alignment and replay option parity, patched into the game scripts in app/mods/.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/hitreg_patch.py. Run it after loadsafe_patch.py and rankpick_patch.py (order in
tools/README.md):

    python -I tools/aimcenter_patch.py

The script refuses to run twice (it looks for its marker __aimCrossAlign). Every match is checked
in every file before anything is written.

1. Crosshair on the aim point (OkAdunfX.js, presentation only, no sim change):
   Shots go through the centre of the 3D projection. The HUD crosshair is a DOM element at
   left/top 50%, and the browser snaps it to a whole device pixel. When the game view has an odd
   size (a maximized 2560x1440 window is 2560x1439 inside) the projection centre is at y=719.5 but
   the crosshair is drawn at y=719, half a pixel (about 0.03 degrees) above where shots go. At
   50-70 m that costs 1-2 head-hit points per 100 first shots. Twice a second (and on every canvas
   resize) the game now measures where the crosshair was really drawn and shifts the camera
   projection by the leftover sub-pixel amount (PerspectiveCamera.setViewOffset), so the aim point
   lands exactly under the crosshair. Even sizes measure 0 and leave the camera untouched. No
   measurement is taken while the ADS crosshair is moved by its follow transform, and offsets over
   1 device pixel are ignored; the last value is kept.

2. Replay resimulation option parity (C_VPDXvn.js):
   Zn (the simple replay resimulator, exported as "e") passed only sensitivity, seed, gait,
   terrain and the bot options to the world, while cs (the replay player) also passes
   zoomSensitivity, recoil, movement and shotTiming. Zn now passes the same four from the replay
   meta (missing = null, the old default), so a run recorded with game recoil/movement resimulates
   the same way in both. No shipped chunk calls Zn today; this keeps the two in step.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]
MARKER = b"__aimCrossAlign"

ALIGN = (
    b"\n/* aim-center (tools/aimcenter_patch.py): put the projection centre (where shots go) under the drawn crosshair */"
    b"const __aimXA={w:-1,h:-1,t:-1e9,dx:0,dy:0};"
    b"function __aimCrossAlign(cam,canvas){"
    b"if(!cam||!cam.isPerspectiveCamera||!canvas)return;"
    b"const now=performance.now(),w=canvas.width,h=canvas.height;"
    b"if(w===__aimXA.w&&h===__aimXA.h&&now-__aimXA.t<500)return;"
    b"__aimXA.t=now;__aimXA.w=w;__aimXA.h=h;"
    b"const el=document.querySelector(\".al-center-crosshair\"),f=el?.parentElement,ft=f?getComputedStyle(f).transform:\"none\";"
    b"if(el&&w>0&&h>0&&(ft===\"none\"||ft===\"matrix(1, 0, 0, 1, 0, 0)\")){"
    b"const c=canvas.getBoundingClientRect(),x=el.getBoundingClientRect();"
    b"if(c.width>0&&c.height>0){const dx=(x.left-(c.left+c.width/2))*w/c.width,dy=(x.top-(c.top+c.height/2))*h/c.height;"
    b"if(Math.abs(dx)<=1&&Math.abs(dy)<=1){__aimXA.dx=Math.abs(dx)<1e-3?0:dx;__aimXA.dy=Math.abs(dy)<1e-3?0:dy}}}"
    b"const v=cam.view;"
    b"if(__aimXA.dx===0&&__aimXA.dy===0){v&&v.enabled&&cam.clearViewOffset();return}"
    b"if(v&&v.enabled&&v.fullWidth===w&&v.fullHeight===h&&v.offsetX===-__aimXA.dx&&v.offsetY===-__aimXA.dy&&v.width===w&&v.height===h)return;"
    b"cam.setViewOffset(w,h,-__aimXA.dx,-__aimXA.dy,w,h)}\n"
)

# (old, new, expected count)
PATCHES = {
    "OkAdunfX.js": [
        (b'const __offsets=__aimADS.offsets(r.camera.aspect||16/9,Qs,t.phase.current==="running");',
         b'const __offsets=__aimADS.offsets(r.camera.aspect||16/9,Qs,t.phase.current==="running");__aimCrossAlign(r.camera,r.canvas);', 1),
    ],
    "C_VPDXvn.js": [
        (b"s=n(e.scene,{sensitivity:e.meta.sensitivity,seed:e.meta.seed,runGait:wt(e.meta),terrain:a,bots:",
         b"s=n(e.scene,{sensitivity:e.meta.sensitivity,seed:e.meta.seed,runGait:wt(e.meta),terrain:a,"
         b"zoomSensitivity:e.meta.zoomSensitivity??null,recoil:e.meta.recoil??null,movement:e.meta.movement??null,"
         b"shotTiming:e.meta.shotTiming??null,bots:", 1),
    ],
}


def load(name):
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raw = open(paths[0], "rb").read()
    for p in paths[1:]:
        if open(p, "rb").read() != raw:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    # Windows checkouts get CRLF (.gitattributes text=auto); patch in LF and convert back.
    return paths, raw, b"\r\n" in raw


files = {}
for name in PATCHES:
    paths, raw, crlf = load(name)
    files[name] = {"paths": paths, "data": raw.replace(b"\r\n", b"\n"), "crlf": crlf}

if MARKER in files["OkAdunfX.js"]["data"]:
    raise SystemExit("already patched (found __aimCrossAlign in OkAdunfX.js)")

for name, patches in PATCHES.items():
    data = files[name]["data"]
    for old, new, count in patches:
        if data.count(old) != count:
            raise SystemExit(f"{name}: expected {count} match(es) for {old[:70]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    files[name]["data"] = data

ok = files["OkAdunfX.js"]["data"]
files["OkAdunfX.js"]["data"] = ok + ALIGN if ok.endswith(b"\n") else ok + b"\n" + ALIGN

for name, f in files.items():
    data = f["data"].replace(b"\n", b"\r\n") if f["crlf"] else f["data"]
    for p in f["paths"]:
        with open(p, "wb") as out:
            out.write(data)
        print("patched", p)
