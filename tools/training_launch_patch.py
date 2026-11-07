"""Lobby launch hooks for the training shell scripts (routines, progress panel).

Edits the mods copies of ChJ6FlD4.js in place (both paths, kept byte-identical), like
tools/round_patch.py. Run it after round_patch.py (order in tools/README.md):

    python -I tools/training_launch_patch.py

Refuses to run twice (marker __aimLaunchWorkshop). The anchor must match exactly once in both
copies before anything is written.

Adds two globals in the lobby (hall) setup scope, right after the training layer's exit is wired
(`const yt=G7();yt.setExit(di);`):

- window.__aimLaunchWorkshop(item) -> true/false
  Starts a drill exactly like clicking it in the lobby: wl(item) goes through window.__aimPlayGate
  (rank picker), the loading screen, Qa(code, "workshop", brief) and the workshop history refresh,
  so the run is saved to al-workshop-runs-v1 and 'aim-local-result' fires at the end.
  (window.__aimLaunchScene from round_patch.py launches with source "plaza" and no workshop brief,
  so nothing is saved; it stays for Round mode.)
  item needs the catalogue fields wl() reads: shareCode, mapId, name, type, description,
  parSeconds. Returns false (does nothing) without a string shareCode.
- window.__aimLeaveTraining() -> true/false
  Closes the open training layer the same way its own Back button does (di(): Studio return
  if pending, layer close, exit fullscreen, scene cleared). Returns false if no drill is open.
  A routine's "Next drill" calls this, waits for the lobby, then __aimLaunchWorkshop: the layer
  loads its scene only on mount, so launching while a result screen is open would not reload.
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
         + b"window.__aimLaunchWorkshop=function(R){if(!R||typeof R.shareCode!==\"string\"||!R.shareCode)return!1;"
           b"wl(R);return!0};"
           b"window.__aimLeaveTraining=function(){if(!l.value)return!1;di();return!0};")

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
