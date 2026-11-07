// Fast unit tests for the smoke suite helpers (npm run test:smokelib). Never launches electron.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import {
  tryTakeSlot, takeSlot, releaseSlot, slotIsStale, readOwner, writeOwner,
  parseArgs, classifyError, shellLineIsError, checkProfile, pickPorts, portOpen,
  parseLauncherOutput, parseLock, readLock, lockIsOurs, once, electronPath, exitCodeFor, EXIT,
  LAUNCHER_PROFILE_RE, safeLauncherProfile, launcherConfig, mainLogError, ALLOW, pidAlive, sleep,
} from "./lib.mjs";
import { startLauncher, stopApp, preempted } from "./launch.mjs";
import { guardLauncher } from "./guard.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "smoke-slots-"));
const DEAD = 999999; // pid that does not exist
const alive = (pid) => pid === process.pid;

test("slot: takes slot1, then slot2, then none", () => {
  const root = tmpRoot();
  const a = tryTakeSlot(root, { team: "t", runner: process.pid }, { alive });
  const b = tryTakeSlot(root, { team: "t", runner: process.pid }, { alive });
  const c = tryTakeSlot(root, { team: "t", runner: process.pid }, { alive });
  const d = tryTakeSlot(root, { team: "t", runner: process.pid }, { alive });
  assert.equal(path.basename(a), "slot1");
  assert.equal(path.basename(b), "slot2");
  assert.equal(path.basename(c), "slot3");
  assert.equal(d, null);
  assert.match(fs.readFileSync(path.join(a, "owner.txt"), "utf8"), new RegExp(`runner=${process.pid}`));
});

test("slot: release removes only our own slot", () => {
  const root = tmpRoot();
  const a = tryTakeSlot(root, { team: "t", runner: process.pid }, { alive });
  assert.equal(releaseSlot(a, [12345]), false, "someone else's pid: keep");
  assert.ok(fs.existsSync(a));
  assert.equal(releaseSlot(a, [process.pid]), true);
  assert.ok(!fs.existsSync(a));
});

test("slot: stale owner (dead pid, old owner.txt) is taken over; fresh or live owner is not", () => {
  const root = tmpRoot();
  for (const n of ["slot1", "slot2", "slot3"]) fs.mkdirSync(path.join(root, n));
  writeOwner(path.join(root, "slot1"), { team: "x", PID: DEAD }); // dead but fresh
  writeOwner(path.join(root, "slot2"), { team: "x", pid: process.pid }); // alive, old
  writeOwner(path.join(root, "slot3"), { team: "x", pid: DEAD }); // dead, old
  const old = (Date.now() - 3 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(root, "slot2", "owner.txt"), old, old);
  fs.utimesSync(path.join(root, "slot3", "owner.txt"), old, old);
  assert.equal(slotIsStale(path.join(root, "slot1"), Date.now(), alive), false);
  assert.equal(slotIsStale(path.join(root, "slot2"), Date.now(), alive), false);
  assert.equal(slotIsStale(path.join(root, "slot3"), Date.now(), alive), true);
  const got = tryTakeSlot(root, { team: "me", runner: process.pid }, { alive });
  assert.equal(path.basename(got), "slot3");
  assert.deepEqual(readOwner(got).pids, [process.pid]);
});

test("slot: dir without owner.txt is taken unless older than 5 min", () => {
  const root = tmpRoot();
  const p = path.join(root, "slot1");
  fs.mkdirSync(p);
  assert.equal(slotIsStale(p, Date.now(), alive), false);
  assert.equal(slotIsStale(p, Date.now() + 6 * 60 * 1000, alive), true);
});

test("slot: owner.txt pid parsing handles pid=, PID= and runner=", () => {
  const root = tmpRoot();
  const p = path.join(root, "slot1");
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, "owner.txt"), "\ufeffteam=feel n=4 PID=63364 time=x\n");
  assert.deepEqual(readOwner(p).pids, [63364]);
  fs.writeFileSync(path.join(p, "owner.txt"), "team=qa-smoke pid=1 runner=2 cdp=9470\n");
  assert.deepEqual(readOwner(p).pids, [1, 2]);
});

