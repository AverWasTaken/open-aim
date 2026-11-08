// Round mode, attack side: where the 5 defender bots stand. Real patched sim, real nav, the map's
// real collision (tools/round_terrain.mjs), player idle at its attacker spawn (out of sight).
// Per seed: the kept setups (group/name, from roundPrepare's split) and, at the barrier drop and
// --after seconds later, each bot's mode, position and distance to its setup spot. Summary: group
// counts per split, bots not standing on their setup at drop+after (> 1.5 m away or not in hold),
// stuck bots, and pairs of bots closer than 3 m. With --look (Ascent B: the attacker's way in, see
// LOOK) also how many of the site's bots an attacker can see from that path (sight rays from eye
// 1.6 m to the bot's body 1.0 / head 1.6 m) at the drop + 10 s, and how many rounds show none.
// --set "name,name,..." forces those setups (one bot each) instead of the seeded split.
// --data <dir> reads <map>.json / <map>.nav.bin from <dir> (e.g. an older copy to compare).
// Heavy-ish (about 1 s per seed): run it on hp.
//   node scripts/round-defense-spread.mjs [--map ascent] [--seeds 50] [--from 1] [--barrier 20] [--after 20]
//     [--look B] [--set "B main pocket,B main door"] [--data dir] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(root, 'app', 'mods');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MAP = arg('--map', 'ascent'), SEEDS = +arg('--seeds', 50), FROM = +arg('--from', 1);
const BARRIER = +arg('--barrier', 20), AFTER = +arg('--after', 20), OUT = arg('--json', null);
const LOOK_SITE = arg('--look', null), SET = arg('--set', null)?.split(',').map((n) => n.trim()).filter(Boolean) ?? null;
const DATA_DIR = arg('--data', path.join(MODS, 'aim-rounds'));
// The attacker's ways into a site (scripts/round-look.mjs; snapped to the nearest nav node), plus the lane.
const { LOOK: LOOK0, LOOK_LANE } = await import(pathToFileURL(path.join(root, 'scripts', 'round-look.mjs')).href);
const LOOK = { [MAP]: { [LOOK_SITE]: { ...(LOOK0[MAP]?.[LOOK_SITE] ?? {}), ...(LOOK_LANE[MAP]?.[LOOK_SITE] ?? {}) } } };
const TPS = 128;
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };

