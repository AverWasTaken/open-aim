# scripts/ux

Checks for the shell UI that need a running copy of the app. They are not part of
`npm test` and are not packaged.

## lobby-layout-check.mjs

Checks the lobby top bar, the feedback link and the keyboard path at six window sizes.

1. Start a hidden test copy with a CDP port, from `app/`:
   `AIM_HEADLESS=1 AIM_PORT=<port> AIM_PROFILE=<test profile> node_modules/electron/dist/electron.exe . --remote-debugging-port=<cdpPort>`
   (never the real profile or port 8000).
2. `node scripts/ux/lobby-layout-check.mjs <cdpPort>`

It sets each size with `Emulation.setDeviceMetricsOverride` (1280x720, 1366x768, 1440x900,
1920x1080, 3840x2160, 1920x1080 at 2x), opens the first lobby tab and checks:

- no sideways scroll (page and top nav);
- Quick start, the Sens box and the feedback link are fully on screen and not covered;
- the feedback link sits in the bottom bar and does not overlap the search box, drill cards
  or sort buttons, and an open panel's dim layer covers it;
- every top-bar button has an aria-label, the FPS button has aria-pressed;
- the Sens arrows are 24x16 and not tab stops, the hidden file input is not a tab stop;
- a 25-step Tab walk starts at "Skip to drills" and every focused element is on screen.

It prints one JSON line per size (`ok`, `fails`, `info`) and exits 1 if any check failed.
`info.firstCardTop` is reported only (the hero height at 1280x720 is a later item).
The size override is cleared at the end.
