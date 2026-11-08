// Crosshair profiles (app/feel-crosshair-profiles.js): storage checks, save/rename/delete,
// and merging every crosshair from a VALORANT settings import into the list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const xp = require('../app/feel-crosshair-profiles.js');
const { parse } = require('../app/valorant-import');

const memory = (init = {}) => {
  const data = new Map(Object.entries(init));
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data };
};
const CODE_A = '0;P;c;5;h;0;f;0;0l;4;0o;2;0a;1;0f;0;1b;0';
const CODE_B = '0;P;c;1;o;1;d;1;z;3;0b;0;1b;0';

test('load: missing or broken data gives an empty list', () => {
  for (const raw of [undefined, '', 'not json', '[]', '{"list":5}', 'null', '{"v":1}']) {
    const s = memory(raw === undefined ? {} : { [xp.KEY]: raw });
    assert.deepEqual(xp.load(s), { v: 1, list: [] }, String(raw));
  }
  const throwing = { getItem() { throw new Error('denied'); } };
  assert.deepEqual(xp.load(throwing), { v: 1, list: [] });
});

test('sanitize drops bad entries, trims names, fixes ids and caps the list', () => {
  const list = [
    { id: 'a', name: '  Main  ', code: CODE_A, source: 'manual', updatedAt: 5 },
    { id: 'a', name: 'Dup id', code: CODE_B, source: 'weird' },
    { id: 'c', name: 'Bad code', code: '1;P' },
    { id: 'd', name: 'Too long code', code: '0;' + 'x'.repeat(2000) },
    { id: 'e', name: '   ', code: CODE_A },
    { id: 'f', name: 'x'.repeat(80), code: CODE_A },
    { id: 'g', name: 'Line\nbreak\u0007', code: '0' },
    null, 7, 'str',
  ];
  const out = xp.sanitize({ v: 1, list });
  assert.deepEqual(out.list.map(p => p.name), ['Main', 'Dup id', 'x'.repeat(32), 'Line break']);
  assert.equal(new Set(out.list.map(p => p.id)).size, 4);
  assert.equal(out.list[0].id, 'a');
  assert.equal(out.list[1].source, 'manual');
  assert.equal(out.list[1].updatedAt, 0);
  const many = Array.from({ length: 70 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, code: CODE_A }));
  assert.equal(xp.sanitize({ list: many }).list.length, 50);
});

test('validCode accepts game codes only', () => {
  assert.ok(xp.validCode('0'));
  assert.ok(xp.validCode(CODE_A));
  for (const bad of [null, 0, '', '1;P', '0x', ';0', '0;' + 'a'.repeat(1999)]) assert.equal(xp.validCode(bad), false, String(bad));
});

test('save then load round-trips', () => {
  const s = memory();
  const r = xp.upsert(xp.load(s), { name: 'Main', code: CODE_A }, 10);
  xp.save(s, r.state);
  const back = xp.load(s);
  assert.equal(back.list.length, 1);
  assert.deepEqual({ ...back.list[0], id: undefined }, { id: undefined, name: 'Main', code: CODE_A, source: 'manual', updatedAt: 10 });
});

test('upsert adds, updates by name (any case), and refuses bad input and a full list', () => {
  let st = xp.upsert({ v: 1, list: [] }, { name: 'Main', code: CODE_A }).state;
  const r1 = xp.upsert(st, { name: 'Pro', code: CODE_B });
  assert.equal(r1.updated, false); st = r1.state;
  assert.equal(st.list.length, 2);
  const r2 = xp.upsert(st, { name: 'main', code: CODE_B });
  assert.equal(r2.updated, true); assert.equal(r2.state.list.length, 2);
  assert.equal(r2.state.list[0].name, 'main'); assert.equal(r2.state.list[0].code, CODE_B);
  assert.equal(st.list[0].code, CODE_A, 'input state is not changed');
  assert.match(xp.upsert(st, { name: '  ', code: CODE_A }).error, /name/);
  assert.match(xp.upsert(st, { name: 'X', code: 'nope' }).error, /code/);
  const full = { v: 1, list: Array.from({ length: 50 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, code: CODE_A })) };
  assert.match(xp.upsert(full, { name: 'New', code: CODE_B }).error, /Limit/);
  assert.equal(xp.upsert(full, { name: 'P3', code: CODE_B }).updated, true, 'updating by name still works when full');
});

test('rename and remove', () => {
  let st = xp.upsert({ v: 1, list: [] }, { name: 'Main', code: CODE_A }).state;
  st = xp.upsert(st, { name: 'Pro', code: CODE_B }).state;
  const id = st.list[0].id;
  const r = xp.rename(st, id, '  New name ');
  assert.equal(r.entry.name, 'New name'); assert.equal(r.state.list[0].id, id);
  assert.match(xp.rename(st, id, 'pro').error, /exists/);
  assert.match(xp.rename(st, id, '').error, /name/);
  assert.match(xp.rename(st, 'missing', 'X').error, /not found/);
  assert.equal(xp.rename(st, id, 'MAIN').entry.name, 'MAIN', 'renaming itself by case is allowed');
  const d = xp.remove(st, id);
  assert.equal(d.removed, true); assert.deepEqual(d.state.list.map(p => p.name), ['Pro']);
  assert.equal(xp.remove(st, 'missing').removed, false);
});

