// Hit marker / kills line checks (tools/ux_hud_patch.py, app/ux-hud.js):
// - the patch script applies once to the unpatched OkAdunfX.js, refuses a second run, and keeps
//   both copies byte-identical;
// - __aimEmitHits / __aimEmitHud, sliced out of the patched bundle, turn a step's events into
//   the right aim-hit / aim-hud details (fake events, then real events from the patched sim);
// - the pure logic and the page side of ux-hud.js on a tiny fake page;
// - wiring: main.js UI_SCRIPTS, package.json build files and test script.
// Runs in node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const MODS = path.join(root, 'app', 'mods');
const DIRS = [path.join('next', 'js'), path.join('_assets', 'r20261021-1', 'next', 'js')];
const PATCH = path.join(root, 'tools', 'ux_hud_patch.py');

function py(args, opts = {}) {
  return execFileSync('python', ['-I', ...args], { stdio: 'pipe', encoding: 'utf8', ...opts });
}
function runPatch(mods) {
  try { return { ok: true, out: py([PATCH, '--mods', mods]) }; }
  catch (e) { return { ok: false, out: String(e.stderr || '') + String(e.stdout || '') }; }
}
// The script's own patch tables (old/new pairs and markers), so the test can't drift from it.
const tables = JSON.parse(py(['-c',
  'import sys,json;sys.path.insert(0,sys.argv[1]);import ux_hud_patch as m;' +
  'd=lambda x:x.decode("utf-8");' +
  'print(json.dumps({"patches":{n:[[d(o),d(w)] for o,w in p] for n,p in m.PATCHES.items()},' +
  '"markers":{n:d(v) for n,v in m.MARKERS.items()}}))',
  path.join(root, 'tools')]));

const count = (s, sub) => s.split(sub).length - 1;

test('patched OkAdunfX.js: both copies identical, every change present once', () => {
  assert.deepEqual(Object.keys(tables.patches), ['OkAdunfX.js']);
  for (const [name, pairs] of Object.entries(tables.patches)) {
    const [a, b] = DIRS.map((d) => fs.readFileSync(path.join(MODS, d, name)));
    assert.ok(a.equals(b), `${name}: copies differ`);
    const s = a.toString('utf8');
    for (const [, now] of pairs) assert.equal(count(s, now), 1, `${name}: ${now.slice(0, 60)}`);
    assert.equal(count(s, 'function __aimEmitHits('), 1);
    assert.equal(count(s, 'function __aimEmitHud('), 1);
    assert.ok(s.includes(tables.markers[name]), `${name}: marker`);
  }
});

test('patch script: applies once to the unpatched scripts, refuses a second run', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-hit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const [name, pairs] of Object.entries(tables.patches)) {
    for (const d of DIRS) {
      let s = fs.readFileSync(path.join(MODS, d, name), 'utf8');
      for (const [old, now] of pairs) {
        assert.equal(count(s, now), 1);
        s = s.replace(now, () => old);
      }
      assert.ok(!s.includes(tables.markers[name]));
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
      fs.writeFileSync(path.join(tmp, d, name), s, 'utf8');
    }
  }
  const first = runPatch(tmp);
  assert.ok(first.ok, first.out);
  for (const name of Object.keys(tables.patches)) {
    const [a, b] = DIRS.map((d) => fs.readFileSync(path.join(tmp, d, name)));
    assert.ok(a.equals(b), `${name}: copies differ after the patch`);
    assert.ok(a.equals(fs.readFileSync(path.join(MODS, DIRS[0], name))), `${name}: differs from the repo copy`);
  }
  const second = runPatch(tmp);
  assert.equal(second.ok, false);
  assert.match(second.out, /already patched/);
});

