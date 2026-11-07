// Starts one hidden (AIM_HEADLESS=1) test copy of the app for the smoke suite and stops it.
//
// Launcher mode (hp): the copy is started ONLY by ~/hp-share/openaim-start.sh and stopped
// ONLY by openaim-stop.sh, and only while ~/hp-share/openaim.lock still names our pid and
// port (plan S2 R1). A detached guard (guard.mjs) does the same checked stop if this runner
// dies. Busy hp = no copy, exit 4 (the PC-side qa-smoke.sh retries).
//
// Direct mode (any machine without hp-share; UNTESTED since rule 0 forbids running the app on
// the PC): spawns electron itself, optional app slot (SMOKE_SLOT_DIR), kills its own tree.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  takeSlot, writeOwner, releaseSlot, pickPorts, checkProfile, pidAlive, killTree, findLeftovers, sleep,
  launcherConfig, launcherProfile, launcherLog, safeLauncherProfile, parseLauncherOutput, readLock, lockIsOurs,
  once, electronPath, EXIT,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const APP_DIR = path.join(REPO, "app");
const GUARD = path.join(HERE, "guard.mjs");

// Runs `file args...` with the hp.sh run-lock fds 8 and 9 closed, so a copy (or guard) that
// outlives this runner never holds one of hp's two machine-wide run slots (R4).
export const CLOSE_RUN_LOCKS = 'exec 8>&- 9>&-; exec "$0" "$@"';

export function runClosed(file, args = [], { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile("bash", ["-c", CLOSE_RUN_LOCKS, file, ...args.map(String)], { timeout, encoding: "utf8", maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve({ code, stdout: stdout || "", stderr: stderr || "", killed: !!(err && err.killed) });
    });
  });
}

export function spawnClosedDetached(file, args, opts = {}) {
  const child = spawn("bash", ["-c", CLOSE_RUN_LOCKS, file, ...args.map(String)], { detached: true, stdio: "ignore", ...opts });
  child.unref();
  return child.pid;
}

// Follows a growing text file from offset 0; calls onLine for each complete line.
function tailFile(file, onLine) {
  let pos = 0;
  let part = "";
  const poll = () => {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (size < pos) pos = 0; // rotated / truncated
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(size - pos, 1 << 16));
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        const lines = (part + buf.toString("utf8", 0, n)).split(/\r?\n/);
        part = lines.pop();
        for (const l of lines) if (l.trim()) onLine(l);
      }
    } catch {
      // not there yet
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  return { poll };
}

export const launcherCfg = () => launcherConfig();

export async function startApp(o) {
  const cfg = o.cfg === undefined ? launcherConfig() : o.cfg;
  return cfg ? startLauncher({ ...o, cfg }) : startDirect(o);
}

