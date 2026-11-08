# Find a Chinese string in the game bundles (raw or \uXXXX-escaped) and print context.
# Usage: python scripts/ux/grep-bundle.py <text> [<text> ...]
import sys, glob, os, re
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
files = sorted(set(glob.glob(os.path.join(ROOT, "app/mods/next/js/*.js")) + glob.glob(os.path.join(ROOT, "site/_assets/r20261021-1/next/js/*.js"))))
seen = set()
BS = chr(92)
for q in sys.argv[1:]:
    esc = "".join(c if ord(c) < 128 else BS + "u%04x" % ord(c) for c in q)
    print("==", q)
    n = 0
    for f in files:
        base = os.path.basename(f)
        s = open(f, encoding="utf-8", errors="replace").read()
        for form in {q, esc, esc.upper().replace(BS + "U", BS + "u")}:
            for m in re.finditer(re.escape(form), s):
                key = (base, m.start())
                if key in seen: continue
                seen.add(key); n += 1
                if n <= 4:
                    print("  %s@%d: %s" % (os.path.relpath(f, ROOT), m.start(), s[max(0, m.start()-150):m.end()+120].replace("\n", " ")))
    print("  total", n)
