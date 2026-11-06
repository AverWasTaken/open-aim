// Checks for the desktop shell's guards: URL paths that try to leave the served folders,
// requests and IPC calls from outside the game, and backup ids that aren't backups.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const appDir = path.join(__dirname, '..', 'app');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-guard-test-'));
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));

// backups.js and studio-store.js need Electron's app paths; a stand-in keeps them in a temp folder.
const electronId = require.resolve('electron', { paths: [appDir] });
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true,
  exports: { app: { getPath: (name) => path.join(profile, name === 'appData' ? '' : 'AimTrainer') } } };

const { isLocalUrl, isLocalHost, fromLocalPage, safeJoin } = require('../app/local-guard');
const backups = require('../app/backups');
const studio = require('../app/studio-store');
const PORT = 8000;

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}
const frame = (url) => ({ senderFrame: url === null ? null : { url } });

test('safeJoin keeps paths inside the folder', () => {
  const base = path.join(profile, 'site');
  assert.equal(safeJoin(base, '/aim/index.html'), path.join(base, 'aim', 'index.html'));
  assert.equal(safeJoin(base, '/a//b/./c.js'), path.join(base, 'a', 'b', 'c.js'));
  assert.equal(safeJoin(base, '/'), path.resolve(base));
  assert.equal(safeJoin(base, ''), path.resolve(base));
  for (const bad of ['/../package.json', '/a/../../x', '/..\\package.json', '/\\..\\app\\main.js',
    '/x\\..\\..\\y', '/C:/Windows/win.ini', '/c:', '/a\0b', '/studio/..\\..\\main.js']) {
    assert.equal(safeJoin(base, bad), null, bad);
  }
});

test('local URLs, hosts and pages', () => {
  assert.ok(isLocalUrl('http://localhost:8000/aim', PORT));
  assert.ok(isLocalUrl('http://127.0.0.1:8000/studio/', PORT));
  assert.ok(!isLocalUrl('http://localhost:8001/aim', PORT));
  assert.ok(!isLocalUrl('https://example.com/', PORT));
  assert.ok(!isLocalUrl('not a url', PORT));
  assert.ok(isLocalHost('localhost:8000', PORT));
  assert.ok(isLocalHost('127.0.0.1:8000', PORT));
  for (const bad of [undefined, '', 'localhost', 'evil.example:8000', 'localhost:8001', 'localhost:8000.evil.example']) {
    assert.ok(!isLocalHost(bad, PORT), String(bad));
  }
  assert.ok(fromLocalPage(frame('http://localhost:8000/aim'), PORT));
  assert.ok(fromLocalPage(frame('http://127.0.0.1:8000/studio/#edit=1'), PORT));
  for (const bad of [null, '', 'about:blank', 'https://localhost:8000/aim', 'http://localhost:9999/', 'file:///C:/x.html', 'http://evil.example:8000/']) {
    assert.ok(!fromLocalPage(frame(bad), PORT), String(bad));
  }
  assert.ok(!fromLocalPage({}, PORT));
  assert.ok(!fromLocalPage(undefined, PORT));
});

test('backup ids must be existing backups', () => {
  const root = path.join(profile, 'AimTrainer-Backups');
  const id = '2026-11-05_10-00-00 manual';
  fs.mkdirSync(path.join(root, id, 'Local Storage'), { recursive: true });
  fs.mkdirSync(path.join(root, '2026-11-05_10-00-01 empty'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'outside', 'Local Storage'), { recursive: true });
  assert.equal(backups.backupDir(id), path.join(root, id));
  for (const bad of ['', '.', '..', '../outside', '..\\outside', 'nope', '2026-11-05_10-00-01 empty', path.join(profile, 'outside'), undefined, 42]) {
    assert.equal(backups.backupDir(bad), null, String(bad));
  }
});

test('backup IPC refuses other pages before doing anything', async () => {
  const ipc = fakeIpc();
  backups.register(ipc, () => null, (e) => fromLocalPage(e, PORT));
  const pending = path.join(profile, 'AimTrainer-Backups', 'restore-pending.json');
  for (const channel of ['aim:backups:list', 'aim:backups:create', 'aim:backups:restore', 'aim:backups:open', 'aim:backups:export', 'aim:backups:import']) {
    for (const event of [frame(null), frame('https://evil.example/'), frame('http://localhost:9999/')]) {
      await assert.rejects(async () => ipc.handlers.get(channel)(event, '2026-11-05_10-00-00 manual'), /only available in the trainer/, channel);
    }
  }
  assert.ok(!fs.existsSync(pending));
  const list = await ipc.handlers.get('aim:backups:list')(frame('http://localhost:8000/aim'));
  assert.deepEqual(list.map((b) => b.id), ['2026-11-05_10-00-00 manual']);
  await assert.rejects(async () => ipc.handlers.get('aim:backups:restore')(frame('http://localhost:8000/aim'), '../outside'), /missing its data/);
  await assert.rejects(async () => ipc.handlers.get('aim:backups:export')(frame('http://localhost:8000/aim'), '..\\outside'), /missing its data/);
  assert.ok(!fs.existsSync(pending));
  // A registration without a check refuses everything.
  const open = fakeIpc();
  backups.register(open, () => null);
  await assert.rejects(async () => open.handlers.get('aim:backups:list')(frame('http://localhost:8000/aim')), /only available/);
});

test('Studio IPC refuses other pages and writes drills whole', async () => {
  const ipc = fakeIpc();
  studio.register(ipc, (e) => fromLocalPage(e, PORT));
  const drills = path.join(profile, 'AimTrainer', 'studio-drills');
  const doc = { schemaVersion: 2, meta: { name: 'Rec' }, rules: { studioRecord: true } };
  for (const channel of ['aim:studio:list', 'aim:studio:save', 'aim:studio:record', 'aim:studio:remove', 'aim:studio:saveRun']) {
    await assert.rejects(async () => ipc.handlers.get(channel)(frame('https://evil.example/'), { doc }), /only available in the trainer/, channel);
    await assert.rejects(async () => ipc.handlers.get(channel)(frame(null), { doc }), /only available in the trainer/, channel);
  }
  assert.ok(!fs.existsSync(drills));
  const local = frame('http://localhost:8000/studio/');
  assert.deepEqual(await ipc.handlers.get('aim:studio:record')(local, { doc }), { code: '00000000000000c0' });
  assert.equal(studio.recording().item.name, 'Rec');
  const saved = await ipc.handlers.get('aim:studio:save')(local, { drill: { name: 'D' }, doc: { schemaVersion: 2, meta: {} }, type: 'aim' });
  assert.equal(studio.all().length, 1);
  const run = await ipc.handlers.get('aim:studio:saveRun')(local, { name: 'R', track: { hz: 60, secs: 1, p: [0, 0, 0, 0, 0, 0] } });
  assert.equal((await ipc.handlers.get('aim:studio:renameRun')(local, { id: run.id, name: 'R2' })).name, 'R2');
  const leftovers = [drills, path.join(drills, 'recording'), path.join(profile, 'AimTrainer', 'studio-runs')]
    .flatMap((d) => fs.readdirSync(d)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.ok(saved.code);
});
