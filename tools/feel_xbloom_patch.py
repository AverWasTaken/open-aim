"""In-game crosshair shows movement and firing error (spread), like VALORANT.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/round_patch.py. Run it after round_patch.py (order in tools/README.md):

    python -I tools/feel_xbloom_patch.py
    python -I tools/feel_xbloom_patch.py --mods <dir>   # testing: patch another copy of app/mods

Refuses to run twice (marker aimErrDeg in CnrSARj_.js, __aimXbloomStep in OkAdunfX.js). Every
match is checked in every file before anything is written. It doesn't touch the audio regions
patched by tools/feel_audio_patch.py, so the two apply in either order.

1. Sim (CnrSARj_.js, nf): a read-only method aimErrDeg() on the object the sim returns:
   {fire, fireRaw, move} in degrees.
   - fireRaw: the firing error the next shot would get now (same call the sim makes when it
     fires: xA(state, gun, stance, zoomed).errDeg). Only with game recoil ("game"/"game2");
     otherwise 0.
   - fire: fireRaw minus the error of a fully recovered gun (fresh qg state, same gun, stance and
     zoom), so the crosshair only shows bloom above the resting error (Vandal rests at 0.25 deg).
   - move: the sim's movement error (n.meDeg, already zoom-adjusted) with game movement
     ("game") and a movable player; otherwise 0.
   - All 0 with perfect accuracy (rules.perfectAccuracy).
   The functions it calls (xA, qg, Vg, Wg, hf, an, yn) only read their arguments and build new
   objects: no RNG draw, no state write, so runs and replays stay identical.
2. Play page (OkAdunfX.js):
   - render loop, next to the crosshairOffset write: adsSight.current.crosshairError =
     {move, fire} in device pixels (the crosshair's own unit), from aimErrDeg() and the camera's
     effective vertical FOV and the canvas CSS height (read at most every 500 ms) times
     devicePixelRatio. Both 0 when the run isn't running;
   - StageCrosshair: the drawn profile is now base (primary or ADS profile, as before) plus a
     per-line extra offset: innerMovementError*innerMovementErrorScale*move +
     innerFiringError*innerFiringErrorScale*fire (same for outer), rounded to 0.5 px, the line's
     total offset capped at 60 px. The extras are refs that change only when the rounded value
     changes, so a still crosshair never re-renders. With both extras 0 the base profile object is
     drawn as before.
   Not modelled: fadeWithFiringError and overrideErrorOffset (left as they are).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

CNR_MARKER = b"aimErrDeg"
OKA_MARKER = b"__aimXbloomStep"

CNR = [
    # Read-only error accessor, first method of the sim object.
    (b"return{get tick(){return U},",
     b"return{get tick(){return U},"
     b"aimErrDeg(){if(O)return{fire:0,fireRaw:0,move:0};"
     b"const aimXm=A.rules.playerMovable&&Q?Math.max(0,n.meDeg??0):0;let aimXf=0,aimXr=0;"
     b"if(B){const aimXz=N();if(aimXz){const aimXv=rD(),aimXa=f();"
     b"aimXr=UD(aimXz.state,aimXz.gun,aimXv,aimXa).errDeg;"
     b"aimXf=Math.max(0,aimXr-UD(Rg(aimXz.gun,aimXv,aimXa),aimXz.gun,aimXv,aimXa).errDeg)}}"
     b"return{fire:aimXf,fireRaw:aimXr,move:aimXm}},"),
]

OKA = [
    # Render loop: error in device px next to the crosshair offset.
    (b"__aimCrossAlign(r.camera,r.canvas);t.adsSight.current.crosshairOffset=__offsets.crosshair;",
     b"__aimCrossAlign(r.camera,r.canvas);t.adsSight.current.crosshairOffset=__offsets.crosshair;"
     b"t.adsSight.current.crosshairError=__aimXbloomErr(de,r.camera,r.canvas,t.phase.current===\"running\");"),
    # StageCrosshair: base profile + per-line extra offset.
    (b"s=Ft(\"primary\"),a=ye(()=>s.value===\"ads\"?Qd(n.crosshair):n.crosshair);let o=0;"
     b"function r(){const c=n.view?.current.crosshair??\"primary\";c!==s.value&&(s.value=c);",
     b"s=Ft(\"primary\"),__aimXbBase=ye(()=>s.value===\"ads\"?Qd(n.crosshair):n.crosshair),__aimXi=Ft(0),__aimXo=Ft(0),"
     b"a=ye(()=>{const b=__aimXbBase.value,xi=__aimXi.value,xo=__aimXo.value;"
     b"return xi||xo?{...b,innerOffset:b.innerOffset+xi,outerOffset:b.outerOffset+xo}:b});let o=0;"
     b"function r(){const c=n.view?.current.crosshair??\"primary\";c!==s.value&&(s.value=c);"
     b"__aimXbloomStep(__aimXbBase.value,c===\"sniper\"?null:n.view?.current.crosshairError,__aimXi,__aimXo);"),
]

OKA_TAIL = b"""
const __aimXB={t:-1e9,h:0},__aimXB0={move:0,fire:0};
function __aimXbloomErr(sim,cam,canvas,running){const e=running&&sim&&typeof sim.aimErrDeg==="function"?sim.aimErrDeg():null;if(!e||!cam||!canvas||!(e.fire>0||e.move>0))return __aimXB0;const now=performance.now();if(now-__aimXB.t>=500||!(__aimXB.h>0)){__aimXB.t=now;const dpr=globalThis.devicePixelRatio||1;__aimXB.h=canvas.clientHeight>0?canvas.clientHeight*dpr:canvas.height}const fov=typeof cam.getEffectiveFOV==="function"?cam.getEffectiveFOV():cam.fov,t=Math.tan(fov*Math.PI/360);if(!(t>0)||!(__aimXB.h>0))return __aimXB0;const k=__aimXB.h/2/t,px=d=>d>0?k*Math.tan(Math.min(d,80)*Math.PI/180):0;return{move:px(e.move),fire:px(e.fire)}}
function __aimXbloomLine(p,e,mv,mvs,fr,frs,off){if(!e)return 0;const x=(p[mv]?(e.move||0)*(+p[mvs]||0):0)+(p[fr]?(e.fire||0)*(+p[frs]||0):0);if(!(x>0))return 0;return Math.max(0,Math.min(Math.round(x*2)/2,60-(+p[off]||0)))}
function __aimXbloomStep(p,e,ri,ro){const xi=p?__aimXbloomLine(p,e,"innerMovementError","innerMovementErrorScale","innerFiringError","innerFiringErrorScale","innerOffset"):0,xo=p?__aimXbloomLine(p,e,"outerMovementError","outerMovementErrorScale","outerFiringError","outerFiringErrorScale","outerOffset"):0;xi!==ri.value&&(ri.value=xi);xo!==ro.value&&(ro.value=xo)}
"""

# app/main.js rewrites these OkAdunfX strings while serving it; they must stay exactly once.
MAIN_JS_STRINGS = [b"const ce=hs(de);for(const xe of Cn)", b"xe.kind===\"shot\"&&(Kt.push(xe.tick*ve)"]


def load(name):
    """Both copies of `name` as (paths, raws, LF text); the copies must match apart from line ends."""
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raws = [open(p, "rb").read() for p in paths]
    text = raws[0].replace(b"\r\n", b"\n")
    for p, r in zip(paths[1:], raws[1:]):
        if r.replace(b"\r\n", b"\n") != text:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    return paths, raws, text


def apply(name, data, patches, tail=b""):
    for old, new in patches:
        if data.count(old) != 1:
            raise SystemExit(f"{name}: expected exactly one match for {old[:70]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    if tail:
        if not data.endswith(b"\n"):
            data += b"\n"
        data += tail.lstrip(b"\n")
    return data


files = {n: load(n) for n in ("CnrSARj_.js", "OkAdunfX.js")}
if CNR_MARKER in files["CnrSARj_.js"][2]:
    raise SystemExit("CnrSARj_.js: already patched (found aimErrDeg)")
if OKA_MARKER in files["OkAdunfX.js"][2]:
    raise SystemExit("OkAdunfX.js: already patched (found __aimXbloomStep)")

out = {
    "CnrSARj_.js": apply("CnrSARj_.js", files["CnrSARj_.js"][2], CNR),
    "OkAdunfX.js": apply("OkAdunfX.js", files["OkAdunfX.js"][2], OKA, OKA_TAIL),
}
for s in MAIN_JS_STRINGS:
    if out["OkAdunfX.js"].count(s) != 1:
        raise SystemExit(f"OkAdunfX.js: app/main.js string {s!r} no longer found exactly once")
for n, data in out.items():
    paths, raws, _ = files[n]
    for p, raw in zip(paths, raws):
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(data.replace(b"\n", b"\r\n") if b"\r\n" in raw else data)
        print("patched", p)
