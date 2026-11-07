// The desktop shell's log file: <userData>/logs/main.log (for the real app,
// %APPDATA%\AimTrainer\logs\main.log). Main-process console output, crashes of the page or of
// Chromium's helper processes, failed loads and page errors are written there, one short line
// each with the time. Past maxBytes (1 MB) the file is moved to main.old.log (one old file kept).
// Logging never throws: a log that can't be written is skipped.
const fs = require("fs");
const path = require("path");
const util = require("util");

const MAX_BYTES = 1024 * 1024;
const MAX_LINE = 4000;
// Page crashes that reload the lobby. clean-exit is a normal close.
const RELOAD_REASONS = new Set(["crashed", "oom", "killed", "abnormal-exit", "launch-failed", "integrity-failure", "memory-eviction"]);

function format(args) {
  try {
    let text = util.format(...args);
    if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + " [...]";
    // Multi-line messages (stacks): continuation lines are indented, so every entry starts with its time.
    return text.replace(/\r?\n/g, "\n    ");
  } catch {
    return "(unprintable log line)";
  }
}

function createLog(dir, { maxBytes = MAX_BYTES } = {}) {
  const file = path.join(dir, "main.log");
  const oldFile = path.join(dir, "main.old.log");
  // The console functions from before hookConsole: the log's own messages go to these, so
  // nothing here can loop back into the log.
  const original = { log: console.log, warn: console.warn, error: console.error };
  let size = null;
  let dirMade = false;

  function rotate() {
    try {
      fs.renameSync(file, oldFile);
    } catch {
      // Can't move it aside (locked?): start the file over rather than let it grow.
      try { fs.writeFileSync(file, ""); } catch {}
    }
    size = 0;
  }

  function write(level, args) {
    try {
      const line = `${new Date().toISOString()} ${level} ${format(args)}\n`;
      if (!dirMade) { fs.mkdirSync(dir, { recursive: true }); dirMade = true; }
      if (size === null) {
        try { size = fs.statSync(file).size; } catch { size = 0; }
      }
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) {
        // Another copy using the same folder may have rotated the file already.
        try { size = fs.statSync(file).size; } catch { size = 0; }
        if (size > 0 && size + bytes > maxBytes) rotate();
      }
      fs.appendFileSync(file, line);
      size += bytes;
    } catch {
      dirMade = false;
      size = null;
    }
  }

  // An oversized file left from last time is moved aside at startup.
  try {
    if (fs.statSync(file).size > maxBytes) rotate();
  } catch {}

  const print = (fn, args) => { try { fn.apply(console, args); } catch {} };
  const log = {
    file,
    original,
    info: (...args) => write("INFO", args),
    warn: (...args) => write("WARN", args),
    error: (...args) => write("ERROR", args),
    // Writes and also prints (to stderr for warn/error), without going through the hooked console.
    say: (...args) => { print(original.log, args); write("INFO", args); },
    shout: (...args) => { print(original.error, args); write("ERROR", args); },
  };

  // console.log/warn/error in the main process keep printing and also go into the log.
  log.hookConsole = (con = console) => {
    for (const [name, level] of [["log", "INFO"], ["warn", "WARN"], ["error", "ERROR"]]) {
      const before = con[name];
      con[name] = (...args) => { print(before, args); write(level, args); };
    }
  };

  // Chromium's helper processes (GPU, utility, ...) that stop.
  log.watchApp = (app) => {
    app.on("child-process-gone", (_event, d = {}) => {
      log.warn(`CHILD PROCESS GONE: type=${d.type} reason=${d.reason} exitCode=${d.exitCode}${d.name ? ` name=${d.name}` : ""}`);
    });
  };

  // Page crashes, hangs, failed loads and page errors of the window `win`. A crashed page
  // reloads `url` (the lobby) after delayMs; after maxReloads crashes within windowMs it stops
  // and calls onGiveUp(). No reload while isQuitting() or once the window is gone.
  log.attachWindow = (win, {
    url, isQuitting = () => false, onGiveUp = () => {},
    delayMs = 500, maxReloads = 3, windowMs = 60000, errorsPerMinute = 50, now = () => Date.now(),
    setTimer = setTimeout,
  } = {}) => {
    const wc = win.webContents;
    const crashes = [];
    let gaveUp = false;
    const gone = () => { try { return win.isDestroyed(); } catch { return true; } };
    wc.on("render-process-gone", (_event, d = {}) => {
      log.error(`PAGE CRASHED: reason=${d.reason} exitCode=${d.exitCode}`);
      if (!RELOAD_REASONS.has(d.reason) || gaveUp || isQuitting() || gone()) return;
      const t = now();
      while (crashes.length && t - crashes[0] > windowMs) crashes.shift();
      crashes.push(t);
      if (crashes.length > maxReloads) {
        gaveUp = true;
        log.error(`PAGE CRASHED ${crashes.length} times in ${Math.round(windowMs / 1000)} s, not reloading again`);
        try { onGiveUp(); } catch (err) { log.error("PAGE CRASHED: giving up failed:", err); }
        return;
      }
      setTimer(() => {
        if (isQuitting() || gone()) return;
        log.warn(`PAGE RELOAD: ${url} (${crashes.length}/${maxReloads})`);
        try {
          Promise.resolve(win.loadURL(url)).catch((err) => log.error(`PAGE RELOAD failed: ${err && err.message}`));
        } catch (err) {
          log.error(`PAGE RELOAD failed: ${err && err.message}`);
        }
      }, delayMs);
    });
    win.on("unresponsive", () => log.warn("PAGE NOT RESPONDING"));
    win.on("responsive", () => log.info("PAGE RESPONDING AGAIN"));
    wc.on("did-fail-load", (_event, code, desc, failedUrl, isMainFrame) => {
      // -3 (ERR_ABORTED): a load replaced by another one, not a failure.
      if (!isMainFrame || code === -3) return;
      log.error(`PAGE LOAD FAILED: ${code} ${desc} ${failedUrl}`);
    });
    wc.on("preload-error", (_event, file, err) => log.error(`PRELOAD ERROR: ${file}`, err));
    // Page errors, at most errorsPerMinute lines a minute so an error loop can't fill the disk.
    // Electron 35+ passes one event object (level "error"); older ones (event, level 3, message, ...).
    let minute = -1;
    let count = 0;
    wc.on("console-message", (...args) => {
      const e = args[0] || {};
      let level = e.level;
      let message = e.message;
      let source = e.sourceId;
      let line = e.lineNumber;
      if (level === undefined) [, level, message, line, source] = args;
      if (level !== "error" && level !== 3) return;
      const m = Math.floor(now() / 60000);
      if (m !== minute) { minute = m; count = 0; }
      count++;
      if (count > errorsPerMinute + 1) return;
      if (count === errorsPerMinute + 1) {
        log.warn(`PAGE ERROR: more than ${errorsPerMinute} this minute, the rest are skipped`);
        return;
      }
      log.error(`PAGE ERROR: ${String(message).slice(0, 1000)}${source ? ` (${source}:${line})` : ""}`);
    });
  };

  return log;
}

module.exports = { createLog, RELOAD_REASONS, MAX_BYTES };
