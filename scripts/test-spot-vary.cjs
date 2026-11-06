// Checks for the per-round spot variation (tools/spotvary_patch.py, tools/spot_alts.mjs): the
// alternatives file covers every shipped pre-aim drill, its entries are well formed and spaced, the
// key function is the same in the tool and the game, the round-start pick only runs in Human-like
// mode for listed drills, and the sim only moves the listed fixed spawners. The geometry checks
// (ground, ledges, walls, sight) run in the app: node tools/spot_alts.mjs --check (tools/README.md).
// The official drills need the game files in site/ (docs/game-files.md) and are skipped without them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf-8');
const JS = [path.join('app', 'mods', 'next', 'js'), path.join('app', 'mods', '_assets', 'r20261021-1', 'next', 'js')];
const slice = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `missing ${from}`);
  const j = src.indexOf(to, i);
  assert.ok(j > i, `missing ${to} after ${from}`);
  return src.slice(i, j + to.length);
};

const toolSrc = read('tools', 'spot_alts.mjs');
const KEY_SRC = JSON.parse('"' + /const KEY_SRC = '([^']*)';/.exec(toolSrc)[1].replace(/"/g, '\\"') + '"');
const aimAltKey = new Function(`${KEY_SRC};return aimAltKey;`)();
const table = JSON.parse(read('app', 'mods', 'aim-ranks', 'spot-alts.json')).scenes;

// Same rule as staticSpots() in tools/spot_alts.mjs.
function staticSpots(doc) {
  if (!doc?.environment?.map || !Array.isArray(doc.spawners) || !Array.isArray(doc.actors)) return [];
  const tm = new Map(doc.actors.map((a) => [a.id, a]));
  const out = doc.spawners.filter((s) => {
    const t = tm.get(s.actorTemplateId);
    return s.kind === 'fixed' && s.maxAlive >= 1 && t?.body?.shape === 'humanoid' && t.behaviors.length > 0 &&
      t.behaviors.every((b) => b.kind === 'shooter' || b.kind === 'respawn');
  });
  return out.length >= 5 ? out.map((s) => s.id) : [];
}

function shippedDrills() {
  const out = [];
  const docOf = (s) => (typeof s.doc === 'string' ? JSON.parse(s.doc) : s.doc);
  const dir = path.join(root, 'site', 'prod-api', 'api', 'v1', 'public', 'val', 'aimlab', 'scenes');
  if (fs.existsSync(dir)) {
    for (const code of fs.readdirSync(dir)) {
      try { out.push({ code, doc: docOf(JSON.parse(fs.readFileSync(path.join(dir, code), 'utf-8')).data) }); } catch {}
    }
  }
  for (const [code, s] of Object.entries(JSON.parse(read('app', 'training-set.json')).scenes)) out.push({ code, doc: docOf(s) });
  return out.filter(({ doc }) => staticSpots(doc).length > 0);
}

// The round-start code from the game (OkAdunfX.js tail) and the sim's scene copy (CnrSARj_.js).
const ok = read(JS[0], 'OkAdunfX.js');
const tail = ok.slice(ok.indexOf('/* aim-spot-vary'));
const game = () => new Function(`${tail};return{aimAltSet,aimAltKey,aimAltPick,aimAltOpts};`)();
const cnr = read(JS[0], 'CnrSARj_.js');
const aimSpotApply = new Function(slice(cnr, 'function aimSpotApply(', 'return n?{...A,spawners:s}:A}') + ';return aimSpotApply;')();

test('the key function is the same in the tool and in both game copies', () => {
  for (const dir of JS) {
    assert.equal(slice(read(dir, 'OkAdunfX.js'), 'function aimAltKey(', '.padStart(8,"0")}'), KEY_SRC);
  }
});

test('both copies of the patched game scripts are identical', () => {
  for (const name of ['OkAdunfX.js', 'CnrSARj_.js', 'C_VPDXvn.js', 'BiMsX6Xn.js']) {
    assert.equal(read(JS[0], name), read(JS[1], name), name);
  }
});

