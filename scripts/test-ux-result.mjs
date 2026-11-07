// Result screen checks (tools/ux_result_patch.py, app/ux-keys.js):
// - the patch script applies once to the unpatched game scripts, refuses a second run, and keeps
//   both copies byte-identical;
// - the record check uM, sliced out of the patched OkAdunfX.js, no longer calls a first run, a
//   0-point run or a tie a "new personal best", and shows time to kill in seconds;
// - the key logic of ux-keys.js (pure decideKey, plus install() on a tiny fake page);
// - wiring: main.js UI_SCRIPTS, package.json build files, english-fixes.js strings, hint CSS.
// Runs in node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const MODS = path.join(root, 'app', 'mods');
const DIRS = [path.join('next', 'js'), path.join('_assets', 'r20261021-1', 'next', 'js')];
const PATCH = path.join(root, 'tools', 'ux_result_patch.py');

function py(args, opts = {}) {
  return execFileSync('python', ['-I', ...args], { stdio: 'pipe', encoding: 'utf8', ...opts });
}
function runPatch(mods) {
  try { return { ok: true, out: py([PATCH, '--mods', mods]) }; }
  catch (e) { return { ok: false, out: String(e.stderr || '') + String(e.stdout || '') }; }
}
// The script's own patch tables (old/new pairs and markers), so the test can't drift from it.
const tables = JSON.parse(py(['-c',
  'import sys,json;sys.path.insert(0,sys.argv[1]);import ux_result_patch as m;' +
  'd=lambda x:x.decode("utf-8");' +
  'print(json.dumps({"patches":{n:[[d(o),d(w)] for o,w in p] for n,p in m.PATCHES.items()},' +
  '"markers":{n:d(v) for n,v in m.MARKERS.items()}}))',
  path.join(root, 'tools')]));

const count = (s, sub) => s.split(sub).length - 1;

test('patched game scripts: both copies identical, every change present once', () => {
  for (const [name, pairs] of Object.entries(tables.patches)) {
    const [a, b] = DIRS.map((d) => fs.readFileSync(path.join(MODS, d, name)));
    assert.ok(a.equals(b), `${name}: copies differ`);
    const s = a.toString('utf8');
    for (const [, now] of pairs) assert.equal(count(s, now), 1, `${name}: ${now.slice(0, 60)}`);
    assert.ok(s.includes(tables.markers[name]), `${name}: marker`);
  }
});

