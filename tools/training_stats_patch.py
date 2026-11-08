"""End-of-run aim stats event for the training shell scripts (training analytics).

Edits the mods copies of OkAdunfX.js in place (both paths, kept byte-identical), like
tools/training_launch_patch.py. Run it after training_launch_patch.py (order in tools/README.md):

    python -I tools/training_stats_patch.py

Refuses to run twice (marker "aim-run-stats"). The anchor must match exactly once in both copies
before anything is written. Each copy keeps its own line ends.

Where: Ks(G, ge, qe, gt, zn), the live run's onRoundComplete handler in the training layer. It runs
once at the end of every live run (workshop, community, Studio/plaza, Round mode). Replays never
reach it (C_VPDXvn has no onRoundComplete). The insert sits right before
`p.value=wt,h.value=Math.round(wt.smoothness)`, after both record branches, so the record is
already saved and 'aim-local-result' has already fired.

What: one try{}catch{} block that dispatches
    window "aim-run-stats" CustomEvent, detail = {
      v: 1,
      recordId, shareCode, sceneHash, createdAt   (from the run record this call just made:
                                                   b.value?.run ?? C.value?.run; each branch of
                                                   Ks sets both b.value and C.value, so this is
                                                   never a stale record; null for Studio/plaza
                                                   and Round runs, which save no record),
      endReason, targetsKilled, targetsTotal      (outcome ge),
      replayId                                    (finished replay Tt.meta.id or null),
      round: !!ge.round, tracking: wt.scoring === "tracking", scoring,
      tickSec                                     (ve = 1/128 s, the sim tick),
      stats: { score, accuracy, hits, shots, duration, kills, avgKillTime, firstShotHitRate,
               followUpHitRate, overshootRatio, undershootRatio, pathEfficiency,
               movingShotRatio, humanoidHits, headshots, coverage, smoothness, damageTaken,
               killsByMisses: [n, n, n] }   (numbers straight from up() = wt; missing or
                                             non-finite -> null; reactionPoints left out),
      lives: [[bornTick, seenTick, killTick, killFromTick, firstHit, secondHit, firstMoving,
               stop, radiusDeg, stopAlongDeg], ...]    (one row per cp() life, zn.lives; the
                                                        booleans as 1/0/null; stop/radiusDeg/
                                                        stopAlongDeg from approach, or null),
      spawnTicks: [...]   (killLog reactionTicks: ticks from spawn or the previous kill to the
                           kill; only mapless non-tracking drills record them, else empty)
    }
Only numbers, booleans, short strings and null are copied (no game objects). Every read is
guarded, so a missing zn / killLog / approach can't throw, and the whole block is in try{}catch{}.

Nothing in the sim changes (read-only after the run ended), so replays and normal drills stay
identical and no replay meta flag is needed. app/training-analytics.js stores a per-run summary of
this event; scripts/test-training-stats.mjs checks the patch.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]
NAME = "OkAdunfX.js"
MARKER = b'"aim-run-stats"'

ANCHOR = b"p.value=wt,h.value=Math.round(wt.smoothness)"
INSERT = (
    b"try{const _sR=b.value?.run??C.value?.run??null,"
    b"_sN=x=>typeof x==\"number\"&&Number.isFinite(x)?x:null,"
    b"_sS=x=>typeof x==\"string\"?x.slice(0,64):null,"
    b"_sB=x=>x===!0?1:x===!1?0:null,"
    b"_sW=wt??{},_sA=Array.isArray(zn?.lives)?zn.lives:[],_sK=Array.isArray(G?.killLog)?G.killLog:[];"
    b"window.dispatchEvent(new CustomEvent(\"aim-run-stats\",{detail:{v:1,"
    b"recordId:_sS(_sR?.id),shareCode:_sS(_sR?.shareCode),sceneHash:_sS(_sR?.sceneHash),createdAt:_sN(_sR?.createdAt),"
    b"endReason:_sS(ge?.endReason),targetsKilled:_sN(ge?.targetsKilled),targetsTotal:_sN(ge?.targetsTotal),"
    b"replayId:_sS(Tt?.meta?.id),round:!!ge?.round,tracking:_sW.scoring===\"tracking\",scoring:_sS(_sW.scoring),"
    b"tickSec:_sN(ve),"
    b"stats:{score:_sN(_sW.score),accuracy:_sN(_sW.accuracy),hits:_sN(_sW.hits),shots:_sN(_sW.shots),"
    b"duration:_sN(_sW.duration),kills:_sN(_sW.kills),avgKillTime:_sN(_sW.avgKillTime),"
    b"firstShotHitRate:_sN(_sW.firstShotHitRate),followUpHitRate:_sN(_sW.followUpHitRate),"
    b"overshootRatio:_sN(_sW.overshootRatio),undershootRatio:_sN(_sW.undershootRatio),"
    b"pathEfficiency:_sN(_sW.pathEfficiency),movingShotRatio:_sN(_sW.movingShotRatio),"
    b"humanoidHits:_sN(_sW.humanoidHits),headshots:_sN(_sW.headshots),coverage:_sN(_sW.coverage),"
    b"smoothness:_sN(_sW.smoothness),damageTaken:_sN(_sW.damageTaken),"
    b"killsByMisses:Array.isArray(_sW.killsByMisses)?_sW.killsByMisses.map(_sN):null},"
    b"lives:_sA.map(l=>{const a=l?.approach??null;return[_sN(l?.bornTick),_sN(l?.seenTick),_sN(l?.killTick),"
    b"_sN(l?.killFromTick),_sB(l?.firstHit),_sB(l?.secondHit),_sB(l?.firstMoving),_sS(a?.stop),"
    b"_sN(a?.radiusDeg),_sN(a?.stopAlongDeg)]}),"
    b"spawnTicks:_sK.map(k=>_sN(k?.reactionTicks)).filter(x=>x!==null)}}))}catch{}"
)
PATCH = INSERT + ANCHOR

paths = [os.path.join(MODS, d, NAME) for d in DIRS]
raws = [open(p, "rb").read() for p in paths]
text = raws[0].replace(b"\r\n", b"\n")
for p, r in zip(paths[1:], raws[1:]):
    if r.replace(b"\r\n", b"\n") != text:
        raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
if MARKER in text:
    raise SystemExit(f"{NAME}: already patched (found {MARKER.decode()})")
if text.count(ANCHOR) != 1:
    raise SystemExit(f"{NAME}: expected exactly one match for {ANCHOR!r}, found {text.count(ANCHOR)}")
out = text.replace(ANCHOR, PATCH)
for p, raw in zip(paths, raws):
    # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
    with open(p, "wb") as f:
        f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
    print("patched", p, f"(+{len(INSERT)} bytes before {ANCHOR.decode()})")
