// Detached cleanup guard for the smoke runner. Two modes:
//
// Launcher mode (hp):  node guard.mjs launcher '<json>'
//   json = {runner, pid, port, stopper, lockFile, profile, capMs, log}
//   Watches only the runner pid. When the runner is gone (killed, ssh dropped) or the cap
//   (max-minutes + 3) is reached, it runs the stopper, but only while the lock file still
//   names OUR electron pid on OUR port (plan S2 R1/R6). It never kills anything itself.
//   It exits on its own once the copy is gone or no longer ours.
//
// Direct mode:  node guard.mjs <runnerPid> <electronPid> <slotDir|-> <cdpPort> <profileDir> <appDir> [logFile]
//   `taskkill /F` on the runner skips its finally/signal handlers on Windows, so this
//   process watches it. When the runner is gone it kills the electron tree it started,
//   any leftover electron.exe that has our --remote-debugging-port AND our profile or app
//   path on its command line, and removes the slot dir (only if it is still ours).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pidAlive, releaseSlot, readOwner, sleep, findLeftovers, killTree, readLock, lockIsOurs, safeLauncherProfile } from "./lib.mjs";

let logFile = null;
const log = (s) => {
  try {
    if (logFile) fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);
  } catch {}
};

// ---------------------------------------------------------------- launcher mode
function runStopper(stopper) {
  return new Promise((resolve) => {
    execFile("bash", ["-c", 'exec 8>&- 9>&-; exec "$0" "$@"', stopper], { timeout: 30000, encoding: "utf8" }, (err, out) => resolve({ code: err ? err.code ?? null : 0, out: String(out || "").trim() }));
  });
}

export async function guardLauncher(c, { pollMs = 1000 } = {}) {
  logFile = c.log || null;
  log(`guard (launcher) up: runner=${c.runner} electron=${c.pid} port=${c.port} cap=${Math.round(c.capMs / 60000)} min`);
  const t0 = Date.now();
  for (;;) {
    const ours = () => lockIsOurs(readLock(c.lockFile), c.pid, c.port);
    if (!pidAlive(c.pid) && !ours()) {
      log("copy gone and lock not ours: guard exits");
      return "gone";
    }
    const runnerGone = !pidAlive(c.runner);
    const capped = Date.now() - t0 > c.capMs;
    if (runnerGone || capped) {
      log(runnerGone ? "runner gone" : "cap reached");
      if (ours()) {
        const r = await runStopper(c.stopper);
        log(`stopper exit ${r.code}: ${r.out}`);
        if (r.code === 0 && safeLauncherProfile(c.profile)) {
          try {
            fs.rmSync(c.profile, { recursive: true, force: true });
          } catch {}
        }
        return "stopped";
      }
      log("lock not ours: nothing to stop");
      return "not-ours";
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------- direct mode
async function guardDirect([runnerPid, electronPid, slotArg, cdpPort, profileDir, appDir, logArg]) {
  const slotDir = slotArg && slotArg !== "-" ? slotArg : null;
  logFile = logArg || null;
  const slotStillOurs = () => {
    if (!slotDir || !fs.existsSync(slotDir)) return false;
    const o = readOwner(slotDir);
    return !o || o.pids.includes(Number(runnerPid)) || o.pids.includes(Number(electronPid));
  };
  log(`guard up: runner=${runnerPid} electron=${electronPid} slot=${slotDir} cdp=${cdpPort}`);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 60 * 60 * 1000) return log("guard: 60 min cap reached, exiting");
    const runnerUp = pidAlive(runnerPid);
    const electronUp = pidAlive(electronPid);
    if (!runnerUp) {
      log("runner gone: cleaning up");
      if (electronUp) killTree(electronPid);
      await sleep(1000);
      for (const p of findLeftovers(cdpPort, [profileDir, appDir])) {
        log(`killing leftover pid ${p.pid}`);
        killTree(p.pid);
      }
      if (slotStillOurs()) releaseSlot(slotDir, [runnerPid, electronPid]) && log("slot released");
      log("guard done");
      return;
    }
    if (!electronUp && !slotStillOurs()) {
      log("electron dead and slot released: guard exits");
      return;
    }
    await sleep(2000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // Ignore hangups from a dropped ssh session; we are detached anyway.
  process.on("SIGHUP", () => {});
  const p = args[0] === "launcher" ? guardLauncher(JSON.parse(args[1])) : guardDirect(args);
  p.catch((e) => log("guard error " + (e.stack || e)));
}
