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
| `feel_xbloom_patch.py` | Crosshair spread: the in-game crosshair lines move out while you move or spray, like VALORANT, following each line's Movement/Firing error settings (see the patch order below). |
| `round_author.mjs` | Writes `app/mods/aim-rounds/<map>.json` (Round mode map data: spawns, barriers, plant zones, defender setups) from the map files in `site/aim-maps/`, node only. `--plot <file.svg>` draws it (also a `.png`), `--check` fails when the stored file is out of date. See [Round mode data](#round-mode-data). |
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
13. `feel_xbloom_patch.py` (after `round_patch.py`; refuses to run twice: it looks for `aimErrDeg` /
    `__aimXbloomStep`). Crosshair spread: a read-only `aimErrDeg()` on the sim object (`CnrSARj_.js`)
    returns the firing error above the gun's resting error and the movement error, in degrees (no RNG
    draw, no state write: runs and replays are unchanged). The play page (`OkAdunfX.js`) turns them into
    pixels from the camera FOV each frame and `StageCrosshair` adds them to the inner/outer line offsets
    per the profile's `inner/outerMovementError(Scale)` and `inner/outerFiringError(Scale)` (rounded to
    0.5 px, a line's offset capped at 60 px; a still crosshair never re-renders). Game recoil and game
    movement only (the live defaults). `fadeWithFiringError` and `overrideErrorOffset` aren't modelled.
    It doesn't touch the regions of `feel_audio_patch.py`; the two apply in either order. Test:
    `npm run test:feelxbloom` in `app/`.

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
  "authoring": { ... }   // transform residuals, raw marks, seal check results
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
heights), and a flood fill over the navmesh checks that each team's barriers close off every neutral
callout. A new map needs its own entry in `MAPS` at the top of the script (callout names, label and
mark pixels from a reference picture, setup spots) and then the same two commands.