test('hooks sit where the plan says: after the recorder, inside the HUD change branch', () => {
  const oka = read('app', 'mods', 'next', 'js', 'OkAdunfX.js');
  assert.ok(oka.includes('Ou(je,Ze),Cn.push(...Ze),__aimEmitHits(Ze,Ae),at>0)for(const he of Ze)'));
  assert.ok(oka.includes('const Ae=hs(de);'));
  assert.ok(oka.includes('function ya(){if(!Ao||!Ve||!zt)return;Ao=!1;const F=Ve.result(),Z={score:Bu(F,zt),'));
  assert.ok(oka.includes('Mo&&Hu(Mo,Z)||(Mo=Z,n.onHud(Z),__aimEmitHud(Z,F))}'));
  // ge = kills, qe = targets total (null on respawning drills); both reset at run start.
  assert.ok(oka.includes('let St=!1,G=0,ge=0,qe=null,'));
  assert.ok(oka.includes('Cn=[],St=!1,G=0,ge=0,qe=Iv(F),'));
  assert.ok(oka.includes('isGridTargetHit as __aimIsGridTargetHit,hasBotHit as __aimHasBotHit,'));
  // main.js serving rewrites still find their strings.
  assert.equal(count(oka, 'xe.kind==="shot"&&(Kt.push(xe.tick*ve)'), 1);
  assert.equal(count(oka, 'const ce=hs(de);for(const xe of Cn)'), 1);
  // The replay resim never loads OkAdunfX.js.
  for (const d of DIRS) assert.ok(!fs.readFileSync(path.join(MODS, d, 'C_VPDXvn.js'), 'utf8').includes('OkAdunfX'));
});

// ---- the helpers from the patched bundle -------------------------------------------------
const grid = await import(pathToFileURL(path.join(MODS, 'aim-audio', 'grid-targets.mjs')).href);
const okaSrc = read('app', 'mods', 'next', 'js', 'OkAdunfX.js');
const helperSrc = okaSrc.slice(okaSrc.indexOf('function __aimEmitHits('), okaSrc.indexOf('function Bu(F,Z){return Dc('));
class FakeEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
function helpers({ ge = 0, qe = null, templates = new Set(), onEvent } = {}) {
  const events = [];
  const win = { dispatchEvent(e) { if (onEvent) onEvent(e); events.push(e); return true; } };
  const h = new Function('window', 'CustomEvent', 'ge', 'qe', '__aimDotTemplates', '__aimIsGridTargetHit', '__aimHasBotHit',
    `${helperSrc};return{__aimEmitHits,__aimEmitHud};`)(win, FakeEvent, ge, qe, templates, grid.isGridTargetHit, grid.hasBotHit);
  return { ...h, events };
}
const shot = (over = {}) => ({ kind: 'shot', tick: 10, hitActorId: null, hitPart: null, ...over });
const actors = [{ id: 1, templateId: 'bot' }, { id: 2, templateId: 'ball' }];
const Ae = { actors };

test('aim-hit: nothing for an empty step, misses or enemy shots', () => {
  const h = helpers();
  h.__aimEmitHits([], Ae);
  h.__aimEmitHits([shot(), { kind: 'enemyShot', tick: 10, hit: true, actorId: 1 }, { kind: 'kill', actorId: 1 }], Ae);
  h.__aimEmitHits([shot({ pellets: [{ hitActorId: null }, { hitActorId: null }] })], Ae);
  assert.equal(h.events.length, 0);
});

test('aim-hit: body, head, pellets, kill once per step, aimBlast kills ignored', () => {
  const h = helpers();
  h.__aimEmitHits([shot({ hitActorId: 1, hitPart: 'body' })], Ae);
  h.__aimEmitHits([shot({ tick: 11, hitActorId: 1, hitPart: 'head' }), { kind: 'kill', actorId: 1 }], Ae);
  h.__aimEmitHits([shot({ tick: 12, pellets: [{ hitActorId: 1, hitPart: 'body' }, { hitActorId: null }, { hitActorId: 1, hitPart: 'head' }] })], Ae);
  h.__aimEmitHits([{ kind: 'kill', actorId: 1, aimBlast: true }, shot({ tick: 13, hitActorId: 1, hitPart: 'body' })], Ae);
  // Two hitting shots in one step with one kill: the kill goes on the first only.
  h.__aimEmitHits([shot({ tick: 14, hitActorId: 1, hitPart: 'legs' }), shot({ tick: 14, hitActorId: 1, hitPart: 'body' }), { kind: 'kill', actorId: 1 }], Ae);
  assert.deepEqual(h.events.map((e) => [e.type, e.detail]), [
    ['aim-hit', { head: false, kill: false, dot: false, pellets: 1, tick: 10 }],
    ['aim-hit', { head: true, kill: true, dot: false, pellets: 1, tick: 11 }],
    ['aim-hit', { head: true, kill: false, dot: false, pellets: 2, tick: 12 }],
    ['aim-hit', { head: false, kill: false, dot: false, pellets: 1, tick: 13 }],
    ['aim-hit', { head: false, kill: true, dot: false, pellets: 1, tick: 14 }],
    ['aim-hit', { head: false, kill: false, dot: false, pellets: 1, tick: 14 }],
  ]);
  assert.ok(h.events.every((e) => !('damage' in e.detail)));
});