test("slot: takeSlot waits, then fails clearly when nothing frees up", async () => {
  const root = tmpRoot();
  for (const n of ["slot1", "slot2", "slot3"]) {
    fs.mkdirSync(path.join(root, n));
    writeOwner(path.join(root, n), { pid: process.pid });
  }
  await assert.rejects(takeSlot(root, { runner: process.pid }, { waitMs: 120, everyMs: 50 }), /no free app slot/);
  await assert.rejects(takeSlot(path.join(root, "nope"), {}, { waitMs: 10 }), /does not exist/);
});

test("args: defaults, lists, = and space forms, env ports", () => {
  const d = parseArgs([]);
  assert.equal(d.only, null);
  assert.deepEqual(d.skip, []);
  assert.equal(d.maxMinutes, 20);
  const o = parseArgs(["--only=boot,drills", "--skip", "round", "--out", "x", "--max-minutes=5"]);
  assert.deepEqual(o.only, ["boot", "drills"]);
  assert.deepEqual(o.skip, ["round"]);
  assert.equal(o.out, "x");
  assert.equal(o.maxMinutes, 5);
  const e = parseArgs([], { SMOKE_PORT: "8275", SMOKE_CDP: "9475" });
  assert.equal(e.port, 8275);
  assert.equal(e.cdp, 9475);
});

test("args: rejects --keep-open, port 8000, unknown flags, half port pairs", () => {
  assert.throws(() => parseArgs(["--keep-open"]), /not allowed/);
  assert.throws(() => parseArgs(["--port=8000", "--cdp=9470"]), /8000/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown/);
  assert.throws(() => parseArgs(["--port=8270"]), /both/);
  assert.throws(() => parseArgs(["--only"]), /needs a value/);
});

test("profile: refuses the user's real save", () => {
  const appData = "C:\\Users\\X\\AppData\\Roaming";
  assert.throws(() => checkProfile("C:\\Users\\X\\AppData\\Roaming\\AimTrainer", appData), /real save/);
  assert.throws(() => checkProfile("c:\\users\\x\\appdata\\roaming\\aimtrainer\\sub", appData), /real save/);
  assert.throws(() => checkProfile("C:\\Users\\X\\AppData\\Roaming", appData), /real save/);
  assert.equal(checkProfile("C:\\Users\\X\\open-aim-hq\\profiles\\qa\\smoke-1", appData), "C:\\Users\\X\\open-aim-hq\\profiles\\qa\\smoke-1");
  // Linux real save: ~/.config/AimTrainer (and $XDG_CONFIG_HOME/AimTrainer).
  const lin = { home: "/home/x", xdg: "" };
  assert.throws(() => checkProfile("/home/x/.config/AimTrainer", "", lin), /real save/);
  assert.throws(() => checkProfile("/home/x/.config/AimTrainer/logs", "", lin), /real save/);
  assert.throws(() => checkProfile("/home/x/.config", "", lin), /real save/);
  assert.throws(() => checkProfile("/data/cfg/AimTrainer", "", { home: "/home/x", xdg: "/data/cfg" }), /real save/);
  assert.equal(checkProfile("/tmp/openaim-profile-8270", "", lin), "/tmp/openaim-profile-8270");
  assert.equal(checkProfile("/home/x/.config/AimTrainerOld", "", lin), "/home/x/.config/AimTrainerOld");
});

