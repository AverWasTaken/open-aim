// Drill card checks (ux W1-B2):
// - app/rank-picker.js on a tiny fake page: the card chip is a button that opens the picker in
//   pick-only mode; a pick there saves the drill's pick and leaves the global enemy rank
//   (localStorage "aim-enemy-rank") alone and starts nothing; the play path still sets the rank
//   and starts the drill; window.__aimRankPicker.openFor(code) works and refuses drills without
//   bots;
// - theme-esports.css hides the card code and the card-back code, and keeps the small-height
//   hero rules.
// Runs in node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const PICKER = read('app', 'rank-picker.js');

// ---- fake page ----
// Elements made by innerHTML templates are not parsed: querySelector on an element marked
// `lazy` makes (and keeps) one child per selector, which is all the picker needs.
class El {
  constructor(doc, tag, { lazy = false } = {}) {
    this.doc = doc;
    this.tagName = String(tag).toUpperCase();
    this.lazy = lazy;
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.dataset = {};
    this.attrs = {};
    this.sel = {};
    this.style = {};
    this.textContent = '';
    this._html = '';
    this.type = '';
    this.className = '';
    this.title = '';
    this.tabIndex = 0;
    this.hidden = false;
    const set = new Set();
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => { const v = on === undefined ? !set.has(c) : !!on; v ? set.add(c) : set.delete(c); return v; },
    };
  }
  set innerHTML(v) {
    this._html = String(v);
    // Plain text of the template (good enough for chip labels and aria-labels).
    this.textContent = this._html.replace(/<[^>]*>/g, '');
    this.sel = {};
  }
  get innerHTML() { return this._html; }
  get isConnected() {
    let e = this;
    while (e.parent) e = e.parent;
    return e === this.doc.body;
  }
  append(...els) { for (const e of els) { e.parent = this; this.children.push(e); } }
  appendChild(e) { this.append(e); return e; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, extra = {}) {
    let stopped = false;
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...extra };
    for (const fn of this.listeners[type] || []) fn(ev);
    return { stopped };
  }
  focus() { this.doc.activeElement = this; }
  querySelector(s) {
    if (s in this.sel) return this.sel[s];
    if (!this.lazy) return null;
    return (this.sel[s] = new El(this.doc, 'div'));
  }
  querySelectorAll() { return []; }
  closest(s) {
    for (let e = this; e; e = e.parent) if (e.matches?.(s)) return e;
    return null;
  }
}

