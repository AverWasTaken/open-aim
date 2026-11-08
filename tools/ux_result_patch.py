"""Result screen: honest personal-best check, time to kill in seconds, Target drill header.

Edits the mods copies in place (both paths of each file, kept byte-identical), like
tools/round_patch.py. Run it after the last entry in the patch order (tools/README.md):

    python -I tools/ux_result_patch.py
    python -I tools/ux_result_patch.py --mods <dir>   # testing: patch another copy of app/mods

Refuses to run twice (markers: __aimPb in OkAdunfX.js, the Target drill header in Hwnlm6zD.js).
Every match is checked in every file before anything is written. UI only: uM and the RunReport
template are not in the sim, the recorder or the replay meta, so saved runs and replays are
unchanged.

1. Record check uM (OkAdunfX.js). The only history caller (zo in Hwnlm6zD) passes the recent runs
   WITH this run at the end, so before this patch every first run and every 0-point run was a
   "new personal best". Now:
   - best = max(earlier recent runs, saved best), or null when there is none;
   - best is shown only when it is above 0 (null otherwise, so RunReport hides the PB block);
   - isBest only when there is such a best, the score is above 0 and beats it (ties are not a record).
2. RunReport (OkAdunfX.js): a tie with the best shows "追平了个人纪录。" ("You tied your best.",
   app/english-fixes.js) instead of "还差 0 分 破个人纪录。" ("Short by 0 pts to beat your record.").
3. Time to kill (OkAdunfX.js uM): "0.42s" instead of "420ms"; the +/- delta next to it is dropped
   (the shared delta formatter rounds to whole numbers, so seconds deltas would read "±0").
4. Result header (Hwnlm6zD.js ResultOverlay): Target drills (workshop source, type ball) say
   "小球工坊 · 训练完成" / "返回小球项目" (english-fixes.js: "TARGET DRILL · COMPLETE" /
   "Back to Target drills") instead of the VALORANT Training header and back label.
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


OKA = [
    # 1. best = earlier runs only (t ends with this run), or null.
    (b"r=t.length?Math.max(...t.map(v=>ss(v.score))):o,u=Go(s)?Math.max(r,ss(s)):r",
     b"__aimPb=t.slice(0,-1).map(v=>ss(v.score)),r=__aimPb.length?Math.max(...__aimPb):null,"
     b"u=Go(s)?(r===null?ss(s):Math.max(r,ss(s))):r"),
    (b"best:u,isBest:o>=u,pbPercent:u>0?",
     b"best:u!==null&&u>0?u:null,isBest:u!==null&&u>0&&o>0&&o>u,pbPercent:u>0?"),
    # 2. Tie line in RunReport.
    (b('e.summary.isBest?(Y(),j("p",sb,"刚刚破了纪录。")):'),
     b('e.summary.isBest?(Y(),j("p",sb,"刚刚破了纪录。")):'
       'e.summary.score===e.summary.best?(Y(),j("p",{key:2},"追平了个人纪录。")):')),
    # 3. Time to kill in seconds, no delta.
    (b('l("平均击杀",v?`${ss(e.avgKillTime)}ms`:"—",e.avgKillTime,v&&n&&n.avgKillTime>0?n.avgKillTime:null,-1)'),
     b('l("平均击杀",v?`${(e.avgKillTime/1e3).toFixed(2)}s`:"—",e.avgKillTime,null,-1)')),
]

# Hwnlm6zD.js keeps \x20 escapes as literal text: raw strings.
HWN = [
    (b(r"cB=bf(()=>cf['value']?'瓦工坊\x20·\x20训练完成'"),
     b(r"cB=bf(()=>ck['value']?'小球工坊\x20·\x20训练完成':cf['value']?'瓦工坊\x20·\x20训练完成'")),
    (b(r"cm=bf(()=>cf['value']?'返回瓦工坊'"),
     b(r"cm=bf(()=>ck['value']?'返回小球项目':cf['value']?'返回瓦工坊'")),
]

MARKERS = {
    "OkAdunfX.js": b"__aimPb",
    "Hwnlm6zD.js": b(r"'小球工坊\x20·\x20训练完成'"),
}


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


PATCHES = {"OkAdunfX.js": OKA, "Hwnlm6zD.js": HWN}


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


if __name__ == "__main__":  # importable by scripts/test-ux-result.mjs (reads PATCHES/MARKERS)
    main()
