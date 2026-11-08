"""Combat feedback effects hook (graphics wave 1): wall impact sparks + dust, bot hit sparks, kill
burst, optional enemy muzzle flash. Render only: no sim, replay or RNG change.

Edits the mods OkAdunfX.js in place (both copies, kept byte-identical). Run it after
round_patch.py (order in tools/README.md), then tools/graphics_holes_patch.py:

    python -I tools/graphics_fx_patch.py

Refuses to run twice (marker __aimFxBoot). Every anchor's count is checked before anything is
written.

The effects live in app/mods/aim-fx/fx.mjs (createFx). The play page (function Jy) gets:
1. setup, next to the bullet holes `u=l1(r.scene,r.camera)`: __aimFx=__aimFxBoot(r). The boot
   helper (appended at the end of the file) returns a stand-in object right away and starts a
   dynamic import("/aim-fx/fx.mjs"); once it loads, createFx gets the page's own three.js
   constructors and the viewport's scene / camera / renderer, adds one Group to r.scene and compiles
   its 4 shader programs. Until then (or if the import fails) every call is a no-op; every call goes
   through try/catch, so the effects can't break the game loop.
2. GPU prewarm list (Eu): ...__aimFx.warmUp() (one mesh per effect material).
3. run start, next to u.clear(): __aimFx.clear() (also re-reads the aim-fx-settings-v1 key).
4. per frame, before r.render(): __aimFx.frame(r.camera); at drill exit, next to u.dispose():
   __aimFx.dispose() (a late-loading module is then ignored).
5. events:
   - wall impacts Us(F,Z,fe): __aimFx.wallImpact({point,normal,dir}); the normal is Ns(F,Z) only
     when bullet holes are on (as before) or the projectile collision Os is already built,
     otherwise null (the effect uses -dir). Sparks show even with bullet holes off; the lazy
     collision build is never started for them.
   - bot hits (both l.spawn calls, inside the not-grid-dot checks): __aimFx.hit({point,part}).
   - kills (the `Qn` kill-count loop): __aimFxKill(...) skips grid-dot targets, finds the actor in
     the post-step snapshot (a killed actor doesn't move in its kill step), chest height from the
     game's head point (Is) * .72, headshot = a shot in the same step hit that actor's head
     (pellets and `also` included). Round-mode spike-blast kills (aimBlast) show it too.
   - enemy shots: __aimFxEnemy(...) -> __aimFx.enemyShot({origin,dir}) (setting enemyMuzzle,
     default off).
Anchors are short and avoid the feel team's audio-call strings and the strings app/main.js
rewrites while serving.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"__aimFxBoot"

OKA = [
    # 1. setup (const list in Jy; r = viewport)
    (b"u=l1(r.scene,r.camera),",
     b"u=l1(r.scene,r.camera),__aimFx=__aimFxBoot(r),"),
    # 2. GPU prewarm list
    (b"Fe.push(...u.warmUp?.()??[],...l.warmUp?.()??[]);",
     b"Fe.push(...u.warmUp?.()??[],...l.warmUp?.()??[],...__aimFx.warmUp());"),
    # 3. run start
    (b"Os=void 0,u.clear(),",
     b"Os=void 0,u.clear(),__aimFx.clear(),"),
    # 4. per frame, before the scene render
    (b"r.render(),h.render(r.renderer),r.present()",
     b"__aimFx.frame(r.camera),r.render(),h.render(r.renderer),r.present()"),
    # 4b. drill exit: free the effect meshes / programs with the page's other renderers
    (b"Hr(),u.dispose(),c.dispose(),",
     b"Hr(),u.dispose(),__aimFx.dispose(),c.dispose(),"),
    # 5a. wall impacts (also penetration holes): normal only when it costs no collision build
    (b'function Us(F,Z,fe){const ce=t.bulletHoles.current;ce.look!=="off"&&u.spawn(F,Ns(F,Z),fe,ce)}',
     b'function Us(F,Z,fe){const ce=t.bulletHoles.current,__aimN=ce.look!=="off"||Os?Ns(F,Z):null;'
     b'ce.look!=="off"&&u.spawn(F,__aimN,fe,ce);__aimFx.wallImpact({point:F,normal:__aimN,dir:Z})}'),
    # 5b. bot hits (main hit + penetration `also`); both sit inside the not-grid-dot checks
    (b'l.spawn(Be.hitPoint,Be.hitPart??"body",Ae.tick)',
     b'(l.spawn(Be.hitPoint,Be.hitPart??"body",Ae.tick),__aimFx.hit({point:Be.hitPoint,part:Be.hitPart??"body"}))'),
    (b"l.spawn(yn.point,yn.part,Ae.tick)",
     b"(l.spawn(yn.point,yn.part,Ae.tick),__aimFx.hit({point:yn.point,part:yn.part}))"),
    # 5c. kills
    (b'for(const he of Ze)he.kind==="kill"&&(Qn+=1);',
     b'for(const he of Ze)he.kind==="kill"&&(Qn+=1,__aimFxKill(__aimFx,he,Ze,Ae,Ds,__aimDotTemplates));'),
    # 5d. enemy shots
    (b'if(he.kind==="enemyShot"){const Be=Ae.actors.find(yn=>yn.id===he.actorId);',
     b'if(he.kind==="enemyShot"){const Be=Ae.actors.find(yn=>yn.id===he.actorId);__aimFxEnemy(__aimFx,Be,Ae);'),
]

# Module-level helpers (hoisted function declarations; they use only the module's imports).
OKA_TAIL = (
    b"/* aim-fx (tools/graphics_fx_patch.py) */\n"
    b"function __aimFxBoot(r){"
    b"const o={impl:null,err:!1},"
    b"call=(k,a)=>{const i=o.impl;if(!i)return;try{return i[k](a)}catch(e){o.err||(o.err=!0,console.warn(\"[aim-fx]\",k,e))}};"
    b"o.warmUp=()=>{const i=o.impl;if(!i)return[];try{return i.warmUp()??[]}catch(e){return[]}};"
    b"o.clear=()=>call(\"clear\");o.frame=c=>call(\"frame\",c);o.hit=a=>call(\"hit\",a);"
    b"o.wallImpact=a=>call(\"wallImpact\",a);o.kill=a=>call(\"kill\",a);o.enemyShot=a=>call(\"enemyShot\",a);"
    b"o.dispose=()=>{o.dead=!0;call(\"dispose\");o.impl=null};"
    b"o.wants=k=>{const i=o.impl;if(!i)return!1;try{return i.wants(k)}catch(e){return!1}};"
    b"try{import(\"/aim-fx/fx.mjs\").then(m=>{if(o.dead)return;try{"
    b"o.impl=m.createFx({Vector3:ze,BufferGeometry:Ps,BufferAttribute:it,ShaderMaterial:uo,Mesh:mt,Color:dt,Quaternion:jr,Group:td},"
    b"{scene:r.scene,camera:r.camera,renderer:r.renderer});o.impl.compileNow?.()"
    b"}catch(e){o.impl=null,console.warn(\"[aim-fx] init failed\",e)}},e=>console.warn(\"[aim-fx] load failed\",e))}"
    b"catch(e){console.warn(\"[aim-fx] load failed\",e)}"
    b"return o}\n"
    b"function __aimFxKill(fx,k,evs,snap,scene,dots){try{"
    b"if(__aimIsGridTargetActor(k.actorId,snap.actors,dots))return;"
    b"const a=snap.actors.find(x=>x.id===k.actorId);if(!a)return;"
    b"const bx=a.position.x+a.offset.x,by=a.position.y+a.offset.y,bz=a.position.z+a.offset.z,"
    b"sc=a.scale??1,cr=a.behavior?.studioCrouch?.amount??0;"
    b"let y=by+1.12*sc*(1-.3*cr);"
    b"try{const tpl=scene?.actors?.find(t=>t.id===a.templateId);if(tpl&&tpl.body?.shape!==\"sphere\"){const h=Is(a,tpl,0);"
    b"h&&Number.isFinite(h.y)&&h.y>by&&(y=by+(h.y-by)*.72)}}catch(e){}"
    b"let head=!1;for(const e of evs){if(e.kind!==\"shot\")continue;for(const p of e.pellets??[e]){"
    b"p.hitActorId===k.actorId&&p.hitPart===\"head\"&&(head=!0);"
    b"for(const x of p.also??[])x.actorId===k.actorId&&x.part===\"head\"&&(head=!0)}}"
    b"fx.kill({position:{x:bx,y,z:bz},headshot:head})"
    b"}catch(e){}}\n"
    b"function __aimFxEnemy(fx,a,snap){try{"
    b"if(!a||!fx.wants(\"enemyMuzzle\"))return;"
    b"const ox=a.position.x+a.offset.x,oy=a.position.y+a.offset.y+1.45,oz=a.position.z+a.offset.z,p=snap.player.position;"
    b"fx.enemyShot({origin:{x:ox,y:oy,z:oz},dir:{x:p.x-ox,y:p.y+1.4-oy,z:p.z-oz}})"
    b"}catch(e){}}\n"
)


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
    for old, new in patches:
        data = data.replace(old, new)
    if tail:
        if not data.endswith(b"\n"):
            data += b"\n"
        data += tail
    return data


def main():
    paths, raws, text = load("OkAdunfX.js")
    if MARKER in text:
        raise SystemExit("OkAdunfX.js: already patched (found __aimFxBoot)")
    # names the hook relies on must already exist in the file
    # (td = three.js Group, Is = the game's head point, both imported from BiMsX6Xn.js)
    for need in (b"bc as td", b"b3 as Is", b"__aimIsGridTargetActor", b"let Ds=null,Os;", b"__aimDotTemplates=new Set"):
        if text.count(need) < 1:
            raise SystemExit(f"OkAdunfX.js: missing {need!r}")
    out = apply("OkAdunfX.js", text, OKA, OKA_TAIL)
    for p, raw in zip(paths, raws):
        with open(p, "wb") as f:
            f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
        print("patched", p)


if __name__ == "__main__":
    main()
