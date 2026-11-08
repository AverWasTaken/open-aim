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
| `drill:<category>` | one drill per lobby category chip (Pre-aim, Angle holding, Anti-flash, Scenarios, Fundamentals): the chip lists the pinned card, the drill loads, starts, and the aim helper gets a kill within about 10 s (the Scenarios drill ends itself after 7 s). Drills marked `noKillOk` in `drills.json` (Pre-aim, Anti-flash: the bots are behind cover until the player walks, and the suite does not walk) only need our shots to register. Bot drills are launched directly (no rank picker); the `rank-picker` step covers the card path for those. The Fundamentals drill is launched directly too when result-replay follows (see there) |
| `result-replay` | continues from the Fundamentals drill played to its end: result screen, replay opens and plays. The result screen only has the Watch button for runs that did not start from a workshop card (game rule: `lastReplay && (!workshopSource \|\| ball drill)`), so that drill is launched with `__aimLaunchScene` |
| `play-again` | Play again from the result screen restarts the drill |
| `pause` | losing the mouse lock pauses (light menu), Resume; Tab opens the full menu, Resume; Restart |
| `settings` | sensitivity changed in the lobby survives a page reload, then is restored |
| `rank-picker` | a card click on a bot drill shows the rank picker; Gold launches and is saved; leaves through the start screen's own Back button (`.al-scene-start-back`; the start overlay lies over `.hall-train-exit` and starts the drill on any click) |
| `studio` | Studio: new Flicks drill, Play opens it in the trainer, it runs, Exit returns to Studio. Sets `studio-coach-done` first: on a fresh profile the first-run tour covers the editor |
| `round` | Round: panel, start with the default map and side, round HUD live, Exit resets the round state. A load that falls back to the lobby (known app bug) is warned and started once more |
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
- If hp is busy (both copy slots taken, our ports in use, a gradle build, load 5+, low memory),
  the suite exits 4 without starting anything and the wrapper tries again every 60 s, up to
  `--wait` minutes (default 30).
