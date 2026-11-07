# scripts/ux

Checks for shell UI layout. They drive a running test copy of the app over the Chrome DevTools Protocol (CDP).
Run them only against a headless test copy: `AIM_HEADLESS=1`, your own `AIM_PORT`, `AIM_PROFILE` and `--remote-debugging-port`.

## settings-layout-check.mjs

Checks the lobby SETTINGS page (`section.hall-center.st-view`, the SettingsView in `ChJ6FlD4.js`).
The CSS it checks is the `/* settings page layout (ux) */` block in `app/theme-esports.css`.

```
node scripts/ux/settings-layout-check.mjs <cdpPort> [--sizes 1280x720,1920x1080,3840x2160] [--tabs general,video] [--shots <dir>] [--no-search]
```

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
