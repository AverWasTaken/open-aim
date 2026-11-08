// First-run welcome banner (app/ux-welcome.js): who sees it, step state, where it goes, and that
// a page-watch sync on a correct page writes nothing. Uses its own small fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const W = require(path.join(root, 'app', 'ux-welcome.js'));

// ---- fake storage ----
function store(init = {}) {
  const data = new Map(Object.entries(init));
  const writes = [];
  return {
    data, writes,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { writes.push([k, String(v)]); data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}
const throwing = () => ({
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
});
const RUNS = JSON.stringify([{ id: 1 }]);

// ---- fake DOM ----
// Elements live in a tree under doc.root; isConnected = reachable from it. Every DOM write is
// logged in doc.writes. querySelector on the doc reads a selector -> element map.
function fakeDoc() {
  const writes = [];
  const map = new Map();
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.parent = null;
      this.children = [];
      this._className = '';
      this._html = '';
      this.attrs = {};
      this.listeners = {};
    }
    get className() { return this._className; }
    set className(v) { writes.push(['className', v]); this._className = v; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { writes.push(['innerHTML']); this._html = v; }
    setAttribute(k, v) { writes.push(['attr', k]); this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    append(c) { writes.push(['append']); c.parent = this; this.children.push(c); }
    get nextElementSibling() {
      if (!this.parent) return null;
      const s = this.parent.children;
      return s[s.indexOf(this) + 1] || null;
    }
    after(node) {
      writes.push(['after']);
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const s = this.parent.children;
      s.splice(s.indexOf(this) + 1, 0, node);
      node.parent = this.parent;
    }
    remove() {
      writes.push(['remove']);
      if (!this.parent) return;
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    get isConnected() {
      let n = this;
      while (n.parent) n = n.parent;
      return n === doc.root;
    }
    contains(n) {
      for (; n; n = n.parent) if (n === this) return true;
      return false;
    }
    // Tests can hang child stand-ins on .qs (selector -> element).
    querySelector(sel) { return (this.qs && this.qs[sel]) || null; }
  }
  const cls = new Set();
  const doc = {
    writes, map, El,
    root: new El('html'),
    activeElement: null,
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelector: (s) => map.get(s) || null,
    querySelectorAll: () => [],
    documentElement: {
      classList: {
        contains: (c) => cls.has(c),
        toggle: (c, on) => { writes.push(['class', c, on]); if (on) cls.add(c); else cls.delete(c); },
      },
    },
    classes: cls,
  };
  return doc;
}
// Lobby with a section holding the hero and the drill list.
function lobby() {
  const doc = fakeDoc();
  const hall = new doc.El('div');
  hall.parent = doc.root; doc.root.children.push(hall);
  const section = new doc.El('section');
  section.parent = hall; hall.children.push(section);
  const hero = new doc.El('header');
  const main = new doc.El('div');
  for (const c of [hero, main]) { c.parent = section; section.children.push(c); }
  doc.map.set('.hall-root', hall);
  doc.map.set(W.HERO, hero);
  doc.writes.length = 0;
  return { doc, hall, section, hero, main };
}
function fakeWin(storage, extra = {}) {
  const frames = [];
  return {
    localStorage: storage,
    innerHeight: 1080,
    frames,
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    flush() { while (frames.length) frames.shift()(); },
    console: { warn() {} },
    ...extra,
  };
}

// ---- decide ----
test('decide: new player (no key, no runs) is classified "shown" and sees it', () => {
  const s = store();
  const d = W.decide(s);
  assert.equal(d.show, true);
  assert.deepEqual(d.steps, [false, false, false]);
  assert.equal(s.data.get(W.KEY), 'shown');
});

test('decide: existing player (runs in either key) is classified "done" and never sees it', () => {
  for (const k of W.RUN_KEYS) {
    const s = store({ [k]: RUNS });
    assert.equal(W.decide(s).show, false);
    assert.equal(s.data.get(W.KEY), 'done');
    // Later calls stay hidden even if runs vanish.
    s.data.delete(k);
    assert.equal(W.decide(s).show, false);
  }
});

test('decide: truth table over key states x runs x steps', () => {
  const stepKeys = [{}, { 'al-sensitivity-v1': '0.4' }, { 'al-sensitivity-v1': '0.4', 'al-crosshair-v1': '{}' }];
  for (const runs of [false, true]) {
    for (const steps of stepKeys) {
      const base = { ...steps, ...(runs ? { 'al-workshop-runs-v1': RUNS } : {}) };
      // missing: depends on runs only (never on the sens / crosshair keys).
      const m = store(base);
      assert.equal(W.decide(m).show, !runs, `missing runs=${runs} ${JSON.stringify(steps)}`);
      assert.equal(m.data.get(W.KEY), runs ? 'done' : 'shown');
      // shown: hidden only when all three steps are done.
      const sh = store({ ...base, [W.KEY]: 'shown' });
      const all = runs && Object.keys(steps).length === 2;
      assert.equal(W.decide(sh).show, !all, `shown runs=${runs} ${JSON.stringify(steps)}`);
      assert.equal(sh.data.get(W.KEY), all ? 'done' : 'shown');
      // done: never.
      const dn = store({ ...base, [W.KEY]: 'done' });
      assert.equal(W.decide(dn).show, false);
      assert.deepEqual(dn.writes, []);
    }
  }
});

test('decide: a classified new player stays "shown" after an import writes sens + crosshair', () => {
  const s = store();
  assert.equal(W.decide(s).show, true);
  s.data.set('al-sensitivity-v1', '0.35');
  s.data.set('al-crosshair-v1', '{"color":1}');
  const d = W.decide(s);
  assert.equal(d.show, true);
  assert.deepEqual(d.steps, [true, true, false]);
  assert.equal(s.data.get(W.KEY), 'shown');
});

test('decide: bad JSON and non-arrays in the run keys count as no runs', () => {
  for (const v of ['{oops', '{"a":1}', '[]', 'null', '7']) {
    const s = store({ 'al-workshop-runs-v1': v, 'al-pw-runs-v1': v });
    assert.equal(W.decide(s).show, true, v);
    assert.equal(s.data.get(W.KEY), 'shown');
  }
});

test('decide: throwing or missing storage means no banner', () => {
  assert.equal(W.decide(throwing()).show, false);
  assert.equal(W.decide(null).show, false);
  const s = store();
  s.setItem = () => { throw new Error('quota'); };
  assert.equal(W.decide(s).show, false);
});

test('decide: "done" reads one key and nothing else (runs on every page change)', () => {
  const s = store({ [W.KEY]: 'done', 'al-workshop-runs-v1': RUNS, 'al-sensitivity-v1': '0.4' });
  const reads = [];
  const get = s.getItem;
  s.getItem = (k) => { reads.push(k); return get(k); };
  assert.equal(W.decide(s).show, false);
  assert.deepEqual(reads, [W.KEY]);
});

test('decide: Hide ("done") hides for good', () => {
  const s = store({ [W.KEY]: 'shown' });
  assert.equal(W.decide(s).show, true);
  s.setItem(W.KEY, 'done');
  assert.equal(W.decide(s).show, false);
});

// ---- stepsDone ----
test('stepsDone: each step by its key', () => {
  assert.deepEqual(W.stepsDone(store()), [false, false, false]);
  assert.deepEqual(W.stepsDone(store({ 'al-sensitivity-v1': '0.5' })), [true, false, false]);
  assert.deepEqual(W.stepsDone(store({ 'al-crosshair-v1': '{}' })), [false, true, false]);
  assert.deepEqual(W.stepsDone(store({ 'al-pw-runs-v1': RUNS })), [false, false, true]);
  assert.deepEqual(W.stepsDone(store({ 'al-workshop-runs-v1': RUNS })), [false, false, true]);
});

test('stepsDone: used buttons count (game skips saving default sens / crosshair)', () => {
  assert.deepEqual(W.stepsDone(store({ [W.STEPS_KEY]: '["sens"]' })), [true, false, false]);
  assert.deepEqual(W.stepsDone(store({ [W.STEPS_KEY]: '["crosshair"]' })), [false, true, false]);
  assert.deepEqual(W.stepsDone(store({ [W.STEPS_KEY]: '["sens","crosshair"]' })), [true, true, false]);
  assert.deepEqual(W.stepsDone(store({ [W.STEPS_KEY]: 'nope' })), [false, false, false]);
  assert.deepEqual(W.stepsDone(throwing()), [false, false, false]);
});

// ---- place ----
test('place: inserts once right after the hero, no-op when already there', () => {
  const { doc, section, hero, main } = lobby();
  const banner = doc.createElement('section');
  doc.writes.length = 0;
  assert.equal(W.place(doc, banner), true);
  assert.deepEqual(section.children, [hero, banner, main]);
  assert.equal(doc.writes.filter((w) => w[0] === 'after').length, 1);
  doc.writes.length = 0;
  assert.equal(W.place(doc, banner), true);
  assert.deepEqual(doc.writes, []);
});

test('place: re-inserts after a new hero when Vue rebuilds the lobby', () => {
  const { doc, section, hero } = lobby();
  const banner = doc.createElement('section');
  W.place(doc, banner);
  hero.remove(); banner.remove(); // Vue swaps the whole view
  const hero2 = new doc.El('header');
  hero2.parent = section; section.children.unshift(hero2);
  doc.map.set(W.HERO, hero2);
  assert.equal(banner.isConnected, false);
  assert.equal(W.place(doc, banner), true);
  assert.equal(hero2.nextElementSibling, banner);
  assert.equal(banner.isConnected, true);
});

test('place: nothing without the hero, and out while startup or a run is on the page', () => {
  const { doc } = lobby();
  const banner = doc.createElement('section');
  doc.map.delete(W.HERO);
  assert.equal(W.place(doc, banner), false);
  assert.equal(banner.isConnected, false);
  for (const blocker of ['.es-startup', '.al-aimlab-root']) {
    const l = lobby();
    const b = l.doc.createElement('section');
    assert.equal(W.place(l.doc, b), true);
    l.doc.map.set(blocker, new l.doc.El('div'));
    assert.equal(W.place(l.doc, b), false, blocker);
    assert.equal(b.isConnected, false, blocker);
    // Dialogs do not hide it.
  }
  const l = lobby();
  const b = l.doc.createElement('section');
  for (const s of ['[role=dialog]', '.hall-dialog', '.es-tool-shade']) l.doc.map.set(s, new l.doc.El('div'));
  assert.equal(W.place(l.doc, b), true);
});

// ---- controller (page-watch sync) ----
test('sync: shows the banner, sets the html class, then a sync on the correct page writes nothing', () => {
  const { doc, hero } = lobby();
  const s = store();
  const win = fakeWin(s);
  const ctl = W.createController(win, doc);
  ctl.sync([]); // page-watch.js calls with [] on pointer unlock
  ctl.sync([{ type: 'childList' }]); // batched into one frame
  assert.equal(win.frames.length, 1);
  win.flush();
  assert.equal(hero.nextElementSibling, ctl.banner);
  assert.ok(doc.classes.has(W.ON_CLASS));
  assert.equal(ctl.banner.attrs.role, 'region');
  assert.equal(ctl.banner.attrs['aria-label'], 'Getting started');
  assert.match(ctl.banner.innerHTML, /New here\? Three quick steps/);
  doc.writes.length = 0;
  s.writes.length = 0;
  ctl.sync([]);
  win.flush();
  assert.deepEqual(doc.writes, [], 'no DOM writes on a correct page');
  assert.deepEqual(s.writes, [], 'no storage writes once classified');
});

test('sync: throwing storage -> no banner', () => {
  const { doc, hero } = lobby();
  const win = fakeWin(throwing());
  const ctl = W.createController(win, doc);
  ctl.sync([]);
  win.flush();
  assert.equal(ctl.banner, null);
  assert.equal(hero.nextElementSibling?.tagName, 'DIV');
  assert.ok(!doc.classes.has(W.ON_CLASS));
});

test('sync: localStorage getter that throws -> no banner', () => {
  const { doc } = lobby();
  const win = fakeWin(null);
  Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
  const ctl = W.createController(win, doc);
  ctl.sync([]);
  win.flush();
  assert.equal(ctl.banner, null);
});

test('sync: classifies only once the lobby exists; existing players get nothing', () => {
  const { doc } = lobby();
  doc.map.delete('.hall-root');
  const s = store({ 'al-workshop-runs-v1': RUNS });
  const win = fakeWin(s);
  const ctl = W.createController(win, doc);
  ctl.sync([]); win.flush();
  assert.equal(s.data.get(W.KEY), undefined);
  doc.map.set('.hall-root', new doc.El('div'));
  ctl.sync([]); win.flush();
  assert.equal(s.data.get(W.KEY), 'done');
  assert.equal(ctl.banner, null);
});

test('sync: startup screen classifies but keeps the banner out; it appears when startup ends', () => {
  const { doc, hero } = lobby();
  doc.map.set('.es-startup', new doc.El('div'));
  const s = store();
  const win = fakeWin(s);
  const ctl = W.createController(win, doc);
  ctl.sync([]); win.flush();
  assert.equal(s.data.get(W.KEY), 'shown');
  assert.ok(!ctl.banner || !ctl.banner.isConnected);
  doc.map.delete('.es-startup');
  ctl.sync([]); win.flush();
  assert.equal(hero.nextElementSibling, ctl.banner);
});

test('sync: a run on the page takes it out and clears the html class; back in the lobby it returns', () => {
  const { doc, hero } = lobby();
  const win = fakeWin(store());
  const ctl = W.createController(win, doc);
  ctl.sync([]); win.flush();
  doc.map.set('.al-aimlab-root', new doc.El('div'));
  ctl.sync([]); win.flush();
  assert.equal(ctl.banner.isConnected, false);
  assert.ok(!doc.classes.has(W.ON_CLASS));
  doc.map.delete('.al-aimlab-root');
  ctl.sync([]); win.flush();
  assert.equal(hero.nextElementSibling, ctl.banner);
  assert.ok(doc.classes.has(W.ON_CLASS));
});

test('sync: all steps done -> "done" and the banner goes', () => {
  const { doc } = lobby();
  const s = store();
  const win = fakeWin(s);
  const ctl = W.createController(win, doc);
  ctl.sync([]); win.flush();
  assert.equal(ctl.banner.isConnected, true);
  s.data.set(W.STEPS_KEY, '["sens","crosshair"]');
  s.data.set('al-pw-runs-v1', RUNS);
  ctl.sync([]); win.flush();
  assert.equal(ctl.banner.isConnected, false);
  assert.equal(s.data.get(W.KEY), 'done');
});

test('sync: step change swaps classes only (no new markup); height change redraws', () => {
  const { doc } = lobby();
  const s = store();
  const win = fakeWin(s);
  const ctl = W.createController(win, doc);
  ctl.sync([]); win.flush();
  assert.match(ctl.banner.innerHTML, /class="ux-welcome-step is-next" data-ux-welcome-step="1"/);
  // Stand-ins for the three step items the markup created.
  const lis = [1, 2, 3].map(() => new doc.El('li'));
  lis[0]._className = 'ux-welcome-step is-next';
  lis[1]._className = lis[2]._className = 'ux-welcome-step';
  ctl.banner.qs = Object.fromEntries(lis.map((li, i) => [`[data-ux-welcome-step="${i + 1}"]`, li]));
  doc.writes.length = 0;
  s.data.set('al-sensitivity-v1', '0.3');
  ctl.sync([]); win.flush();
  assert.ok(!doc.writes.some((w) => w[0] === 'innerHTML'), 'no innerHTML on a step change');
  assert.deepEqual(lis.map((li) => li.className), ['ux-welcome-step is-done', 'ux-welcome-step is-next', 'ux-welcome-step']);
  s.data.set(W.STEPS_KEY, '["crosshair"]');
  ctl.sync([]); win.flush();
  assert.deepEqual(lis.map((li) => li.className), ['ux-welcome-step is-done', 'ux-welcome-step is-done', 'ux-welcome-step is-next']);
  win.innerHeight = 720;
  ctl.sync([]); win.flush();
  assert.ok(doc.writes.some((w) => w[0] === 'innerHTML'));
  assert.equal(ctl.banner.className, 'ux-welcome is-compact');
  assert.match(ctl.banner.innerHTML, /New here\?<\/p>/);
});

// ---- markup ----
test('render: full layout words, next step marked, import button only with the importer', () => {
  const html = W.render({ compact: false, importer: false, steps: [true, false, false] });
  for (const t of ['New here? Three quick steps', 'Set your sensitivity', 'Match your VALORANT sens, or convert from another game.',
    'Sens tools', 'Pick a crosshair', 'Paste a VALORANT crosshair code or make your own.', 'Crosshair settings',
    'Play your first drill', 'Play the drill shown at the top.', 'Play featured drill', '>Hide<']) {
    assert.ok(html.includes(t), t);
  }
  assert.ok(!html.includes('Import from VALORANT'));
  assert.ok(W.render({ compact: false, importer: true, steps: [false, false, false] }).includes('Import from VALORANT'));
  assert.match(html, /class="ux-welcome-step is-done" data-ux-welcome-step="1"/);
  assert.match(html, /class="ux-welcome-step is-next" data-ux-welcome-step="2"/);
  assert.match(html, /aria-label="Hide getting started steps"/);
  assert.ok(!/—|–/.test(html), 'no em/en dashes');
  // Never the classes other code treats as dialogs/panels/cards.
  assert.ok(!/es-tool|hall-dialog|role="dialog"|data-section|al-wk-card/.test(html));
});

test('render: compact line has three step buttons + Hide, descriptions in title/aria-describedby', () => {
  const html = W.render({ compact: true, importer: true, steps: [false, false, false] });
  assert.match(html, /New here\?/);
  for (const t of ['Set sensitivity', 'Pick a crosshair', 'Play a drill']) assert.ok(html.includes(t), t);
  assert.equal((html.match(/<button/g) || []).length, 4);
  assert.equal((html.match(/aria-describedby="ux-welcome-d\d"/g) || []).length, 3);
  assert.match(html, /title="Match your VALORANT sens, or convert from another game\."/);
  assert.ok(!html.includes('Import from VALORANT'));
});

test('sig changes with steps and layout', () => {
  const a = W.sig({ compact: false, importer: false, steps: [false, false, false] });
  assert.notEqual(a, W.sig({ compact: false, importer: false, steps: [true, false, false] }));
  assert.notEqual(a, W.sig({ compact: true, importer: false, steps: [false, false, false] }));
  assert.notEqual(a, W.sig({ compact: false, importer: true, steps: [false, false, false] }));
  assert.equal(a, W.sig({ compact: false, importer: false, steps: [false, false, false] }));
});

test('CSS: every rule scoped, tokens only, makes room at <= 800px tall', () => {
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(W.CSS.replace(/:not\(#es\)/g, '')), 'no raw hex');
  for (const line of W.CSS.split('\n').map((l) => l.trim()).filter((l) => /^[^@}].*\{/.test(l))) {
    assert.match(line, /^html\[data-aim-local\]/, line);
  }
  assert.match(W.CSS, /@media \(max-height:800px\)\{\s*html\[data-aim-local\]\.ux-welcome-on:not\(#es\) body \.al-wk-hero-copy>h1\{display:none!important\}/);
  // Never the whole hero copy: it holds the featured drill and its Play button (step 3).
  assert.ok(!/\.al-wk-hero-copy\{display:none/.test(W.CSS));
});

// ---- wiring ----
test('ux-welcome.js is wired into main.js, the build and the test scripts', () => {
  const main = read('app', 'main.js');
  assert.match(main, /const UX_WELCOME_JS = fs\.readFileSync\(path\.join\(__dirname, "ux-welcome\.js"\), "utf-8"\);/);
  assert.match(main, /\["UX RESULT", UX_RESULT_JS\],\r?\n {2}\["UX WELCOME", UX_WELCOME_JS\],/);
  const pkg = JSON.parse(read('app', 'package.json'));
  assert.ok(pkg.build.files.includes('ux-welcome.js'));
  assert.equal(pkg.scripts['test:welcome'], 'node --test ../scripts/test-ux-welcome.mjs');
});
