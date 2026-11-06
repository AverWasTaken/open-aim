"""Vary the static bot spots every round (Human-like bot mode).

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/spotbias_patch.py. Run it after spotbias_patch.py (order in tools/README.md):

    python -I tools/spotvary_patch.py

Refuses to run twice (marker aimSpotApply in CnrSARj_.js). Every match is checked in every file
before anything is written.

app/mods/aim-ranks/spot-alts.json (tools/spot_alts.mjs) lists, for the static spots of the shipped
pre-aim drills, checked alternative positions around each authored point (first entry = the
authored point; stored y = authored y, the game ground-snaps from it like for the authored point).

1. Round start (OkAdunfX.js, aimBotRunOpts): in Human-like bot mode (not Classic), when the file
   has the drill (keyed by aimAltKey(doc), a hash of the map, weapon, player spawn, spawnerPick and
   the whole spawners, blocks and actors lists, keys sorted; the entry must list the drill's meta
   id, so Studio drills never match), every spot with alternatives gets one of them, chosen from the
   round seed and the spawner id (aimAltPick, a hash; no game random numbers are used). The run
   options get spotPos: {spawnerId: [x, y, z]}. Like the other bot options it is saved in the
   replay meta, so playback uses the stored positions and never reads the file. Every enemy rank,
   "Default" and "No return fire" included. The file is fetched when the game script loads; if a
   round starts before it arrived it is read synchronously (tried once per game load).
2. Sim (CnrSARj_.js, world creation nf): with spotPos, the world is built from a copy of the scene
   whose listed fixed spawners have their position replaced. Everything else (spot pick, rng
   streams, ground snap, facing) runs unchanged; a respawn of the same spawner within the round
   uses the same position. Without spotPos the scene is used as is (old runs, Classic mode).
3. Replay playback (C_VPDXvn.js, both world builders): spotPos from the meta (missing = null).

The bot-order HUD keeps planning on the authored scene (its numbers point at the spots; the name
labels follow the live bots), so it is not rebuilt every round.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]
MARKER = b"aimSpotApply"

NF_OLD = b"function nf(A,g){const D=g.seed??A.meta.seed,"
NF_NEW = (
    b"function aimSpotApply(A,g){const p=g?.spotPos;if(!p||typeof p!==\"object\"||!Array.isArray(A?.spawners))return A;let n=0;"
    b"const s=A.spawners.map(o=>{const q=p[o.id];if(o.kind!==\"fixed\"||!Array.isArray(q)||q.length!==3||!q.every(Number.isFinite))return o;"
    b"n++;return{...o,position:{x:q[0],y:q[1],z:q[2]}}});return n?{...A,spawners:s}:A}"
    b"function nf(A,g){A=aimSpotApply(A,g);const D=g.seed??A.meta.seed,"
)

OK_TAIL = (
    b"\n/* aim-spot-vary (tools/spotvary_patch.py): checked alternative bot spots (tools/spot_alts.mjs), one per spot per round */"
    b"let aimAltTable=null,aimAltTried=!1;try{fetch(\"/aim-ranks/spot-alts.json\",{cache:\"no-cache\"}).then(r=>r.ok?r.json():null)"
    b".then(j=>{aimAltTable||aimAltSet(j)}).catch(()=>{})}catch{}"
    b"function aimAltSet(j){aimAltTable=j&&j.scenes&&typeof j.scenes==\"object\"?j.scenes:null}"
    b'function aimAltKey(d){if(!d||!Array.isArray(d.spawners))return null;const c=x=>Array.isArray(x)?x.map(c):x&&typeof x=="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,c(x[k])])):x,s=JSON.stringify(c([d.environment?.map??null,d.rules?.weapon??null,d.playerSpawn??null,d.rules?.spawnerPick??null,d.spawners,d.blocks??[],d.actors??[]]));let e=2166136261,h=2646966556;for(let i=0;i<s.length;i++){const k=s.charCodeAt(i);e=Math.imul(e^k,16777619),h=Math.imul(h^k,2246822507)}return(e>>>0).toString(16).padStart(8,"0")+(h>>>0).toString(16).padStart(8,"0")}'
    b"function aimAltPick(seed,id,n){const s=String(seed)+\"|\"+id;let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);"
    b"h^=h>>>15,h=Math.imul(h,2246822507),h^=h>>>13,h=Math.imul(h,3266489909),h^=h>>>16;return(h>>>0)%n}"
    b"function aimAltOpts(o,F){try{if(o.bots!==\"human\"||!Array.isArray(F?.spawners))return;"
    b"if(!aimAltTable&&!aimAltTried)try{aimAltTried=!0;const x=new XMLHttpRequest;x.open(\"GET\",\"/aim-ranks/spot-alts.json\",!1),x.send(),x.status===200&&aimAltSet(JSON.parse(x.responseText))}catch{}"
    b"if(!aimAltTable)return;const e=aimAltTable[aimAltKey(F)];if(!e||!e.alts||typeof e.alts!=\"object\"||!Array.isArray(e.ids)||!e.ids.includes(F.meta?.id))return;"
    b"const p={};let n=0;for(const s of F.spawners){const a=e.alts[s.id];if(s.kind!==\"fixed\"||!Array.isArray(a)||a.length<2)continue;"
    b"const i=aimAltPick(F.meta?.seed,s.id,a.length),q=a[i];if(Array.isArray(q)&&q.length===3&&q.every(Number.isFinite))p[s.id]=[q[0],q[1],q[2]],i>0&&n++}"
    b"Object.keys(p).length&&(o.spotPos=p,console.log(\"[aim-spots] spot vary: \"+n+\" of \"+Object.keys(p).length+\" spots moved\"))}catch{}}\n"
)

# (old, new, expected count)
PATCHES = {
    "CnrSARj_.js": [
        (NF_OLD, NF_NEW, 1),
    ],
    "OkAdunfX.js": [
        (b"aimSpotOpts(o,F);return o}", b"aimSpotOpts(o,F);aimAltOpts(o,F);return o}", 1),
    ],
    "C_VPDXvn.js": [
        (b"spotScores:e.meta.spotScores??null}",
         b"spotScores:e.meta.spotScores??null,spotPos:e.meta.spotPos??null}", 2),
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
    raise SystemExit("already patched (found aimSpotApply in CnrSARj_.js)")
if b"aimSpotWeights" not in files["CnrSARj_.js"]["data"]:
    raise SystemExit("run tools/spotbias_patch.py first")

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
