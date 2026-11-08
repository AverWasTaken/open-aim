// app/training-launch.js in node:vm with a mocked fetch and a mocked window.__aimLaunchWorkshop:
// window.__aimLaunchByCode(code, extra) finds the full item (training list first, then the
// drill-variants twins), hands it to the hook and never throws. Also checks it is wired into
// app/main.js (UI_SCRIPTS) and app/package.json (build.files).
// Run: node --test scripts/test-training-launch.mjs   (npm run test:training-hooks in app/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(root, 'app', 'training-launch.js'), 'utf-8');
const LIST = '/prod-api/api/v1/public/val/aimlab/workshop';
const VARIANTS = '/aim/drill-variants.json';

const official = { shareCode: '5a9e43d609bbb3a3', name: "Boaster's flick drill (hard)", description: 'official', type: 'hold', mapId: null };
const trainingSet = { shareCode: 'e3c17ccb9f5a1500', name: 'Micro flicks', description: 'training set', type: 'ball', mapId: null };
const hard = { shareCode: 'c935a7a37b985842', name: '困难-Ascent B retake from Mid', description: 'hard', type: 'aim', mapId: 'ascent' };
const easy = { shareCode: '54145a349a983de4', name: '简单-Ascent B retake from Mid', description: 'easy', type: 'aim', mapId: 'ascent' };
const older = 'aaaaaaaaaaaaaaaa';
const group = { code: hard.shareCode, title: 'Ascent B retake from Mid', item: hard, easy, bots: [{}] };

// The served list leaves out Easy twins and older copies (app/main.js serves merged.data).
function server(over = {}) {
  const state = {
    list: { code: '00000', data: [official, trainingSet, hard], msg: '', local: true },
    variants: { variants: { [hard.shareCode]: group, [easy.shareCode]: group, [older]: group } },
    calls: [],
    fail: null,
    ...over,
  };
  state.fetch = async (url, opts) => {
    state.calls.push({ url, opts });
    if (state.fail && state.fail(url)) throw new Error('network down');
    const body = url === LIST ? state.list : url === VARIANTS ? state.variants : null;
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  return state;
}

function load({ srv = server(), hook = 'ok' } = {}) {
  const launched = [];
  // Items cross the vm realm boundary, so they are compared as plain JSON copies.
  const win = { console: { warn() {}, log() {}, error() {} }, fetch: (...a) => srv.fetch(...a) };
  if (hook === 'ok') win.__aimLaunchWorkshop = (item) => { launched.push(JSON.parse(JSON.stringify(item))); return true; };
  if (hook === 'refuse') win.__aimLaunchWorkshop = (item) => { launched.push(JSON.parse(JSON.stringify(item))); return false; };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  return { win, launched, srv };
}

test('official code launches the full catalogue item', async () => {
  const { win, launched, srv } = load();
  assert.equal(await win.__aimLaunchByCode(official.shareCode), true);
  assert.deepEqual(launched, [official]);
  assert.ok(srv.calls.every((c) => c.opts && c.opts.cache === 'no-cache'), 'fetches use cache no-cache');
});

test('training-set code that was never played resolves (e3c17ccb9f5a1500)', async () => {
  const { win, launched } = load();
  assert.equal(await win.__aimLaunchByCode('e3c17ccb9f5a1500'), true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].shareCode, 'e3c17ccb9f5a1500');
  assert.equal(launched[0].type, 'ball');
});

test('Easy twin code (only in drill-variants) launches the Easy item, not the card', async () => {
  const { win, launched } = load();
  assert.equal(await win.__aimLaunchByCode(easy.shareCode), true);
  assert.deepEqual(launched, [easy]);
});

test('hidden older copy code launches the card item', async () => {
  const { win, launched } = load();
  assert.equal(await win.__aimLaunchByCode(older), true);
  assert.deepEqual(launched, [hard]);
});

test('unknown code resolves false, refetches once, hook not called', async () => {
  const { win, launched, srv } = load();
  assert.equal(await win.__aimLaunchByCode(official.shareCode), true);
  const before = srv.calls.length;
  assert.equal(await win.__aimLaunchByCode('ffffffffffffffff'), false);
  assert.equal(srv.calls.length - before, 2, 'one refetch of both lists on a miss');
  assert.equal(launched.length, 1);
});

