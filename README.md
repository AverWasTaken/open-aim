<h1 align="center">open-aim</h1>

<p align="center">
  Offline aim training on real VALORANT maps.<br>
  Pre-aim the routes you actually play, then build your own drills.
</p>

<p align="center">
  <a href="https://github.com/AverWasTaken/open-aim/releases/latest/download/AimTrainer-Setup.exe"><b>Download for Windows</b></a>
  &nbsp;·&nbsp;
  <a href="#get-it">How to install</a>
  &nbsp;·&nbsp;
  <a href="#build-your-own-drills">Make a drill</a>
  &nbsp;·&nbsp;
  <a href="CHANGELOG.md">What's new in 1.3.0</a>
  &nbsp;·&nbsp;
  <a href="#run-it-from-source">Run from source</a>
</p>

<p align="center">
  <sub>A personal copy of <a href="https://github.com/unkwsr/open-aim">open-aim by unkwsr</a>, with a few extra features.</sub>
</p>

<p align="center">
  <img src="docs/images/v1.3/hero-sunset.png" alt="Training against bots on Sunset with the RGX Vandal" width="100%">
</p>

<br>

## Train where you play

Walk real routes and clear the angles you'd check in a match. Train on Ascent, Split,
Haven, Lotus, Bind, Corrode, Abyss, Summit and now **Sunset**, or work on your fundamentals
in the training range. Bots peek, flash and shoot back.

**New in 1.3.0:** six Sunset pre-aim drills across A Short, A Tube and B Main.

