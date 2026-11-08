// Result card theme and container checks (app/theme-esports.css, app/ux-result.js):
// - :root has the warn token, the result block maps the game's run colours to tokens and the
//   game's teal/amber hex values are gone from the theme;
// - the five token fixes in ux blocks (difficulty, moment gold, moment pass/time dots, verdict
//   splash) use tokens and no raw hex;
// - ux-result.js places one container on a fake page: above the buttons, or above feel's shot
//   summary when that sits right above the buttons; never twice, never moved, re-placed after
//   the result is rebuilt, one event per insert;
// - wiring: main.js UI_SCRIPTS, package.json build files and test script.
// Runs in node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const css = read('app', 'theme-esports.css');
const P = 'html[data-aim-local]:not(#es) body ';
// A hex colour not followed by more hex digits (8-digit values like #ff465544 exist).
const hex = (h) => new RegExp(h + '(?![0-9a-fA-F])', 'i');
const anyHex = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;

// The declaration block of the rule whose selector is exactly `sel` (first match).
function rule(sel) {
  const i = css.indexOf(sel + ' {');
  assert.ok(i >= 0, `rule not found: ${sel}`);
  const open = css.indexOf('{', i + sel.length);
  return css.slice(open + 1, css.indexOf('}', open));
}
// A custom-property line inside a block (e.g. "  --mr-gold: ...;").
function propLine(name) {
  const m = css.match(new RegExp(`^\\s*${name.replace(/[-]/g, '\\-')}:[^;]*;`, 'm'));
  assert.ok(m, `property not found: ${name}`);
  return m[0];
}