test('every shipped pre-aim drill has an entry; alternatives are well formed and spaced', () => {
  const drills = shippedDrills();
  assert.ok(drills.length >= 20, `only ${drills.length} drills`);
  let spots = 0;
  for (const { code, doc } of drills) {
    const e = table[aimAltKey(doc)];
    assert.ok(e, `${code}: no entry (rerun node tools/spot_alts.mjs, see tools/README.md)`);
    assert.ok(e.codes.includes(code), `${code}: entry lists other drills only`);
    assert.ok(e.ids.includes(doc.meta.id), `${code}: entry does not list meta id ${doc.meta.id}`);
    const eligible = new Set(staticSpots(doc));
    const byId = new Map(doc.spawners.map((s) => [s.id, s]));
    const placed = [];
    for (const [id, alts] of Object.entries(e.alts)) {
      assert.ok(eligible.has(id), `${code}: ${id} is not a static spot`);
      const p = byId.get(id).position;
      assert.ok(alts.length >= 2 && alts.length <= 6, `${code}: ${id} has ${alts.length} entries`);
      assert.deepEqual(alts[0], [p.x, p.y, p.z], `${code}: ${id} first entry is not the authored point`);
      for (const q of alts.slice(1)) {
        assert.ok(q.length === 3 && q.every(Number.isFinite), `${code}: ${id} ${q}`);
        assert.equal(q[1], p.y, `${code}: ${id} stores a y other than the authored one`);
        const d = Math.hypot(q[0] - p.x, q[2] - p.z);
        assert.ok(d >= 0.55 && d <= 1.6, `${code}: ${id} moved ${d.toFixed(2)} m`);
        placed.push({ id, x: q[0], z: q[2] });
      }
      spots++;
    }
    for (const a of placed) {
      for (const s of doc.spawners) {
        if (s.id === a.id) continue;
        const hx = s.kind === 'fixed' ? 0 : Math.abs(s.size?.x ?? 0) / 2, hz = s.kind === 'fixed' ? 0 : Math.abs(s.size?.z ?? 0) / 2;
        const d = Math.hypot(Math.max(0, Math.abs(a.x - s.position.x) - hx), Math.max(0, Math.abs(a.z - s.position.z) - hz));
        assert.ok(d >= 0.8 - 1e-9, `${code}: ${a.id} alternative within ${d.toFixed(2)} m of ${s.id}`);
      }
      for (const b of placed) {
        if (b.id !== a.id) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 0.8 - 1e-9, `${code}: ${a.id} and ${b.id} alternatives too close`);
      }
    }
  }
  assert.ok(spots >= 100, `only ${spots} spots with alternatives`);
});

test('any edit to spots, blocks, bots or the pool changes the key', () => {
  const doc = shippedDrills()[0]?.doc;
  if (!doc) return;
  const base = aimAltKey(doc);
  const edits = [
    (d) => { d.playerSpawn.yaw += 0.1; },
    (d) => { d.spawners[0].position.x += 0.5; },
    (d) => { d.spawners[0].groundSnap = !d.spawners[0].groundSnap; },
    (d) => { d.blocks.push({ id: 'x', shape: 'box', position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }); },
    (d) => { d.actors[0].behaviors = [...(d.actors[0].behaviors || []), { kind: 'strafe', speed: [5.4, 5.4] }]; },
    (d) => { d.environment.map = 'other'; },
  ];
  for (const edit of edits) {
    const d = JSON.parse(JSON.stringify(doc));
    edit(d);
    assert.notEqual(aimAltKey(d), base, String(edit));
  }
  const r = JSON.parse(JSON.stringify(doc));
  r.meta = { ...r.meta, name: 'renamed' };
  r.spawners = r.spawners.map((x) => Object.fromEntries(Object.entries(x).reverse()));
  assert.equal(aimAltKey(r), base);
});

test('round start: Human-like only, listed drills only, pick follows the seed', () => {
  const drill = shippedDrills().find(({ doc }) => table[aimAltKey(doc)]);
  if (!drill) return;
  const g = game();
  g.aimAltSet({ scenes: table });
  const doc = drill.doc;
  const run = (bots, seed, meta = {}) => {
    const o = bots ? { bots } : {};
    g.aimAltOpts(o, { ...doc, meta: { ...doc.meta, ...meta, seed } });
    return o.spotPos;
  };
  assert.equal(run(undefined, 5), undefined, 'Classic mode keeps the authored spots');
  assert.equal(run('human', 5, { id: 'studio-copy' }), undefined, 'a drill id the entry does not list');
  const a = run('human', 5), b = run('human', 5), e = table[aimAltKey(doc)];
  assert.ok(a && Object.keys(a).length === Object.keys(e.alts).length);
  assert.deepEqual(a, b, 'same seed, same spots');
  for (const [id, q] of Object.entries(a)) assert.ok(e.alts[id].some((x) => x.join() === q.join()), id);
  let changed = 0;
  for (let seed = 6; seed < 26; seed++) if (JSON.stringify(run('human', seed)) !== JSON.stringify(a)) changed++;
  assert.ok(changed >= 18, `only ${changed} of 20 other seeds changed the spots`);
  // The pick is spread over every entry.
  const counts = [0, 0, 0, 0];
  for (let seed = 0; seed < 4000; seed++) counts[g.aimAltPick(seed, 'spawner-3', 4)]++;
  for (const c of counts) assert.ok(c > 850 && c < 1150, String(counts));
});

