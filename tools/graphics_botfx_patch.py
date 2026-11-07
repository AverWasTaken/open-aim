"""Bot hit flash and death animation (graphics wave 1, render side only).

Edits the actor renderer `Uf` (its `apply`) in the mods `CnrSARj_.js` (both copies). `Uf.apply`
runs once per drawn frame in the game (OkAdunfX) and in the replay player (C_VPDXvn), so both get
the effect. Nothing here touches the sim: no sim state, no RNG draws, no events; all new state
lives on the renderer's own per-actor records and is reset by `clear()` (replay seek, retry).

1. Hit flash on humanoids: a white pulse on top of the base look. It holds full strength for 4 ticks
   (~31 ms, so it is on screen for at least a frame or two even at low fps), then eases out over 14
   ticks (~110 ms). A headshot (`hitPart` of the shot event is "head") is brighter, holds 5 ticks
   and eases out over 20. The emissive goes up (gameSkin materials; the older `skin` materials
   whose emissive map is the albedo get emissiveIntensity too) and the colour is pulled toward
   white. The old inverted-colour tint is dropped for humanoids (the white pulse replaces it).
   - Timing is tick based (shot tick to the drawn tick, with the frame's interpolation), so a
     paused replay holds the frame. Only uniform values change, never anything that recompiles a
     shader, and only while a pulse runs (plus one frame that writes the base emissive back; the
     game rewrites the colour itself every frame). The base emissive is re-read when the actor's
     tint changed, so a pulse never puts an old tint back.
2. Death of a humanoid: when it goes alive -> dead while still visible (a kill, including Round
   mode's spike blast; time-outs hide the actor and are not animated): pose frozen, it sinks
   0.32 m, squashes, tips back a little and glows white-hot, then shrinks to nothing; gone after
   220 ms. Wall-clock timed (performance.now) so the drop always finishes, even when the drill
   ends on that kill. A respawn (new bornTick, or dead -> alive) cancels it at once and restores
   the transforms. The transform caches (`aimCacheActorTransform`, `aimCacheActorScale`) re-apply
   whenever the values differ, and the patch writes its own values after them every frame while
   dying, then restores scale/tilt when done.
3. Spheres (every sphere template is a "grid dot" target, `__aimDotTemplates`): no new effect,
   they look and die exactly as before. `aimBfxSpheres=!1` in the injected code; setting it to !0
   would turn on a sphere pulse and a 120 ms pop (1 -> 1.25 -> 0), kept for later.
Tuning: `aimBfxT` in the injected code (pb/ph peak, hb/hh hold ticks, lb/lh ease ticks for
body/head, cm colour mix).

Usage: python tools/graphics_botfx_patch.py   (from the repo root; refuses to run twice)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"/* graphics-botfx */"

HELPERS = (
    MARKER
    + b"const aimBfxSpheres=!1,aimBfxBase=new WeakMap,aimBfxColor=new TA,aimBfxT={pb:1,ph:1.6,hb:4,hh:5,lb:14,lh:20,cm:.6};"
    b"function aimBfxNow(){return globalThis.performance?.now?.()??Date.now()}"
    # Death start: freeze the last drawn transform.
    b"function aimBfxStart(e){if(!e.mesh.skin&&!aimBfxSpheres)return;const r=e.mesh.root;"
    b"e.aimDie=aimBfxNow(),e.aimDieP=0,e.aimDieX=r.position.x,e.aimDieY=r.position.y,e.aimDieZ=r.position.z,e.aimDieYaw=r.rotation.y}"
    b"function aimBfxEnd(e){e.aimDie=-1}"
    # Loop 1: still dying? Then keep the frozen spot (humanoids sink) and stay visible.
    b"function aimBfxDying(e){if(!(e.aimDie>=0))return!1;const s=e.mesh.skin,p=(aimBfxNow()-e.aimDie)/(s?220:120);"
    b"if(!(p<1))return e.aimDie=-1,!1;e.aimDieP=Math.max(0,p);const r=e.mesh.root;"
    b"r.position.set(e.aimDieX,e.aimDieY-(s?.32*e.aimDieP*e.aimDieP:0),e.aimDieZ),r.rotation.y=e.aimDieYaw,r.updateMatrix();return!0}"
    # Loop 2: squash/tilt/shrink on the pivot (after its scale cache), restore when done.
    b"function aimBfxPivot(e,J){const v=e.mesh.pivot;if(e.aimDie>=0){const p=e.aimDieP;let x,y,t=0;"
    b"if(e.mesh.skin){const k=p<.6?1:Math.max(.02,1-(p-.6)/.4);x=(1+.1*p)*k,y=(1-.3*p*p)*k,t=-.28*(1-(1-p)*(1-p))}"
    b"else x=y=p<.3?1+.25*(1-(1-p/.3)*(1-p/.3)):Math.max(.02,1.25*(1-(p-.3)/.7)*(1-(p-.3)/.7));"
    b"v.scale.set(J*x,J*y,J*x),v.rotation.x=t,v.updateMatrix(),e.aimPivotSet=!0}"
    b"else if(e.aimPivotSet)v.rotation.x=0,v.scale.setScalar(J),v.updateMatrix(),e.aimPivotSet=!1}"
    # Loop 2: glow (hit pulse, death white-hot). The pulse holds its peak for hb/hh ticks, then eases
    # out over lb/lh ticks (body/head). emissive goes up and colour is pulled toward white (cm): the
    # game rewrites colour every frame and the patch writes the base emissive back when the pulse
    # ends, so nothing can stick. The base emissive is re-read when the actor's tint changed
    # (`emissiveHex`, written by the game just before this call), so a pulse never restores an old tint.
    b"function aimBfxGlow(e,T,base){const sph=!e.mesh.skin;if(sph&&!aimBfxSpheres)return;const P=aimBfxT;let k=0;"
    b"const age=T-1-(e.aimHitTick??-1/0);if(age<1e9){const h=e.aimHitHead,d=h?P.lh:P.lb,y=Math.max(0,age-(h?P.hh:P.hb));"
    b"if(y<d){const x=y/d;k=(h?P.ph:P.pb)*(1-x)*(1-x)}}"
    b"e.aimDie>=0&&(k=Math.max(k,1.7*Math.min(1,.4+e.aimDieP/.12)));if(!(k>0)&&!e.aimGlowOn)return;e.aimGlowOn=k>0;"
    b"const nh=e.aimGlowHex!==e.emissiveHex,w=Math.min(1,k)*P.cm;e.aimGlowHex=e.emissiveHex;"
    b"for(const o of e.mesh.parts){const m=o.material;if(!m||!m.emissive)continue;let b=aimBfxBase.get(m);"
    b"b?nh&&b.e.copy(m.emissive):(b={e:m.emissive.clone(),i:m.emissiveIntensity??1},aimBfxBase.set(m,b));"
    b"w>0&&m.color&&m.color.lerp(aimBfxColor.setRGB(1,1,1),w);"
    b"if(m.emissiveMap)m.emissive.copy(b.e).lerp(aimBfxColor.setRGB(1,1,1),Math.min(1,k)),m.emissiveIntensity=b.i+k*2.2;"
    b"else{const a=k*.85/Math.max(m.emissiveIntensity??1,.05);m.emissive.setRGB(b.e.r+a,b.e.g+a,b.e.b+a)}}}"
)

CNR = [
    # Helpers just before the actor renderer.
    (b"function Uf(A,g,D,w){",
     HELPERS + b"function Uf(A,g,D,w){"),
    # Loop 1: respawn cancels; alive -> dead while visible starts the death.
    (b"(H.bornTick!==t.bornTick||!t.wasAlive&&H.alive)&&(t.flashUntilTick=-1/0),t.wasAlive=H.alive,",
     b"(H.bornTick!==t.bornTick||!t.wasAlive&&H.alive)&&(t.flashUntilTick=-1/0,t.aimHitTick=-1/0,aimBfxEnd(t)),"
     b"t.wasAlive&&!H.alive&&H.visible&&H.bornTick===t.bornTick&&aimBfxStart(t),t.wasAlive=H.alive,"),
    # Loop 1: after the cached transform, a dying actor stays drawn at its frozen spot.
    (b"aimCacheActorTransform(t.mesh.root,r,Ow(H)),t.mesh.root.visible=a}",
     b"aimCacheActorTransform(t.mesh.root,r,Ow(H)),t.mesh.root.visible=aimBfxDying(t)||a}"),
    # Shot events: remember the tick and whether it was a headshot.
    (b"i&&H.tick>=i.bornTick&&(i.flashUntilTick=s.tick+IF)}",
     b"i&&H.tick>=i.bornTick&&(i.flashUntilTick=s.tick+IF,i.aimHitTick=H.tick,i.aimHitHead=H.hitPart===\"head\")}"),
    # Humanoids: the white pulse replaces the inverted-colour tint.
    (b"l=a?t?.hit??i.mesh.hitColor:r,",
     b"l=a&&!i.mesh.skin?t?.hit??i.mesh.hitColor:r,"),
    # Loop 2: death squash/shrink after the scale cache.
    (b"aimCacheActorScale(i.mesh.pivot,J),",
     b"aimCacheActorScale(i.mesh.pivot,J),aimBfxPivot(i,J),"),
    # Loop 2: glow after the colour/emissive writes.
    (b"q&&(i.emissiveHex=r),m+=1}",
     b"q&&(i.emissiveHex=r),aimBfxGlow(i,s.tick+(+L||0),r),m+=1}"),
    # Skinned pose is frozen while dying.
    (b"jQ(H.mesh,i,a,__aimCrouch)}o.length=0",
     b"H.aimDie>=0||jQ(H.mesh,i,a,__aimCrouch)}o.length=0"),
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


paths, raws, text = load("CnrSARj_.js")
if MARKER in text:
    raise SystemExit("CnrSARj_.js: already patched (found /* graphics-botfx */)")
out = apply("CnrSARj_.js", text, CNR)
for p, raw in zip(paths, raws):
    # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
    with open(p, "wb") as f:
        f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
    print("patched", p)
