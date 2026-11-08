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
| `drill:<category>` | one drill per lobby category chip (Pre-aim, Angle holding, Anti-flash, Scenarios, Fundamentals): the chip lists the pinned card, the drill loads, starts, and the aim helper gets a kill within about 10 s (the Scenarios drill ends itself after 7 s). A drill with no kill gets one more try from a fresh launch (noted in the summary); no kill twice fails. Drills marked `noKillOk` in `drills.json` (Pre-aim, Anti-flash: the bots are behind cover until the player walks, and the suite does not walk) only need our shots to register. Bot drills are launched directly (no rank picker); the `rank-picker` step covers the card path for those. The Fundamentals drill is launched directly too when result-replay follows (see there) |
| `result-replay` | continues from the Fundamentals drill played to its end: result screen, replay opens and plays. The result screen only has the Watch button for runs that did not start from a workshop card (game rule: `lastReplay && (!workshopSource \|\| ball drill)`), so that drill is launched with `__aimLaunchScene` |
| `play-again` | Play again from the result screen restarts the drill |
| `pause` | losing the mouse lock pauses (light menu), Resume; Tab opens the full menu, Resume; Restart |
| `settings` | sensitivity changed in the lobby survives a page reload, then is restored |
| `rank-picker` | a card click on a bot drill shows the rank picker; Gold launches and is saved; leaves through the start screen's own Back button (`.al-scene-start-back`; the start overlay lies over `.hall-train-exit` and starts the drill on any click) |
| `studio` | Studio: new Flicks drill, Play opens it in the trainer, it runs, Exit returns to Studio. Sets `studio-coach-done` first: on a fresh profile the first-run tour covers the editor |
| `round` | Round: panel, start with the default map and side, round HUD live, Exit resets the round state. A load that falls back to the lobby (see "Lobby fallback") is warned and started once more |
| `probe` | only with `--only=probe`: load times (first and repeat), sim speed, frames per second |
| `soak:*`, `edge:*` | only with `--only`: see "Soak and edge groups" |

The pinned drills live in `drills.json`. If one disappears from the list, the step says so; pick
another light drill in that category.

## Soak and edge groups (opt-in)

Two extra step groups look for bugs a player would hit and measure stability. They are never
part of the default run (that stays two batches of about 2 minutes each); run them on their own:

```bash
bash /c/Users/Jacob/open-aim-hq/qa-smoke.sh <hpname> --only=soak   # 2 batches: soak:retries, soak:switch
bash /c/Users/Jacob/open-aim-hq/qa-smoke.sh <hpname> --only=edge   # 2 batches (list below)
bash /c/Users/Jacob/open-aim-hq/qa-smoke.sh <hpname> --only=edge:hitch,edge:resize   # any steps, one start
```

The wrapper turns `--only=soak` / `--only=edge` (exactly that value) into batches of their own,
each its own app start under the 12-minute cap. A failing soak/edge step is a finding about the
app: its notes carry the numbers and a repro, and its screenshots are in the batch folder. Soak
and edge steps also fail on main.log health lines that are only warnings for the default steps:
`CHILD PROCESS GONE` (unless `reason=clean-exit`), `PAGE NOT RESPONDING`, `PAGE RELOAD`.

The first soak/edge step that needs counters installs a page probe and reloads `/aim` once. The
probe wraps `WebGL(2)RenderingContext.prototype.create*/delete*` (textures, buffers,
framebuffers, renderbuffers, programs, shaders, vertex arrays) and the `AudioContext` and
`Worker` constructors, so live object counts can be read (WebGL objects are held by weak reference, so objects the page dropped and the browser collected do not count). Runs without such a step never get it.

