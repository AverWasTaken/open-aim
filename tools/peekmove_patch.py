"""Pre-aim bots react and move when they see you, by enemy rank (Human-like bots, explicit rank).

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/spotvary_patch.py. Run it after spotvary_patch.py (order in tools/README.md):

    python -I tools/peekmove_patch.py

Refuses to run twice (marker aimPeekUpdate in BiMsX6Xn.js). Every match is checked in every file
before anything is written.

app/mods/aim-ranks/spot-alts.json (tools/spot_alts.mjs) also holds a movement lane per position of
every static spot: lanes[spawnerId][i] = [ax, az, min, max] for alternative i (or the authored
point when the spot has no alternatives), the sideways axis (perpendicular to the line from the
planner's "from" point) and how far the bot may walk along it each way (metres, at most 1.5),
checked every 0.1 m for ground, ledges, walls, a clear path and the head staying visible from the
"from" point.

1. Round start (OkAdunfX.js, aimAltOpts from tools/spotvary_patch.py): in Human-like mode with an
   explicit enemy rank (Iron..Radiant; not "Default", not "No return fire", not Classic), every
   static spot whose bot shoots back and has a lane for the chosen position gets it: the run
   options get peekMove: true and spotLane: {spawnerId: [ax, az, min, max]}, saved in the replay
   meta. The chosen position is the same one spotPos uses (same aimAltPick index).
2. Sim (CnrSARj_.js, nf): with peekMove, an enemy rank and Human-like bots, those spawners' bots get
   one more behaviour, aimPeek (cached list per spawner), after their own ones. Without peekMove
   nothing changes.
3. aimPeek (BiMsX6Xn.js, aimPeekUpdate; numbers in aimPeekRanks next to aimBotRanks): the bot stands
   still until it first sees you. On every new sighting (a new shooter engagement) it rolls
   (aimHr, its own keys and state, no game random numbers) whether it stays put this time
   (stand: 20% Iron .. 10% Radiant). Otherwise it starts moving after half its rank reaction time,
   in ADAD legs along its lane (lane clamped to the rank's cap) with the existing mover (il, run
   speed at most), pausing between legs (dwell). Its state lives at behavior.strafe with a phase,
   so the existing Human-like hold applies: bots that rolled stop-to-shoot (aimBotRanks stop) brake
   and fire once slow; the others shoot while moving (with the existing movement error). After a
   burst of N shots a stop-to-shoot bot drops the hold, starts a new leg the other way and the
   shooter's next shot waits about 70% of the leg, so it peeks, counter-strafes and fires again.
   A new leg only starts while it sees you this tick; when it loses sight of you it finishes the
   current leg and waits there.
   The legs are driven with the game's mover il directly (like the strafer's wN does) instead of
   wN itself, because wN's leg and dwell rolls draw e.rng; every roll here is aimHr on the bot's own
   state, so no game random number is used and the shooter's rolls keep their order.
   Rank table (travel per leg m, speed x run speed, dwell s, stand chance, burst shots, lane cap m,
   chance of a 2.2x wide leg). Pauses are short at both ends on purpose: low ranks keep walking
   (wide, slow legs, shooting on the move), high ranks jiggle (short, fast legs, stop to shoot):
     iron      1.3-2.6  .50-.70  .12-.35  .20  3-6  1.5  0
     bronze    1.2-2.4  .55-.75  .12-.38  .18  3-5  1.5  0
     silver    1.1-2.2  .60-.80  .15-.45  .16  3-5  1.5  0
     gold      0.8-1.6  .70-.90  .20-.50  .14  2-4  1.3  .15
     platinum  0.7-1.4  .75-.95  .25-.55  .12  2-4  1.2  .12
     diamond   0.6-1.2  .80-1.0  .20-.45  .10  2-3  1.1  .10
     ascendant 0.4-0.9  .90-1.0  .15-.35  .10  1-3  1.0  .10
     immortal  .35-0.8  .95-1.0  .12-.30  .10  1-2  0.9  .08
     radiant   0.3-0.7  1.0     .10-.25  .10  1-2  0.8  .08
4. Replay playback (C_VPDXvn.js, both world builders): peekMove and spotLane from the meta.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]
MARKER = b"aimPeekUpdate"

PAUSE = b"function aimBotPause(n,e,r,t,l){return l>0&&aimBotRoute(n,t)?l*(.6+.8*aimHr(r,e,37)):l}"
PEEK = (
    b"const aimPeekRanks={iron:{t:[1.3,2.6],v:[.5,.7],d:[.12,.35],st:.2,b:[3,6],cap:1.5,w:0},"
    b"bronze:{t:[1.2,2.4],v:[.55,.75],d:[.12,.38],st:.18,b:[3,5],cap:1.5,w:0},"
    b"silver:{t:[1.1,2.2],v:[.6,.8],d:[.15,.45],st:.16,b:[3,5],cap:1.5,w:0},"
    b"gold:{t:[.8,1.6],v:[.7,.9],d:[.2,.5],st:.14,b:[2,4],cap:1.3,w:.15},"
    b"platinum:{t:[.7,1.4],v:[.75,.95],d:[.25,.55],st:.12,b:[2,4],cap:1.2,w:.12},"
    b"diamond:{t:[.6,1.2],v:[.8,1],d:[.2,.45],st:.1,b:[2,3],cap:1.1,w:.1},"
    b"ascendant:{t:[.4,.9],v:[.9,1],d:[.15,.35],st:.1,b:[1,3],cap:1,w:.1},"
    b"immortal:{t:[.35,.8],v:[.95,1],d:[.12,.3],st:.1,b:[1,2],cap:.9,w:.08},"
    b"radiant:{t:[.3,.7],v:[1,1],d:[.1,.25],st:.1,b:[1,2],cap:.8,w:.08}};"
    b"function aimPeekInt(a,u){return Math.min(a[1],a[0]+Math.floor(u*(a[1]-a[0]+1)))}"
    b"function aimPeekUpdate(n,e,t,i){if(t.botMode!==1)return;const P=aimPeekRanks[n.rank],R=aimBotRanks[n.rank],L=n.lane;if(!P||!R||!Array.isArray(L))return;"
    b"let s=e.behavior.strafe;if(!s||s.born!==e.bornTick)s=e.behavior.strafe={born:e.bornTick,index:1,finished:!0,speed:0,point:0,cap:0,dir:0,until:0,go:-1,eng:-1,shots:0,burst:0,mv:0,lead:0};"
    b"if(!e.alive){s.speed=0;return}const r=e.behavior.shooter;if(!r)return;"
    b"const lo=Math.max(L[2],-P.cap),hi=Math.min(L[3],P.cap);if(!(hi-lo>=.3))return;"
    b"const ax=L[0],az=L[1],h=e.home,at=()=>((e.position.x-h.x)*ax+(e.position.z-h.z)*az)/(ax*ax+az*az),pt=p=>({x:h.x+p*ax,y:e.position.y,z:h.z+p*az}),"
    b"step=()=>{il(s,{waypoints:[pt(at()),pt(s.point)],loop:!1,speed:s.cap,finish:\"stop\",...e.combatHold===1?{brake:!0}:{}},e,t.ground===void 0?t:{...t,ground:void 0},i),"
    b"s.finished&&(s.phase=\"wait\",s.until=t.elapsed+P.d[0]+(P.d[1]-P.d[0])*aimHr(s,e,97))};"
    b"if(r.readyTick>=0&&r.lastSeenTick===t.tick&&r.readyTick!==s.eng){s.eng=r.readyTick,s.shots=0,s.burst=aimPeekInt(P.b,aimHr(s,e,61));"
    b"if(aimHr(s,e,67)<P.st)s.mv=0;else{const re=R.reaction[0]+(R.reaction[1]-R.reaction[0])*aimHr(s,e,71);s.mv=1,s.go=t.tick+aa(.5*re,i),"
    b"s.dir=aimHr(s,e,73)<.5?-1:1,s.phase===void 0&&(s.phase=\"wait\",s.until=-1)}}"
    b"if(s.phase===void 0)return;"
    b"if(s.mv===1&&r.stop===1&&e.pendingShotTick===t.tick&&++s.shots>=s.burst)s.shots=0,s.burst=aimPeekInt(P.b,aimHr(s,e,61)),delete e.combatHold,s.phase=\"wait\",s.until=-1,s.lead=1;"
    b"if(s.phase===\"wait\"){if(s.mv!==1||t.tick<s.go||t.elapsed<s.until||r.lastSeenTick!==t.tick)return;"
    b"const c=at();let tr=P.t[0]+(P.t[1]-P.t[0])*aimHr(s,e,79);aimHr(s,e,83)<P.w&&(tr*=2.2);let d=s.dir||1,to=Math.min(hi,Math.max(lo,c+d*tr));"
    b"Math.abs(to-c)<.15&&(d=-d,to=Math.min(hi,Math.max(lo,c+d*tr)));if(Math.abs(to-c)<.15){s.until=t.elapsed+.2;return}"
    b"const M=Ng(k0(e,t))??t.profile;s.dir=-d,s.point=to,s.cap=M.runSpeed*(P.v[0]+(P.v[1]-P.v[0])*aimHr(s,e,89)),s.index=1,s.finished=!1,s.phase=\"go\";"
    b"s.lead===1&&(s.lead=0,r.nextFireTick=Math.max(r.nextFireTick,t.tick+aa(.7*Math.abs(to-c)/Math.max(.1,s.cap),i)))}"
    b"s.phase===\"go\"&&step()}"
)

CNR_FN_ANCHOR = b"function aimSpotApply(A,g){"
CNR_FN = (
    b"function aimPeekList(c,h,Z,L,rk){let b=c.get(h.spawnerId);if(b)return b;const l=L[h.spawnerId],"
    b"ok=Array.isArray(l)&&l.length===4&&l.every(Number.isFinite)&&l[2]<=0&&l[3]>=0&&Z.body?.shape===\"humanoid\"&&"
    b"Z.behaviors.some(x=>x.kind===\"shooter\")&&Z.behaviors.every(x=>x.kind===\"shooter\"||x.kind===\"respawn\");"
    b"b=ok?[...Z.behaviors,{kind:\"aimPeek\",lane:l,rank:rk}]:Z.behaviors;c.set(h.spawnerId,b);return b}"
)

OK_OLD = (
    b"const p={};let n=0;for(const s of F.spawners){const a=e.alts[s.id];if(s.kind!==\"fixed\"||!Array.isArray(a)||a.length<2)continue;"
    b"const i=aimAltPick(F.meta?.seed,s.id,a.length),q=a[i];if(Array.isArray(q)&&q.length===3&&q.every(Number.isFinite))p[s.id]=[q[0],q[1],q[2]],i>0&&n++}"
    b"Object.keys(p).length&&(o.spotPos=p,console.log(\"[aim-spots] spot vary: \"+n+\" of \"+Object.keys(p).length+\" spots moved\"))}catch{}}"
)
OK_NEW = (
    b"const p={},pl={},pk=typeof o.enemyRank==\"string\"&&!!e.lanes&&typeof e.lanes==\"object\",tm=new Map((F.actors??[]).map(x=>[x.id,x]));let n=0;"
    b"for(const s of F.spawners){if(s.kind!==\"fixed\")continue;const a=e.alts[s.id],va=Array.isArray(a)&&a.length>=2,"
    b"ln=pk&&tm.get(s.actorTemplateId)?.behaviors?.some(b=>b.kind===\"shooter\")?e.lanes[s.id]:null,m=va?a.length:Array.isArray(ln)?ln.length:0;if(!m)continue;"
    b"const i=aimAltPick(F.meta?.seed,s.id,m);if(va){const q=a[i];Array.isArray(q)&&q.length===3&&q.every(Number.isFinite)&&(p[s.id]=[q[0],q[1],q[2]],i>0&&n++)}"
    b"const l=Array.isArray(ln)&&ln.length===m?ln[i]:null;Array.isArray(l)&&l.length===4&&l.every(Number.isFinite)&&(pl[s.id]=[l[0],l[1],l[2],l[3]])}"
    b"Object.keys(p).length&&(o.spotPos=p,console.log(\"[aim-spots] spot vary: \"+n+\" of \"+Object.keys(p).length+\" spots moved\"));"
    b"Object.keys(pl).length&&(o.peekMove=!0,o.spotLane=pl,console.log(\"[aim-spots] \"+o.enemyRank+\": \"+Object.keys(pl).length+\" bots move when they see you\"))}catch{}}"
)

# (old, new, expected count)
PATCHES = {
    "BiMsX6Xn.js": [
        (b"decay:sN};/* aim-bots", b"decay:sN,aimPeek:{init(){},update(n,e,t,i){aimPeekUpdate(n,e,t,i)}}};/* aim-bots", 1),
        (PAUSE, PAUSE + PEEK, 1),
    ],
    "CnrSARj_.js": [
        (CNR_FN_ANCHOR, CNR_FN + CNR_FN_ANCHOR, 1),
        (b"aimBR=typeof g.enemyRank==\"string\"?g.enemyRank:null,",
         b"aimBR=typeof g.enemyRank==\"string\"?g.enemyRank:null,aimPK=g.peekMove===!0&&aimBM&&aimBR&&g.spotLane&&typeof g.spotLane==\"object\"?new Map:null,", 1),
        (b"z=IE.has(h.spawnerId)?aB(Z):Z.behaviors,",
         b"z=IE.has(h.spawnerId)?aB(Z):aimPK?aimPeekList(aimPK,h,Z,g.spotLane,aimBR):Z.behaviors,", 1),
    ],
    "OkAdunfX.js": [
        (OK_OLD, OK_NEW, 1),
    ],
    "C_VPDXvn.js": [
        (b"spotPos:e.meta.spotPos??null}",
         b"spotPos:e.meta.spotPos??null,peekMove:e.meta.peekMove??null,spotLane:e.meta.spotLane??null}", 2),
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

if MARKER in files["BiMsX6Xn.js"]["data"]:
    raise SystemExit("already patched (found aimPeekUpdate in BiMsX6Xn.js)")
if b"aimSpotApply" not in files["CnrSARj_.js"]["data"]:
    raise SystemExit("run tools/spotvary_patch.py first")

for name, patches in PATCHES.items():
    data = files[name]["data"]
    for old, new, count in patches:
        if data.count(old) != count:
            raise SystemExit(f"{name}: expected {count} match(es) for {old[:70]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    files[name]["data"] = data

for name, f in files.items():
    data = f["data"].replace(b"\n", b"\r\n") if f["crlf"] else f["data"]
    for p in f["paths"]:
        with open(p, "wb") as out:
            out.write(data)
        print("patched", p)
