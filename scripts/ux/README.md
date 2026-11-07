# scripts/ux

Checks for the shell UI that need a running copy of the app. They are not part of
`npm test` and are not packaged.

## lobby-layout-check.mjs

Checks the lobby top bar, the feedback link and the keyboard path at eight window sizes.

1. Start a hidden test copy with a CDP port. In the open-aim push this only happens on the
   hp server: `bash hp.sh app-start <name> <AIM_PORT> <cdpPort>` (never the real profile or
   port 8000; never on the user's PC).
2. `node scripts/ux/lobby-layout-check.mjs <cdpPort> [shotDir]`

On the hp server (team copies): `bash hp.sh cdp-script <cdpPort> scripts/ux/lobby-layout-check.mjs /tmp/lobby-shots`
(cdp-script passes the port itself), then copy the screenshots back with `scp hp:/tmp/lobby-shots/* <local dir>`.

It sets each size with `Emulation.setDeviceMetricsOverride` (1280x720, 1366x768, 1440x900,
1536x864, 1680x1050, 1920x1080, 3840x2160, 1920x1080 at 2x), opens the first lobby tab and checks:

- no sideways scroll (page and top nav), and no tab cut off in the tab row (only enforced
  when Bahnschrift is installed: the widths are tuned for it; hp has no Bahnschrift, so
  there `info.tabsClipped` is reported only);
- bar labels show from 1660px wide and are hidden below (the breakpoint in
  theme-esports.css); below it every button shows an icon; every button has a title
  tooltip either way;
- Quick start, the Sens box and the feedback link are fully on screen and not covered;
- the feedback link sits in the bottom bar and does not overlap the search box, drill cards
  or sort buttons, and an open panel's dim layer covers it;
- every top-bar button has an aria-label, the FPS button has aria-pressed;
- the Sens arrows are 24x16 and not tab stops, the hidden file input is not a tab stop;
- a 25-step Tab walk starts at "Skip to drills" and every focused element is on screen.

It prints one JSON line per size (`ok`, `fails`, `info`) and exits 1 if any check failed.
`info.firstCardTop` is reported only (the hero height at 1280x720 is a later item).
With `shotDir` it saves `lobby-<w>x<h>@<dpr>x.png` per size and `tab-1280-<n>.png` for the
first 8 Tab presses at 1280x720. The size override is cleared at the end.
