// Cover starts for the bots of the six "*-peekers" map drills (scenarios/*-peekers.json).
//
// Before: every bot stood on its authored spot and strafed there, so the player turned a corner and the
// bot was already standing in the open; refills after a kill popped into view on the spot.
// After: each pool spot gets a cover point next to it, hidden from where the player comes from. The
// spawner sits on the cover point (first spawn and every refill start there) and the bot walks a stock
// `path` loop: cover (wait) -> spot (short wait) -> up to three jiggle steps -> back to cover. The stock
// shooter (engage "stop") holds it out to fight when it sees the player.
//
// Where the player comes from: the game's own bot-order planner (hy in OkAdunfX.js) run on the ORIGINAL
// drills, saved in tools/data/peek-viewpoints.json (route + each spot's first-sight point, the same
// point tools/spot_scores.mjs scores from, plus the original pool spawners and actors). Reference
// viewpoints of a spot = its first-sight point + route samples every 2 m for the next 10 m after it,
// eye = feet + stand eye height. Line of sight = the sim's bot sight on the real map collision
// (tools/round_terrain.mjs loadTerrain().sight).
//
// Cover search: both sides perpendicular to the first-sight point -> spot line, 0.25 m steps up to 3 m;
// a candidate needs a clear walk to the spot (rays at 0.6 m and 1.2 m, centre and +-G.WALK sideways;
// floor probe every 0.25 m, steps/drops <= 0.5 m). Hidden from a viewpoint = no sight to head (1.86 m)
// and chest (1.2 m) at the centre and +-0.35 m sideways. Best candidate = hidden from the first-sight
// point and from the most route samples, then the shortest. If no perpendicular candidate hides from
// the first-sight point, the same search runs along the two axes rotated 45 deg away from the viewer
// ("step back behind the corner"). Still none (or no first-sight point at all): the spot keeps today's
// position (path [spot, jiggles], spawner on it).
// Jiggles: 0.7 / -0.5 / 0.6 m sideways from the spot, toward the open side (away from the cover);
// a jiggle whose leg is blocked is dropped. Area spawners collapse to their box centre (size 0).
// A no-cover spot left without any jiggle must still move (never a bot standing still), in order:
//  (a) path jiggles in another direction or shorter (+-0.3 m sideways, 45 deg, along the view line);
//  (b) the original strafe (spawner + actor-1 exactly as in the original drill) if +-0.8 m along world
//      X is a clear walk; (c) the original strafe with a spawner rotationY that turns the strafe axis
//      down a clear direction (the one closest to sideways as seen from the first-sight point).
//
// Runs on hp (terrain is CPU heavy the first time; cached in the OS temp folder):
//   node tools/peek_cover.mjs            rewrite the six scenario files + their spot-score entries
//   node tools/peek_cover.mjs --check    fail if the scenario files or spot-scores.json are stale
//   node tools/peek_cover.mjs --json     print the per-spot report as JSON
//   node tools/peek_cover.mjs --dry [--walk-half 0.3]   report only (no writes), optional walk margin
//   node tools/peek_cover.mjs --init <planner.json>   (re)make tools/data/peek-viewpoints.json from a
//        planner dump (tools/peek_planner.mjs, run in a test copy of the app) and the CURRENT
//        scenario files, which must still be the original (not yet converted) drills.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'tools', 'data', 'peek-viewpoints.json');
export const SCORES = path.join(ROOT, 'app', 'mods', 'aim-ranks', 'spot-scores.json');
export const STEMS = ['ascent-b-retake', 'bind-a-showers', 'corrode-mid-to-a', 'haven-garage-push', 'lotus-b-attack', 'split-b-heaven-retake'].map((s) => `${s}-peekers`);
// HALF = sideways offset of the hidden test; WALK = sideways offset of the walk-clearance rays (bot hit
// capsules are ~0.2 m in radius). 0.25 / 0.30 / 0.35 compared in the P2 check: at 0.25 the covers that
// only fit with < 0.30 m to spare had the bot's rifle (pointing at the player) inside or past the cover
// wall, one of them visible to the player; 0.30 picked.
export const G = { HEAD: 1.86, CHEST: 1.2, HALF: 0.35, WALK: 0.3, STEP: 0.25, MAX: 3, RAYS: [0.6, 1.2], STEP_H: 0.5, PROBE: 0.25, SAMPLE: 2, AHEAD: 10 };
// Restored movement for no-cover spots without any fitting jiggle.
export const SHORT = [0.3, -0.3, 0.3];
export const STRAFE_ACTOR = 'actor-1';
// Pause (s) at cover / at the spot / at each jiggle step. Pause waits are plain numbers in the game,
// so the cover wait varies per spot instead (cover +- coverSpread, from a hash of the spawner id) and
// bots don't all share one rhythm. Human-like bots scale each wait by 0.6-1.4 (aimBotPause).
// Cover ~2.4 s: an unengaged covered bot is hidden from its first-sight point ~60% of the time
// (1.6 s gave ~50%; scripts/test-training-peekers.mjs prints the share).
export const RHYTHM = { cover: 2.4, coverSpread: 0.4, spot: 0.6, jiggle: 0.15, speed: 5.4, jiggles: [0.7, -0.5, 0.6] };
export function coverWait(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return Math.round((RHYTHM.cover + RHYTHM.coverSpread * (((h >>> 0) % 1001) / 500 - 1)) * 100) / 100;
}
const FLOOR_NY = Math.cos((44.765 * Math.PI) / 180);
const r3 = (v) => Math.round(v * 1000) / 1000;
const P3 = (q) => ({ x: r3(q.x), y: r3(q.y), z: r3(q.z) });