test('sim: only listed fixed spawners move, the scene is not changed, no spotPos = same scene', () => {
  const doc = {
    meta: { id: 'x', seed: 1 },
    spawners: [
      { id: 'a', kind: 'fixed', position: { x: 1, y: 2, z: 3 }, groundSnap: true },
      { id: 'b', kind: 'area', position: { x: 4, y: 5, z: 6 }, size: { x: 2, y: 0, z: 2 } },
      { id: 'c', kind: 'fixed', position: { x: 7, y: 8, z: 9 } },
    ],
  };
  const before = JSON.stringify(doc);
  assert.equal(aimSpotApply(doc, {}), doc);
  assert.equal(aimSpotApply(doc, { spotPos: null }), doc);
  assert.equal(aimSpotApply(doc, { spotPos: { c: [1, 2] } }), doc, 'bad entry ignored');
  const out = aimSpotApply(doc, { spotPos: { a: [1.5, 2, 3.25], b: [0, 0, 0], c: [NaN, 0, 0] } });
  assert.notEqual(out, doc);
  assert.deepEqual(out.spawners[0], { ...doc.spawners[0], position: { x: 1.5, y: 2, z: 3.25 } });
  assert.equal(out.spawners[1], doc.spawners[1], 'area spawners stay');
  assert.equal(out.spawners[2], doc.spawners[2], 'non-finite entries ignored');
  assert.equal(JSON.stringify(doc), before);
});

test('both replay world builders pass spotPos from the meta', () => {
  for (const dir of JS) {
    const src = read(dir, 'C_VPDXvn.js');
    assert.equal(src.split('spotPos:e.meta.spotPos??null').length - 1, 2);
  }
});

// ---- Pre-aim bots move when they see you (tools/peekmove_patch.py) ----

test('lanes: one per position, well formed, inside 1.5 m', () => {
  let n = 0;
  for (const [key, e] of Object.entries(table)) {
    for (const [id, ls] of Object.entries(e.lanes ?? {})) {
      const positions = e.alts[id]?.length ?? 1;
      assert.equal(ls.length, positions, `${key} ${id}: ${ls.length} lanes for ${positions} positions`);
      for (const l of ls) {
        if (l === null) continue;
        assert.ok(l.length === 4 && l.every(Number.isFinite), `${key} ${id}: ${l}`);
        assert.ok(Math.abs(Math.hypot(l[0], l[1]) - 1) < 1e-3, `${key} ${id}: axis ${l[0]},${l[1]}`);
        assert.ok(l[2] <= 0 && l[3] >= 0 && l[2] >= -1.5 && l[3] <= 1.5 && l[3] - l[2] >= 0.3, `${key} ${id}: extents ${l[2]}..${l[3]}`);
        n++;
      }
    }
  }
  assert.ok(n >= 500, `only ${n} lanes`);
});

