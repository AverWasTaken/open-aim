// UI words checks: the translator wrapper in app/main.js (english-fixes.js and translations.js
// merged into the site's dictionary), golden English for the audited screens, the fix files'
// hygiene, and the English strings other shell scripts look for in the page.
// Loads the real wrapper template from main.js (scripts/ux/translator-harness.mjs). Node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadTranslator } from './ux/translator-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const require = createRequire(import.meta.url);
const hasSite = fs.existsSync(path.join(ROOT, 'site', '_assets', 'r20261021-1', 'i18n', 'en.dict.mjs'));
const tr = hasSite ? await loadTranslator(path.join(APP, 'main.js')) : null;
const en = (s) => tr.translateText(s);

// Source -> expected English on the audited screens (lobby, Records drawer, replay viewer,
// search, settings, history, result, in-game menus).
const GOLDEN = [
  ['Độ khó', 'Difficulty'],
  ['Toàn cầu', 'Global'],
  ['Đóng', 'Close'],
  ['Đang gửi…', 'Sending…'],
];

test('wrapper merges english-fixes then translations, no VN pre-pass', () => {
  const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf-8');
  const a = main.indexOf('Object.assign(dictionary, ${JSON.stringify(require("./english-fixes"))});');
  const b = main.indexOf('Object.assign(dictionary, ${JSON.stringify(require("./translations"))});');
  assert.ok(a > 0 && b > a, 'english-fixes is merged, then translations');
  assert.ok(!/const VN\b/.test(main), 'no VN regex');
  assert.ok(!/\bconst (EXTRA|KEYS)\b/.test(main), 'no pre-pass tables');
});

test('Vietnamese and audited strings translate', { skip: !hasSite && 'site/ missing' }, () => {
  for (const [source, english] of GOLDEN) assert.equal(en(source), english, source);
  // A whole-sentence dictionary entry must still win over its parts.
  assert.equal(en('Độ khó không thay đổi'), tr.dictionary['Độ khó không thay đổi']);
  assert.ok(!/[ăâđơưạ-ỹ]/i.test(en('Độ khó không thay đổi')));
});

test('every translations.js key is used as written', { skip: !hasSite && 'site/ missing' }, () => {
  const vi = require(path.join(APP, 'translations.js'));
  for (const [k, v] of Object.entries(vi)) assert.equal(en(k), v, k);
});

test('no key in both translations.js and english-fixes.js', () => {
  const vi = require(path.join(APP, 'translations.js'));
  const zh = require(path.join(APP, 'english-fixes.js'));
  assert.deepEqual(Object.keys(vi).filter((k) => k in zh), []);
});

// Keys that were deliberately written with edge spaces before these checks existed.
const EDGE_SPACE_KEYS = new Set(['放大 ', ' 倍，一格一个屏幕像素', '结局 ']);
for (const file of ['english-fixes.js', 'translations.js']) {
  test(`${file}: no duplicate keys, clean values`, () => {
    const text = fs.readFileSync(path.join(APP, file), 'utf-8');
    const seen = new Map();
    text.split(/\r?\n/).forEach((line, i) => {
      // A line can hold several entries ("一": "Mon", "二": "Tue", ...).
      for (const m of line.matchAll(/(?:^|,)\s*("(?:[^"\\]|\\.)*")\s*:/g)) {
        const key = JSON.parse(m[1]);
        assert.ok(!seen.has(key), `${file}:${i + 1} duplicate key ${m[1]} (first at line ${seen.get(key)})`);
        seen.set(key, i + 1);
      }
    });
    const entries = Object.entries(require(path.join(APP, file)));
    assert.equal(seen.size, entries.length, 'line scan found every key');
    for (const [k, v] of entries) {
      assert.ok(!/\p{Script=Han}/u.test(v), `CJK in value of ${k}: ${v}`);
      assert.ok(!(v.includes('—') && v.trim() !== '—'), `em dash in value of ${k}: ${v}`);
      if (!EDGE_SPACE_KEYS.has(k)) assert.ok(k === k.trim() && !/\s{2}/.test(k), `key not trimmed/single-spaced: ${JSON.stringify(k)}`);
    }
  });
}

test('strings other shell scripts look for still come out', { skip: !hasSite && 'site/ missing' }, () => {
  // local-customization.js finds the native skin row by its "Vandal" and "AK-47" buttons.
  assert.equal(en('狂徒'), 'Vandal');
  assert.equal(en('AK-47'), 'AK-47');
  // interface-mode.js puts its row under the heading matching /Smoothness/.
  assert.match(en('流畅度'), /Smoothness/);
  // startup-screen.js waits while any text starts with "Loading".
  for (const k of ['加载中', '加载中…', '加载中...', '正在加载…', '正在载入训练场…', '载入训练场']) {
    assert.ok(en(k).startsWith('Loading'), `${k} -> ${en(k)}`);
  }
});
