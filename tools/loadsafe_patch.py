"""Map loading: a collision worker that never answers can't hang the load, plus stage logs.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/bot_patch.py. Run it after hitreg_patch.py (order in tools/README.md):

    python -I tools/loadsafe_patch.py

BiMsX6Xn.js, kF (builds a map's collision in the module worker /assets/C-Ox_Jol.js):
  * The game waited for the worker's "done" with no time limit. Now it gives up after 60 s, or at
    once on onerror / onmessageerror / a "failed" reply, terminates the worker and builds the
    collision on the main thread (DF) instead, with a console warning.
  * kF hands the triangle arrays to the worker (transfer), which empties the main thread's copies.
    The fallback therefore re-extracts them from the map's pre-merge geometry (oF, through a
    callback from the caller cU), so the fallback map has full collision.
  * console.info "[aim-load] ..." lines with timings at each map-load stage: files fetched (collision
    json, model, ropes, surfaces), terrain hash (MF), worker ready, collision built (worker or main
    thread), collision ready.

ChJ6FlD4.js (HallView, lazy import of the trainer chunk Hwnlm6zD.js): the game already retries
that import (once with a cache-busting URL, then twice more 0.8 s and 1.6 s apart, 30 s timeout).
This only adds console warnings when an attempt fails, so a stuck "Downloading trainer" shows why.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

BIMSX = [
    (b"const QF=4e3;",
     b'function aimLoadLog(s,t0){console.info("[aim-load] "+s+(t0!==void 0?" ("+Math.round(performance.now()-t0)+" ms)":""))}'
     b"const aimWorkerTimeout=6e4;const QF=4e3;"),
    # Worker build with a time limit; on any failure, rebuild the arrays (aimRb) and use DF.
    (b"async function kF(n,e,t,i){const r=await GF();if(!r)return DF(n,e,t,i);try{return await new Promise((s,a)=>{",
     b"async function kF(n,e,t,i,aimRb){const aimT0=performance.now(),r=await GF();"
     b'aimLoadLog(r?"collision worker ready":"collision worker unavailable, building on the main thread",aimT0);'
     b"if(!r)return DF(n,e,t,i);let aimTo;try{return await new Promise((s,a)=>{"
     b'aimTo=setTimeout(()=>a(new Error("no answer in "+aimWorkerTimeout/1e3+" s")),aimWorkerTimeout),'
     b'r.onmessageerror=()=>a(new Error("unreadable message from the worker")),'),
    (b"c=[e.buffer];t&&t.buffer!==e.buffer&&c.push(t.buffer),r.postMessage(o,c)})}finally{r.terminate()}}",
     b"c=[e.buffer];t&&t.buffer!==e.buffer&&c.push(t.buffer),r.postMessage(o,c)})"
     b'.then(aimV=>(aimLoadLog("collision built in the worker",aimT0),aimV))}'
     b"catch(aimE){if(!aimRb)throw aimE;clearTimeout(aimTo),r.terminate();"
     b'console.warn("[aim-load] collision worker failed ("+(aimE?.message??aimE)+"); building on the main thread");'
     b'const aimT1=performance.now(),aimL=aimRb(),aimV=DF(n,aimL.walk,aimL.cable,i);return aimLoadLog("collision built on the main thread",aimT1),aimV}'
     b"finally{clearTimeout(aimTo),r.terminate()}}"),
    (b"f=await kF(r,l.walk,l.cable,a);", b"f=await kF(r,l.walk,l.cable,a,()=>oF(o,r,c));"),
    # Stage logs in cU (map collision load).
    (b"if(t)return t;const i=Promise.all([ls(Nv(n)).then(applyMapCollisionFixes),",
     b'if(t)return t;const aimT0=performance.now();aimLoadLog("map "+n+": loading collision, model, ropes, surfaces");'
     b"const i=Promise.all([ls(Nv(n)).then(applyMapCollisionFixes),"),
    (b'.then(async([r,,s,a])=>{cA("collision",null);', b'.then(async([r,,s,a])=>{cA("collision",null);aimLoadLog("map "+n+": files ready",aimT0);'),
    (b"u=await MF(r,l,c,a).catch(h=>null),", b'u=await MF(r,l,c,a).catch(h=>null),aimH=aimLoadLog("map "+n+": terrain hash done",aimT0),'),
    (b"const A=c?{...f,ropes:c}:f;", b'aimLoadLog("map "+n+": collision ready",aimT0);const A=c?{...f,ropes:c}:f;'),
]

CHJ = [
    (b".catch(async R=>{const z=await Zc(R);return window.__cancelAssetRecovery__?.(),z})",
     b'.catch(async R=>{console.warn("[aim-load] trainer download failed, retrying with a fresh URL:",R?.message??R);'
     b"const z=await Zc(R);return window.__cancelAssetRecovery__?.(),z})"),
    (b"onError(R,z,pe,Ge){if(Ge<=nF){setTimeout(z,Ge*800);return}",
     b'onError(R,z,pe,Ge){console.warn("[aim-load] trainer load failed (attempt "+Ge+"):",R?.message??R);if(Ge<=nF){setTimeout(z,Ge*800);return}'),
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


# Check every file before writing any, so a failed match leaves nothing half-patched.
jobs = [patch("BiMsX6Xn.js", BIMSX, b"aimLoadLog"), patch("ChJ6FlD4.js", CHJ, b"[aim-load]")]
for paths, data in jobs:
    for p in paths:
        with open(p, "wb") as f:
            f.write(data)
        print("patched", p)
