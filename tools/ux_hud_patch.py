"""HUD events for the shell: one "aim-hit" per hitting shot and "aim-hud" when the stat box changes.

Edits the mods copies of OkAdunfX.js in place (both paths, kept byte-identical), like
tools/ux_result_patch.py. Run it after the last entry in the patch order (tools/README.md):

    python -I tools/ux_hud_patch.py
    python -I tools/ux_hud_patch.py --mods <dir>   # testing: patch another copy of app/mods

Refuses to run twice (marker: __aimEmitHits). Every match is checked in both copies before
anything is written. Read-only hooks: they run after the sim step, the recorder (Ou) and the
stats observer, read the step's events and the HUD values, and dispatch window events. No sim,
RNG, recorder or replay code changes. OkAdunfX.js is not loaded by the replay resim
(C_VPDXvn.js imports only BiMsX6Xn, index.uPZ7wDgX, DXHU7cEs, D_iGclxB and CnrSARj_).

1. Live tick (after `Ou(je,Ze),Cn.push(...Ze)`): __aimEmitHits(Ze,Ae) dispatches
   aim-hit {head, kill, dot, pellets, tick} once per player shot that hit an actor.
   - head: a pellet hit the head; pellets: how many pellets hit;
   - kill: the step had a kill (aimBlast kills excluded), attached to the step's first hitting shot;
   - dot: the shot hit a ball/grid target and no bot (grid targets raise kill events too).
2. HUD builder ya(): when the stat box values change (Hu false), __aimEmitHud(Z,F) dispatches
   aim-hud {kills, total, headshots, humanoidHits, score, hits, shots}. total is null on
   respawning drills (Iv). Fires only on change, so nothing is allocated on quiet frames.
Listener errors are caught, so they can't break the game loop.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.environ.get("AIM_UX_MODS") or os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]


def b(s):
    return s.encode("utf-8")


HELPERS = (
    "function __aimEmitHits(Ze,Ae){if(!Ze.length)return;try{let kills=0;"
    "for(const ev of Ze)ev.kind===\"kill\"&&!ev.aimBlast&&kills++;"
    "for(const ev of Ze){if(ev.kind!==\"shot\")continue;let hits=0,head=!1;"
    "for(const pel of ev.pellets??[ev])if(pel.hitActorId!=null){hits++;pel.hitPart===\"head\"&&(head=!0)}"
    "if(!hits)continue;"
    "const dot=__aimIsGridTargetHit(ev,Ae.actors,__aimDotTemplates)&&!__aimHasBotHit(ev,Ae.actors,__aimDotTemplates);"
    "window.dispatchEvent(new CustomEvent(\"aim-hit\",{detail:{head,kill:kills>0,dot,pellets:hits,tick:ev.tick}}));"
    "kills=0}}catch(err){}}"
    "function __aimEmitHud(Z,F){try{window.dispatchEvent(new CustomEvent(\"aim-hud\",{detail:{kills:ge,total:qe,"
    "headshots:F.headshots,humanoidHits:F.humanoidHits,score:Z.score,hits:Z.hits,shots:Z.shots}}))}catch(err){}}"
)

OKA = [
    # 1. Live tick: after the recorder and Cn.push, before the zoom bookkeeping (`at>0` stays last).
    (b("Cn.push(...Ze),at>0)"),
     b("Cn.push(...Ze),__aimEmitHits(Ze,Ae),at>0)")),
    # 2. HUD builder ya(): only when Hu says the stat box changed.
    (b("Mo&&Hu(Mo,Z)||(Mo=Z,n.onHud(Z))"),
     b("Mo&&Hu(Mo,Z)||(Mo=Z,n.onHud(Z),__aimEmitHud(Z,F))")),
    # 3. Helpers in the engine closure (sees ge, qe, __aimDotTemplates and the grid-target imports).
    (b("function Bu(F,Z){return Dc("),
     b(HELPERS + "function Bu(F,Z){return Dc(")),
]

MARKERS = {"OkAdunfX.js": b"__aimEmitHits"}
PATCHES = {"OkAdunfX.js": OKA}


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
    for old, new in patches:
        data = data.replace(old, new)
    return data


def main():
    files = {n: load(n) for n in PATCHES}
    for n, marker in MARKERS.items():
        if marker in files[n][2]:
            raise SystemExit(f"{n}: already patched (found {marker.decode('utf-8')})")
    out = {n: apply(n, files[n][2], patches) for n, patches in PATCHES.items()}
    for n, data in out.items():
        paths, raws, _ = files[n]
        for p, raw in zip(paths, raws):
            # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
            with open(p, "wb") as f:
                f.write(data.replace(b"\n", b"\r\n") if b"\r\n" in raw else data)
            print("patched", p)


if __name__ == "__main__":  # importable by scripts/test-ux-hit.mjs (reads PATCHES/MARKERS)
    main()