test('lists are cached for the page session', async () => {
  const { win, srv } = load();
  await win.__aimLaunchByCode(official.shareCode);
  await win.__aimLaunchByCode(trainingSet.shareCode);
  await win.__aimLaunchByCode(easy.shareCode);
  assert.equal(srv.calls.length, 2);
});

test('a code added after the first fetch is found by the refetch', async () => {
  const srv = server();
  const { win, launched } = load({ srv });
  await win.__aimLaunchByCode(official.shareCode);
  const studio = { shareCode: 'studio00000000aa', name: 'My drill', type: 'ball' };
  srv.list = { ...srv.list, data: [...srv.list.data, studio] };
  assert.equal(await win.__aimLaunchByCode(studio.shareCode), true);
  assert.equal(launched[1].shareCode, studio.shareCode);
});

test('fetch failure resolves false and a later call retries', async () => {
  const srv = server({ fail: () => true });
  const { win, launched } = load({ srv });
  assert.equal(await win.__aimLaunchByCode(official.shareCode), false);
  srv.fail = null;
  assert.equal(await win.__aimLaunchByCode(official.shareCode), true);
  assert.equal(launched.length, 1);
});

test('variants fetch failure resolves false (never throws)', async () => {
  const { win } = load({ srv: server({ fail: (u) => u === VARIANTS }) });
  assert.equal(await win.__aimLaunchByCode(official.shareCode), false);
});

test('bad response shapes resolve false', async () => {
  const { win } = load({ srv: server({ list: { data: null }, variants: { variants: null } }) });
  assert.equal(await win.__aimLaunchByCode(official.shareCode), false);
});

test('no hook resolves false', async () => {
  const { win } = load({ hook: 'none' });
  assert.equal(await win.__aimLaunchByCode(official.shareCode), false);
});

test('hook refusing (drill open) resolves false', async () => {
  const { win, launched } = load({ hook: 'refuse' });
  assert.equal(await win.__aimLaunchByCode(official.shareCode), false);
  assert.equal(launched.length, 1);
});

test('bad code resolves false without fetching', async () => {
  const { win, srv } = load();
  for (const c of [undefined, null, '', 42, {}]) assert.equal(await win.__aimLaunchByCode(c), false);
  assert.equal(srv.calls.length, 0);
});

test('extra: name/description win only when given; other fields ignored; cache not mutated', async () => {
  const { win, launched } = load();
  await win.__aimLaunchByCode(official.shareCode, { description: 'Step 2 of 3' });
  await win.__aimLaunchByCode(official.shareCode, { name: 'Warm-up', description: null, type: 'flash', shareCode: 'x' });
  await win.__aimLaunchByCode(official.shareCode);
  assert.deepEqual(launched[0], { ...official, description: 'Step 2 of 3' });
  assert.deepEqual(launched[1], { ...official, name: 'Warm-up' });
  assert.deepEqual(launched[2], official);
});

test('installs once (guard)', () => {
  const { win } = load();
  const fn = win.__aimLaunchByCode;
  vm.runInContext(SRC, win);
  assert.equal(win.__aimLaunchByCode, fn);
});

test('wired into main.js UI_SCRIPTS and package.json build.files', () => {
  const main = fs.readFileSync(path.join(root, 'app', 'main.js'), 'utf-8');
  assert.match(main, /const TRAINING_LAUNCH_JS = fs\.readFileSync\(path\.join\(__dirname, "training-launch\.js"\), "utf-8"\);/);
  const list = main.slice(main.indexOf('const UI_SCRIPTS = ['), main.indexOf('];', main.indexOf('const UI_SCRIPTS = [')));
  assert.ok(list.includes('["TRAINING LAUNCH", TRAINING_LAUNCH_JS]'), 'listed in UI_SCRIPTS');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf-8'));
  assert.ok(pkg.build.files.includes('training-launch.js'), 'listed in build.files');
});