test('mergeImported: keeps existing, skips duplicate codes, names fallback, stops at 50', () => {
  const existing = xp.upsert({ v: 1, list: [] }, { name: 'Mine', code: CODE_A }).state;
  const m = xp.mergeImported(existing, [
    { name: 'Dup of mine', code: CODE_A },
    { name: '<b>Pro</b> ' + 'y'.repeat(60), code: CODE_B },
    { name: '', code: '0;s;1' },
    { name: 'Bad', code: 'garbage' },
    { name: 'Again', code: CODE_B },
  ], 99);
  assert.deepEqual([m.added, m.duplicates, m.notAdded, m.invalid], [2, 2, 0, 1]);
  assert.deepEqual(m.state.list.map(p => p.name), ['Mine', ('<b>Pro</b> ' + 'y'.repeat(60)).slice(0, 32), 'VALORANT 3']);
  assert.deepEqual(m.state.list.map(p => p.source), ['manual', 'valorant', 'valorant']);
  assert.equal(existing.list.length, 1, 'input state is not changed');

  const nearly = { v: 1, list: Array.from({ length: 48 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, code: '0;z;' + i })) };
  const m2 = xp.mergeImported(nearly, [{ name: 'a', code: '0;a' }, { name: 'b', code: '0;b' }, { name: 'c', code: '0;c' }, { name: 'd', code: '0;d' }]);
  assert.deepEqual([m2.added, m2.notAdded], [2, 2]);
  assert.equal(m2.state.list.length, 50);
  assert.deepEqual(m2.state.list.slice(-2).map(p => p.name), ['a', 'b'], 'file order kept');
  assert.deepEqual(xp.mergeImported(nearly, null).added, 0);
});

test('a parsed RiotUserSettings.ini with three crosshairs merges all three', () => {
  const prof = (name, r) => ({ profileName: name, primary: { color: { r, g: 255, b: 0 }, bHasOutline: false } });
  const data = JSON.stringify(JSON.stringify({ currentProfile: 1, profiles: [prof('Main', 0), prof('Pro', 255), prof('Dot', 128)] }));
  const result = parse([{ name: 'RiotUserSettings.ini', text: '[Settings]\nEAresStringSettingName::SavedCrosshairProfileData=' + data }]);
  assert.equal(result.profiles.length, 3);
  const m = xp.mergeImported({ v: 1, list: [] }, result.profiles);
  assert.equal(m.added, 3);
  assert.deepEqual(m.state.list.map(p => p.name), ['Main', 'Pro', 'Dot']);
  assert.ok(m.state.list.every(p => xp.validCode(p.code)));
  // Stored and loaded again, still three.
  const s = memory(); xp.save(s, m.state); assert.equal(xp.load(s).list.length, 3);
  // Importing the same file again adds nothing.
  assert.equal(xp.mergeImported(m.state, result.profiles).duplicates, 3);
});

test('mergeImported gives repeated names a number, within 32 chars', () => {
  const st = xp.upsert({ v: 1, list: [] }, { name: 'Main', code: CODE_A }).state;
  const long = 'L'.repeat(32);
  const m = xp.mergeImported(st, [
    { name: 'main', code: '0;a' }, { name: 'Main', code: '0;b' }, { name: long, code: '0;c' }, { name: long, code: '0;d' },
  ]);
  assert.deepEqual(m.state.list.map(p => p.name), ['Main', 'main (2)', 'Main (3)', long, 'L'.repeat(28) + ' (2)']);
  assert.ok(m.state.list.every(p => Array.from(p.name).length <= 32));
});

// valorant-import-ui.js: the startup prompt stays away while ux-welcome's banner offers the import.
test('startup prompt skipped for new players (welcome banner offers the import)', () => {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'valorant-import-ui.js'), 'utf-8');
  const m = src.match(/function welcomeOffersImport\(\) \{[\s\S]*?\n  \}\r?\n/);
  assert.ok(m, 'welcomeOffersImport found');
  const make = (store, innerHeight = 1000) => {
    const localStorage = { getItem: (k) => (k in store ? store[k] : null) };
    return new Function('localStorage', 'window', m[0] + 'return welcomeOffersImport;')(localStorage, { innerHeight });
  };
  assert.equal(make({ 'ux-welcome-v1': 'shown' }, 800)(), false, 'compact banner (<= 800 px) has no Import button');
  assert.equal(make({ 'ux-welcome-v1': 'shown' })(), true);
  assert.equal(make({ 'ux-welcome-v1': 'done' })(), false);
  assert.equal(make({})(), true, 'not decided yet, no runs = new player');
  assert.equal(make({ 'al-workshop-runs-v1': '[{"id":1}]' })(), false, 'has runs = existing player');
  assert.equal(make({ 'al-pw-runs-v1': '[{"id":1}]' })(), false);
  assert.equal(make({ 'al-workshop-runs-v1': 'garbage' })(), true);
  assert.match(src, /if \(!welcomeOffersImport\(\)\) \{ sessionStorage\.setItem\(SHOWN, "1"\); open\(\); \}/);
});

test('import prompt rule still matches ux-welcome.js (800 px, key, run keys)', () => {
  const fs = require('fs'), path = require('path');
  const ux = fs.readFileSync(path.join(__dirname, '..', 'app', 'ux-welcome.js'), 'utf-8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'app', 'valorant-import-ui.js'), 'utf-8');
  assert.match(ux, /const COMPACT_MAX_H = 800;/);
  assert.match(ux, /const KEY = "ux-welcome-v1";/);
  assert.match(ux, /const RUN_KEYS = \["al-workshop-runs-v1", "al-pw-runs-v1"\];/);
  assert.match(ui, /innerHeight \|\| 0\) > 800/);
  assert.match(ui, /"ux-welcome-v1"/);
  assert.match(ui, /runs\("al-workshop-runs-v1"\) && !runs\("al-pw-runs-v1"\)/);
});
