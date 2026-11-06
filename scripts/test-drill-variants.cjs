// Checks for app/drill-variants.js: which Easy/Hard twins become one card in the training list.
// The real-list test needs the game files in site/ (docs/game-files.md) and is skipped without them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { mergeVariants, shooterStats, docOf, parseName } = require(path.join(root, 'app', 'drill-variants.js'));

const item = (shareCode, name, mapId = 'ascent', createTime = '2026-10-01 00:00:00') => ({ shareCode, name, mapId, createTime });
const shooter = { kind: 'shooter', reaction: [0.34, 0.44], aimErrorDeg: 2.8 };

test('parseName matches the game title parser', () => {
  assert.deepEqual(parseName('困难-Split A retake'), { label: '困难', title: 'Split A retake' });
  assert.deepEqual(parseName('简单 · Lotus A attack'), { label: '简单', title: 'Lotus A attack' });
  assert.deepEqual(parseName('Grid shooting'), { label: null, title: 'Grid shooting' });
});

test('shooterStats finds shooters anywhere in a doc', () => {
  const doc = docOf({ doc: JSON.stringify({ a: [{ kind: 'target' }, { b: { ...shooter, extra: 1 } }] }) });
  assert.deepEqual(shooterStats(doc), [{ reaction: [0.34, 0.44], aimErrorDeg: 2.8 }]);
  assert.equal(docOf({ doc: '{broken' }), null);
});

test('twins merge, older copies hide, Studio drills and odd cases stay', () => {
  const items = [
    item('studioH', '困难-Mine'), item('studioE', '简单-Mine'), // Studio drills: never paired
    item('h1', '困难-A site'), item('e1', '简单-A site'),
    item('h2old', '困难-B site', 'bind', '2026-10-01 00:00:00'), item('e2old', '简单-B site', 'bind', '2026-10-01 00:00:00'),
    item('h2', '困难-B site', 'bind', '2026-10-02 00:00:00'), item('e2', '简单-B site', 'bind', '2026-10-02 00:00:00'),
    item('h3', '困难-C site', 'haven'), item('e3', '简单-C site', 'lotus'), // different maps
    item('h4', '困难-D site'), item('e4', '简单-D site'), // Hard without bots
    item('solo', 'Duel drill'), item('plain', 'Grid shooting'),
  ];
  const withBots = new Set(['studioH', 'h1', 'h2old', 'h2', 'h3', 'solo']);
  const r = mergeVariants(items, (x) => (withBots.has(x.shareCode) ? [shooter] : []), new Set(['studioH', 'studioE']));
  assert.deepEqual(r.data.map((x) => x.shareCode), ['studioH', 'studioE', 'h1', 'h2', 'h3', 'e3', 'h4', 'e4', 'solo', 'plain']);
  assert.deepEqual(r.hidden.sort(), ['e1', 'e2', 'e2old', 'h2old']);
  assert.equal(r.variants.e1.item.shareCode, 'h1');
  assert.equal(r.variants.h1.easy.shareCode, 'e1');
  for (const c of ['h2', 'e2', 'h2old', 'e2old']) {
    assert.equal(r.variants[c].item.shareCode, 'h2');
    assert.equal(r.variants[c].easy.shareCode, 'e2');
  }
  assert.equal(r.variants.h3.easy, null);
  assert.equal(r.variants.e3, undefined);
  assert.equal(r.variants.h4, undefined);
  assert.equal(r.variants.studioH.easy, null);
  assert.equal(r.variants.solo.easy, null);
  assert.equal(r.variants.plain, undefined);
});

const listFile = path.join(root, 'site', 'prod-api', 'api', 'v1', 'public', 'val', 'aimlab', 'workshop');
test('real training list: 28 exact pairs + 4 near pairs, 2 older copies hidden', { skip: !fs.existsSync(listFile) && 'no site/ game files' }, () => {
  const list = JSON.parse(fs.readFileSync(listFile, 'utf-8')).data;
  const set = JSON.parse(fs.readFileSync(path.join(root, 'app', 'training-set.json'), 'utf-8'));
  const known = new Set(list.map((x) => x.shareCode));
  const items = [...list, ...set.items.filter((x) => !known.has(x.shareCode))];
  const botsOf = (x) => {
    let scene = set.scenes[x.shareCode];
    const file = path.join(root, 'site', 'prod-api', 'api', 'v1', 'public', 'val', 'aimlab', 'scenes', x.shareCode);
    if (!scene && fs.existsSync(file)) scene = JSON.parse(fs.readFileSync(file, 'utf-8')).data;
    return shooterStats(docOf(scene));
  };
  const r = mergeVariants(items, botsOf);
  assert.equal(items.length, 108);
  assert.equal(r.hidden.length, 34);
  assert.equal(r.data.length, items.length - 34);
  const groups = [...new Set(Object.values(r.variants))];
  const paired = groups.filter((g) => g.easy);
  assert.equal(paired.length, 32);
  for (const g of paired) {
    assert.equal(parseName(g.item.name).label, '困难');
    assert.equal(parseName(g.easy.name).label, '简单');
    assert.equal(g.item.mapId, g.easy.mapId);
    assert.ok(g.bots.length > 0);
    assert.ok(r.hidden.includes(g.easy.shareCode));
    assert.ok(!r.hidden.includes(g.item.shareCode));
  }
  const exact = paired.filter((g) => parseName(g.item.name).title.toLowerCase() === parseName(g.easy.name).title.toLowerCase());
  assert.equal(exact.length, 28);
  const near = paired.filter((g) => !exact.includes(g)).map((g) => [g.item.shareCode, g.easy.shareCode]).sort();
  assert.deepEqual(near, [
    ['afcbc73b0048afcc', '46029355cfd99cf1'],
    ['b69de2b10b5cfc06', '75551c4e540ca4e8'],
    ['becafa3cd2560b03', '10d043eea1794c53'],
    ['e759f847c60c90e5', '789f9e6dc075e747'],
  ]);
  // "Split A retake" was published twice: the newest pair stays, the older copies open it too.
  assert.equal(r.variants['334c7b11c93f400f'].item.shareCode, '80444d4551b0ebcc');
  assert.equal(r.variants['2bca4991b2ec434d'].easy.shareCode, '1802435f5c7bd36c');
  assert.ok(r.hidden.includes('334c7b11c93f400f') && r.hidden.includes('2bca4991b2ec434d'));
  // "Haven A Long attack (random)" keeps its own card.
  assert.ok(r.data.some((x) => x.shareCode === '935efd2987c64ad4'));
  assert.equal(r.variants['935efd2987c64ad4'].easy, null);
});