// ---------------------------------------------------------------- launcher mode
// Returns a handle. h.busy is set (and nothing was started) when hp is busy.
export async function startLauncher({ cfg, port, cdp, outDir, log = console.log, onLine = () => {}, onMainLine = () => {}, maxMinutes = 20, appDir = APP_DIR, cdpWaitMs = 90000, guardScript = GUARD }) {
  const h = {
    mode: "launcher", cfg, port, cdp, outDir, appDir, profile: launcherProfile(port), pid: null, started: false, busy: null,
    tail: [], exited: false, exitCode: null, guardPid: null, stopped: false, timers: [], tails: [],
  };
  h.stop = once((lg) => stopLauncher(h, lg || log));

  // Fresh profile (R8): only when no open-aim copy holds the lock dir, and only the exact
  // /tmp/openaim-profile-<port> shape.
  if (!fs.existsSync(cfg.lockDir) && safeLauncherProfile(h.profile)) {
    fs.rmSync(h.profile, { recursive: true, force: true });
    log(`fresh profile ${h.profile}`);
  }
  const r = await runClosed(cfg.starter, [appDir, port, cdp], { timeout: 150000 });
  const p = parseLauncherOutput(r.stdout, r.code);
  if (p.kind === "busy") {
    h.busy = p.why;
    log(`launcher: busy (${p.why})`);
    return h;
  }
  if (p.kind === "badapp") {
    const e = new Error(`launcher refused app dir ${appDir} (exit 12)`);
    e.exitCode = EXIT.badArgs;
    throw e;
  }
  if (p.kind !== "started") throw new Error(`launcher gave unexpected output (exit ${p.code}${r.killed ? ", timed out" : ""}): ${p.text || r.stderr.trim().slice(0, 300) || "(nothing)"}`);
  h.pid = p.pid;
  h.started = true;
  log(`launcher: started pid ${h.pid}${p.cdpReady ? "" : " (CDP not answering yet)"}; AIM ${port}, CDP ${cdp}`);

  // Guard right away, so a runner killed from here on still gets the copy stopped (R6).
  h.guardPid = spawnClosedDetached(process.execPath, [guardScript, "launcher", JSON.stringify({
    runner: process.pid, pid: h.pid, port, stopper: cfg.stopper, lockFile: cfg.lockFile, profile: h.profile,
    capMs: (maxMinutes + 3) * 60000, log: path.join(outDir, "guard.log"),
  })]);

  // Electron/xvfb output (saved, never scanned: R11) and the shell's main.log (scanned).
  const keep = (l) => {
    h.tail.push(l);
    if (h.tail.length > 40) h.tail.shift();
    onLine(l);
  };
  h.tails.push(tailFile(launcherLog(port), keep));
  h.tails.push(tailFile(path.join(h.profile, "AimTrainer", "logs", "main.log"), onMainLine));
  h.timers.push(setInterval(() => {
    for (const t of h.tails) t.poll();
    if (!h.exited && !pidAlive(h.pid)) h.exited = true;
  }, 1000));
  h.timers.forEach((t) => t.unref?.());

  if (!p.cdpReady) {
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < cdpWaitMs && !ok && pidAlive(h.pid)) {
      ok = await fetch(`http://127.0.0.1:${cdp}/json/version`, { signal: AbortSignal.timeout(3000) }).then((x) => x.ok, () => false);
      if (!ok) await sleep(2000);
    }
    if (!ok) {
      await h.stop(log);
      throw new Error(`CDP ${cdp} did not answer within ${Math.round(cdpWaitMs / 1000)} s after the launcher started pid ${h.pid}`);
    }
  }
  return h;
}

// Checked stop (R1): never a no-op stopper call without our own start, never someone else's copy.
async function stopLauncher(h, log) {
  for (const t of h.timers) clearInterval(t);
  h.timers = [];
  let stopped = false;
  let why = "not started";
  if (h.started) {
    const lock = readLock(h.cfg.lockFile);
    if (lockIsOurs(lock, h.pid, h.port)) {
      log(`stopping copy pid ${h.pid} with ${h.cfg.stopper}`);
      const r = await runClosed(h.cfg.stopper, [], { timeout: 30000 });
      stopped = r.code === 0;
      why = stopped ? "stopped" : `stopper exit ${r.code}: ${(r.stdout + r.stderr).trim().slice(0, 200)}`;
      if (!stopped) log(why);
    } else {
      why = `lock ${lock ? JSON.stringify(lock) : "missing"} is not ours (pid ${h.pid}, port ${h.port}); not stopping`;
      log(why);
    }
  }
  h.stopped = stopped;
  h.exited = h.exited || !h.pid || !pidAlive(h.pid);
  // Logs into outDir before the profile goes.
  for (const t of h.tails) t.poll();
  if (h.started && h.outDir) {
    for (const [src, dst] of [[launcherLog(h.port), "electron.log"], [path.join(h.profile, "AimTrainer", "logs", "main.log"), "main.log"]]) {
      try {
        fs.copyFileSync(src, path.join(h.outDir, dst));
      } catch {}
    }
  }
  if (stopped && safeLauncherProfile(h.profile)) {
    try {
      fs.rmSync(h.profile, { recursive: true, force: true });
    } catch {}
  }
  return { stopped, why };
}

