// Headless in-app smoke suite: starts ONE hidden test copy of the app (AIM_HEADLESS=1,
// fresh profile, qa ports), drives it over CDP through the main user flows, and writes
// results.json, summary.txt, run.log, electron.log, main.log and a screenshot per step.
//   cd app && npm run smoke [-- --only=boot,drill --skip=round --list --out=<dir> --max-minutes=12]
// On hp (launcher mode) run it through open-aim-hq/qa-smoke.sh from the PC; see README.md.
// Exit codes: 0 pass, 1 step failures, 2 bad args, 3 hard timeout, 4 hp busy / copy stopped by
// someone else (not run), 5 output pipe gone (ssh dropped).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs, classifyError, shellLineIsError, mainLogError, mainLogHealth, startLineTime, startupTimes, fmtMs, sleep, EXIT, exitCodeFor, DEFAULT_PORTS, launcherConfig } from "./lib.mjs";
import { startApp, stopApp, appGone, preempted, sessionReport, REPO } from "./launch.mjs";
import { Cdp } from "./cdp.mjs";
import { STEPS as BASE_STEPS, PAGE_LIB, recover } from "./steps.mjs";
import { EXTRA_STEPS } from "./steps-extra.mjs";

// Opt-in soak/edge groups come after the default steps (they never run without --only).
const STEPS = [...BASE_STEPS, ...EXTRA_STEPS];

const HELP = `npm run smoke -- [--only=a,b] [--skip=a,b] [--list] [--out=dir] [--port=N --cdp=N] [--max-minutes=20] [--profile=dir (direct mode)] [--slot-wait=30 (direct mode)]`;

let opts;
try {
  opts = parseArgs(process.argv.slice(2), process.env);
} catch (e) {
  console.error(String(e.message || e));
  console.error(HELP);
  process.exit(EXIT.badArgs);
}
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
const cfg = launcherConfig();
if (cfg && opts.profile) {
  console.error(`--profile is not allowed on hp (launcher mode): ${cfg.starter} fixes the profile at /tmp/openaim-profile-<port>`);
  process.exit(EXIT.badArgs);
}
const names = STEPS.map((s) => s.name);
if (opts.list) {
  for (const s of STEPS) console.log(`${s.name.padEnd(22)} ${s.optional ? "(only with --only) " : ""}${s.about || ""}`);
  process.exit(0);
}
for (const n of [...(opts.only || []), ...opts.skip]) {
  if (!names.includes(n) && !names.some((x) => x.startsWith(n + ":"))) {
    console.error(`unknown step "${n}". Steps: ${names.join(", ")}`);
    process.exit(EXIT.badArgs);
  }
}
// "drill" in --only/--skip matches every drill:<chip> step. Optional steps run only when named.
const pick = (list, name) => list.some((n) => n === name || name.startsWith(n + ":"));
const selected = STEPS.filter((s) => {
  if (pick(opts.skip, s.name)) return false;
  if (s.always) return true;
  if (opts.only) return pick(opts.only, s.name);
  return !s.optional;
});

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const outDir = path.resolve(opts.out || path.join(REPO, "app", "smoke-out", `smoke-${stamp}`));
fs.mkdirSync(outDir, { recursive: true });
const freshProfile = !opts.profile;
const profile = cfg ? null : path.resolve(opts.profile || path.join(REPO, "app", "smoke-out", `profile-${stamp}`));

const t0 = Date.now();
const logFile = path.join(outDir, "run.log");
let pipeGone = false;
let lastOut = Date.now();
const log = (s) => {
  const line = `[${fmtMs(Date.now() - t0).padStart(7)}] ${s}`;
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {}
  if (pipeGone) return;
  try {
    process.stdout.write(line + "\n");
    lastOut = Date.now();
  } catch {
    pipeGone = true;
  }
};

let app = null;
let starting = null; // in-flight startApp promise
let cdp = null;
let finishing = false;
let currentStep = "start";
const results = [];
const early = []; // main.log errors seen before CDP is attached
const boot = { startLineAt: null, cdpAt: null }; // startup timeline (plan W2 R11)
let startup = null;

async function cleanup(why) {
  if (!app) return null;
  log(`cleanup (${why}): stopping app pid ${app.pid}`);
  try {
    cdp?.close();
  } catch {}
  return stopApp(app, log);
}