test('round start: bots move only with an explicit rank in Human-like mode, same spots either way', () => {
  const drill = shippedDrills().find(({ doc }) => {
    const e = table[aimAltKey(doc)];
    return e && Object.keys(e.lanes ?? {}).length && doc.actors.some((a) => a.behaviors.some((b) => b.kind === 'shooter'));
  });
  if (!drill) return;
  const g = game();
  g.aimAltSet({ scenes: table });
  const doc = drill.doc, e = table[aimAltKey(doc)];
  const run = (o, seed) => { g.aimAltOpts(o, { ...doc, meta: { ...doc.meta, seed } }); return o; };
  const def = run({ bots: 'human' }, 9), ranked = run({ bots: 'human', enemyRank: 'gold' }, 9), classic = run({ enemyRank: 'gold' }, 9);
  assert.equal(def.peekMove, undefined, 'Default rank: static');
  assert.equal(def.spotLane, undefined);
  assert.equal(classic.peekMove, undefined, 'Classic: static');
  assert.equal(classic.spotPos, undefined);
  assert.deepEqual(ranked.spotPos, def.spotPos, 'the rank does not change the positions');
  assert.equal(ranked.peekMove, true);
  const tm = new Map(doc.actors.map((a) => [a.id, a]));
  for (const [id, l] of Object.entries(ranked.spotLane)) {
    const s = doc.spawners.find((x) => x.id === id);
    assert.ok(tm.get(s.actorTemplateId).behaviors.some((b) => b.kind === 'shooter'), `${id} does not shoot`);
    const i = e.alts[id] ? e.alts[id].findIndex((q) => q.join() === ranked.spotPos[id].join()) : 0;
    assert.deepEqual(l, e.lanes[id][i], `${id}: lane of another position`);
  }
});

const cnrPeek = new Function(slice(cnr, 'function aimPeekList(', 'c.set(h.spawnerId,b);return b}') + ';return aimPeekList;')();

test('sim: aimPeek only for static shooters with a lane, cached per spawner', () => {
  const shooter = { body: { shape: 'humanoid' }, behaviors: [{ kind: 'respawn' }, { kind: 'shooter' }] };
  const strafer = { body: { shape: 'humanoid' }, behaviors: [{ kind: 'shooter' }, { kind: 'strafe' }] };
  const target = { body: { shape: 'humanoid' }, behaviors: [{ kind: 'respawn' }] };
  const lanes = { a: [1, 0, -1, 1], b: [1, 0, -1, 1], c: [1, 0, -1, 1], d: [1, 0, 0.5, 1] };
  const cache = new Map();
  const a = cnrPeek(cache, { spawnerId: 'a' }, shooter, lanes, 'gold');
  assert.deepEqual(a.map((x) => x.kind), ['respawn', 'shooter', 'aimPeek']);
  assert.deepEqual(a[2], { kind: 'aimPeek', lane: lanes.a, rank: 'gold' });
  assert.equal(cnrPeek(cache, { spawnerId: 'a' }, shooter, lanes, 'gold'), a, 'cached');
  assert.equal(cnrPeek(cache, { spawnerId: 'b' }, strafer, lanes, 'gold'), strafer.behaviors);
  assert.equal(cnrPeek(cache, { spawnerId: 'c' }, target, lanes, 'gold'), target.behaviors);
  assert.equal(cnrPeek(cache, { spawnerId: 'd' }, shooter, lanes, 'gold'), shooter.behaviors, 'lane must contain the spot');
  assert.equal(cnrPeek(cache, { spawnerId: 'e' }, shooter, lanes, 'gold'), shooter.behaviors, 'no lane');
});

test('aimPeek is wired in: behaviour registry, world builder, both replay builders', () => {
  for (const dir of JS) {
    const bi = read(dir, 'BiMsX6Xn.js');
    assert.ok(bi.includes('aimPeek:{init(){},update(n,e,t,i){aimPeekUpdate(n,e,t,i)}}'));
    assert.equal(bi.split('function aimPeekUpdate(').length - 1, 1);
    // no game random numbers in the new behaviour
    const body = slice(bi, 'function aimPeekUpdate(', 's.phase==="go"&&step()}');
    assert.ok(!/\be\.rng\b/.test(body), 'aimPeekUpdate must not draw e.rng');
    // a new leg only starts while the bot sees the player this tick (not during the shooter's sight grace)
    assert.ok(body.includes('t.elapsed<s.until||r.lastSeenTick!==t.tick)return;'));
    const c = read(dir, 'CnrSARj_.js');
    assert.ok(c.includes('aimPK=g.peekMove===!0&&aimBM&&aimBR&&g.spotLane'));
    assert.ok(c.includes('z=IE.has(h.spawnerId)?aB(Z):aimPK?aimPeekList(aimPK,h,Z,g.spotLane,aimBR):Z.behaviors,'));
    const v = read(dir, 'C_VPDXvn.js');
    assert.equal(v.split('peekMove:e.meta.peekMove??null,spotLane:e.meta.spotLane??null').length - 1, 2);
  }
});
