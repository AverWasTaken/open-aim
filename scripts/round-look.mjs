// The attacker's ways into a site, per map (x, z; callers snap them to the nearest nav node and look
// from eye 1.6 m above it). Used by scripts/round-defense-spread.mjs --look, scripts/round-setup-check.mjs
// and scripts/test-round-nav.mjs (Ascent B: setups an attacker sees on the way in).
// Ascent B: B Main, the B Main door (outside / inside), the B approach behind it; the spread sweep also
// uses the site-front lane entry and the lane (LOOK_LANE).
export const LOOK = {
  ascent: { B: { 'B Main': [-55, 20], 'door out': [-61.5, 11.7], 'door in': [-65.5, 12], approach: [-70, 14] } },
};
export const LOOK_LANE = {
  ascent: { B: { 'lane entry': [-64, 22], lane: [-65.5, 27] } },
};