function makePage({ rank = 'iron', picks = null, variants, cards = [] } = {}) {
  const store = new Map();
  if (rank != null) store.set('aim-enemy-rank', rank);
  if (picks != null) store.set('aim-rank-picks', JSON.stringify(picks));
  store.set('aim-favorites-merged-v1', '1');
  const winListeners = {};
  const events = [];
  const raf = [];
  const doc = { activeElement: null };
  doc.body = new El(doc, 'body');
  doc.createElement = (tag) => new El(doc, tag, { lazy: true });
  doc.querySelectorAll = (s) => (s === '.al-wk-card[data-share-code]' ? cards.map((c) => c.el) : []);
  const win = {
    document: doc,
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url) => ({
      ok: true,
      json: async () => (String(url).includes('drill-variants') ? { variants } : { scenes: {} }),
    }),
    addEventListener: (t, fn) => (winListeners[t] ||= []).push(fn),
    removeEventListener: (t, fn) => { winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn); },
    dispatchEvent: (ev) => { events.push(ev.type); },
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
    setTimeout,
    clearTimeout,
    __aimBots: {
      RANKS: [
        ['iron', 'Iron', [0.5, 0.7], 6, 0],
        ['gold', 'Gold', [0.3, 0.45], 3, 0],
        ['radiant', 'Radiant', [0.15, 0.2], 0.5, 1],
      ],
      rankOf: () => 'gold',
    },
  };
  win.window = win;
  for (const c of cards) {
    // A card: <article.al-wk-card data-share-code> with a body and a title.
    const el = new El(doc, 'article');
    el.dataset.shareCode = c.code;
    el.matches = (s) => s === '.al-wk-card[data-share-code]';
    const body = new El(doc, 'div');
    const h3 = new El(doc, 'h3');
    h3.textContent = ` ${c.name} `;
    el.append(body, h3);
    el.sel['.al-wk-body'] = body;
    el.sel.h3 = h3;
    el.querySelector = (s) => (s === ':scope .aim-rank-chip' ? body.children.find((e) => e.className === 'aim-rank-chip') || null : El.prototype.querySelector.call(el, s));
    doc.body.append(el);
    c.el = el;
    c.body = body;
  }
  const ctx = vm.createContext(win);
  vm.runInContext(PICKER, ctx, { filename: 'rank-picker.js' });
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      while (raf.length) raf.shift()();
    }
  };
  const shade = () => doc.body.children.find((e) => e.className.includes('aim-pick-shade')) || null;
  const tiles = () => {
    const s = shade();
    if (!s) return [];
    return [...s.querySelector('.aim-pick-top').children, ...s.querySelector('.aim-pick-grid').children];
  };
  const tile = (pick) => tiles().find((t) => t.dataset.pick === pick);
  const key = (k) => { for (const fn of [...(winListeners.keydown || [])]) fn({ key: k, preventDefault() {}, stopPropagation() {} }); };
  const picksNow = () => JSON.parse(store.get('aim-rank-picks') || '{}');
  return { win, ctx, doc, store, events, flush, shade, tiles, tile, key, picksNow };
}

const VARIANTS = {
  BOTS1: { code: 'BOTS1', title: 'Bot drill', item: { shareCode: 'BOTS1' }, bots: [{}], easy: { shareCode: 'EASY1' } },
  EASY1: { code: 'BOTS1', title: 'Bot drill', item: { shareCode: 'BOTS1' }, bots: [{}], easy: { shareCode: 'EASY1' } },
};
const chipOf = (card) => card.body.children.find((e) => e.className === 'aim-rank-chip') || null;

test('card chip is a button with a label', async () => {
  const cards = [{ code: 'BOTS1', name: 'Bot drill' }, { code: 'TARGETS', name: 'Targets' }];
  const p = makePage({ variants: VARIANTS, cards });
  await p.flush();
  const chip = chipOf(cards[0]);
  assert.ok(chip, 'chip added to the bot drill card');
  assert.equal(cards[0].body.children.length, 1, 'one chip, not one per redraw');
  assert.equal(chipOf(cards[1]), null, 'no chip on a drill without bots');
  assert.equal(chip.tagName, 'BUTTON');
  assert.equal(chip.type, 'button');
  assert.equal(chip.dataset.key, 'pick');
  assert.equal(chip.getAttribute('aria-label'), 'Pick enemy rank');
  assert.match(chip.title, /Click to change/);
});

test('chip opens a pick-only picker; a pick saves only this drill', async () => {
  const cards = [{ code: 'BOTS1', name: 'Bot drill' }];
  const p = makePage({ variants: VARIANTS, cards, rank: 'iron', picks: { OTHER: 'radiant' } });
  await p.flush();
  const chip = chipOf(cards[0]);
  const r = chip.fire('click');
  assert.ok(r.stopped, 'chip click does not bubble to the card');
  assert.ok(p.shade(), 'picker opened');
  assert.match(p.shade().querySelector('.es-tool-head p').textContent, /Enter saves/);
  assert.equal(p.shade().querySelector('h2').textContent, 'Bot drill');
  p.tile('gold').fire('click');
  assert.equal(p.shade(), null, 'picker closed');
  assert.equal(p.store.get('aim-enemy-rank'), 'iron', 'global enemy rank unchanged');
  assert.deepEqual(p.picksNow(), { OTHER: 'radiant', BOTS1: 'gold' });
  assert.ok(!p.events.includes('aim-bot-settings-change'), 'no bot settings change event');
  assert.equal(p.doc.activeElement, chip, 'focus goes back to the chip');
  await p.flush();
  assert.equal(chip.dataset.key, 'gold', 'chip shows the new pick');
  assert.equal(chip.dataset.rank, 'gold');
  assert.match(chip.getAttribute('aria-label'), /^Enemy rank: Gold\. Change$/);
});

