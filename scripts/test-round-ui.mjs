// Round mode shell scripts in node with a tiny fake DOM: app/round-panel.js (nav prefetch, Start
// launches synchronously when the nav is cached and waits only for a running fetch) and
// app/round-hud.js (an enemy defusing your spike: text, bar, beep pattern; no success chirp when
// the attacker loses to a defuse; html.aim-round-on follows window.__aimRoundOn at once; the
// detonation screen flash and the delayed end banner), the style rules both files follow
// (theme vars, no em dashes) and the detonation blast in app/mods/aim-rounds/round-visual.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(root, 'app', f), 'utf-8');

class El {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.sel = new Map(); this.dataset = {}; this.style = {}; this.hidden = false; this.textContent = ''; this.innerHTML = ''; this.isConnected = false; this.parentElement = null; this.disabled = false;
    const cls = new Set(); this.classList = { toggle: (c, on) => { (on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c); }, add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) }; }
  get childElementCount() { return this.children.length; }
  append(...c) { for (const x of c) if (x instanceof El) { x.parentElement = this; x.isConnected = true; this.children.push(x); } }
  appendChild(c) { this.append(c); return c; }
  remove() { this.isConnected = false; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  click() { for (const f of this.listeners.click ?? []) f({ stopPropagation() {}, target: this }); }
  focus() {}
  querySelector(s) { if (!this.sel.has(s)) this.sel.set(s, new El()); return this.sel.get(s); }
  querySelectorAll() { return []; }
}