test('aim-hit: dot flag for ball/grid hits, not when a bot is hit too', () => {
  const h = helpers({ templates: new Set(['ball']) });
  h.__aimEmitHits([shot({ hitActorId: 2, hitPart: 'body' }), { kind: 'kill', actorId: 2 }], Ae);
  h.__aimEmitHits([shot({ pellets: [{ hitActorId: 2, hitPart: 'body' }, { hitActorId: 1, hitPart: 'head' }] })], Ae);
  assert.equal(h.events[0].detail.dot, true);
  assert.equal(h.events[0].detail.kill, true); // ux-hud.js drops the kill variant on dots
  assert.equal(h.events[1].detail.dot, false);
});

// Browsers report listener errors without throwing them back to dispatchEvent; the catch is for
// bad input (and any dispatch that does throw).
test('bad input or a throwing dispatch never escapes into the game loop', () => {
  const h = helpers({ onEvent() { throw new Error('listener'); } });
  assert.doesNotThrow(() => h.__aimEmitHits([shot({ hitActorId: 1, hitPart: 'body' })], Ae));
  assert.doesNotThrow(() => h.__aimEmitHud({ score: 1, hits: 1, shots: 1 }, { headshots: 0, humanoidHits: 0 }));
  // Broken input is swallowed too.
  const ok = helpers();
  assert.doesNotThrow(() => ok.__aimEmitHits([shot({ hitActorId: 1 })], {}));
});

test('aim-hud: kills, total, headshots, hits; a fresh object, not the HUD state', () => {
  const h = helpers({ ge: 7, qe: 10 });
  const Z = { score: 420, hits: 9, shots: 12, secondsLeft: 30, coverage: 0, smoothness: 0 };
  h.__aimEmitHud(Z, { headshots: 3, humanoidHits: 5, hits: 9 });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, 'aim-hud');
  assert.deepEqual(h.events[0].detail, { kills: 7, total: 10, headshots: 3, humanoidHits: 5, score: 420, hits: 9, shots: 12 });
  assert.notEqual(h.events[0].detail, Z);
  const respawn = helpers({ ge: 3, qe: null });
  respawn.__aimEmitHud(Z, { headshots: 0, humanoidHits: 0 });
  assert.equal(respawn.events[0].detail.total, null);
});

// ---- real events from the patched sim ----------------------------------------------------
register(pathToFileURL(path.join(root, 'scripts', 'sim-loader.mjs')).href);
globalThis.window ??= globalThis;
globalThis.self ??= globalThis;
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const sim = await import(pathToFileURL(path.join(MODS, 'next', 'js', 'CnrSARj_.js')).href);

function standDoc(shape) {
  return {
    schemaVersion: 2, meta: { id: `ux-hit-${shape}`, name: 'ux hit', seed: 3, createdAt: 0 },
    environment: { skyColor: '#111820', fogNear: 14, fogFar: 33, ambientIntensity: 1, keyLightIntensity: 1, fogEnabled: false },
    blocks: [{ id: 'ground', shape: 'plane', position: { x: 0, y: 0, z: 0 }, rotationY: 0, size: { x: 80, y: 0.4, z: 80 }, color: '#18222b', collidable: true }],
    playerSpawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    spawners: [{ id: 's1', kind: 'fixed', actorTemplateId: 't1', position: { x: 0, y: shape === 'sphere' ? 1.6 : 0, z: -8 }, size: { x: 0, y: 0, z: 0 }, maxAlive: 1, spawnDelay: [0, 0], faceTarget: true, groundSnap: shape !== 'sphere' }],
    actors: [{ id: 't1', name: 'T1', body: shape === 'sphere' ? { shape: 'sphere', radius: 0.5 } : { shape: 'humanoid', headSize: 1, bodyWidth: 0.44, bodyHeight: 0, look: 'bot', weapon: 'vandal' },
      color: '#ff4655', behaviors: [] }],
    rules: { duration: 60, scoring: 'clicking', weapon: 'vandal', playerMovable: true, fireMode: 'hold', playerDeath: 'none', buyMenu: false },
  };
}
const IDLE = { forward: 0, strafe: 0, mouseDx: 0, mouseDy: 0, jump: false, crouch: false, walk: false, fire: false };

