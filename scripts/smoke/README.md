# In-app smoke suite

Starts one hidden copy of the app with a fresh profile, clicks through the main flows over
the Chrome DevTools Protocol (CDP), and fails if a flow breaks or an unexpected error shows up.
It is opt-in (`npm run smoke`); only its unit tests (`npm run test:smokelib`) are in the gate.

## What it covers

`npm run smoke -- --list` prints the steps. In order:

| step | checks |
|---|---|
| `boot` | lobby ready on a fresh profile; the first-run "Import VALORANT settings" box shows and closes (runs in every batch) |
| `lobby` | every top tab opens without leaving the lobby |
| `drill:<category>` | one drill per lobby category chip (Pre-aim, Angle holding, Anti-flash, Scenarios, Fundamentals): the chip lists the pinned card, the drill loads, starts, and the aim helper gets a kill within about 10 s |
| `result-replay` | continues from the Fundamentals drill played to its end: result screen, replay opens and plays |
| `play-again` | Play again from the result screen restarts the drill |
| `pause` | losing the mouse lock pauses (light menu), Resume; Tab opens the full menu, Resume; Restart |
| `settings` | sensitivity changed in the lobby survives a page reload, then is restored |
| `rank-picker` | a card click on a bot drill shows the rank picker; Gold launches and is saved |
| `studio` | Studio: new Flicks drill, Play opens it in the trainer, it runs, Exit returns to Studio |
| `round` | Round (beta): panel, start, round HUD live, Exit resets the round state |
| `probe` | only with `--only=probe`: load times (first and repeat), sim speed, frames per second |

The pinned drills live in `drills.json`. If one disappears from the list, the step says so; pick
another light drill in that category.

## Run it on hp (the normal way)

Nothing heavy runs on the PC. From inside the worktree you want to test, in Git Bash:

```bash
bash /c/Users/Jacob/open-aim-hq/qa-smoke.sh <hpname>            # sync, then all batches
bash /c/Users/Jacob/open-aim-hq/qa-smoke.sh <hpname> --only=boot,settings
```

- It syncs the worktree to hp (`hp.sh sync <hpname>`; skip with `--no-sync`), then runs the suite
  there with `hp.sh run`.
- Without `--only` it runs two batches. Each batch is its own app start, capped at 12 minutes
  (`--max-minutes=12`), so no copy stays up longer than that. The smoke run is the one sanctioned
  check that may go past the usual 10 minutes per start.
- If hp is busy (Soprano play-test, high load, another team's copy), the suite exits 4 without
  starting anything and the wrapper tries again every 60 s, up to `--wait` minutes (default 30).
- Outputs are copied to `open-aim-hq\shots\qa\smoke-<hpname>-<stamp>\b<N>\`, removed from hp,
  and each batch's `summary.txt` is printed.

On hp the suite only starts the app through `~/hp-share/openaim-start.sh` (it owns the one-copy
lock, the busy checks, xvfb and the profile `/tmp/openaim-profile-<port>`) and only stops it
through `~/hp-share/openaim-stop.sh`, and only while `~/hp-share/openaim.lock` still names its own
pid and port. A detached guard does the same checked stop if the runner is killed, or after
`--max-minutes` + 3. If someone else stops the copy mid-run (`hp.sh app-stop`), the run aborts
with exit 4 and does not touch the lock. Known limit: between reading the lock and running the
stopper there is a gap of a few milliseconds.

Timing on hp (hidden copy, software WebGL, about 19 fps, nice 19): see "Timing" below. A gate
running at the same time slows the app down further.

## Run it locally (direct mode, untested)

On a machine without `~/hp-share/openaim-start.sh` the suite spawns electron itself
(`app/node_modules/electron/dist/electron[.exe]`) with `AIM_HEADLESS=1`, a fresh profile under
`app/smoke-out/`, and the first free qa port pair (8270/9470, 8275/9475, ...). It refuses the
real save (`%APPDATA%\AimTrainer`, `~/.config/AimTrainer`) and port 8000. `SMOKE_SLOT_DIR` turns
on app slots (at most 3 copies on one machine). This mode has not been run since the hp move;
never use it on the user's PC.

```bash
cd app && npm run smoke -- [--only=a,b] [--skip=a,b] [--list] [--out=dir] [--port=N --cdp=N] [--max-minutes=20] [--profile=dir]
```

`--only=drill` / `--skip=drill` match every `drill:<category>` step. `--profile` is refused on hp.

## Exit codes

| code | meaning |
|---|---|
| 0 | every step passed, no unexpected errors |
| 1 | a step failed (or the harness hit an error) |
| 2 | bad arguments, or the launcher refused the app folder |
| 3 | hard time cap (`--max-minutes`) reached |
| 4 | not run: hp busy, or the copy was stopped by someone else mid-run |
| 5 | the ssh session dropped (output pipe gone); the copy is stopped |

`qa-smoke.sh` returns the first non-zero batch code, and 255 means ssh to hp failed. A
preempted batch (exit 4) is retried like a busy one; its screenshots are kept in `b<N>-try<K>\`.

Exit 5 relies on the runner printing a line at least every 10 s: when the PC's ssh dies, the
next write fails and the runner stops the copy. If the network drops without closing the
connection, that only happens once ssh gives up on it; until then `--max-minutes` (and the guard
at `--max-minutes` + 3) bounds how long the copy can stay up.

## Output files

In the output folder (`app/smoke-out/smoke-<stamp>/` by default, `--out` to change; on hp the
wrapper copies it to the PC):

- `summary.txt`: one line per step (pass/fail, time, errors, notes).
- `results.json`: the same plus app pid, ports, timings, warnings.
- `NN-<step>.png`: a screenshot at the end of every step (plus a few mid-step ones).
- `run.log`: everything the runner printed.
- `main.log`: the app's own log (`<profile>/AimTrainer/logs/main.log`).
- `electron.log`: electron/xvfb output. Saved for debugging, never scanned for errors.
- `guard.log`: what the cleanup guard did.

## Errors and the allowlist

A step fails on any uncaught page exception, any page `console.error` / network error, and any
`ERROR` line in `main.log` (except `PAGE ERROR:` lines, which repeat page errors CDP already
reported). Warnings are listed but do not fail. Allowed errors (`ALLOW` in `lib.mjs`, each with a
reason; `hpOnly` marks noise seen only on the hidden hp copy):

- 404 on `/prod-api/api/v1/public/val/aimlab/desktop-seen`: offline build, no server for the ping.
- 404 on `/aimlab/plays/workshop/<code>`: offline build, no play counter server.
- 404 on `/aimlab/lock-events`: offline build, no pointer-lock telemetry server.

## Timing

Measured with `--only=probe` on hp (hidden copy, xvfb, software WebGL, nice 19):

(filled in from the probe run)