test('patch script: applies once to the unpatched scripts, refuses a second run', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-result-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Undo the patch on a copy (each replacement must be there exactly once).
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

// uM from the patched bundle. Its helpers are tiny; check the bundle still defines them this way.
const oka = read('app', 'mods', 'next', 'js', 'OkAdunfX.js');
assert.ok(oka.includes(',ss=e=>Math.round(e),Go=e=>typeof e=="number"&&Number.isFinite(e),'));
assert.ok(oka.includes(',Px=e=>e.scoring==="tracking";function uM('));
const UM_START = 'function uM(e,t,n,s=null,a={}){';
const umSrc = oka.slice(oka.indexOf(UM_START), oka.indexOf('}const Dx=', oka.indexOf(UM_START)) + 1);
const uM = new Function('ss', 'Go', 'Px', 'Bn', 'Lx', `${umSrc};return uM;`)(
  (e) => Math.round(e),
  (e) => typeof e === 'number' && Number.isFinite(e),
  (e) => e.scoring === 'tracking',
  {},
  () => 'good',
);
const run = (score, over = {}) => ({
  score, scoring: 'flick', accuracy: 50, avgKillTime: 420, firstShotHitRate: 60, overshootRatio: 10,
  movingShotRatio: 0, followUpHitRate: 0, humanoidHits: 0, ...over,
});
// The way Hwnlm6zD zo() calls it: recent runs with this run at the end, the previous run, the
// saved best (both read before this run was saved).
function withHistory(score, earlier, savedBest, over) {
  const me = run(score, over);
  const recent = earlier.map((v) => run(v));
  return uM(me, [...recent, me].slice(-12), recent.at(-1) ?? null, savedBest);
}

test('record check: first run is not a record', () => {
  const r = withHistory(300, [], null);
  assert.equal(r.best, null);
  assert.equal(r.isBest, false);
  assert.equal(r.deltaPrev, null);
});

test('record check: beating an old saved best outside the recent window', () => {
  const r = withHistory(500, [], 400);
  assert.equal(r.best, 400);
  assert.equal(r.isBest, true);
  assert.equal(r.pbPercent, 100);
});

test('record check: higher, tie, lower', () => {
  const up = withHistory(500, [400], 400);
  assert.equal(up.isBest, true);
  assert.equal(up.best, 400);
  const tie = withHistory(400, [400], 400);
  assert.equal(tie.isBest, false);
  assert.equal(tie.best, 400);
  assert.equal(tie.score === tie.best, true); // RunReport's tie line condition
  const down = withHistory(300, [400], 400);
  assert.equal(down.isBest, false);
  assert.equal(down.best, 400);
  assert.equal(down.pbPercent, 75);
  // Best from the recent runs when the saved best is missing.
  const recentOnly = withHistory(350, [200, 380, 100], null);
  assert.equal(recentOnly.best, 380);
  assert.equal(recentOnly.isBest, false);
});

test('record check: zero and negative scores are never a record', () => {
  const zero = withHistory(0, [0], 0);
  assert.equal(zero.best, null);
  assert.equal(zero.isBest, false);
  const zeroFirst = withHistory(0, [], null);
  assert.equal(zeroFirst.best, null);
  assert.equal(zeroFirst.isBest, false);
  const neg = withHistory(-20, [-50], -50);
  assert.equal(neg.best, null);
  assert.equal(neg.isBest, false);
  const zeroAfterBest = withHistory(0, [300], 300);
  assert.equal(zeroAfterBest.isBest, false);
  assert.equal(zeroAfterBest.best, 300);
});

test('record check: no-history path (custom scenes) has no best', () => {
  const r = uM(run(500), [], null, null);
  assert.equal(r.best, null);
  assert.equal(r.isBest, false);
});

test('time to kill shows seconds and no delta', () => {
  const r = withHistory(300, [200], 200);
  const ttk = r.stats.find((s) => s.label === '平均击杀');
  assert.equal(ttk.value, '0.42s');
  assert.equal(ttk.delta, null);
  const slow = withHistory(300, [], null, { avgKillTime: 16784 });
  assert.equal(slow.stats.find((s) => s.label === '平均击杀').value, '16.78s');
  const none = withHistory(300, [], null, { avgKillTime: 0 });
  assert.equal(none.stats.find((s) => s.label === '平均击杀').value, '—');
  // Other deltas still work.
  assert.equal(r.stats.find((s) => s.label === '命中率').delta, 0);
});

test('RunReport tie line and Target drill header are in the scripts, with English', () => {
  assert.ok(oka.includes('e.summary.isBest?(Y(),j("p",sb,"刚刚破了纪录。")):e.summary.score===e.summary.best?(Y(),j("p",{key:2},"追平了个人纪录。")):(Y(),j("p",ob,'));
  const hwn = read('app', 'mods', 'next', 'js', 'Hwnlm6zD.js');
  assert.ok(hwn.includes("cB=bf(()=>ck['value']?'小球工坊\\x20·\\x20训练完成':cf['value']?'瓦工坊\\x20·\\x20训练完成'"));
  assert.ok(hwn.includes("cm=bf(()=>ck['value']?'返回小球项目':cf['value']?'返回瓦工坊'"));
  // ck is the "Target drill" flag of ResultOverlay (workshop source, type ball).
  assert.ok(hwn.includes("ck=bf(()=>cf['value']&&cd['value']?.['workshop']?.['type']==='ball'),cm=bf(()=>ck['value']?"));
  const fixes = require(path.join(root, 'app', 'english-fixes.js'));
  assert.equal(fixes['追平了个人纪录。'], 'You tied your best.');
  assert.equal(fixes['小球工坊 · 训练完成'], 'TARGET DRILL · COMPLETE');
  assert.equal(fixes['返回小球项目'], 'Back to Target drills');
});

test('ux-keys.js is wired into main.js, the build and the theme', () => {
  const main = read('app', 'main.js');
  assert.match(main, /const UX_KEYS_JS = fs\.readFileSync\(path\.join\(__dirname, "ux-keys\.js"\), "utf-8"\);/);
  assert.match(main, /\["PAGE WATCH", PAGE_WATCH_JS\],\r?\n {2}\["UX KEYS", UX_KEYS_JS\],/);
  const pkg = JSON.parse(read('app', 'package.json'));
  assert.ok(pkg.build.files.includes('ux-keys.js'));
  assert.equal(pkg.scripts['test:result'], 'node --test ../scripts/test-ux-result.mjs');
  const css = read('app', 'theme-esports.css');
  assert.match(css, /\.al-mr-btn\[data-action=retry\]\)::before \{ content: "R";/);
  assert.match(css, /\.al-mr-btn\[data-action=exit\]\)::before \{ content: "Esc"; \}/);
});