// Taps one shot every 40 ticks, in a repeating pattern: aim low (body hit), straight (headshot,
// a one-shot kill with the Vandal), turned away (miss); the aim goes back after each tap. Every
// real step goes to __aimEmitHits the way the live tick hands it over (events + snapshot).
function sweep(doc, dotTemplates) {
  const s = sim.c(doc, { sensitivity: 1, zoomSensitivity: 1, seed: 4 });
  const h = helpers({ templates: dotTemplates });
  const steps = [];
  for (let i = 0; i < 1600; i++) {
    const tap = i > 64 && i % 40 === 0;
    const T = i % 40 === 30 ? i + 10 : i % 40 === 10 ? i - 10 : -1, kind = (T / 40) % 3, sign = i % 40 === 30 ? 1 : -1;
    const ev = s.step({ ...IDLE, fire: tap, mouseDx: T > 64 && kind === 1 ? sign * 300 : 0, mouseDy: T > 64 && kind === 2 ? sign * 60 : 0 });
    const before = h.events.length;
    h.__aimEmitHits(ev, s.snapshot());
    steps.push({ ev, out: h.events.slice(before).map((e) => e.detail) });
  }
  return steps;
}

test('real sim: one aim-hit per hitting shot, none for misses; head and kill flags match the events', (t) => {
  const steps = sweep(standDoc('humanoid'), new Set());
  let hitShots = 0, missShots = 0, heads = 0, bodies = 0, kills = 0;
  for (const { ev, out } of steps) {
    const shots = ev.filter((e) => e.kind === 'shot');
    const hitting = shots.filter((e) => (e.pellets ?? [e]).some((p) => p.hitActorId != null));
    missShots += shots.length - hitting.length;
    hitShots += hitting.length;
    assert.equal(out.length, hitting.length);
    out.forEach((d, k) => {
      const e = hitting[k];
      assert.equal(d.tick, e.tick);
      assert.equal(d.head, (e.pellets ?? [e]).some((p) => p.hitPart === 'head'));
      assert.equal(d.dot, false);
      if (d.head) heads++;
      else bodies++;
    });
    const stepKills = ev.filter((e) => e.kind === 'kill' && !e.aimBlast).length;
    if (out.length) assert.equal(out[0].kill, stepKills > 0);
    if (out[0]?.kill) kills++;
  }
  assert.ok(hitShots > 0, 'the sweep should hit the bot at least once');
  assert.ok(missShots > 0, 'the sweep should miss at least once');
  t.diagnostic(`hit shots ${hitShots}, misses ${missShots}, heads ${heads}, bodies ${bodies}, kills ${kills}`);
  assert.ok(heads > 0 && bodies > 0, 'the sweep should land head and body hits');
  assert.ok(kills > 0, 'the sweep should kill the bot at least once');
});

test('real sim: hits on a sphere target carry dot', () => {
  const steps = sweep(standDoc('sphere'), new Set(['t1']));
  const out = steps.flatMap((s) => s.out);
  assert.ok(out.length > 0, 'the sweep should hit the sphere');
  assert.ok(out.every((d) => d.dot === true));
});

// ---- ux-hud.js on a fake page ------------------------------------------------------------
function fakeEl(tag, over = {}) {
  const classes = new Set();
  const el = {
    tagName: tag, className: '', dataset: {}, style: {}, hidden: false, children: [], parentElement: null, textContent: '',
    attributes: [], offsetHeight: 0, animations: 0, isConnected: true,
    classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c), add: (c) => classes.add(c) },
    setAttribute() {}, append(c) { c.parentElement = el; el.children.push(c); }, after() {},
    animate() { el.animations++; return { cancel() {} }; },
    getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {},
    set innerHTML(v) { el._html = v; }, get innerHTML() { return el._html; },
    ...over,
  };
  return el;
}
function loadHud({ storage = {}, page = {} } = {}) {
  const listeners = {};
  const frames = [];
  const doc = {
    documentElement: fakeEl('html', { classList: { contains: (c) => !!page.roundClass && c === 'aim-round-on' } }),
    head: fakeEl('head'),
    getElementById: () => null,
    createElement: (tag) => fakeEl(tag),
    querySelector: (sel) => page[sel] ?? null,
  };
  const ctx = {
    document: doc,
    localStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = v; }, removeItem: (k) => { delete storage[k]; } },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    addEventListener: (type, f) => { (listeners[type] ??= []).push(f); },
    removeEventListener() {},
    dispatchEvent: (e) => { for (const f of listeners[e.type] ?? []) f(e); },
    Event: class { constructor(type) { this.type = type; } },
    __aimWatchPage() {},
  };
  ctx.window = ctx;
  vm.runInNewContext(read('app', 'ux-hud.js'), ctx);
  const fire = (type, detail) => { for (const f of listeners[type] ?? []) f({ type, detail }); };
  const flush = () => { while (frames.length) frames.shift()(0); };
  return { api: ctx.__aimUxHud, fire, flush, frames, storage, ctx };
}