// ---------------------------------------------------------------- launcher mode (pure)
test("launcher output: started, started without CDP, busy, bad app dir, garbage", () => {
  assert.deepEqual(parseLauncherOutput("started 123\n", 0), { kind: "started", pid: 123, cdpReady: true });
  assert.deepEqual(parseLauncherOutput("started 123 (cdp not answering yet)\n", 0), { kind: "started", pid: 123, cdpReady: false });
  assert.deepEqual(parseLauncherOutput("busy soprano play-test running (pid 719636)\n", 10), { kind: "busy", why: "soprano play-test running (pid 719636)" });
  assert.deepEqual(parseLauncherOutput("busy load 13.24", 10), { kind: "busy", why: "load 13.24" });
  assert.deepEqual(parseLauncherOutput("busy", 10), { kind: "busy", why: "busy" });
  assert.deepEqual(parseLauncherOutput("", 12), { kind: "badapp" });
  assert.equal(parseLauncherOutput("started 123", 10).kind, "busy", "exit code wins");
  for (const [out, code] of [["hello", 0], ["", 0], ["started abc", 0], ["started 1", 0], ["started 123 extra", 0], ["started 123", 1], ["started 123", null], ["busy x", 0]]) {
    assert.equal(parseLauncherOutput(out, code).kind, "garbage", `${JSON.stringify(out)} exit ${code}`);
  }
});

test("launcher profile: only /tmp/openaim-profile-<digits> may be deleted", () => {
  for (const ok of ["/tmp/openaim-profile-8270", "/tmp/openaim-profile-1"]) assert.ok(safeLauncherProfile(ok), ok);
  for (const bad of ["/tmp/openaim-profile-8270/", "/tmp/openaim-profile-", "/tmp/openaim-profile-82x0", "/tmp/openaim-profile-8270/../..", "/tmp/openaim-profile-8270/x",
    "/tmp", "/", "", "/home/ayvyr/.config/AimTrainer", "tmp/openaim-profile-8270", " /tmp/openaim-profile-8270", "/tmp/openaim-profile-8270\n/", null, undefined, 8270]) {
    assert.equal(safeLauncherProfile(bad), false, JSON.stringify(bad));
  }
  assert.ok(LAUNCHER_PROFILE_RE instanceof RegExp);
});

test("lock: parse and ownership (pid on line 1 AND port on line 2)", () => {
  const txt = "4242\nopen-aim 2026-11-07T12:00:00Z port 8270 cdp 9470\n";
  assert.deepEqual(parseLock(txt), { pid: 4242, port: 8270, cdp: 9470, time: Date.parse("2026-11-07T12:00:00Z") });
  assert.equal(parseLock("1\nopen-aim garbage port 1").time, null);
  assert.ok(lockIsOurs(parseLock(txt), 4242, 8270));
  assert.ok(lockIsOurs(parseLock(txt), "4242", "8270"));
  assert.equal(lockIsOurs(parseLock(txt), 4243, 8270), false, "other pid");
  assert.equal(lockIsOurs(parseLock(txt), 4242, 8271), false, "other port");
  assert.equal(lockIsOurs(parseLock("4242\nopen-aim x port 82700 cdp 9470"), 4242, 8270), false, "port must match exactly");
  assert.equal(lockIsOurs(parseLock("4242\n"), 4242, 8270), false, "no port line");
  assert.equal(lockIsOurs(parseLock("x4242\nopen-aim x port 8270"), 4242, 8270), false, "garbage pid");
  assert.equal(lockIsOurs(parseLock(""), 4242, 8270), false);
  assert.equal(lockIsOurs(null, 4242, 8270), false, "missing lock");
  assert.equal(readLock(path.join(os.tmpdir(), "no-such-lock-" + process.pid)), null);
});