const keys = require(path.join(root, 'app', 'ux-keys.js'));
const ev = (code, over = {}) => ({ code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, ...over });
const st = (over = {}) => ({ now: 1000, resultAt: 0, resultBusy: false, pauseOpen: false, editing: false, ...over });

test('keys: R, Esc on the result screen; Q in the Tab menu', () => {
  assert.equal(keys.decideKey(ev('KeyR'), st()), 'retry');
  assert.equal(keys.decideKey(ev('Escape'), st()), 'back');
  assert.equal(keys.decideKey(ev('KeyQ'), st({ resultAt: null, pauseOpen: true })), 'quit');
  assert.equal(keys.decideKey(ev('KeyQ'), st()), null);
  assert.equal(keys.decideKey(ev('KeyT'), st()), null);
  assert.equal(keys.decideKey(ev('KeyR'), st({ resultAt: null })), null);
  assert.equal(keys.decideKey(ev('Escape'), st({ resultAt: null, pauseOpen: true })), null);
});

test('keys: repeats, modifiers, IME and text fields are ignored', () => {
  for (const over of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    assert.equal(keys.decideKey(ev('KeyR', over), st()), null, JSON.stringify(over));
    assert.equal(keys.decideKey(ev('Escape', over), st()), null, JSON.stringify(over));
    assert.equal(keys.decideKey(ev('KeyQ', over), st({ pauseOpen: true })), null, JSON.stringify(over));
  }
  assert.equal(keys.decideKey(ev('KeyR', { shiftKey: true }), st()), 'retry');
  assert.equal(keys.decideKey(ev('KeyR'), st({ editing: true })), null);
  assert.equal(keys.decideKey(ev('KeyQ'), st({ pauseOpen: true, editing: true })), null);
});

test('keys: 600 ms guard and the card animation', () => {
  assert.equal(keys.GUARD_MS, 600);
  assert.equal(keys.decideKey(ev('KeyR'), st({ resultAt: 1000, now: 1599 })), null);
  assert.equal(keys.decideKey(ev('KeyR'), st({ resultAt: 1000, now: 1600 })), 'retry');
  assert.equal(keys.decideKey(ev('Escape'), st({ resultAt: 1000, now: 1100 })), null);
  assert.equal(keys.decideKey(ev('KeyR'), st({ resultBusy: true })), null);
  assert.equal(keys.decideKey(ev('Escape'), st({ resultBusy: true })), null);
});

test('keys: Esc and Q leave events other handlers took; R does not', () => {
  assert.equal(keys.decideKey(ev('Escape', { defaultPrevented: true }), st()), null);
  assert.equal(keys.decideKey(ev('KeyQ', { defaultPrevented: true }), st({ pauseOpen: true })), null);
  assert.equal(keys.RESPECT_PREVENTED.KeyR, false);
  assert.equal(keys.decideKey(ev('KeyR', { defaultPrevented: true }), st()), 'retry');
});

// A tiny fake page for canClick and install().
function fakeButton(over = {}) {
  const b = {
    isConnected: true, disabled: false, clicks: 0, rects: 1,
    getClientRects() { return { length: this.rects }; },
    getBoundingClientRect() { return { left: 100, top: 100, width: 100, height: 40 }; },
    contains(n) { return n === this; },
    click() { this.clicks += 1; },
    ...over,
  };
  return b;
}
function fakeDoc(map, { top = null, modals = [] } = {}) {
  return {
    documentElement: {},
    activeElement: null,
    querySelector(sel) { return map[sel] ?? null; },
    querySelectorAll(sel) { return sel === '[aria-modal="true"]' ? modals : []; },
    elementFromPoint() { return top; },
  };
}

test('canClick: on screen, enabled, on top, no modal over it', () => {
  const b = fakeButton();
  assert.equal(keys.canClick(b, fakeDoc({}, { top: b })), true);
  assert.equal(keys.canClick(null, fakeDoc({}, { top: b })), false);
  assert.equal(keys.canClick(fakeButton({ disabled: true }), fakeDoc({}, { top: b })), false);
  assert.equal(keys.canClick(fakeButton({ isConnected: false }), fakeDoc({}, { top: b })), false);
  const hidden = fakeButton({ rects: 0 });
  assert.equal(keys.canClick(hidden, fakeDoc({}, { top: hidden })), false);
  assert.equal(keys.canClick(b, fakeDoc({}, { top: {} })), false);
  const modal = { contains: () => false, getClientRects: () => ({ length: 1 }) };
  assert.equal(keys.canClick(b, fakeDoc({}, { top: b, modals: [modal] })), false);
  const hiddenModal = { contains: () => false, getClientRects: () => ({ length: 0 }) };
  assert.equal(keys.canClick(b, fakeDoc({}, { top: b, modals: [hiddenModal] })), true);
});

