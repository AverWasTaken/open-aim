// Location label under the minimap (app/maps-location.js) and the shared frame hook
// (app/aim-tick-hub.js, emitted from app/main.js ROUTE_LOOP_TO). Runs in node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HUB_SRC = read('app', 'aim-tick-hub.js');
const LOC_SRC = read('app', 'maps-location.js');
const MAIN = read('app', 'main.js');
const { pickCallout, labelVisible, toMapUV, labelBox } = require(path.join(ROOT, 'app', 'maps-location.js'));

// The minimap file the app serves for a map: app/mods overrides site/.
const MAP_IDS = [...new Set([
  ...fs.readdirSync(path.join(ROOT, 'site', 'aim-maps')),
  ...fs.readdirSync(path.join(ROOT, 'app', 'mods', 'aim-maps')),
].filter((f) => f.endsWith('.minimap.json')).map((f) => f.replace('.minimap.json', '')))].sort();
const served = (id) => {
  const mod = path.join(ROOT, 'app', 'mods', 'aim-maps', `${id}.minimap.json`);
  return JSON.parse(fs.readFileSync(fs.existsSync(mod) ? mod : path.join(ROOT, 'site', 'aim-maps', `${id}.minimap.json`), 'utf8'));
};

// main.js: the frame-loop replacement string, run as code against a fake window.
const ROUTE_TO = eval(/const ROUTE_LOOP_TO = ("[^"]*"|'[^']*');/.exec(MAIN)[1]);
const frame = (win, state) => new Function('window', 'hs', 'de', 'Cn', `${ROUTE_TO}{}`)(win, () => state, null, []);
const loadHub = (win) => vm.runInNewContext(HUB_SRC, { window: win, console });

test('main.js: frame loop calls the legacy tick, then the hub; scripts are registered', () => {
  assert.equal(ROUTE_TO, 'const ce=hs(de);window.__aimTick?.(ce);window.__aimTickHub?.emit(ce);for(const xe of Cn)');
  assert.ok(ROUTE_TO.startsWith(eval(/const ROUTE_LOOP_FROM = ("[^"]*");/.exec(MAIN)[1]).replace('for(const xe of Cn)', '')));
  assert.match(MAIN, /const AIM_TICK_HUB_JS = fs\.readFileSync\(path\.join\(__dirname, "aim-tick-hub\.js"\), "utf-8"\);/);
  assert.match(MAIN, /const MAPS_LOCATION_JS = fs\.readFileSync\(path\.join\(__dirname, "maps-location\.js"\), "utf-8"\);/);
  const ui = MAIN.slice(MAIN.indexOf('const UI_SCRIPTS = ['), MAIN.indexOf('];', MAIN.indexOf('const UI_SCRIPTS = [')));
  const order = ['["PAGE WATCH"', '["AIM TICK HUB", AIM_TICK_HUB_JS]', '["SHOT GRAPH"', '["MAPS LOCATION", MAPS_LOCATION_JS]'].map((s) => ui.indexOf(s));
  assert.ok(order.every((i) => i >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'hub early, label after the shot graph');
  const files = JSON.parse(read('app', 'package.json')).build.files;
  for (const f of ['aim-tick-hub.js', 'maps-location.js']) assert.ok(files.includes(f), f);
});

test('hub: legacy tick still fires, listeners fire, old chain wrapper does not recurse', () => {
  const win = {};
  loadHub(win);
  const calls = [];
  win.__aimTick = (s) => calls.push(['legacy', s.tick]); // the shot graph's plain assignment
  const off = win.__aimTickHub.add((s) => calls.push(['a', s.tick]));
  win.__aimTickHub.add(() => { throw new Error('boom'); });
  win.__aimTickHub.add((s) => calls.push(['b', s.tick]));
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a);
  try {
    frame(win, { tick: 1 });
    // A later script that chains the old way keeps working and does not loop.
    const prev = win.__aimTick;
    win.__aimTick = (s) => { prev?.(s); calls.push(['chain', s.tick]); };
    frame(win, { tick: 2 });
    off();
    frame(win, { tick: 3 });
  } finally { console.error = origError; }
  assert.deepEqual(calls, [
    ['legacy', 1], ['a', 1], ['b', 1],
    ['legacy', 2], ['chain', 2], ['a', 2], ['b', 2],
    ['legacy', 3], ['chain', 3], ['b', 3],
  ]);
  assert.equal(errors.length, 1, 'a throwing listener is logged once');
  // Last plain assignment wins, as before the hub.
  win.__aimTick = (s) => calls.push(['last', s.tick]);
  calls.length = 0;
  frame(win, { tick: 4 });
  assert.deepEqual(calls, [['last', 4], ['b', 4]]);
});

test('hub: loading twice keeps the first hub and its listeners; no hub, no crash', () => {
  const win = {};
  loadHub(win);
  const hub = win.__aimTickHub;
  let n = 0;
  hub.add(() => n++);
  loadHub(win);
  assert.equal(win.__aimTickHub, hub);
  frame(win, { tick: 1 });
  assert.equal(n, 1);
  hub.remove(() => {});
  assert.doesNotThrow(() => frame({}, { tick: 1 }), 'frame loop without the hub or a legacy tick');
});

test('data: every served minimap has callouts with names and finite x/z inside the minimap', () => {
  assert.ok(MAP_IDS.length >= 9, MAP_IDS.join());
  for (const id of MAP_IDS) {
    const info = served(id);
    assert.ok(info.transform, id);
    assert.ok(Array.isArray(info.callouts) && info.callouts.length > 0, id);
    for (const c of info.callouts) {
      assert.ok(typeof c.name === 'string' && c.name.trim(), `${id}: name`);
      assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z), `${id} ${c.name}: x/z`);
      const { u, v } = toMapUV(info.transform, c.x, c.z);
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, `${id} ${c.name}: u ${u} v ${v}`);
    }
  }
});

test('visibility: running + minimap on screen + setting on', () => {
  for (const phase of ['running', 'paused', 'result', 'idle', undefined]) {
    for (const width of [0, 240, null, undefined]) {
      for (const on of [true, false]) {
        const want = phase === 'running' && width === 240 && on;
        assert.equal(labelVisible(phase, width, on), want, `${phase} ${width} ${on}`);
      }
    }
  }
  assert.equal(labelVisible('running', NaN, true), false);
});

test('hysteresis: dN < dC - min(1.5, 0.25 dC), first pick is the nearest', () => {
  const A = { name: 'A', x: 0, z: 0 }, B = { name: 'B', x: 10, z: 0 };
  const L = [A, B];
  assert.equal(pickCallout(L, 4.9, 0, null), A);
  assert.equal(pickCallout(L, 5.1, 0, null), B, 'first pick: plain nearest');
  assert.equal(pickCallout(L, 5.5, 0, A), A, 'dB 4.5 vs 5.5 - 1.375: stay');
  assert.equal(pickCallout(L, 5.6, 0, A), A, 'dB 4.4 vs 5.6 - 1.4: stay');
  assert.equal(pickCallout(L, 5.9, 0, A), B, 'dB 4.1 vs 5.9 - 1.475: switch');
  assert.equal(pickCallout(L, 6.1, 0, A), B, 'dB 3.9 vs 6.1 - 1.5: switch');
  assert.equal(pickCallout(L, 4.1, 0, B), A, 'back the other way');
  assert.equal(pickCallout(L, 4.5, 0, B), B, 'dA 4.5 vs 5.5 - 1.375: stay');
  // Close points: the 0.25 dC term rules.
  const C = { name: 'C', x: 0, z: 0 }, D = { name: 'D', x: 1, z: 0 };
  assert.equal(pickCallout([C, D], 0.55, 0, C), C, 'dD .45 vs .55 - .1375: stay');
  assert.equal(pickCallout([C, D], 0.6, 0, C), D, 'dD .4 vs .6 - .15: switch');
  // Current callout from another map, empty list, bad input.
  assert.equal(pickCallout(L, 9, 0, { name: 'old', x: 9, z: 0 }), B);
  assert.equal(pickCallout([], 1, 1, A), A);
  assert.equal(pickCallout(null, 1, 1, null), null);
  assert.equal(pickCallout(L, NaN, 0, A), A);
});

test('hysteresis on Jam: A Site and A Hut (1.8 m apart) switch both ways', () => {
  const jam = served('jam').callouts;
  const site = jam.find((c) => c.name === 'A Site'), hut = jam.find((c) => c.name === 'A Hut');
  assert.ok(site && hut);
  assert.ok(Math.abs(Math.hypot(site.x - hut.x, site.z - hut.z) - 1.81) < 0.01);
  let cur = pickCallout(jam, site.x, site.z, null);
  assert.equal(cur, site);
  const mid = (site.z + hut.z) / 2;
  cur = pickCallout(jam, site.x, mid - 0.05, cur);
  assert.equal(cur, site, 'just past the middle: stay');
  cur = pickCallout(jam, hut.x, hut.z, cur);
  assert.equal(cur, hut, 'standing on A Hut: switch');
  cur = pickCallout(jam, site.x, mid + 0.05, cur);
  assert.equal(cur, hut, 'just past the middle the other way: stay');
  cur = pickCallout(jam, site.x, site.z, cur);
  assert.equal(cur, site, 'back on A Site: switch');
});

test('layout: one line centred under the minimap, clear of the arena tag', () => {
  const rect = { left: 24, top: 60, width: 240, height: 240, bottom: 300, right: 264 };
  const box = labelBox(rect);
  assert.deepEqual(box, { left: 24, top: 306, width: 240 });
  const h = Number(/line-height:(\d+)px;height:(\d+)px/.exec(LOC_SRC)[2]);
  assert.ok(box.top + h <= rect.bottom + 36 - 8, 'label ends well above the arena tag (minimap bottom + 36)');
  assert.match(LOC_SRC, /white-space:nowrap;text-overflow:ellipsis;text-align:center/);
  assert.doesNotMatch(LOC_SRC.slice(LOC_SRC.indexOf('style.textContent'), LOC_SRC.indexOf('appendChild(style)')), /#[0-9a-f]{3,6}\b/i, 'theme vars only');
});

// ---------- the browser part against a small fake page ----------
function fakePage({ setting = null, minimapRect = { left: 20, top: 40, width: 200, height: 200, bottom: 240, right: 220 } } = {}) {
  const listeners = {};
  const intervals = [];
  const appended = [];
  let now = 0;
  const el = (tag) => ({
    tag, style: {}, className: '', textContent: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { appended.push(c); return c; },
  });
  const minimap = { rect: minimapRect, getBoundingClientRect() { return this.rect; } };
  const store = new Map(setting === null ? [] : [['aim-maps-location', setting]]);
  const ctx = {
    console,
    performance: { now: () => now },
    setInterval: (fn) => { intervals.push(fn); return 0; },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (url) => {
      const id = /\/aim-maps\/(.+)\.minimap\.json$/.exec(url)[1];
      return MAP_IDS.includes(id) ? { ok: true, json: async () => served(id) } : { ok: false, json: async () => null };
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    document: {
      head: el('head'), body: el('body'), documentElement: el('html'),
      getElementById: () => null,
      createElement: el,
      querySelector: (sel) => (sel === '.hall-train-layer [data-role="minimap"]' ? ctx.__minimap : null),
    },
    __minimap: minimap,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(HUB_SRC, ctx);
  vm.runInContext(LOC_SRC, ctx);
  const label = () => appended.find((n) => n.className === 'aim-map-location');
  return {
    ctx, minimap, label,
    phase: (detail) => { for (const fn of listeners['aim-round-phase'] || []) fn({ detail }); },
    tick: (x, z) => { now += 200; ctx.__aimTickHub.emit({ tick: now, player: { position: { x, y: 0, z } } }); },
    timers: () => { for (const fn of intervals) fn(); },
    settle: () => new Promise((r) => setTimeout(r, 0)),
    shown: () => !!label() && label().style.display === 'block',
  };
}

test('page: label follows the player on Jam, hides off the run', async () => {
  const p = fakePage();
  const jam = served('jam').callouts;
  const site = jam.find((c) => c.name === 'A Site'), main = jam.find((c) => c.name === 'A Main');
  p.phase({ phase: 'running', previous: 'idle', mapId: 'jam' });
  await p.settle(); await p.settle();
  p.tick(site.x, site.z);
  assert.ok(p.shown());
  assert.equal(p.label().textContent, 'A Site');
  assert.deepEqual([p.label().style.left, p.label().style.top, p.label().style.width], ['20px', '246px', '200px']);
  p.tick(main.x, main.z);
  assert.equal(p.label().textContent, 'A Main');
  p.phase({ phase: 'paused', previous: 'running', mapId: 'jam' });
  assert.ok(!p.shown(), 'paused');
  p.phase({ phase: 'running', previous: 'paused', mapId: 'jam' });
  assert.ok(p.shown(), 'resumed keeps the label');
  p.minimap.rect = { ...p.minimap.rect, width: 0, height: 0 };
  p.timers();
  assert.ok(!p.shown(), 'minimap hidden (blinded)');
  p.minimap.rect = { left: 40, top: 40, width: 300, height: 300, bottom: 340, right: 340 };
  p.timers();
  assert.deepEqual([p.label().style.left, p.label().style.top, p.label().style.width], ['40px', '346px', '300px'], 'follows a bigger minimap');
  p.phase({ phase: 'result', previous: 'running', mapId: 'jam' });
  assert.ok(!p.shown(), 'result screen');
  p.phase({ phase: 'idle', previous: 'result', mapId: null });
  assert.ok(!p.shown(), 'lobby');
  // A drill without a map: no label.
  p.phase({ phase: 'running', previous: 'idle', mapId: null });
  p.tick(0, 0);
  assert.ok(!p.shown(), 'no map, no label');
});

test('page: setting off hides the label; unknown map shows nothing', async () => {
  const off = fakePage({ setting: '0' });
  off.phase({ phase: 'running', previous: 'idle', mapId: 'ascent' });
  await off.settle(); await off.settle();
  off.tick(0, 0);
  assert.ok(!off.shown());
  const bad = fakePage();
  bad.phase({ phase: 'running', previous: 'idle', mapId: 'nope' });
  await bad.settle(); await bad.settle();
  bad.tick(0, 0);
  assert.ok(!bad.shown());
  const no = fakePage({ minimapRect: null });
  no.ctx.__minimap = null;
  no.phase({ phase: 'running', previous: 'idle', mapId: 'ascent' });
  await no.settle(); await no.settle();
  no.tick(0, 0);
  assert.ok(!no.shown(), 'no minimap element');
});