function writeReports(extra) {
  const pass = !extra.fatal && results.length > 0 && results.every((r) => r.status === "pass");
  const out = {
    pass, exitCode: extra.exitCode, mode: cfg ? "launcher" : "direct", startedAt: new Date(t0).toISOString(), totalMs: Date.now() - t0, outDir,
    profile: app?.profile || profile, appPid: app?.pid ?? null, ports: app ? { aim: app.port, cdp: app.cdp } : extra.ports || null,
    stopped: extra.stopped ?? null, startup, ...extra, steps: results,
  };
  try {
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(out, null, 2));
  } catch {}
  const rows = results.map((r) => `${r.status.toUpperCase().padEnd(7)} ${r.step.padEnd(22)} ${fmtMs(r.ms).padStart(7)}  ${[...r.errors, ...r.notes.map((n) => "note: " + n), ...r.warnings.slice(0, 3).map((w) => "warn: " + w)].join(" ; ").slice(0, 400)}`);
  const head = extra.busy
    ? `open-aim smoke NOT RUN (hp busy: ${extra.busy})`
    : extra.preempted
      ? `open-aim smoke NOT FINISHED (copy stopped by someone else)  total ${fmtMs(out.totalMs)}`
      : `open-aim smoke ${pass ? "PASSED" : "FAILED"}  total ${fmtMs(out.totalMs)}  (${results.filter((r) => r.status === "pass").length}/${results.length} steps pass)`;
  const text = [
    `${head}  exit ${extra.exitCode}`,
    `out: ${outDir}`,
    `mode: ${out.mode}  app pid: ${out.appPid ?? "-"}  ports: ${out.ports ? `${out.ports.aim}/${out.ports.cdp}` : "-"}  profile: ${out.profile || "-"}`,
    ...(startup ? [`startup: ${startupLine(startup)}`] : []),
    ...(extra.fatal ? [`FATAL: ${extra.fatal}`] : []),
    "",
    ...rows,
    "",
  ].join("\n");
  try {
    fs.writeFileSync(path.join(outDir, "summary.txt"), text);
  } catch {}
  return { pass, text };
}

async function bail(code, why, flags = {}) {
  if (finishing) return;
  finishing = true;
  log(`ABORT: ${why}`);
  // The launcher may still be starting a copy: wait for it (it returns within ~150 s), so a
  // copy that comes up after this abort still gets the checked stop instead of being orphaned.
  if (!app && starting) {
    log("waiting for the launcher to finish before stopping");
    // startLauncher can take up to ~150 s (launcher) + 90 s (slow CDP); past that the guard,
    // already running by then, does the checked stop.
    app = await Promise.race([starting.catch(() => null), sleep(250000).then(() => null)]);
    if (app?.busy) app = null;
  }
  const wasPreempted = !!flags.preempted || preempted(app);
  const st = await cleanup(why).catch((e) => ({ stopped: false, why: String(e) }));
  const pre = wasPreempted || !!st?.preempted;
  const exitCode = pre && code !== EXIT.sshGone ? EXIT.busy : code;
  const { text } = writeReports({ fatal: why, exitCode, stopped: st?.stopped ?? null, ...flags, preempted: pre });
  log("\n" + text);
  process.exit(exitCode);
}
const onPipeError = (e) => {
  pipeGone = true;
  bail(EXIT.sshGone, `output pipe gone (${e?.code || e}): ssh session dropped`, { sshGone: true });
};
process.stdout.on("error", onPipeError);
process.stderr.on("error", onPipeError);
process.on("SIGINT", () => bail(130, "SIGINT"));
process.on("SIGTERM", () => bail(143, "SIGTERM"));
process.on("SIGHUP", () => bail(129, "SIGHUP"));
process.on("SIGBREAK", () => bail(131, "SIGBREAK"));
process.on("uncaughtException", (e) => (e && e.code === "EPIPE" ? onPipeError(e) : bail(1, "uncaught " + (e.stack || e))));
process.on("unhandledRejection", (e) => bail(1, "unhandled rejection " + (e?.stack || e)));
const hard = setTimeout(() => bail(EXIT.timeout, `hard timeout ${opts.maxMinutes} min`, { timedOut: true }), opts.maxMinutes * 60000);
hard.unref?.();
// Heartbeat: a line at least every 10 s, so a dropped ssh session shows up as EPIPE fast (R5).
const beat = setInterval(() => {
  if (Date.now() - lastOut >= 10000) log(`.. still on ${currentStep}`);
}, 2000);
beat.unref?.();
// Copy stopped by someone else (hp.sh app-stop, Soprano priority): abort, no stopper call (R7).
const watch = setInterval(() => {
  if (app && !finishing && preempted(app)) bail(EXIT.busy, "preempted: the copy was stopped by someone else (lock gone or not ours)", { preempted: true });
}, 2000);
watch.unref?.();

