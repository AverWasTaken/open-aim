"""Human-like bots and the "Enemy rank" override, patched into the game scripts in app/mods/.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/lighting_patch.py. Run it once, after lighting_patch.py and the hand edits listed in
tools/README.md:

    python -I tools/bot_patch.py

C_VPDXvn.js (replay playback) has no mods copy before this patch; the script copies it from
site/next/js/ first.

Two per-run options, read from localStorage when a round starts (app/bot-settings.js shows them
in Settings) and saved in the replay meta so playback rebuilds the same bots:
  * meta.bots: "human" = Human-like bots (default). Missing = Classic, today's exact behaviour
    (so every replay recorded before this patch still plays back the same).
  * meta.enemyRank: "iron".."radiant" = every shooting bot uses that rank's reaction, aim error
    and head aim. Missing = the drill's own values. Bots that don't shoot stay that way.

Human-like (all of it is off in Classic, which draws from the bot's random stream in exactly
today's order; the extra randomness comes from a second per-bot stream kept in the bot's state,
so Classic draws are left untouched in Human-like mode too):
  * strafers: per-leg speed 80-100% of the configured max, short-short-long leg rhythm,
    ~15% early reversals with a very short stop, skewed stops (mostly short, sometimes a long
    hesitation). Legs stay inside the configured travel.
  * reaction: skewed (median = middle of the band, long tail up to 1.6x the band's top);
    re-peeks within 1.5 s of last seeing the player react 30% faster.
  * aim: first shot of each sighting 15% wider (later shots as configured); up to
    35% wider against a player strafing sideways at full speed.
  * stop to shoot: on each new sighting a shooter rolls whether it stops before firing
    (iron 10% ... radiant 90%, the last column of RANKS). Strafers that stop brake and fire once still;
    the rest keep moving and fire with movement error. Applies to strafers, peekers, runners,
    patrols and copycats.
  * peekers, runners and patrols: 0-0.25 s hesitation before each route start and waypoint pauses
    60-140% of their set length.
  * drills with flash bots (anti-flash drills): only the aim changes apply. Movement, reactions and
    stops stay Classic, so every flash pops on the same tick as in Classic.
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
SITE = os.path.join(ROOT, "site")
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

# Mirrors RANKS in app/studio/drill.js (reaction seconds, aim error degrees, head aim) plus the
# chance to stop before shooting in Human-like mode.
RANKS = [
    ("iron", ".9,1.1", "9", 0, ".1"),
    ("bronze", ".75,.9", "7", 0, ".2"),
    ("silver", ".6,.75", "5.5", 0, ".3"),
    ("gold", ".5,.62", "4.5", 0, ".45"),
    ("platinum", ".42,.52", "3.5", 1, ".55"),
    ("diamond", ".34,.44", "2.8", 1, ".65"),
    ("ascendant", ".28,.36", "2.2", 1, ".75"),
    ("immortal", ".22,.3", "1.6", 1, ".85"),
    ("radiant", ".17,.23", "1.1", 1, ".9"),
]
RANKS_JS = ("{" + ",".join(
    f"{rid}:{{reaction:[{re}],error:{er},heads:{hd},stop:{st}}}" for rid, re, er, hd, st in RANKS) + "}").encode()
RANK_RE = ("^(" + "|".join(r[0] for r in RANKS) + ")$").encode()

HELPERS = (
    b"/* aim-bots: Human-like bots + Enemy rank (tools/bot_patch.py) */"
    b"const aimBotRanks=" + RANKS_JS + b",aimBotOv=new WeakMap,aimBotNear=new WeakMap;"
    # Second random stream per behaviour state (s.hs, a plain number, so snapshots keep it).
    # Seeded from the bot's own seed, so Human-like never draws from e.rng beyond Classic's draws.
    b"function aimHr(s,e,k){if(s.hs===void 0)s.hs=(Math.imul(((e.rng?.seed??0)^k)>>>0,2654435761)^Math.imul((e.bornTick|0)+1,40503))>>>0;"
    b"s.hs=s.hs+1831565813>>>0;let r=s.hs;r=Math.imul(r^r>>>15,r|1);r^=r+Math.imul(r^r>>>7,r|61);return((r^r>>>14)>>>0)/4294967296}"
    # Shooter config with the Enemy rank override applied (cached per config object).
    b"function aimBotShooter(n,t){const id=t.enemyRank,R=id&&Object.hasOwn(aimBotRanks,id)?aimBotRanks[id]:null;if(!R)return n;"
    b"let c=aimBotOv.get(n);if(!c||c.aimRankId!==id){c={...n,reaction:R.reaction,aimErrorDeg:R.error,difficulty:R.heads?\"hard\":\"easy\",aimRankId:id};"
    b"delete c.rePeekReaction;aimBotOv.set(n,c)}return c}"
    # Rank of a shooter: the override, else the nearest rank by reaction midpoint and aim error.
    b"function aimBotRankOf(n){if(n.aimRankId)return n.aimRankId;let b=aimBotNear.get(n);if(b)return b;"
    b"const w=Array.isArray(n.reaction)&&n.reaction.length===2?n.reaction:[.5,.62],m=Math.max(.01,(w[0]+w[1])/2),er=Math.max(.05,Number(n.aimErrorDeg)||.05);let bd=1/0;"
    b"for(const[id,R]of Object.entries(aimBotRanks)){const d=Math.abs(Math.log(m/((R.reaction[0]+R.reaction[1])/2)))+Math.abs(Math.log(er/R.error));d<bd&&(bd=d,b=id)}"
    b"return aimBotNear.set(n,b),b}"
    # Reaction: split log-normal around the band's middle, clamped to [0.9 min, 1.6 max].
    b"function aimBotReact(w,r,e){const a=Math.min(w[0],w[1]),b=Math.max(w[0],w[1]),m=(a+b)/2;if(!(m>0))return a;"
    b"const z=Math.sqrt(-2*Math.log(Math.max(1e-12,aimHr(r,e,11))))*Math.cos(2*Math.PI*aimHr(r,e,11)),lo=Math.max(.001,a*.9),hi=b*1.6,"
    b"s=z<0?Math.log(m/lo)/2.4:Math.log(hi/m)/2.4;return Math.min(hi,Math.max(lo,m*Math.exp(s*z)))}"
    # New sighting: reaction, quick re-peek, stop roll, shot counter. In drills with flash bots the reaction
    # (I0, Classic's own draw) and the stop stay Classic, so routes and flashes keep their exact timing.
    b"function aimBotEngage(n,e,r,t,w,i,I0){r.ns=0;if(t.botFlashDrill===1)return delete r.lostTick,r.stop=1,I0;let I=aimBotReact(w,r,e);"
    b"const L=r.lastSeenTick>=0?r.lastSeenTick:r.lostTick;r.peeked&&!n.rePeekReaction&&L!==void 0&&t.tick-L<=aa(1.5,i)&&(I*=.7);delete r.lostTick;"
    b"r.stop=aimHr(r,e,11)<aimBotRanks[aimBotRankOf(n)].stop?1:0;r.stop||delete e.combatHold;return I}"
    # Player's sideways speed as seen from the bot (smoothed), from the eye position last tick.
    b"function aimBotTrack(r,h,g,i){const x=h.x,z=h.z;if(r.tx!==void 0&&i>0){const dx=x-g.x,dz=z-g.z,L=Math.hypot(dx,dz)||1,"
    b"v=Math.min(8,Math.abs((x-r.tx)*dz-(z-r.tz)*dx)/L/i);r.lat=(r.lat??0)*.7+v*.3}r.tx=x,r.tz=z}"
    # Aim error for one shot (counts the shot): first-shot flick, plus a term for a strafing player.
    b"function aimBotErr(n,r,t){if(t.botMode!==1)return n.aimErrorDeg;const k=r.ns??0;r.ns=k+1;"
    b"return n.aimErrorDeg*(k===0?1.15:1)*(1+.35*Math.min(1,(r.lat??0)/5.4))}"
    # Strafer leg: rhythm, early reversal, speed. Runs after cb's own (Classic) draws.
    b"function aimBotLeg(n,e,t){const T0=Math.min(n.travel[0],n.travel[1]),T1=Math.max(n.travel[0],n.travel[1]),"
    b"sh=aimHr(t,e,23)<((t.hr??0)>=2?.15:.6);t.hr=sh?(t.hr??0)+1:0;let tr=T0+(T1-T0)*(sh?0:.5)+(T1-T0)*.5*aimHr(t,e,23);"
    b"t.quick=0;aimHr(t,e,23)<.15&&(tr*=.35+.35*aimHr(t,e,23),t.quick=1);t.point=t.direction*tr/2;"
    b"t.cap=Math.max(n.speed[0],n.speed[1])*(.8+.2*aimHr(t,e,23))}"
    # Strafer stop: very short after an early reversal, else mostly short with ~10% long ones.
    b"function aimBotDwell(n,e,t){const D0=Math.min(n.dwell[0],n.dwell[1]),D1=Math.max(n.dwell[0],n.dwell[1]),lo=D0*.6,u=aimHr(t,e,29);"
    b"return t.quick===1?lo+(D0-lo)*u:aimHr(t,e,29)<.1?D1*(.7+.3*u):lo+(D1-lo)*Math.pow(u,2.2)}"
    # Routes: start hesitation and +-40% waypoint pauses. Off in drills with flash bots (botFlashDrill),
    # so every flash pops on the same tick as in Classic. aimBotHes also scales the first-waypoint pause.
    b"function aimBotRoute(n,t){return t.botMode===1&&t.botFlashDrill!==1}"
    b"function aimBotHes(n,e,r,t){if(!aimBotRoute(n,t))return;const p=r.pauseUntil>=0?Math.max(0,r.pauseUntil-t.elapsed)*(.6+.8*aimHr(r,e,37)):0;"
    b"r.pauseUntil=t.elapsed+p+.25*aimHr(r,e,31)}"
    b"function aimBotPause(n,e,r,t,l){return l>0&&aimBotRoute(n,t)?l*(.6+.8*aimHr(r,e,37)):l}"
    # Test hook (only with localStorage["aim-bot-lab"]="1"): the pure pieces, for measuring distributions.
    b"try{localStorage.getItem(\"aim-bot-lab\")===\"1\"&&(globalThis.__aimBotLab={ranks:structuredClone(aimBotRanks),rankOf:aimBotRankOf,react:aimBotReact,err:aimBotErr,"
    b"leg:aimBotLeg,dwell:aimBotDwell,hit:(deg,dist,u1,u2)=>{const a=bc(deg*Math.PI/180,u1,u2);return Cc(a.yaw,a.pitch,dist)}})}catch{}"
)

BIMSX = [
    (b"function pA(n,e,t){for(const i of e)ub[i.kind].init(i,n,t)}",
     HELPERS + b"function pA(n,e,t){for(const i of e)ub[i.kind].init(i,n,t)}"),
    # ---- shooter ----
    (b'update(n,e,t,i){const r=sl(e,"shooter",V0),s=t.gameMovement===!0;',
     b'update(n,e,t,i){n=aimBotShooter(n,t);const r=sl(e,"shooter",V0),s=t.gameMovement===!0;'),
    # Human-like: counter-strafing strafers can hold to shoot too (Classic: they never do).
    (b'const d=dA(e).some(w=>w!==void 0),m=n.engage!=="move"&&d,',
     b'const d=dA(e).some(w=>w!==void 0)||t.botMode===1&&t.botFlashDrill!==1&&e.behavior.strafe?.phase!==void 0,m=n.engage!=="move"&&d,'),
    (b"if(y){if(r.readyTick<0||t.tick-r.lastSeenTick>H0){const w=r.peeked&&n.rePeekReaction||n.reaction,I=e.rng.range(w[0],w[1]);r.readyTick=t.tick+aa(I,i)",
     b"if(t.botMode===1&&aimBotTrack(r,h.eye,g,i),y){if(r.readyTick<0||t.tick-r.lastSeenTick>H0){const w=r.peeked&&n.rePeekReaction||n.reaction;let I=e.rng.range(w[0],w[1]);"
     b"t.botMode===1&&(I=aimBotEngage(n,e,r,t,w,i,I));r.readyTick=t.tick+aa(I,i)"),
    (b"else if(r.lastSeenTick>=0&&t.tick-r.lastSeenTick>H0){if(r.readyTick=-1,r.lastSeenTick=-1,",
     b"else if(r.lastSeenTick>=0&&t.tick-r.lastSeenTick>H0){if(t.botMode===1&&(r.lostTick=r.lastSeenTick),r.readyTick=-1,r.lastSeenTick=-1,"),
    # Only bots that rolled "stop" hold (and wait until still) before firing.
    (b"if(m){if(e.combatHold=1,A)", b"if(m&&(t.botMode!==1||r.stop===1)){if(e.combatHold=1,A)"),
    (b"U=bc(n.aimErrorDeg*Math.PI/180,e.rng.next(),e.rng.next())", b"U=bc(aimBotErr(n,r,t)*Math.PI/180,e.rng.next(),e.rng.next())"),
    (b"O=n.aimErrorDeg+o.errorDegrees(U,w)", b"O=aimBotErr(n,r,t)+o.errorDegrees(U,w)"),
    (b"R=bc(n.aimErrorDeg*Math.PI/180,e.rng.next(),e.rng.next())", b"R=bc(aimBotErr(n,r,t)*Math.PI/180,e.rng.next(),e.rng.next())"),
    (b"aimErrorDeg:n.aimErrorDeg+id(t.profile,u,_,!1)", b"aimErrorDeg:aimBotErr(n,r,t)+id(t.profile,u,_,!1)"),
    # ---- strafer ----
    (b't.phase="go",t.index=1,t.finished=!1,t.speed=0}', b't.phase="go",t.index=1,t.finished=!1,t.speed=0,t.hm===1&&aimBotLeg(n,e,t)}'),
    (b"init(n,e){if(n.counterStrafe){e.behavior.strafe=IN(n,e);return}",
     b"init(n,e,aimCtx){if(n.counterStrafe){e.behavior.strafe=IN(n,e);aimCtx?.botMode===1&&aimCtx.botFlashDrill!==1&&(e.behavior.strafe.hm=1,aimBotLeg(n,e,e.behavior.strafe));return}"),
    (b"function wN(n,e,t,i,r){if(!e.alive){t.speed=0;return}",
     b"function wN(n,e,t,i,r){i.botMode===1&&i.botFlashDrill!==1&&t.hm===void 0&&(t.hm=1);if(!e.alive){t.speed=0;return}"),
    (b'speed:t.cap,finish:"stop",accel:n.accel}', b'speed:t.cap,finish:"stop",accel:n.accel,...t.hm===1&&e.combatHold===1?{brake:!0}:{}}'),
    (b"t.until=i.elapsed+SN(n,e)", b"t.until=i.elapsed+(t.hm===1?(SN(n,e),aimBotDwell(n,e,t)):SN(n,e))"),
    # ---- runners / peekers (cross) and patrols (path) ----
    (b"e.behavior.cross=r,P0(n,e,r,t.elapsed)}", b"e.behavior.cross=r,P0(n,e,r,t.elapsed),aimBotHes(n,e,r,t)}"),
    (b"r.readyAt=-1,P0(n,e,r,t.elapsed));return}", b"r.readyAt=-1,P0(n,e,r,t.elapsed),aimBotHes(n,e,r,t));return}"),
    (b"const l=Ps(n.pauses,a),u=hA(n,a);", b"const l=aimBotPause(n,e,r,t,Ps(n.pauses,a)),u=hA(n,a);"),
    (b"r.pauseUntil=t.elapsed+Ps(n.pauses,s)", b"r.pauseUntil=t.elapsed+aimBotPause(n,e,r,t,Ps(n.pauses,s))"),
    (b"lN={init(n,e){e.behavior.path={index:0,finished:!1,speed:0}}",
     b"lN={init(n,e,aimCtx){e.behavior.path={index:0,finished:!1,speed:0};aimCtx&&aimBotRoute(n,aimCtx)&&aimBotHes(n,e,e.behavior.path,aimCtx)}"),
]

# Sim factory: run options -> per-tick context.
CNRS = [
    (b'Q=g.movement==="game",', b'Q=g.movement==="game",aimBM=g.bots==="human",aimBR=typeof g.enemyRank=="string"?g.enemyRank:null,'
     b'aimBF=A.actors.some(c=>c.behaviors?.some(b=>Array.isArray(b.flashStops)&&b.flashStops.length>0)),'),
    (b"...Q?{gameMovement:!0}:{},", b"...Q?{gameMovement:!0}:{},...aimBM?{botMode:1}:{},...aimBR?{enemyRank:aimBR}:{},...aimBF?{botFlashDrill:1}:{},"),
]

# Round start: read the settings once, pass them to the sim and save them in the replay meta.
OKAD = [
    (b"movement:nl,shotTiming:sl})", b"movement:nl,shotTiming:sl,...(aimBotOpt=aimBotRunOpts())})"),
    (b"shotTiming:sl,recordedAt:Date.now()", b"shotTiming:sl,...aimBotOpt,recordedAt:Date.now()"),
]
OKAD_TAIL = (
    b"\n/* aim-bots (tools/bot_patch.py): bot options for the round, from Settings */"
    b"let aimBotOpt={};function aimBotRunOpts(){const o={};try{localStorage.getItem(\"aim-bot-mode\")!==\"classic\"&&(o.bots=\"human\");"
    b"const r=localStorage.getItem(\"aim-enemy-rank\")??\"\";/" + RANK_RE + b"/.test(r)&&(o.enemyRank=r)}catch{o.bots=\"human\"}return o}\n"
)

# Replay playback: rebuild the world with the same bot options.
CVP = [
    (b"shotTiming:e.meta.shotTiming??null})", b"shotTiming:e.meta.shotTiming??null,bots:e.meta.bots??null,enemyRank:e.meta.enemyRank??null})"),
    (b"runGait:wt(e.meta),terrain:a})", b"runGait:wt(e.meta),terrain:a,bots:e.meta.bots??null,enemyRank:e.meta.enemyRank??null})"),
]


def patch(name, patches, marker, tail=b"", source=None):
    """Return (paths, patched bytes) for both copies of `name`; writes nothing."""
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    if source is None:
        raw = open(paths[0], "rb").read()
        for p in paths[1:]:
            if open(p, "rb").read() != raw:
                raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    else:
        raw = open(source, "rb").read()
    # Windows checkouts get CRLF (.gitattributes text=auto); patch in LF and convert back.
    crlf = b"\r\n" in raw
    data = raw.replace(b"\r\n", b"\n")
    if marker in data:
        raise SystemExit(f"{name}: already patched (found {marker.decode()})")
    for old, new in patches:
        if data.count(old) != 1:
            raise SystemExit(f"{name}: expected exactly one match for {old[:60]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    if tail:
        data = data.rstrip(b"\n") + tail
    if crlf:
        data = data.replace(b"\n", b"\r\n")
    return paths, data


# Check every file before writing any, so a failed match leaves nothing half-patched.
cvp_paths = [os.path.join(MODS, d, "C_VPDXvn.js") for d in DIRS]
cvp_source = None if os.path.exists(cvp_paths[0]) else os.path.join(SITE, "next", "js", "C_VPDXvn.js")
jobs = [
    patch("BiMsX6Xn.js", BIMSX, b"aimBotRanks"),
    patch("CnrSARj_.js", CNRS, b"aimBM"),
    patch("OkAdunfX.js", OKAD, b"aimBotRunOpts", OKAD_TAIL),
    patch("C_VPDXvn.js", CVP, b"e.meta.bots", source=cvp_source),
]
for paths, data in jobs:
    for p in paths:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
        print("patched", p)