register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
const bots = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-bots.mjs')).href);
const sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);
const { loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
const { buildDoc } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
const navlib = await import(pathToFileURL(path.join(root, 'tools', 'round_navlib.mjs')).href);
const { parseRoundNav } = await import(pathToFileURL(path.join(MODS, 'aim-rounds', 'round-nav.mjs')).href);
const DATA = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${MAP}.json`), 'utf-8'));
const NAV = fs.readFileSync(path.join(DATA_DIR, `${MAP}.nav.bin`));
globalThis.__aimRoundNav = { [MAP]: NAV.buffer.slice(NAV.byteOffset, NAV.byteOffset + NAV.byteLength) };
const MODE = Object.fromEntries(Object.entries(bots.roundBotsInternals.MODE).map(([k, v]) => [v, k]));
const W = await loadTerrain(MAP, { root });
const G = parseRoundNav(NAV), GH = navlib.nodeIndex(G);
const views = Object.entries(LOOK[MAP]?.[LOOK_SITE] ?? {}).map(([name, [x, z]]) => {
  const k = navlib.nearestNode(G, GH, x, z, 2);
  if (k < 0) throw new Error(`look point ${name}: no nav node within 2 m`);
  return { name, eye: [G.x[k], G.y[k] + 1.6, G.z[k]] };
});
if (LOOK_SITE && !views.length) throw new Error(`--look ${LOOK_SITE}: no look points for ${MAP}`);
// Which look points see bot b (alive): body 1.0 m or head 1.6 m above its feet.
const seenFrom = (b) => views.filter((v) => W.sight(v.eye, [b.x, b.y + 1.0, b.z]) || W.sight(v.eye, [b.x, b.y + 1.6, b.z])).map((v) => v.name);

const r2 = (v) => Math.round(v * 100) / 100;
function snap(st, cfg) {
  return st.actors.map((a) => {
    const su = cfg.setupBySpawner?.[a.spawnerId], b = a.behavior.roundBot ?? {}, p = a.position;
    return {
      id: a.id, group: su?.group ?? '?', name: su?.name ?? '?', alive: a.alive, mode: MODE[b.mode] ?? b.mode,
      x: r2(p.x), y: r2(p.y), z: r2(p.z), d: su ? r2(Math.hypot(p.x - su.x, p.z - su.z)) : null,
    };
  });
}

const runs = [];
const t0 = Date.now();
for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  const doc = buildDoc(DATA, { side: 'attack', weapon: 'vandal', barrierSec: BARRIER });
  const cfg = doc.rules.round;
  if (SET) { // one bot per named setup (as round-bots-sweep realDoc)
    const byName = Object.fromEntries(Object.entries(cfg.setupBySpawner).map(([id, su]) => [su.name, id]));
    const ids = SET.map((n) => byName[n]);
    if (!ids.every(Boolean)) throw new Error(`--set: unknown setup in ${SET}`);
    cfg.setups = { groups: { all: ids }, splits: [[ids.length]], count: ids.length };
    doc.spawners = doc.spawners.filter((sp) => ids.includes(sp.id));
  }
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed, terrain: W });
  let live = -1, atDrop = null, after = null, look = null;
  for (let i = 0; i < (BARRIER + AFTER + 5) * TPS; i++) {
    s.step(IDLE);
    const st = s.saveState(), r = st.aimRound;
    if (live < 0 && r.phase !== 'barrier') { live = r.tick; atDrop = snap(st, cfg); }
    if (views.length && live >= 0 && !look && r.tick >= live + 10 * TPS) {
      look = snap(st, cfg).filter((b) => b.group === LOOK_SITE && b.alive).map((b) => ({ name: b.name, from: seenFrom(b) }));
    }
    if (live >= 0 && r.tick >= live + AFTER * TPS) { after = snap(st, cfg); break; }
  }
  const groups = {};
  for (const b of atDrop ?? []) groups[b.group] = (groups[b.group] ?? 0) + 1;
  runs.push({ seed, groups, atDrop, after, look });
  const fmt = (L) => (L ?? []).map((b) => `${b.group}:${b.name}[${b.mode} d${b.d} @${b.x},${b.y},${b.z}]`).join(' | ');
  console.log(`seed ${seed} ${JSON.stringify(groups)}\n  drop  ${fmt(atDrop)}\n  +${AFTER}s  ${fmt(after)}`);
  if (look) console.log(`  look ${LOOK_SITE} +10s: ${look.map((l) => `${l.name} <- ${l.from.join('/') || 'nobody'}`).join(' | ') || '(no bots there)'}`);
}
// Summary
const splitCount = {}, notThere = [], stuck = [], close = [], nameUse = {};
for (const r of runs) {
  const k = ['A', 'mid', 'B'].map((g) => r.groups[g] ?? 0).join('-');
  splitCount[k] = (splitCount[k] ?? 0) + 1;
  for (const b of r.after ?? []) {
    nameUse[b.name] = (nameUse[b.name] ?? 0) + 1;
    if (b.mode === 'stuck') stuck.push({ seed: r.seed, ...b });
    else if (b.d === null || b.d > 1.5 || b.mode !== 'hold') notThere.push({ seed: r.seed, name: b.name, mode: b.mode, d: b.d });
  }
  const L = r.after ?? [];
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const d = Math.hypot(L[i].x - L[j].x, L[i].z - L[j].z);
    if (d < 3) close.push({ seed: r.seed, a: L[i].name, b: L[j].name, d: r2(d) });
  }
}
console.log('\nsplits A-mid-B:', JSON.stringify(splitCount));
console.log('setup use:', JSON.stringify(nameUse));
console.log(`not on setup at drop+${AFTER}s (>1.5 m or not hold):`, notThere.length, JSON.stringify(notThere.slice(0, 40)));
console.log('stuck:', stuck.length, JSON.stringify(stuck.slice(0, 20)));
console.log('pairs < 3 m:', close.length, JSON.stringify(close.slice(0, 20)));
if (views.length) {
  const withSite = runs.filter((r) => r.look?.length), none = withSite.filter((r) => !r.look.some((l) => l.from.length));
  const seen = withSite.reduce((n, r) => n + r.look.filter((l) => l.from.length).length, 0), total = withSite.reduce((n, r) => n + r.look.length, 0);
  console.log(`look ${LOOK_SITE}: rounds with ${LOOK_SITE} bots ${withSite.length}; rounds where none of them is visible from the way in: ${none.length} (seeds ${none.map((r) => r.seed).join(',') || '-'}); bots visible ${seen}/${total}`);
}
console.log(`time ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(runs));
