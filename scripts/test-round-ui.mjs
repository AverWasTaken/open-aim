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
  assert.deepEqual(urls, ['/aim-rounds/ascent.nav.bin']);
  await flush();
  assert.ok(ctx.__aimRoundNav.ascent instanceof ArrayBuffer);
  assert.equal(ctx.__aimRoundPanel.navState.ascent, 'ok');
  for (const [name, fetchFn] of [['404', async () => response(null, false)], ['not RNAV', async () => response(new ArrayBuffer(16))], ['network', async () => { throw new Error('x'); }]]) {
    const c = context({ fetch: fetchFn });
    vm.runInContext(src('round-panel.js'), c);
    await flush();
    assert.equal(c.__aimRoundPanel.navState.ascent, 'missing', name);
    assert.ok(!c.__aimRoundNav?.ascent, name);
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
  ctx.__aimRoundPanel.open(); // opening retries the missing file
  await flush();
  assert.equal(fetches, 2);
  ctx.document.body.children.at(-1).querySelector('.aim-round-start').click();
  assert.equal(launches.length, 1);
  assert.equal(fetches, 2);
  // Cold: the fetch is still running -> wait for it, then launch once (a second click does nothing).
  launches = [];
  let release;
  ctx = context({ fetch: () => new Promise((r) => { release = () => r(response(rnav())); }), __aimLaunchScene: (o) => { launches.push(o); return true; } });
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