test("once: concurrent and repeated calls share one run", async () => {
  let n = 0;
  const stop = once(async () => {
    n++;
    await sleep(20);
    return n;
  });
  const [a, b] = await Promise.all([stop(), stop()]);
  assert.equal(await stop(), 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(n, 1);
});

test("exit codes: pass 0, fail 1, bad args 2, timeout 3, busy/preempted 4, ssh gone 5", () => {
  assert.deepEqual(EXIT, { pass: 0, fail: 1, badArgs: 2, timeout: 3, busy: 4, sshGone: 5 });
  assert.equal(exitCodeFor({ pass: true }), 0);
  assert.equal(exitCodeFor({ pass: false }), 1);
  assert.equal(exitCodeFor({}), 1);
  assert.equal(exitCodeFor({ badArgs: true, busy: true }), 2);
  assert.equal(exitCodeFor({ timedOut: true }), 3);
  assert.equal(exitCodeFor({ busy: true }), 4);
  assert.equal(exitCodeFor({ preempted: true, timedOut: true }), 4);
  assert.equal(exitCodeFor({ sshGone: true, busy: true }), 5);
});

test("electron path per platform", () => {
  assert.equal(electronPath("/r/app", "linux"), path.join("/r/app", "node_modules", "electron", "dist", "electron"));
  assert.equal(electronPath("/r/app", "win32"), path.join("/r/app", "node_modules", "electron", "dist", "electron.exe"));
});

test("launcher mode detection: SMOKE_LAUNCHER, or Linux with ~/hp-share/openaim-start.sh", () => {
  const c = launcherConfig({ env: { SMOKE_LAUNCHER: "/opt/x/start.sh" }, platform: "win32", home: "/h", exists: () => false });
  assert.equal(c.starter, "/opt/x/start.sh");
  assert.equal(c.stopper, path.join("/opt/x", "openaim-stop.sh"));
  assert.equal(c.lockFile, path.join("/opt/x", "openaim.lock"));
  assert.equal(c.lockDir, path.join("/opt/x", "openaim.lock.d"));
  const hp = launcherConfig({ env: {}, platform: "linux", home: "/home/ayvyr", exists: (p) => p === path.join("/home/ayvyr", "hp-share", "openaim-start.sh") });
  assert.equal(hp.starter, path.join("/home/ayvyr", "hp-share", "openaim-start.sh"));
  assert.equal(launcherConfig({ env: {}, platform: "linux", home: "/home/x", exists: () => false }), null);
  assert.equal(launcherConfig({ env: {}, platform: "win32", home: "C:\\Users\\x", exists: () => true }), null);
});

test("main.log: ERROR lines count, PAGE ERROR (CDP has it) and other levels do not", () => {
  assert.equal(mainLogError("2026-11-07T12:00:00.123Z ERROR UI SCRIPTS: TypeError: x"), "UI SCRIPTS: TypeError: x");
  assert.equal(mainLogError("2026-11-07T12:00:00.123Z ERROR PAGE ERROR: Failed to load resource (x:1)"), null);
  assert.equal(mainLogError("2026-11-07T12:00:00.123Z WARN PAGE NOT RESPONDING"), null);
  assert.equal(mainLogError("2026-11-07T12:00:00.123Z INFO started"), null);
  assert.equal(mainLogError("    at foo (bar.js:1:2)"), null);
  assert.equal(classifyError({ kind: "shell", level: "error", text: "main.log: UI SCRIPTS: x" }), "fail");
  for (const a of ALLOW) assert.ok(a.why && a.why.length > 10, "every allowlist entry says why");
});

// ---------------------------------------------------------------- launcher mode with fake hp scripts (Linux only)
// A fake openaim-start.sh / openaim-stop.sh pair in a temp dir; "electron" is a sleep. Never starts the app.
const linuxOnly = { skip: process.platform === "win32" ? "needs bash + /proc (runs on hp)" : false };
const PORT = 18997; // not a real qa port; its /tmp/openaim-profile-18997 is ours to create/delete

function fakeHp({ busy = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-fakehp-"));
  const lock = path.join(dir, "openaim.lock");
  const starter = path.join(dir, "openaim-start.sh");
  const stopper = path.join(dir, "openaim-stop.sh");
  fs.writeFileSync(starter, busy ? `#!/bin/bash\necho "busy ${busy}"; exit 10\n` : `#!/bin/bash
mkdir "${lock}.d" 2>/dev/null || { echo "busy another open-aim copy is running"; exit 10; }
ls -l /proc/$$/fd > "${dir}/starter-fds.txt" 2>&1
setsid sleep 30 >/dev/null 2>&1 </dev/null &
pid=$!; printf "%s\\nopen-aim x port %s cdp %s\\n" "$pid" "$2" "$3" > "${lock}"
echo "started $pid"
`);
  fs.writeFileSync(stopper, `#!/bin/bash
echo x >> "${dir}/stops.txt"
pid=$(head -1 "${lock}" 2>/dev/null); [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
rm -f "${lock}"; rmdir "${lock}.d" 2>/dev/null; echo stopped
`);
  fs.chmodSync(starter, 0o755);
  fs.chmodSync(stopper, 0o755);
  const cfg = { starter, stopper, lockFile: lock, lockDir: lock + ".d" };
  const stops = () => (fs.existsSync(path.join(dir, "stops.txt")) ? fs.readFileSync(path.join(dir, "stops.txt"), "utf8").trim().split("\n").length : 0);
  return { dir, cfg, stops, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "smoke-out-")) };
}
const noGuard = path.join(os.tmpdir(), `smoke-noguard-${process.pid}.mjs`);
fs.writeFileSync(noGuard, "\n");
const quiet = () => {};