const secs = (ms) => (ms == null ? "?" : `${(ms / 1000).toFixed(1)} s`);
function startupLine(s) {
  return `spawn -> START: ${secs(s.spawnToStartLine)}, -> CDP ${secs(s.spawnToCdp)}, -> lobby ${secs(s.spawnToLobby)} (hp load ${s.load.map((x) => x.toFixed(1)).join("/")}, ${s.cpus} cpus)`;
}

// main.log health lines (CHILD PROCESS GONE, PAGE NOT RESPONDING, PAGE RELOAD): warnings for
// default steps, failures for soak/edge steps (step.strictHealth; plan W2 R12).
function pushHealth(h) {
  const e = { step: cdp ? cdp.step : currentStep, kind: "health", level: h.level, text: ("main.log: " + h.text).slice(0, 400), url: "", t: Date.now() };
  if (cdp) cdp.errors.push(e);
  else early.push(e);
}

function pushShellError(text) {
  const e = { step: cdp ? cdp.step : currentStep, kind: "shell", level: "error", text: text.slice(0, 400), url: "", t: Date.now() };
  if (cdp) cdp.errors.push(e);
  else early.push(e);
}

function stepErrors(name) {
  return cdp.errors.filter((e) => e.step === name);
}

// 'fail' | 'warn' | 'ignore' for an error seen during `step` (or while returning to the lobby
// after it): main.log health lines fail only soak/edge steps (strictHealth).
function judge(step, e) {
  if (e.kind === "health" && step.strictHealth && e.level === "fail" && !(step.allowHealth && step.allowHealth.test(e.text.replace(/^main\.log: /, "")))) return "fail";
  return classifyError(e);
}

