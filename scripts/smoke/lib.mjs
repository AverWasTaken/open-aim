// Shared helpers for the smoke suite: app slots, port checks, arg parsing and the
// console/network error allowlist. No side effects on import, so lib.test.mjs can
// test it without launching anything.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";

export const DEFAULT_SLOT_DIR = "C:\\Users\\Jacob\\open-aim-hq\\app-slots";
export const SLOT_NAMES = ["slot1", "slot2", "slot3"];
// qa owns 8270-8279 / 9470-9479; 8271-8274 / 9471-9474 belong to other qa children.
export const PORT_PAIRS = [[8270, 9470], [8275, 9475], [8276, 9476], [8277, 9477], [8278, 9478], [8279, 9479]];

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

// ---------------------------------------------------------------- slots
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
  if (!(o.maxMinutes > 0)) throw new Error("bad --max-minutes");
  if (!(o.slotWait >= 0)) throw new Error("bad --slot-wait");
  return o;
}

// Profile must never be the user's real save.
export function checkProfile(dir, appData = process.env.APPDATA || "") {
  const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, "");
  if (appData) {
    const real = norm(path.join(appData, "AimTrainer"));
    const d = norm(dir);
    if (d === real || d.startsWith(real + path.sep) || d === norm(appData)) throw new Error(`profile ${dir} is the user's real save; refusing`);
  }
  return dir;
}

// ---------------------------------------------------------------- errors
// Known benign noise (driving-map item 11). Each entry: {why, test(entry)}.
// entry = {kind: 'exception'|'console'|'log'|'shell', level, text, url}
const KNOWN_404 = [
  /\/prod-api\/api\/v1\/public\/val\/aimlab\/desktop-seen(\?|$)/,
  /\/aimlab\/plays\/workshop\/[^/?]+(\?|$)/,
  /\/aimlab\/lock-events(\?|$)/,
];
const SHELL_SCRIPT_PREFIX = /^[A-Z][A-Z0-9 ]{2,}:/; // "ROUND HUD:", "STARTUP SCREEN:" (main.js UI script wrappers)

// Returns 'fail' | 'warn' | 'ignore'.
export function classifyError(e) {
  const text = String(e.text || "");
  const url = String(e.url || "");
  if (e.kind === "exception") return "fail";
  if (e.kind === "shell") return "fail"; // electron stdout line from a broken shell script
  if (e.level === "warning" || e.level === "warn" || e.level === "verbose" || e.level === "info") return "warn";
  // error level from here on
  if (SHELL_SCRIPT_PREFIX.test(text)) return "fail";
  const is404 = /status of 404/.test(text) || e.status === 404;
  if (is404 && KNOWN_404.some((re) => re.test(url))) return "ignore";
  return "fail";
}

// Lines in electron stdout that mean a shell (main process / injected script) problem.
export function shellLineIsError(line) {
  return /^(UI SCRIPTS|STARTUP SCREEN|SHELL SETTINGS|SHOT GRAPH):/.test(line) || /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(line);
}

export function fmtMs(ms) {
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s` : `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------- processes
export function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 20000 });
  } catch {}
}

// electron.exe processes whose command line has --remote-debugging-port=<cdp> AND one of
// `marks` (our profile dir or our app dir). Never matches the user's own app (no CDP port).
export function findLeftovers(cdpPort, marks) {
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
