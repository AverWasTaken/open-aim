"""Round mode (one VALORANT-style round: barrier phase, spike plant / defuse) in the game scripts.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/peekmove_patch.py. Run it after peekmove_patch.py (order in tools/README.md):

    python -I tools/round_patch.py

Refuses to run twice (marker /aim-rounds/round-core.mjs in CnrSARj_.js). Every match is checked in
every file before anything is written. Everything below only acts when the scene has rules.round
(round scenes are built by app/round-scene.js); every other scene runs exactly as before.

The round logic itself lives in app/mods/aim-rounds/round-core.mjs (pure functions, tested in node
by scripts/test-round.mjs), the 3D bits in app/mods/aim-rounds/round-visual.mjs.

1. Sim (CnrSARj_.js, nf):
   - imports round-core.mjs; before the sim reads the scene, roundPrepare(scene, seed) picks the
     player's spawn point and the 5 enemy setup spawners from the run seed (a new seed per run, so
     every restart re-rolls; the play page already does this in To(), prepared scenes pass through);
   - round state aimRd (plain object) next to the sim state; saveState() stores a copy as
     aimRound, restoreState() puts it back (the play page's opening step does save/step/restore);
   - setRoundHold({plant,use}): held keys from the play page, read by the next step;
   - player movement: after the move, if the round says so (barrier crossed during the barrier
     phase, or the player is dead after the plant), x/z go back to where they were and the
     horizontal speed is zeroed; a dead player also can't go up (no jumping; falling still works);
   - player shots are blocked while roundNoFire (barrier phase, round over, dead, holding, or the
     plant / defuse key held where it would start a hold on this tick);
   - bot shots at the player are dropped while roundBotsHold (barrier phase, round over, dead);
   - requestUse() (weapon pickup) is refused while roundBlocksUse;
   - at the end of each step roundStep(...) runs with the player, this tick's kill count and the
     held keys, the yaw (defuse facing) and whether the knife is out (cancels a hold); on the
     detonation tick the player and every bot inside the blast radius (35 m) die (bots through the
     sim's own kill steps: alive false, slow state cleared, weapon drop, a "kill" event marked
     aimBlast, which the play page doesn't count as the player's kill);
     snapshot().round = roundView(...) (null without a round).
2. Play page (OkAdunfX.js):
   - To() runs roundPrepare on the scene first (so the target count, 5, and everything else on the
     page see the same bots as the sim);
   - imports round-visual.mjs and BoxGeometry/CylinderGeometry; To() starts the visuals
     (barrier walls, spike) on the game scene, Hr() removes them; each frame updates them;
   - no replay recording for round runs (Je = null; Uu/Ou handle null);
   - before each step: de.setRoundHold({plant: Digit4 held, use: the "use" key held}) via two new
     input methods aimHeld(action) / aimHeldCode(code) (held keys clear on blur / lost lock);
   - after each step: window.__aimRound = snapshot.round (read by app/round-hud.js),
     window.__aimRoundHolding blocks ADS while planting/defusing;
   - end of run: with a round, the normal end checks (player dead, targets cleared, time, falling)
     are skipped; the run ends when the round controller says done (a few seconds after the round
     is decided, for the end banner). Du() reports endReason "cleared" for a win, "time" for a
     timeout loss, "died" otherwise, plus outcome.round = {win, reason, side, map};
   - the result screen headline / verdict (Tb, Sb) show "Round won/lost" and the reason;
   - the HUD's time chip is hidden for round runs (the round HUD shows the round timers).
3. Lobby (ChJ6FlD4.js): window.__aimLaunchScene({shareCode, name, mapId}) starts a scene by share
   code like the lobby does (loading screen, then Qa) with source "plaza" and no workshop brief, so
   no workshop history / leaderboard entry and no rank picker (app/round-panel.js has its own rank
   tiles).
4. Result header (Hwnlm6zD.js, Wo): with outcome.round, title "Round won/lost" and the reason.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"/aim-rounds/round-core.mjs"

CNR = [
    # Import (top of file; the sim module already starts with an import line).
    (b'import {aimCrouchMotion} from "./BiMsX6Xn.js";\n',
     b'import {aimCrouchMotion} from "./BiMsX6Xn.js";\n'
     b'import {roundPrepare as aimRoundPrepare,roundCreate as aimRoundCreate,roundStep as aimRoundStep,'
     b'roundView as aimRoundView,roundClone as aimRoundClone,roundBlocksMove as aimRoundBlocksMove,'
     b'roundFrozen as aimRoundFrozen,roundNoFire as aimRoundNoFire,roundBotsHold as aimRoundBotsHold,'
     b'roundBlocksUse as aimRoundBlocksUse,roundBlast as aimRoundBlast} from "/aim-rounds/round-core.mjs";\n'),
    # Scene prep + round state.
    (b"function nf(A,g){A=aimSpotApply(A,g);const D=g.seed??A.meta.seed,",
     b"function nf(A,g){A=aimSpotApply(A,g);A=A.rules?.round?aimRoundPrepare(A,g.seed??A.meta.seed):A;"
     b"const aimRdCfg=A.rules?.round??null;let aimRd=aimRdCfg?aimRoundCreate(aimRdCfg,AA):null,aimRdHold={plant:!1,use:!1};"
     b"const aimRdSave=(s,r)=>(r&&(s.aimRound=aimRoundClone(r)),s);"
     b"const D=g.seed??A.meta.seed,"),
    # Player movement: revert x/z when a barrier is crossed (or dead after the plant).
    (b"let sA=null;if(!FA){",
     b"const aimX0=n.position.x,aimY0=n.position.y,aimZ0=n.position.z;let sA=null;if(!FA){"),
    (b"zoomRatio:h}:null)}if(q!==null&&(IP(n,q,U,sA)",
     b"zoomRatio:h}:null)}aimRd!==null&&(aimRoundFrozen(aimRd)||aimRoundBlocksMove(aimRdCfg,aimRd,aimX0,aimZ0,n.position.x,n.position.z,n.position.y))"
     b"&&(n.position={...n.position,x:aimX0,z:aimZ0},n.velocity={...n.velocity,x:0,y:0});"
     b"aimRd!==null&&aimRoundFrozen(aimRd)&&n.position.y>aimY0&&(n.position={...n.position,y:aimY0},n.verticalVelocity=Math.min(0,n.verticalVelocity??0));"
     b"if(q!==null&&(IP(n,q,U,sA)"),
    # Player fire.
    (b"Pg=q!==null&&FP(n,U)||v||zA",
     b"Pg=aimRd!==null&&aimRoundNoFire(aimRd,aimRdHold,aimRdCfg,n.position)||q!==null&&FP(n,U)||v||zA"),
    # Bot shots at the player.
    (b"if(G.pendingShotTick=-1,I&&!G.alive){delete G.pendingShotHits;continue}",
     b"if(G.pendingShotTick=-1,I&&!G.alive||aimRd!==null&&aimRoundBotsHold(aimRd)){delete G.pendingShotHits;continue}"),
    # Weapon pickup on the use key.
    (b"requestUse(){return l.length===0&&JA.length===0||_()?!1:(VA=!0,!0)}",
     b"requestUse(){return l.length===0&&JA.length===0||_()||aimRd!==null&&aimRoundBlocksUse(aimRd)?!1:(VA=!0,!0)}"
     b",setRoundHold(c){aimRdHold={plant:!!c?.plant,use:!!c?.use}}"),
    # Save / restore.
    (b"saveState(){return vP(",
     b"saveState(){return aimRdSave(vP("),
    (b"recoilGameZoom:L?SB(L):null})},restoreState(c){const G=kP(",
     b"recoilGameZoom:L?SB(L):null}),aimRd)},restoreState(c){aimRd!==null&&c.aimRound&&(aimRd=aimRoundClone(c.aimRound)),aimRdHold={plant:!1,use:!1};const G=kP("),
    # Round tick at the end of the step.
    (b"aimStudioRecord(A,U,AA,n,c);return G}",
     b"if(aimRd!==null){let aimK=0;for(const Z of G)Z.kind===\"kill\"&&(aimK+=1);"
     b"aimRoundStep(aimRdCfg,aimRd,{tick:U,tickSec:AA,player:{x:n.position.x,y:n.position.y,z:n.position.z,"
     b"yaw:n.yaw,speed:Math.hypot(n.velocity.x,n.velocity.y),grounded:n.grounded,health:n.health??JB,knife:n.knife===1},kills:aimK,hold:aimRdHold});"
     b"if(aimRd.reason===\"detonated\"&&aimRd.endTick===U){aimRoundBlast(aimRdCfg,aimRd,n.position)&&(n.health=0,aimRd.playerAlive=!1);"
     b"for(const Z of iA)Z.alive&&aimRoundBlast(aimRdCfg,aimRd,Z.position)&&(Z.alive=!1,Z.health=0,fB(Z),"
     b"G.push({tick:U,kind:\"kill\",actorId:Z.id,killTicks:U-Z.bornTick,aimBlast:!0}),PE&&oE(Z),aimRd.enemiesDead+=1)}}"
     b"aimStudioRecord(A,U,AA,n,c);return G}"),
    # Snapshot.
    (b"snapshot(){return{tick:U,",
     b"snapshot(){return{round:aimRd!==null?aimRoundView(aimRdCfg,aimRd,AA):null,tick:U,"),
]

OKA_TAIL = b"""
/* aim-round (tools/round_patch.py): round mode visuals and result text; only acts with rules.round. */
let __aimRoundVis=null,__aimRoundEnd=null;
function __aimRoundStart(F,scene){__aimRoundStop();const cfg=F?.rules?.round;window.__aimRoundOn=!!cfg;if(!cfg)return;try{__aimRoundVis=__aimRoundVisual({Mesh:mt,Group:td,PlaneGeometry:is,SphereGeometry:nd,BoxGeometry:__aimBoxGeo,CylinderGeometry:__aimCylGeo,MeshBasicMaterial:os,DoubleSide:An},scene,cfg)}catch(err){console.warn("[aim-round] visuals:",err)}}
function __aimRoundStop(){try{__aimRoundVis?.dispose()}catch{}__aimRoundVis=null;__aimRoundEnd=null;window.__aimRoundOn=!1;window.__aimRound=null;window.__aimRoundHolding=!1}
function __aimRoundFrame(ce){if(__aimRoundVis&&ce?.round)try{__aimRoundVis.update(ce.round,performance.now()/1000)}catch{}}
function __aimRoundFinish(v){__aimRoundEnd={win:!!v.win,reason:v.reason,side:v.side,map:v.map};return v.win?"cleared":v.reason==="timeout"?"time":"died"}
function __aimRoundOutcome(){return __aimRoundEnd?{round:__aimRoundEnd}:{}}
const __aimRoundReasons={detonated:["Spike detonated","Spike detonated"],defused:["Spike defused","Spike defused"],eliminated:["All enemies eliminated","Your team was eliminated"],died:["The attackers were eliminated","You died"],timeout:["Time ran out before the plant","Time ran out before the plant"]};
function __aimRoundText(r){const t=__aimRoundReasons[r?.reason];return t?(r.win?t[0]:t[1]):""}
typeof window!=="undefined"&&(window.__aimRoundText=__aimRoundText);
function __aimRoundHighlight(r){return{tone:r.win?"win":"loss",title:r.win?"Round won":"Round lost",sub:__aimRoundText(r)}}
function __aimRoundVerdict(r){return{word:r.win?"Win":"Loss",detail:__aimRoundText(r)}}
"""

OKA = [
    (b"import {warmGridTargetAudio as __aimWarmGridTarget,",
     b"import {createRoundVisual as __aimRoundVisual} from '/aim-rounds/round-visual.mjs';\n"
     b"import {warmGridTargetAudio as __aimWarmGridTarget,"),
    (b"bd as mt", b"bd as mt,d2 as __aimBoxGeo,d1 as __aimCylGeo"),
    (b"import {createRoundVisual as __aimRoundVisual}",
     b"import {roundPrepare as __aimRoundPrepare} from '/aim-rounds/round-core.mjs';\nimport {createRoundVisual as __aimRoundVisual}"),
    # The round's own setup pick (5 of the setup spots, player spawn) before the page reads the
    # scene, so its target count and views match the sim (the sim skips prepared scenes).
    (b"function To(F,Z=null){if(r.applyEnvironment(F.environment)",
     b"function To(F,Z=null){F=F?.rules?.round?__aimRoundPrepare(F,F.meta.seed):F;if(r.applyEnvironment(F.environment)"),
    (b"function Hr(){Br(),Ur(),", b"function Hr(){__aimRoundStop(),Br(),Ur(),"),
    (b"s.onSceneBuilt?.(F),Hr(),Ke=d0(F),r.mount(Ke),",
     b"s.onSceneBuilt?.(F),Hr(),Ke=d0(F),r.mount(Ke),__aimRoundStart(F,r.scene),"),
    (b"Je=h0(F,de,{", b"Je=F.rules.round?null:h0(F,de,{"),
    (b"previousPhysicsSnapshot=hs(de);const Ze=de.step(je);",
     b"previousPhysicsSnapshot=hs(de);window.__aimRoundOn&&de.setRoundHold?.({plant:se.aimHeldCode(\"Digit4\"),use:se.aimHeld(\"use\")});const Ze=de.step(je);"),
    # Bots killed by the spike blast (kill events marked aimBlast) aren't the player's kills.
    (b"for(const he of Ze)he.kind===\"kill\"&&(ge+=1);gt?.observe(Ze),hn=null;const Ae=hs(de);",
     b"for(const he of Ze)he.kind===\"kill\"&&!he.aimBlast&&(ge+=1);gt?.observe(Ze.some(he=>he.aimBlast)?Ze.filter(he=>!he.aimBlast):Ze),hn=null;const Ae=hs(de);"
     b"Ae.round&&(window.__aimRound=Ae.round,window.__aimRoundHolding=Ae.round.holding!==null);"),
    (b"return{get zoomLevel(){",
     b"return{aimHeld($){return re($)},aimHeldCode($){return o.has($)},get zoomLevel(){"),
    (b"const __aimEquipBlocksADS=()=>O!==null&&U(de.tick);",
     b"const __aimEquipBlocksADS=()=>window.__aimRoundHolding===!0||O!==null&&U(de.tick);"),
    (b"if(!St&&Ze.some(he=>he.kind===\"playerFell\")){",
     b"if(!St&&!Ae.round&&Ze.some(he=>he.kind===\"playerFell\")){"),
    (b"const Xr=Ze.some(he=>he.kind===\"playerDead\"),Yr=de.targetsExhausted();",
     b"if(Ae.round){!St&&Ae.round.done&&(St=!0,Du(__aimRoundFinish(Ae.round)));return}"
     b"const Xr=Ze.some(he=>he.kind===\"playerDead\"),Yr=de.targetsExhausted();"),
    (b"kills:gt?.kills()??[],killedBy:gt?.killer()??null,threat:Bs}",
     b"kills:gt?.kills()??[],killedBy:gt?.killer()??null,threat:Bs,...__aimRoundOutcome()}"),
    (b"function rM(e){const t=",
     b"function rM(e){if(window.__aimRoundOn)return[{label:\"\xe5\xbe\x97\xe5\x88\x86\",value:String(e.score)},"
     b"{label:\"\xe5\x91\xbd\xe4\xb8\xad\xe7\x8e\x87\",value:e.shots>0?`${Math.round(e.hits/e.shots*100)}%`:\"\xe2\x80\x94\"}];const t="),
    (b"function Tb(e,t){", b"function Tb(e,t){if(t.round)return __aimRoundHighlight(t.round);"),
    (b"function Sb(e,t){", b"function Sb(e,t){if(t.round)return __aimRoundVerdict(t.round);"),
    (b"$.apply(ce,Cn,fe,$u(ce),previousPhysicsSnapshot),Cn=[];",
     b"$.apply(ce,Cn,fe,$u(ce),previousPhysicsSnapshot),__aimRoundFrame(ce),Cn=[];"),
]

CHJ = [
    (b"Le.workshopHistory.refreshSummary(),Le.workshopHistory.ensureRuns(R.shareCode)}",
     b"Le.workshopHistory.refreshSummary(),Le.workshopHistory.ensureRuns(R.shareCode)}"
     b"window.__aimLaunchScene=function(o){if(!o||typeof o.shareCode!==\"string\"||!o.shareCode)return!1;"
     b"document.documentElement.requestFullscreen?.().catch(()=>{}),"
     b"yt.begin({shareCode:o.shareCode,mapId:o.mapId??null,title:o.name||o.shareCode,subtitle:o.subtitle||\"\",backLabel:ts()}),"
     b"Qa(o.shareCode,\"plaza\");return!0};"),
]

HWN = [
    (b"function Wo(cb){",
     b"function Wo(cb){if(cb&&cb.round)return{kind:cb.endReason,title:cb.round.win?'Round won':'Round lost',detail:window.__aimRoundText?.(cb.round)||''};"),
]


def load(name):
    """Both copies of `name` as (paths, raws, LF text); the copies must match apart from line ends
    (Windows checkouts may give one copy CRLF and the other LF)."""
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


files = {n: load(n) for n in ("CnrSARj_.js", "OkAdunfX.js", "ChJ6FlD4.js", "Hwnlm6zD.js")}
if MARKER in files["CnrSARj_.js"][2]:
    raise SystemExit("CnrSARj_.js: already patched (found /aim-rounds/round-core.mjs)")
for n, marker in (("OkAdunfX.js", b"__aimRoundVisual"), ("ChJ6FlD4.js", b"__aimLaunchScene"), ("Hwnlm6zD.js", b"__aimRoundText")):
    if marker in files[n][2]:
        raise SystemExit(f"{n}: already patched (found {marker.decode()})")

out = {
    "CnrSARj_.js": apply("CnrSARj_.js", files["CnrSARj_.js"][2], CNR),
    "OkAdunfX.js": apply("OkAdunfX.js", files["OkAdunfX.js"][2], OKA, OKA_TAIL),
    "ChJ6FlD4.js": apply("ChJ6FlD4.js", files["ChJ6FlD4.js"][2], CHJ),
    "Hwnlm6zD.js": apply("Hwnlm6zD.js", files["Hwnlm6zD.js"][2], HWN),
}
for n, data in out.items():
    paths, raws, _ = files[n]
    for p, raw in zip(paths, raws):
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(data.replace(b"\n", b"\r\n") if b"\r\n" in raw else data)
        print("patched", p)