async function runStep(step, idx) {
  const nn = String(idx + 1).padStart(2, "0");
  const base = `${nn}-${step.name.replace(/[^a-z0-9-]+/gi, "_")}`;
  const r = { step: step.name, status: "pass", ms: 0, notes: [], warnings: [], errors: [], screenshot: null };
  cdp.step = step.name;
  currentStep = step.name;
  const ctx = {
    cdp, log: (s) => log(`  ${step.name}: ${s}`), opts, outDir, aborted: false, results, app,
    next: selected[idx + 1]?.name || null, prev: results[results.length - 1] || null,
    note: (s) => r.notes.push(s), warn: (s) => (r.warnings.push(s), log(`  ${step.name}: WARN ${s}`)),
    data: (k, v) => ((r.data ||= {})[k] = v),
    shot: async (suffix) => cdp.screenshot(path.join(outDir, `${base}-${suffix}.png`)).catch(() => null),
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
    r.screenshot = await cdp.screenshot(path.join(outDir, `${base}.png`));
  } catch {}
  await sleep(1200); // main.log is polled once a second
  for (const e of stepErrors(step.name)) {
    const c = judge(step, e);
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

async function main() {
  log(`smoke: ${selected.length} steps (${selected.map((s) => s.name).join(", ")}) -> ${outDir}`);
  log(cfg ? `launcher mode: ${cfg.starter}` : `direct mode (untested), profile ${profile}`);
  let fatal = null;
  let fatalCode = null;
  let startPreempted = false;
  let session = null;
  let leftovers = null;
  try {
    const [port, cdpPort] = opts.port ? [opts.port, opts.cdp] : cfg ? DEFAULT_PORTS : [null, null];
    starting = startApp({
      cfg, profile, outDir, port, cdp: cdpPort, slotWaitMin: opts.slotWait, maxMinutes: opts.maxMinutes, log,
      onLine: (line) => {
        // Direct mode: electron stdout is the shell's console. Launcher mode: xvfb/electron noise, never scanned (R11).
        if (!cfg && shellLineIsError(line)) pushShellError("electron: " + line);
      },
      onMainLine: (line) => {
        const m = mainLogError(line);
        if (m) pushShellError("main.log: " + m);
        const h = mainLogHealth(line);
        if (h) pushHealth(h);
        if (boot.startLineAt == null) boot.startLineAt = startLineTime(line);
      },
    });
    app = await starting;
    if (finishing) return null; // bail() owns the exit now
    if (app.busy) {
      finishing = true;
      const exitCode = exitCodeFor({ busy: true });
      const { text } = writeReports({ busy: app.busy, exitCode });
      log("\n" + text);
      return exitCode;
    }
    cdp = new Cdp({ cdpPort: app.cdp, aimPort: app.port, log });
    cdp.errors.push(...early.map((e) => ({ ...e, step: "boot" })));
    const attaching = cdp.attach(120000).then((t) => ((boot.cdpAt = Date.now()), t));
    // Attach early so boot errors are caught; fail fast if electron dies.
    await Promise.race([
      attaching,
      (async () => {
        while (!app.exited) await sleep(250);
        throw new Error(`electron exited early (code ${app.exitCode}):\n${app.tail.slice(-15).join("\n")}`);
      })(),
    ]);
    await cdp.addOnNewDocument(PAGE_LIB);
    await cdp.evaluate(PAGE_LIB).catch(() => {}); // current document too
    if (app.mode === "launcher") {
      session = sessionReport(app.pid, [app.guardPid]);
      if (session) log(`session ${app.pid}: ${session.members.length} processes, pid is group leader ${session.pidIsGroupLeader}, session leader ${session.pidIsSessionLeader}, run-lock fds held by copy/guard: ${session.leaks.length ? session.leaks.join(", ") : "none"}`);
    }
    let crashedAt = null;
    for (let i = 0; i < selected.length; i++) {
      const step = selected[i];
      if (crashedAt) {
        results.push({ step: step.name, status: "skipped", ms: 0, notes: [], warnings: [], errors: [`skipped: ${crashedAt}`], screenshot: null });
        continue;
      }
      const r = await runStep(step, i);
      results.push(r);
      if (step.name === "boot" && !startup) {
        startup = { ...startupTimes({ spawnAt: app.spawnAt ?? null, startLineAt: boot.startLineAt, cdpAt: boot.cdpAt, lobbyAt: r.data?.lobbyAt ?? null }), load: os.loadavg(), cpus: os.cpus().length };
        log(`startup: ${startupLine(startup)}`);
      }
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
        currentStep = cdp.step;
        const rec = await recover(cdp, { log: (s) => log(`  recover: ${s}`), force: r.status !== "pass" }).catch((e) => ({ ok: false, why: String(e.message || e) }));
        if (!rec.ok) {
          r.status = "fail";
          r.errors.push(`recovery to lobby failed: ${rec.why}`);
          log(`  recover FAILED: ${rec.why}`);
        }
        await sleep(1200);
        for (const e of stepErrors(cdp.step)) {
          if (judge(step, e) === "fail") {
            r.status = "fail";
            r.errors.push(`unexpected (while returning to lobby) ${e.kind}: ${e.text}${e.url ? " @ " + e.url : ""}`);
          }
        }
      }
    }
  } catch (e) {
    fatal = String(e.message || e);
    fatalCode = e.exitCode ?? null;
    if (e.preempted) startPreempted = true;
    log(`FATAL: ${fatal}`);
  }
  currentStep = "stopping";
  const wasPreempted = preempted(app);
  const st = await cleanup("run finished");
  if (finishing) return null; // bail() owns the exit now
  finishing = true;
  const pre = startPreempted || wasPreempted || !!st?.preempted;
  if (pre) log("the copy was stopped by someone else during the run (preempted)");
  if (app?.mode === "launcher" && st?.stopped) {
    await sleep(1000);
    leftovers = sessionReport(app.pid)?.members ?? null;
    if (leftovers) log(`leftovers in session ${app.pid}: ${leftovers.length ? leftovers.join(", ") : "none"}`);
  }
  if (fatal) results.push({ step: "harness", status: "fail", ms: 0, notes: [], warnings: [], errors: [fatal], screenshot: null });
  // Direct mode: delete a fresh profile after a clean pass (launcher mode deletes its own in stopApp).
  let profileKept = !!profile;
  const allPass = !fatal && results.length > 0 && results.every((r) => r.status === "pass");
  if (profile && allPass && freshProfile) {
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
  const exitCode = fatalCode ?? exitCodeFor({ pass: allPass, preempted: pre });
  const { text } = writeReports({ fatal, exitCode, profileKept, stopped: st?.stopped ?? null, stopWhy: st?.why ?? null, session, leftovers, preempted: pre });
  log("\n" + text);
  return exitCode;
}

const code = await main();
if (code !== null) {
  clearTimeout(hard);
  process.exit(code);
}
