"""Round mode bots (milestone R2: defenders move): the `roundBot` behaviour hook in the game scripts.

Edits the mods copies in place (both paths of each file, kept byte-identical). Run it after
round_patch.py (order in tools/README.md):

    python -I tools/round_bots_patch.py

Refuses to run twice (a marker per file) and refuses to run before round_patch.py. Every match is
checked in every file before anything is written. `--mods <dir>` patches another copy (tests);
`--print-pairs` prints the (old, new) pairs as JSON and writes nothing (scripts/test-round-bots-parity.mjs
uses them to rebuild the un-patched bundles and prove that normal drills run exactly as before).

The behaviour logic lives in app/mods/aim-rounds/round-bots.mjs (pure, imports nothing from the
bundles, does nothing at import time). Its header comment is the contract (exports, ctx.round,
io.bots, flat actor fields, reserved names).

1. Bot behaviours (BiMsX6Xn.js):
   - imports roundBotInit / roundBotUpdate from /aim-rounds/round-bots.mjs (first line; the
     anchor has no line end because the file is CRLF on Windows checkouts);
   - `ub` (behaviour kinds) gains `roundBot`; its update also gets `il`, the game's own mover
     (path/cross use it; with ctx.ground it follows the real floor);
   - `dA` (the movers list: stop-to-shoot, airborne checks) gains behavior.roundBot, so the il
     state that roundBot keeps in behavior.roundBot counts like path/cross;
   - shooter `MN`: no shot and no stop-to-shoot while actor.roundDefusing===1 (the flag is read
     after the sight / reaction bookkeeping, so the bot still tracks the player);
   - shooter `MN`: while actor.roundHoldFire===1 (round bots set it during the barrier phase) the
     reaction time is rolled again every tick the player is seen, so it starts when the barriers
     drop instead of running out behind them.
   Normal drills never set those flags or use roundBot, so they run as before.
2. Sim (CnrSARj_.js, nf):
   - imports aimRoundBotList / aimRoundIoBots from /aim-rounds/round-bots.mjs;
   - the behaviour ctx (aE) gets `round:{cfg,state,bots:null}` only in round runs (no key at all
     otherwise); right before the behaviour loop ctx.round.bots = aimRoundBotList(actors), the
     same start-of-tick snapshot for every bot (null during init, which runs inside the spawn step);
   - templates with a roundBot behaviour join the ground-mover set GB (like path/cross: ctx.ground
     for il, no per-tick ground snap by the sim);
   - roundStep's io gains bots: aimRoundIoBots(actors) (end-of-tick positions, for the bot defuse).
3. Scene validator (D_iGclxB.js): `roundBot` is a valid behaviour kind at the check site. The kind
   list `et` itself (it feeds Studio's behaviour picker) is left alone.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
PRINT_PAIRS = "--print-pairs" in sys.argv
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

BIM = [
    # Import (first line; no line end in the anchor).
    (b'import {maps as localMaps} from "/local/map-registry.mjs";',
     b'import {roundBotInit as aimRoundBotInit,roundBotUpdate as aimRoundBotUpdate} from "/aim-rounds/round-bots.mjs";'
     b'import {maps as localMaps} from "/local/map-registry.mjs";'),
    # Behaviour kinds.
    (b"ub={replay:{init:aimReplayInit,update:aimReplayUpdate},",
     b"ub={replay:{init:aimReplayInit,update:aimReplayUpdate},"
     b"roundBot:{init:(c,a,x)=>aimRoundBotInit(c,a,x),update:(c,a,x,d)=>aimRoundBotUpdate(c,a,x,d,il)},"),
    # Movers list (stop-to-shoot, airborne).
    (b"dA=n=>[n.behavior.path,n.behavior.cross,n.behavior.replay]",
     b"dA=n=>[n.behavior.path,n.behavior.cross,n.behavior.replay,n.behavior.roundBot]"),
    # Shooter: no shot / stop-to-shoot while defusing.
    (b"||e.behavior.replay?.fire===0)return;",
     b"||e.behavior.replay?.fire===0||e.roundDefusing===1)return;"),
    # Shooter: reaction time starts when the barrier drops.
    (b"if(r.readyTick<0||t.tick-r.lastSeenTick>H0){",
     b"if(r.readyTick<0||t.tick-r.lastSeenTick>H0||e.roundHoldFire===1){"),
]

CNR = [
    (b'import {aimCrouchMotion} from "./BiMsX6Xn.js";',
     b'import {aimCrouchMotion} from "./BiMsX6Xn.js";'
     b'import {aimRoundBotList,aimRoundIoBots} from "/aim-rounds/round-bots.mjs";'),
    # Behaviour ctx: round key only in round runs.
    (b"aE=c=>({tick:c,elapsed:c*AA,profile:i,",
     b"aE=c=>({tick:c,elapsed:c*AA,profile:i,...aimRd!==null?{round:{cfg:aimRdCfg,state:aimRd,bots:null}}:{},"),
    # Ground movers (il with ctx.ground, no per-tick snap).
    (b'c.behaviors.some(G=>G.kind==="path"||G.kind==="cross")',
     b'c.behaviors.some(G=>G.kind==="path"||G.kind==="cross"||G.kind==="roundBot")'),
    # Start-of-tick bot snapshot for the behaviours.
    (b"const rA=GB.size>0?{...x,ground:eD}:x;for(const h of iA){",
     b"x.round&&(x.round.bots=aimRoundBotList(iA));const rA=GB.size>0?{...x,ground:eD}:x;for(const h of iA){"),
    # Round tick: bots (defuse).
    (b"kills:aimK,hold:aimRdHold});",
     b"kills:aimK,hold:aimRdHold,bots:aimRoundIoBots(iA)});"),
]

DIG = [
    (b"et.includes(a.kind)||n(",
     b'et.includes(a.kind)||a.kind==="roundBot"||n('),
]

PATCHES = {"BiMsX6Xn.js": BIM, "CnrSARj_.js": CNR, "D_iGclxB.js": DIG}
MARKERS = {
    "BiMsX6Xn.js": b"/aim-rounds/round-bots.mjs",
    "CnrSARj_.js": b"/aim-rounds/round-bots.mjs",
    "D_iGclxB.js": b'a.kind==="roundBot"',
}

if PRINT_PAIRS:
    print(json.dumps({n: [[o.decode("utf-8"), w.decode("utf-8")] for o, w in p] for n, p in PATCHES.items()}))
    sys.exit(0)


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


files = {n: load(n) for n in PATCHES}
if b"/aim-rounds/round-core.mjs" not in files["CnrSARj_.js"][2]:
    raise SystemExit("CnrSARj_.js: run tools/round_patch.py first")
for n, marker in MARKERS.items():
    if marker in files[n][2]:
        raise SystemExit(f"{n}: already patched (found {marker.decode()})")

out = {n: apply(n, files[n][2], PATCHES[n]) for n in PATCHES}
for n, data in out.items():
    paths, raws, _ = files[n]
    for p, raw in zip(paths, raws):
        # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
        with open(p, "wb") as f:
            f.write(data.replace(b"\n", b"\r\n") if b"\r\n" in raw else data)
        print("patched", p)
