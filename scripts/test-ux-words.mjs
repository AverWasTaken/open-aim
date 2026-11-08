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
  // lobby header (assembled around the map count)
  ['无畏契约创意工坊地图 · 9 张图的真实点位，练预瞄、架枪、背闪', 'VALORANT maps · 9 maps with real spots to practice pre-aim, holding angles and dodging flashes'],
  // search
  [' 没有对得上「zzzz」的项目。 ', ' No drills match “zzzz”. '],
  ['清空搜索', 'Clear search'],
  // Records drawer
  ['这台设备上的记录', 'Records on this PC'],
  ['这台设备上的最好', 'Best on this PC'],
  ['还没打过', 'Not played yet'],
  ['打完一局，这里就会记下来。', 'Finish a run and it shows up here.'],
  ['分数高的在前 · 同分比用时', 'Highest score first · ties go to the faster time'],
  // replay viewer
  ['精彩时刻', 'Highlights'],
  ['失误复盘', 'Misses'],
  ['本局数据', 'Run stats'],
  ['准星轨迹', 'Crosshair path'],
  ['最优路径', 'Best path'],
  ['连中 3 在这里断掉', 'Streak 3 ends here'],
  ['后半程慢了 12%——体力或专注在掉', 'Second half slower by 12%: tiring or losing focus'],
  // settings (Audio hit sound, Control help, header)
  ['打中目标时的声音，小球项目和瓦工坊通用。当前：', 'The sound when you hit a target, in Target drills and VALORANT Training. Current: '],
  ['都能绑定，按', ' can be bound. Press'],
  ['完成', 'Done'],
  ['改动立即保存，本局马上生效', 'Changes save right away and apply to this run.'],
  // Tab menu, buy menu, result
  ['继续', 'Resume'],
  ['准星设置', 'Crosshair settings'],
  [' 分 · 6 命中 ', ' pts · 6 Hits '],
  ['雄鹿', 'Bucky'],
  ['战神', 'Ares'],
  ['冥驹', 'Operator'],
  ['9.5 发/秒', '9.5 rounds/s'],
  ['爆头率', 'Headshot %'],
  ['看本局回放', 'Watch replay'],
  ['瓦工坊 · 训练完成', 'Drill complete'],
  ['返回小球项目', 'Back to Target drills'],
  // reports from other teams: lobby tab, drill start panel, start card control hint
  ['赛事赛程', 'Tournaments'],
  ['号角', 'Web'],
  ['鼠标移动瞄准 · 鼠标左键射击 · T重启 · ESC 菜单', 'Mouse aim · Left Mouse shoot · T restart · ESC menu'],
  ['玩家场景', 'Custom drill'],
  ['同屏靶数', 'Targets at once'],
  ['个 · 球形', '· spheres'],
  ['· 狂徒 · 无后坐', '· Vandal · No recoil'],
  ['站定 ', 'Stand still '],
  ['· 不可位移', '· fixed spot'],
  ['· 被玩过 3 次 · 10-21 发布 · 1.1 KB', '· Played 3 times · 10-21 published · 1.1 KB'],
  [' 靶打掉后 0 秒补一个。 ', ' A new target appears 0 sec after each kill. '],
  [' 时长由这份场景决定： ', ' Length is set by this drill: '],
  ['在', ''],
  ['的真实点位练预瞄、架枪、背闪', ': real spots to practice pre-aim, holding angles and dodging flashes'],
  ['的方块场地上练基础功，不绑定地图', ' block arena: practice the basics, no map needed'],
  ['打过 5 次 · 打完 3', 'Played 5 times · finished 3'],
  ['你从本地导入的场景 · 12 个方块', 'Imported from your PC · 12 blocks'],
  ['本局时长', 'Run time'],
  ['已复制', 'Copied'],
  // pause menu text
  ['停住倒计时，慢慢熟悉地图。开过的这一局不计排名，成绩照常记录。', 'Stops the countdown so you can learn the map. This run won\'t be ranked; your score is still saved.'],
  // base terms
  ['小球项目', 'Target drills'],
  ['瓦创意工坊', 'Studio'],
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
