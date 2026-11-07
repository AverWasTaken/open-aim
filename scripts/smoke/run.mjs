// Headless in-app smoke suite: starts ONE hidden test copy of the app (AIM_HEADLESS=1,
// fresh profile, qa ports, app slot), drives it over CDP through the main user flows,
// and writes results.json, summary.txt and a screenshot per step.
//   cd app && npm run smoke [-- --only=boot,drills --skip=round --list --out=<dir> --profile=<dir>]
// Exit code 0 only if every step passed and no unexpected console/log errors happened.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, classifyError, shellLineIsError, fmtMs, sleep } from "./lib.mjs";
import { startApp, stopApp, appGone, REPO } from "./launch.mjs";
import { Cdp } from "./cdp.mjs";
import { STEPS, PAGE_LIB, recover } from "./steps.mjs";

const HELP = `npm run smoke -- [--only=a,b] [--skip=a,b] [--list] [--out=dir] [--profile=dir] [--port=N --cdp=N] [--max-minutes=20] [--slot-wait=30]`;

let opts;
try {
  opts = parseArgs(process.argv.slice(2), process.env);
} catch (e) {
  console.error(String(e.message || e));
  console.error(HELP);
  process.exit(2);
}
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
const names = STEPS.map((s) => s.name);
if (opts.list) {
  for (const s of STEPS) console.log(`${s.name.padEnd(22)} ${s.about || ""}`);
  process.exit(0);
}
for (const n of [...(opts.only || []), ...opts.skip]) {
  if (!names.includes(n) && !names.some((x) => x.startsWith(n + ":"))) {
    console.error(`unknown step "${n}". Steps: ${names.join(", ")}`);
    process.exit(2);
  }
}
// "drill" in --only/--skip matches every drill:<chip> step.
const pick = (list, name) => list.some((n) => n === name || name.startsWith(n + ":"));
const selected = STEPS.filter((s) => (!opts.only || pick(opts.only, s.name) || s.always) && !pick(opts.skip, s.name));

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const HQ = "C:\\Users\\Jacob\\open-aim-hq";
const outDir = path.resolve(opts.out || (fs.existsSync(path.join(HQ, "shots", "qa")) ? path.join(HQ, "shots", "qa", `smoke-${stamp}`) : path.join(REPO, "app", "smoke-out", `smoke-${stamp}`)));
fs.mkdirSync(outDir, { recursive: true });
const freshProfile = !opts.profile;
const profile = path.resolve(opts.profile || (fs.existsSync(path.join(HQ, "profiles")) ? path.join(HQ, "profiles", "qa", `smoke-${stamp}`) : path.join(REPO, "app", "smoke-out", `profile-${stamp}`)));

const t0 = Date.now();
const logFile = path.join(outDir, "run.log");
const log = (s) => {
  const line = `[${fmtMs(Date.now() - t0).padStart(7)}] ${s}`;
  console.log(line);
  fs.appendFileSync(logFile, line + "\n");
};

let app = null;
let cdp = null;
let finishing = false;
const results = [];

async function cleanup(why) {
  if (app) {
    log(`cleanup (${why}): stopping app pid ${app.pid}`);
    try {
      cdp?.close();
    } catch {}
    const a = app;
    app = null;
    await stopApp(a, log);
  }
}

async function bail(code, why) {
  if (finishing) return;
  finishing = true;
  log(`ABORT: ${why}`);
  await cleanup(why);
  process.exit(code);
}
process.on("SIGINT", () => bail(130, "SIGINT"));
process.on("SIGTERM", () => bail(143, "SIGTERM"));
process.on("SIGBREAK", () => bail(131, "SIGBREAK"));
process.on("uncaughtException", (e) => bail(1, "uncaught " + (e.stack || e)));
process.on("unhandledRejection", (e) => bail(1, "unhandled rejection " + (e?.stack || e)));
const hard = setTimeout(() => bail(3, `hard timeout ${opts.maxMinutes} min`), opts.maxMinutes * 60000);
hard.unref?.();

function stepErrors(name) {
  return cdp.errors.filter((e) => e.step === name);
}

async function runStep(step, idx) {
  const nn = String(idx + 1).padStart(2, "0");
  const shot = path.join(outDir, `${nn}-${step.name.replace(/[^a-z0-9-]+/gi, "_")}.png`);
  const r = { step: step.name, status: "pass", ms: 0, notes: [], warnings: [], errors: [], screenshot: null };
  cdp.step = step.name;
  const ctx = {
    cdp, log: (s) => log(`  ${step.name}: ${s}`), opts, outDir, aborted: false, results, app,
    note: (s) => r.notes.push(s), warn: (s) => (r.warnings.push(s), log(`  ${step.name}: WARN ${s}`)),
    shot: async (suffix) => cdp.screenshot(path.join(outDir, `${nn}-${step.name.replace(/[^a-z0-9-]+/gi, "_")}-${suffix}.png`)).catch(() => null),
    check() {
      if (this.aborted) throw new Error("step aborted (timeout)");
      if (cdp.crashed) throw new Error("renderer crashed");
      if (app && appGone(app)) throw new Error("app process exited");
    },
  };
  const s0 = Date.now();
  log(`> ${step.name}`);
  let timer;
  try {
    await Promise.race([
      step.run(ctx),
      new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`timed out after ${Math.round(step.timeoutMs / 1000)} s`)), step.timeoutMs))),
    ]);
  } catch (e) {
    r.status = "fail";
    r.errors.push(String(e.message || e).split("\n")[0]);
  } finally {
    clearTimeout(timer);
    ctx.aborted = true;
  }
  r.ms = Date.now() - s0;
  try {
    r.screenshot = await cdp.screenshot(shot);
  } catch {}
  // Console / log / exception errors seen during this step.
  await sleep(300);
  for (const e of stepErrors(step.name)) {
    const c = classifyError(e);
    const line = `${e.kind}${e.level === "warning" ? "(warning)" : ""}: ${e.text}${e.url ? " @ " + e.url : ""}`;
    if (c === "fail") {
      r.status = "fail";
      r.errors.push("unexpected " + line);
    } else if (c === "warn") {
      if (!r.warnings.includes(line)) r.warnings.push(line);
    }
  }
  r.warnings = [...new Set(r.warnings)];
  if (ctx.keepState && r.status === "pass") r.keepState = true; // next step continues from here
  log(`< ${step.name}: ${r.status.toUpperCase()} in ${fmtMs(r.ms)}${r.errors.length ? " - " + r.errors.join(" | ") : ""}`);
  return r;
}

