// Starts one hidden (AIM_HEADLESS=1) test copy of the app for the smoke suite and
// cleans it up. Takes an app slot first, picks a free qa port pair, spawns electron,
// and starts a detached guard (guard.mjs) that cleans up if this process is killed hard.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SLOT_DIR, takeSlot, writeOwner, releaseSlot, pickPorts, checkProfile,
  pidAlive, killTree, findLeftovers, sleep,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const APP_DIR = path.join(REPO, "app");
export const ELECTRON = path.join(APP_DIR, "node_modules", "electron", "dist", "electron.exe");

export async function startApp({ profile, outDir, port, cdp, slotWaitMin = 30, log = console.log, onLine = () => {} }) {
  checkProfile(profile);
  if (!fs.existsSync(ELECTRON)) throw new Error(`electron not found at ${ELECTRON} (app/node_modules junction missing?)`);
  const slotRoot = process.env.SMOKE_SLOT_DIR || DEFAULT_SLOT_DIR;
  const h = { slot: null, pid: null, child: null, guardPid: null, port: null, cdp: null, profile, tail: [], exited: false, exitCode: null };

  // 1. App slot (machine-wide cap of 3 test copies). owner.txt right away (plan S9).
  h.slot = await takeSlot(slotRoot, { team: "qa-smoke", runner: process.pid, state: "launching", time: new Date().toISOString() }, {
    waitMs: slotWaitMin * 60000,
    everyMs: Number(process.env.SMOKE_SLOT_POLL_MS) || 60000,
    log,
  });
  log(`took app slot ${h.slot}`);
  try {
    // 2. Ports: free pair in the qa range (or the one given).
    [h.port, h.cdp] = await pickPorts(port && cdp ? [port, cdp] : null);
    log(`ports: AIM ${h.port}, CDP ${h.cdp}`);

    // 3. Spawn electron, hidden, low priority (main.js handles AIM_HEADLESS).
    fs.mkdirSync(profile, { recursive: true });
    const logStream = fs.createWriteStream(path.join(outDir, "electron.log"));
    const env = { ...process.env, AIM_HEADLESS: "1", AIM_PORT: String(h.port), AIM_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(ELECTRON, [`--remote-debugging-port=${h.cdp}`, APP_DIR], { env, cwd: APP_DIR, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    h.child = child;
    h.pid = child.pid;
    if (!h.pid) throw new Error("electron failed to spawn");
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
    writeOwner(h.slot, { team: "qa-smoke", pid: h.pid, runner: process.pid, cdp: h.cdp, port: h.port, time: new Date().toISOString() });
    log(`electron pid ${h.pid}`);

    // 4. Guard: survives `taskkill /F` on this runner.
    const guard = spawn(process.execPath, [path.join(HERE, "guard.mjs"), String(process.pid), String(h.pid), h.slot, String(h.cdp), profile, APP_DIR, path.join(outDir, "guard.log")], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    guard.unref();
    h.guardPid = guard.pid;
    return h;
  } catch (e) {
    await stopApp(h, log);
    throw e;
  }
}

// Kill the electron tree we started, anything left with our CDP port + profile/app path,
// and release the slot. Safe to call twice.
export async function stopApp(h, log = console.log) {
  if (!h) return;
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
}

export function appGone(h) {
  return !h.pid || !pidAlive(h.pid);
}