test("launcher: busy -> nothing started, no stopper call, profile untouched", linuxOnly, async () => {
  const f = fakeHp({ busy: "soprano play-test running (pid 1)" });
  const prof = `/tmp/openaim-profile-${PORT}`;
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, "marker"), "x");
  fs.mkdirSync(f.cfg.lockDir); // another copy holds the lock dir: profile must stay
  const h = await startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard });
  assert.equal(h.busy, "soprano play-test running (pid 1)");
  assert.equal(h.started, false);
  await stopApp(h, quiet);
  await stopApp(h, quiet);
  assert.equal(f.stops(), 0, "no stopper call after busy");
  assert.ok(fs.existsSync(path.join(prof, "marker")), "profile untouched while another copy holds the lock");
  fs.rmSync(prof, { recursive: true, force: true });
});

test("launcher: start, stop memoised (one stopper call), profile deleted, fds 8/9 closed", linuxOnly, async () => {
  const f = fakeHp();
  const prof = `/tmp/openaim-profile-${PORT}`;
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, "old"), "x");
  // Open fds 8 and 9 in a parent bash (like hp.sh run's run locks) and check the starter does not see them.
  const probe = execFileSync("bash", ["-c", `exec 9>"${f.dir}/l9" 8>"${f.dir}/l8"; bash -c 'exec 8>&- 9>&-; exec "$0" "$@"' ls -l /proc/self/fd`], { encoding: "utf8" });
  assert.doesNotMatch(probe, /l9|l8/, "fd-closing wrapper drops 8/9");
  const h = await startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard });
  assert.equal(h.started, true);
  assert.ok(pidAlive(h.pid));
  assert.ok(!fs.existsSync(path.join(prof, "old")), "fresh profile before start (lock dir was free)");
  fs.mkdirSync(prof, { recursive: true }); // the app would create it
  assert.equal(preempted(h), false);
  const [a, b] = await Promise.all([stopApp(h, quiet), stopApp(h, quiet)]);
  await stopApp(h, quiet);
  assert.equal(f.stops(), 1, "stopper ran exactly once");
  assert.equal(a.stopped, true);
  assert.equal(b.stopped, true);
  assert.ok(!fs.existsSync(f.cfg.lockFile));
  assert.ok(!fs.existsSync(prof), "profile deleted after a checked stop");
  await sleep(100);
  assert.equal(pidAlive(h.pid), false);
});

