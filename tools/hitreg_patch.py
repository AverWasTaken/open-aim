"""Exact fire rate and the optional "Perfect first shot", patched into the game scripts in app/mods/.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/bot_patch.py. Run it after lighting_patch.py, the hand edits and bot_patch.py
(order in tools/README.md):

    python -I tools/hitreg_patch.py

The script has stages. Each stage has its own marker and is skipped when its marker is already
in the files, so running the script again only adds the stages that are missing. Every match of
a stage is checked in every file before anything is written.

Both options are per-run flags saved in the replay meta (next to the bot options from
tools/bot_patch.py), so playback rebuilds the same sim. A missing flag means off, which is the
old behaviour, so every replay recorded before this patch still plays back the same.

Stage 1, meta.exactFireRate (every new run sets it):
  The game rounds the hold-to-fire interval to whole 128 Hz ticks (Vandal 9.85/s instead of
  9.75, Phantom 10.67 instead of 11, Spectre 12.8 instead of 13.33). With the flag the sim keeps
  the leftover part of a tick between shots, so a held trigger fires at the configured rate on
  average (shots still land on ticks). The leftover resets when the trigger is released, on a
  burst or tap shot and on a weapon switch, and is part of saveState/restoreState. Recoil
  recovery (the interval in UB and the game-recoil l8 call) uses the unrounded interval too.
  Not changed: tap mode, bursts (p/H), bot fire timing.

Stage 2, meta.perfectFirstShot (Settings > General > "Perfect first shot", default off):
  A single-bullet shot that is the first of a spray (recoil progress 0: UB progress for the
  basic recoil, the game recoil's bullet index for recoil "game"/"game2") while the movement
  error is 0 goes exactly where the crosshair is. The spread is still drawn from the shot random
  stream as before (the result is just not used), so later shots and bots get the same random
  numbers either way. The shot event records spreadDeg 0 (and firingDeg 0 with game recoil).
  Separate from the drill rule perfectAccuracy, which is left alone.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

# (old, new, expected count)
STAGE1 = {
    "CnrSARj_.js": [
        # Run flags.
        (b'Q=g.movement==="game",aimBM=', b'Q=g.movement==="game",aimXF=g.exactFireRate===!0,aimBM=', 1),
        # Fire interval in ticks, unrounded with the flag; aimFire: hold-to-fire check with the carry.
        (b"const iD=()=>f()?u():T(),",
         b"const iD=()=>aimXF?XA/(e.firingRatePerSecond*(f()?e.ads.fireRateMultiplier:1)):f()?u():T(),"
         b"aimFire=()=>{const w=U-pA+aimFc,I=iD();return w>=I?(aimFc=w<I+1?w-I:0,!0):!1},", 1),
        (b"let U=0,MD=0,pA=-1/0,Ig=!1;", b"let U=0,MD=0,pA=-1/0,Ig=!1,aimFc=0;", 1),
        (b'A.rules.fireMode==="hold"?U-pA>=iD()&&(pA=U,YD(G,kA)):Ig||(Ig=!0,pA=U,YD(G,kA))',
         b'A.rules.fireMode==="hold"?(aimXF?aimFire():U-pA>=iD())&&(pA=U,YD(G,kA)):Ig||(Ig=!0,pA=U,aimFc=0,YD(G,kA))', 1),
        (b"U-pA>=p(dA)&&(KA-=1,pA=U,", b"U-pA>=p(dA)&&(KA-=1,pA=U,aimFc=0,", 1),
        (b"(Ig=!0,KA=dA.shotsPerEntry-1,pA=U,", b"(Ig=!0,KA=dA.shotsPerEntry-1,pA=U,aimFc=0,", 1),
        (b"og||(Ig=!1)", b"og||(Ig=!1,aimFc=0)", 1),
        (b"n.equipTick=U,LA=-1,KA=0,F=0,", b"n.equipTick=U,LA=-1,KA=0,F=0,aimFc=0,", 1),
        (b"Cg=e.magazineSize,LA=-1,KA=0,cg=0,", b"Cg=e.magazineSize,LA=-1,KA=0,aimFc=0,cg=0,", 1),
        # Snapshots (replay seek, in-round restore): only written when the flag is on.
        (b"burstShotsLeft:KA,sensitivity:E,", b"burstShotsLeft:KA,...aimXF?{fireCarry:aimFc}:{},sensitivity:E,", 1),
        (b"burstShotsLeft:g.burstShotsLeft,", b"burstShotsLeft:g.burstShotsLeft,...g.fireCarry!==void 0?{fireCarry:g.fireCarry}:{},", 1),
        (b"burstShotsLeft:g.burstShotsLeft??0,", b"burstShotsLeft:g.burstShotsLeft??0,fireCarry:g.fireCarry??0,", 1),
        (b"KA=G.burstShotsLeft,E=G.sensitivity", b"KA=G.burstShotsLeft,aimFc=G.fireCarry,E=G.sensitivity", 1),
    ],
    # Round start (bot_patch.py's option reader): every new run uses the exact rate.
    "OkAdunfX.js": [
        (b'}catch{o.bots="human"}return o}', b'}catch{o.bots="human"}o.exactFireRate=!0;return o}', 1),
    ],
    # Replay playback (both world builders).
    "C_VPDXvn.js": [
        (b"bots:e.meta.bots??null,enemyRank:e.meta.enemyRank??null}",
         b"bots:e.meta.bots??null,enemyRank:e.meta.enemyRank??null,exactFireRate:e.meta.exactFireRate??null}", 2),
    ],
}

STAGE2 = {
    "CnrSARj_.js": [
        (b'aimXF=g.exactFireRate===!0,', b'aimXF=g.exactFireRate===!0,aimPF1=g.perfectFirstShot===!0,', 1),
        (b"function nf(A,g){", b"function aimPick(a,b,on){return on?b:a}function nf(A,g){", 1),
        # aimS0: this shot is the first of a spray (no recoil built up yet).
        (b"let j,b,wA=.5;", b"let j,b,wA=.5,aimS0=!1;", 1),
        (b"b=y?y.errDeg:0,y&&(wA=y.power)", b"b=y?y.errDeg:0,aimS0=!y||y.s<=0,y&&(wA=y.power)", 1),
        (b"b=e.errorDegrees(V,F);", b"b=e.errorDegrees(V,F),aimS0=V<=0;", 1),
        (b"const gA=O?0:Math.max(0,b+QA),FA=e.pelletsPerShot,sA=[];",
         b"const gA=O?0:Math.max(0,b+QA),FA=e.pelletsPerShot,aimZ=aimPF1&&FA===1&&aimS0&&QA===0,sA=[];", 1),
        # The spread is still drawn (same random numbers), then replaced by the aim direction j.
        (b"y=z?k8(j,gA,wA,z.angle01,z.radius01):B?R8(j,gA,wA,sg):x8(j,gA,sg),$=[]",
         b"y=aimPick(z?k8(j,gA,wA,z.angle01,z.radius01):B?R8(j,gA,wA,sg):x8(j,gA,sg),j,aimZ),$=[]", 1),
        (b"spreadDeg:gA,moveDeg:QA", b"spreadDeg:aimZ?0:gA,moveDeg:QA", 1),
        (b"...B?{firingDeg:b}:{}", b"...B?{firingDeg:aimZ?0:b}:{}", 1),
    ],
    "OkAdunfX.js": [
        (b"o.exactFireRate=!0;return o}",
         b'o.exactFireRate=!0;try{localStorage.getItem("aim-perfect-first-shot")==="1"&&(o.perfectFirstShot=!0)}catch{}return o}', 1),
    ],
    "C_VPDXvn.js": [
        (b"exactFireRate:e.meta.exactFireRate??null}",
         b"exactFireRate:e.meta.exactFireRate??null,perfectFirstShot:e.meta.perfectFirstShot??null}", 2),
    ],
}

STAGES = [(b"aimXF", "exact fire rate", STAGE1)]


def load(name):
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raw = open(paths[0], "rb").read()
    for p in paths[1:]:
        if open(p, "rb").read() != raw:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    # Windows checkouts get CRLF (.gitattributes text=auto); patch in LF and convert back.
    return paths, raw, b"\r\n" in raw


files = {}
for _, _, stage in STAGES:
    for name in stage:
        if name not in files:
            paths, raw, crlf = load(name)
            files[name] = {"paths": paths, "data": raw.replace(b"\r\n", b"\n"), "crlf": crlf, "changed": False}

# Marker lives in CnrSARj_.js for both stages.
for marker, label, stage in STAGES:
    if marker in files["CnrSARj_.js"]["data"]:
        print(f"skip stage '{label}': already patched (found {marker.decode()})")
        continue
    for name, patches in stage.items():
        data = files[name]["data"]
        for old, new, count in patches:
            if data.count(old) != count:
                raise SystemExit(f"{name}: expected {count} match(es) for {old[:70]!r}, found {data.count(old)}")
            data = data.replace(old, new)
        files[name]["data"] = data
        files[name]["changed"] = True
    print(f"stage '{label}' ready")

for name, f in files.items():
    if not f["changed"]:
        continue
    data = f["data"].replace(b"\n", b"\r\n") if f["crlf"] else f["data"]
    for p in f["paths"]:
        with open(p, "wb") as out:
            out.write(data)
        print("patched", p)