test('install: result time from the phase event, guard, then a click', () => {
  let clock = 0;
  const handlers = {};
  let observer = null;
  const retry = fakeButton();
  const back = fakeButton();
  const page = {};
  const doc = fakeDoc(page);
  doc.elementFromPoint = () => page.__top;
  const win = {
    document: doc,
    performance: { now: () => clock },
    addEventListener(type, fn) { handlers[type] = fn; },
    MutationObserver: class { constructor(cb) { observer = cb; } observe() {} },
  };
  keys.install(win, doc);
  keys.install(win, doc); // second call is a no-op
  const press = (code, over = {}) => {
    const e = { ...ev(code, over), target: null, prevented: false, preventDefault() { this.prevented = true; } };
    handlers.keydown(e);
    return e;
  };
  // No result: nothing happens.
  assert.equal(press('KeyR').prevented, false);
  // Result appears at t=1000.
  clock = 1000;
  handlers['aim-round-phase']({ detail: { phase: 'result', previous: 'running' } });
  page['.al-result-overlay'] = {};
  page['.al-result-overlay .al-run-actions .al-primary-btn'] = retry;
  page['.al-result-overlay .al-run-actions .al-secondary-btn'] = back;
  observer([]);
  clock = 1300;
  page.__top = retry;
  assert.equal(press('KeyR').prevented, false);
  assert.equal(retry.clicks, 0);
  clock = 1700;
  const e = press('KeyR');
  assert.equal(e.prevented, true);
  assert.equal(retry.clicks, 1);
  // Esc: back button not on top (replay viewer over it) -> nothing.
  page.__top = {};
  assert.equal(press('Escape').prevented, false);
  assert.equal(back.clicks, 0);
  page.__top = back;
  press('Escape');
  assert.equal(back.clicks, 1);
  // Next run: phase leaves result, overlay gone; then the overlay shows up without the event
  // (fallback): the guard starts from when the observer saw it.
  clock = 5000;
  handlers['aim-round-phase']({ detail: { phase: 'idle', previous: 'result' } });
  delete page['.al-result-overlay'];
  observer([]);
  clock = 9000;
  page['.al-result-overlay'] = {};
  observer([]);
  page.__top = retry;
  clock = 9100;
  press('KeyR');
  assert.equal(retry.clicks, 1);
  clock = 9700;
  press('KeyR');
  assert.equal(retry.clicks, 2);
  // Q in the Tab menu (no result showing).
  delete page['.al-result-overlay'];
  const quit = fakeButton();
  page['.al-pause-overlay .al-pause-acts .al-pause-act.is-exit'] = quit;
  page.__top = quit;
  press('KeyQ');
  assert.equal(quit.clicks, 1);
});

test('install: text field focus blocks R/Esc; an extra card button (routine bar) does not', () => {
  let clock = 0;
  const handlers = {};
  const retry = fakeButton();
  const back = fakeButton();
  const page = {
    '.al-result-overlay': {},
    '.al-result-overlay .al-run-actions .al-primary-btn': retry,
    '.al-result-overlay .al-run-actions .al-secondary-btn': back,
  };
  const doc = fakeDoc(page);
  doc.elementFromPoint = () => page.__top;
  const win = {
    document: doc,
    performance: { now: () => clock },
    addEventListener(type, fn) { handlers[type] = fn; },
    MutationObserver: class { constructor() {} observe() {} },
  };
  keys.install(win, doc);
  handlers['aim-round-phase']({ detail: { phase: 'result' } });
  clock = 2000;
  const press = (code, target) => {
    const e = { ...ev(code), target, prevented: false, preventDefault() { this.prevented = true; } };
    handlers.keydown(e);
    return e;
  };
  const input = { nodeType: 1, tagName: 'INPUT' };
  page.__top = retry;
  assert.equal(press('KeyR', input).prevented, false);
  doc.activeElement = { nodeType: 1, tagName: 'DIV', isContentEditable: true };
  page.__top = back;
  assert.equal(press('Escape', null).prevented, false);
  assert.equal(retry.clicks + back.clicks, 0);
  // Training's "Next drill" button (.tr-btn, outside .al-run-actions) has focus: R still clicks
  // the real Play again, never the focused button.
  const next = fakeButton();
  doc.activeElement = next;
  next.nodeType = 1; next.tagName = 'BUTTON';
  page.__top = retry;
  assert.equal(press('KeyR', next).prevented, true);
  assert.equal(retry.clicks, 1);
  assert.equal(next.clicks, 0);
});