| step | what it does | fails when |
|---|---|---|
| `soak:retries` | bot drill (Angle holding; the aim helper gets kills): up to 40 restarts through the light pause menu (lock lost, Restart), shots each cycle; then up to 10 retries with R from the result screen of the 7 s Scenarios drill. Self-budget 8 min. Samples each restart in the paused menu / on the result screen; GC (twice) before every 2nd pause sample and every result sample. Writes `soak.csv` row by row | a slope or growth rule below fails |
| `soak:switch` | cycles lobby, Micro tiles, lobby, Ascent pre-aim, lobby, Round, lobby (up to 8 cycles, budget 8 min); samples in the lobby after GC. Writes `soak-switch.csv` | the same rules, per cycle, from cycle 1 on |
| `edge:blur` | Ascent pre-aim: holds W + left mouse, then alt-tab (lock lost + window `blur`, no key-up or mouse-up), 2.5 s paused, Resume | the player keeps walking or firing for 2 s after Resume; the player moves while paused; the timer runs while paused although "Pause timer" is on; the drill does not go on |
| `edge:rapid-retry` | R every 50 ms for 2 s as the Scenarios result appears; then 10 restarts back to back (lock lost + T) | not exactly one retry from the result; R restarts a running drill; more than one trainer root or HUD; `__aimTick` rate over 1.5x the baseline (a doubled game loop); more live AudioContexts than before; no shot in a normal run after |
| `edge:hitch` | Micro tiles: a 2.5 s busy loop on the page's main thread mid-drill | the sim runs ahead of real time, sim speed after is outside 0.8-1.25, under 20 fps 3 s later, the HUD timer drops more than wall time + 1 s |
| `edge:start-overlay` | Ascent pre-aim: clicks the screen centre every 300 ms while the loader is up (it clicks the loader on purpose, so no covered-click check here) | falls back to the lobby, the load fails, the loader is stuck for 60 s, more than one trainer root or HUD, the drill does not run |
| `edge:back-spam` | backs out of an Ascent load (Esc x5, then any uncovered back button) and launches Micro tiles at once; Esc x6 on a result screen; lock lost + Esc x6 in a drill; a drill still starts | the next drill shows another drill's actors or stops running; Esc on the result screen leaves neither the result nor the lobby; in-drill Esc leaves no pause menu. No way to cancel a load is a warning |
| `edge:resize` | `Emulation.setDeviceMetricsOverride` 1280x720, 800x600, 1920x1080, 1024x768 @1.25, 1280x720 @1.5, in the lobby and mid-drill (tries `Browser.setWindowBounds` once first; the override is cleared in `finally`) | wrong page size, top nav outside the window, the canvas does not fill the view (2 px), the drawing buffer does not follow (buffer / (css x dpr) differs by over 10% between sizes), a DOM crosshair off centre by over 2 px, HUD text outside the view, no shot after. Sideways scroll in the lobby is a warning |
| `edge:settings-mid` | in a drill: Tab menu, Settings (the lobby's settings dialog, "changes save right away and apply to this run"): sensitivity typed on General, the first switch on Crosshair, FOV and a quality choice on Video, then Done and Resume; the localStorage snapshot is restored after | no sensitivity box in the dialog; the typed sensitivity is not saved; the camera does not turn by the new sensitivity at once (yaw for 100 counts off by over 10%); the drill does not resume and register shots. Crosshair / FOV / quality controls that are not found, or that save nothing, are warnings (best effort) |
| `edge:saved` | writes garbage, then wrong-type values into saved settings (`al-sensitivity-v1`, `al-display-settings-v1`, `aim-bot-mode`, `aim-enemy-rank`, `aim-rank-picks`, `aim-round-setup`, `aim-unlimited-v1`, history-like keys) and reloads | the lobby does not come up, page errors, the camera yaw goes non-finite or does not turn, the sensitivity box shows a non-number. The exact localStorage snapshot is restored after (never `clear()`) |
| `edge:sens` | types into the lobby sensitivity box (`Input.insertText` + Enter + blur): 0.001, 10, 0.0001, 11, 99999, -1, 0, abc, empty, 1e3, 0.5; then 10 and 0.001 in a drill after a reload | a stored value outside 0.001-10 or not a number; shown and stored differ; not kept over a reload; yaw for 100 counts off by over 10% from 0.07 deg x sens. Restored after |

Run the groups through the wrapper: `npm run smoke -- --only=soak` (or the wrapper's space form
`--only soak`) puts both soak steps into one app start, and their time limits (10.5 min each) go
past the 12-minute cap. Only the exact `--only=soak` / `--only=edge` value is split into batches.

Edge batches: 1 = `edge:blur,edge:rapid-retry,edge:hitch,edge:start-overlay,edge:back-spam`,
2 = `edge:resize,edge:settings-mid,edge:saved,edge:sens` (sens last: it changes the
sensitivity, then restores it).

### Soak thresholds and why

Before each GC'd sample the suite drops the inspector's stored console messages
(`Runtime.discardConsoleEntries`), so objects kept only for the console don't look like a leak.
Slopes are Theil-Sen (the median of all pairwise slopes), so one odd sample (a late GC, a
texture upload in flight) barely moves them. The pause path is judged from restart 10 on (the
first restarts warm caches), the result path from retry 2 on and on its own (it may grow its
run history on purpose), `soak:switch` from cycle 1 on (the first cycle loads the map).

| metric | source | rule |
|---|---|---|
| JS heap after GC | `Performance.getMetrics` JSHeapUsedSize after `HeapProfiler.collectGarbage` x2 | over 200 KB/restart warns, over 1 MB/restart fails |
| DOM nodes | getMetrics Nodes, GC'd samples only (the count includes garbage until a GC) | over 5/restart warns |
| JS event listeners | getMetrics JSEventListeners (GC'd samples only); window and document listeners via `getEventListeners` (every sample) | 0.5/restart or more fails (a listener added per restart and never removed); the types that grew are in the notes |
| live WebGL objects | page probe (textures, buffers, framebuffers, renderbuffers, programs, vertex arrays): made, not deleted, still reachable (weak reference), in a live, not-lost context; GC'd samples only (the browser frees an object whose wrapper is collected) | 0.5/restart or more fails |
| live WebGL contexts | page probe | any growth fails |
| lost WebGL contexts still reachable | page probe (a context Chrome force-lost, e.g. once a page has too many, whose object is still held after GC: an old drill's canvas/renderer kept) | any growth fails |
| WebGL context / canvas / WebGLBuffer / WebGLTexture objects on the heap | `Runtime.queryObjects` after GC (cross-check without the probe) | contexts, canvases: any growth fails; buffers, textures: 0.5/restart or more fails |
| live workers | page probe (`Worker` made minus terminated) and CDP worker targets | any growth (median of the last 3 samples above the first 3) fails |
| live AudioContexts | page probe (made minus closed) | any growth fails |
| renderer PSS | `/proc/<pid>/smaps_rollup` of the copy's session processes, by `--type=` | over 2 MB/restart warns |

`soak.csv` columns: `x` (restarts done), `path`, `t_s`, `gc`, the metrics above, renderer, GPU
and browser RSS, `load1` (hp load), `restart_ms` (how long the restart before the sample took).

### Startup time

Every run records the startup timeline of its app start: launcher spawn, the shell's `START:`
line in main.log, CDP attached, lobby ready, plus the hp load at that moment. It is in
`results.json` (`startup`), the summary header and `run.log`. Relative numbers only (hp is
shared and its load changes).

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
every copy started from the same hp worktree, so the suite does not start (exit 4, busy) while
another copy from its worktree runs (for example the team's own `hp.sh app-start <name>` copy),
and logs a WARNING if one appears during the run (its stop would hit that copy too; the guard,
which only runs when the runner died, stops without that warning); and if our copy dies by itself and leaves its lock, the stopper only removes the lock
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

Measured with `--only=probe` on hp (hidden copy, xvfb, nice 15-19). "Load" is launch until the
start screen can take a start (workshop loader gone, button not covered or disabled); "start" is
the Enter/click until the drill runs with the mouse lock (it includes the drill preparation).
"Page fps" is the page's `requestAnimationFrame` rate over 1-2 s; the probe also prints
`__aimTick` calls per second, which is not a frame rate. Function-check numbers only, not game FPS.

Current numbers (Intel GPU copies, since 2026-11-07 ~20:00; probe run 2026-11-08 01:01; the load
was under 5 when the copy started and rose during the run):

| hp load (8 cpus) | drill | load first / repeat | start | sim seconds per wall second | page fps |
|---|---|---|---|---|---|
| 5.4-7.0 | Micro tiles (targets, no map) | 4.6 s / 5.3 s | 0.4 s | 1.00 | 60 |
| 5.4-7.0 | DDY's pre-aim, Ascent (map) | 10.7 s / 4.7 s | 0.4 s | 1.00 | 60 |

A full run is about 2 min 10 s per batch on a quiet hp (batch 1: 8 steps incl. a 60 s drill
played to its end; batch 2: 7 steps), far under the 12-minute cap. The two batches are kept so
one busy spell or preemption only costs half a run; step time limits stay generous (drill loads
180 s, steps 5-8 min) because a busy hp slows everything down unevenly, see below.

Earlier, on software WebGL (before the Intel GPU), with the old ready check:

| hp state | drill | load first / repeat | start | sim s/s | page fps |
|---|---|---|---|---|---|
| quiet (load 3.4-3.9; 2026-11-07 18:15) | Micro tiles | 4.8 s / 3.9 s | 0.4 s | 1.00 | ~60 |
| busy (load 9.8-11.2, Soprano play-test; 17:34) | Micro tiles | about 20-30 s each (from the load timeline) | 7-9 s | 0.98 then 0.24 | 0.4-2 during loads, 2-8 in the drill |

- On a busy hp everything slows down unevenly: the sim fell to a quarter of real time at about
  2 frames per second, so a 60 s drill took about 4 minutes of wall time. The suite waits out
  loads (up to 180 s for drills) and the drill preparation after a start, but its timers are wall
  time, so a very busy hp can still fail steps on time. hp's own busy check refuses to start at
  load 5 or more (3 or more while a gradle build runs).
- A gate (`hp.sh gate`) running at the same time slows the app down further.

## How a start is detected

The start button already shows while the workshop loader is still preparing the drill. During that
time it sits under `.al-wkload-stage`, and the loader's own panel (`.aim-scenario-loading`)
swallows every key in the capture phase while it is shown (a hidden panel lets keys through; the
suite treats any panel as not ready, to be safe). The suite therefore waits until no `section.al-wkload` and
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

## Lobby fallback (was listed as an app bug; the suite's own launch caused it)

Until 2026-11-08 01:00 the suite's direct launch (`__aimLaunchScene({shareCode, name})`) passed no
map id. A map drill's first load in a page then ended back in the lobby with no error: the loader
prepared the drill before the map was in, the map load that followed rebuilt the scene
mid-preparation, the preparation threw an `AbortError`, and `scenario-loading.mjs` treats that like
the player pressing Back (`if (error?.name === 'AbortError') back()`), so it closed without the
failure panel. Load timeline (2026-11-07 18:15, no input sent): launch 51.0 s; button disabled
"LOADING MAPS..." from 51.3 s; `ascent.collision.json` / `ascent.lights.json` in at 51.4 s;
"Preparing visuals" 52.7 s, "Finishing up" 56.4 s, and in the same 200 ms poll the button turned
enabled (map load done); lobby at 56.6 s. A card click passes the drill's map
(`yt.begin({...mapId})`), so players launching from cards do not hit this. With the map id passed
(from the scene doc's `environment.map`) the fallback has not happened again (full run 01:08:
15/15, no fallback; probe 01:01: first Ascent load 10.7 s, no fallback).

Round: on this branch `app/round-panel.js:177` launches Round with `mapId: null`, i.e. the same
way; one run (2026-11-07 22:23) waited 150 s on the lobby after Start, which fits this case, and
the five full runs since passed. The round team's integration of 2026-11-08 02:06 (BOARD) passes
`mapId: cur.map` and adds Defense, Corrode and Split to the Round panel; after merging that, run
the `round` step again (it uses the panel's defaults). The round and drill steps still detect a fallback (`qa.fellBack`:
a load was seen and the lobby shows with no loader on top), log the timeline, warn
"app bug: ... fell back to the lobby" and launch once more; a second fallback fails the step.