function writeReports(extra) {
  const pass = results.every((r) => r.status === "pass") && results.length > 0;
  const out = { pass, startedAt: new Date(t0).toISOString(), totalMs: Date.now() - t0, outDir, profile, ports: app ? { aim: app.port, cdp: app.cdp } : extra.ports, ...extra, steps: results };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(out, null, 2));
  const rows = results.map((r) => `${r.status.toUpperCase().padEnd(7)} ${r.step.padEnd(22)} ${fmtMs(r.ms).padStart(7)}  ${[...r.errors, ...r.notes.map((n) => "note: " + n), ...r.warnings.slice(0, 3).map((w) => "warn: " + w)].join(" ; ").slice(0, 300)}`);
  const text = [
    `open-aim smoke ${pass ? "PASSED" : "FAILED"}  total ${fmtMs(out.totalMs)}  (${results.filter((r) => r.status === "pass").length}/${results.length} steps pass)`,
    `out: ${outDir}`,
    `profile: ${profile}${extra.profileKept ? " (kept)" : " (deleted)"}`,
    ...(extra.fatal ? [`FATAL: ${extra.fatal}`] : []),
    "",
    ...rows,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "summary.txt"), text);
  return { pass, text };
}

async function main() {
  log(`smoke: ${selected.length} steps -> ${outDir}`);
  log(`profile ${profile}`);
  let fatal = null;
  let ports = null;
  try {
    app = await startApp({
      profile, outDir, port: opts.port, cdp: opts.cdp, slotWaitMin: opts.slotWait, log,
      onLine: (line) => {
        if (shellLineIsError(line) && cdp) cdp.errors.push({ step: cdp.step, kind: "shell", level: "error", text: "electron: " + line.slice(0, 400), url: "", t: Date.now() });
      },
    });
    ports = { aim: app.port, cdp: app.cdp };
    cdp = new Cdp({ cdpPort: app.cdp, aimPort: app.port, log });
    // Attach early so boot errors are caught; fail fast if electron dies.
    await Promise.race([
      cdp.attach(120000),
      (async () => {
        while (!app.exited) await sleep(250);
        throw new Error(`electron exited early (code ${app.exitCode}):\n${app.tail.slice(-15).join("\n")}`);
      })(),
    ]);
    await cdp.addOnNewDocument(PAGE_LIB);
    await cdp.evaluate(PAGE_LIB).catch(() => {}); // current document too
    let crashedAt = null;
    for (let i = 0; i < selected.length; i++) {
      const step = selected[i];
      if (crashedAt) {
        results.push({ step: step.name, status: "skipped", ms: 0, notes: [], warnings: [], errors: [`skipped: ${crashedAt}`], screenshot: null });
        continue;
      }
      const r = await runStep(step, i);
      results.push(r);
      if (cdp.crashed) crashedAt = "renderer crashed";
      else if (appGone(app)) crashedAt = `app exited (code ${app.exitCode})`;
      if (crashedAt) {
        r.errors.push(crashedAt);
        r.status = "fail";
        continue;
      }
      // Back to a clean lobby before the next step (plan S14); not after the last one.
      if (i < selected.length - 1 && !r.keepState) {
        cdp.step = `recover:${step.name}`;
        const rec = await recover(cdp, { log: (s) => log(`  recover: ${s}`), force: r.status !== "pass" }).catch((e) => ({ ok: false, why: String(e.message || e) }));
        if (!rec.ok) {
          r.status = "fail";
          r.errors.push(`recovery to lobby failed: ${rec.why}`);
          log(`  recover FAILED: ${rec.why}`);
        }
        await sleep(200);
        for (const e of stepErrors(cdp.step)) {
          if (classifyError(e) === "fail") {
            r.status = "fail";
            r.errors.push(`unexpected (while returning to lobby) ${e.kind}: ${e.text}${e.url ? " @ " + e.url : ""}`);
          }
        }
      }
    }
  } catch (e) {
    fatal = String(e.message || e);
    log(`FATAL: ${fatal}`);
  }
  if (app) ports = { aim: app.port, cdp: app.cdp };
  await cleanup("run finished");
  if (fatal) results.push({ step: "harness", status: "fail", ms: 0, notes: [], warnings: [], errors: [fatal], screenshot: null });
  let profileKept = true;
  const allPass = !fatal && results.length > 0 && results.every((r) => r.status === "pass");
  if (allPass && freshProfile) {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        profileKept = false;
        break;
      } catch {
        await sleep(500);
      }
    }
  }
  const { pass, text } = writeReports({ fatal, ports, profileKept });
  console.log("\n" + text);
  return pass ? 0 : 1;
}

const code = await main();
finishing = true;
clearTimeout(hard);
process.exit(code);