const plain = (o) => JSON.parse(JSON.stringify(o)); // objects made inside the vm context
test('ux-hud: kills text and when the line shows', () => {
  const { api } = loadHud();
  assert.equal(api.killsText({ kills: 7, total: 10, headshots: 3, humanoidHits: 5 }), 'Kills 7/10 · HS 60%');
  assert.equal(api.killsText({ kills: 7, total: null, headshots: 1, humanoidHits: 3 }), 'Kills 7 · HS 33%');
  assert.equal(api.killsText({ kills: 0, total: 5, headshots: 0, humanoidHits: 0 }), 'Kills 0/5 · HS -');
  assert.equal(api.shouldShowKills({ kills: 0, total: 5, humanoidHits: 0 }, false), true);
  assert.equal(api.shouldShowKills({ kills: 2, total: null, humanoidHits: 4 }, false), true);
  // Ball drill: endless targets, no humanoid hits, lots of dot kills -> hidden.
  assert.equal(api.shouldShowKills({ kills: 30, total: null, headshots: 0, humanoidHits: 0 }, false), false);
  assert.equal(api.shouldShowKills({ kills: 7, total: 10, humanoidHits: 5 }, true), false); // Round
  assert.equal(api.shouldShowKills(null, false), false);
  assert.deepEqual(plain(api.markerVariant({ head: true, kill: true, dot: false })), { head: true, kill: true });
  assert.deepEqual(plain(api.markerVariant({ head: true, kill: true, dot: true })), { head: false, kill: false });
  assert.deepEqual(plain(api.markerVariant({ head: false, kill: false, dot: false })), { head: false, kill: false });
});

function page() {
  const reads = { n: 0 };
  const hud = fakeEl('div', { offsetHeight: 720, getBoundingClientRect: () => (reads.n++, { top: 100, bottom: 820, height: 720 }) });
  const chip = fakeEl('div', { getBoundingClientRect: () => ({ top: 118, bottom: 180, height: 62 }) });
  hud.querySelector = (sel) => (sel === '.al-hud-top .al-hud-chip' ? chip : null);
  const wrap = fakeEl('div');
  const cross = fakeEl('div', { parentElement: wrap });
  return { '.al-hud': hud, '.al-center-crosshair': cross, hud, wrap, reads };
}

test('ux-hud: marker only while running, one frame per batch, head/kill classes', () => {
  const p = page();
  const h = loadHud({ page: p });
  h.fire('aim-hit', { head: true, kill: false, dot: false });
  assert.equal(h.frames.length, 0, 'no frame before the run starts');
  h.fire('aim-round-phase', { phase: 'running', previous: 'idle' });
  h.flush();
  h.fire('aim-hit', { head: false, kill: false, dot: false });
  h.fire('aim-hit', { head: true, kill: true, dot: false });
  assert.equal(h.frames.length, 1, 'hits in one frame share one animation frame');
  h.flush();
  const marker = p.wrap.children.find((c) => c.className === 'ux-hitmarker');
  assert.ok(marker, 'marker sits in the crosshair wrapper');
  assert.equal(marker.animations, 1);
  assert.ok(marker.classList.contains('is-head') && marker.classList.contains('is-kill'));
  h.fire('aim-hit', { head: true, kill: true, dot: true });
  h.flush();
  assert.ok(!marker.classList.contains('is-head') && !marker.classList.contains('is-kill'), 'dot hits get the plain marker');
  h.fire('aim-round-phase', { phase: 'paused', previous: 'running' });
  h.flush();
  h.fire('aim-hit', { head: false, kill: false, dot: false });
  assert.equal(h.frames.length, 0, 'paused: ignored');
  // Setting off: ignored too.
  const off = loadHud({ page: page(), storage: { 'aim-ux-hitmarker': 'off' } });
  off.fire('aim-round-phase', { phase: 'running', previous: 'idle' });
  off.flush();
  off.fire('aim-hit', { head: false, kill: false, dot: false });
  assert.equal(off.frames.length, 0);
});

