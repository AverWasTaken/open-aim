# scripts/ux

Checks for shell UI layout. They drive a running test copy of the app over the Chrome DevTools Protocol (CDP).
Run them only against a headless test copy: `AIM_HEADLESS=1`, your own `AIM_PORT`, `AIM_PROFILE` and `--remote-debugging-port`.
The layout checks are not part of `npm test` and are not packaged.

## settings-layout-check.mjs

Checks the lobby SETTINGS page (`section.hall-center.st-view`, the SettingsView in `ChJ6FlD4.js`).
The CSS it checks is the `/* settings page layout (ux) */` block in `app/theme-esports.css`.

```
node scripts/ux/settings-layout-check.mjs <cdpPort> [--sizes 1280x720,1920x1080,3840x2160] [--tabs general,video] [--shots <dir>] [--no-search]
```

- On hp: `bash open-aim-hq/hp.sh cdp-script <cdpPort> scripts/ux/settings-layout-check.mjs [options]`. hp.sh already passes the port as the first argument, so don't repeat it. `--shots` paths are on hp.
- It opens SETTINGS from the top nav, then walks every tab at each size (`Emulation.setDeviceMetricsOverride`). It clears the override at the end.
- A size can carry a scale: `1920x1080@2`.
- On the Video tab it waits for the shell lighting row (`[data-setting="mapLighting"]`) before measuring.
- Fails on:
  - a description or stat label cut off with "…" (`.st-list .hall-field-text small`, `.st-list .al-number-hint`, `.st-tele dt/dd`);
  - horizontal scroll inside `.st-view`, `.st-main` or `.st-list`;
  - the live preview showing on the Control or Audio tab;
  - at 1920 wide and up: the settings column outside 480-880px, or the preview wider than 1.4x the settings column;
  - the preview stack running past the bottom of its column;
  - a search on the Audio tab not bringing the preview back, or clearing it not hiding it again.
- `--shots <dir>` saves `settings-<size>-<tab>.png` per tab.
- Exit code: 0 pass, 1 a check failed, 2 could not run.

## lobby-layout-check.mjs

Checks the lobby top bar, the feedback link, the keyboard path and the drill cards at eight window sizes.

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
- pressing Enter on "Skip to drills" moves focus into the first drill card, on screen, and
  only the drill list scrolls (not the lobby frame).
- drill cards: no card code ("NO.XXXXXX", `.al-wk-card-no` / `.al-wkb-no`) is visible, every
  visible card play button (`.al-wk-split-go`, `.al-wk-play`) fits its label
  (scrollWidth <= clientWidth) and its icon is not squashed;
- at heights up to 800px, with the drill list at the top, the first card's title ends above
  the bottom bar (`info.firstTitleBottom` <= `info.bottomBarTop`; reported above 800px);
- at 1280x720 only: the first card rank chip is a `<button type="button">` with an
  aria-label; a real click opens the rank picker with the pick-only hint ("Enter saves");
  picking a rank there saves it for that drill (chip updates, focus back on the chip),
  starts nothing and leaves `localStorage["aim-enemy-rank"]` unchanged. The drill's old
  pick is put back afterwards. With `shotDir` it also saves `chip-picker-1280.png`.

It prints one JSON line per size (`ok`, `fails`, `info`) and exits 1 if any check failed.
Each CDP call gives up after 20 s (also when the copy is stopped), and the whole run stops
with exit 3 after 8 minutes, so it never holds the shared hp copy past its slot.
`info.firstCardTop` and `info.heroHeight` are reported only.
`info.navNeed` / `info.navFree` are reported only: the width the top nav needs in its current
state and its spare room, to check the 1660px / 1860px breakpoints against real widths.
With `shotDir` it saves `lobby-<w>x<h>@<dpr>x.png` per size and `tab-1280-<n>.png` for the
first 8 Tab presses at 1280x720. The size override is cleared at the end.