**One card per drill, you pick who you face.** Drills that used to come as an Easy and a
Hard card are one card now. Press play on a drill whose bots shoot back and pick:
**No return fire** (the Easy version: same route, bots never shoot), **Default** (the
drill's own bots, with the rank they play like) or a rank from **Iron** to **Radiant**.
Enter plays your last pick, which the card also shows. Bot behaviour (Human-like or
Classic) stays in Settings. Scores are kept per version: No return fire runs are filed
under the Easy drill (its history, best score and leaderboard), the card shows the ranked
version's stats.

- **Pre-aim:** walk a route and clear every common angle before anyone shows up.
- **Angle holding:** hold one spot while bots wide-swing and jiggle-peek.
- **Anti-flash:** they flash, then swing. Turn away in time, then take the duel.
- **Fundamentals:** micro-flicks, Drift-style clicking, strafers and tracking.

<br>

## Build your own drills

Pick a real map or build an arena from scratch in **Studio**. Place bots, shape their
routes, add cover and press play. Switch between 2D, clean 3D and the **Detailed** view
of the actual game map.

<p align="center">
  <img src="docs/images/v1.3/studio-sunset.png" alt="Studio Detailed view: placing bots around Sunset's stairs and doorways" width="100%">
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/images/v1.3/studio-bot-options.png" alt="Bot controls for jump height, occasional crouching and flashes"></td>
    <td width="50%"><img src="docs/images/studio-build.png" alt="Building cover with walls, stairs and a floor in Studio"></td>
  </tr>
  <tr>
    <td>Tune jumps, occasional crouching, hit slowdown and flashes.</td>
    <td>Build your own spot with walls, boxes, stairs, ramps and window walls.</td>
  </tr>
</table>

Use holders, strafers, peekers, runners and rushers, with shooting difficulty from
**Iron to Radiant**. Add unpredictable movement, jumps and occasional crouches to vary
the duel. Build arenas from **12 to 200 m**, with Dark or Light looks and Flat or Grid
surfaces. Move, resize and rotate cover with snapping, undo and redo.

### Record yourself. Train against your run.

**Copycat bots** repeat your recorded movement: strafes, stops, crouches and jumps.
They can fire at the moments you fired or shoot as soon as they see you. Preview the
route, adjust playback speed, mirror it, and save recordings to your **Runs library**
for other drills.

<p align="center">
  <img src="docs/images/v1.3/studio-copycat.png" alt="Copycat bot with a recorded movement path, playback controls and options to save the run" width="100%">
</p>

<br>

## New sights. More skins.

Rifles, SMGs and heavy weapons have new animated aiming visuals. The gun rises to
your eye and the sight moves with its sway and recoil. The Marshal, Outlaw and Operator
have sniper scopes with smoother opening animations. Aim speed, zoom, sensitivity,
spread and accuracy are unchanged.

<table>
  <tr>
    <td width="50%"><img src="docs/images/v1.3/rifle-ads.png" alt="Aiming down the RGX Vandal's glowing sight on Sunset"></td>
    <td width="50%"><img src="docs/images/v1.3/sniper-scope.png" alt="Two Sunset bots viewed through a sniper scope"></td>
  </tr>
  <tr>
    <td>New rifle ADS, with each skin keeping its own look.</td>
    <td>Sniper scopes for the Marshal, Outlaw and Operator.</td>
  </tr>
</table>

**15 new skins** include RGX and Gaia Vandals, BlastX Phantom, Prime Guardian,
Singularity Sheriff, Smite Ghost, Araxys and Rogue Operators, and six melee skins.
Several have their own firing sounds, kill sounds and effects. Melee skins have equip,
attack and **inspect (Y)** animations. Choose yours in **Settings**.

<table>
  <tr>
    <td width="33%"><img src="docs/images/v1.3/gaia-white.png" alt="Gaia White Vandal"></td>
    <td width="33%"><img src="docs/images/v1.3/blastx.png" alt="BlastX Phantom"></td>
    <td width="33%"><img src="docs/images/v1.3/karambit.png" alt="Inspecting the Damascus Steel Karambit"></td>
  </tr>
  <tr>
    <td>Gaia White Vandal</td>
    <td>BlastX Phantom</td>
    <td>Damascus Steel Karambit</td>
  </tr>
</table>

<br>

## Round mode (beta)

Play **one VALORANT-style round**, you against 5 bots. Open it with **Round (beta)** in the
lobby's top bar, pick the map (**Ascent** or **Corrode**), your side (**Attack** or **Defense**),
the enemy rank, your weapon and how long the barriers stay up (10, 20 or 30 seconds), then press
**Start**. The panel remembers your picks.

Both sides start the same way: barriers keep each team in its spawn area (you see them as coloured
walls) and nobody can shoot until they drop. Then the round lasts 1:40, and a planted spike goes
off 45 seconds after the plant (it beeps faster near the end).

**Attack** (you plant):
- The 5 defenders walk from their spawn to setup spots near both sites and mid (a different setup
  every round). After a plant they come back to the site and one of them defuses.
- Walk into a site and **hold 4** for 4 seconds to plant (stand still or walk; running, jumping or
  letting go starts it over). You can't shoot while planting.
- **You win** when the spike goes off or every defender is dead. **You lose** when you die before
  the plant, the time runs out before the plant, or they defuse it. If you die after the plant,
  the round goes on and the spike decides it.

**Defense** (you stop the plant):
- The 5 attackers wait behind their barriers, then gather on one route to one site (A or B, picked
  at random; sometimes one of them takes the other route). They go in together, one plants, and the
  rest hold spots around the spike. If the bot with the spike dies, another one picks it up.
- The top of the screen says which sites to defend. You hear a soft pulsing tone while an attacker
  plants within about 30 m: left or right tells you where, louder means closer.
- After the plant, find the spike and **hold F** for 7 seconds to defuse (stand still or walk). Past
  3.5 seconds a release keeps half the progress.
- **You win** when you defuse, the time runs out before the plant, or every attacker dies before the
  plant. **You lose** when you die or the spike goes off. Killing every attacker after the plant is
  not enough: you still have to defuse.

For both sides:
- A banner shows the result, then the normal result screen. Round runs are not saved to your drill
  history and leave no replay.
- The rank tiles are the same Enemy rank setting the drills use (Default = the round's own bots).
- 4 and F are the plant and defuse keys shown in game; F is the game's "use" key, so if you moved
  "use" to another key, defuse with that one.

Known limits of the beta: you can walk through bots; on Ascent the attackers reach B from the
defender side of B Main (they don't take the gap jump), so you may see them early from the
defender spawn; and the barriers were placed from the map data, not checked in game on every
corner. How the map data is made: [tools/README.md](tools/README.md#round-mode-data).

<br>

## Every shot counts

Track score, time and hit rate while you play. The rebuilt **shooting-error graph**
shows a thin bar per shot: yellow for spray error and blue for movement error.
Your training history keeps every run.

New headshot effects, target-hit audio and optional **advanced bullet tracers** add
feedback to your shots. Weapons and skins are prepared before a drill starts to reduce
stutters when firing and switching guns.

<br>

## Set it up like your game

**Import your VALORANT settings**, including sensitivity, ADS and scope multipliers,
crosshair and keybinds, with a preview, backup and Undo. Or use Sens tools to bring your
sensitivity over from another game.

Adjust resolution, stretched 4:3, render scale, viewmodel, weapon hand, flashes and
enemy outlines. Crosshair changes apply immediately in a drill.

<p align="center">
  <img src="docs/images/sens-tools.png" alt="Sensitivity tools: eDPI, cm/360 and a converter from other games" width="420">
</p>
<p align="center">
  <sub>Bring your sensitivity over from CS2, Apex, Overwatch 2, Call of Duty or Destiny 2.</sub>
</p>

- **Your frame rate.** Unlimited, Match display or a custom 30–1000 FPS cap, with a live FPS meter and 1% lows.
- **Fullscreen.** Starts fullscreen; F11 switches to a window and remembers your choice.
- **Offline.** No account, no internet. Your data stays in `%APPDATA%\AimTrainer`.
- **Backed up.** A backup is made at every start, and you can export to a folder whenever you like.

<br>

## Get it

You need Windows 10 or 11 and a graphics card with WebGL 2
(almost every PC from the last 10 years has one).

### The easy way

1. Click here to download the game: **[AimTrainer-Setup.exe](https://github.com/AverWasTaken/open-aim/releases/latest/download/AimTrainer-Setup.exe)**
2. When the download is done, open the file.
3. If a blue box says **"Windows protected your PC"**, click **More info**, then click **Run anyway**.
   (Windows shows this because the game is not signed by a big company.)
4. Click **Next** until it is done, then click **Finish**.
5. Open **AimTrainer** from your desktop or the Start menu.
6. The first time, bring over your VALORANT settings, or type your sensitivity in **Sens tools**.
7. Pick a drill and play.

**To update:** download the file again from the same link and run it.
Your settings and scores are kept.

### The always-newest way

This way takes a bit more setup, but the game gets the newest version
by itself every time you open it.

1. Install **Git**: go to [git-scm.com/download/win](https://git-scm.com/download/win),
   download it, open it, and click **Next** on every screen.
2. Install **Node.js**: go to [nodejs.org](https://nodejs.org), download the **LTS**
   version, open it, and click **Next** on every screen.
3. Open a **new** PowerShell window: press the Windows key, type `powershell`, press Enter.
4. Copy these three lines, paste them into the window (right-click pastes), and press Enter:

   ```powershell
   git clone -c core.longpaths=true https://github.com/AverWasTaken/open-aim.git
   cd open-aim
   .\launcher\Install.cmd
   ```

5. Wait. It downloads about 450 MB, so the first start can take a few minutes.
   The game opens by itself when it is ready.
6. From now on, open the game with the **AimTrainer** icon on your desktop.

The game lives in a folder called `open-aim` in your user folder. Don't delete or move it.
If you move it, run `launcher\Install.cmd` in the new place to fix the desktop icon.

**Something went wrong?** The game writes a log to `%APPDATA%\AimTrainer\logs\main.log`
(paste that into the File Explorer address bar). Add it to your bug report.

Read the full [1.3.0 changelog](CHANGELOG.md) for all additions and fixes.

<br>

## Run it from source

You need [Node.js](https://nodejs.org) 20+ and the game files in `site/`
(see [docs/game-files.md](docs/game-files.md)).

```bash
git clone -c core.longpaths=true https://github.com/AverWasTaken/open-aim.git
cd open-aim/app
npm install
npm start
```

`npm run build` makes the installer. How it's put together: [docs/architecture.md](docs/architecture.md).
Want to add a drill to the built-in list? See [docs/scenario-format.md](docs/scenario-format.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

<br>

## Credits

The 3D maps come from the [ishoutu aim trainer](https://ishoutu.cn/aim). They are not my
work and are not covered by this project's MIT license.

Callout names on the maps are Riot's in-game English names, via [valorant-api.com](https://valorant-api.com).

<br>

---

<sub>
MIT licensed. Built with <a href="https://www.electronjs.org">Electron</a> and <a href="https://threejs.org">three.js</a>.
A personal project for testing, not affiliated with or endorsed by Riot Games.
VALORANT and its maps belong to Riot Games.
</sub>