test("launcher: lock not ours -> no stopper call; copy stopped by someone else -> preempted", linuxOnly, async () => {
  const f = fakeHp();
  const h = await startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard });
  // Someone else stops it (hp.sh app-stop) and another team starts a copy on another port.
  execFileSync(f.cfg.stopper);
  fs.writeFileSync(f.cfg.lockFile, `${h.pid}\nopen-aim x port 8221 cdp 9421\n`);
  await sleep(100);
  assert.equal(preempted(h), true);
  const r = await stopApp(h, quiet);
  assert.equal(r.stopped, false);
  assert.equal(f.stops(), 1, "only the outside stop; ours did not call the stopper");
  assert.ok(fs.existsSync(f.cfg.lockFile), "other copy's lock untouched");
});

test("launcher: outside stopper mid-pause (pid dead, lock still ours for a moment) -> preempted, no stopper call", linuxOnly, async () => {
  const f = fakeHp();
  const h = await startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard });
  process.kill(h.pid, "SIGKILL"); // like openaim-stop.sh's TERM; it removes the lock 2 s later
  await sleep(50);
  setTimeout(() => fs.rmSync(f.cfg.lockFile, { force: true }), 300);
  const r = await stopApp(h, quiet);
  assert.equal(r.preempted, true);
  assert.equal(r.stopped, false);
  assert.equal(f.stops(), 0);
});

test("launcher: our copy died and left its lock -> stale lock stopped after the wait", linuxOnly, async () => {
  const f = fakeHp();
  const h = await startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard });
  h.staleWaitMs = 300;
  process.kill(h.pid, "SIGKILL");
  await sleep(50);
  const r = await stopApp(h, quiet);
  assert.equal(r.preempted, false);
  assert.equal(f.stops(), 1);
  assert.ok(!fs.existsSync(f.cfg.lockFile));
});

test("launcher: garbage output but a fresh lock on our port -> copy adopted and stopped", linuxOnly, async () => {
  const f = fakeHp();
  const real = fs.readFileSync(f.cfg.starter, "utf8").replace(/echo "started \$pid"/, 'echo "segfault"');
  fs.writeFileSync(f.cfg.starter, real.replace("open-aim x port", 'open-aim $(date -u +%FT%TZ) port'));
  await assert.rejects(startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard }), /unexpected output.*stopped/);
  assert.equal(f.stops(), 1);
  assert.ok(!fs.existsSync(f.cfg.lockFile));
});

test("guard (launcher): runner gone -> checked stop; lock not ours -> no stop", linuxOnly, async () => {
  const f = fakeHp();
  const h = await startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard });
  const c = { runner: 999999, pid: h.pid, port: PORT, stopper: f.cfg.stopper, lockFile: f.cfg.lockFile, profile: "/tmp/not-a-launcher-profile", capMs: 60000, log: null };
  assert.equal(await guardLauncher(c, { pollMs: 20 }), "stopped");
  assert.equal(f.stops(), 1);
  // Second copy; lock says another port -> guard must not stop it.
  const g = fakeHp();
  const h2 = await startLauncher({ cfg: g.cfg, port: PORT, cdp: PORT + 1, outDir: g.outDir, log: quiet, guardScript: noGuard });
  fs.writeFileSync(g.cfg.lockFile, `${h2.pid}\nopen-aim x port 8221 cdp 9421\n`);
  assert.equal(await guardLauncher({ ...c, pid: h2.pid, stopper: g.cfg.stopper, lockFile: g.cfg.lockFile }, { pollMs: 20 }), "not-ours");
  assert.equal(g.stops(), 0);
  // Cap reached with the runner alive -> checked stop.
  fs.writeFileSync(g.cfg.lockFile, `${h2.pid}\nopen-aim x port ${PORT} cdp ${PORT + 1}\n`);
  assert.equal(await guardLauncher({ ...c, runner: process.pid, pid: h2.pid, stopper: g.cfg.stopper, lockFile: g.cfg.lockFile, capMs: 50 }, { pollMs: 20 }), "stopped");
  assert.equal(g.stops(), 1);
  assert.equal(pidAlive(h2.pid), false);
});

