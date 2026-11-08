// Map preview checks (tools/maps_previews.mjs, app/mods/aim-maps/maps.json + <map>.preview.png, the
// Practice panel's map box in app/practice-panel.js):
//  - maps.json lists all 9 maps; every preview PNG decodes, matches its size and stays small;
//  - world -> pixel is the in-game minimap's own transform (Gs/bl/qs lifted from Dc2Dm9E6.js),
//    so the picture has the game minimap's orientation (attackers at the bottom);
//  - the facing convention (forward = (-sin yaw, -cos yaw)) puts the bot spots in front of you;
//  - the panel's markers are where app/practice-scene.js buildDoc puts the bots and the player;
//  - the spawns and spots land on drawn floor;
//  - the committed files are what the tool writes (--check).
// Runs in node only. Skipped without the game files in site/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { constSrc, fnSrc } from '../tools/round_terrain.mjs';
import { decodePng } from '../tools/maps_previews.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf-8').replace(/\r\n/g, '\n');
const AIM = path.join(root, 'app', 'mods', 'aim-maps');
const MAPS = [['ascent', 'Ascent'], ['bonsai', 'Split'], ['triad', 'Haven'], ['plummet', 'Summit'], ['jam', 'Lotus'], ['infinity', 'Abyss'], ['rook', 'Corrode'], ['duality', 'Bind'], ['juliett', 'Sunset']];
const maps = JSON.parse(read('app', 'mods', 'aim-maps', 'maps.json'));
const areas = JSON.parse(read('app', 'mods', 'aim-practice', 'areas.json'));
const P = require(path.join(root, 'app', 'practice-scene.js'));
const mini = (id) => JSON.parse(read('app', 'mods', 'aim-maps', `${id}.minimap.json`));
const px = (e, x, z) => [e.world.a * x + e.world.b * z + e.world.c, e.world.d * x + e.world.e * z + e.world.f];
const HAVE_SITE = fs.existsSync(path.join(root, 'site', 'aim-maps', 'ascent.collision.json'));

test('maps.json has the 9 maps, English names, previews that decode at their size and stay small', () => {
  assert.deepEqual(maps.map((m) => [m.id, m.name]), MAPS);
  for (const m of maps) {
    assert.equal(m.preview, `/aim-maps/${m.id}.preview.png`);
    assert.ok(Number.isInteger(m.size[0]) && Number.isInteger(m.size[1]) && m.size[0] > 100 && m.size[1] > 100, `${m.id}: size`);
    assert.ok(Math.max(...m.size) <= 640, `${m.id}: size ${m.size}`);
    for (const k of 'abcdef') assert.ok(Number.isFinite(m.world[k]), `${m.id}: world.${k}`);
    const buf = fs.readFileSync(path.join(AIM, `${m.id}.preview.png`));
    assert.ok(buf.length < 150 * 1024, `${m.id}: ${buf.length} bytes`);
    const d = decodePng(buf);
    assert.deepEqual([d.w, d.h], m.size, `${m.id}: decoded size`);
  }
});

test('world -> pixel is the game minimap transform (Gs/bl/qs from Dc2Dm9E6.js), both bundle copies', () => {
  const lifts = [path.join('app', 'mods', 'next', 'js'), path.join('app', 'mods', '_assets', 'r20261021-1', 'next', 'js')].map((dir) => {
    const src = read(dir, 'Dc2Dm9E6.js');
    const ctx = { Math };
    vm.createContext(ctx);
    vm.runInContext([constSrc(src, 'Gs'), fnSrc(src, 'bl'), fnSrc(src, 'qs'), 'var __q=qs;'].join('\n'), ctx);
    return ctx.__q;
  });
  for (const m of maps) {
    const mm = mini(m.id);
    const pts = mm.callouts.map((c) => [c.x, c.z]);
    for (const a of areas.maps[m.id].areas) { pts.push([a.spawn.x, a.spawn.z]); for (const s of a.spots) pts.push([s.x, s.z]); }
    for (const qs of lifts) for (const [x, z] of pts) {
      const q = qs(mm, x, z), [u, v] = px(m, x, z);
      const eu = m.mm.scale * (q.u - m.mm.u0), ev = m.mm.scale * (q.v - m.mm.v0);
      assert.ok(Math.abs(u - eu) < 0.01 && Math.abs(v - ev) < 0.01, `${m.id}: (${x},${z}) -> ${u},${v} but the minimap says ${eu},${ev}`);
    }
    // no mirror: the transform is a rotation + uniform scale
    const { a, b, d, e } = m.world;
    assert.ok(a * e - b * d > 0, `${m.id}: mirrored`);
    assert.ok(Math.abs(Math.hypot(a, d) - Math.hypot(b, e)) < 1e-4, `${m.id}: not uniform`);
  }
});

test('attackers are at the bottom of every preview', () => {
  for (const m of maps) {
    const c = mini(m.id).callouts;
    const att = c.find((k) => k.name === 'Attacker Spawn'), def = c.find((k) => k.name === 'Defender Spawn');
    assert.ok(att && def, `${m.id}: spawn callouts`);
    assert.ok(px(m, att.x, att.z)[1] > px(m, def.x, def.z)[1], `${m.id}: attacker spawn is not below defender spawn`);
  }
});

