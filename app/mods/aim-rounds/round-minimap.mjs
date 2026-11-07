// Round mode markers on the in-game minimap (small corner map and the big map): the site letters
// A/B and the spike (planted: both sides; dropped: attack side only). Pure canvas 2D, nothing at
// import time, no three.js. Drawn by the game's minimap component (tools/round_minimap_patch.py),
// which imports drawMiniMarks / drawBigMarks / roundMarksKey from /aim-rounds/round-minimap.mjs.
//
// Data: globalThis.__aimRoundMarks, one flat object per round run, or null (normal drills: the
// patched minimap then does no extra work at all). round-visual.mjs sets it:
//   create:  globalThis.__aimRoundMarks = createRoundMarks(cfg)   (cfg = rules.round)
//   update:  updateRoundMarks(marks, view)   every frame (view = roundView(), no allocation)
//   dispose: globalThis.__aimRoundMarks = null
// Shape: { rev, letters: [{ t, x, z }], spike: 0 none | 1 planted | 2 dropped, sx, sz, pulse }.
//   rev goes up whenever anything drawn changes (spike kind, its rounded x/z, pulse on/off), so the
//   minimap's redraw key changes exactly then. Coordinates are world x/z, the same frame as the
//   minimap pose (player.position.x/z).
// Visibility (never leaks the defense side's hidden info): planted spike for both sides; dropped
// spike only on the attack side; botPlanting / carrier are never read.
//
// Mapper contract (from the patch): map(x, z) -> [px, py] canvas pixels.
//   small map: already rotated + zoomed + centred; R = radius in px (the map is a circle), dpr.
//   big map: map image space * canvas size; dpr.

const RED = '#ff4655';        // accent (ux-style.md)
const AMBER = '#ffd166';      // status warn: dropped spike
const TEXT = '#f4f5f7';       // primary text
const OUTLINE = 'rgba(9,11,15,0.92)'; // --es-bg
const FONT = 'Bahnschrift, "Segoe UI", system-ui, sans-serif';
const PULSE_MS = 1000;        // one pulse ring per second while planted
const KEY_STEP_MS = 80;       // redraw key step while pulsing (~12 Hz)

const num = (v) => (Number.isFinite(v) ? v : null);

export function createRoundMarks(cfg) {
  const letters = [];
  for (const s of cfg?.sites ?? []) {
    const c = s?.center;
    const x = num(c?.x), z = num(c?.z);
    if (x === null || z === null || s?.id == null) continue;
    letters.push({ t: String(s.id).slice(0, 2).toUpperCase(), x, z });
  }
  return { rev: 1, letters, spike: 0, sx: 0, sz: 0, pulse: false };
}

// Per frame: copies the spike from the round view into the marks; bumps rev only on a change.
export function updateRoundMarks(m, view) {
  if (!m || !view) return;
  const s = view.spike;
  let kind = 0, at = null;
  if (s?.planted) { kind = 1; at = s.planted; }
  else if (s?.dropped && view.side === 'attack') { kind = 2; at = s.dropped; }
  const x = at ? Math.round(at.x * 5) / 5 : 0, z = at ? Math.round(at.z * 5) / 5 : 0;
  const pulse = kind === 1 && view.phase === 'planted';
  if (kind !== m.spike || x !== m.sx || z !== m.sz || pulse !== m.pulse) {
    m.spike = kind; m.sx = x; m.sz = z; m.pulse = pulse; m.rev++;
  }
}

// Redraw-key suffix: "" with no marks (normal drills: key unchanged), else |m<rev>, plus a time
// step while the planted spike pulses.
export function roundMarksKey(now) {
  const m = globalThis.__aimRoundMarks;
  if (!m) return '';
  return m.pulse ? `|m${m.rev}:${Math.floor(now / KEY_STEP_MS)}` : `|m${m.rev}`;
}

function letter(ctx, t, x, y, size) {
  ctx.font = `700 ${Math.round(size)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, size * 0.28);
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(t, x, y);
  ctx.fillStyle = TEXT;
  ctx.fillText(t, x, y);
}

function diamond(ctx, x, y, r, fill, line) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
}

function pulseRing(ctx, x, y, r0, r1, line, now) {
  const k = (now % PULSE_MS) / PULSE_MS;
  ctx.beginPath();
  ctx.arc(x, y, r0 + (r1 - r0) * k, 0, Math.PI * 2);
  ctx.lineWidth = line;
  ctx.strokeStyle = `rgba(255,70,85,${(0.9 * (1 - k)).toFixed(3)})`;
  ctx.stroke();
}

function spike(ctx, m, x, y, r, dpr, now) {
  if (m.spike === 1) {
    if (m.pulse) pulseRing(ctx, x, y, r, r * 2.6, 2 * dpr, now);
    diamond(ctx, x, y, r, RED, 1.5 * dpr);
  } else diamond(ctx, x, y, r, AMBER, 1.5 * dpr);
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Small (corner) map. Letters outside the circle are skipped; the spike is pinned to the rim.
export function drawMiniMarks(ctx, m, map, R, dpr, now = clock()) {
  if (!m || typeof map !== 'function') return;
  ctx.save();
  for (const l of m.letters) {
    const [px, py] = map(l.x, l.z);
    if (Math.hypot(px - R, py - R) > R - 8 * dpr) continue;
    letter(ctx, l.t, px, py, 12 * dpr);
  }
  if (m.spike) {
    let [px, py] = map(m.sx, m.sz);
    const dx = px - R, dy = py - R, d = Math.hypot(dx, dy), lim = R - 6 * dpr;
    if (d > lim && d > 0) { px = R + (dx / d) * lim; py = R + (dy / d) * lim; }
    spike(ctx, m, px, py, 4.5 * dpr, dpr, now);
  }
  ctx.restore();
}

// Big map. The site letter sits in a badge above the site centre, clear of the callout label
// (callout names are drawn to the right of their dot).
export function drawBigMarks(ctx, m, map, dpr, now = clock()) {
  if (!m || typeof map !== 'function') return;
  ctx.save();
  for (const l of m.letters) {
    const [px, py0] = map(l.x, l.z);
    const r = 11 * dpr, py = py0 - 20 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16,19,26,0.85)';
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = RED;
    ctx.stroke();
    letter(ctx, l.t, px, py + 0.5 * dpr, 15 * dpr);
  }
  if (m.spike) {
    const [px, py] = map(m.sx, m.sz);
    spike(ctx, m, px, py, 7 * dpr, dpr, now);
  }
  ctx.restore();
}
