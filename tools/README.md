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
| `make_training_set.py` | Generated the original 25 scenarios. New scenarios go straight into `scenarios/` instead. |

```bash
python -I tools/make_icon.py
```