// Pre-aim drills walk around corners, so some spots end up behind the start (rook's B-from-mid and
// mid-to-A areas have half of theirs behind): >= 85% over all maps, and more in front than behind
// on every map (the opposite convention fails both by far).
test('facing: forward = (-sin yaw, -cos yaw) puts the spots in front of their spawn', () => {
  let front = 0, all = 0;
  for (const [map, M] of Object.entries(areas.maps)) {
    let f = 0, n = 0;
    for (const a of M.areas) {
      const fx = -Math.sin(a.spawn.yaw), fz = -Math.cos(a.spawn.yaw);
      for (const s of a.spots) { n++; if ((s.x - a.spawn.x) * fx + (s.z - a.spawn.z) * fz > 0) f++; }
    }
    assert.ok(f / n > 0.6, `${map}: only ${f}/${n} spots in front`);
    front += f; all += n;
  }
  assert.ok(front / all >= 0.85, `only ${front}/${all} spots in front`);
});

test('panel markers are where buildDoc puts the player and the bots', () => {
  const src = read('app', 'practice-panel.js');
  const markers = vm.runInNewContext(`${fnSrc(src, 'practiceMarkers')}; practiceMarkers`, { Math });
  let cases = 0;
  for (const [map, M] of Object.entries(areas.maps)) for (const a of M.areas) {
    for (const [bots, count] of [['none', 0], ['static', 1], ['static', 5], ['static', 12], ['strafe', 1], ['strafe', 5], ['strafe', 12]]) {
      const doc = P.buildDoc(M, a, { map, area: a.id, weapon: 'vandal', bots, count });
      const mk = markers(a, bots, count);
      assert.deepEqual([mk.spawn.x, mk.spawn.z, mk.spawn.yaw], [doc.playerSpawn.position.x, doc.playerSpawn.position.z, doc.playerSpawn.yaw]);
      assert.equal(mk.bots.length, doc.spawners.length, `${map}/${a.id} ${bots} ${count}: marker count`);
      doc.spawners.forEach((sp, i) => {
        const b = mk.bots[i], tag = `${map}/${a.id} ${bots} ${count} bot ${i + 1}`;
        assert.ok(Math.abs(b.x - sp.position.x) <= 0.0015 && Math.abs(b.z - sp.position.z) <= 0.0015, `${tag}: ${b.x},${b.z} vs ${sp.position.x},${sp.position.z}`);
        const strafing = doc.actors.find((t) => t.id === sp.actorTemplateId).behaviors.find((x) => x.kind === 'strafe');
        assert.equal(!!b.lane, !!strafing, `${tag}: lane shown iff the bot strafes`);
        if (!strafing) return;
        const [x1, z1, x2, z2] = b.lane, len = Math.hypot(x2 - x1, z2 - z1);
        // along the bot's right vector (the spawner's rotationY) and as long as its widest swing
        assert.ok(Math.abs((x2 - x1) / len - Math.cos(sp.rotationY)) < 0.002 && Math.abs((z2 - z1) / len + Math.sin(sp.rotationY)) < 0.002, `${tag}: lane direction`);
        assert.ok(Math.abs(len - strafing.travel[1]) <= 0.011, `${tag}: lane ${len} vs travel ${strafing.travel[1]}`);
        assert.ok(Math.abs((x1 + x2) / 2 - sp.position.x) <= 0.0015 && Math.abs((z1 + z2) / 2 - sp.position.z) <= 0.0015, `${tag}: lane middle`);
      });
      cases++;
    }
  }
  assert.ok(cases >= 200, `${cases} cases`);
});

test('every practice spawn and spot is inside its preview, >= 95% on drawn floor', () => {
  for (const m of maps) {
    const d = decodePng(fs.readFileSync(path.join(AIM, `${m.id}.preview.png`)));
    const solid = (x, y) => { // the pixel or one next to it (spots right at a wall)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = Math.floor(x) + dx, Y = Math.floor(y) + dy;
        if (X >= 0 && Y >= 0 && X < d.w && Y < d.h && d.rgba[(Y * d.w + X) * 4 + 3] === 255) return true;
      }
      return false;
    };
    let on = 0, all = 0;
    const miss = [];
    for (const a of areas.maps[m.id].areas) for (const [kind, p] of [['spawn', a.spawn], ...a.spots.map((s) => ['spot', s])]) {
      const [x, y] = px(m, p.x, p.z);
      assert.ok(x >= 0 && y >= 0 && x < d.w && y < d.h, `${m.id}/${a.id} ${kind} outside the image`);
      all++;
      if (solid(x, y)) on++; else miss.push(`${a.id} ${kind} ${p.x},${p.z}`);
    }
    assert.ok(on / all >= 0.95, `${m.id}: ${on}/${all} on floor; off: ${miss.join('; ')}`);
    // every area's own spawn is on floor
    for (const a of areas.maps[m.id].areas) { const [x, y] = px(m, a.spawn.x, a.spawn.z); assert.ok(solid(x, y), `${m.id}/${a.id}: spawn off the floor`); }
  }
});

test('committed previews are what tools/maps_previews.mjs writes', { skip: !HAVE_SITE && 'no site/aim-maps' }, () => {
  const out = execFileSync(process.execPath, [path.join(root, 'tools', 'maps_previews.mjs'), '--check'], { encoding: 'utf-8' });
  assert.match(out, /up to date/);
});