function context(extra = {}) {
  const store = new Map();
  const listeners = {};
  const ctx = {
    console, Promise, Map, Set, Uint8Array, ArrayBuffer, String, JSON, Math, Number, Object, Array, Error,
    document: { createElement: (t) => new El(t), head: new El(), body: new El(), getElementById: () => null, documentElement: new El(), activeElement: null },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: (t, f) => { (listeners[t] ??= []).push(f); }, removeEventListener() {}, dispatchEvent() { return true; },
    Event: class { constructor(t) { this.type = t; } }, HTMLButtonElement: class {},
    setTimeout: (f, ms) => { ctx.timers.push({ f, ms }); return ctx.timers.length; }, timers: [],
    ...extra,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}
const flush = () => new Promise((r) => setImmediate(r));
const rnav = () => { const b = new ArrayBuffer(16); new Uint8Array(b).set([82, 78, 65, 86]); return b; };
const response = (buf, ok = true) => ({ ok, arrayBuffer: async () => buf });

test('round panel: prefetches every map nav on load into globalThis.__aimRoundNav; bad or missing files are remembered', async () => {
  const urls = [];
  const ctx = context({ fetch: async (u) => { urls.push(u); return response(rnav()); } });
  vm.runInContext(src('round-panel.js'), ctx);
  assert.deepEqual(urls, ['/aim-rounds/ascent.nav.bin', '/aim-rounds/rook.nav.bin']);
  await flush();
  for (const m of ['ascent', 'rook']) {
    assert.ok(ctx.__aimRoundNav[m] instanceof ArrayBuffer, m);
    assert.equal(ctx.__aimRoundPanel.navState[m], 'ok', m);
  }
  for (const [name, fetchFn] of [['404', async () => response(null, false)], ['not RNAV', async () => response(new ArrayBuffer(16))], ['network', async () => { throw new Error('x'); }]]) {
    const c = context({ fetch: fetchFn });
    vm.runInContext(src('round-panel.js'), c);
    await flush();
    for (const m of ['ascent', 'rook']) {
      assert.equal(c.__aimRoundPanel.navState[m], 'missing', `${name} ${m}`);
      assert.ok(!c.__aimRoundNav?.[m], `${name} ${m}`);
    }
  }
});

test('round panel: Start launches inside the click when the nav is cached or known missing; waits only for a running fetch', async () => {
  // Cached.
  let launches = [];
  let ctx = context({ fetch: async () => response(rnav()), __aimLaunchScene: (o) => { launches.push(o); return true; } });
  vm.runInContext(src('round-panel.js'), ctx);
  await flush();
  ctx.__aimRoundPanel.open();
  ctx.document.body.children.at(-1).querySelector('.aim-round-start').click();
  assert.equal(launches.length, 1, 'synchronous launch');
  assert.equal(launches[0].shareCode, 'round-ascent-attack-vandal-20');
  // Known missing (404): synchronous too, no new fetch on Start.
  launches = [];
  let fetches = 0;
  ctx = context({ fetch: async () => { fetches++; return response(null, false); }, __aimLaunchScene: (o) => { launches.push(o); return true; } });
  vm.runInContext(src('round-panel.js'), ctx);
  await flush();
  ctx.__aimRoundPanel.open(); // opening retries the missing files (both maps)
  await flush();
  assert.equal(fetches, 4);
  ctx.document.body.children.at(-1).querySelector('.aim-round-start').click();
  assert.equal(launches.length, 1);
  assert.equal(fetches, 4);
  // Cold: the fetch is still running -> wait for it, then launch once (a second click does nothing).
  launches = [];
  const releases = [];
  const release = () => { for (const f of releases.splice(0)) f(); };
  ctx = context({ fetch: () => new Promise((r) => { releases.push(() => r(response(rnav()))); }), __aimLaunchScene: (o) => { launches.push(o); return true; } });
  vm.runInContext(src('round-panel.js'), ctx);
  ctx.__aimRoundPanel.open();
  const shade = ctx.document.body.children.at(-1);
  shade.querySelector('.aim-round-start').click();
  shade.querySelector('.aim-round-start').click();
  assert.equal(launches.length, 0, 'waits for the running fetch');
  assert.match(shade.querySelector('.aim-round-note').textContent, /Loading/);
  release();
  await flush(); await flush();
  assert.equal(launches.length, 1);
  assert.ok(ctx.__aimRoundNav.ascent instanceof ArrayBuffer, 'cached before the launch');
});

test('round panel: Ascent and Corrode in the map row; picking Corrode starts round-rook-... ("Round · Corrode") and is remembered', async () => {
  const launches = [];
  const ctx = context({ fetch: async () => response(rnav()), __aimLaunchScene: (o) => { launches.push(o); return true; } });
  vm.runInContext(src('round-panel.js'), ctx);
  await flush();
  assert.equal(JSON.stringify(ctx.__aimRoundPanel.maps.map((m) => [m.id, m.name])), JSON.stringify([['ascent', 'Ascent'], ['rook', 'Corrode']]), 'vm-realm array');
  ctx.__aimRoundPanel.open();
  let shade = ctx.document.body.children.at(-1);
  const row = shade.querySelector('[data-k="map"]');
  assert.deepEqual(row.children.map((b) => b.dataset.v), ['ascent', 'rook']);
  assert.ok(row.children[0].classList.contains('is-active'), 'Ascent picked by default');
  row.children[1].click();
  assert.ok(row.children[1].classList.contains('is-active') && !row.children[0].classList.contains('is-active'));
  shade.querySelector('.aim-round-start').click();
  assert.equal(launches.length, 1);
  assert.equal(launches[0].shareCode, 'round-rook-attack-vandal-20');
  assert.equal(launches[0].name, 'Round · Corrode');
  assert.equal(JSON.parse(ctx.localStorage.getItem('aim-round-setup')).map, 'rook');
  ctx.__aimRoundPanel.open();
  shade = ctx.document.body.children.at(-1);
  const row2 = shade.querySelector('[data-k="map"]');
  assert.ok(row2.children[1].classList.contains('is-active') && !row2.children[0].classList.contains('is-active'), 'Corrode remembered');
  // A stored map that is no longer listed falls back to the first map.
  ctx.localStorage.setItem('aim-round-setup', JSON.stringify({ map: 'nowhere' }));
  ctx.__aimRoundPanel.open();
  assert.ok(ctx.document.body.children.at(-1).querySelector('[data-k="map"]').children[0].classList.contains('is-active'));
});

test('round panel: Defense is enabled ("Stop the plant"), starts round-<map>-defense-..., is remembered, header text and subtitle follow the side; bad stored side -> Attack', async () => {
  const launches = [];
  const ctx = context({ fetch: async () => response(rnav()), __aimLaunchScene: (o) => { launches.push(o); return true; } });
  vm.runInContext(src('round-panel.js'), ctx);
  await flush();
  const openShade = () => { ctx.__aimRoundPanel.open(); return ctx.document.body.children.at(-1); };
  let shade = openShade();
  let side = shade.querySelector('[data-k="side"]');
  assert.deepEqual(side.children.map((b) => b.dataset.v), ['attack', 'defense']);
  const [atk, def] = side.children;
  assert.equal(def.disabled, false, 'Defense enabled');
  assert.match(def.innerHTML, /<small>Stop the plant<\/small>/);
  assert.ok(atk.classList.contains('is-active') && !def.classList.contains('is-active'), 'Attack by default');
  assert.match(shade.querySelector('.aim-round-blurb').textContent, /plant the spike in a site/);
  def.click();
  assert.ok(def.classList.contains('is-active') && !atk.classList.contains('is-active'));
  assert.match(shade.querySelector('.aim-round-blurb').textContent, /stop the attackers from planting, or defuse the spike/);
  shade.querySelector('.aim-round-start').click();
  assert.equal(launches.at(-1).shareCode, 'round-ascent-defense-vandal-20');
  assert.equal(launches.at(-1).subtitle, 'Defense · stop the plant');
  assert.equal(JSON.parse(ctx.localStorage.getItem('aim-round-setup')).side, 'defense');
  // Remembered; Corrode defense too.
  shade = openShade();
  side = shade.querySelector('[data-k="side"]');
  assert.ok(side.children[1].classList.contains('is-active'), 'Defense remembered');
  shade.querySelector('[data-k="map"]').children[1].click();
  assert.ok(side.children[1].classList.contains('is-active'), 'still Defense on Corrode');
  shade.querySelector('.aim-round-start').click();
  assert.equal(launches.at(-1).shareCode, 'round-rook-defense-vandal-20');
  // Back to Attack: subtitle and stored side follow.
  shade = openShade();
  shade.querySelector('[data-k="side"]').children[0].click();
  shade.querySelector('.aim-round-start').click();
  assert.equal(launches.at(-1).shareCode, 'round-rook-attack-vandal-20');
  assert.equal(launches.at(-1).subtitle, 'Attack · plant the spike');
  assert.equal(JSON.parse(ctx.localStorage.getItem('aim-round-setup')).side, 'attack');
  // A missing or unknown stored side -> Attack.
  for (const v of [{ map: 'ascent' }, { map: 'ascent', side: 'retake' }, { map: 'ascent', side: 7 }]) {
    ctx.localStorage.setItem('aim-round-setup', JSON.stringify(v));
    const s = openShade().querySelector('[data-k="side"]');
    assert.ok(s.children[0].classList.contains('is-active') && !s.children[1].classList.contains('is-active'), JSON.stringify(v));
  }
});

test('round panel: a map without defense (defense: false) shows Defense as "Coming soon" there, and a picked or stored Defense falls back to Attack', async () => {
  const launches = [];
  const code = src('round-panel.js').replace('{ id: "rook", name: "Corrode", defense: true }', '{ id: "rook", name: "Corrode", defense: false }');
  assert.ok(code.includes('defense: false }'), 'test patch applied');
  const ctx = context({ fetch: async () => response(rnav()), __aimLaunchScene: (o) => { launches.push(o); return true; } });
  vm.runInContext(code, ctx);
  await flush();
  ctx.localStorage.setItem('aim-round-setup', JSON.stringify({ map: 'rook', side: 'defense' }));
  ctx.__aimRoundPanel.open();
  const shade = ctx.document.body.children.at(-1), side = shade.querySelector('[data-k="side"]'), map = shade.querySelector('[data-k="map"]');
  assert.equal(side.children[1].disabled, true);
  assert.match(side.children[1].innerHTML, /<small>Coming soon<\/small>/);
  assert.ok(side.children[0].classList.contains('is-active'), 'stored Defense on Corrode -> Attack');
  map.children[0].click(); // Ascent: Defense available again
  assert.equal(side.children[1].disabled, false);
  side.children[1].click();
  map.children[1].click(); // back to Corrode with Defense picked -> Attack
  assert.equal(side.children[1].disabled, true);
  assert.ok(side.children[0].classList.contains('is-active') && !side.children[1].classList.contains('is-active'));
  shade.querySelector('.aim-round-start').click();
  assert.equal(launches.at(-1).shareCode, 'round-rook-attack-vandal-20');
});

test('round panel maps: every listed map ships aim-rounds/<id>.json (schema 1, map = id, name = the label, A-C sites) and <id>.nav.bin (RNAV); its round scene builds', () => {
  const ctx = context({ fetch: async () => response(rnav()) });
  vm.runInContext(src('round-panel.js'), ctx);
  const { buildDoc } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
  const dir = path.join(root, 'app', 'mods', 'aim-rounds');
  assert.ok(ctx.__aimRoundPanel.maps.length >= 2);
  for (const m of ctx.__aimRoundPanel.maps) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${m.id}.json`), 'utf-8'));
    assert.equal(data.schema, 1, m.id);
    assert.equal(data.map, m.id);
    assert.equal(data.name, m.name, `${m.id}: json name is the panel label`);
    assert.ok(data.sites.length >= 2 && data.sites.every((s) => /^[A-C]$/.test(s.id)), `${m.id}: site ids`);
    const nav = fs.readFileSync(path.join(dir, `${m.id}.nav.bin`));
    assert.equal(nav.subarray(0, 4).toString('latin1'), 'RNAV', `${m.id}: nav.bin magic`);
    const doc = buildDoc(data, { side: 'attack', weapon: 'vandal', barrierSec: 20 });
    assert.equal(doc.rules.round.map, m.id);
    assert.equal(doc.meta.id, `round-${m.id}-attack`);
  }
});

test('round core: roundView.sites = the cfg site ids (A, B on both maps; A, B, C on a 3-site cfg; [] without sites), one frozen array per cfg', async () => {
  const core = await import(pathToFileURL(path.join(root, 'app', 'mods', 'aim-rounds', 'round-core.mjs')).href);
  const { buildDoc } = createRequire(import.meta.url)(path.join(root, 'app', 'round-scene.js'));
  const TS = 1 / 128;
  for (const map of ['ascent', 'rook']) {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'app', 'mods', 'aim-rounds', `${map}.json`), 'utf-8'));
    const cfg = buildDoc(data, { side: 'attack', weapon: 'vandal', barrierSec: 20 }).rules.round;
    const st = core.roundCreate(cfg, TS);
    const v1 = core.roundView(cfg, st, TS), v2 = core.roundView(cfg, st, TS);
    assert.deepEqual([...v1.sites], ['A', 'B'], map);
    assert.equal(v1.sites, v2.sites, `${map}: cached per cfg`);
    assert.ok(Object.isFrozen(v1.sites));
    const three = { ...cfg, sites: [...cfg.sites, { ...cfg.sites[0], id: 'C' }] };
    assert.deepEqual([...core.roundView(three, core.roundCreate(three, TS), TS).sites], ['A', 'B', 'C']);
    const none = { ...cfg, sites: undefined };
    assert.deepEqual([...core.roundView(none, st, TS).sites], []);
  }
});

// ---------------------------------------------------------------- HUD
function hud(pre = {}) {
  const tones = [];
  let interval = null, raf = null, now = 0;
  class Node { connect(n) { return n; } }
  const audio = class { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createOscillator() { const o = new Node(); o.frequency = {}; o.start = () => tones.push({ at: now, f: o.frequency.value, type: o.type }); o.stop = () => {}; return o; }
    createGain() { const g = new Node(); g.gain = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; return g; } };
  const ctx = context({ AudioContext: audio, setInterval: (f) => { interval = f; }, requestAnimationFrame: (f) => { raf = f; return 1; }, performance: { now: () => now * 1000 }, ...pre });
  vm.runInContext(src('round-hud.js'), ctx);
  const root = ctx.document.body;
  const el = () => root.children[0];
  const show = (r, t) => {
    now = t;
    ctx.__aimRoundOn = true; ctx.__aimRound = r;
    if (!raf) interval();
    const f = raf; raf = null; f?.();
    // Fire due timeouts (second beep of a pair).
    const due = ctx.timers.splice(0); for (const x of due) x.f();
  };
  const tick = () => interval(); // the 250 ms poll
  return { ctx, tones, show, el, tick };
}
const base = { map: 'ascent', side: 'attack', timeLeft: 30, spikeSec: 45, plant: 0, defuse: 0, checkpoint: false, holding: null, zone: null, near: false, carrying: false, spike: { carrier: null, dropped: null, planted: { x: 0, y: 0, z: 0, site: 'A' } }, enemiesAlive: 5, enemyCount: 5, playerAlive: true, winner: null, reason: null, win: null, done: false };

test('round HUD: an enemy defusing your spike shows "Spike being defused", its progress and two low beeps every 0.5 s', () => {
  const h = hud();
  let tick = 100;
  h.show({ ...base, phase: 'planted', tick: tick++, botDefusing: false }, 0);
  const root = h.el();
  assert.equal(root.querySelector('.arh-bar').hidden, true);
  assert.match(root.querySelector('.arh-spike').textContent, /Spike planted/);
  const low0 = h.tones.filter((t) => t.f === 260).length;
  assert.equal(low0, 0);
  for (let i = 0; i <= 20; i++) h.show({ ...base, phase: 'planted', tick: tick++, botDefusing: true, defuser: 3, defuse: 0.25 }, 1 + i * 0.05);
  assert.equal(root.querySelector('.arh-spike').textContent, 'Spike being defused');
  assert.equal(root.querySelector('.arh-bar').hidden, false);
  assert.equal(root.querySelector('.arh-bar small').textContent, 'SPIKE BEING DEFUSED');
  assert.equal(root.querySelector('.arh-fill').style.width, '25%');
  const low = h.tones.filter((t) => t.f === 260);
  // 1.0 .. 2.0 s: pairs at 1.0, 1.5, 2.0.
  assert.equal(low.length, 6, JSON.stringify(low));
  // Back to no defuser: bar hidden again, no more low beeps.
  h.show({ ...base, phase: 'planted', tick: tick++, botDefusing: false }, 2.3);
  h.show({ ...base, phase: 'planted', tick: tick++, botDefusing: false }, 2.9);
  assert.equal(root.querySelector('.arh-bar').hidden, true);
  assert.equal(h.tones.filter((t) => t.f === 260).length, 6);
});

test('round HUD: the carry hint names the round sites ("A or B", "A, B or C"); no usable sites -> "a site"', () => {
  const h = hud();
  const hint = () => h.el().querySelector('.arh-hint');
  const live = { ...base, phase: 'live', carrying: true, zone: null, spike: { carrier: 'player', dropped: null, planted: null } };
  let tick = 1;
  const cases = [[['A', 'B'], 'Take the spike to A or B site'], [['A', 'B', 'C'], 'Take the spike to A, B or C site'], [['B'], 'Take the spike to B site'], [undefined, 'Take the spike to a site'], [[], 'Take the spike to a site'], [['<i>'], 'Take the spike to a site']];
  for (const [sites, want] of cases) {
    h.show({ ...live, sites, tick: tick++ }, tick * 0.3);
    assert.equal(hint().hidden, false, String(sites));
    assert.equal(hint().innerHTML, want, String(sites));
  }
  h.show({ ...live, sites: ['A', 'B'], zone: 'A', tick: tick++ }, tick * 0.3);
  assert.match(hint().innerHTML, /Hold <kbd>4<\/kbd> to plant/, 'in a zone: the plant hint');
});

test('round HUD: defused as the attacker = loss tone, no success chirp; as the defender the chirp stays', () => {
  for (const [win, chirp] of [[false, false], [true, true]]) {
    const h = hud();
    h.show({ ...base, side: win ? 'defense' : 'attack', phase: 'planted', tick: 1, botDefusing: !win }, 0);
    h.tones.length = 0;
    h.show({ ...base, side: win ? 'defense' : 'attack', phase: 'ended', tick: 2, reason: 'defused', winner: 'defense', win }, 0.1);
    const fs_ = h.tones.map((t) => t.f);
    assert.equal(fs_.includes(990) || fs_.includes(660), chirp, `win ${win}: ${fs_}`);
    if (!win) assert.ok(fs_.includes(220), 'loss tone');
    assert.equal(h.el().querySelector('.arh-banner b').textContent, win ? 'ROUND WON' : 'ROUND LOST');
    assert.equal(h.el().querySelector('.arh-banner').hidden, false, 'defuse: banner at once');
    assert.equal(h.el().querySelector('.arh-flash').hidden, true, 'defuse: no screen flash');
  }
});

test('round HUD defense: "Defend A and B" objective, no "Spike dropped", defuse hints after the plant; attack keeps "Spike dropped"', () => {
  const h = hud();
  const spike = () => h.el().querySelector('.arh-spike').textContent;
  const hint = () => h.el().querySelector('.arh-hint');
  const d = { ...base, side: 'defense', sites: ['A', 'B'], spike: { carrier: null, dropped: null, planted: null } };
  let tick = 1;
  h.show({ ...d, phase: 'barrier', tick: tick++ }, 0.1);
  assert.equal(spike(), 'Defend A and B');
  assert.match(hint().innerHTML, /^Barriers drop in/);
  h.show({ ...d, phase: 'live', tick: tick++ }, 0.2);
  assert.equal(spike(), 'Defend A and B');
  assert.equal(hint().hidden, true, 'no center hint while live');
  for (const [sites, want] of [[['A', 'B', 'C'], 'Defend A, B and C'], [['B'], 'Defend B'], [[], 'Defend the sites'], [['<b>'], 'Defend the sites']]) {
    h.show({ ...d, phase: 'live', sites, tick: tick++ }, tick * 0.1);
    assert.equal(spike(), want, String(sites));
  }
  // The attackers dropped their spike: the defender is not told.
  h.show({ ...d, phase: 'live', spike: { carrier: null, dropped: { x: 1, y: 0, z: 2 }, planted: null }, tick: tick++ }, 1);
  assert.equal(spike(), 'Defend A and B', 'no "Spike dropped" on defense');
  // Planted: the site; far -> "Defuse the spike at B"; near -> the F hint; holding -> none.
  const planted = { ...d, phase: 'planted', spike: { carrier: null, dropped: null, planted: { x: 0, y: 0, z: 0, site: 'B' } } };
  h.show({ ...planted, tick: tick++ }, 1.1);
  assert.equal(spike(), 'Spike planted · B');
  assert.equal(hint().hidden, false); assert.equal(hint().innerHTML, 'Defuse the spike at B');
  h.show({ ...planted, near: true, tick: tick++ }, 1.2);
  assert.equal(hint().innerHTML, 'Hold <kbd>F</kbd> to defuse');
  h.show({ ...planted, near: true, holding: 'defuse', defuse: 0.4, tick: tick++ }, 1.3);
  assert.equal(hint().hidden, true);
  assert.equal(h.el().querySelector('.arh-bar small').textContent, 'DEFUSING');
  h.show({ ...planted, spike: { carrier: null, dropped: null, planted: { x: 0, y: 0, z: 0, site: '<i>' } }, tick: tick++ }, 1.4);
  assert.equal(hint().innerHTML, 'Defuse the spike', 'odd site id dropped');
  // Attack side: the dropped spike line stays.
  const a = hud();
  a.show({ ...base, phase: 'live', sites: ['A', 'B'], spike: { carrier: null, dropped: { x: 1, y: 0, z: 2 }, planted: null }, tick: 1 }, 0.1);
  assert.equal(a.el().querySelector('.arh-spike').textContent, 'Spike dropped');
});

test('round HUD defense: the enemy plant sound follows plantCue (one looping voice, panned, level from gain), stops when the cue goes, on pause, on the plant, at the round end and off the defense side', () => {
  const log = { osc: [], pan: [], lvl: [], stops: 0 }; // stops: the cue's two oscillators only (beeps stop too)
  class Node { connect(n) { return n; } disconnect() {} }
  // Only the cue uses setTargetAtTime: on the level gain (log.lvl) and on the panner (log.pan).
  const param = (tag) => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime(v) { log[tag].push(v); this.value = v; } });
  const AC = class { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = new Node(); }
    createOscillator() { const o = new Node(); o.frequency = { value: 0 }; o.start = () => log.osc.push({ f: o.frequency.value, type: o.type }); o.stop = () => { if (o.frequency.value === 540 || o.frequency.value === 5) log.stops++; }; return o; }
    createGain() { const g = new Node(); g.gain = param('lvl'); return g; }
    createStereoPanner() { const p = new Node(); p.pan = param('pan'); return p; } };
  const h = hud({ AudioContext: AC });
  const voices = () => log.osc.filter((o) => o.f === 540).length;
  const d = { ...base, side: 'defense', sites: ['A', 'B'], spike: { carrier: null, dropped: null, planted: null } };
  let tick = 1;
  const at = (r, t) => h.show({ ...d, tick: tick++, ...r }, t);
  at({ phase: 'live', plantCue: null }, 0.1);
  assert.equal(log.osc.length, 0, 'no cue, no sound');
  at({ phase: 'live', plantCue: { pan: -0.75, gain: 0.5 } }, 0.2);
  assert.equal(voices(), 1, 'one 540 Hz voice started');
  assert.equal(log.osc.find((o) => o.f === 540).type, 'triangle');
  assert.ok(log.osc.some((o) => o.f === 5 && o.type === 'square'), 'the 5 Hz pulse');
  assert.equal(log.pan.at(-1), -0.75, 'panned left');
  assert.ok(Math.abs(log.lvl.at(-1) - (0.03 + 0.09 * 0.5)) < 1e-9, `level ${log.lvl.at(-1)}`);
  at({ phase: 'live', plantCue: { pan: 1, gain: 1 } }, 0.3);
  assert.equal(voices(), 1, 'still one voice (updated, not restarted)');
  assert.equal(log.pan.at(-1), 1); assert.ok(Math.abs(log.lvl.at(-1) - 0.12) < 1e-9);
  // The cue goes away: the voice fades and stops.
  at({ phase: 'live', plantCue: null }, 0.4);
  assert.equal(log.stops, 2, 'voice + pulse stopped'); assert.equal(log.lvl.at(-1), 0);
  at({ phase: 'live', plantCue: null }, 0.45);
  assert.equal(log.stops, 2, 'stopped once');
  // Starts again; the plant (phase planted) stops it even if a stale cue rides along.
  at({ phase: 'live', plantCue: { pan: 0, gain: 0.3 } }, 0.5);
  assert.equal(voices(), 2);
  at({ phase: 'planted', plantCue: { pan: 0, gain: 0.3 }, spike: { carrier: null, dropped: null, planted: { x: 0, y: 0, z: 0, site: 'A' } } }, 0.6);
  assert.equal(log.stops, 4, 'stopped on the plant');
  // Paused (the same sim tick for > 0.25 s): silent.
  const T = tick++;
  h.show({ ...d, phase: 'live', plantCue: { pan: 0, gain: 0.3 }, tick: T }, 0.7);
  assert.equal(voices(), 3);
  h.show({ ...d, phase: 'live', plantCue: { pan: 0, gain: 0.3 }, tick: T }, 1.2);
  assert.equal(log.stops, 6, 'stopped while paused');
  // Round over (done): stopped.
  at({ phase: 'live', plantCue: { pan: 0, gain: 0.3 } }, 1.3);
  assert.equal(voices(), 4);
  at({ phase: 'ended', done: true, plantCue: null }, 1.4);
  assert.equal(log.stops, 8, 'stopped when the round view is done');
  // Attack side: a cue never plays.
  const a = hud({ AudioContext: AC });
  a.show({ ...base, side: 'attack', phase: 'live', plantCue: { pan: 0, gain: 1 }, spike: { carrier: 'player', dropped: null, planted: null }, tick: 1 }, 0.1);
  assert.equal(voices(), 4, 'attack side: no cue');
});

test('round HUD: beeps go through window.__aimAudio.bus.ui when present', () => {
  const h = hud();
  const used = [];
  const bus = { context: new h.ctx.AudioContext(), connect() {} };
  const orig = bus.context.createOscillator.bind(bus.context);
  bus.context.createOscillator = () => { const o = orig(); const c = o.connect; o.connect = (n) => { used.push(n); return c.call(o, n); }; return o; };
  h.ctx.__aimAudio = { bus: { ui: bus } };
  h.show({ ...base, phase: 'live', tick: 1, spike: { carrier: 'player', dropped: null, planted: null } }, 0);
  h.show({ ...base, phase: 'planted', tick: 2 }, 0.1);
  assert.ok(used.length > 0, 'oscillators created on the bus context');
});

test('round HUD: html.aim-round-on follows window.__aimRoundOn synchronously (setter), keeps a value set before load', () => {
  const h = hud();
  const html = h.ctx.document.documentElement;
  assert.equal(html.classList.contains('aim-round-on'), false);
  h.ctx.__aimRoundOn = true; // set from outside the vm, like the play page does
  assert.equal(html.classList.contains('aim-round-on'), true, 'on with no tick');
  assert.equal(h.ctx.__aimRoundOn, true, 'getter returns the value');
  h.ctx.__aimRoundOn = false;
  assert.equal(html.classList.contains('aim-round-on'), false, 'off with no tick');
  // A round already on when the script loads (page reload mid-run).
  const h2 = hud({ __aimRoundOn: true });
  assert.equal(h2.ctx.document.documentElement.classList.contains('aim-round-on'), true);
  assert.equal(h2.ctx.__aimRoundOn, true);
  // Poll backup: the class is put back if something else changed it.
  h2.ctx.document.documentElement.classList.remove('aim-round-on');
  h2.tick();
  assert.equal(h2.ctx.document.documentElement.classList.contains('aim-round-on'), true);
  // The stylesheet (chip hide + brief card rules) is added at load, before any round frame.
  const css = h.ctx.document.head.children.map((c) => c.textContent).join('\n');
  assert.match(css, /html\.aim-round-on \.al-hud-top \{ display: none !important; \}/);
  for (const sel of ['.al-scene-brief-head', '.al-scene-brief-author', '.al-scene-brief hr', '.al-scene-brief-specs', '.al-scene-brief-note', '.al-scene-brief-says > .al-start-kicker']) assert.ok(css.includes('html.aim-round-on ' + sel), sel);
  assert.ok(!css.includes('.al-scene-brief-overlay'), 'the card itself stays (Start / Back)');
  // The game's 3-line clamp on the description is lifted for rounds.
  assert.match(css, /html\.aim-round-on \.al-scene-brief-says p \{[^}]*-webkit-line-clamp: unset;[^}]*overflow: visible;/);
});

test('round HUD: detonation = screen flash at once, end banner 0.6 s later; both reset for the next round', () => {
  const h = hud();
  const planted = { ...base, phase: 'planted', timeLeft: 0.1 };
  const boom = { ...base, phase: 'ended', timeLeft: 0, reason: 'detonated', winner: 'attack', win: true };
  h.show({ ...planted, tick: 1 }, 10);
  const root = h.el();
  const flash = root.querySelector('.arh-flash'), banner = root.querySelector('.arh-banner');
  assert.equal(flash.hidden, true);
  h.show({ ...boom, tick: 2 }, 10.02);
  assert.equal(flash.hidden, false, 'flash on the end frame');
  assert.equal(banner.hidden, true, 'banner waits');
  assert.equal(root.querySelector('.arh-clock span').textContent, '0:00');
  h.show({ ...boom, tick: 2 }, 10.12);
  const o1 = Number(flash.style.opacity);
  assert.equal(flash.hidden, false);
  assert.ok(o1 > 0.4 && o1 <= 0.85, `opacity at +0.1 s: ${o1}`);
  h.show({ ...boom, tick: 2 }, 10.5);
  assert.ok(Number(flash.style.opacity) < o1, 'fades');
  assert.equal(banner.hidden, true, 'banner still hidden before +0.6 s');
  h.show({ ...boom, tick: 2 }, 10.7);
  assert.equal(banner.hidden, false, 'banner after +0.6 s');
  assert.equal(flash.hidden, true, 'flash over');
  assert.equal(root.querySelector('.arh-banner b').textContent, 'ROUND WON');
  // Run over (done) -> HUD hides and forgets the flash; the next round starts clean.
  h.show({ ...boom, tick: 3, done: true }, 12);
  assert.equal(root.hidden, true);
  h.show({ ...planted, tick: 10 }, 20);
  h.show({ ...base, phase: 'ended', tick: 11, reason: 'eliminated', winner: 'attack', win: true }, 20.05);
  assert.equal(flash.hidden, true, 'no flash for other ends');
  assert.equal(banner.hidden, false, 'other ends: banner at once');
});

test('round UI style: theme vars (raw hex only as var fallbacks), no em dashes, es-tool-primary Start', () => {
  for (const f of ['round-hud.js', 'round-panel.js']) {
    const code = src(f);
    const rest = code.replace(/var\(--es-[a-z0-9-]+, [^()]*(\([^()]*\))?[^()]*\)/g, 'VAR');
    const hex = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    assert.deepEqual(hex.filter((x) => !['#ffd166', '#000'].includes(x)), [], `${f}: raw colours`);
    assert.ok(!code.includes('—'), `${f}: em dash`);
    assert.ok(!/border-radius: [1-9]/.test(code), `${f}: rounded corners`);
  }
  const panel = src('round-panel.js');
  assert.ok(panel.includes('class="aim-round-start es-tool-primary"'));
  assert.match(panel, /\.es-tool\.aim-round button:focus-visible \{ outline: 2px solid var\(--es-red, #ff4655\); outline-offset: 2px; \}/);
  assert.ok(!/button\.aim-round-start \{[^}]*background/.test(panel), 'Start look comes from .es-tool-primary');
  assert.match(src('round-hud.js'), /You died\. Spike planted\./);
});

test('round visual: detonation blast draws over walls (no depth test, render order 999) and fades front-loaded', async () => {
  const { createRoundVisual } = await import(pathToFileURL(path.join(root, 'app', 'mods', 'aim-rounds', 'round-visual.mjs')).href);
  class V3 { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { Object.assign(this, { x, y, z }); return this; } copy(o) { return this.set(o.x, o.y, o.z); } setScalar(s) { return this.set(s, s, s); } }
  class Obj { constructor() { this.children = []; this.position = new V3(); this.rotation = new V3(); this.scale = new V3(); this.visible = true; } add(...c) { this.children.push(...c); } remove(c) { this.children = this.children.filter((x) => x !== c); } updateMatrixWorld() {} }
  class G { dispose() {} }
  const THREE = { Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } }, Group: Obj, PlaneGeometry: G, SphereGeometry: G, BoxGeometry: G, CylinderGeometry: G, MeshBasicMaterial: class extends G { constructor(o) { super(); Object.assign(this, o); } }, DoubleSide: 2 };
  const scene = new Obj();
  const v = createRoundVisual(THREE, scene, { barriers: [] });
  const blast = scene.children[0].children.find((m) => m.material?.depthTest === false);
  assert.ok(blast, 'blast mesh with depthTest false');
  assert.equal(blast.renderOrder, 999);
  const at = { x: 1, y: 2, z: 3 };
  const boom = { phase: 'ended', reason: 'detonated', spike: { planted: at } };
  v.update(boom, 5);
  const o0 = blast.material.opacity;
  assert.ok(blast.visible && o0 >= 0.45 && o0 <= 0.55, `start opacity ${o0}`);
  v.update(boom, 5.4);
  const s1 = blast.scale.x, o1 = blast.material.opacity;
  v.update(boom, 5.8);
  assert.ok(Math.abs(blast.scale.x - 35) < 1e-6, 'full radius at 0.8 s');
  assert.ok(s1 > 25, `grows fast (ease-out): ${s1}`);
  assert.ok(o1 < o0 * 0.6, `fades early: ${o1}`);
  v.update(boom, 6.5);
  assert.equal(blast.visible, false, 'gone after 1.4 s');
  v.dispose();
});

// ---------------------------------------------------------------- R5: round stats line
// A hud() whose window listeners are reachable (the ux-result-extra event) and whose document has
// a result card (.al-result-overlay) with the given text, or none.
function statsHud(pre = {}) {
  const on = {};
  const h = hud({ addEventListener: (t, f) => { (on[t] ??= []).push(f); }, ...pre });
  let card = null;
  h.ctx.document.querySelector = (sel) => (sel === '.al-result-overlay' ? card : null);
  h.card = (text) => { card = text === null ? null : { textContent: text }; };
  h.fire = (type, detail) => { for (const f of on[type] ?? []) f({ type, detail }); };
  return h;
}
const stats = (h) => h.el().querySelector('.arh-stats');
const live = { ...base, phase: 'live', spike: { carrier: 'player', dropped: null, planted: null }, kills: 0, plantClock: null, defuseLeft: null };

test('R5 HUD: HS% = head hits / hits on enemies from window.__aimShot (chained: the previous hook runs first), pellets count one by one, barrier shots and repeats do not count', () => {
  const h = statsHud();
  const seen = [];
  h.ctx.__aimShot = function (e) { seen.push({ e, hitsBefore: h.ctx.__aimRoundStats.hits }); return 'feel'; };
  const feel = h.ctx.__aimShot;
  let tick = 1;
  h.show({ ...live, phase: 'barrier', tick: tick++ }, 0.1);
  assert.notEqual(h.ctx.__aimShot, feel, 'wrapped at the first round frame');
  h.ctx.__aimShot({ hitActorId: 2, hitPart: 'head' });
  assert.equal(h.ctx.__aimRoundStats.hits, 0, 'barrier: not counted');
  h.show({ ...live, tick: tick++ }, 0.2);
  const head = { hitActorId: 2, hitPart: 'head' };
  assert.equal(h.ctx.__aimShot(head), 'feel', "the previous hook's return value passes through");
  h.ctx.__aimShot({ hitActorId: 3, hitPart: 'body' });
  h.ctx.__aimShot({ hitActorId: null, hitPart: null }); // miss
  h.ctx.__aimShot({ hitActorId: 0, hitPart: 'legs' }); // actor id 0 is a hit
  h.ctx.__aimShot({ hitActorId: 1, hitPart: 'head', pellets: [{ hitActorId: 1, hitPart: 'head' }, { hitActorId: 1, hitPart: 'body' }, { hitActorId: null, hitPart: null }] });
  assert.equal(seen.length, 6, 'feel saw every shot');
  assert.equal(seen[1].hitsBefore, 0, 'feel ran before the count');
  assert.equal(h.ctx.__aimRoundStats.hits, 5);
  assert.equal(h.ctx.__aimRoundStats.heads, 2);
  // Someone replaces the hook after us: the next frame chains onto the new one; an event that goes
  // through both wrappers counts once.
  const outer = h.ctx.__aimShot;
  h.ctx.__aimShot = function (e) { return outer(e); };
  h.show({ ...live, tick: tick++ }, 0.3);
  h.ctx.__aimShot({ hitActorId: 4, hitPart: 'head' });
  assert.equal(h.ctx.__aimRoundStats.hits, 6);
  assert.equal(h.ctx.__aimRoundStats.heads, 3);
  h.ctx.__aimShot(head);
  assert.equal(h.ctx.__aimRoundStats.hits, 6, 'the same event object counts once');
  // A bullet through one enemy into another (also: [{actorId, part}]): each enemy hit counts.
  h.ctx.__aimShot({ hitActorId: 1, hitPart: 'body', also: [{ actorId: 2, part: 'head' }, { actorId: null, part: null }] });
  assert.equal(h.ctx.__aimRoundStats.hits, 8);
  assert.equal(h.ctx.__aimRoundStats.heads, 4);
  // The round-ending shot arrives with the view already "ended": it counts.
  const won = { ...live, phase: 'ended', reason: 'eliminated', winner: 'attack', win: true, kills: 5 };
  h.show({ ...won, tick: tick++ }, 0.4);
  h.ctx.__aimShot({ hitActorId: 5, hitPart: 'head' });
  h.show({ ...won, tick: tick++ }, 0.5);
  assert.equal(stats(h).textContent, 'Kills 5 · HS 56%');
  // Not in a round: nothing counts.
  h.ctx.__aimRoundOn = false;
  h.ctx.__aimShot({ hitActorId: 5, hitPart: 'head' });
  assert.equal(h.ctx.__aimRoundStats.hits, 9);
  // The next round starts clean (off -> on resets the counts and the line).
  h.ctx.__aimRoundOn = true;
  assert.equal(h.ctx.__aimRoundStats.hits, 0);
  assert.equal(h.ctx.__aimRoundStats.line, '');
});

test('R5 HUD: the stats line under the end banner, per case (attack / defense), parts with no number left out', () => {
  const cases = [
    // [view, hits, heads, line]
    [{ side: 'attack', reason: 'detonated', win: true, kills: 3, plantClock: 57.2 }, 3, 1, 'Kills 3 · HS 33% · Planted at 0:58'],
    [{ side: 'attack', reason: 'timeout', win: false, kills: 1, plantClock: null }, 2, 2, 'Kills 1 · HS 100% · No plant'],
    [{ side: 'attack', reason: 'defused', win: false, kills: 2, plantClock: 40, defuseLeft: 30 }, 4, 1, 'Kills 2 · HS 25% · Enemy defused'],
    [{ side: 'attack', reason: 'died', win: false, kills: 0, plantClock: null }, 0, 0, 'Kills 0'],
    [{ side: 'attack', reason: 'eliminated', win: true, kills: 5, plantClock: 12.01 }, 5, 5, 'Kills 5 · HS 100% · Planted at 0:13'],
    [{ side: 'defense', reason: 'detonated', win: false, kills: 3, plantClock: 50.3 }, 3, 1, 'Kills 3 · HS 33% · Enemy planted at 0:51'],
    [{ side: 'defense', reason: 'defused', win: true, kills: 1, plantClock: 50.3, defuseLeft: 11.2 }, 1, 0, 'Kills 1 · HS 0% · Defused with 0:12 left'],
    [{ side: 'defense', reason: 'eliminated', win: true, kills: 5, plantClock: null }, 6, 2, 'Kills 5 · HS 33%'],
    [{ side: 'defense', reason: 'timeout', win: true, kills: 0, plantClock: null }, 0, 0, 'Kills 0'],
    [{ side: 'attack', reason: 'detonated', win: true, kills: undefined, plantClock: undefined }, 0, 0, ''],
  ];
  for (const [v, hits, heads, want] of cases) {
    const h = statsHud();
    let tick = 1;
    h.show({ ...live, side: v.side, tick: tick++ }, 0.1);
    for (let i = 0; i < hits; i++) h.ctx.__aimShot({ hitActorId: 1, hitPart: i < heads ? 'head' : 'body' });
    h.show({ ...live, ...v, phase: 'ended', winner: v.win === (v.side === 'attack') ? 'attack' : 'defense', tick: tick++ }, 0.2);
    const el = stats(h);
    assert.equal(el.textContent, want, JSON.stringify(v));
    assert.equal(el.hidden, !want, `hidden when empty: ${JSON.stringify(v)}`);
    assert.equal(h.ctx.__aimRoundStats.line, want);
    assert.ok(!want.includes('—'), 'no em dash');
  }
});

test("R5 HUD: the stats line fills ux's result card container (event or __aimUxResult.extra()) on a round result only, once; a new round clears it", () => {
  const h = statsHud();
  let tick = 1;
  h.show({ ...live, tick: tick++ }, 0.1);
  h.ctx.__aimShot({ hitActorId: 1, hitPart: 'head' });
  const end = { ...live, phase: 'ended', reason: 'detonated', winner: 'attack', win: true, kills: 2, plantClock: 70 };
  h.show({ ...end, tick: tick++ }, 0.2);
  h.show({ ...end, tick: tick++, done: true }, 4.3); // the run is over: the HUD hides, the line stays
  assert.equal(h.el().hidden, true);
  const line = 'Kills 2 · HS 100% · Planted at 1:10';
  assert.equal(h.ctx.__aimRoundStats.line, line);
  const rows = (box) => box.children.filter((c) => c.classList.contains('arh-result-stats'));
  // Not a round result card (a drill's): left alone.
  h.card('TARGET DRILL Score 12');
  const box = h.ctx.document.createElement('div');
  h.fire('ux-result-extra', { el: box });
  assert.equal(box.children.length, 0, 'drill card: no row');
  // No card at all: nothing.
  h.card(null);
  h.fire('ux-result-extra', { el: box });
  assert.equal(box.children.length, 0);
  // The round's card: one row with the line; a second event doesn't add another.
  h.card('Round won Spike detonated');
  h.fire('ux-result-extra', { el: box });
  assert.equal(rows(box).length, 1);
  assert.equal(rows(box)[0].textContent, line);
  h.fire('ux-result-extra', { el: box });
  assert.equal(box.children.length, 1, 'still one row');
  h.card('ROUND LOST');
  const box2 = h.ctx.document.createElement('div');
  h.fire('ux-result-extra', { el: box2 });
  assert.equal(rows(box2)[0].textContent, line, 'lost card too (case-insensitive)');
  // window.__aimUxResult.extra(): the container already up when the run ends.
  const g = statsHud();
  const box3 = g.ctx.document.createElement('div');
  g.ctx.__aimUxResult = { extra: () => box3 };
  g.card('Round lost Your team was eliminated');
  const lost = { ...live, side: 'defense', phase: 'ended', reason: 'detonated', winner: 'attack', win: false, kills: 0, plantClock: 33.5 };
  g.show({ ...live, side: 'defense', tick: 1 }, 0.1);
  g.show({ ...lost, tick: 2 }, 0.2);
  g.show({ ...lost, tick: 3, done: true }, 4.3);
  assert.equal(rows(box3)[0]?.textContent, 'Kills 0 · Enemy planted at 0:34');
  // A new round view (not ended) clears the saved line: a late event fills nothing.
  h.show({ ...live, phase: 'barrier', tick: 1 }, 10);
  assert.equal(h.ctx.__aimRoundStats.line, '');
  const box4 = h.ctx.document.createElement('div');
  h.fire('ux-result-extra', { el: box4 });
  assert.equal(box4.children.length, 0);
});
