# Merge {"<section>": {"<key>": "<English>"}} JSON into app/english-fixes.js.
# Existing keys get their value replaced in place; new keys go at the end of the named
# section (the "// ---- <section>" comment). Prints what it did. Use --dry to preview.
# Usage: python scripts/ux/merge-fixes.py entries.json [--dry]
import json, re, sys, os
sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
P = os.path.join(ROOT, "app", "english-fixes.js")
entries = json.load(open(sys.argv[1], encoding="utf-8"))
dry = "--dry" in sys.argv
text = open(P, encoding="utf-8").read()
nl = "\r\n" if "\r\n" in text else "\n"
lines = text.split(nl)
STR = r'"((?:[^"\\]|\\.)*)"'
def q(s): return json.dumps(s, ensure_ascii=False)

def find_key(key):
    pat = re.compile(r'(^|,)(\s*)' + re.escape(q(key)) + r'(\s*:\s*)' + STR)
    for i, l in enumerate(lines):
        m = pat.search(l)
        if m: return i, m
    return None, None

replaced = added = same = 0
for section, kv in entries.items():
    for key, val in kv.items():
        i, m = find_key(key)
        if i is not None:
            old = json.loads('"' + m.group(4) + '"')
            if old == val: same += 1; continue
            lines[i] = lines[i][:m.start(4) - 1] + q(val) + lines[i][m.end(4) + 1:]
            print("REPLACE %s\n   - %s\n   + %s" % (key, old, val)); replaced += 1
            continue
        heads = [j for j, l in enumerate(lines) if l.strip().startswith("// ----")]
        start = next((j for j in heads if lines[j].strip() == "// ---- " + section), None)
        if start is None: sys.exit("no section: " + section)
        nxt = next((j for j in heads if j > start), None)
        if nxt is None: nxt = next(j for j in range(len(lines) - 1, -1, -1) if lines[j].strip() == "};")
        end = nxt
        while lines[end - 1].strip() == "": end -= 1
        lines.insert(end, "  %s: %s," % (q(key), q(val)))
        print("ADD [%s] %s -> %s" % (section, key, val)); added += 1
print("replaced %d, added %d, unchanged %d" % (replaced, added, same))
if not dry: open(P, "w", encoding="utf-8", newline="").write(nl.join(lines))
