// Real callout names (tools/maps_callouts.mjs, tools/maps-callouts-en.json, tools/maps_callout_patch.py):
// the generated app/mods/aim-maps/<map>.minimap.json files are up to date, English only and keep every
// callout spot; the shell's English translator passes the names through unchanged; the patched
// nearest-callout lookup ($u in Dc2Dm9E6.js) keeps English spaces and gives the old text for Chinese.
// Runs in node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'maps-callouts-en.json'), 'utf8'));
const { SITE_MAPS, MODS_ONLY_MAPS, MAPS } = await import(pathToFileURL(path.join(ROOT, 'tools', 'maps_callouts.mjs')).href);
const HAN = /\p{Script=Han}/u;
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const mods = (map) => readJson('app', 'mods', 'aim-maps', `${map}.minimap.json`);
const ALL_EN = MAPS.flatMap((m) => DATA[m].map((d) => d.en));
const ALL_ZH = MAPS.flatMap((m) => DATA[m].map((d) => d.zh));

test('data covers 9 maps, 204 names, English is ASCII', () => {
  assert.deepEqual(MAPS.slice().sort(), Object.keys(DATA).filter((k) => !k.startsWith('_')).sort());
  assert.equal(ALL_EN.length, 204);
  for (const en of ALL_EN) assert.match(en, /^[A-Za-z]+( [A-Za-z]+)+$/, en);
  for (const zh of ALL_ZH) assert.ok(HAN.test(zh), zh);
  for (const m of MAPS) assert.equal(new Set(DATA[m].map((d) => d.en)).size, DATA[m].length, `${m}: duplicate English name`);
});

test('maps_callouts.mjs --check: generated files are up to date', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'maps_callouts.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('site maps: English names, same callout count / x / z / order as site/', () => {
  for (const map of SITE_MAPS) {
    const site = readJson('site', 'aim-maps', `${map}.minimap.json`);
    const out = mods(map);
    assert.equal(out.callouts.length, site.callouts.length, map);
    out.callouts.forEach((c, i) => {
      const s = site.callouts[i];
      assert.ok(!HAN.test(c.name), `${map} ${c.name}`);
      assert.equal(s.name, DATA[map][i].zh, `${map} ${i}`);
      assert.equal(c.name, DATA[map][i].en, `${map} ${i}`);
      assert.deepEqual({ ...c, name: null }, { ...s, name: null }, `${map} ${i}`);
    });
    assert.deepEqual({ ...out, callouts: null }, { ...site, callouts: null }, map);
  }
});

test('juliett: English names at the stored x / z', () => {
  for (const map of MODS_ONLY_MAPS) {
    const out = mods(map);
    assert.equal(out.callouts.length, DATA[map].length, map);
    out.callouts.forEach((c, i) => {
      const d = DATA[map][i];
      assert.deepEqual(Object.keys(c), ['name', 'x', 'z'], `${map} ${i}`);
      assert.deepEqual(c, { name: d.en, x: d.x, z: d.z }, `${map} ${i}`);
    });
    assert.equal(out.map, map);
  }
});

test('the English translator leaves every callout name as it is', async () => {
  const i18n = path.join(ROOT, 'site', '_assets', 'r20261021-1', 'i18n');
  // Same as the translator wrapper app/main.js serves: english-fixes.js merged into the dictionary
  // before the first translation, translations.js only for Vietnamese text (VN regex).
  const dictionary = (await import(pathToFileURL(path.join(i18n, 'en.dict.mjs')).href)).default;
  Object.assign(dictionary, require(path.join(ROOT, 'app', 'english-fixes.js')));
  const { translateText } = await import(pathToFileURL(path.join(i18n, 'translate-en.mjs')).href);
  const vnLine = fs.readFileSync(path.join(ROOT, 'app', 'main.js'), 'utf8').match(/^const VN = (\/.*\/i);\r?$/m);
  assert.ok(vnLine, 'VN regex in app/main.js');
  const VN = new Function(`return ${vnLine[1]}`)();
  assert.ok(!HAN.test(translateText('A区 大厅')), 'translator loaded (control)');
  // The pre-aim result builds sentences around the name (mi() in Dc2Dm9E6.js); the English name must
  // come through whole there too (a later english-fixes.js key could otherwise eat part of it).
  const templates = [
    (n) => `你在 ${n} 看见他 · 相距 12 米`,
    (n) => `你在 ${n} 看见他时，正在打 2 号`,
    (n) => `你在 ${n} 看见他，和 3 号同一刻露头`,
    (n) => `你在 ${n} 看见他时被闪白了`,
    (n) => `你在 ${n} 看见他时人在空中`,
    (n) => `${n} `,
  ];
  for (const en of ALL_EN) {
    assert.equal(VN.test(en), false, `VN regex matches ${en}`);
    assert.equal(translateText(en), en);
    for (const t of templates) {
      const out = translateText(t(en));
      assert.ok(out.includes(en) && !HAN.test(out) && !out.includes('Translation unavailable'), `${t(en)} -> ${out}`);
    }
  }
});

test('patched $u keeps English spaces, Chinese gives the old text', () => {
  const files = [path.join('next', 'js'), path.join('_assets', 'r20261021-1', 'next', 'js')]
    .map((d) => fs.readFileSync(path.join(ROOT, 'app', 'mods', d, 'Dc2Dm9E6.js'), 'utf8'));
  assert.equal(files[0], files[1], 'both Dc2Dm9E6.js copies identical');
  const src = files[0];
  assert.equal(src.split("return cA['name']['replace'](/\\s+/g,'');").length - 1, 0, 'old anchor gone');
  const m = [...src.matchAll(/function \$u\(cw,cx,cy\)\{[^]*?return cA\['name'\]\['replace'\]\((\/[^]*?\/g),''\);\}/g)];
  assert.equal(m.length, 1, '$u found once');
  const lit = m[0][1];
  assert.equal(lit, String.raw`/\s+(?=[^\x00-\x7f])|(?<=[^\x00-\x7f])\s+/g`);
  const re = new Function(`return ${lit}`)();
  const strip = (s) => s.replace(re, '');
  assert.equal(strip('A区 大厅'), 'A区大厅');
  assert.equal(strip('A Main'), 'A Main');
  assert.equal(strip('Attacker Spawn'), 'Attacker Spawn');
  const siteZh = SITE_MAPS.flatMap((map) => readJson('site', 'aim-maps', `${map}.minimap.json`).callouts.map((c) => c.name));
  for (const zh of [...ALL_ZH, ...siteZh]) assert.equal(strip(zh), zh.replace(/\s+/g, ''), zh);
  for (const en of ALL_EN) assert.equal(strip(en), en);
});
