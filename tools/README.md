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

`lighting_patch.py` and `bot_patch.py` don't touch the same code, so they give the same bytes in
either order. `app/main.js` also patches `OkAdunfX.js` while serving it (`SHOT_LOOP`,
`ROUTE_LOOP`); those strings are left alone by all of the above.

To start the bot patch over: `git checkout` the three mods files, delete both mods
`C_VPDXvn.js` copies, then run `python -I tools/bot_patch.py`.