// Copy stopped by someone else (hp.sh app-stop, Soprano): our pid is gone and the lock no
// longer names us (R7).
export function preempted(h) {
  if (!h || h.mode !== "launcher" || !h.started || h.stopped) return false;
  if (pidAlive(h.pid)) return false;
  return !lockIsOurs(readLock(h.cfg.lockFile), h.pid, h.port);
}

// ---------------------------------------------------------------- direct mode (untested)
export async function startDirect({ profile, outDir, port, cdp, slotWaitMin = 30, log = console.log, onLine = () => {} }) {
  checkProfile(profile);
  const ELECTRON = electronPath(APP_DIR);
  if (!fs.existsSync(ELECTRON)) throw new Error(`electron not found at ${ELECTRON} (app/node_modules junction missing?)`);
  const slotRoot = process.env.SMOKE_SLOT_DIR || null;
  const h = { mode: "direct", slot: null, pid: null, child: null, guardPid: null, port: null, cdp: null, profile, tail: [], exited: false, exitCode: null, started: false };
  h.stop = once((lg) => stopDirect(h, lg || log));

  if (slotRoot) {
    h.slot = await takeSlot(slotRoot, { team: "qa-smoke", runner: process.pid, state: "launching", time: new Date().toISOString() }, {
      waitMs: slotWaitMin * 60000,
      everyMs: Number(process.env.SMOKE_SLOT_POLL_MS) || 60000,
      log,
    });
    log(`took app slot ${h.slot}`);
  }
  try {
    [h.port, h.cdp] = await pickPorts(port && cdp ? [port, cdp] : null);
    log(`ports: AIM ${h.port}, CDP ${h.cdp}`);
    fs.mkdirSync(profile, { recursive: true });
    const logStream = fs.createWriteStream(path.join(outDir, "electron.log"));
    const env = { ...process.env, AIM_HEADLESS: "1", AIM_PORT: String(h.port), AIM_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(ELECTRON, [`--remote-debugging-port=${h.cdp}`, APP_DIR], { env, cwd: APP_DIR, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    h.child = child;
    h.pid = child.pid;
    if (!h.pid) throw new Error("electron failed to spawn");
    h.started = true;
    const take = (buf) => {
      logStream.write(buf);
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        h.tail.push(line);
        if (h.tail.length > 40) h.tail.shift();
        onLine(line);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("exit", (code) => {
      h.exited = true;
      h.exitCode = code;
      logStream.end();
    });
    if (h.slot) writeOwner(h.slot, { team: "qa-smoke", pid: h.pid, runner: process.pid, cdp: h.cdp, port: h.port, time: new Date().toISOString() });
    log(`electron pid ${h.pid}`);
    const guard = spawn(process.execPath, [GUARD, String(process.pid), String(h.pid), h.slot || "-", String(h.cdp), profile, APP_DIR, path.join(outDir, "guard.log")], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    guard.unref();
    h.guardPid = guard.pid;
    return h;
  } catch (e) {
    await h.stop(log);
    throw e;
  }
}

async function stopDirect(h, log) {
  if (h.pid && pidAlive(h.pid)) {
    killTree(h.pid);
    for (let i = 0; i < 20 && pidAlive(h.pid); i++) await sleep(250);
  }
  if (h.cdp && h.pid) {
    for (const p of findLeftovers(h.cdp, [h.profile, APP_DIR])) {
      log(`killing leftover electron pid ${p.pid}`);
      killTree(p.pid);
    }
  }
  if (h.slot) {
    if (releaseSlot(h.slot, [process.pid, h.pid].filter(Boolean))) log(`released app slot ${h.slot}`);
    h.slot = null;
  }
  return { stopped: true, why: "killed" };
}

// ---------------------------------------------------------------- both
// Safe to call any number of times, concurrently too: one stop.
export async function stopApp(h, log = console.log) {
  if (!h || !h.stop) return { stopped: false, why: "no handle" };
  return h.stop(log);
}

export function appGone(h) {
  return !h || !h.pid || !pidAlive(h.pid);
}
