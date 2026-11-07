// Shared helpers for the smoke suite: launcher output and lock parsing (hp), app slots
// (direct mode), port checks, arg parsing and the console/log error allowlist. No side
// effects on import, so lib.test.mjs can test it without launching anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";

// Direct mode only: app slots are used when SMOKE_SLOT_DIR is set (no default; the old
// open-aim-hq app-slots folder is retired).
export const SLOT_NAMES = ["slot1", "slot2", "slot3"];
// qa owns 8270-8279 / 9470-9479; 8271-8274 / 9471-9474 belong to other qa children.
export const PORT_PAIRS = [[8270, 9470], [8275, 9475], [8276, 9476], [8277, 9477], [8278, 9478], [8279, 9479]];
export const DEFAULT_PORTS = [8270, 9470];

// Exit codes of npm run smoke (qa-smoke.sh passes them through).
export const EXIT = { pass: 0, fail: 1, badArgs: 2, timeout: 3, busy: 4, sshGone: 5 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pidAlive(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

// ---------------------------------------------------------------- hp launcher mode
// On hp the app is started only by ~/hp-share/openaim-start.sh (it owns the one-copy lock,
// the Soprano/load checks, xvfb and the profile path) and stopped only by openaim-stop.sh.
// Launcher mode is on when SMOKE_LAUNCHER names the start script, or on Linux when
// $HOME/hp-share/openaim-start.sh exists. The stopper and the lock live next to the start script.
export function launcherConfig({ env = process.env, platform = process.platform, home = os.homedir(), exists = fs.existsSync } = {}) {
  let starter = env.SMOKE_LAUNCHER || null;
  if (!starter && platform === "linux") {
    const p = path.join(home, "hp-share", "openaim-start.sh");
    if (exists(p)) starter = p;
  }
  if (!starter) return null;
  const dir = path.dirname(starter);
  return { starter, stopper: path.join(dir, "openaim-stop.sh"), lockFile: path.join(dir, "openaim.lock"), lockDir: path.join(dir, "openaim.lock.d") };
}

// The launcher fixes the profile at /tmp/openaim-profile-<port>. Only a path of exactly
// that shape may ever be deleted by the suite.
export const LAUNCHER_PROFILE_RE = /^\/tmp\/openaim-profile-\d+$/;
export const launcherProfile = (port) => `/tmp/openaim-profile-${port}`;
export const launcherLog = (port) => `/tmp/openaim-${port}.log`;
export const safeLauncherProfile = (p) => typeof p === "string" && LAUNCHER_PROFILE_RE.test(p);

// openaim-start.sh stdout + exit code ->
//   {kind:'started', pid, cdpReady} | {kind:'busy', why} | {kind:'badapp'} | {kind:'garbage', text, code}
export function parseLauncherOutput(stdout, code) {
  const text = String(stdout || "").trim();
  if (code === 10) {
    const m = text.match(/^busy\b\s*(.*)$/m);
    return { kind: "busy", why: (m && m[1].trim()) || text || "busy" };
  }
  if (code === 12) return { kind: "badapp" };
  if (code === 0) {
    const m = text.match(/^started (\d+)( \(cdp not answering yet\))?\s*$/m);
    if (m && Number(m[1]) > 1) return { kind: "started", pid: Number(m[1]), cdpReady: !m[2] };
  }
  return { kind: "garbage", text: text.slice(0, 300), code };
}

// ~/hp-share/openaim.lock: line 1 = pid, line 2 = "open-aim <time> port <aim> cdp <cdp>".
export function parseLock(text) {
  if (text == null) return null;
  const lines = String(text).split(/\r?\n/);
  const first = lines[0].trim();
  const pid = /^\d+$/.test(first) ? Number(first) : null;
  const port = (lines[1] || "").match(/\bport (\d+)\b/);
  const cdp = (lines[1] || "").match(/\bcdp (\d+)\b/);
  return { pid, port: port ? Number(port[1]) : null, cdp: cdp ? Number(cdp[1]) : null };
}

export function readLock(file) {
  try {
    return parseLock(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// We may stop the copy only while the lock still names OUR electron pid on OUR port
// (plan R1). Known limit: someone could stop + restart between this check and the stopper
// call (a gap of milliseconds); the stopper itself reads the lock again.
export function lockIsOurs(lock, pid, port) {
  return !!lock && lock.pid != null && lock.pid === Number(pid) && lock.port === Number(port);
}

// One shared promise: concurrent callers (signal handler + finally) run fn once.
export function once(fn) {
  let p = null;
  return (...args) => (p ||= Promise.resolve().then(() => fn(...args)));
}

// Electron binary inside app/node_modules for this platform (direct mode).
export function electronPath(appDir, platform = process.platform) {
  return path.join(appDir, "node_modules", "electron", "dist", platform === "win32" ? "electron.exe" : "electron");
}

// Final exit code of a run.
export function exitCodeFor({ badArgs = false, busy = false, preempted = false, sshGone = false, timedOut = false, pass = false } = {}) {
  if (badArgs) return EXIT.badArgs;
  if (sshGone) return EXIT.sshGone;
  if (busy || preempted) return EXIT.busy;
  if (timedOut) return EXIT.timeout;
  return pass ? EXIT.pass : EXIT.fail;
}

// main.log lines look like "<ISO time> ERROR <message>"; continuation lines (stacks) have no
// prefix. Returns the message of an ERROR line, or null. "PAGE ERROR:" lines are the page's
// own console errors, which CDP already reports (and the allowlist judges), so they are
// not counted twice.
export function mainLogError(line) {
  const m = String(line).match(/^\d{4}-\d\d-\d\dT[\d:.]+Z ERROR (.*)$/);
  if (!m) return null;
  if (/^PAGE ERROR: /.test(m[1])) return null;
  return m[1];
}

// ---------------------------------------------------------------- slots (direct mode)
// Slot owner.txt lines look like "team=qa smoke pid=123 ..." (other teams write PID=123).
export function readOwner(slotPath) {
  const f = path.join(slotPath, "owner.txt");
  let text, mtimeMs;
  try {
    text = fs.readFileSync(f, "utf8");
    mtimeMs = fs.statSync(f).mtimeMs;
  } catch {
    return null;
  }
  const pids = [...text.matchAll(/\b(?:pid|runner)=(\d+)/gi)].map((m) => Number(m[1]));
  return { text, mtimeMs, pids };
}

// A slot is stale (free to take over) when:
//  - owner.txt exists, is older than 2 min, and every pid in it is dead; or
//  - there is no owner.txt and the slot dir itself is older than 5 min.
export function slotIsStale(slotPath, now = Date.now(), alive = pidAlive) {
  const owner = readOwner(slotPath);
  if (owner) {
    if (now - owner.mtimeMs < 2 * 60 * 1000) return false;
    if (!owner.pids.length) return false; // can't tell; treat as taken
    return owner.pids.every((p) => !alive(p));
  }
  let st;
  try {
    st = fs.statSync(slotPath);
  } catch {
    return false; // gone: not stale, just free (mkdir will tell)
  }
  return now - st.mtimeMs > 5 * 60 * 1000;
}

export function writeOwner(slotPath, fields) {
  const line = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ");
  fs.writeFileSync(path.join(slotPath, "owner.txt"), line + "\n");
}

// One attempt over slot1..3. Returns the slot path or null.
export function tryTakeSlot(root, ownerFields, { now = Date.now(), alive = pidAlive, log = () => {} } = {}) {
  for (const name of SLOT_NAMES) {
    const p = path.join(root, name);
    try {
      fs.mkdirSync(p); // atomic: fails if it exists
      writeOwner(p, ownerFields);
      return p;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (slotIsStale(p, now, alive)) {
      // Take over: remove and re-create atomically; if someone else beat us, move on.
      log(`slot ${name} looks stale (owner dead), taking it over`);
      try {
        fs.rmSync(p, { recursive: true, force: true });
        fs.mkdirSync(p);
        writeOwner(p, ownerFields);
        return p;
      } catch {}
    }
  }
  return null;
}

// Wait for a slot, checking every `everyMs` (>= 60 s on the real machine), up to waitMs.
export async function takeSlot(root, ownerFields, { waitMs = 30 * 60 * 1000, everyMs = 60000, log = () => {} } = {}) {
  if (!fs.existsSync(root)) throw new Error(`slot root ${root} does not exist`);
  const t0 = Date.now();
  for (;;) {
    const p = tryTakeSlot(root, ownerFields, { log });
    if (p) return p;
    if (Date.now() - t0 + everyMs > waitMs) throw new Error(`no free app slot in ${root} after ${Math.round((Date.now() - t0) / 1000)} s (all 3 taken)`);
    log(`all app slots taken; next check in ${Math.round(everyMs / 1000)} s`);
    await sleep(everyMs);
  }
}

// Remove the slot only if it is still ours (owner.txt mentions one of our pids).
export function releaseSlot(slotPath, ourPids) {
  if (!slotPath) return false;
  const owner = readOwner(slotPath);
  if (owner && !owner.pids.some((p) => ourPids.map(Number).includes(p))) return false;
  try {
    fs.rmSync(slotPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- ports
export function portOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// First pair whose AIM and CDP ports are both free. `preferred` = [port, cdp] from args/env.
export async function pickPorts(preferred, isOpen = portOpen) {
  const pairs = preferred ? [preferred] : PORT_PAIRS;
  for (const [port, cdp] of pairs) {
    if (port === 8000 || cdp === 8000) throw new Error("port 8000 is the user's real app; refusing");
    if (!(await isOpen(port)) && !(await isOpen(cdp))) return [port, cdp];
  }
  throw new Error(`no free AIM/CDP port pair among ${pairs.map((p) => p.join("/")).join(", ")}`);
}

// ---------------------------------------------------------------- args
export function parseArgs(argv, env = {}) {
  const o = { only: null, skip: [], list: false, out: null, profile: null, port: null, cdp: null, maxMinutes: 20, slotWait: 30, help: false };
  const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let val = null;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      val = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const next = () => {
      if (val !== null) return val;
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "--only": o.only = list(next()); break;
      case "--skip": o.skip = list(next()); break;
      case "--list": o.list = true; break;
      case "--out": o.out = next(); break;
      case "--profile": o.profile = next(); break;
      case "--port": o.port = Number(next()); break;
      case "--cdp": o.cdp = Number(next()); break;
      case "--max-minutes": o.maxMinutes = Number(next()); break;
      case "--slot-wait": o.slotWait = Number(next()); break;
      case "-h": case "--help": o.help = true; break;
      case "--keep-open": throw new Error("--keep-open is not allowed (no idle test copies)");
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (o.port == null && env.SMOKE_PORT) o.port = Number(env.SMOKE_PORT);
  if (o.cdp == null && env.SMOKE_CDP) o.cdp = Number(env.SMOKE_CDP);
  if ((o.port == null) !== (o.cdp == null)) throw new Error("give both --port and --cdp (or neither)");
  for (const k of ["port", "cdp"]) {
    if (o[k] != null && !(Number.isInteger(o[k]) && o[k] > 1024 && o[k] < 65536)) throw new Error(`bad --${k}`);
  }
  if (o.port === 8000 || o.cdp === 8000) throw new Error("port 8000 is the user's real app; refusing");
  if (!(o.maxMinutes > 0 && o.maxMinutes <= 25)) throw new Error("bad --max-minutes (allowed: more than 0, at most 25)");
  if (!(o.slotWait >= 0)) throw new Error("bad --slot-wait");
  return o;
}

// Profile must never be the user's real save: %APPDATA%\AimTrainer on Windows,
// ~/.config/AimTrainer (or $XDG_CONFIG_HOME/AimTrainer) on Linux, nor those parent folders.
export function checkProfile(dir, appData = process.env.APPDATA || "", { home = os.homedir(), xdg = process.env.XDG_CONFIG_HOME || "" } = {}) {
  // Compare with forward slashes only, so Windows-style paths behave the same on Linux (tests).
  const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const d = norm(dir);
  const saves = [];
  const parents = [];
  if (appData) saves.push(path.join(appData, "AimTrainer")), parents.push(appData);
  if (home) saves.push(path.join(home, ".config", "AimTrainer")), parents.push(path.join(home, ".config"));
  if (xdg) saves.push(path.join(xdg, "AimTrainer")), parents.push(xdg);
  for (const s of saves) {
    const n = norm(s);
    if (d === n || d.startsWith(n + "/")) throw new Error(`profile ${dir} is the user's real save; refusing`);
  }
  for (const p of parents) if (d === norm(p)) throw new Error(`profile ${dir} is the user's real save folder; refusing`);
  return dir;
}

// ---------------------------------------------------------------- errors
// Allowlist for page console / log errors. Keep it short; every entry says why.
// entry = {kind: 'exception'|'console'|'log'|'shell', level, text, url}
// hpOnly: noise seen only on the hidden hp copies (xvfb + software WebGL), never on a real PC.
export const ALLOW = [
  { why: "offline build: the desktop-seen ping has no server (driving map 11)", test: (e) => is404(e) && /\/prod-api\/api\/v1\/public\/val\/aimlab\/desktop-seen(\?|$)/.test(e.url) },
  { why: "offline build: play counter for a workshop drill has no server (driving map 11)", test: (e) => is404(e) && /\/aimlab\/plays\/workshop\/[^/?]+(\?|$)/.test(e.url) },
  { why: "offline build: pointer-lock telemetry has no server (driving map 11)", test: (e) => is404(e) && /\/aimlab\/lock-events(\?|$)/.test(e.url) },
];
const is404 = (e) => /status of 404/.test(String(e.text || "")) || e.status === 404;
const SHELL_SCRIPT_PREFIX = /^[A-Z][A-Z0-9 ]{2,}:/; // "ROUND HUD:", "STARTUP SCREEN:" (main.js UI script wrappers)

// Returns 'fail' | 'warn' | 'ignore'.
export function classifyError(e) {
  const text = String(e.text || "");
  if (e.kind === "exception") return "fail";
  if (e.kind === "shell") return ALLOW.some((a) => a.shell && a.test(e)) ? "ignore" : "fail"; // main.log ERROR / shell problem
  if (e.level === "warning" || e.level === "warn" || e.level === "verbose" || e.level === "info") return "warn";
  // error level from here on
  if (SHELL_SCRIPT_PREFIX.test(text)) return "fail";
  if (ALLOW.some((a) => !a.shell && a.test({ ...e, url: String(e.url || "") }))) return "ignore";
  return "fail";
}

// Lines in electron stdout (direct mode) that mean a shell (main process / injected script) problem.
export function shellLineIsError(line) {
  return /^(UI SCRIPTS|STARTUP SCREEN|SHELL SETTINGS|SHOT GRAPH):/.test(line) || /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(line);
}

export function fmtMs(ms) {
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s` : `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------- processes (direct mode only)
// Launcher mode never calls these: it stops the copy only through openaim-stop.sh.
export function killTree(pid) {
  if (process.platform !== "win32") {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {}
    return;
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 20000 });
  } catch {}
}

// electron.exe processes whose command line has --remote-debugging-port=<cdp> AND one of
// `marks` (our profile dir or our app dir). Never matches the user's own app (no CDP port).
// Windows only; direct mode elsewhere (untested) relies on killTree of the child.
export function findLeftovers(cdpPort, marks) {
  if (process.platform !== "win32") return [];
  const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
  let out = "";
  try {
    out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  } catch {
    return [];
  }
  const low = (s) => String(s || "").toLowerCase();
  const ms = marks.filter(Boolean).map((p) => low(path.resolve(p)));
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const i = l.indexOf("|");
    return { pid: Number(l.slice(0, i)), cmd: low(l.slice(i + 1)) };
  }).filter((p) => p.cmd.includes(`--remote-debugging-port=${cdpPort}`) && ms.some((m) => p.cmd.includes(m)));
}
