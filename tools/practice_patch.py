"""Practice mode (free play on any map, app/practice-scene.js) in the play page.

Edits the mods copies of OkAdunfX.js in place (both paths, kept byte-identical), like
tools/round_patch.py. Run it after round_patch.py (order in tools/README.md):

    python -I tools/practice_patch.py

Refuses to run twice (marker __aimPracticeOn in OkAdunfX.js). Every match is checked before anything
is written. Everything below only acts when the scene has rules.practice (practice scenes are built by
app/practice-scene.js); every other scene runs exactly as before. No sim change.

OkAdunfX.js:
  1. No replay recording for practice runs: right after the recorder line round_patch.py made
     (`Je=F.rules.round?null:h0(...)`, left byte-identical because scripts/test-round.mjs looks for
     it), To() drops the recorder for practice scenes (`F.rules.practice&&(Je=null)`; Uu/Ou already
     handle Je = null, as for round runs). A practice run can last hours; the recorder would keep
     every tick in memory, and it would save a replay if the run ever ended.
  2. window.__aimPracticeOn: set in __aimRoundStart (called from To() on every scene build, restart
     included) from the scene's rules.practice, cleared in __aimRoundStop (Hr(): every rebuild and
     the engine dispose when the run is left).
  3. The HUD chips (rM) show only score and accuracy while __aimPracticeOn is set, like round mode:
     no 24 h timer counting down.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"__aimPracticeOn"

OKA = [
    (b"rulesVersion:Z.rulesVersion}:{}}),Ve=av(F),",
     b"rulesVersion:Z.rulesVersion}:{}}),F.rules.practice&&(Je=null),Ve=av(F),"),
    (b"window.__aimRoundOn=!!cfg;if(!cfg)return;",
     b"window.__aimPracticeOn=!!F?.rules?.practice;window.__aimRoundOn=!!cfg;if(!cfg)return;"),
    (b"window.__aimRoundOn=!1;window.__aimRound=null;",
     b"window.__aimRoundOn=!1;window.__aimPracticeOn=!1;window.__aimRound=null;"),
    (b"function rM(e){if(window.__aimRoundOn)return[",
     b"function rM(e){if(window.__aimRoundOn||window.__aimPracticeOn)return["),
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


paths, raws, text = load("OkAdunfX.js")
if MARKER in text:
    raise SystemExit("OkAdunfX.js: already patched (found __aimPracticeOn)")
data = apply("OkAdunfX.js", text, OKA)
for p, raw in zip(paths, raws):
    # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
    with open(p, "wb") as f:
        f.write(data.replace(b"\n", b"\r\n") if b"\r\n" in raw else data)
    print("patched", p)
