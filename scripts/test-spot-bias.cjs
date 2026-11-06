// Checks for the rank-biased spot choice (tools/spotbias_patch.py, tools/spot_scores.mjs):
// the score file covers every shipped drill with a random spot pool, the key function is the same
// in the tool and the game, and the patched pick is identical to the original without a bias.
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

const toolSrc = read('tools', 'spot_scores.mjs');
const KEY_SRC = JSON.parse('"' + /const KEY_SRC = '([^']*)';/.exec(toolSrc)[1].replace(/"/g, '\\"') + '"');
const aimSpotKey = new Function(`${KEY_SRC};return aimSpotKey;`)();
const table = JSON.parse(read('app', 'mods', 'aim-ranks', 'spot-scores.json')).scenes;

test('the key function is the same in the tool and in both game copies', () => {
  for (const dir of JS) {
    const ok = read(dir, 'OkAdunfX.js');
    assert.equal(slice(ok, 'function aimSpotKey(', '.padStart(8,"0")}'), KEY_SRC);
  }
});

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
  return out.filter(({ doc }) => {
    const p = doc?.rules?.spawnerPick;
    return p && p.pool.length >= 3 && Math.floor(p.count) > 0 && Math.floor(p.count) < p.pool.length;
  });
}

test('every shipped drill with a random spot pool has scores for its whole pool', () => {
  const drills = shippedDrills();
  assert.ok(drills.length >= 10);
  for (const { code, doc } of drills) {
    const e = table[aimSpotKey(doc)];
    assert.ok(e, `${code}: no entry (rerun node tools/spot_scores.mjs, see tools/README.md)`);
    assert.ok(e.codes.includes(code), `${code}: entry lists other drills only`);
    assert.ok(e.ids.includes(doc.meta.id), `${code}: entry does not list meta id ${doc.meta.id}`);
    for (const id of doc.rules.spawnerPick.pool) {
      const p = e.scores[id];
      assert.ok(typeof p === 'number' && p >= 0 && p <= 1, `${code}: ${id} score ${p}`);
    }
  }
});

// The patched pI (with its helpers) from the sim, and the original pI as it was before the patch.
const cnr = read(JS[0], 'CnrSARj_.js');
const pI = new Function('VI', slice(cnr, 'const aimSpotRankBias=', 'B.add(C[E])}return B}') + ';return pI;')(24301);
const oldPI = new Function('VI', 'return function pI(A,g){const D=A.rules.spawnerPick;if(!D)return null;const w=new Set(D.pool),B=new Set,C=[];for(const E of A.spawners)w.has(E.id)?C.push(E.id):B.add(E.id);const Q=Math.max(0,Math.min(C.length,Math.floor(D.count))),I=g.fork(VI);for(let E=0;E<Q;E+=1){const P=E+Math.floor(I.next()*(C.length-E)),o=C[E];C[E]=C[P],C[P]=o,B.add(C[E])}return B}')(24301);

// Small deterministic stand-in for the game's rng: fork(n) and next() in [0, 1).
function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, fork: (n) => rng(Math.imul(seed ^ n, 2654435761)), calls: 0 };
}
function drill(n, count) {
  const spawners = Array.from({ length: n + 2 }, (_, i) => ({ id: `s${i}` }));
  return { spawners, rules: { spawnerPick: { pool: spawners.slice(1, n + 1).map((s) => s.id), count } } };
}
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

test('any edit the planner could see changes the key', () => {
  const doc = shippedDrills()[0].doc;
  const base = aimSpotKey(doc);
  const edits = [
    (d) => { d.playerSpawn.yaw += 0.1; },
    (d) => { d.spawners[0].position.x += 0.5; },
    (d) => { d.spawners[0].groundSnap = !d.spawners[0].groundSnap; },
    (d) => { d.spawners[0].rotationY = 1; },
    (d) => { d.blocks.push({ id: 'x', shape: 'box', position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }); },
    (d) => { d.actors[0].behaviors = [...(d.actors[0].behaviors || []), { kind: 'strafe', speed: [5.4, 5.4] }]; },
    (d) => { d.rules.spawnerPick.count -= 1; },
  ];
  if (doc.blocks.length) edits.push((d) => { d.blocks[0].bulletCollidable = !d.blocks[0].bulletCollidable; });
  for (const edit of edits) {
    const d = JSON.parse(JSON.stringify(doc));
    edit(d);
    assert.notEqual(aimSpotKey(d), base, String(edit));
  }
  // Key order and the drill's meta (name, id) don't matter.
  const r = JSON.parse(JSON.stringify(doc));
  r.meta = { ...r.meta, name: 'renamed' };
  r.spawners = r.spawners.map((x) => Object.fromEntries(Object.entries(x).reverse()));
  assert.equal(aimSpotKey(r), base);
});

test('the patched pick without a bias is the original pick', () => {
  for (const [n, count] of [[18, 10], [21, 18], [25, 12], [4, 0]]) {
    const doc = drill(n, count);
    const half = Object.fromEntries(doc.rules.spawnerPick.pool.map((id) => [id, 0.5]));
    const ramp = Object.fromEntries(doc.rules.spawnerPick.pool.map((id, i) => [id, i / (n - 1)]));
    for (let seed = 1; seed <= 200; seed++) {
      const old = oldPI(doc, rng(seed));
      assert.ok(same(pI(doc, rng(seed)), old));
      assert.ok(same(pI(doc, rng(seed), null), old));
      assert.ok(same(pI(doc, rng(seed), { rank: 'platinum', scores: ramp }), old), 'platinum has no bias');
      assert.ok(same(pI(doc, rng(seed), { rank: 'iron', scores: half }), old), 'equal scores have no bias');
      assert.ok(same(pI(doc, rng(seed), { rank: 'unknown', scores: ramp }), old), 'unknown rank has no bias');
    }
  }
});

test('low ranks pick common spots, high ranks off-angles, with the same number of draws', () => {
  const doc = drill(18, 10);
  const pool = doc.rules.spawnerPick.pool;
  const scores = Object.fromEntries(pool.map((id, i) => [id, i / (pool.length - 1)]));
  const meanP = (rank) => {
    let sum = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const picked = pool.filter((id) => pI(doc, rng(seed), { rank, scores }).has(id));
      assert.equal(picked.length, 10);
      sum += picked.reduce((a, id) => a + scores[id], 0) / picked.length;
    }
    return sum / 300;
  };
  const iron = meanP('iron'), gold = meanP('gold'), radiant = meanP('radiant');
  assert.ok(iron < 0.4 && iron < gold && gold < 0.5 && radiant > 0.6, `iron ${iron} gold ${gold} radiant ${radiant}`);
  // Same rng stream: one next() per pick, whatever the bias.
  let calls = 0;
  const counting = { fork: () => ({ next: () => { calls++; return 0.37; } }) };
  pI(doc, counting, { rank: 'radiant', scores });
  assert.equal(calls, 10);
});

test('replay playback passes the stored scores to both world builders', () => {
  for (const dir of JS) {
    const src = read(dir, 'C_VPDXvn.js');
    assert.equal(src.split('spotScores:e.meta.spotScores??null').length - 1, 2);
  }
  assert.match(cnr, /ow=pI\(A,Ug,aimBR&&g\.spotScores&&typeof g\.spotScores=="object"\?\{rank:aimBR,scores:g\.spotScores\}:null\)/);
});
