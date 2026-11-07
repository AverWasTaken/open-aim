"""English callout names keep their spaces in the workshop / pre-aim result texts.

Edits the mods Dc2Dm9E6.js in place (both paths, kept byte-identical), like tools/rankpick_patch.py.
Run it after round_patch.py (order in tools/README.md):

    python -I tools/maps_callout_patch.py

Refuses to run twice (marker: the new regex). Every match is checked before anything is written.

Dc2Dm9E6.js, $u(map, x, z) (exported as `ad`, ChJ6FlD4 imports it as `xo`): the nearest-callout
lookup behind the "place" line of the workshop cards and the workshop detail (from the drill's
spawn point). It returned the callout name with ALL whitespace removed ("A区 大厅" -> "A区大厅"),
which turns the English names from tools/maps_callouts.mjs into "AMain". It now removes only
whitespace next to a non-ASCII character, so Chinese names give the same text as before byte for
byte and "A Main" stays "A Main". (The pre-aim result and the remaining-bots list use `gn`, which
returns the name as it is, so they need no patch.)

Both patched copies are checked with `node --check` (on a temp file) before anything is written.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

NEW_RE = rb"/\s+(?=[^\x00-\x7f])|(?<=[^\x00-\x7f])\s+/g"
MARKER = NEW_RE
CLASS = rb"[^\x00-\x7f]"  # the literal 12 characters, appears twice in NEW_RE
DC2 = [
    (rb"return cA['name']['replace'](/\s+/g,'');",
     rb"return cA['name']['replace'](" + NEW_RE + rb",'');"),
]


def patch(name, patches, marker):
    """Return (paths, patched bytes) for both copies of `name`; writes nothing."""
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raw = open(paths[0], "rb").read()
    for p in paths[1:]:
        if open(p, "rb").read() != raw:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    # Windows checkouts get CRLF (.gitattributes text=auto); patch in LF and convert back.
    crlf = b"\r\n" in raw
    data = raw.replace(b"\r\n", b"\n")
    if marker in data:
        raise SystemExit(f"{name}: already patched (found {marker.decode()})")
    if data.count(CLASS) != 0:
        raise SystemExit(f"{name}: expected no {CLASS.decode()} before patching, found {data.count(CLASS)}")
    for old, new in patches:
        if data.count(old) != 1:
            raise SystemExit(f"{name}: expected exactly one match for {old[:60]!r}, found {data.count(old)}")
        data = data.replace(old, new)
    if b"\x00" in data:
        raise SystemExit(f"{name}: a NUL byte ended up in the output")
    if data.count(CLASS) != 2:
        raise SystemExit(f"{name}: expected {CLASS.decode()} exactly twice after patching, found {data.count(CLASS)}")
    if data.count(marker) != 1:
        raise SystemExit(f"{name}: expected the new regex once after patching, found {data.count(marker)}")
    if crlf:
        data = data.replace(b"\n", b"\r\n")
    return paths, data


paths, data = patch("Dc2Dm9E6.js", DC2, MARKER)
fd, tmp = tempfile.mkstemp(suffix=".mjs")
try:
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    if subprocess.run(["node", "--check", tmp]).returncode != 0:
        raise SystemExit("node --check failed on the patched file; nothing written")
finally:
    os.remove(tmp)
for p in paths:
    with open(p, "wb") as f:
        f.write(data)
    print("patched", p)
if open(paths[0], "rb").read() != open(paths[1], "rb").read():
    raise SystemExit("the two copies differ after patching")
print("node --check ok, copies identical")
