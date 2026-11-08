// Round mode S4: the attacker bots (defense side) on Corrode's (rook) REAL collision: the same run
// checks as test-round-bots-attack.mjs (Ascent) on the second round map. Attackers wait behind
// their barriers (never across), stage on their plan route, go together, the carrier plants on the
// plan site within 40 s of the drop on a plant spot, the rest hold distinct post-plant spots; a
// carrier killed on the way or mid-plant -> the spike is fetched and replanted. No bot stuck or off
// the floor. Uses scripts/round-bots-sweep.mjs with ROUND_MAP=rook (its ASCENT / NAV_AB then hold
// Corrode's data). Needs the game files in site/ (skipped without them). Heavy: run it on hp
// (npm run test:round in app/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ROUND_MAP = 'rook';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(root, 'app', 'mods');
const { terrainSources, loadTerrain } = await import(pathToFileURL(path.join(root, 'tools', 'round_terrain.mjs')).href);
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'next', 'js', 'CK5kb5jb.js')) && !!terrainSources('rook', root);
const skip = !HAVE_SITE && 'no game files in site/';
let sim = null, T = null, SW = null;
if (HAVE_SITE) {
  register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);
  SW = await import(pathToFileURL(path.join(root, 'scripts', 'round-bots-sweep.mjs')).href);
}
const terrain = async () => (T ??= await loadTerrain('rook', { root }));
const run = async (o) => SW.attackRun({ sim, W: await terrain(), ...o });

function checkRun(m, label) {
  const tag = `${label} [plan ${m.plan.site} seed ${m.seed}]`;
  assert.equal(m.bots, 5, `${tag}: 5 bots`);
  assert.equal(m.nav, true, `${tag}: every bot on the nav`);
  assert.equal(m.routeOk, true, `${tag}: routes from cfg.attack`);
  assert.equal(m.crossings, 0, `${tag}: crossed an attacker barrier in the barrier phase`);
  assert.equal(m.outside, 0, `${tag}: left the attacker side in the barrier phase`);
  assert.equal(m.offFloor, 0, `${tag}: off the nav floors ${JSON.stringify(m.offFloorAt)}`);
  assert.equal(m.stuck, 0, `${tag}: stuck ${JSON.stringify(m.stuckAt)}`);
  assert.ok(m.maxPlanters <= 1 && m.plantingNotCarrier === 0, `${tag}: one planter, the carrier`);
  assert.ok(m.minStillBarrier >= 0.8, `${tag}: waiting bots ${m.minStillBarrier} m apart`);
  assert.ok(m.plant >= 0, `${tag}: planted`);
  assert.ok(m.plantAfterLive <= 40, `${tag}: planted ${m.plantAfterLive} s after the drop`);
  assert.equal(m.plantSite, m.plan.site, `${tag}: planted on the plan site`);
  assert.ok(m.plantNodeDist < 0.1, `${tag}: spike ${m.plantNodeDist} m from a plant spot`);
  assert.ok(m.planter !== null, `${tag}: a bot stands on the spike`);
  assert.ok(m.post && m.post.assigned === Math.min(m.post.alive, m.post.spots) && m.post.distinct === m.post.assigned && m.post.held === m.post.assigned, `${tag}: post-plant spots ${JSON.stringify(m.post)}`);
}

test('S4 real Corrode: the sweep module runs on Corrode; the defense doc carries Corrode\'s attack data and plan', { skip }, () => {
  assert.equal(SW.MAP, 'rook');
  const doc = SW.defenseDoc({ planSeed: 1 }), r = doc.rules.round;
  assert.equal(r.map, 'rook'); assert.equal(r.side, 'defense');
  assert.deepEqual(r.attackData, SW.ASCENT.attack, 'rook.json attack data');
  assert.ok(['A', 'B'].includes(r.attack.site));
  const N = SW.useNav();
  assert.ok(N && N.g.count > 0, 'rook nav');
  assert.ok(N.header.attack, 'rook nav header has attack staging / plant / post-plant data');
});

test('S4 real Corrode: A and B, both movement modes, with and without a lurker: wait behind the barriers, stage, go together, plant within 40 s of the drop, distinct post-plant spots', { skip }, async () => {
  const cases = [
    { planSeed: SW.planSeedFor('A', { lurker: false }), barrierSec: 10, extra: {} },
    { planSeed: SW.planSeedFor('A', { lurker: true }), barrierSec: 20, extra: { movement: 'game' } },
    { planSeed: SW.planSeedFor('B', { lurker: false }), barrierSec: 10, extra: { movement: 'game' } },
    { planSeed: SW.planSeedFor('B', { lurker: true }), barrierSec: 30, extra: {} },
  ];
  for (const c of cases) {
    const m = await run({ doc: SW.defenseDoc(c), seed: 3, extra: c.extra });
    checkRun(m, `Corrode ${c.extra.movement ?? 'default'} barrier ${c.barrierSec}`);
    console.log(`Corrode plan ${m.plan.site} seed ${c.planSeed} (${c.extra.movement ?? 'default'}, barrier ${c.barrierSec}): go ${m.goAfterLive} s after the drop (${m.stagedAtGo}/${m.members} staged, gather ${m.plan.gatherSec}), planted ${m.plantAfterLive} s after the drop, post ${JSON.stringify(m.post)}`);
  }
});

test('S4 real Corrode: carrier killed on the way / mid-plant -> fetched and replanted', { skip }, async () => {
  for (const c of [
    { planSeed: SW.planSeedFor('A', { lurker: false }), barrierSec: 10, extra: {}, kill: 'route' },
    { planSeed: SW.planSeedFor('B', { lurker: false }), barrierSec: 10, extra: { movement: 'game' }, kill: 'midplant' },
  ]) {
    const m = await run({ doc: SW.defenseDoc(c), seed: 3, extra: c.extra, kill: c.kill });
    const tag = `Corrode ${c.kill} kill plan ${m.plan.site}`;
    assert.ok(m.killed, `${tag}: killed`);
    assert.equal(m.drops.length, 1, `${tag}: one drop`);
    assert.equal(m.pickups.length, 1, `${tag}: picked up`);
    assert.equal(m.pickups[0].id, m.fetcher, `${tag}: by the latched fetcher`);
    checkRun(m, tag);
    console.log(`${tag}: fetch walk ${m.fetchWalk} m, planted ${m.plantAfterLive} s after the drop`);
  }
});
