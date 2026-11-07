// Fast unit tests for the smoke suite helpers (npm run test:smokelib). Never launches electron.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  tryTakeSlot, takeSlot, releaseSlot, slotIsStale, readOwner, writeOwner,
  parseArgs, classifyError, shellLineIsError, checkProfile, pickPorts, portOpen,
} from "./lib.mjs";

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
