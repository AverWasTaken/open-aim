"""Free old drills: fix the two drill memory leaks (render side only).

Patches both copies of `BiMsX6Xn.js` and `OkAdunfX.js` (and nothing else: no sim, replay, RNG or
replay meta change). Root cause write-up: open-aim-hq scratch/qa/leak/FINDINGS.md.

Leak 1 (every drill visit kept its whole WebGL context, canvas and session alive in the lobby):
  B1  three.js r185 never removes a renderer's "dispose" listeners from objects it does not own.
      The module-wide DFG_LUT texture, shared geometries and cached materials kept one closure per
      old renderer, and each closure holds that renderer's GL context and canvas. All 12
      `addEventListener("dispose", ...)` sites in the three internals now go through `aimDL(key,
      obj, fn)`: it adds the listener as before and records [WeakRef(obj), WeakRef(fn)] under the
      renderer's GL context (`n` in nD/sD/aD/W3/$3, `n.getContext()` in eD/z3 where `n` is the
      renderer, `k` in the renderer CE). The renderer's `dispose()` ends with `aimDLrel(k)`, which
      removes the listeners still in place. The list is pruned when it doubles (min 256 entries).
      The function is weak too: a registered listener stays alive through obj._listeners anyway,
      and a strong reference kept removed one-off closures (the bound depth texture callback, which
      holds a render target's framebuffer and its deleted textures) alive until the next prune.
      `globalThis.__aimDLStats` = {liveKeys, entries, removedLast, lateAdds} for tests.
  B2  `aimLt` (Map lighting) stored the GL context of every texture it saw (`e.g`); it now stores
      a WeakRef and drops entries whose context is gone. Same filtering as before.
  B3  The play page's `webglcontextlost` listener (its arrow holds the whole drill session) is
      `{once: true}`.
  C   The play page's frame scheduler `_h()` wakes itself through a MessageChannel; the open port
      was never closed, so each session left a port and its listener behind. The session dispose
      closes the scheduler the page made itself.
Leak 2 (R / Play again on a map drill: +175 GL buffers and +350 vertex arrays per retry):
  A   `Br()` (drop the map visual before loading a new one) now calls `dispose()` on the old
      visual's InstancedMesh copies, so the renderer frees their instance buffers and VAOs.
      Geometry and materials are shared with the map cache and are not disposed.

Every anchor's count is asserted, both copies must be identical, and the script refuses to run
twice (markers `/* qa-leak */` in BiMsX6Xn.js and `"aimBr"` in OkAdunfX.js). Keeps each copy's
own line ends.

Usage: python tools/leak_fix_patch.py   (from the repo root)
       python tools/leak_fix_patch.py --mods <dir>   (patch another copy of app/mods, for tests)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]
ALLOWED = {"BiMsX6Xn.js", "OkAdunfX.js"}  # render-side only: never the sim/replay bundles

# B1 registry helpers, inserted (top level of the module) right before three's WebGLCubeMaps `eD`.
HELPER = (
    b'/* qa-leak */'
    b'function aimDLs(){return aimDL.S||(aimDL.S={m:new WeakMap,rel:new WeakSet,'
    b'st:globalThis.__aimDLStats={liveKeys:0,entries:0,removedLast:0,lateAdds:0}})}'
    b'function aimDL(k,o,f){o.addEventListener("dispose",f);if(!k)return;const S=aimDLs(),st=S.st;'
    b'if(S.rel.has(k)){st.lateAdds++;return}let e=S.m.get(k);'
    b'if(!e){e={a:[],w:new WeakMap,lim:256};S.m.set(k,e);st.liveKeys++}'
    b'let s=e.w.get(o);s||e.w.set(o,s=new WeakSet);if(s.has(f))return;s.add(f);'
    b'e.a.push([new WeakRef(o),new WeakRef(f)]);st.entries++;'
    b'if(e.a.length>e.lim){const b=[];for(const x of e.a){const y=x[0].deref(),g=x[1].deref();'
    b'if(y&&g&&y.hasEventListener("dispose",g))b.push(x);else y&&g&&e.w.get(y)?.delete(g)}'
    b'st.entries-=e.a.length-b.length;e.a=b;e.lim=Math.max(256,2*b.length)}}'
    b'function aimDLrel(k){if(!k)return;const S=aimDLs(),st=S.st;if(S.rel.has(k))return;S.rel.add(k);'
    b'const e=S.m.get(k);let n=0;if(e){for(const x of e.a){const y=x[0].deref(),g=x[1].deref();'
    b'y&&g&&y.hasEventListener("dispose",g)&&(y.removeEventListener("dispose",g),n++)}'
    b'S.m.delete(k);st.liveKeys--;st.entries-=e.a.length}st.removedLast=n}'
)

PATCHES = {
    "BiMsX6Xn.js": {
        "marker": b"/* qa-leak */",
        "edits": [
            # B1 helpers
            (b"function eD(n){let e=new WeakMap", HELPER + b"function eD(n){let e=new WeakMap"),
            # B1 sites. eD (WebGLCubeMaps, n = renderer)
            (b'e.set(A,m),A.addEventListener("dispose",l),o(m.texture',
             b'e.set(A,m),aimDL(n.getContext(),A,l),o(m.texture'),
            # eD (WebGLCubeUVMaps / PMREM, n = renderer)
            (b't.set(A,g),A.addEventListener("dispose",u),g.texture',
             b't.set(A,g),aimDL(n.getContext(),A,u),g.texture'),
            # nD (WebGLGeometries, n = gl)
            (b'r[A.id]===!0||(A.addEventListener("dispose",a),r[A.id]=!0',
             b'r[A.id]===!0||(aimDL(n,A,a),r[A.id]=!0'),
            # sD (WebGLMorphtargets, n = gl)
            (b'i.set(o,A),o.addEventListener("dispose",S)}',
             b'i.set(o,A),aimDL(n,o,S)}'),
            # aD (WebGLObjects, InstancedMesh, n = gl); keep the hasEventListener guard
            (b'l.hasEventListener("dispose",c)===!1&&l.addEventListener("dispose",c)',
             b'l.hasEventListener("dispose",c)===!1&&aimDL(n,l,c)'),
            # z3 (WebGLShadowMap material variants, n = renderer)
            (b'B[F]=D,M.addEventListener("dispose",y)),w=D',
             b'B[F]=D,aimDL(n.getContext(),M,y)),w=D'),
            # W3 (WebGLTextures, n = gl): texture, depth texture, bound depth texture, render target
            (b'L.__webglInit=!0,x.addEventListener("dispose",M))',
             b'L.__webglInit=!0,aimDL(n,x,M))'),
            (b'Z.__webglInit=!0,x.depthTexture.addEventListener("dispose",M))',
             b'Z.__webglInit=!0,aimDL(n,x.depthTexture,M))'),
            (b'q.addEventListener("dispose",Z),x.__depthDisposeCallback=Z',
             b'aimDL(n,q,Z),x.__depthDisposeCallback=Z'),
            (b'L.addEventListener("dispose",b);const Z=L.textures',
             b'aimDL(n,L,b);const Z=L.textures'),
            # $3 (WebGLUniformsGroups, n = gl)
            (b'r[v.id]=_,v.addEventListener("dispose",E))',
             b'r[v.id]=_,aimDL(n,v,E))'),
            # CE (WebGLRenderer, k = gl); keep the De===void 0 guard
            (b'De===void 0&&(T.addEventListener("dispose",Wn),De=new Map',
             b'De===void 0&&(aimDL(k,T,Wn),De=new Map'),
            # B1 release: very end of CE.dispose (Ke/ae.dispose above still fire this renderer's handlers)
            (b'Se.removeEventListener("sessionend",Th),nr.stop()};function Mt(T)',
             b'Se.removeEventListener("sessionend",Th),nr.stop(),aimDLrel(k)};function Mt(T)'),
            # B2 aimLt.track: WeakRef to the GL context (re-wrapped only when the context changes)
            (b'this.seen.add(e)),e.g=g,e.L=L}',
             b'this.seen.add(e)),e.g&&e.g.deref()===g||(e.g=new WeakRef(g)),e.L=L}'),
            # B2 aimLt.refilter: an entry whose context is gone is dropped; others filtered as before
            (b'if(e.g!==g)continue;',
             b'const aimEg=e.g&&e.g.deref();if(!aimEg){this.seen.delete(e);this.ref.delete(t);continue}'
             b'if(aimEg!==g)continue;'),
        ],
        # after patching: only aimDL itself adds a "dispose" listener (the 12 direct sites are gone)
        "expect": {b'addEventListener("dispose"': 1},
    },
    "OkAdunfX.js": {
        "marker": b'"aimBr"',
        "edits": [
            # A: dispose the old map visual's InstancedMesh copies (same order as before, then dispose)
            (b'function Br(){va&&(r.setMapVisual(null),globalThis.__aimBotVisibility?.setMap(null,r.camera),va=null)}',
             b'function Br(){if(!va)return;const v=va;r.setMapVisual(null),'
             b'globalThis.__aimBotVisibility?.setMap(null,r.camera),va=null;'
             b'try{v.traverse(o=>{o.isInstancedMesh&&o.dispose()})}catch(e){console.error("aimBr",e)}}'),
            # B3: the contextlost arrow holds the drill session scope; run it once and let go
            (b"r.canvas.addEventListener('webglcontextlost',()=>{__aimPreparedLoadout=null;__aimInitialPrepared=false});",
             b"r.canvas.addEventListener('webglcontextlost',()=>{__aimPreparedLoadout=null;__aimInitialPrepared=false},{once:true});"),
            # C: the frame scheduler `_h()` (one per play page) wakes itself through a MessageChannel whose
            # port1 has onmessage set; an open, entangled port is never collected, so every session left
            # one (and its listener) behind. `close()` shuts it; the session dispose `Yu` calls it for the
            # scheduler the page made itself (not one passed in as s.scheduler).
            (b'cancelFrame(i){t.delete(i),n.delete(i)}}}function Rh(',
             b'cancelFrame(i){t.delete(i),n.delete(i)},close(){e.port1.onmessage=null,e.port1.close(),'
             b'e.port2.close(),o!==void 0&&clearTimeout(o),r!==void 0&&clearTimeout(r),t.clear(),n.clear()}}}'
             b'function Rh('),
            (b'const Eo=Rh({onTick:Gu,', b'let aimSch=null;const Eo=Rh({onTick:Gu,'),
            (b's.scheduler??(me?_h():void 0))', b's.scheduler??(me?aimSch=_h():void 0))'),
            (b'Ue=null,Eo.stop(),W==="locked"', b'Ue=null,Eo.stop(),aimSch?.close(),aimSch=null,W==="locked"'),
        ],
        "expect": {b"{once:true}": 1, b"aimSch": 4},
    },
}

assert set(PATCHES) <= ALLOWED, "leak_fix_patch.py must only touch BiMsX6Xn.js and OkAdunfX.js"

# Read and check everything first; write nothing unless every file passes.
plan = []
for name, spec in PATCHES.items():
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raws = [open(p, "rb").read() for p in paths]
    text = raws[0].replace(b"\r\n", b"\n")
    for p, r in zip(paths[1:], raws[1:]):
        if r.replace(b"\r\n", b"\n") != text:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    for other in PATCHES.values():
        if text.count(other["marker"]) != 0:
            raise SystemExit(f"{name}: already patched (found {other['marker'].decode()!r}); restore the file first")
    out = text
    for old, new in spec["edits"]:
        if out.count(old) != 1:
            raise SystemExit(f"{name}: expected exactly one match for {old[:90]!r}, found {out.count(old)}")
        if out.count(new) != 0:
            raise SystemExit(f"{name}: replacement already present: {new[:90]!r}")
        out = out.replace(old, new)
        assert out.count(new) == 1 and out.count(old) == new.count(old)
    assert out.count(spec["marker"]) == 1, f"{name}: marker count"
    for g, n in spec["expect"].items():
        if out.count(g) != n:
            raise SystemExit(f"{name}: expected {g!r} {n} time(s) after patching, found {out.count(g)}")
    if name == "BiMsX6Xn.js":
        assert out.count(b"aimDL(") == 12 + 1 and out.count(b"nr.stop(),aimDLrel(k)}") == 1, "B1 site count"
    plan.append((paths, raws, out))

for paths, raws, out in plan:
    for p, raw in zip(paths, raws):
        assert os.path.basename(p) in ALLOWED
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
        print("patched", p)
