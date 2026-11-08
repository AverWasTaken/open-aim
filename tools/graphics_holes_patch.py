"""Bullet holes from a fixed pool (graphics wave 1). Run after tools/graphics_fx_patch.py:

    python -I tools/graphics_holes_patch.py

Edits the bullet hole renderer l1 in the mods OkAdunfX.js (both copies, kept byte-identical).
Refuses to run twice (marker __aimHoleFree). Every anchor's count is checked first.

Before: every hole made a new Mesh + MeshBasicMaterial (+ Color) and disposed the material when it
faded out, with no cap. After: at most 64 hole meshes ever exist, each with its own material (so
look, tint, fade and draw order are exactly as before). An expired hole goes back to a free list;
a new hole takes a free mesh, else makes one while fewer than 64 exist, else reuses the oldest
live hole. On reuse the material gets the hole's colour, opacity 1 and the current texture (the
canvas stand-in is swapped for the loaded hole texture once it arrives, as new holes did before).
clear() keeps the meshes for the next run; dispose() frees them. warmUp() is unchanged.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"__aimHoleFree"
LIMIT = 64

OKA = [
    # expire: back to the free list instead of disposing the material
    (b"h=p=>{e.remove(p.mesh),p.mesh.material.dispose()},d=()=>{for(const p of r)h(p);r=[]};",
     b"__aimHoleFree=[],h=p=>{e.remove(p.mesh),__aimHoleFree.push(p.mesh)},d=()=>{for(const p of r)h(p);r=[]};"),
    # spawn: take a pooled mesh (free, new while < LIMIT, else the oldest live hole)
    (b'const C=m.look==="tinted"?new dt(m.tint):new dt(bl),E=new mt(o(),i(C));',
     b"let E;if(__aimHoleFree.length)E=__aimHoleFree.pop();"
     b"else if(r.length+__aimHoleFree.length<" + str(LIMIT).encode() + b")E=new mt(o(),i(new dt(bl)));"
     b"else{const q=r.shift();e.remove(q.mesh),E=q.mesh}"
     b'E.material.map!==n&&(E.material.map=n),E.material.opacity=1,E.material.color.set(m.look==="tinted"?m.tint:bl);'),
    # dispose: free the pooled materials too
    (b"dispose(){d(),a?.dispose(),a=null,n.dispose(),s!==n&&s.dispose()}",
     b"dispose(){d();for(const q of __aimHoleFree)q.material.dispose();__aimHoleFree.length=0,"
     b"a?.dispose(),a=null,n.dispose(),s!==n&&s.dispose()}"),
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


def main():
    paths, raws, text = load("OkAdunfX.js")
    if MARKER in text:
        raise SystemExit("OkAdunfX.js: already patched (found __aimHoleFree)")
    if b"__aimFxBoot" not in text:
        raise SystemExit("OkAdunfX.js: run tools/graphics_fx_patch.py first")
    start = text.find(b"function l1(e,t){")
    end = text.find(b"const Zl=", start)
    if text.count(b"function l1(e,t){") != 1 or end < 0:
        raise SystemExit("OkAdunfX.js: bullet hole renderer l1 not found")
    body = text[start:end]
    for old, _ in OKA:
        if text.count(old) != 1 or body.count(old) != 1:
            raise SystemExit(f"OkAdunfX.js: expected exactly one match in l1 for {old[:70]!r}, found {text.count(old)}")
    for old, new in OKA:
        body = body.replace(old, new)
    out = text[:start] + body + text[end:]
    for p, raw in zip(paths, raws):
        with open(p, "wb") as f:
            f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
        print("patched", p)


if __name__ == "__main__":
    main()
