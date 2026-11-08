// HUD shell checks: loading-progress step math (app/mods/aim-ui/scenario-loading.mjs) and the
// CSS that makes the in-drill score box readable and keeps it visible above the Tab menu.
// Node only: imports the real module (no DOM is touched at import) and reads the CSS as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const { loadingStep } = await import(pathToFileURL(path.join(APP, 'mods', 'aim-ui', 'scenario-loading.mjs')).href);

// CSS rules as [selector, body] pairs; comments stripped, @media wrappers ignored.
function rules(file) {
  const css = fs.readFileSync(path.join(APP, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]]);
}
const alpha = (body) => {
  const m = /background(?:-color)?\s*:\s*rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(body);
  return m ? Number(m[1]) : null;
};

test('loadingStep maps known labels and passes unknown ones through', () => {
  assert.deepEqual(loadingStep('Loading scenario assets', 0), { text: 'Preparing assets', completed: 0, done: 0 });
  assert.deepEqual(loadingStep('Loading map, bots and effects', 1), { text: 'Preparing map and bots', completed: 1, done: 1 });
  assert.equal(loadingStep('Warming weapon shaders and textures', 2).text, 'Preparing visuals');
  assert.deepEqual(loadingStep('Finishing GPU preparation', 3), { text: 'Finishing up', completed: 3, done: 3 });
  assert.equal(loadingStep('Something new', 1).text, 'Something new');
});

test('loadingStep without detail keeps the old behaviour', () => {
  for (const c of [0, 1, 2, 3, 4]) {
    const s = loadingStep('Warming weapon shaders and textures', c);
    assert.equal(s.completed, c);
    assert.equal(s.done, c);
    assert.equal(s.text, 'Preparing visuals');
  }
  assert.equal(loadingStep('x').completed, 0, 'completed defaults to 0');
  assert.equal(loadingStep('x', 2, null).text, 'x');
  assert.equal(loadingStep('x', 2, { weapon: 'a', index: 0, total: 0 }).text, 'x', 'total 0 = no weapon text');
});

test('weapon detail: label format, smooth fraction inside step 2, dots use floor', () => {
  const total = 16;
  let last = 2;
  for (let index = 0; index < total; index++) {
    const s = loadingStep('Warming weapon shaders and textures', 2, { weapon: 'w' + index, index, total });
    assert.equal(s.text, `Preparing visuals · weapon ${index + 1}/${total}`);
    assert.ok(s.completed > 2 && s.completed < 3, `completed ${s.completed} in (2,3)`);
    assert.ok(s.completed > last, 'strictly increasing');
    assert.equal(s.completed, 2 + (index + 1) / (total + 1));
    assert.equal(s.done, 2);
    last = s.completed;
  }
  // Workshop % = 90 + completed * 2: 94.x .. just under 96.
  const first = 90 + loadingStep('w', 2, { index: 0, total }).completed * 2;
  assert.ok(first > 94 && last * 2 + 90 < 96);
});

test('done is clamped to 0..4', () => {
  assert.equal(loadingStep('x', -1).done, 0);
  assert.equal(loadingStep('x', 3.99).done, 3);
  assert.equal(loadingStep('x', 7).done, 4);
});

test('HUD chip values are a fixed px size >= 24 with tabular numbers', () => {
  const hud = rules('theme-esports.css').filter(([sel]) => sel.includes('.al-hud-chip'));
  assert.ok(hud.length, 'HUD chip rules found');
  const value = hud.find(([sel]) => /\.al-hud-chip\s+:is\(b,\s*strong\)/.test(sel));
  assert.ok(value, 'value rule found');
  const px = /font-size\s*:\s*([\d.]+)px/.exec(value[1]);
  assert.ok(px && Number(px[1]) >= 24, 'value font-size >= 24px');
  assert.match(value[1], /font-variant-numeric\s*:\s*tabular-nums/);
  for (const [, body] of hud) assert.ok(!body.includes('1.15em'), 'no 1.15em left in HUD chip rules');
  const label = hud.find(([sel]) => /\.al-hud-chip\s+:is\(span/.test(sel));
  assert.match(label[1], /font-size\s*:\s*11px/);
});

test('Tab menu overlay dims the scene (alpha >= .55); the light "Paused" panel is not hit', () => {
  const ui = rules('ui.css');
  const overlay = ui.filter(([sel]) => sel.includes('.al-pause-overlay'));
  assert.ok(overlay.length, 'overlay rule found');
  const a = overlay.map(([, b]) => alpha(b)).filter(v => v !== null);
  assert.ok(a.length && a.every(v => v >= 0.55), `overlay alpha ${a}`);
  for (const [sel] of overlay) {
    for (const part of sel.split(',')) assert.ok(part.includes('.al-pause-overlay'), `"${part.trim()}" would also dim the Paused panel`);
  }
});

test('every paused-state rule skips Round mode', () => {
  for (const file of ['ui.css', 'theme-esports.css']) {
    for (const [sel] of rules(file)) {
      if (!sel.includes('.is-paused')) continue;
      for (const part of sel.split(',')) {
        if (part.includes('.is-paused')) assert.ok(part.includes(':not(.aim-round-on)'), `${file}: ${part.trim()}`);
      }
    }
  }
  const ui = rules('ui.css');
  assert.ok(ui.some(([sel, b]) => /\.is-paused\s+\.al-hud-top/.test(sel) && /display\s*:\s*flex\s*!important/.test(b)), 'score box shown while paused');
  assert.ok(ui.some(([sel, b]) => /\.is-paused\s+\.al-hud\s*$/.test(sel) && /z-index\s*:\s*9\b/.test(b)), 'HUD lifted above the menu');
});