test('ux-hud: kills line under the chips on bot drills, hidden on ball drills, in Round and when paused', () => {
  const p = page();
  const h = loadHud({ page: p });
  // The game's run reset sends the first aim-hud before the phase turns "running".
  h.fire('aim-hud', { kills: 0, total: 10, headshots: 0, humanoidHits: 0, score: 0, hits: 0, shots: 0 });
  h.fire('aim-round-phase', { phase: 'running', previous: 'idle' });
  h.flush();
  const line = p.hud.children.find((c) => c.className === 'ux-hud-kills');
  assert.ok(line);
  assert.equal(line.textContent, 'Kills 0/10 · HS -', 'shows from the start of the run');
  assert.equal(line.hidden, false);
  assert.equal(line.style.top, '86px'); // chip bottom 180 - hud top 100 + 6
  h.fire('aim-hud', { kills: 2, total: 10, headshots: 1, humanoidHits: 2, score: 300, hits: 2, shots: 3 });
  h.flush();
  assert.equal(line.textContent, 'Kills 2/10 · HS 50%');
  // Stat changes that don't change the line (score, coverage...) cost no layout reads.
  const readsBefore = p.reads.n;
  h.fire('aim-hud', { kills: 2, total: 10, headshots: 1, humanoidHits: 2, score: 350, hits: 2, shots: 4 });
  h.flush();
  h.fire('aim-hud', { kills: 3, total: 10, headshots: 1, humanoidHits: 3, score: 450, hits: 3, shots: 5 });
  h.flush();
  assert.equal(p.reads.n, readsBefore, 'placed once, text updates only');
  assert.equal(line.textContent, 'Kills 3/10 · HS 33%');
  h.fire('resize');
  h.flush();
  assert.equal(p.reads.n, readsBefore + 1, 'a resize places it again');
  h.fire('aim-round-phase', { phase: 'paused', previous: 'running' });
  h.flush();
  assert.equal(line.hidden, true);
  h.fire('aim-round-phase', { phase: 'running', previous: 'paused' });
  h.flush();
  assert.equal(line.hidden, false, 'resume keeps the numbers');
  h.fire('aim-round-phase', { phase: 'result', previous: 'running' });
  h.flush();
  assert.equal(line.hidden, true);
  // Next run is a ball drill: its reset aim-hud comes first, then "running".
  h.fire('aim-hud', { kills: 0, total: null, headshots: 0, humanoidHits: 0, score: 0, hits: 0, shots: 0 });
  h.fire('aim-round-phase', { phase: 'running', previous: 'idle' });
  h.flush();
  assert.equal(line.hidden, true, 'ball drill');
  h.fire('aim-hud', { kills: 30, total: null, headshots: 0, humanoidHits: 0, score: 900, hits: 30, shots: 31 });
  h.flush();
  assert.equal(line.hidden, true, 'ball drill with dot kills');
  const r = loadHud({ page: { ...page(), roundClass: true } });
  r.fire('aim-round-phase', { phase: 'running', previous: 'idle' });
  r.fire('aim-hud', { kills: 2, total: 10, headshots: 1, humanoidHits: 2 });
  r.flush();
  const rp = r.ctx.document.querySelector('.al-hud');
  assert.ok(!rp.children.some((c) => c.className === 'ux-hud-kills' && !c.hidden), 'Round');
});

test('ux-hud.js is wired into main.js and the build', () => {
  const main = read('app', 'main.js');
  assert.match(main, /const UX_HUD_JS = fs\.readFileSync\(path\.join\(__dirname, "ux-hud\.js"\), "utf-8"\);/);
  assert.match(main, /\["UX KEYS", UX_KEYS_JS\],\r?\n {2}\["UX HUD", UX_HUD_JS\],/);
  const pkg = JSON.parse(read('app', 'package.json'));
  assert.ok(pkg.build.files.includes('ux-hud.js'));
  assert.equal(pkg.scripts['test:hit'], 'node --test ../scripts/test-ux-hit.mjs');
  const hud = read('app', 'ux-hud.js');
  assert.ok(hud.includes('[data-setting="hitBursts"]'));
  assert.ok(hud.includes('"aim-ux-hitmarker"'));
});