test("guard (launcher): pid dead, lock still ours while another stopper pauses -> waits, no second stop", linuxOnly, async () => {
  const f = fakeHp();
  const h = await startLauncher({ cfg: f.cfg, port: PORT, cdp: PORT + 1, outDir: f.outDir, log: quiet, guardScript: noGuard });
  process.kill(h.pid, "SIGKILL");
  await sleep(50);
  setTimeout(() => fs.rmSync(f.cfg.lockFile, { force: true }), 300);
  const c = { runner: 999999, pid: h.pid, port: PORT, stopper: f.cfg.stopper, lockFile: f.cfg.lockFile, profile: "/tmp/not-a-launcher-profile", capMs: 60000, log: null, staleWaitMs: 2000 };
  assert.equal(await guardLauncher(c, { pollMs: 20 }), "not-ours");
  assert.equal(f.stops(), 0);
});

test("allowlist: known benign 404s ignored, local 404s and exceptions fail, warnings warn", () => {
  const e404 = (url) => ({ kind: "log", level: "error", text: "Failed to load resource: the server responded with a status of 404 (Not Found)", url });
  assert.equal(classifyError(e404("http://localhost:8270/prod-api/api/v1/public/val/aimlab/desktop-seen")), "ignore");
  assert.equal(classifyError(e404("http://localhost:8270/prod-api/api/v1/public/val/aimlab/plays/workshop/d43f842fb33e4d46")), "ignore");
  assert.equal(classifyError(e404("http://localhost:8270/prod-api/api/v1/public/val/aimlab/lock-events")), "ignore");
  assert.equal(classifyError(e404("http://localhost:8270/next/js/missing.js")), "fail");
  assert.equal(classifyError(e404("http://localhost:8270/aim/drill-variants.json")), "fail");
  assert.equal(classifyError(e404("http://localhost:8270/prod-api/api/v1/public/val/other")), "fail");
  assert.equal(classifyError({ kind: "exception", level: "error", text: "TypeError: x is undefined" }), "fail");
  assert.equal(classifyError({ kind: "console", level: "error", text: "ROUND HUD: TypeError" }), "fail");
  assert.equal(classifyError({ kind: "console", level: "error", text: "something broke" }), "fail");
  assert.equal(classifyError({ kind: "console", level: "warning", text: "THREE.WARNING: Multiple instances of Three.js being imported." }), "warn");
  assert.equal(classifyError({ kind: "console", level: "warning", text: "Electron Security Warning (Insecure Content-Security-Policy)" }), "warn");
  assert.equal(classifyError({ kind: "shell", level: "error", text: "electron: UI SCRIPTS: Error" }), "fail");
});

test("shell stdout lines: script wrapper errors flagged, normal lines not", () => {
  assert.equal(shellLineIsError("UI SCRIPTS: SyntaxError: Unexpected token"), true);
  assert.equal(shellLineIsError("STARTUP SCREEN: Error: x"), true);
  assert.equal(shellLineIsError("MISSING: /prod-api/api/v1/public/val/aimlab/desktop-seen"), false);
  assert.equal(shellLineIsError("DevTools listening on ws://127.0.0.1:9470/devtools/browser/x"), false);
});

test("ports: picks the first free pair, skips busy ones, refuses 8000", async () => {
  const busy = new Set([8270, 9475]);
  const isOpen = async (p) => busy.has(p);
  assert.deepEqual(await pickPorts(null, isOpen), [8276, 9476]);
  assert.deepEqual(await pickPorts([8277, 9477], isOpen), [8277, 9477]);
  await assert.rejects(pickPorts([8270, 9470], isOpen), /no free/);
  await assert.rejects(pickPorts([8000, 9470], isOpen), /8000/);
});

test("ports: portOpen sees a real listener", async () => {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const { port } = srv.address();
  assert.equal(await portOpen(port), true);
  srv.close();
  await new Promise((r) => srv.once("close", r));
  assert.equal(await portOpen(port), false);
});
