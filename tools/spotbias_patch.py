"""Rank-biased spot choice: low ranks stand on common spots, high ranks on off-angles.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/hitreg_patch.py. Run it after aimcenter_patch.py (order in tools/README.md):

    python -I tools/spotbias_patch.py

Refuses to run twice (marker aimSpotWeights in CnrSARj_.js). Every match is checked in every file
before anything is written.

Drills with rules.spawnerPick start each round with a random subset of their spots (pI in
CnrSARj_.js: a partial Fisher-Yates shuffle of the pool, one rng.fork(24301) number per pick).

1. Round start (OkAdunfX.js, aimBotRunOpts from tools/bot_patch.py): when the player picked an
   explicit enemy rank (not "Default") and app/mods/aim-ranks/spot-scores.json
   (tools/spot_scores.mjs) has the drill, keyed by aimSpotKey(doc), the run options get
   spotScores: {spawnerId: p} for the pool (p 0 = common spot .. 1 = off-angle). Like the other
   bot options it is saved in the replay meta, so playback uses the stored scores and never
   looks them up again.
2. Sim (CnrSARj_.js): with spotScores and an enemy rank, pI draws the same numbers from the same
   stream but picks with weights w = exp(b * (p - 0.5) * ln 20): at step E it takes the first
   index k >= E whose running weight sum over the not-yet-picked spots passes u * total. Rank
   bias b: iron -1, bronze -0.75, silver -0.5, gold -0.25, platinum 0, diamond 0.25,
   ascendant 0.5, immortal 0.75, radiant 1, so the most off-angle spot is 20x more (radiant) or
   less (iron) likely per draw than the most common one. Equal weights (platinum, or no scores)
   use the original pick unchanged, so runs without spotScores are identical to before.
3. Bot-order HUD (OkAdunfX.js, Vy): passes the same bias to pI, so its numbered order covers the
   spots the sim really spawned.
4. Replay playback (C_VPDXvn.js, both world builders): spotScores from the meta (missing = null).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]
MARKER = b"aimSpotWeights"

PI_OLD = (b"function pI(A,g){const D=A.rules.spawnerPick;if(!D)return null;const w=new Set(D.pool),B=new Set,C=[];"
          b"for(const E of A.spawners)w.has(E.id)?C.push(E.id):B.add(E.id);"
          b"const Q=Math.max(0,Math.min(C.length,Math.floor(D.count))),I=g.fork(VI);"
          b"for(let E=0;E<Q;E+=1){const P=E+Math.floor(I.next()*(C.length-E)),o=C[E];C[E]=C[P],C[P]=o,B.add(C[E])}return B}")
PI_NEW = (
    # Rank bias per enemy rank; weights only when they differ (else the original pick).
    b"const aimSpotRankBias={iron:-1,bronze:-.75,silver:-.5,gold:-.25,platinum:0,diamond:.25,ascendant:.5,immortal:.75,radiant:1};"
    b"function aimSpotWeights(C,sb){if(!sb||typeof sb.rank!==\"string\"||!sb.scores||typeof sb.scores!==\"object\")return null;"
    b"const b=aimSpotRankBias[sb.rank];if(typeof b!==\"number\"||b===0)return null;const W=new Map;let same=!0,first=null;"
    b"for(const id of C){const p=sb.scores[id],q=typeof p==\"number\"&&p>=0&&p<=1?p:.5,w=Math.exp(b*(q-.5)*Math.log(20));"
    b"W.set(id,w),first===null?first=w:w!==first&&(same=!1)}return same?null:W}"
    b"function aimSpotIndex(C,W,E,u){let t=0;for(let k=E;k<C.length;k++)t+=W.get(C[k]);const x=u*t;let a=0;"
    b"for(let k=E;k<C.length;k++)if(a+=W.get(C[k]),a>x)return k;return C.length-1}"
    b"function pI(A,g,aimSB=null){const D=A.rules.spawnerPick;if(!D)return null;const w=new Set(D.pool),B=new Set,C=[];"
    b"for(const E of A.spawners)w.has(E.id)?C.push(E.id):B.add(E.id);"
    b"const Q=Math.max(0,Math.min(C.length,Math.floor(D.count))),I=g.fork(VI),aimW=aimSpotWeights(C,aimSB);"
    b"for(let E=0;E<Q;E+=1){const aimU=I.next(),P=aimW?aimSpotIndex(C,aimW,E,aimU):E+Math.floor(aimU*(C.length-E)),o=C[E];"
    b"C[E]=C[P],C[P]=o,B.add(C[E])}return B}"
)

OK_TAIL = (
    b"\n/* aim-spots (tools/spotbias_patch.py): off-angle scores per spot (tools/spot_scores.mjs) for rank-biased spot choice */"
    b"let aimSpotTable=null;try{fetch(\"/aim-ranks/spot-scores.json\",{cache:\"no-cache\"}).then(r=>r.ok?r.json():null)"
    b".then(j=>{aimSpotTable=j&&j.scenes&&typeof j.scenes==\"object\"?j.scenes:null}).catch(()=>{})}catch{}"
    b"function aimSpotKey(d){const r=n=>Math.round(n*100)/100,p=d?.rules?.spawnerPick;if(!p||!Array.isArray(p.pool)||!Array.isArray(d.spawners))return null;"
    b"const s=JSON.stringify([d.environment?.map??null,p.pool,d.spawners.map(x=>[x.id,r(x.position.x),r(x.position.y),r(x.position.z)])]);"
    b"let e=2166136261,h=2646966556;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);e=Math.imul(e^c,16777619),h=Math.imul(h^c,2246822507)}"
    b"return(e>>>0).toString(16).padStart(8,\"0\")+(h>>>0).toString(16).padStart(8,\"0\")}"
    b"function aimSpotOpts(o,F){try{if(!o.enemyRank||!F?.rules?.spawnerPick)return;"
    b"if(!aimSpotTable){console.log(\"[aim-spots] scores not loaded yet, no spot bias this round\");return}"
    b"const e=aimSpotTable[aimSpotKey(F)];if(!e||!e.scores||typeof e.scores!=\"object\")return;const s={};"
    b"for(const id of F.rules.spawnerPick.pool){const p=e.scores[id];typeof p==\"number\"&&p>=0&&p<=1&&(s[id]=p)}"
    b"Object.keys(s).length&&(o.spotScores=s,console.log(\"[aim-spots] \"+o.enemyRank+\": spot bias on \"+Object.keys(s).length+\" spots\"))}catch{}}"
    b"function aimSpotBias(){return aimBotOpt&&typeof aimBotOpt.enemyRank==\"string\"&&aimBotOpt.spotScores&&typeof aimBotOpt.spotScores==\"object\""
    b"?{rank:aimBotOpt.enemyRank,scores:aimBotOpt.spotScores}:null}\n"
)

# (old, new, expected count)
PATCHES = {
    "CnrSARj_.js": [
        (PI_OLD, PI_NEW, 1),
        (b"ow=pI(A,Ug),", b"ow=pI(A,Ug,aimBR&&g.spotScores&&typeof g.spotScores==\"object\"?{rank:aimBR,scores:g.spotScores}:null),", 1),
    ],
    "OkAdunfX.js": [
        (b"o=l0(e,Ed(e.meta.seed)),", b"o=l0(e,Ed(e.meta.seed),aimSpotBias()),", 1),
        (b"...(aimBotOpt=aimBotRunOpts())}", b"...(aimBotOpt=aimBotRunOpts(F))}", 1),
        (b"function aimBotRunOpts(){const o={};", b"function aimBotRunOpts(F){const o={};", 1),
        (b'(o.perfectFirstShot=!0)}catch{}return o}', b'(o.perfectFirstShot=!0)}catch{}aimSpotOpts(o,F);return o}', 1),
    ],
    "C_VPDXvn.js": [
        (b"perfectFirstShot:e.meta.perfectFirstShot??null}",
         b"perfectFirstShot:e.meta.perfectFirstShot??null,spotScores:e.meta.spotScores??null}", 2),
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

if MARKER in files["CnrSARj_.js"]["data"]:
    raise SystemExit("already patched (found aimSpotWeights in CnrSARj_.js)")
if b"__aimCrossAlign" not in files["OkAdunfX.js"]["data"]:
    raise SystemExit("run tools/aimcenter_patch.py first")

for name, patches in PATCHES.items():
    data = files[name]["data"]
    for old, new, count in patches:
        if data.count(old) != count:
            raise SystemExit(f"{name}: expected {count} match(es) for {old[:70]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    files[name]["data"] = data

ok = files["OkAdunfX.js"]["data"]
files["OkAdunfX.js"]["data"] = ok + OK_TAIL if ok.endswith(b"\n") else ok + b"\n" + OK_TAIL

for name, f in files.items():
    data = f["data"].replace(b"\n", b"\r\n") if f["crlf"] else f["data"]
    for p in f["paths"]:
        with open(p, "wb") as out:
            out.write(data)
        print("patched", p)
