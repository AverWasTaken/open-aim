// Detached cleanup guard for the smoke runner (plan S1).
//   node guard.mjs <runnerPid> <electronPid> <slotDir|-> <cdpPort> <profileDir> <appDir> [logFile]
// `taskkill /F` on the runner skips its finally/signal handlers on Windows, so this
// process watches it. When the runner is gone it kills the electron tree it started,
// any leftover electron.exe that has our --remote-debugging-port AND our profile or app
// path on its command line, and removes the slot dir (only if it is still ours).
// It exits on its own once electron is dead and the slot is released.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive, releaseSlot, readOwner, sleep, findLeftovers, killTree } from "./lib.mjs";

const [runnerPid, electronPid, slotArg, cdpPort, profileDir, appDir, logArg] = process.argv.slice(2);
const slotDir = slotArg && slotArg !== "-" ? slotArg : null;
const logFile = logArg || null;
const log = (s) => {
  try {
    if (logFile) fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);
  } catch {}
};

function slotStillOurs() {
  if (!slotDir || !fs.existsSync(slotDir)) return false;
  const o = readOwner(slotDir);
  return !o || o.pids.includes(Number(runnerPid)) || o.pids.includes(Number(electronPid));
}

async function main() {
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
  main().catch((e) => log("guard error " + e));
}