// aimSpotKey: the same text as in OkAdunfX.js, kept in tools/spot_scores.mjs (single copy).
export function aimSpotKeyFn(root = ROOT) {
  const src = fs.readFileSync(path.join(root, 'tools', 'spot_scores.mjs'), 'utf-8');
  const m = src.match(/^const KEY_SRC = '(.*)';$/m);
  if (!m) throw new Error('KEY_SRC not found in tools/spot_scores.mjs');
  return new Function(`${m[1]};return aimSpotKey;`)();
}

export const scenarioFile = (stem, root = ROOT) => path.join(root, 'scenarios', `${stem}.json`);
export function readScenario(stem, root = ROOT) {
  const text = fs.readFileSync(scenarioFile(stem, root), 'utf-8').replace(/^﻿/, '');
  const data = JSON.parse(text);
  return { text, data, doc: JSON.parse(data.scene.doc) };
}
export const readData = (root = ROOT) => JSON.parse(fs.readFileSync(path.join(root, 'tools', 'data', 'peek-viewpoints.json'), 'utf-8'));

// Route arc-length helpers (horizontal distance; points are feet positions [x, y, z]).
function routeSamples(route, from, ahead = G.AHEAD, step = G.SAMPLE) {
  if (!route || route.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][2] - route[i - 1][2]));
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz;
    const t = L2 > 1e-12 ? Math.max(0, Math.min(1, ((from[0] - a[0]) * dx + (from[2] - a[2]) * dz) / L2)) : 0;
    const d = Math.hypot(a[0] + dx * t - from[0], a[2] + dz * t - from[2]);
    if (d < best.d - 1e-9) best = { d, s: cum[i - 1] + (cum[i] - cum[i - 1]) * t };
  }
  const at = (s) => {
    let i = 1;
    while (i < route.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1], t = seg > 1e-9 ? Math.max(0, Math.min(1, (s - cum[i - 1]) / seg)) : 0;
    const a = route[i - 1], b = route[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
  const out = [];
  for (let k = 1; k * step <= ahead + 1e-9; k++) {
    const s = best.s + k * step;
    if (s > cum[cum.length - 1] + 1e-9) break;
    out.push(at(s));
  }
  return out;
}

// Reference viewpoints (eyes) of one spot: { first, samples } or null (planner never sees the spot).
export function viewpoints(entry, id) {
  const st = entry.steps?.[id];
  if (!st?.from) return null;
  const eye = (q) => [q[0], q[1] + entry.eye, q[2]];
  return { first: eye(st.from), samples: routeSamples(entry.route, st.from).map(eye), from: st.from };
}

export function geometry(T, walkHalf = G.WALK) {
  const floorAt = (x, y, z, up = 1, down = 3) => {
    const t = T.ray(T.pawn, [x, y + up, z], [0, -1, 0], down + up, FLOOR_NY);
    return t < 0 ? null : y + up - t;
  };
  // Any of head/chest at the centre or +-HALF sideways (sideways as seen from the eye) visible?
  const seen = (eye, p) => {
    const dx = p.x - eye[0], dz = p.z - eye[2], l = Math.hypot(dx, dz) || 1, ax = -dz / l, az = dx / l;
    for (const o of [0, G.HALF, -G.HALF]) for (const h of [G.HEAD, G.CHEST]) if (T.sight(eye, [p.x + ax * o, p.y + h, p.z + az * o])) return true;
    return false;
  };
  const oneWay = (A, B) => {
    const dx = B.x - A.x, dz = B.z - A.z, L = Math.hypot(dx, dz);
    if (L < 1e-6) return null;
    const px = -dz / L, pz = dx / L;
    for (const h of G.RAYS) for (const o of [0, walkHalf, -walkHalf]) {
      const dy = B.y - A.y, len = Math.hypot(L, dy);
      const t = T.ray(T.pawn, [A.x + px * o, A.y + h, A.z + pz * o], [dx / len, dy / len, dz / len], len);
      if (t >= 0 && t < len) return `wall at ${t.toFixed(2)} m (h ${h}, side ${o})`;
    }
    let prev = A.y;
    const n = Math.ceil(L / G.PROBE);
    for (let i = 1; i <= n; i++) {
      const f = i / n, y = floorAt(A.x + dx * f, prev, A.z + dz * f, 0.6, 1.2);
      if (y === null || Math.abs(y - prev) > G.STEP_H) return `floor step at ${(f * L).toFixed(2)} m`;
      prev = y;
    }
    if (Math.abs(prev - B.y) > G.STEP_H) return 'end floor mismatch';
    return null;
  };
  // Clear both ways (a path bot walks through walls, so a blocked leg would clip).
  const walk = (A, B) => oneWay(A, B) ?? oneWay(B, A);
  return { floorAt, seen, walk };
}

// One pool spawner -> { spawner, actor (null = the original actor-1), info }.
export function coverSpot(geo, src, actorTpl, vp) {
  const { floorAt, seen, walk } = geo;
  const box = src.size && (src.size.x || src.size.y || src.size.z) ? { ...src.size } : null;
  const fy = floorAt(src.position.x, src.position.y, src.position.z);
  const spot = { x: src.position.x, y: fy ?? src.position.y, z: src.position.z };
  const info = { id: src.id, area: box, spotSeen: null, cover: null, hiddenFirst: false, samples: 0, hiddenSamples: 0, dropped: [], why: null, restored: null };
  let best = null, axis = { x: 1, z: 0 }, away = { x: 0, z: 1 };
  // Cover candidates along dirOf(side) (unit vectors), 0.25 m steps up to 3 m; notes per side.
  const search = (dirOf, notes) => {
    let top = null;
    for (const side of [1, -1]) {
      const u = dirOf(side);
      let note = `seen from the first-sight point up to ${G.MAX} m`;
      for (let k = 1; k * G.STEP <= G.MAX + 1e-9; k++) {
        const d = k * G.STEP, cx = spot.x + u.x * d, cz = spot.z + u.z * d;
        const cy = floorAt(cx, spot.y, cz, 0.6, 1.2);
        if (cy === null) { if (note !== 'ok') note = `no floor at ${d} m`; break; }
        const C = { x: cx, y: cy, z: cz };
        const blocked = walk(C, spot);
        if (blocked) { if (note !== 'ok') note = `walk blocked at ${d} m: ${blocked}`; break; } // collinear: farther out is blocked too
        if (seen(vp.first, C)) continue;
        note = 'ok';
        const hid = vp.samples.filter((e) => !seen(e, C)).length;
        if (!top || hid > top.hid || (hid === top.hid && d < top.d)) top = { C, d, side, hid };
      }
      notes[side > 0 ? 'L' : 'R'] = note;
    }
    return top;
  };
  if (!vp) info.why = 'planner never sees this spot';
  else {
    info.samples = vp.samples.length;
    info.spotSeen = seen(vp.first, spot);
    const dx = spot.x - vp.first[0], dz = spot.z - vp.first[2], l = Math.hypot(dx, dz) || 1;
    axis = { x: -dz / l, z: dx / l };
    away = { x: dx / l, z: dz / l };
    info.sides = {};
    best = search((s) => ({ x: axis.x * s, z: axis.z * s }), info.sides);
    if (best) best.dir = 'side';
    else {
      // Step back behind the corner: the sideways axis turned 45 deg away from the viewer.
      info.diag = {};
      best = search((s) => ({ x: (axis.x * s + away.x) * Math.SQRT1_2, z: (axis.z * s + away.z) * Math.SQRT1_2 }), info.diag);
      if (best) best.dir = 'diag45';
    }
    if (best) Object.assign(info, { cover: { side: best.side, d: best.d, dir: best.dir }, hiddenFirst: true, hiddenSamples: best.hid });
    else info.why = 'no cover hides it from the first-sight point';
  }
  const home = best ? best.C : spot;
  // Path from home: [home, spot] (cover) or [spot], then jiggles spot + dir * m; a blocked leg drops
  // that jiggle, then the closing leg back to home must be clear too.
  const jiggle = (dir, amps) => {
    const pts = best ? [home, spot] : [spot], tags = pts.map(() => null), dropped = [];
    amps.forEach((m, i) => {
      const x = spot.x + dir.x * m, z = spot.z + dir.z * m, y = floorAt(x, spot.y, z, 0.6, 1.2);
      const J = { x, y: y ?? spot.y, z };
      const why = y === null ? 'no floor' : walk(pts[pts.length - 1], J);
      if (why) dropped.push(`j${i + 1} (${why})`);
      else { pts.push(J); tags.push(`j${i + 1}`); }
    });
    while (pts.length > (best ? 2 : 1)) {
      const why = walk(pts[pts.length - 1], home);
      if (!why) break;
      pts.pop();
      dropped.push(`${tags.pop()} (loop back: ${why})`);
    }
    return { pts, dropped };
  };
  const open = best ? { x: -axis.x * best.side, z: -axis.z * best.side } : axis;
  let jig = jiggle(open, RHYTHM.jiggles);
  info.dropped = jig.dropped;
  if (!best && jig.pts.length < 2) {
    // (a) any other jiggle that fits, most sideways (as the player sees it) first: shorter sideways,
    // 45 deg (full, then short), then along the view line.
    const c = Math.SQRT1_2, dA = { x: (axis.x + away.x) * c, z: (axis.z + away.z) * c }, dB = { x: (axis.x - away.x) * c, z: (axis.z - away.z) * c };
    const alts = [
      ['sideways +-0.3 m', axis, SHORT], ['45 deg', dA, RHYTHM.jiggles], ['-45 deg', dB, RHYTHM.jiggles],
      ['45 deg +-0.3 m', dA, SHORT], ['-45 deg +-0.3 m', dB, SHORT], ['view line', away, RHYTHM.jiggles], ['view line +-0.3 m', away, SHORT],
    ];
    for (const [how, dir, amps] of alts) {
      const t = jiggle(dir, amps);
      if (t.pts.length >= 2) { jig = t; info.restored = { kind: 'a', how }; break; }
    }
    if (!info.restored) {
      // (b) / (c): the original strafe. Stock strafe axis = (cos r, -sin r) for spawner rotationY r
      // (world X when unset); each leg ends <= max(travel)/2 from home; x/z only, no wall collision.
      const strafe = actorTpl.behaviors.find((b) => b.kind === 'strafe');
      const reach = strafe ? Math.max(...strafe.travel) / 2 : 0;
      const clear = (r) => {
        for (const sg of [1, -1]) {
          const x = spot.x + Math.cos(r) * reach * sg, z = spot.z - Math.sin(r) * reach * sg, y = floorAt(x, spot.y, z, 0.6, 1.2);
          if (y === null || walk(spot, { x, y, z })) return false;
        }
        return true;
      };
      if (strafe && clear(0)) info.restored = { kind: 'b', how: 'strafe along world X' };
      else if (strafe) {
        // 5 deg steps (the axis is two-way, so 5..175), closest to sideways from the first-sight point first.
        const want = Math.atan2(-axis.z, axis.x);
        const off = (r) => { const d = (((r - want) % Math.PI) + Math.PI) % Math.PI; return Math.min(d, Math.PI - d); };
        const tries = [];
        for (let k = 1; k < 36; k++) tries.push((k * 5 * Math.PI) / 180);
        tries.sort((a, b) => off(a) - off(b) || a - b);
        const r = tries.find(clear);
        if (r !== undefined) {
          const rotationY = Math.round(r * 1000) / 1000;
          info.restored = { kind: 'c', how: `strafe, rotationY ${rotationY}`, rotationY };
        }
      }
      if (info.restored) {
        // The exact original spawner + the original actor-1 (the drill as it was before the cover change).
        const spawner = structuredClone(src);
        if (info.restored.kind === 'c') spawner.rotationY = info.restored.rotationY;
        return { spawner, actor: null, info };
      }
      info.why += '; NO movement fits: stands still';
    }
  }
  const pts = jig.pts;
  const waits = pts.map((_, i) => (best && i === 0 ? coverWait(src.id) : (best ? i === 1 : i === 0) ? RHYTHM.spot : RHYTHM.jiggle));
  const shooter = actorTpl.behaviors.find((b) => b.kind === 'shooter');
  const actor = {
    ...structuredClone(actorTpl), id: `peek-${src.id}`,
    behaviors: [
      { kind: 'path', waypoints: pts.map(P3), loop: true, speed: RHYTHM.speed, counterStrafe: true, pauses: waits.map((wait, at) => ({ at, wait })) },
      structuredClone(shooter),
    ],
  };
  const spawner = { ...structuredClone(src) };
  Object.assign(spawner, { kind: 'area', actorTemplateId: actor.id, position: P3({ x: home.x, y: home.y + 0.3, z: home.z }), size: { x: 0, y: 0, z: 0 } });
  return { spawner, actor, info };
}

// Original drill (from the data file) + current file -> converted doc + report.
export function convert(entry, current, T, walkHalf = G.WALK) {
  const geo = geometry(T, walkHalf);
  const doc = structuredClone(current);
  const pool = new Set(doc.rules.spawnerPick.pool);
  if (JSON.stringify(doc.rules.spawnerPick.pool) !== JSON.stringify(entry.source.pool)) throw new Error('pool changed since the viewpoints were captured: rerun --init');
  if (JSON.stringify(doc.playerSpawn) !== JSON.stringify(entry.source.playerSpawn)) throw new Error('player spawn changed since the viewpoints were captured: rerun --init');
  const srcBy = new Map(entry.source.spawners.map((s) => [s.id, s]));
  const actorBy = new Map(entry.source.actors.map((a) => [a.id, a]));
  const made = [], infos = [];
  doc.spawners = doc.spawners.map((s) => {
    if (!pool.has(s.id)) return s;
    const src = srcBy.get(s.id);
    if (!src) throw new Error(`${s.id}: not in the captured source`);
    const r = coverSpot(geo, src, actorBy.get(src.actorTemplateId), viewpoints(entry, s.id));
    if (r.actor) made.push(r.actor);
    infos.push(r.info);
    return r.spawner;
  });
  // Original actors still in use (non-pool spawners, restored strafe spots), then the per-spot actors.
  const used = new Set(doc.spawners.map((s) => s.actorTemplateId));
  doc.actors = [...entry.source.actors.filter((a) => used.has(a.id)), ...made];
  return { doc, infos };
}

export async function terrainLoader(root = ROOT, log = () => {}) {
  const { loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
  const cache = new Map();
  return async (map) => { if (!cache.has(map)) cache.set(map, await loadTerrain(map, { root, log })); return cache.get(map); };
}

export async function generate({ root = ROOT, stems = STEMS, log = () => {}, terrain = null, walkHalf = G.WALK } = {}) {
  const loadTerrain = terrain ?? (await terrainLoader(root, log));
  const data = readData(root);
  const key = aimSpotKeyFn(root);
  const out = [];
  for (const stem of stems) {
    const entry = data.drills[stem];
    if (!entry) throw new Error(`${stem}: not in tools/data/peek-viewpoints.json`);
    const cur = readScenario(stem, root);
    const T = await loadTerrain(cur.doc.environment.map);
    const { doc, infos } = convert(entry, cur.doc, T, walkHalf);
    const text = JSON.stringify(doc);
    const next = structuredClone(cur.data);
    next.scene.doc = text;
    next.scene.docBytes = Buffer.byteLength(text);
    next.item.docBytes = next.scene.docBytes;
    const eol = cur.text.includes('\r\n') ? '\r\n' : '\n';
    const fileText = (JSON.stringify(next, null, 2) + '\n').replace(/\n/g, eol);
    out.push({ stem, entry, doc, infos, key: key(doc), fileText, stale: fileText.replace(/\r\n/g, '\n') !== cur.text.replace(/\r\n/g, '\n') });
  }
  return out;
}

// Flat 0.5 spot scores for the converted docs (spot bias off for these drills); other entries kept.
export function scoresText(results, root = ROOT) {
  const raw = fs.readFileSync(path.join(root, 'app', 'mods', 'aim-ranks', 'spot-scores.json'), 'utf-8');
  const j = JSON.parse(raw);
  const codes = new Set(results.map((r) => r.entry.shareCode));
  const scenes = Object.fromEntries(Object.entries(j.scenes).filter(([, v]) => !v.codes.some((c) => codes.has(c))));
  for (const r of results) {
    scenes[r.key] = { codes: [r.entry.shareCode], ids: [r.doc.meta.id], name: r.doc.meta.name, map: r.doc.environment.map, scores: Object.fromEntries(r.doc.rules.spawnerPick.pool.map((id) => [id, 0.5])) };
  }
  const sorted = Object.fromEntries(Object.entries(scenes).sort((a, b) => a[1].codes[0].localeCompare(b[1].codes[0])));
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { old: raw, text: (JSON.stringify({ ...j, scenes: sorted }, null, 1) + '\n').replace(/\n/g, eol) };
}

function initData(plannerFile, root = ROOT) {
  const P = JSON.parse(fs.readFileSync(plannerFile, 'utf-8'));
  const drills = {};
  let eye = null;
  for (const stem of STEMS) {
    const { data, doc } = readScenario(stem, root);
    if (doc.actors.some((a) => a.id.startsWith('peek-'))) throw new Error(`${stem}: already converted; --init needs the original drills`);
    const p = P[stem];
    if (!p) throw new Error(`${stem}: missing in ${plannerFile}`);
    eye = eye ?? p.eye;
    const pool = doc.rules.spawnerPick.pool, ps = new Set(pool);
    drills[stem] = {
      shareCode: data.scene.shareCode, map: doc.environment.map, eye: p.eye,
      source: { playerSpawn: doc.playerSpawn, pool, spawners: doc.spawners.filter((s) => ps.has(s.id)), actors: doc.actors },
      steps: p.steps, route: p.route,
    };
  }
  const about = 'Planner viewpoints of the six *-peekers drills (game bot-order planner hy on the ORIGINAL drills: route = feet points, steps[spawnerId].from = where the route first sees the spot) plus the original pool spawners/actors; input of tools/peek_cover.mjs';
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify({ version: 1, about, drills }) + '\n');
  console.log(`wrote ${path.relative(root, DATA)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--init');
  if (i >= 0) return initData(argv[i + 1]);
  const check = argv.includes('--check'), json = argv.includes('--json'), dry = argv.includes('--dry');
  const wi = argv.indexOf('--walk-half'), walkHalf = wi >= 0 ? Number(argv[wi + 1]) : G.WALK;
  if (!(walkHalf >= 0 && walkHalf < 1)) throw new Error('--walk-half: metres, e.g. 0.3');
  if (walkHalf !== G.WALK && !dry) throw new Error('--walk-half only with --dry (the files are made with G.WALK)');
  if (dry && check) throw new Error('--dry and --check do not go together');
  const res = await generate({ log: (m) => console.error(m), walkHalf });
  const rows = [];
  for (const r of res) {
    for (const f of r.infos) rows.push({ drill: r.stem.replace('-peekers', ''), id: f.id, area: f.area ? `${f.area.x}x${f.area.z}` : '', seen: f.spotSeen, cover: f.cover ? `${f.cover.side > 0 ? 'L' : 'R'} ${f.cover.d}${f.cover.dir === 'diag45' ? ' 45deg' : ''}` : 'NONE', hidden: f.cover ? `${f.hiddenSamples + 1}/${f.samples + 1}` : '', restored: f.restored ? `${f.restored.kind}: ${f.restored.how}` : '', dropped: f.dropped.join('; '), why: f.why ? `${f.why} [L: ${f.sides?.L ?? '-'}; R: ${f.sides?.R ?? '-'}]` : '' });
  }
  if (json) console.log(JSON.stringify(res.map((r) => ({ stem: r.stem, key: r.key, infos: r.infos }))));
  else console.table(rows);
  // Per drill: hidden from all viewpoints / partly / of those via the 45 deg search / no cover (restored a, b, c).
  for (const r of res) {
    const c = { all: 0, partial: 0, diag: 0, none: 0, a: 0, b: 0, c: 0, still: 0 };
    for (const f of r.infos) {
      if (f.cover) { c[f.hiddenSamples === f.samples ? 'all' : 'partial']++; if (f.cover.dir === 'diag45') c.diag++; } else c.none++;
      if (f.restored) c[f.restored.kind]++;
      if (f.why?.includes('stands still')) c.still++;
    }
    console.error(`${r.stem} (walk +-${walkHalf} m): cover all ${c.all}, partial ${c.partial} (45 deg ${c.diag}), no cover ${c.none} (restored a ${c.a}, b ${c.b}, c ${c.c}; still ${c.still})`);
  }
  if (dry) return;
  const sc = scoresText(res);
  const scoresStale = sc.text.replace(/\r\n/g, '\n') !== sc.old.replace(/\r\n/g, '\n');
  if (check) {
    const stale = res.filter((r) => r.stale).map((r) => r.stem);
    if (scoresStale) stale.push('spot-scores.json');
    if (stale.length) { console.error(`stale: ${stale.join(', ')} (run node tools/peek_cover.mjs)`); process.exit(1); }
    console.error('peek_cover: up to date');
    return;
  }
  for (const r of res) if (r.stale) fs.writeFileSync(scenarioFile(r.stem), r.fileText);
  if (scoresStale) fs.writeFileSync(SCORES, sc.text);
  console.error(`wrote ${res.filter((r) => r.stale).length} scenario files${scoresStale ? ' + spot-scores.json' : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