test('pick-only: Enter saves the selected tile, "No return fire" starts nothing', async () => {
  const cards = [{ code: 'BOTS1', name: 'Bot drill' }];
  const p = makePage({ variants: VARIANTS, cards, rank: null });
  await p.flush();
  chipOf(cards[0]).fire('click');
  p.tile('none').focus();
  p.tile('none').fire('focus');
  p.key('Enter');
  assert.equal(p.shade(), null);
  assert.equal(p.store.get('aim-enemy-rank'), undefined, 'still no global rank');
  assert.equal(p.picksNow().BOTS1, 'none');
  // Esc closes without saving.
  chipOf(cards[0]).fire('click');
  p.tile('radiant').fire('focus');
  p.key('Escape');
  assert.equal(p.shade(), null);
  assert.equal(p.picksNow().BOTS1, 'none');
});

test('play path unchanged: the pick sets the global rank and starts the drill', async () => {
  const p = makePage({ variants: VARIANTS, rank: 'iron' });
  await p.flush();
  const started = [];
  p.win.__aimPlayGate({ shareCode: 'BOTS1', name: 'Bot drill' }, (item) => started.push(item.shareCode));
  assert.ok(p.shade());
  assert.match(p.shade().querySelector('.es-tool-head p').textContent, /Enter plays your last pick/);
  p.tile('radiant').fire('click');
  assert.deepEqual(started, ['BOTS1']);
  assert.equal(p.store.get('aim-enemy-rank'), 'radiant');
  assert.ok(p.events.includes('aim-bot-settings-change'));
  assert.equal(p.picksNow().BOTS1, 'radiant');
  // "No return fire" starts the Easy twin.
  p.win.__aimPlayGate({ shareCode: 'BOTS1' }, (item) => started.push(item.shareCode));
  p.tile('none').fire('click');
  assert.deepEqual(started, ['BOTS1', 'EASY1']);
  assert.equal(p.store.get('aim-enemy-rank'), undefined);
});

test('openFor: opens for drills with bots, refuses the rest, waits for the drill list', async () => {
  const p = makePage({ variants: VARIANTS, rank: 'gold' });
  // Before the list arrived: returns false, then opens once it is read.
  assert.equal(p.win.__aimRankPicker.openFor('BOTS1'), false);
  await p.flush();
  assert.ok(p.shade(), 'opened after the list arrived');
  p.key('Escape');
  assert.equal(p.shade(), null);
  assert.equal(typeof p.win.__aimRankPicker.openFor, 'function');
  assert.equal(p.win.__aimRankPicker.openFor('NOPE'), false);
  assert.equal(p.shade(), null);
  assert.equal(p.win.__aimRankPicker.openFor('EASY1', { name: 'x' }), true);
  p.tile('iron').fire('click');
  assert.equal(p.store.get('aim-enemy-rank'), 'gold');
  // Picks are kept under the drill's main code.
  assert.equal(p.picksNow().BOTS1, 'iron');
  // A second copy of the script does nothing (the guard keeps the first one's API).
  const api = p.win.__aimRankPicker;
  vm.runInContext(PICKER, p.ctx);
  assert.equal(p.win.__aimRankPicker, api);
});

test('theme CSS: card codes hidden, chip focus ring, small-height hero', () => {
  const css = read('app', 'theme-esports.css');
  assert.match(css, /\.al-wk-card-no[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.al-wkb-no[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /@media \(max-height: 800px\)/);
  assert.match(css, /\.aim-rank-chip:focus-visible/);
});
