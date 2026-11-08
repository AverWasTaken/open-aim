"""First-shot stall: warm the muzzle-flash composite passes against the real output target.

The muzzle-flash renderer in `OkAdunfX.js` (both copies) pre-compiles its shaders once in `B()`
(`T.warmScene`), but it drew the light/tone composite passes only into its own offscreen target
`Re`. The real shot draws those passes into the caller's target (`Oe`, usually the canvas), and
three.js keys programs on the target (tone mapping + output colour space differ between a render
target and the canvas), so the first shot still compiled 1-2 programs and stalled.

1. `B()` gets a 6th parameter `__aimOut` (the caller's target) and, after its own warm renders,
   also draws the light and tone passes into `__aimOut ?? null` with the renderer scissor at a
   1x1 pixel and the tone pass's exposure at 0 (the same trick the tracer renderer uses at char
   ~72576). Both passes read a null texture there (B nulls the `tex` uniforms) and output 0:
   light pass blends DstColor/One, tone pass One/OneMinusSrcAlpha with alpha 0, so the pixel is
   unchanged. The caller's `finally` restores target, scissor test, clear colour and autoClear.
   `globalThis.__aimFxWarmN` counts warm runs (a check that it runs a few times, not every frame).
2. The warm re-arms (`y=!0`) whenever `toneMapping|outputColorSpace|target uuid` changes (first
   frame, Enhanced/Original switch, a different output target), stored on the passes object as
   `__aimWarmKey`. Before, `y` was only set when a new flash material appeared.

Render-only: no sim, replay or RNG change.

Usage: python tools/graphics_warm_patch.py   (from the repo root; refuses to run twice)
       python tools/graphics_warm_patch.py --mods <dir>   (patch another copy of app/mods, for tests)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"/* graphics-warm */"

OKA = [
    # 1. B() takes the caller's output target.
    (b"function B(T,X,N,W,te){T.warmScene.clear()",
     b"function B(T,X,N,W,te,__aimOut){" + MARKER + b"globalThis.__aimFxWarmN=(globalThis.__aimFxWarmN|0)+1;T.warmScene.clear()"),
    # 1b. ...and also warms the light/tone passes into it (1x1 renderer scissor, exposure 0).
    (b"X.render(T.lightPass.scene,T.quadCam),X.render(T.tonePass.scene,T.quadCam),N.scissorTest=!1",
     b"X.render(T.lightPass.scene,T.quadCam),X.render(T.tonePass.scene,T.quadCam),N.scissorTest=!1,"
     b"X.setRenderTarget(__aimOut??null),X.setScissorTest(!0),X.setScissor(0,0,1,1),"
     b"T.tonePass.mat.uniforms.exposure.value=0,"
     b"X.render(T.lightPass.scene,T.quadCam),X.render(T.tonePass.scene,T.quadCam),"
     b"T.tonePass.mat.uniforms.exposure.value=1,X.setScissorTest(!1)"),
    # 2. Re-arm on tone mapping / colour space / output target change; pass the target to B().
    (b"y&&(y=!1,B(q,T,Re,W.scene,le))",
     b"q.__aimWarmKey!==(q.__aimWarmKey=T.toneMapping+\"|\"+T.outputColorSpace+\"|\"+(Oe?.uuid??\"null\"))&&(y=!0),"
     b"y&&(y=!1,B(q,T,Re,W.scene,le,Oe))"),
]


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


paths, raws, text = load("OkAdunfX.js")
if MARKER in text:
    raise SystemExit("OkAdunfX.js: already patched (found /* graphics-warm */)")
out = apply("OkAdunfX.js", text, OKA)
for p, raw in zip(paths, raws):
    # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
    with open(p, "wb") as f:
        f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
    print("patched", p)
