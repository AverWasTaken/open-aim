// Checks for the desktop shell's hardening: the UI script batch parses, every file main.js
// loads ships in the build, AIM_PORT/headless checks, the startup backup steps, and the log file
// (writing, rotation, crash reloads, page-error limit).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const appDir = path.join(__dirname, '..', 'app');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-shell-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// backups.js needs Electron's app paths; a stand-in keeps them in a temp folder.
const profile = path.join(tmp, 'profile');
const relaunches = [];
const pickers = [];
const ipcHandlers = new Map();
const electronId = require.resolve('electron', { paths: [appDir] });
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: {
  app: {
    getPath: (name) => path.join(profile, name === 'appData' ? '' : 'AimTrainer'),
    relaunch: (opts) => relaunches.push(opts),
    quit: () => {},
  },
  dialog: { showOpenDialog: async (...args) => { pickers.push(args); return { canceled: true, filePaths: [] }; } },
  ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
} };

const backups = require('../app/backups');
const { parsePort, readTestEnv } = require('../app/shell-env');
const { createLog } = require('../app/shell-log');
const valorantIpc = require('../app/valorant-import-ipc');

// CRLF checkouts (.gitattributes text=auto) read the same as LF ones.
const mainSrc = fs.readFileSync(path.join(appDir, 'main.js'), 'utf-8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
const shipped = (file) => pkg.build.files.some((f) => f === file
  || (f.endsWith('/**/*') && file.startsWith(f.slice(0, -'**/*'.length))));

// The declaration statement of `const NAME =` in main.js (up to the next ";" at a line end).
function declaration(name) {
  const start = mainSrc.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `main.js has no const ${name}`);
  const end = mainSrc.indexOf(';\n', start);
  return mainSrc.slice(start, end + 1);
}
const jsFiles = (text) => [...text.matchAll(/["']([\w.-]+\.js)["']/g)].map((m) => m[1]);

// The UI_SCRIPTS entries: [label, CONST] pairs, each CONST read from one or more files.
function uiScripts() {
  const decl = declaration('UI_SCRIPTS');
  const pairs = [...decl.matchAll(/\[\s*"([^"]+)"\s*,\s*([A-Z0-9_]+)\s*\]/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 10, `UI_SCRIPTS: only ${pairs.length} entries found`);
  return pairs.map(([label, name]) => {
    const files = jsFiles(declaration(name));
    assert.ok(files.length > 0, `${label}: no .js file found in "const ${name} = ..."`);
    return { label, name, files };
  });
}
const readApp = (file) => fs.readFileSync(path.join(appDir, file), 'utf-8').replace(/\r\n/g, '\n');

test('the UI script batch and the startup screen parse', () => {
  const scripts = uiScripts();
  // Built the same way as UI_SCRIPT_BATCH / STARTUP_SCREEN_RUN in main.js.
  const batch = scripts.map(({ label, files }) =>
    `try {\n${files.map(readApp).join('\n')}\n} catch (err) { console.error(${JSON.stringify(label)} + ":", err); }`
  ).join('\n');
  assert.match(mainSrc, /const UI_SCRIPT_BATCH = UI_SCRIPTS\.map\(\(\[name, source\]\) =>\s*`try \{\\n\$\{source\}\\n\} catch/,
    'main.js builds UI_SCRIPT_BATCH differently; update this test');
  for (const { label, files } of scripts) {
    for (const f of files) assert.doesNotThrow(() => new vm.Script(readApp(f), { filename: f }), `${label}: ${f}`);
  }
  assert.doesNotThrow(() => new vm.Script(batch, { filename: 'UI_SCRIPT_BATCH' }));
  const startup = jsFiles(declaration('STARTUP_SCREEN_JS'));
  assert.deepEqual(startup, ['startup-screen.js']);
  assert.doesNotThrow(() => new vm.Script(`try {\n${readApp(startup[0])}\n} catch (err) { console.error("STARTUP SCREEN:", err); }`));
  const lock = mainSrc.match(/const FAKE_POINTER_LOCK = `([\s\S]*?)`;/);
  assert.ok(lock, 'FAKE_POINTER_LOCK not found');
  assert.doesNotThrow(() => new vm.Script(lock[1]));
});

test('every file main.js loads is in the build', () => {
  const needed = new Set();
  for (const { files } of uiScripts()) files.forEach((f) => needed.add(f));
  // Every path.join(__dirname, "a", "b") naming a file (folders: studio/ is a glob entry,
  // mods/ ships as extraResources).
  for (const m of mainSrc.matchAll(/path\.join\(__dirname((?:,\s*["'][^"']+["'])+)\)/g)) {
    const rel = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).join('/');
    const full = path.join(appDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) continue;
    needed.add(rel);
  }
  // Local modules, and the ones they require in turn.
  const queue = [...mainSrc.matchAll(/require\(["']\.\/([^"']+)["']\)/g)].map((m) => m[1]);
  const seen = new Set();
  while (queue.length) {
    let name = queue.shift();
    if (!path.extname(name)) name += '.js';
    if (seen.has(name)) continue;
    seen.add(name);
    needed.add(name);
    assert.ok(fs.existsSync(path.join(appDir, name)), `${name} is required but missing`);
    if (name.endsWith('.js')) {
      for (const m of readApp(name).matchAll(/require\(["']\.\/([^"']+)["']\)/g)) queue.push(m[1]);
    }
  }
  for (const f of ['shell-log.js', 'shell-env.js', 'backups.js', 'preload.js', 'ui.css', 'build/icon.ico']) assert.ok(needed.has(f), f);
  const missing = [...needed].filter((f) => !shipped(f));
  assert.deepEqual(missing, [], 'add these to app/package.json build.files');
});

test('AIM_PORT parsing', () => {
  assert.deepEqual(parsePort(undefined), { port: 8000, explicit: false });
  assert.deepEqual(parsePort(''), { port: 8000, explicit: false });
  assert.deepEqual(parsePort('  '), { port: 8000, explicit: false });
  assert.deepEqual(parsePort('8270'), { port: 8270, explicit: true });
  assert.deepEqual(parsePort(' 8270 '), { port: 8270, explicit: true });
  assert.deepEqual(parsePort('65535'), { port: 65535, explicit: true });
  for (const bad of ['0', 'abc', '70000', '65536', '8270x', '-1', '1e3', '0x1F90', '80.5', '+80']) {
    assert.ok(parsePort(bad).error, bad);
  }
});

test('headless test copies need their own port and profile', () => {
  assert.deepEqual(readTestEnv({}), { port: 8000, headless: false });
  assert.deepEqual(readTestEnv({ AIM_PORT: '8272' }), { port: 8272, headless: false });
  assert.ok(readTestEnv({ AIM_PORT: 'abc' }).error);
  assert.deepEqual(readTestEnv({ AIM_HEADLESS: '1', AIM_PORT: '8272', AIM_PROFILE: 'C:\\x' }), { port: 8272, headless: true });
  assert.ok(readTestEnv({ AIM_HEADLESS: '1', AIM_PROFILE: 'C:\\x' }).error, 'no port');
  assert.ok(readTestEnv({ AIM_HEADLESS: '1', AIM_PORT: '8000', AIM_PROFILE: 'C:\\x' }).error, 'port 8000');
  assert.ok(readTestEnv({ AIM_HEADLESS: '1', AIM_PORT: '8272' }).error, 'no profile');
  assert.ok(readTestEnv({ AIM_HEADLESS: '1', AIM_PORT: '8272', AIM_PROFILE: ' ' }).error, 'blank profile');
});

// --- backups.onStartup ---------------------------------------------------------------
const ud = path.join(profile, 'AimTrainer');
const broot = path.join(profile, 'AimTrainer-Backups');
const pending = path.join(broot, 'restore-pending.json');
function resetData() {
  fs.rmSync(profile, { recursive: true, force: true });
  for (const dir of ['Local Storage', 'IndexedDB', 'studio-drills', 'studio-runs']) {
    fs.mkdirSync(path.join(ud, dir), { recursive: true });
    fs.writeFileSync(path.join(ud, dir, 'data.txt'), `live ${dir}`);
  }
}
const backupsOf = (reason) => (fs.existsSync(broot) ? fs.readdirSync(broot) : [])
  .filter((n) => fs.statSync(path.join(broot, n)).isDirectory() && n.includes(` ${reason}`));
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

test('a corrupt restore-pending.json is dropped and the launch backup still happens', () => {
  resetData();
  for (const bad of ['{', 'null', '"x"', '[]']) {
    fs.mkdirSync(broot, { recursive: true });
    fs.writeFileSync(pending, bad);
    const before = backupsOf('launch').length;
    quiet(() => backups.onStartup());
    assert.ok(!fs.existsSync(pending), `${bad}: pending file removed`);
    assert.equal(backupsOf('launch').length, before + 1, `${bad}: launch backup made`);
  }
});

test('a scheduled restore is applied before the launch backup; studio-runs is backed up', () => {
  resetData();
  quiet(() => backups.onStartup());
  const [first] = backupsOf('launch');
  assert.ok(first);
  for (const dir of ['Local Storage', 'studio-runs', 'studio-drills']) {
    assert.equal(fs.readFileSync(path.join(broot, first, dir, 'data.txt'), 'utf-8'), `live ${dir}`);
  }
  fs.writeFileSync(path.join(ud, 'studio-runs', 'data.txt'), 'changed');
  fs.writeFileSync(path.join(ud, 'Local Storage', 'data.txt'), 'changed');
  fs.writeFileSync(pending, JSON.stringify({ id: first }));
  quiet(() => backups.onStartup());
  assert.ok(!fs.existsSync(pending));
  assert.equal(fs.readFileSync(path.join(ud, 'Local Storage', 'data.txt'), 'utf-8'), 'live Local Storage');
  assert.equal(fs.readFileSync(path.join(ud, 'studio-runs', 'data.txt'), 'utf-8'), 'live studio-runs');
  const [saved] = backupsOf('before restore');
  assert.equal(fs.readFileSync(path.join(broot, saved, 'studio-runs', 'data.txt'), 'utf-8'), 'changed');
  assert.equal(backupsOf('launch').length, 2);
});

test('restoring an older backup without studio-runs keeps the live runs', () => {
  resetData();
  quiet(() => backups.onStartup());
  const [old] = backupsOf('launch');
  fs.rmSync(path.join(broot, old, 'studio-runs'), { recursive: true }); // as made before studio-runs was added
  fs.writeFileSync(path.join(ud, 'studio-runs', 'data.txt'), 'newer runs');
  fs.writeFileSync(pending, JSON.stringify({ id: old }));
  quiet(() => backups.onStartup());
  assert.equal(fs.readFileSync(path.join(ud, 'studio-runs', 'data.txt'), 'utf-8'), 'newer runs');
  assert.equal(fs.readFileSync(path.join(ud, 'Local Storage', 'data.txt'), 'utf-8'), 'live Local Storage');
});

test('a pending restore of a missing backup is dropped; a missing studio-runs folder is fine', () => {
  resetData();
  fs.rmSync(path.join(ud, 'studio-runs'), { recursive: true });
  fs.mkdirSync(broot, { recursive: true });
  fs.writeFileSync(pending, JSON.stringify({ id: '../..' }));
  quiet(() => backups.onStartup());
  assert.ok(!fs.existsSync(pending));
  const [made] = backupsOf('launch');
  assert.ok(made && !fs.existsSync(path.join(broot, made, 'studio-runs')));
});

function fakeIpc() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => handlers.set(channel, fn) };
}

test('restore relaunches the portable .exe; headless refuses on-screen backup actions', async () => {
  resetData();
  quiet(() => backups.onStartup());
  const [id] = backupsOf('launch');
  const ipc = fakeIpc();
  backups.register(ipc, () => null, () => true);
  const before = process.env.PORTABLE_EXECUTABLE_FILE;
  try {
    process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Games\\AimTrainer.exe';
    await ipc.handlers.get('aim:backups:restore')({}, id);
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    await ipc.handlers.get('aim:backups:restore')({}, id);
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    if (before === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = before;
  }
  assert.deepEqual(relaunches.slice(-2), [{ execPath: 'C:\\Games\\AimTrainer.exe' }, undefined]);

  const headless = fakeIpc();
  backups.register(headless, () => null, () => true, { headless: true });
  for (const ch of ['aim:backups:open', 'aim:backups:export', 'aim:backups:import']) {
    await assert.rejects(async () => quiet(() => headless.handlers.get(ch)({})), /headless/, ch);
  }
  assert.ok(Array.isArray(await headless.handlers.get('aim:backups:list')({})));
  // Headless restore: scheduled for the next launch, but the copy never restarts itself.
  const count = relaunches.length;
  fs.rmSync(pending, { force: true });
  await quiet(() => headless.handlers.get('aim:backups:restore')({}, id));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(relaunches.length, count);
  assert.deepEqual(JSON.parse(fs.readFileSync(pending, 'utf-8')), { id });
});

test('headless copies never open the VALORANT import file picker', async () => {
  const wc = { mainFrame: {} };
  const win = { webContents: wc };
  const event = { sender: wc, senderFrame: wc.mainFrame };
  valorantIpc.register(() => win, () => {}, { headless: true });
  await assert.rejects(async () => quiet(() => ipcHandlers.get('aim:valorant:choose')(event)), /headless/);
  assert.equal(pickers.length, 0);
  ipcHandlers.clear();
  valorantIpc.register(() => win, () => {});
  assert.equal(await ipcHandlers.get('aim:valorant:choose')(event), null);
  assert.equal(pickers.length, 1, 'normal copies still open it');
});

// --- shell-log -----------------------------------------------------------------------
test('the log writes lines and rotates past its size limit', () => {
  const dir = path.join(tmp, 'log1', 'logs');
  const log = createLog(dir, { maxBytes: 2000 });
  log.info('hello', 42, { a: 1 });
  log.error('boom', new Error('bad thing'));
  const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf-8');
  assert.match(text, /^\d{4}-\d\d-\d\dT\S+ INFO hello 42 \{ a: 1 \}$/m);
  assert.match(text, /ERROR boom Error: bad thing/);
  for (let i = 0; i < 100; i++) log.warn(`line ${i} `.padEnd(60, 'x'));
  assert.ok(fs.existsSync(path.join(dir, 'main.old.log')));
  assert.ok(fs.statSync(path.join(dir, 'main.log')).size <= 2000);
  assert.ok(fs.statSync(path.join(dir, 'main.old.log')).size <= 2000);
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf-8'), /line 99 /);
  // An oversized file from last time is moved aside at startup.
  fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(3000));
  createLog(dir, { maxBytes: 2000 }).info('fresh');
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf-8'), /^\S+ INFO fresh\n$/);
  assert.equal(fs.statSync(path.join(dir, 'main.old.log')).size, 3000);
});

test('multi-line entries keep one time stamp per entry', () => {
  const dir = path.join(tmp, 'log7');
  const log = createLog(dir);
  log.error('first line\r\nsecond line\nthird');
  log.info('next');
  const lines = fs.readFileSync(path.join(dir, 'main.log'), 'utf-8').split('\n');
  assert.match(lines[0], /^\S+ ERROR first line$/);
  assert.equal(lines[1], '    second line');
  assert.equal(lines[2], '    third');
  assert.match(lines[3], /^\S+ INFO next$/);
});

test('a log rotated by another copy is not rotated again', () => {
  const dir = path.join(tmp, 'log8');
  const a = createLog(dir, { maxBytes: 1000 });
  for (let i = 0; i < 9; i++) a.info('a'.repeat(80));
  // Another copy sharing the folder rotates the file (e.g. at its startup).
  fs.renameSync(path.join(dir, 'main.log'), path.join(dir, 'main.old.log'));
  fs.writeFileSync(path.join(dir, 'main.log'), 'other copy\n');
  a.info('b'.repeat(80));
  assert.match(fs.readFileSync(path.join(dir, 'main.old.log'), 'utf-8'), /aaaa/, 'old history kept');
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf-8'), /^other copy\n\S+ INFO b+\n$/);
});

test('the log never throws when it cannot write', () => {
  const blocked = path.join(tmp, 'log2');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'logs'), 'a file where the logs folder should be');
  const log = createLog(path.join(blocked, 'logs'));
  assert.doesNotThrow(() => { log.info('x'); log.error(new Error('y')); log.warn({ get boom() { throw new Error('getter'); } }); });
  // A hooked console keeps printing and doesn't throw either.
  const printed = [];
  const con = { log: (...a) => printed.push(a.join(' ')), warn: () => {}, error: () => { throw new Error('stderr gone'); } };
  log.hookConsole(con);
  assert.doesNotThrow(() => { con.log('still', 'printed'); con.error('x'); });
  assert.deepEqual(printed, ['still printed']);
  // A circular object is still logged.
  const dir = path.join(tmp, 'log3');
  const ok = createLog(dir);
  const a = { name: 'loop' }; a.self = a;
  ok.info(a);
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf-8'), /loop/);
});

function fakeWindow() {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.loads = [];
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.loadURL = (url) => { win.loads.push(url); return Promise.resolve(); };
  return win;
}
const logText = (dir) => fs.readFileSync(path.join(dir, 'main.log'), 'utf-8');

test('a crashed page reloads the lobby, at most 3 times a minute', () => {
  const dir = path.join(tmp, 'log4');
  const log = createLog(dir);
  const win = fakeWindow();
  let t = 1000000;
  const timers = [];
  let gaveUp = 0;
  let quitting = false;
  log.attachWindow(win, { url: 'http://localhost:8272/aim', now: () => t, setTimer: (fn, ms) => timers.push([fn, ms]),
    isQuitting: () => quitting, onGiveUp: () => gaveUp++ });
  const crash = (reason) => win.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 });
  const run = () => { while (timers.length) timers.shift()[0](); };

  crash('clean-exit');
  assert.equal(timers.length, 0, 'clean exit: no reload');
  crash('crashed'); run();
  t += 10000; crash('oom'); run();
  t += 10000; crash('killed'); run();
  assert.deepEqual(win.loads, Array(3).fill('http://localhost:8272/aim'));
  assert.equal(timers.length, 0);
  t += 10000; crash('crashed');
  assert.equal(gaveUp, 1, '4th crash within 60 s gives up');
  assert.equal(timers.length, 0);
  crash('crashed');
  assert.equal(gaveUp, 1, 'gives up once');
  assert.match(logText(dir), /PAGE CRASHED: reason=oom exitCode=1/);
  assert.match(logText(dir), /PAGE RELOAD: http:\/\/localhost:8272\/aim \(3\/3\)/);
  assert.match(logText(dir), /PAGE CRASHED 4 times in 60 s/);

  // Crashes spread over more than a minute keep reloading.
  const w2 = fakeWindow();
  log.attachWindow(w2, { url: 'u', now: () => t, setTimer: (fn) => fn(), onGiveUp: () => gaveUp++ });
  for (let i = 0; i < 6; i++) { t += 61000; w2.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); }
  assert.equal(w2.loads.length, 6);
  assert.equal(gaveUp, 1);

  // Quitting or a closed window: no reload (checked again when the timer fires).
  const w3 = fakeWindow();
  log.attachWindow(w3, { url: 'u', setTimer: (fn) => timers.push([fn]), isQuitting: () => quitting });
  w3.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  quitting = true; run();
  w3.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  quitting = false; run();
  w3.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  w3.destroyed = true; run();
  assert.equal(w3.loads.length, 0);
});

test('window events and page errors are logged, page errors at most 50 a minute', () => {
  const dir = path.join(tmp, 'log5');
  const log = createLog(dir);
  const win = fakeWindow();
  let t = 0;
  log.attachWindow(win, { url: 'u', now: () => t });
  const wc = win.webContents;
  win.emit('unresponsive');
  win.emit('responsive');
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost/aborted', true);
  wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://localhost/subframe', false);
  wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:8272/aim', true);
  // Electron 35+ form: one event object (positional args still follow it).
  wc.emit('console-message', { level: 'error', message: 'new form', sourceId: 'a.js', lineNumber: 3 }, 3, 'new form', 3, 'a.js');
  wc.emit('console-message', { level: 'info', message: 'not an error' }, 1, 'not an error', 1, 'a.js');
  // Old form: (event, level, message, line, sourceId).
  wc.emit('console-message', {}, 3, 'old form', 7, 'b.js');
  wc.emit('console-message', {}, 2, 'old warning', 7, 'b.js');
  let text = logText(dir);
  assert.match(text, /WARN PAGE NOT RESPONDING/);
  assert.match(text, /INFO PAGE RESPONDING AGAIN/);
  assert.match(text, /PAGE LOAD FAILED: -102 ERR_CONNECTION_REFUSED http:\/\/localhost:8272\/aim/);
  assert.doesNotMatch(text, /aborted|subframe/);
  assert.match(text, /PAGE ERROR: new form \(a\.js:3\)/);
  assert.match(text, /PAGE ERROR: old form \(b\.js:7\)/);
  assert.doesNotMatch(text, /not an error|old warning/);

  for (let i = 0; i < 100; i++) wc.emit('console-message', { level: 'error', message: `spam ${i}` });
  text = logText(dir);
  assert.equal((text.match(/ ERROR PAGE ERROR: /g) || []).length, 50);
  assert.equal((text.match(/the rest are skipped/g) || []).length, 1);
  t += 60000;
  wc.emit('console-message', { level: 'error', message: 'next minute' });
  assert.match(logText(dir), /PAGE ERROR: next minute/);
});

test('helper processes that stop are logged', () => {
  const dir = path.join(tmp, 'log6');
  const log = createLog(dir);
  const app = new EventEmitter();
  log.watchApp(app);
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: -1 });
  assert.match(logText(dir), /CHILD PROCESS GONE: type=GPU reason=crashed exitCode=-1/);
});
