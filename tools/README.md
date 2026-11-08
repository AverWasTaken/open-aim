# Maintainer tools

Python scripts used to build parts of the app. They read the game files in `site/`, so they
only work on a PC that has them (see [docs/game-files.md](../docs/game-files.md)).
Run them from the repository root with Python 3.

| Script | What it does |
| --- | --- |
| `make_icon.py` | Draws the app icon into `app/build/` |
| `perf_patch.py` | Writes the performance-patched game script into `app/mods/` |
| `lighting_patch.py` | Adds the Map lighting option (Enhanced / Original) to the patched game script in `app/mods/` |
| (hand edit) | Left-handed viewmodel fix in `Object3D.updateWorldMatrix` of the mods `BiMsX6Xn.js` (both copies): a parents-only update keeps `matrixWorldNeedsUpdate` set and a dirty parent forces the child, so a `getWorldPosition()` call can't swallow `hand.scale.x = -1` (upstream issues #4/#5). Re-apply by hand if the bundle is regenerated. |
| `bot_patch.py` | Human-like bots and the Enemy rank setting: edits the mods `BiMsX6Xn.js`, `CnrSARj_.js` and `OkAdunfX.js` (both copies) in place and makes the mods `C_VPDXvn.js` (replay playback) from `site/`. Details in the script's docstring. |
| `hitreg_patch.py` | Exact fire rate (and, in its second stage, the Perfect first shot option): edits the mods `CnrSARj_.js`, `OkAdunfX.js` and `C_VPDXvn.js` (both copies) in place. Details in the script's docstring. |
| `loadsafe_patch.py` | Map loading: a collision worker that never answers (60 s), crashes or can't load no longer hangs the load (main-thread build instead), plus `[aim-load]` console lines with stage timings, trainer download timing and retry warnings. Edits the mods `BiMsX6Xn.js` and `ChJ6FlD4.js` (both copies). |
| `rankpick_patch.py` | Rank picker on play: makes `wl` (the one lobby launch function) in the mods `ChJ6FlD4.js` (both copies) hand the drill to `window.__aimPlayGate` (`app/rank-picker.js`) first. Details in the script's docstring. |
| `aimcenter_patch.py` | Puts the aim point exactly under the drawn crosshair (a sub-pixel camera shift when the game view has an odd size, e.g. a maximized 2560x1439 window; render only, no sim change) and makes the simple replay resimulator `Zn` in the mods `C_VPDXvn.js` pass the same recoil/movement/shotTiming/zoomSensitivity options as the replay player. Edits the mods `OkAdunfX.js` and `C_VPDXvn.js` (both copies). Details in the script's docstring. |
| `spotbias_patch.py` | Rank-biased spot choice: with an explicit enemy rank, drills with a random spot pool (`rules.spawnerPick`) pick common spots more often for low ranks and off-angles for high ranks (scores from `spot_scores.mjs`, saved in the replay meta as `spotScores`). Edits the mods `CnrSARj_.js`, `OkAdunfX.js` and `C_VPDXvn.js` (both copies). Details in the script's docstring. |
| `spot_scores.mjs` | Writes `app/mods/aim-ranks/spot-scores.json`: an off-angle score per spot of every shipped drill with a random spot pool, from the game's own bot-order planner. Runs against a test copy of the app (rerun steps below). |
| `spotvary_patch.py` | Spot variation: in Human-like bot mode the static bots of the shipped pre-aim drills stand on one of their checked alternative positions (`spot_alts.mjs`), a new one each round (from the round seed; saved in the replay meta as `spotPos`). Edits the mods `CnrSARj_.js`, `OkAdunfX.js` and `C_VPDXvn.js` (both copies). Details in the script's docstring. |
| `spot_alts.mjs` | Writes `app/mods/aim-ranks/spot-alts.json`: up to 5 checked alternative positions per static spot of every shipped pre-aim drill, and a sideways movement lane per position (ground, ledges, walls, sight lines and spacing tested with the game's own collision and sight test). `--check` re-tests the stored file. Runs against a test copy of the app (rerun steps below). |
| `peekmove_patch.py` | Pre-aim bots react and move: with Human-like bots and an explicit enemy rank, the static shooting bots of the shipped pre-aim drills walk ADAD along their checked lane once they see you, by rank (`aimPeekRanks` next to `aimBotRanks`; saved in the replay meta as `peekMove` and `spotLane`). Edits the mods `BiMsX6Xn.js`, `CnrSARj_.js`, `OkAdunfX.js` and `C_VPDXvn.js` (both copies). Details and the rank table in the script's docstring. |
| `round_patch.py` | Round mode: the round controller in the sim (barrier phase, spike plant / defuse, outcomes, save/restore), the play page side (held keys, no replay, round end, result text, barrier and spike visuals) and `window.__aimLaunchScene` for the lobby panel. Edits the mods `CnrSARj_.js`, `OkAdunfX.js`, `ChJ6FlD4.js` and `Hwnlm6zD.js` (both copies). Only acts on scenes with `rules.round`. Details in the script's docstring. |
| `round_bots_patch.py` | Round mode bots: the `roundBot` behaviour hook (logic in `app/mods/aim-rounds/round-bots.mjs`, whose header is the contract). Adds `roundBot` to the bot behaviours (its update also gets the game's mover `il`), to the movers list `dA` and to the sim's ground movers; the behaviour ctx gets `round:{cfg,state,bots}` in round runs only (a start-of-tick bot list) and the round tick gets `io.bots` (bot defuse); the shooter neither fires nor stops-to-shoot while `actor.roundDefusing===1` and re-rolls its reaction time while `actor.roundHoldFire===1` (barrier phase); the scene validator accepts the kind. Edits the mods `BiMsX6Xn.js`, `CnrSARj_.js` and `D_iGclxB.js` (both copies). `--print-pairs` dumps its (old, new) pairs for the A/B parity test (`scripts/test-round-bots-parity.mjs`). Details in the script's docstring. |
| `round_minimap_patch.py` | Round mode minimap markers: the site letters A/B and the spike (planted: both sides; dropped: attack side only) on the in-game corner map and the big map. Drawing code in `app/mods/aim-rounds/round-minimap.mjs` (header = contract); the data is `window.__aimRoundMarks`, set by `round-visual.mjs` only while a round scene runs (null in normal drills, which then draw exactly as before). Edits the mods `OkAdunfX.js` (both copies): an import line, the small-map bot overlay block (shared world-to-screen mapper), both minimap redraw keys and the big-map overlay. `--print-pairs` dumps its (old, new) pairs for `scripts/test-round-minimap.mjs`. Details in the script's docstring. |
| `round_author.mjs` | Writes `app/mods/aim-rounds/<map>.json` (Round mode map data: spawns, barriers, plant zones, defender setups, retake staging points, attacker routes and plant spots) from the map files in `site/aim-maps/`, node only. Maps: Ascent and Corrode (`--map rook`). `--plot <file.svg>` draws it (also a `.png`), `--check` fails when the stored file is out of date, `--attack-plot <file.png>` draws the attacker data from the nav.bin header. See [Round mode data](#round-mode-data). |
| `round_terrain.mjs` | Round mode helper (node module, no CLI): `loadTerrain(map)` rebuilds the game's real pawn and projectile collision in plain node with the game's own code (meshopt decoder, terrain worker, BVH builder and raycast, all lifted from the repo files at runtime). Triangle sets are cached in `%TEMP%/open-aim-round-cache/`. Used by `round_nav.mjs` and the round tests. |
| `round_navdata.mjs`, `round_navlib.mjs`, `round_png.mjs` | Helpers for `round_nav.mjs`, `round_author.mjs` and the round tests: nav header data (setup facings, staging and zone checks, attacker route / plant / post-plant data, travel report, plots, retake and attacker staging candidates, plant spot candidates), graph searches (floods, Dijkstra, barrier edge mask), a small PNG canvas. |
| `round_nav.mjs` | Writes `app/mods/aim-rounds/<map>.nav.bin`, the Round mode nav graph: the game's own nav builder run on the real collision from both spawns (2-3 min, below-normal priority). `--reuse` keeps the graph and only rewrites the header (setup facings, staging and zone checks, which need sight rays; helpers in `round_navdata.mjs`). `--candidates`, `--setup-candidates`, `--attack-candidates` list the spots the authored retake / setup / attacker data was picked from. See [Round mode nav graph](#round-mode-nav-graph). |
| `maps_callouts.mjs` | Writes `app/mods/aim-maps/<map>.minimap.json` for every map: the game's callout list with Riot's in-game English names ("A Main", "B Boat House") in place of the Chinese ones, from `tools/maps-callouts-en.json`, node only. Only the names change; every spot and every other byte stays as in `site/aim-maps/` (juliett, which only exists in `app/mods/aim-maps/`, is renamed in place). `--check` fails when a file is out of date. See [Callout names](#callout-names). |
| `maps_callout_patch.py` | Keeps the space in English callout names ("A Main", not "AMain") in the place line of the workshop cards and the workshop detail: the nearest-callout lookup `$u` in the mods `Dc2Dm9E6.js` (both copies) now removes only whitespace next to a non-ASCII character, so Chinese names give the same text as before. Details in the script's docstring. |
| `fetch_rank_icons.py` | Downloads the rank icons into `app/mods/aim-ranks/` (run once; the PNGs are committed). |
| `make_training_set.py` | Generated the original 25 scenarios. New scenarios go straight into `scenarios/` instead. |

```bash
python -I tools/make_icon.py
```

## Patch order for the mods game scripts

The mods copies of the game scripts carry these changes, oldest first. `lighting_patch.py` and
`bot_patch.py` each refuse to run twice (they look for their own marker) and check that both
copies (`next/js/` and `_assets/r20261021-1/next/js/`) are identical before writing them.

1. `perf_patch.py` wrote the first mods `BiMsX6Xn.js` from `site/`. Later hand edits are not in
   it, so don't run it again on the current files.
2. `lighting_patch.py`
3. The left-handed viewmodel hand edit (table above).
4. `bot_patch.py`
5. `hitreg_patch.py` (needs `bot_patch.py`: it extends the bot options reader and the replay
   options). It runs in stages, each with its own marker; a run only adds the stages that are
   missing.
6. `loadsafe_patch.py`
7. `rankpick_patch.py` (refuses to run twice: it looks for `__aimPlayGate`)
8. `aimcenter_patch.py` (refuses to run twice: it looks for `__aimCrossAlign`)
9. `spotbias_patch.py` (needs `aimcenter_patch.py`; refuses to run twice: it looks for `aimSpotWeights`)
10. `spotvary_patch.py` (needs `spotbias_patch.py`; refuses to run twice: it looks for `aimSpotApply`)
11. `peekmove_patch.py` (needs `spotvary_patch.py`; refuses to run twice: it looks for `aimPeekUpdate`)
12. `round_patch.py` (after `peekmove_patch.py`; refuses to run twice: it looks for `/aim-rounds/round-core.mjs`). It keeps each copy's own line ends.
13. `round_bots_patch.py` (after `round_patch.py`, it refuses to run without it; refuses to run twice: it looks for `/aim-rounds/round-bots.mjs` in `BiMsX6Xn.js`/`CnrSARj_.js` and `a.kind==="roundBot"` in `D_iGclxB.js`). It keeps each copy's own line ends. Normal drills are unchanged: `scripts/test-round-bots-parity.mjs` rebuilds the un-patched files from the script's own pairs and compares drills tick for tick.
14. `maps_callout_patch.py` (after `round_patch.py`; only touches `Dc2Dm9E6.js`; refuses to run twice: it looks for its new regex `/\s+(?=[^\x00-\x7f])|(?<=[^\x00-\x7f])\s+/g`).
15. `ux_result_patch.py` (ux; after `round_patch.py`, independent of 13 and 14; refuses to run twice: it looks for `__aimPb` in
    `OkAdunfX.js` and the Target drill header in `Hwnlm6zD.js`). Result screen only, no sim or
    replay code: the record check `uM` counts earlier runs only (no "new personal best" on a first
    run, a 0-point run or a tie), RunReport gets a tie line, time to kill shows seconds
    (`0.42s`, no delta), and Target drills get their own result header and back label. The
    English for the new strings is in `app/english-fixes.js` ("ux result screen"). Tests:
    `npm run test:result` (`--mods <dir>` patches another copy). It keeps each copy's own line ends.
16. `round_minimap_patch.py` (after `round_patch.py`, independent of 15: it anchors on round_patch's `round-core.mjs` import line and refuses to run without it; only touches `OkAdunfX.js`; refuses to run twice: it looks for `/aim-rounds/round-minimap.mjs`). It keeps each copy's own line ends. Normal drills are unchanged: `scripts/test-round-minimap.mjs` rebuilds the un-patched minimap code from the script's own pairs and compares the canvas calls.

Exact fire rate: every run started after `hitreg_patch.py` saves `exactFireRate: true` in its
replay meta, and a held trigger (continuous full-auto, hip or ADS) fires at the configured rate
(hip: Vandal 9.75/s, Phantom 11, Spectre 13.33, Odin 12). Older runs fired at the tick-rounded rate
(hip: 9.85, 10.67, 12.8, 11.64) and keep it in playback, so scores from before and after aren't
directly comparable for Phantom, Spectre and Odin sprays. Tap fire, bursts and bot fire timing are
unchanged.

`lighting_patch.py` and `bot_patch.py` don't touch the same code, so they give the same bytes in
either order. `app/main.js` also patches `OkAdunfX.js` while serving it (`SHOT_LOOP`,
`ROUTE_LOOP`); those strings are left alone by all of the above.

To start the bot patch over: `git checkout` the three mods files, delete both mods
`C_VPDXvn.js` copies, then run `python -I tools/bot_patch.py`.

## Spot scores (rank-biased spots)

`app/mods/aim-ranks/spot-scores.json` must be rebuilt when a shipped drill's spots change (a new
drill with `rules.spawnerPick`, moved spawners, a different pool). `npm run test:spots` (in `app/`)
fails when a shipped drill has no entry. To rebuild:

```bash
# 1. a test copy of the app with a debug port (empty profile folder, free ports)
AIM_PROFILE=/tmp/aim-test AIM_PORT=8141 app/node_modules/.bin/electron app --remote-debugging-port=9351
# 2. in another terminal
node tools/spot_scores.mjs --cdp 9351 --plots /tmp/spot-plots
```

`--plots` writes a top-down picture per drill (minimap, planned route, spots coloured from blue =
common to red = off-angle) to check the scores by eye. `--only <code>,<code>` rescores some drills
and keeps the rest of the file. Replays keep the scores they were recorded with (replay meta), so
a rebuild never changes old replays.

## Spot alternatives (bot positions vary every round)

`app/mods/aim-ranks/spot-alts.json` must be rebuilt when a shipped pre-aim drill's spots, blocks or
bots change. `npm run test:vary` (in `app/`) fails when a shipped drill has no entry. To rebuild and
check (same test copy of the app as above):

```bash
node tools/spot_alts.mjs --cdp 9351 --plots /tmp/alt-plots
node tools/spot_alts.mjs --cdp 9351 --check
```

`--plots` draws each drill's authored spots (white), their alternatives (orange) and the movement lane of
the authored spot (cyan). The same file holds the lanes the moving bots use (`tools/peekmove_patch.py`). `--only
<code>,<code>` redoes some drills and keeps the rest. A rebuild never changes old replays: they keep
the positions and lanes they were recorded with (`spotPos`, `spotLane` in the replay meta).

## Round mode data

`app/mods/aim-rounds/<map>.json` holds what a round needs on one map. `app/round-scene.js` turns it
into a scene (served by `main.js` as `round-<map>-<side>-<weapon>-<barrierSec>`), the sim runs it
with `app/mods/aim-rounds/round-core.mjs` (tests: `npm run test:round` in `app/`).

```jsonc
{
  "schema": 1, "map": "ascent", "name": "Ascent",
  "spawns": { "attack": [{ "x": 0, "y": 2, "z": 0, "yaw": 1.57 }, ...5], "defense": [...5] },
  // yaw: the game's forward is (-sin yaw, -cos yaw)
  "barriers": [{ "id": "atk-midtop", "team": "attack", "name": "Mid Top",
                 "a": { "x": 0, "z": 0 }, "b": { "x": 0, "z": 0 }, "y": [3, 8.5], "width": 7 }],
  // a team can't cross its own segments while the barriers are up; y = height range of the wall
  "sites": [{ "id": "A", "zone": [[x, z], ...], "y": [4.7, 7.6], "center": { "x": 0, "y": 5, "z": 0 } }],
  // plant zone polygon (x, z) and the feet height range inside it
  "setups": { "defense": { "A": [{ "name": "...", "x": 0, "y": 5, "z": 0 }], "mid": [...], "B": [...] },
              "splits": [[2, 1, 2], ...] },
  // defender spots by group; a round keeps 5 bots, split [A, mid, B] picked from the run seed
  "retake": { "A": [{ "name": "A heaven", "x": 0, "y": 8.09, "z": 0 }, ...2], "B": [...2] },
  // retake staging points: defender bots group here before retaking a planted site
  "attack": {
    "routes": { "A": [{ "name": "A Main", "entry": { "name": "A Main door", "x": 0, "y": 4, "z": 0 },
                        "staging": [{ "name": "A Main 1", "x": 0, "y": 4, "z": 0 }, ...3] }, ...2], "B": [...2] },
    "plant": { "A": [{ "name": "A default", "x": 0, "y": 5, "z": 0 }, ...2], "B": [...2] }
  },
  // attacker bots (the player defends): per site 2 routes, each with 3 staging points (neutral or
  // attacker side, where the bots group up) and an entry waypoint the route passes (the bots' shortest
  // walk + drop path from staging to the plant spots goes within 3 m of it), and 2 plant spots
  // (1 m inside the zone, defusable all around). round-scene copies it into rules.round.attackData
  // (R3 step S4); roundPrepare draws the round's plan from the seed (round-core.mjs).
  "authoring": { ... }   // transform residuals, raw marks, seal check results (real nav graph)
}
```

To rebuild Ascent (`--image` is the barrier reference picture the user supplied; it is only used to
check sides and to draw under the plot, and is not part of the repo):

```bash
node tools/round_author.mjs --image ascent-barriers.png --plot /tmp/ascent-round.svg
node tools/round_author.mjs --check
```

How the barriers are placed (details in the script header): the picture's labels are fitted to the
game's callouts (similarity transform, about 2 m rms), each barrier mark is moved to world space and
snapped to the narrowest closed choke within 3 m (rays against the pawn + greybox collision at three
heights), and a flood fill over the real nav graph (`<map>.nav.bin`, below) checks that each team's
barriers close off every callout outside its side, over walk edges only and over all edges.
`--check` reads the committed nav.bin and needs no collision bake. A new map needs its own entry in `MAPS` at the top of the script (callout names, label and
mark pixels from a reference picture, setup spots) and then the same two commands.

### Other maps (Corrode = `rook`)

Maps without a reference picture use per-map switches in `MAPS` (the script header has the details):

- `WORLD: 'terrain'`: `rook.collision.json` has no greybox and no NavMesh, so rays go against the game's real
  pawn world (`round_terrain.mjs` `loadTerrain`, the triangles the nav bake uses); floor rays start at height
  hints (`SPAWN_Y`, the site marker top, the y of every authored point). Needs the triangle cache (built on
  first use, about 30 s).
- `MINIMAP: 'mod'`: English callouts from `app/mods/aim-maps/<map>.minimap.json`, used as they are.
- `BARRIERS: 'collision'`: the barriers are the map's own placed `SM_Barrier` walls (zero-thickness planes,
  each paired with a vision blocker): segment = the plane's long side, 0.4 m further into the walls at both
  ends, height range from the floors next to it. The team comes from the nav graph: with every barrier up,
  each barrier's cut edges must touch exactly one team's spawn flood (and at least 5 walk edges); anything
  else fails. Id = team + nearest callout. The first run (no nav.bin yet) writes them without a team and
  fails; bake, then run again.
- `CALLOUT_SPOTS`: minimap spots that lie off the floor, moved onto it (Corrode: A Lobby, A Main, A Crane).
- `SIDES` is written by hand from the map (lobbies/attacker spawn attack, sites/defender spawn/back areas
  defense, mains/links/mid neutral). The seal check fails on a leak, on a SIDES callout with no nav node within
  4 m, and on an own callout a team can't reach.

Corrode, from scratch (on hp: `hp.sh run <name> "..."`, one bake at a time):

```bash
node tools/round_author.mjs --map rook          # 1. spawns, barriers (no team yet), sites; fails: no nav.bin
node tools/round_nav.mjs --map rook             # 2. bake (~40 s on Corrode): 21693 nodes, 162053 edges
node tools/round_author.mjs --map rook          # 3. barrier teams + seal check
node tools/round_nav.mjs --map rook --setup-candidates A      # 4. defender setup candidates (also B, mid --near "x,z")
node tools/round_nav.mjs --map rook --candidates A            #    retake staging candidates
node tools/round_nav.mjs --map rook --attack-candidates A --near "x,z|x,z"   # plant + attacker staging candidates
node tools/round_author.mjs --map rook          # 5. after writing SETUPS / RETAKE / ATTACK into MAPS.rook
node tools/round_nav.mjs --map rook --reuse     # 6. header
node tools/round_author.mjs --map rook --check --plot rook-round.svg --attack-plot rook-attack.png
```

Setup candidates (`round_navdata.mjs` `setupCandidates`): defender-walkable inside the defender barriers, open
floor, in the zone or within 12 m, slowest defender spawn -> spot at most 10 s (shortest barrier) + the
attackers' fastest barrier -> zone time - 1 s, sees at least one defender barrier (where attackers come in)
within 30 m and is seen from at most 2 (the bots' sight test); it also reports `hiddenAtk` (no attacker
barrier sample sees it), and the picks must include at least one such spot per site (tested). Thresholds
that differ from Ascent's are written down in `MAPS.<map>.NOTES` (copied to `authoring.notes`).
`scripts/test-round-nav.mjs` runs every check for every map that has a json + nav.bin (per-map counts in its
`EXPECT`), loads the real collision for each (building the cache if needed, never skipped) and runs
`round_author.mjs --check --map <map>` with the full rebuild.

## Round mode nav graph

`app/mods/aim-rounds/<map>.nav.bin` is the graph Round mode bots walk on. Format v1 (little-endian,
reader/writer in `app/mods/aim-rounds/round-nav.mjs`): `"RNAV"`, u32 version, u32 header length,
header JSON, then per node f32 x / y (floor) / z, then CSR edges `edgeStart[n+1]`, `edgeTo`,
`edgeCost` (seconds at run speed), `edgeType` (0 walk, 1 drop, 2 jump up, 3 two-cell gap).
The header holds the bake parameters and grid origin, `source` (sha256 of the collision file, the
GLB and the terrain worker it was baked from), and data that needs real sight rays
(`tools/round_navdata.mjs` documents every field):

```jsonc
"inputs":  { "file": "app/mods/aim-rounds/ascent.json", "sha256": "..." }, // spawns/barriers/sites/setups/retake/attack
"setups":  { "A site default": { "group": "A", "node": 16919, "walk": true,
             "face": 1.3264, "face2": 0.5113, "faceNode": 1234, "face2Node": 2345, "faceT": 9.1, "spawnT": 10.33 } },
"staging": { "A": [{ "name": "A heaven", "node": 20862, "t": 2.97, "hidden": true,
             "los": { "body": false, "head": false }, "reach": true }, ...] },
"zones":   { "A": { "samples": 716, "noDefuseNode": 0.0042, "bad": [[x, y, z], ...] } },
"siteGoals": { "A": { "node": 0, "x": 0, "y": 5, "z": 0 } },
"attack":  { "plant": { "A": [{ "name": "A default", "node": 17301, "margin": 5.83, "inZone": true, "reach": true,
                                 "nearOk": true, "near": 12, "spawnT": 17.53 }, ...] },
             "staging": { "A": [{ "route": "A Main", "entry": { "name": "A Main door", "node": 12339 },
                                  "staging": [{ "name": "A Main 1", "node": 10495, "side": "neutral", "reach": true, "spawnT": 13.09,
                                                "wait": { "node": 7355, "t": 2.78 }, "plantT": [4.44, 4.26], "entryD": [0, 0] }, ...] }, ...] },
             "postPlant": { "A": { "A default": [{ "node": 0, "x": 0, "y": 4, "z": 0, "d": 19.55, "seen": 0 }, ...4] } } }
```

`face`/`face2` are bot facings in the sim's convention (`facingYaw = atan2(dx, dz)`, radians):
toward the place attackers reach first (walk, drop and jump edges from their spawn) among the nodes
the bot can see from the spot within 30 m
(`face2`: the best one at least 40 deg away). `walk`: the defender bots can walk (walk + drop edges)
there from their spawn with the barriers up. `staging` re-checks the authored retake points
(time to the site, hidden from 1 m above the site centre). `zones`: share of spike spots in the
plant zone with no defender-walkable node within the defuse range (1.6 m, |dy| < 2).
`attack` (round mode R3, the attacker bots): plant spot checks (margin inside the zone, every
attacker node within 1 m in the zone and defusable), staging checks (barrier-phase side, reached from
every attacker spawn, the wait node behind the attacker barriers, walk + drop time and entry distance
to each plant spot) and the post-plant spots per plant spot: 6-20 m away, attackers walk there, the
bots' sight test from eye height to the spike (0.3 m above the floor) is clear; fewest retake points
seeing them first, then the attackers' side; 4 per spot, 4 m and 20 deg apart.

`tools/round_nav.mjs` builds it: `loadTerrain` (`tools/round_terrain.mjs`) rebuilds the pawn
collision, the game's nav builder `Vv` (lifted from `OkAdunfX.js`) runs from the attacker and the
defender spawn with the game's parameters, and the two graphs are merged by cell and floor height.
It takes 2-3 minutes on one core and drops its own priority to below normal. The first run also
decodes the map (about 20 s) and caches the triangles in `%TEMP%/open-aim-round-cache/`.

Tool order after a change:

```bash
node tools/round_author.mjs         # 1. map json (spawns, barriers, sites, setups, retake, attack) + seal check
node tools/round_nav.mjs            # 2a. full bake when spawns or the map collision changed (Ascent: 21746 nodes, 161371 edges)
node tools/round_nav.mjs --reuse    # 2b. otherwise: keep the graph, rewrite the header (1-2 min)
                                    #     (--candidates <site> lists retake staging candidates)
node tools/round_author.mjs --check # 3. the seal numbers still match the graph
                                    #     (--attack-plot <file.png>: routes, plant and post-plant spots)
```

`--plot <dir>` draws the setups with their facing arrows, the staging points with their paths and
the plant zones' no-defuse spots; `--report <file.json>` writes the travel-time report (defender
spawn to setups, attacker spawn to attacker barriers, worst setup to each site + 7 s defuse).

`npm run test:round` (scripts/test-round-nav.mjs) fails when the collision, GLB or terrain worker
no longer match the hashes in the header (rerun the full bake) or when the map json's inputs changed
(rerun with `--reuse`). It also checks setups (every split finds enough walkable spots), staging
points, zone coverage and the attacker data (staging never on the defender side, routes pass their
entry, plant spots defusable all around, post-plant spots re-checked with real sight rays when the
terrain cache exists).


## Callout names

The game's map files name their callouts in Chinese (`site/aim-maps/<map>.minimap.json`, e.g.
"A区 大厅"). `tools/maps-callouts-en.json` lists, per map and in the same order, each Chinese name
and Riot's in-game English name for it (valorant-api.com, `zh-CN` vs `en-US` map data: same
callouts, same order, on all 9 maps). `maps_callouts.mjs` writes the English copies into
`app/mods/aim-maps/`, which the app serves in place of `site/` at the same URL, so the big map
(M), the workshop cards and the pre-aim result all show "A Lobby", "B Boat House", "Mid Tiles".
It stops if a map file's names don't match the data (name, count or order), and juliett's spots
must match the x / z kept in the data file. After changing the data:

```bash
node tools/maps_callouts.mjs          # write app/mods/aim-maps/<map>.minimap.json
node tools/maps_callouts.mjs --check  # what scripts/test-maps-callouts.mjs runs (npm run test:maps)
```

The English names replace the Chinese ones for every UI language, so the Vietnamese UI shows
the English callouts too.