test('theme: :root defines the warn token right after --es-green', () => {
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  assert.match(rootBlock, /--es-green: #4ade80;\r?\n {2}--es-warn: #ffd166;/);
});

test('theme: result block maps the run colours to tokens; no game teal/amber left', () => {
  const body = rule(P + '.al-run-body');
  assert.match(body, /--run-good: var\(--es-green\);/);
  assert.match(body, /--run-signal: var\(--es-warn\);/);
  assert.match(body, /--run-bad: var\(--es-red\);/);
  assert.match(body, /--run-dim: var\(--es-muted\);/);
  assert.match(body, /--run-muted: var\(--es-muted\);/);
  assert.doesNotMatch(body, /--run-line|background/);
  for (const h of ['#5ad1a0', '#ffb84d', '#ffd28a']) assert.doesNotMatch(css, hex(h), `${h} still in theme-esports.css`);
  // best-score bar: solid warn via the background shorthand (drops the game's gradient)
  assert.match(rule(P + '.al-run-pb-track i'), /^\s*background: var\(--es-warn\);\s*$/);
  assert.match(rule(P + ':is(.al-run-delta b, .al-run-pb-track, .al-run-pb-track i, .al-bots-card-map, .al-bots-card-list li.is-killer b)'), /border-radius: 0;/);
  assert.match(rule(P + '.al-run-legend > span:not(.is-acc)::before'), /border-top-color: var\(--es-red\);/);
  assert.match(rule(P + '.al-run-tier.is-good'), /color: var\(--es-soft\);/);
  assert.match(rule(P + '.al-result-verdict'), /--verdict: var\(--es-muted\);/);
  assert.match(rule(P + '.al-result-verdict.is-cleared'), /--verdict: var\(--es-green\);/);
  assert.match(rule(P + '.al-result-verdict.is-time'), /--verdict: var\(--es-warn\);/);
  assert.match(rule(P + '.al-result-verdict.is-died'), /--verdict: var\(--es-red\);/);
  const guide = rule(P + '.al-result-guide-btn');
  for (const d of ['border: none;', 'border-left: 3px solid transparent;', 'border-radius: 0;', 'background: var(--es-raised-2);', 'text-transform: uppercase;', 'font-weight: 700;', 'font-stretch: 75%;']) assert.ok(guide.includes(d), d);
  assert.match(rule(P + '.al-result-guide-btn:hover'), /border-left-color: var\(--es-red\);/);
  assert.match(rule(P + '.al-bots-card.is-side h3 b'), /color: var\(--es-text\);/);
  assert.match(rule(P + '.al-run-strip b'), /font-variant-numeric: tabular-nums;/);
  const cap = rule(P + ':is(.al-run-strip span, .al-run-pb-label, .al-run-chart-top)');
  for (const d of ['font-size: 11px;', 'text-transform: uppercase;', 'letter-spacing: 0.06em;', 'color: var(--es-muted);']) assert.ok(cap.includes(d), d);
  assert.match(rule(P + '.ux-result-extra'), /display: flex; flex-direction: column; gap: 8px; padding: 12px 26px;/);
  assert.match(rule(P + '.ux-result-extra:empty'), /display: none;/);
});

test('theme: the five ux token fixes use tokens and no raw hex', () => {
  const lines = [
    [propLine('--aim-difficulty'), 'var(--es-warn)'],
    [propLine('--mr-gold'), 'var(--es-warn)'],
    [rule(P + '.al-mr.is-pass .al-mr-verdict b::before'), 'var(--es-green)'],
    [rule(P + '.al-mr.is-time .al-mr-verdict b::before'), 'var(--es-warn)'],
    [rule(P + '.al-result-verdict-splash.is-time'), 'var(--es-warn)'],
  ];
  for (const [text, token] of lines) {
    assert.ok(text.includes(token), `${text.trim()} should use ${token}`);
    assert.doesNotMatch(text, anyHex, `${text.trim()} has a raw hex`);
  }
  for (const h of ['#ffd23f', '#ffcf5a', '#1fa463', '#c98a1c']) assert.doesNotMatch(css, hex(h));
});

// ---- ux-result.js on a fake page --------------------------------------------------------
// Tiny DOM: elements with classes, children, parent links; the document answers the two
// selectors ux-result.js uses.
function el(cls, kids = []) {
  const e = {
    nodeType: 1, className: cls, children: [], parentElement: null,
    classList: { contains: (c) => e.className.split(/\s+/).includes(c) },
    get previousElementSibling() {
      const p = e.parentElement; if (!p) return null;
      const i = p.children.indexOf(e); return i > 0 ? p.children[i - 1] : null;
    },
    append(...cs) { for (const c of cs) { c.parentElement = e; e.children.push(c); } },
    insertBefore(c, ref) {
      if (c.parentElement) c.parentElement.children.splice(c.parentElement.children.indexOf(c), 1);
      const i = e.children.indexOf(ref); assert.ok(i >= 0, 'insertBefore ref must be a child');
      c.parentElement = e; e.children.splice(i, 0, c);
    },
    remove() { if (e.parentElement) e.parentElement.children.splice(e.parentElement.children.indexOf(e), 1); e.parentElement = null; },
  };
  e.append(...kids);
  return e;
}
function walk(n, f) { for (const c of n.children) { if (f(c)) return c; const r = walk(c, f); if (r) return r; } return null; }
function hasAncestor(n, cls) { for (let p = n.parentElement; p; p = p.parentElement) if (p.classList.contains(cls)) return true; return false; }
function fakeDoc() {
  const body = el('body');
  const doc = {
    body, queries: 0, created: 0,
    createElement: () => { doc.created++; return el(''); },
    querySelector(sel) {
      doc.queries++;
      if (sel === '.al-result-overlay') return walk(body, (n) => n.classList.contains('al-result-overlay'));
      if (sel === '.al-result-overlay .al-run-body > .al-run-actions') {
        return walk(body, (n) => n.classList.contains('al-run-actions') && n.parentElement?.classList.contains('al-run-body') && hasAncestor(n, 'al-result-overlay'));
      }
      throw new Error('unexpected selector ' + sel);
    },
  };
  return doc;
}
function resultPage(doc, { shot = false, actions = true } = {}) {
  const runBody = el('al-run-body', [el('al-run-hero'), el('al-run-strip')]);
  if (shot) runBody.append(el('es-shotgraph-sum'));
  if (actions) runBody.append(el('al-run-actions'));
  const overlay = el('al-result-overlay', [el('al-result-modal', [runBody])]);
  doc.body.append(overlay);
  return { overlay, runBody };
}
const names = (n) => n.children.map((c) => c.className);
const ux = require(path.join(root, 'app', 'ux-result.js'));

test('ux-result: one container right above the buttons; second call does nothing', () => {
  const doc = fakeDoc();
  const { runBody } = resultPage(doc);
  const made = ux.place(doc);
  assert.ok(made);
  assert.equal(made.className, 'ux-result-extra');
  assert.equal(made.children.length, 0, 'no text or children inside (keeps :empty working)');
  assert.deepEqual(names(runBody), ['al-run-hero', 'al-run-strip', 'ux-result-extra', 'al-run-actions']);
  assert.equal(ux.place(doc), null);
  assert.deepEqual(names(runBody), ['al-run-hero', 'al-run-strip', 'ux-result-extra', 'al-run-actions']);
  assert.equal(ux.current(doc), made);
});

test('ux-result: nothing without a result, or without the run buttons', () => {
  const doc = fakeDoc();
  assert.equal(ux.place(doc), null);
  assert.equal(doc.queries, 1, 'only the cheap overlay check runs when no result shows');
  const { runBody } = resultPage(doc, { actions: false });
  assert.equal(ux.place(doc), null);
  assert.deepEqual(names(runBody), ['al-run-hero', 'al-run-strip']);
  assert.equal(doc.created, 0);
});

test('ux-result: goes above feel\'s shot summary; feel inserting later keeps the order', () => {
  const doc = fakeDoc();
  const { runBody } = resultPage(doc, { shot: true });
  ux.place(doc);
  assert.deepEqual(names(runBody), ['al-run-hero', 'al-run-strip', 'ux-result-extra', 'es-shotgraph-sum', 'al-run-actions']);
  // feel's panel arrives after the container (feel inserts right before the buttons)
  const doc2 = fakeDoc();
  const r2 = resultPage(doc2);
  const made = ux.place(doc2);
  const actions = r2.runBody.children.at(-1);
  r2.runBody.insertBefore(el('es-shotgraph-sum'), actions);
  assert.equal(ux.place(doc2), null, 'existing container is never moved');
  assert.deepEqual(names(r2.runBody), ['al-run-hero', 'al-run-strip', 'ux-result-extra', 'es-shotgraph-sum', 'al-run-actions']);
  assert.equal(r2.runBody.children[2], made);
});

test('ux-result: install() fires one event per insert and places again after a rebuild', () => {
  const doc = fakeDoc();
  const events = [];
  let watcher = null;
  const win = {
    document: doc,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent: (e) => { events.push(e); return true; },
    __aimWatchPage: (cb, opts) => { watcher = cb; assert.deepEqual(opts, { childList: true, subtree: true }); },
  };
  ux.install(win, doc);
  assert.equal(typeof watcher, 'function');
  assert.equal(win.__aimUxResult.extra(), null);
  assert.equal(events.length, 0);
  const first = resultPage(doc);
  watcher([]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ux-result-extra');
  assert.equal(events[0].detail.el, first.runBody.children[2]);
  assert.equal(win.__aimUxResult.extra(), events[0].detail.el);
  watcher([]); watcher([]);
  assert.equal(events.length, 1, 'no event on a no-op');
  // the game replaces the result overlay (play again, next run)
  first.overlay.remove();
  watcher([]);
  assert.equal(win.__aimUxResult.extra(), null);
  const second = resultPage(doc);
  watcher([]);
  assert.equal(events.length, 2);
  assert.equal(events[1].detail.el, second.runBody.children[2]);
  assert.notEqual(events[1].detail.el, events[0].detail.el);
  // a second install is ignored
  const before = win.__aimUxResult;
  ux.install(win, doc);
  assert.equal(win.__aimUxResult, before);
});

test('ux-result.js runs as an injected script (no module) and installs once', () => {
  const doc = fakeDoc();
  resultPage(doc);
  const events = [];
  const ctx = {
    document: doc,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent: (e) => { events.push(e); return true; },
    __aimWatchPage() {},
  };
  vm.runInNewContext(read('app', 'ux-result.js'), ctx);
  assert.equal(events.length, 1, 'places on load when the result already shows');
  assert.equal(typeof ctx.__aimUxResult.extra, 'function');
});

test('ux-result.js is wired into main.js, the build and the test scripts', () => {
  const main = read('app', 'main.js');
  assert.match(main, /const UX_RESULT_JS = fs\.readFileSync\(path\.join\(__dirname, "ux-result\.js"\), "utf-8"\);/);
  assert.match(main, /\["UX HUD", UX_HUD_JS\],\r?\n {2}\["UX RESULT", UX_RESULT_JS\],/);
  const pkg = JSON.parse(read('app', 'package.json'));
  assert.ok(pkg.build.files.includes('ux-result.js'));
  assert.equal(pkg.scripts['test:theme'], 'node --test ../scripts/test-ux-result-theme.mjs');
});
