"""Lobby launch hooks for the training shell scripts (routines, progress panel).

Edits the mods copies of ChJ6FlD4.js in place (both paths, kept byte-identical), like
tools/round_patch.py. Run it after round_patch.py (order in tools/README.md):

    python -I tools/training_launch_patch.py

Refuses to run twice (marker __aimLaunchWorkshop). The anchor must match exactly once in both
copies before anything is written.

Adds two globals in the lobby (hall) setup scope, right after the training layer's exit is wired
(`const yt=G7();yt.setExit(di);`):

- window.__aimLaunchWorkshop(item | shareCode) -> true/false
  Starts a drill exactly like clicking it in the lobby: wl(item) goes through window.__aimPlayGate
  (rank picker), the loading screen and Qa(code, "workshop", brief), so the run counts as a
  workshop run: eligible scoring, onWorkshopRound -> pushRun (al-workshop-runs-v1) and the
  workshop history. (window.__aimLaunchScene from round_patch.py launches with source "plaza":
  'aim-local-result' still fires but with eligible:false and nothing is saved; it stays for
  Round mode.)
  The item is completed from the lobby catalogue with si(code, item) (like the history tab's own
  Play, Sc()), so a bare share code or a partial item works; the caller's description is kept.
  Returns false and does nothing when: no string shareCode; the code has no known type (not in
  the catalogue and no item.type); a drill is open or loading (l.value / yt.view.open; the layer
  loads its scene only on mount, so a launch on top of an open drill would not reload it).
  true means the launch started; with the rank picker gate the player can still cancel, so
  callers wait for the window 'aim-local-scene' event to know the drill really started.
- window.__aimLeaveTraining() -> true/false
  Closes the open (or loading) drill the same way its own Back does (di(): Studio return if
  pending, layer close, exit fullscreen, scene cleared; the layer's unmount hook releases pointer
  lock). Returns false if no drill is open or loading. A routine's "Next drill" calls this, waits
  for the lobby, then __aimLaunchWorkshop.
scripts/test-training-hooks.mjs checks both hooks are present in both copies.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]
NAME = "ChJ6FlD4.js"
MARKER = b"__aimLaunchWorkshop"

ANCHOR = b"const yt=G7();yt.setExit(di);"
PATCH = (ANCHOR
         + b"window.__aimLaunchWorkshop=function(R){if(typeof R===\"string\")R={shareCode:R};"
           b"if(!R||typeof R.shareCode!==\"string\"||!R.shareCode||l.value||yt.view.open)return!1;"
           b"const it=si(R.shareCode,R)||(R.type?R:null);if(!it)return!1;"
           b"wl(it===R?R:{...it,description:R.description??it.description});return!0};"
           b"window.__aimLeaveTraining=function(){if(!l.value&&!yt.view.open)return!1;di();return!0};")

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
    print("patched", p)