- Outputs are copied to `open-aim-hq\shots\qa\smoke-<hpname>-<stamp>\b<N>\`, removed from hp,
  and each batch's `summary.txt` is printed.

On hp the suite only starts the app through `~/hp-share/openaim-start.sh` and only stops it through
`~/hp-share/openaim-stop.sh <hp worktree name>`. Since 2026-11-07 ~21:00 the launcher runs up to two
copies at once on hp's Intel GPU: it prints `started <pid> slot <n>` and writes
`~/hp-share/openaim-slot<n>.lock` (line 1 pid, line 2 `open-aim <time> port <p> cdp <c> app <dir>`).
The suite stops its copy only while that slot's lock still names its own pid and port, and always
passes the worktree name (taken from the app dir `.../open-aim-wt/<name>/app`; a bare
`openaim-stop.sh` stops every copy on hp, so the suite refuses to start when the app dir has no
such name). A detached guard does the same checked stop if the runner is killed, or after
`--max-minutes` + 3. If someone else stops the copy mid-run (`hp.sh app-stop <name>`, a bare
stop, or the launcher's 15-minute reaper), the run aborts with exit 4 and does not touch the
lock. The fresh profile `/tmp/openaim-profile-<port>` is only deleted when no slot lock (or
half-started slot) names our port and nothing listens on our ports. Known limits: between
reading the lock and running the stopper there is a gap of a few milliseconds; the stopper stops
every copy started from the same hp worktree (only one smoke run per worktree can run anyway,
same ports); and if our copy dies by itself and leaves its lock, the stopper only removes the lock
(the suite never kills processes itself), so anything left in that session shows up in the
`leftovers` line of `run.log` / `results.json`.

Timing on hp: see "Timing" below. A gate running at the same time slows the app down further.

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
| 129 / 130 / 143 | stopped by SIGHUP / SIGINT / SIGTERM (131: SIGBREAK on Windows); the copy is stopped |

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

Every click goes through `clickSel`, which waits until `elementFromPoint` at the target's centre is the target, so an overlay on top fails the step with "covered by ..." instead of taking the click.

## Errors and the allowlist

A step fails on any uncaught page exception, any page `console.error` / network error, and any
`ERROR` line in `main.log` (except `PAGE ERROR:` lines, which repeat page errors CDP already
reported). Warnings are listed but do not fail. Allowed errors (`ALLOW` in `lib.mjs`, each with a
reason; `hpOnly` marks noise seen only on the hidden hp copy):

- 404 on `/prod-api/api/v1/public/val/aimlab/desktop-seen`: offline build, no server for the ping.
- 404 on `/aimlab/plays/workshop/<code>`: offline build, no play counter server.
- 404 on `/aimlab/lock-events`: offline build, no pointer-lock telemetry server.

## Timing

Measured with `--only=probe` on hp (hidden copy, xvfb, nice 15-19). Until 2026-11-07 ~20:00 the
copies drew with software WebGL; since then on the Intel GPU (60 fps, about half a core). "Load" is launch
until the start screen can take a start (workshop loader gone, button not covered or disabled);
"start" is the Enter/click until the drill runs with the mouse lock (it includes the drill
preparation). Frame rates are the page's `requestAnimationFrame` rate; they are function-check
numbers only, not game FPS.

| hp state (load avg, 8 cpus) | drill | load first / repeat | start | sim seconds per wall second | page fps |
|---|---|---|---|---|---|
| quiet (3.4-3.9; 2026-11-07 18:15) | Micro tiles (targets) | 4.8 s / 3.9 s | 0.4 s | 1.00 | ~60 |
| quiet (3.4-3.9) | DDY's pre-aim, Ascent (map) | 4.5 s (after one lobby fallback, see below) / 4.4 s | 0.4 s | 1.00 | ~60 |
| busy (9.8-11.2, Soprano play-test; 17:34) | Micro tiles | about 20-30 s / about 20-30 s (from the load timeline; that run still had the old ready check) | 7-9 s | 0.98 then 0.24 | 0.4-2 during loads, 2-8 in the drill |

- On a busy hp everything slows down unevenly: the sim fell to a quarter of real time at about
  2 frames per second, so a 60 s drill takes about 4 minutes of wall time. The suite waits out
  loads (up to 180 s for drills) and the drill preparation after a start, but its timers are wall
  time, so a very busy hp can still fail steps on time. hp's own busy check refuses to start at
  load 3 or more, so most runs get the quiet numbers.
- A gate (`hp.sh gate`) running at the same time slows the app down further (nice 19 both).

## How a start is detected

The start button already shows while the workshop loader is still preparing the drill. During that
time it sits under `.al-wkload-stage`, and the loader's own panel (`.aim-scenario-loading`)
swallows every key in the capture phase. The suite therefore waits until no `section.al-wkload` and
no `.aim-scenario-loading` exist, the button is enabled, and `elementFromPoint` at its centre is the
button. Only then does it press Enter (later tries click the button). After a press it waits out
the drill preparation panel instead of pressing again. If a start does not take, `run.log` gets a
`start try N did not take` line with focus, lock, input counters (did our key reach the page and
the game's window listener), the trainer store (`phase`, `mapLoading`), the loader state, what sits
on top of the button, and the frame rate, plus a load timeline and a screenshot per try.

Kills: a hit target counts as killed when a later frame shows it dead or respawned (its `bornTick`
changed). Targets that respawn at once can die and come back between two frames when frames are
slow, so the `alive` flag alone misses them.

Aim: sphere targets are aimed at their centre; humanoid bots at the head (`position + offset` is
their feet; head centre 1.88 m up standing, 1.48 m crouched, times `scale` x `headSize`). Body
shapes come from the scene doc (`/prod-api/api/v1/public/val/aimlab/scenes/<code>`), fetched at
launch. The helper fires single taps, only once the aim is on a target.

## Known app bugs (found by the suite; not worked around silently)

- **A map drill's first load can end in the lobby with no error.** Seen on hp both quiet and busy,
  on the first load of a map in the session; the repeat load works. In the full run of 2026-11-07
  22:23 it hit every map drill after a fresh page (DDY's pre-aim and Ascent dock on Ascent, Erv's
  Sheriff 5k on Haven) and most likely Round on Ascent. Repro: fresh page (`location.assign('/aim')`),
  launch any map drill, wait without input: the loader closes to the lobby when the map finishes. Load
  timeline from the quiet run, no input sent: launch 51.0 s; start button disabled "LOADING MAPS..."
  from 51.3 s; `ascent.collision.json` / `ascent.lights.json` loaded at 51.4 s; workshop
  preparation "Preparing visuals" 52.7 s, "Finishing up" 56.4 s, and in the same 200 ms poll the
  button turned enabled (session map load done); lobby at 56.6 s. Likely cause (code reading): when
  the session's map load finishes it rebuilds the scene (`loadScene`), which bumps the scene
  generation the running workshop preparation checks; the preparation then throws an `AbortError`,
  which the loader treats like the player pressing Back (`scenario-loading.mjs`
  `if (error?.name === 'AbortError') back()`), so it closes to the lobby without the failure panel.
  The suite logs a warning with the timeline and launches the drill once more; a second fallback
  fails the step.
