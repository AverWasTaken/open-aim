// Opt-in step groups on top of the smoke suite (plan W2): soak (stability over many restarts
// and screen switches) and edge (bug hunt like a player). They never run without --only;
// qa-smoke.sh splits --only=soak and --only=edge into batches of their own (README).
// A failing soak/edge step is a finding about the app (numbers + screenshot + repro in the
// notes), not a broken suite.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sleep, soakVerdicts, csvLine, parseSmapsRollup, procType } from "./lib.mjs";
import { sessionReport } from "./launch.mjs";
import { DRILLS, J, waitFor, status, clickSel, waitLobby, launchDrill, startDrill, launchAndStart, shootFor, exitDrill, playToResult } from "./steps.mjs";

const drill = (id) => DRILLS.drills.find((d) => d.id === id);
const LIGHT = DRILLS.light; // Micro tiles: targets, no map
const MAP = drill("pre-aim"); // DDY's pre-aim, Ascent: map drill, the player can walk
const BOTS = drill("angle-holding"); // bot drill where the aim helper gets kills (R2)
const SHORT = drill("scenarios"); // ends by itself after 7 s

// ---------------------------------------------------------------- page probe
// Installed before the app's own scripts (new document), so every WebGL object, AudioContext
// and Worker the page makes is counted (plan W2 R3/R5). WebGL: objects held by weak reference,
// counted while reachable, not deleted and in a live, not-lost context (contexts counted, lost
// ones separately). AudioContexts: made - closed. Workers: made - terminated.
export const PROBE_LIB = String.raw`(() => {
  if (window.__qaProbe) return;
  const P = window.__qaProbe = { v: 1, audio: { made: 0, closed: 0 }, workers: { made: 0, ended: 0 } };
  const KINDS = ['Texture', 'Buffer', 'Framebuffer', 'Renderbuffer', 'Program', 'Shader', 'VertexArray'];
  // Live = created, not deleted, still reachable from the page (held by weak reference: the
  // browser frees a WebGL object whose JS wrapper is garbage-collected, without a delete call),
  // in a context that is itself still alive and not lost. Only meaningful right after a forced
  // GC, so the soak rules judge GL counts on GC'd samples only.
  const deleted = new WeakSet();
  const perCtx = new WeakMap();
  const ctxs = [];
  const entryFor = (gl) => {
    let e = perCtx.get(gl);
    if (!e) { e = { ref: new WeakRef(gl), objs: {} }; perCtx.set(gl, e); ctxs.push(e); }
    return e;
  };
  const wrapGL = (proto) => {
    if (!proto) return;
    for (const k of KINDS) {
      const c = proto['create' + k], d = proto['delete' + k];
      if (typeof c !== 'function' || c.__qa) continue;
      const cw = function () { const o = c.apply(this, arguments); if (o && typeof o === 'object') { const e = entryFor(this); (e.objs[k] = e.objs[k] || []).push(new WeakRef(o)); } return o; };
      cw.__qa = 1;
      proto['create' + k] = cw;
      if (typeof d === 'function') proto['delete' + k] = function (o) { if (o && typeof o === 'object') deleted.add(o); return d.apply(this, arguments); };
    }
  };
  wrapGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  wrapGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  const wrapCtor = (name, onMake) => {
    const C = window[name];
    if (typeof C !== 'function') return;
    window[name] = new Proxy(C, { construct(t, args, nt) { const o = Reflect.construct(t, args, nt); try { onMake(o); } catch (e) {} return o; } });
  };
  const onAudio = (o) => {
    P.audio.made++;
    let closed = false;
    const done = () => { if (!closed && o.state === 'closed') { closed = true; P.audio.closed++; } };
    o.addEventListener('statechange', done);
    const cl = o.close;
    if (typeof cl === 'function') o.close = function () { const r = cl.apply(this, arguments); Promise.resolve(r).then(done, () => {}); return r; };
  };
  wrapCtor('AudioContext', onAudio);
  wrapCtor('webkitAudioContext', onAudio);
  wrapCtor('Worker', (o) => {
    P.workers.made++;
    const tm = o.terminate;
    let ended = false;
    o.terminate = function () { if (!ended) { ended = true; P.workers.ended++; } return tm.apply(this, arguments); };
  });
  P.snap = () => {
    const out = { workers: P.workers.made - P.workers.ended, audio_ctx: P.audio.made - P.audio.closed, ticks: window.__qa ? __qa.ticks : null };
    let alive = 0, lost = 0;
    for (const k of KINDS) out['gl_' + k.toLowerCase()] = 0;
    for (const e of ctxs) {
      const gl = e.ref.deref();
      if (!gl) { e.objs = {}; continue; }
      if (gl.isContextLost && gl.isContextLost()) { lost++; continue; }
      alive++;
      for (const k of KINDS) {
        const list = e.objs[k];
        if (!list) continue;
        // Drop collected or deleted objects from the list as we count.
        e.objs[k] = list.filter((r) => { const o = r.deref(); return !!o && !deleted.has(o); });
        out['gl_' + k.toLowerCase()] += e.objs[k].length;
      }
    }
    out.gl_contexts = alive;
    out.gl_contexts_lost = lost;
    return out;
  };
})()`;

// Install the probe and reload once so it sees the page from its first script.
async function ensureProbe(ctx) {
  const c = ctx.cdp;
  const have = await c.evaluate("!!(window.__qaProbe && window.__qaProbe.v === 1)").catch(() => false);
  if (!have) {
    if (!c.__probeAdded) {
      await c.addOnNewDocument(PROBE_LIB);
      c.__probeAdded = true;
    }
    ctx.log("installing the page probe (WebGL/AudioContext/Worker counters): reloading /aim");
    await c.evaluate("location.assign('/aim'); true").catch(() => {});
    await sleep(1500);
    await c.ensureAttached();
    await waitLobby(ctx, 120000);
    if (!(await c.evaluate("!!window.__qaProbe").catch(() => false))) throw new Error("page probe did not install");
  }
  await c.send("Performance.enable", {}).catch(() => {});
  await c.send("HeapProfiler.enable", {}).catch(() => {});
}

// ---------------------------------------------------------------- node-side metrics
// Electron process memory by kind, from the copy's session on hp (Linux only; null elsewhere).
function procMem(app) {
  if (!app || app.mode !== "launcher" || process.platform !== "linux") return null;
  const rep = sessionReport(app.pid);
  if (!rep) return null;
  const by = {};
  for (const pid of rep.members) {
    let type = null;
    let mem = null;
    try {
      type = procType(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
      mem = parseSmapsRollup(fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
    } catch {
      continue;
    }
    if (!type) continue;
    const b = (by[type] ||= { n: 0, rssKb: 0, pssKb: 0 });
    b.n++;
    b.rssKb += mem.rssKb || 0;
    b.pssKb += mem.pssKb || 0;
  }
  const mb = (kb) => (kb == null ? null : +(kb / 1024).toFixed(1));
  return {
    renderer_rss_mb: mb(by.renderer?.rssKb), renderer_pss_mb: mb(by.renderer?.pssKb), renderers: by.renderer?.n ?? 0,
    gpu_rss_mb: mb(by["gpu-process"]?.rssKb), browser_rss_mb: mb(by.browser?.rssKb),
  };
}

const LISTENERS_EXPR = `(() => {
  const count = (o) => { const m = getEventListeners(o); let n = 0; const by = {}; for (const k of Object.keys(m)) { n += m[k].length; by[k] = m[k].length; } return { n, by }; };
  const w = count(window), d = count(document);
  return { win: w.n, doc: d.n, winBy: w.by, docBy: d.by };
})()`;

export const SAMPLE_COLS = ["x", "path", "t_s", "gc", "heap_mb", "nodes", "js_listeners", "win_listeners", "doc_listeners", "gl_texture", "gl_buffer", "gl_framebuffer", "gl_renderbuffer", "gl_program", "gl_shader", "gl_vertexarray", "gl_contexts", "gl_contexts_lost", "q_gl_contexts", "q_canvases", "q_gl_buffers", "q_gl_textures", "workers", "worker_targets", "audio_ctx", "documents", "renderer_rss_mb", "renderer_pss_mb", "renderers", "gpu_rss_mb", "browser_rss_mb", "load1", "restart_ms", "note"];

// Objects on the page heap with this prototype (Runtime.queryObjects): a cross-check of the
// probe's counts that does not depend on the probe's wrappers. Null when unavailable.
async function queryCount(c, protoExpr) {
  const group = "qa-query";
  try {
    const p = await c.send("Runtime.evaluate", { expression: `(typeof ${protoExpr.split(".")[0]} === 'function') ? ${protoExpr} : null`, objectGroup: group }, 15000);
    if (p.exceptionDetails || !p.result?.objectId) return null;
    const q = await c.send("Runtime.queryObjects", { prototypeObjectId: p.result.objectId, objectGroup: group }, 30000);
    const n = await c.send("Runtime.callFunctionOn", { objectId: q.objects.objectId, functionDeclaration: "function () { return this.length; }", returnByValue: true }, 15000);
    return n.result?.value ?? null;
  } catch {
    return null;
  } finally {
    await c.send("Runtime.releaseObjectGroup", { objectGroup: group }, 10000).catch(() => {});
  }
}

// One metrics sample. gc: force two full GCs first; DOM node, listener, heap and WebGL counts
// are only compared on such rows (they include garbage otherwise).
async function sample(ctx, { x, path: p, gc = false, query = gc, t0 = Date.now(), extra = {} }) {
  const c = ctx.cdp;
  const q = {};
  if (gc) {
    // The inspector keeps console-API arguments (Runtime.enable) alive: drop them first so they
    // can't look like a page leak.
    await c.send("Runtime.discardConsoleEntries", {}, 10000).catch(() => {});
    for (let i = 0; i < 2; i++) {
      await c.send("HeapProfiler.collectGarbage", {}, 30000).catch(() => {});
      await sleep(150);
    }
  }
  const m = {};
  const pm = await c.send("Performance.getMetrics", {}, 15000).catch(async () => {
    await c.send("Performance.enable", {}).catch(() => {});
    return c.send("Performance.getMetrics", {}, 15000).catch(() => ({ metrics: [] }));
  });
  for (const e of pm.metrics || []) m[e.name] = e.value;
  const lis = await c.send("Runtime.evaluate", { expression: LISTENERS_EXPR, includeCommandLineAPI: true, returnByValue: true }, 15000).then((r) => r.result?.value || null, () => null);
  const probe = await c.evaluate("window.__qaProbe ? __qaProbe.snap() : null").catch(() => null);
  const targets = await c.send("Target.getTargets", {}, 10000).then((r) => r.targetInfos.filter((t) => /worker/.test(t.type)).length, () => null);
  if (gc && query) {
    // After the other readings: the result arrays are garbage until the next GC and would add to
    // the heap number. queryObjects is slow (seconds with thousands of objects), so callers ask
    // for it on fewer samples.
    const ctx2 = await queryCount(c, "WebGL2RenderingContext.prototype");
    const ctx1 = await queryCount(c, "WebGLRenderingContext.prototype");
    q.q_gl_contexts = ctx2 == null && ctx1 == null ? null : (ctx2 || 0) + (ctx1 || 0);
    q.q_canvases = await queryCount(c, "HTMLCanvasElement.prototype");
    q.q_gl_buffers = await queryCount(c, "WebGLBuffer.prototype");
    q.q_gl_textures = await queryCount(c, "WebGLTexture.prototype");
  }
  const row = {
    x, path: p, t_s: +((Date.now() - t0) / 1000).toFixed(1), gc: gc ? 1 : 0,
    heap_mb: m.JSHeapUsedSize != null ? +(m.JSHeapUsedSize / 1048576).toFixed(3) : null,
    nodes: m.Nodes ?? null, js_listeners: m.JSEventListeners ?? null, documents: m.Documents ?? null,
    win_listeners: lis?.win ?? null, doc_listeners: lis?.doc ?? null,
    ...(probe || {}), ...q, worker_targets: targets,
    ...(procMem(ctx.app) || {}),
    load1: +os.loadavg()[0].toFixed(2),
    ...extra,
  };
  row._winBy = lis?.winBy || null;
  row._docBy = lis?.docBy || null;
  return row;
}

// Row-by-row CSV in the output folder (a run cut short still leaves its rows).
function csvWriter(file) {
  fs.writeFileSync(file, csvLine(SAMPLE_COLS) + "\n");
  return (row) => fs.appendFileSync(file, csvLine(SAMPLE_COLS.map((k) => row[k])) + "\n");
}

// Verdicts -> notes/warnings; returns the failing lines.
function report(ctx, label, rows, from) {
  const vs = soakVerdicts(rows, { from });
  const fails = [];
  for (const v of vs) {
    if (v.verdict === "n/a") continue;
    const line = `${label}: ${v.text} -> ${v.verdict.toUpperCase()}`;
    ctx.log(line);
    if (v.verdict === "fail") fails.push(line);
    else if (v.verdict === "warn") ctx.warn(line);
  }
  ctx.data(label, vs.map(({ col, n, slope, first, last, verdict }) => ({ col, n, slope, first, last, verdict })));
  return fails;
}

// Which listener types grew between two samples (for the failure text).
function listenerGrowth(a, b) {
  const out = [];
  for (const [k, by] of [["window", "_winBy"], ["document", "_docBy"]]) {
    if (!a?.[by] || !b?.[by]) continue;
    for (const t of new Set([...Object.keys(a[by]), ...Object.keys(b[by])])) {
      const d = (b[by][t] || 0) - (a[by][t] || 0);
      if (d > 0) out.push(`${k}.${t} +${d}`);
    }
  }
  return out.join(", ");
}

// ---------------------------------------------------------------- shared helpers
const pauseLite = async (ctx) => {
  await ctx.cdp.evaluate("document.exitPointerLock(); true");
  await waitFor(ctx, "__qa.phase==='paused' && !!__qa.visq('.al-pause-layer.al-pause-lite')", { timeout: 10000, what: "paused + light pause menu" });
};

// After a Restart/Play again/R: running again, starting from the start screen if it shows.
async function untilRunning(ctx, what, timeout = 30000) {
  await ctx.cdp.moveTo();
  const r = await waitFor(ctx, "(__qa.phase==='running' && __qa.locked()) ? 'running' : (__qa.readyToStart() ? 'ready' : false)", { timeout, every: 250, what });
  if (r === "ready") await startDrill(ctx);
  return r;
}

const hudText = (ctx) => ctx.cdp.evaluate("__qa.text(__qa.visq('.al-hud'))").catch(() => "");
// "TIME 0:50" (or 0:05.2) in the HUD -> seconds, or null.
export function hudSeconds(text) {
  const m = String(text || "").match(/TIME\s+(\d+):(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Back to the lobby by navigation (used when a flow ends somewhere unknown).
async function toLobby(ctx) {
  await ctx.cdp.evaluate("document.exitPointerLock && document.exitPointerLock(); window.__qa && __qa.aimStop(); location.assign('/aim'); true").catch(() => {});
  await sleep(1500);
  await ctx.cdp.ensureAttached();
  await waitLobby(ctx, 120000);
}

// Single drill instance: one trainer root, one visible HUD, and the sim hook called at a
// normal rate (a doubled game loop would call __aimTick twice as often: R5).
async function instanceCheck(ctx, ms = 2000) {
  return ctx.cdp.evaluate(`(async () => {
    const t0 = __qa.ticks, p0 = performance.now();
    await new Promise((r) => setTimeout(r, ${ms}));
    return { tickRate: +((__qa.ticks - t0) * 1000 / (performance.now() - p0)).toFixed(1), roots: document.querySelectorAll('.al-aimlab-root').length,
      huds: [...document.querySelectorAll('.al-hud')].filter(__qa.vis).length, canvases: document.querySelectorAll('canvas').length,
      audio: window.__qaProbe ? __qaProbe.snap().audio_ctx : null, phase: __qa.phase, locked: __qa.locked() };
  })()`, { timeout: ms + 15000 });
}

// Yaw change for a synthetic mouse move of `counts` (after a 1-count primer, which the game
// may swallow as the first move after the lock). Waits for the sim to apply it.
async function yawFor(ctx, counts) {
  return ctx.cdp.evaluate(`(async () => {
    const frames = (n) => new Promise((r) => { let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const mv = (x) => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: x, movementY: 0 }));
    mv(1); await frames(6);
    const y0 = __qa.last.player.yaw;
    mv(${counts}); await frames(8);
    const y1 = __qa.last.player.yaw;
    let d = y1 - y0; d = Math.atan2(Math.sin(d), Math.cos(d));
    return { y0, y1, d, sens: localStorage.getItem('al-sensitivity-v1') };
  })()`);
}

// ---------------------------------------------------------------- soak
const SOAK_BUDGET_MS = 8 * 60000; // R1: wall-clock self-budget per soak step

const soakRetries = {
  name: "soak:retries",
  optional: true,
  strictHealth: true,
  about: "~40 pause-menu restarts (bot drill) + ~10 result-screen retries (R); heap/nodes/listeners/GL/workers/audio/RSS per restart; Theil-Sen slopes",
  timeoutMs: 10.5 * 60000,
  async run(ctx) {
    const t0 = Date.now();
    await ensureProbe(ctx);
    const file = path.join(ctx.outDir, "soak.csv");
    const write = csvWriter(file);
    ctx.note(`CSV ${file}`);
    const rowsA = [];
    const rowsB = [];
    // Path A (R1/R2): mid-drill restart through the light pause menu, bot drill, shots each cycle.
    await launchAndStart(ctx, BOTS, "scene", { loadTimeout: 180000 });
    let ended = 0;
    let lastRestartMs = null;
    for (let k = 0; k <= 40; k++) {
      ctx.check();
      const r = await shootFor(ctx, { seconds: 3, enough: 1, minSeconds: 2 });
      if (r.phase === "result" || r.result) {
        // The drill ended by itself (should not happen in 3 s): Play again, sample next cycle.
        ended++;
        await clickSel(ctx, ".al-result-overlay .al-primary-btn");
        await untilRunning(ctx, "running after Play again");
        continue;
      }
      await pauseLite(ctx);
      const row = await sample(ctx, { x: k, path: "pause", gc: k % 2 === 0, query: k % 10 === 0, t0, extra: { restart_ms: lastRestartMs, note: `kills ${r.kills} shots ${r.shots}` } });
      rowsA.push(row);
      write(row);
      if (k % 10 === 0) {
        ctx.log(`pause path: restart ${k}: heap ${row.heap_mb} MB${row.gc ? " (after GC)" : ""}, nodes ${row.nodes}, listeners ${row.js_listeners} (window ${row.win_listeners}, document ${row.doc_listeners}), GL textures ${row.gl_texture} buffers ${row.gl_buffer} programs ${row.gl_program}, workers ${row.workers}/${row.worker_targets}, audio ${row.audio_ctx}, renderer PSS ${row.renderer_pss_mb} MB, load ${row.load1}`);
        await ctx.shot(`restart${k}`);
      }
      if (k === 40 || Date.now() - t0 > SOAK_BUDGET_MS * 0.7) break;
      const tr = Date.now();
      await clickSel(ctx, ".al-pause-layer .al-pause-act", "Restart");
      await untilRunning(ctx, `running after restart ${k + 1}`);
      lastRestartMs = Date.now() - tr;
    }
    const nA = rowsA.length ? rowsA[rowsA.length - 1].x : 0;
    ctx.note(`pause path: ${nA} restarts in ${((Date.now() - t0) / 1000).toFixed(0)} s${ended ? `, drill ended by itself ${ended}x` : ""}`);
    await exitDrill(ctx);
    // Path B (R1): the Scenarios drill ends by itself after 7 s; retry from the result screen
    // with R (Play again when R does nothing).
    await launchAndStart(ctx, SHORT, "scene", { loadTimeout: 180000 });
    let viaR = 0;
    let viaButton = 0;
    for (let k = 0; k <= 10; k++) {
      ctx.check();
      await ctx.cdp.evaluate("__qa.resetCounters(); true");
      await playToResult(ctx, { maxSeconds: 40 });
      const row = await sample(ctx, { x: k, path: "result", gc: true, t0, extra: { restart_ms: lastRestartMs } });
      rowsB.push(row);
      write(row);
      if (k === 10 || Date.now() - t0 > SOAK_BUDGET_MS) break;
      // ux-keys ignores R for 600 ms after the result shows and while the card animates in.
      await waitFor(ctx, "(() => { const m = document.querySelector('.al-result-overlay .al-result-modal'); return !m || !m.getAnimations || !m.getAnimations().some((a) => a.playState === 'running'); })()", { timeout: 5000, every: 150 }).catch(() => {});
      await sleep(700);
      const tr = Date.now();
      await ctx.cdp.moveTo();
      await ctx.cdp.key("r");
      const ok = await waitFor(ctx, "(__qa.phase==='running' && __qa.locked()) || __qa.readyToStart()", { timeout: 4000, every: 200 }).catch(() => false);
      if (ok) viaR++;
      else {
        viaButton++;
        await clickSel(ctx, ".al-result-overlay .al-primary-btn");
      }
      await untilRunning(ctx, `running after result retry ${k + 1}`);
      lastRestartMs = Date.now() - tr;
    }
    ctx.note(`result path: ${rowsB.length ? rowsB[rowsB.length - 1].x : 0} retries (R ${viaR}, Play again ${viaButton})`);
    if (viaButton && !viaR) ctx.warn("R on the result screen did not retry; Play again was used");
    await exitDrill(ctx);
    // Verdicts (R4): restart 10 on for the pause path; the result path from retry 2 on (it may
    // legitimately grow its run history, so it is judged on its own).
    const fails = [...report(ctx, "soak pause-restart", rowsA, 10), ...report(ctx, "soak result-retry", rowsB, 2)];
    const first = rowsA.find((r) => r.x >= 10);
    const last = rowsA[rowsA.length - 1];
    const grew = listenerGrowth(first, last);
    if (grew) ctx.note(`listener types that grew (restart ${first?.x} -> ${last?.x}): ${grew}`);
    for (const k of [10, 20, 30, 40]) {
      const r = rowsA.find((x) => x.x === k);
      if (r) ctx.note(`restart ${k}: heap ${r.heap_mb} MB, nodes ${r.nodes}, listeners ${r.js_listeners}, renderer RSS ${r.renderer_rss_mb} MB`);
    }
    if (fails.length) throw new Error(`leak suspect (finding, see ${path.basename(file)}): ${fails.join(" | ")}`);
  },
};

// Round (beta) from its panel: start, running with the round HUD, then exit.
async function playRound(ctx) {
  for (let attempt = 1; ; attempt++) {
    await ctx.cdp.evaluate("__qa.sawLoad = false; __aimRoundPanel.open(); true");
    await clickSel(ctx, ".aim-round-start");
    await waitFor(ctx, "window.__aimRoundOn===true", { timeout: 20000, what: "__aimRoundOn" });
    const v = await waitFor(ctx, "__qa.status().failed ? 'FAILED' : __qa.fellBack() ? 'LOBBY' : __qa.readyToStart()", { timeout: 150000, every: 1000, what: "round start screen" });
    if (v === "FAILED") throw new Error("round scene failed to load");
    if (v !== "LOBBY") break;
    if (attempt >= 2) throw new Error("round load fell back to the lobby twice");
    ctx.warn("round load fell back to the lobby; started again");
  }
  await startDrill(ctx);
  await waitFor(ctx, "(()=>{const h=document.getElementById('aim-round-hud'); return !!window.__aimRound && !!h && !h.hidden;})()", { timeout: 20000, what: "round HUD" });
  await sleep(1000);
  await exitDrill(ctx);
}

const soakSwitch = {
  name: "soak:switch",
  optional: true,
  strictHealth: true,
  about: "6-8 cycles lobby -> target drill -> lobby -> map drill -> lobby -> Round -> lobby; metrics in the lobby after GC",
  timeoutMs: 10.5 * 60000,
  async run(ctx) {
    const t0 = Date.now();
    await ensureProbe(ctx);
    const file = path.join(ctx.outDir, "soak-switch.csv");
    const write = csvWriter(file);
    ctx.note(`CSV ${file}`);
    const rows = [];
    const parts = [];
    const roundOk = await ctx.cdp.evaluate("!!(window.__aimRoundPanel && __aimRoundPanel.open)");
    if (!roundOk) ctx.warn("no Round panel (__aimRoundPanel); cycles skip Round");
    let cycleMs = 0;
    for (let k = 0; k <= 8; k++) {
      ctx.check();
      const row = await sample(ctx, { x: k, path: "switch", gc: true, t0, extra: { restart_ms: cycleMs || null } });
      rows.push(row);
      write(row);
      ctx.log(`cycle ${k}: heap ${row.heap_mb} MB, nodes ${row.nodes}, listeners ${row.js_listeners}, GL textures ${row.gl_texture}, audio ${row.audio_ctx}, renderer PSS ${row.renderer_pss_mb} MB, load ${row.load1}`);
      if (k === 8 || Date.now() - t0 + (cycleMs || 60000) * 1.2 > SOAK_BUDGET_MS) break;
      const tc = Date.now();
      // A GC'd sample in the lobby after each part too, so growth can be pinned to one part.
      await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
      await shootFor(ctx, { seconds: 2, enough: 99, minSeconds: 2 });
      await exitDrill(ctx);
      const rt = await sample(ctx, { x: k + 1, path: "after-target", gc: true, query: false, t0 });
      parts.push(rt);
      write(rt);
      await launchAndStart(ctx, MAP, "scene", { loadTimeout: 180000 });
      await shootFor(ctx, { seconds: 2, enough: 99, minSeconds: 2 });
      await exitDrill(ctx);
      const rm = await sample(ctx, { x: k + 1, path: "after-map", gc: true, query: false, t0 });
      parts.push(rm);
      write(rm);
      if (roundOk) await playRound(ctx);
      await waitFor(ctx, "__qa.inLobby()", { timeout: 30000, what: "lobby after the cycle" });
      cycleMs = Date.now() - tc;
      if (k === 0) await ctx.shot("cycle1");
    }
    // Mean growth per part from cycle 2 on (the first cycle warms caches): target drill = cycle
    // start -> after-target, map drill = after-target -> after-map, Round = after-map -> cycle end.
    const per = { "target drill": [], "map drill": [], Round: [] };
    for (let k = 2; k < rows.length; k++) {
      const s0 = rows[k - 1], t = parts.find((r) => r.x === k && r.path === "after-target"), m = parts.find((r) => r.x === k && r.path === "after-map"), e = rows[k];
      if (!t || !m) continue;
      per["target drill"].push([s0, t]);
      per["map drill"].push([t, m]);
      per.Round.push([m, e]);
    }
    for (const [part, pairs] of Object.entries(per)) {
      if (!pairs.length) continue;
      const avg = (col) => {
        const v = pairs.map(([a, b]) => b[col] - a[col]).filter(Number.isFinite);
        return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
      };
      const f = (x, d = 0) => (x == null ? "?" : (x >= 0 ? "+" : "") + x.toFixed(d));
      const line = `per ${part} (mean of ${pairs.length}): heap ${f(avg("heap_mb"), 2)} MB, nodes ${f(avg("nodes"))}, listeners ${f(avg("js_listeners"))}, lost-but-held WebGL contexts ${f(avg("gl_contexts_lost"), 1)}, live-context textures ${f(avg("gl_texture"))} buffers ${f(avg("gl_buffer"))}`;
      ctx.note(line);
      ctx.log(line);
    }
    const n = rows.length ? rows[rows.length - 1].x : 0;
    ctx.note(`${n} cycles in ${((Date.now() - t0) / 1000).toFixed(0)} s (last cycle ${(cycleMs / 1000).toFixed(0)} s)`);
    for (const r of rows) ctx.note(`cycle ${r.x}: heap ${r.heap_mb} MB, nodes ${r.nodes}, listeners ${r.js_listeners}, renderer RSS ${r.renderer_rss_mb} MB, WebGL contexts on the heap ${r.q_gl_contexts} (lost ${r.gl_contexts_lost}), canvases ${r.q_canvases}, WebGLBuffers ${r.q_gl_buffers}`);
    if (n < 4) ctx.warn(`only ${n} cycles fit the budget; slopes are rough`);
    // From cycle 1 on: the first cycle loads the map and caches (one-off growth).
    const fails = report(ctx, "soak switch", rows, 1);
    const grew = listenerGrowth(rows.find((r) => r.x >= 1), rows[rows.length - 1]);
    if (grew) ctx.note(`listener types that grew: ${grew}`);
    if (fails.length) throw new Error(`leak suspect (finding, see ${path.basename(file)}): ${fails.join(" | ")}`);
  },
};

// ---------------------------------------------------------------- edge
const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : null);
const playerPos = (ctx) => ctx.cdp.evaluate("__qa.last && __qa.last.player ? { x: __qa.last.player.position.x, y: __qa.last.player.position.y, z: __qa.last.player.position.z, tick: __qa.last.tick } : null");

// R6: input held through an alt-tab: W + left mouse down, lock lost + window blur, no key-up
// or mouse-up ever arrives. After Resume the player must not keep walking or firing.
const edgeBlur = {
  name: "edge:blur",
  optional: true,
  strictHealth: true,
  about: "alt-tab with W + mouse held (lock lost + window blur, no key-up): no endless walking or firing after Resume; pause timer; drill goes on",
  timeoutMs: 6 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    await launchAndStart(ctx, MAP, "scene", { loadTimeout: 180000 });
    await sleep(800);
    await c.evaluate("__qa.resetCounters(); true");
    const p0 = await playerPos(ctx);
    let held = { key: false, mouse: false };
    try {
      await c.keyDown("w");
      held.key = true;
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.cx, y: c.cy, button: "left", clickCount: 1 });
      held.mouse = true;
      await sleep(600);
      const p1 = await playerPos(ctx);
      const shotsHeld = await c.evaluate("__qa.shots.length");
      const walked = dist(p0, p1);
      ctx.note(`holding W + mouse 0.6 s: walked ${walked == null ? "?" : walked.toFixed(2)} m, shots ${shotsHeld}`);
      // Alt-tab: the lock goes and the window blurs; the key and button stay down (no up event).
      await c.evaluate("document.exitPointerLock(); window.dispatchEvent(new Event('blur')); true");
      await waitFor(ctx, "__qa.phase==='paused' && !!__qa.visq('.al-pause-layer.al-pause-lite')", { timeout: 10000, what: "paused + light pause menu after alt-tab" });
      await ctx.shot("paused");
      const timerSetting = await c.evaluate("__qa.text([...document.querySelectorAll('.al-pause-layer .al-pause-act')].find(b => /pause timer/i.test(__qa.text(b))))");
      const h0 = hudSeconds(await hudText(ctx));
      const pp0 = await playerPos(ctx);
      await sleep(2500);
      const h1 = hudSeconds(await hudText(ctx));
      const pp1 = await playerPos(ctx);
      const movedPaused = dist(pp0, pp1);
      ctx.note(`paused 2.5 s: HUD time ${h0} -> ${h1} s (setting "${timerSetting || "?"}"), player moved ${movedPaused == null ? "?" : movedPaused.toFixed(2)} m, sim tick ${pp0?.tick} -> ${pp1?.tick}`);
      if (movedPaused > 0.05) throw new Error(`player moved ${movedPaused.toFixed(2)} m while paused`);
      if (/\bon\b/i.test(timerSetting || "") && h0 != null && h1 != null && h0 !== h1) throw new Error(`"Pause timer" is on but the drill timer ran while paused (${h0} -> ${h1} s)`);
      if (/\boff\b/i.test(timerSetting || "") && h0 != null && h1 != null && h0 === h1) ctx.note('timer stood still while paused although "Pause timer" is off');
      if (!timerSetting || h0 == null || h1 == null) ctx.warn(`timer check inconclusive: "Pause timer" ${timerSetting ? `"${timerSetting}"` : "not in the light menu"}, HUD time ${h0} -> ${h1} s while paused`);
      // Resume: the player clicks Resume (that click ends the held mouse button); W never comes up.
      await clickSel(ctx, ".al-pause-layer .al-pause-act.is-primary");
      held.mouse = false;
      await c.moveTo();
      await waitFor(ctx, "__qa.phase==='running' && __qa.locked()", { timeout: 10000, what: "running after Resume" });
      await sleep(300);
      const s0 = await c.evaluate("__qa.shots.length");
      const pa = await playerPos(ctx);
      await sleep(2000);
      const pb = await playerPos(ctx);
      const s1 = await c.evaluate("__qa.shots.length");
      const walkedAfter = dist(pa, pb);
      ctx.note(`2 s after Resume: walked ${walkedAfter == null ? "?" : walkedAfter.toFixed(2)} m, shots ${s1 - s0}`);
      await ctx.shot("after-resume");
      const bad = [];
      if (walked != null && walked < 0.05) ctx.warn("W did not move the player in this drill: the stuck-key check is inconclusive");
      if (walkedAfter > 0.1) bad.push(`player kept walking ${walkedAfter.toFixed(2)} m in 2 s after Resume with no key held (W stuck after alt-tab)`);
      if (s1 - s0 > 0) bad.push(`${s1 - s0} shots fired in 2 s after Resume with no button held (fire stuck after alt-tab)`);
      if (bad.length) throw new Error(`finding: ${bad.join("; ")}. Repro: hold W + left mouse in a map drill, alt-tab, come back, click Resume`);
    } finally {
      if (held.key) await c.keyUp("w").catch(() => {});
      if (held.mouse) await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.cx, y: c.cy, button: "left", clickCount: 1 }).catch(() => {});
    }
    // The drill goes on normally.
    const r = await shootFor(ctx, { seconds: 3, enough: 99, minSeconds: 3 });
    if (r.phase !== "running" || !r.shots) throw new Error(`drill did not go on normally after the alt-tab (phase ${r.phase}, shots ${r.shots})`);
    await exitDrill(ctx);
  },
};

// R13 main case + R5: R spammed every 50 ms for 2 s as the result appears -> exactly one retry,
// one drill instance; then 10 restarts as fast as possible -> a clean single running drill.
const edgeRapidRetry = {
  name: "edge:rapid-retry",
  optional: true,
  strictHealth: true,
  about: "R every 50 ms for 2 s as the result shows -> exactly one retry; 10 back-to-back restarts -> one clean drill (tick rate, HUD, AudioContexts)",
  timeoutMs: 6 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    await ensureProbe(ctx);
    await launchAndStart(ctx, SHORT, "scene", { loadTimeout: 180000 });
    const tRun = Date.now();
    const base = await instanceCheck(ctx, 2000);
    ctx.note(`baseline: __aimTick ${base.tickRate}/s, roots ${base.roots}, HUDs ${base.huds}, AudioContexts ${base.audio}`);
    await c.evaluate("__qa.phases = []; true");
    // Spam from ~1 s before the 7 s drill ends until 2 s have passed and the result was seen
    // (at most 6 s if the sim runs slow).
    const wait = tRun + 6000 - Date.now();
    if (wait > 0) await sleep(wait);
    await c.moveTo();
    const ts = Date.now();
    let presses = 0;
    let sawResult = false;
    while (Date.now() - ts < 6000) {
      await c.key("r");
      presses++;
      if (!sawResult && presses % 4 === 0) sawResult = await c.evaluate("__qa.phases.some(p => p.p === 'result')");
      if (Date.now() - ts >= 2000 && sawResult) break;
      await sleep(50);
    }
    await sleep(1500);
    const ph = await c.evaluate("__qa.phases.map(p => p.p)");
    const iRes = ph.indexOf("result");
    const runsAfter = iRes < 0 ? null : ph.slice(iRes + 1).filter((p) => p === "running").length;
    const runsBefore = (iRes < 0 ? ph : ph.slice(0, iRes)).filter((p) => p === "running").length;
    ctx.note(`R x${presses} over ${((Date.now() - ts - 1500) / 1000).toFixed(1)} s: phases ${ph.join(">")}`);
    const bad = [];
    if (iRes < 0) bad.push("the drill never reached its result screen during the spam");
    if (runsBefore) bad.push(`R restarted the running drill ${runsBefore}x before the result`);
    if (runsAfter != null && runsAfter !== 1) bad.push(`${runsAfter} retries from one result screen (wanted exactly 1)`);
    let st = await status(ctx);
    if (!(st.phase === "running" && st.locked)) {
      ctx.note(`after the spam: ${JSON.stringify({ phase: st.phase, result: st.result, ready: st.ready, locked: st.locked })}`);
      if (st.result) await clickSel(ctx, ".al-result-overlay .al-primary-btn");
      await untilRunning(ctx, "running after the R spam");
    }
    const a = await instanceCheck(ctx, 2000);
    ctx.note(`after R spam: __aimTick ${a.tickRate}/s, roots ${a.roots}, HUDs ${a.huds}, AudioContexts ${a.audio}`);
    await ctx.shot("after-r-spam");
    const single = (x, what, b0 = base) => {
      if (x.roots !== 1) bad.push(`${what}: ${x.roots} trainer roots`);
      if (x.huds > 1) bad.push(`${what}: ${x.huds} HUDs visible`);
      if (b0.tickRate > 0 && x.tickRate > b0.tickRate * 1.5) bad.push(`${what}: __aimTick ${x.tickRate}/s vs ${b0.tickRate}/s before (doubled game loop?)`);
      if (b0.audio != null && x.audio != null && x.audio > b0.audio) bad.push(`${what}: ${x.audio} AudioContexts vs ${b0.audio} before`);
    };
    single(a, "after the R spam");
    // 10 restarts back to back: lock lost + T (the light menu's Restart key) without waiting.
    // On the 60 s Micro tiles (the 7 s drill may already be over by now).
    st = await status(ctx);
    if (st.result) await clickSel(ctx, ".al-result-overlay .al-secondary-btn");
    else await exitDrill(ctx, { to: "none" });
    await waitFor(ctx, "__qa.inLobby()", { timeout: 30000, what: "back in the lobby" });
    await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
    const base2 = await instanceCheck(ctx, 2000);
    ctx.note(`Micro tiles baseline: __aimTick ${base2.tickRate}/s, AudioContexts ${base2.audio}`);
    await c.evaluate("__qa.phases = []; true");
    for (let i = 0; i < 10; i++) {
      await c.evaluate("document.exitPointerLock(); true");
      await c.key("t");
      await sleep(100);
    }
    await sleep(1500);
    const ph2 = await c.evaluate("__qa.phases.map(p => p.p).join('>')");
    st = await status(ctx);
    ctx.note(`10 fast restarts (lock lost + T): phases ${ph2}; now ${JSON.stringify({ phase: st.phase, locked: st.locked, pauseLite: st.pauseLite, ready: st.ready })}`);
    if (st.pauseLite && !st.locked) {
      // T did not restart from the light menu: use its Restart button once.
      await clickSel(ctx, ".al-pause-layer .al-pause-act", "Restart");
    }
    await untilRunning(ctx, "running after the fast restarts");
    const b = await instanceCheck(ctx, 2000);
    ctx.note(`after fast restarts: __aimTick ${b.tickRate}/s, roots ${b.roots}, HUDs ${b.huds}, AudioContexts ${b.audio}`);
    single(b, "after 10 fast restarts", base2);
    if (!/running/.test(ph2)) bad.push(`10 x (lock lost + T) never restarted the drill although the light menu shows "RESTART T" (phases ${ph2 || "none"})`);
    // One normal run.
    const r = await shootFor(ctx, { seconds: 4, enough: 1, minSeconds: 2 });
    ctx.note(`normal run: phase ${r.phase}, kills ${r.kills}, shots ${r.shots}`);
    if (!r.shots) bad.push("no shot registered in the normal run after the restarts");
    await ctx.shot("normal-run");
    if (bad.length) throw new Error(`finding: ${bad.join("; ")}`);
    st = await status(ctx);
    if (st.result) await clickSel(ctx, ".al-result-overlay .al-secondary-btn");
    else await exitDrill(ctx);
  },
};

// R13: main thread busy for 2.5 s mid-drill -> sim and timer stay sane (no runaway catch-up).
const edgeHitch = {
  name: "edge:hitch",
  optional: true,
  strictHealth: true,
  about: "2.5 s main-thread stall mid-drill: sim speed and HUD timer sane after, no runaway catch-up, frames recover",
  timeoutMs: 4 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
    await sleep(1500);
    const snap = () => c.evaluate("({ tick: __qa.last ? __qa.last.tick : null, frames: __qa.ticks, t: Date.now(), hud: __qa.text(__qa.visq('.al-hud')), phase: __qa.phase })");
    const a = await snap();
    await c.evaluate("(() => { const t = performance.now(); let n = 0; while (performance.now() - t < 2500) n++; return n; })()", { timeout: 20000 });
    const b = await snap();
    await sleep(3000);
    const d = await snap();
    const fps = await c.evaluate("__qa.fps(1000)");
    const wallAB = (b.t - a.t) / 1000;
    const wallAD = (d.t - a.t) / 1000;
    const simAB = (b.tick - a.tick) / 128;
    const simBD = (d.tick - b.tick) / 128 / ((d.t - b.t) / 1000);
    const simAD = (d.tick - a.tick) / 128;
    const ha = hudSeconds(a.hud);
    const hd = hudSeconds(d.hud);
    const line = `stall ${wallAB.toFixed(1)} s wall: sim +${simAB.toFixed(2)} s during it; after: sim ${simBD.toFixed(2)} s/s, ${fps} fps; over ${wallAD.toFixed(1)} s wall the sim ran ${simAD.toFixed(2)} s, HUD time ${ha} -> ${hd} s`;
    ctx.note(line);
    ctx.data("hitch", { wallAB, simAB, simBD, fps, wallAD, simAD, hudFrom: ha, hudTo: hd });
    await ctx.shot("after-stall");
    const bad = [];
    if (d.phase !== "running") bad.push(`phase ${d.phase} after the stall`);
    if (simAD > wallAD * 1.1 + 0.25) bad.push(`sim ran ahead of real time (${simAD.toFixed(2)} s in ${wallAD.toFixed(1)} s)`);
    if (!(simBD > 0.8 && simBD < 1.25)) bad.push(`sim speed ${simBD.toFixed(2)} s/s after the stall (runaway catch-up or stuck)`);
    if (fps < 20) bad.push(`only ${fps} fps 3 s after the stall`);
    if (ha != null && hd != null && ha - hd > wallAD + 1) bad.push(`HUD timer dropped ${(ha - hd).toFixed(1)} s in ${wallAD.toFixed(1)} s`);
    if (simAD < wallAD * 0.5) ctx.note("the sim dropped most of the stall (clamped catch-up)");
    if (bad.length) throw new Error(`finding: ${bad.join("; ")} (${line})`);
    await exitDrill(ctx);
  },
};

const LOADER = "!!document.querySelector('section.al-wkload, .aim-scenario-loading')";

// R13: clicking the start overlay while the loader is still up.
const edgeStartOverlay = {
  name: "edge:start-overlay",
  optional: true,
  strictHealth: true,
  about: "clicks on the drill screen every 300 ms while the loader is still up: the drill still loads, starts once, runs",
  timeoutMs: 5 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    await c.updateCenter();
    await launchDrill(ctx, MAP, "scene");
    const t0 = Date.now();
    let clicks = 0;
    let sawLoader = false;
    while (Date.now() - t0 < 120000) {
      ctx.check();
      const up = await c.evaluate(LOADER);
      if (up) {
        sawLoader = true;
        await c.click(c.cx, c.cy);
        clicks++;
      } else if (sawLoader || Date.now() - t0 > 5000) break;
      await sleep(300);
    }
    const loadMs = Date.now() - t0;
    await sleep(1500);
    let st = await status(ctx);
    const fell = await c.evaluate("__qa.fellBack()");
    ctx.note(`${clicks} clicks while the loader was up (${(loadMs / 1000).toFixed(1)} s); then ${JSON.stringify({ phase: st.phase, locked: st.locked, ready: st.ready, lobby: st.lobby, failed: st.failed })}`);
    await ctx.shot("after-load");
    if (!sawLoader) ctx.warn("never saw the loader (load too fast to click during it)");
    if (fell) throw new Error(`finding: clicking during the load dropped the player back in the lobby (${clicks} clicks). Repro: launch Ascent pre-aim, click the screen while it loads`);
    if (st.failed) throw new Error("finding: the drill failed to load after clicks during the load");
    if (await c.evaluate(LOADER)) {
      await waitFor(ctx, `!(${LOADER})`, { timeout: 60000, what: "loader gone" }).catch(() => {
        throw new Error("finding: loader still up 60 s after the clicks (stuck loader)");
      });
    }
    st = await status(ctx);
    if (!(st.phase === "running" && st.locked)) await startDrill(ctx);
    else ctx.note("a click during the load started the drill as soon as it was ready");
    const r = await shootFor(ctx, { seconds: 3, enough: 99, minSeconds: 3 });
    const one = await instanceCheck(ctx, 1500);
    ctx.note(`then: shots ${r.shots}, phase ${r.phase}, roots ${one.roots}, HUDs ${one.huds}`);
    if (!r.shots || r.phase !== "running") throw new Error(`drill not running normally after the clicks (phase ${r.phase}, shots ${r.shots})`);
    if (one.roots !== 1 || one.huds > 1) throw new Error(`finding: ${one.roots} trainer roots / ${one.huds} HUDs after clicking during the load`);
    await exitDrill(ctx);
  },
};

// R7: backed out mid-load, then launched another drill at once; Esc spam on the result screen;
// in-drill Esc (modelled as lock lost).
const edgeBackSpam = {
  name: "edge:back-spam",
  optional: true,
  strictHealth: true,
  about: "back out of a map drill mid-load and launch another drill at once (right drill, no hijack); Esc spam on the result screen and in the drill",
  timeoutMs: 7 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    const bad = [];
    // 1. Back out mid-load.
    await launchDrill(ctx, MAP, "scene");
    await waitFor(ctx, LOADER, { timeout: 15000, every: 100, what: "loader up" }).catch(() => ctx.warn("loader never showed"));
    await sleep(500);
    await ctx.shot("loading");
    let how = null;
    for (let i = 0; i < 5; i++) {
      await c.key("Escape");
      await sleep(150);
    }
    if (await waitFor(ctx, `__qa.inLobby() && !(${LOADER})`, { timeout: 3000, every: 200 }).catch(() => false)) how = "Esc";
    if (!how) {
      // A back/cancel control on the loader or the trainer frame, if any is uncovered.
      for (const sel of [".al-wkload button", ".aim-scenario-loading button", ".al-aimlab-root .al-scene-start-back", ".hall-train-exit"]) {
        const p = await c.evaluate(`__qa.at(${J(sel)})`);
        if (!p || p.covered) continue;
        await c.click(p.x, p.y);
        if (await waitFor(ctx, `__qa.inLobby() && !(${LOADER})`, { timeout: 5000, every: 200 }).catch(() => false)) {
          how = sel;
          break;
        }
      }
    }
    ctx.note(`back out mid-load: ${how || "no way found (Esc x5 and the visible back buttons did nothing)"}`);
    if (!how) {
      ctx.warn("finding: a loading drill cannot be cancelled (Esc does nothing, no uncovered back button); waited it out");
      await waitFor(ctx, `!(${LOADER})`, { timeout: 120000, what: "load finished" });
      await toLobby(ctx);
    }
    // 2. Launch another drill at once: it must be the drill that loads and stays (the old map
    // load must not take over).
    await launchDrill(ctx, LIGHT, "scene");
    await startDrill(ctx, { loadTimeout: 180000 });
    const tpl = await c.evaluate("Object.keys(__qa.bodies)");
    const check = () => c.evaluate(`(() => { const a = (__qa.last && __qa.last.actors) || []; const want = new Set(${J(tpl)}); return { n: a.length, foreign: a.filter(x => want.size && !want.has(String(x.templateId))).map(x => x.templateId).slice(0, 5), phase: __qa.phase, locked: __qa.locked(), lobby: __qa.inLobby() }; })()`);
    const s1 = await check();
    await sleep(6000);
    const s2 = await check();
    ctx.note(`next drill (${LIGHT.name}): ${JSON.stringify(s1)} -> 6 s later ${JSON.stringify(s2)}`);
    await ctx.shot("next-drill");
    if (s1.foreign.length || s2.foreign.length) bad.push(`after backing out of ${MAP.name}, ${LIGHT.name} shows actors of another drill (${[...s1.foreign, ...s2.foreign].join(",")})`);
    if (s2.phase !== "running" || s2.lobby) bad.push(`${LIGHT.name} did not keep running after the back-out (phase ${s2.phase}, lobby ${s2.lobby})`);
    await exitDrill(ctx);
    // 3. Esc spam on the result screen.
    await launchAndStart(ctx, SHORT, "scene", { loadTimeout: 180000 });
    await playToResult(ctx, { maxSeconds: 40 });
    for (let i = 0; i < 6; i++) {
      await c.key("Escape");
      await sleep(100);
    }
    await sleep(1500);
    let st = await status(ctx);
    ctx.note(`Esc x6 on the result screen -> ${st.result ? "result screen" : st.lobby ? "lobby" : JSON.stringify(st)}`);
    await ctx.shot("result-esc");
    if (!st.result && !st.lobby) bad.push(`Esc spam on the result screen left neither the result nor the lobby (${JSON.stringify({ phase: st.phase, ready: st.ready, loading: st.loading })})`);
    if (st.result) await clickSel(ctx, ".al-result-overlay .al-secondary-btn");
    await waitFor(ctx, "__qa.inLobby()", { timeout: 30000, what: "lobby" }).catch(() => bad.push("could not get back to the lobby from the result screen after Esc spam"));
    // 4. In-drill Esc: lock lost + Esc spam, then Resume works.
    await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
    await c.evaluate("document.exitPointerLock(); true");
    for (let i = 0; i < 6; i++) {
      await c.key("Escape");
      await sleep(100);
    }
    await sleep(800);
    st = await status(ctx);
    ctx.note(`in drill: lock lost + Esc x6 -> ${JSON.stringify({ phase: st.phase, pauseLite: st.pauseLite, pauseMenu: st.pauseMenu, lobby: st.lobby })}`);
    if (st.pauseLite || st.pauseMenu) {
      await clickSel(ctx, ".al-pause-layer .al-pause-act.is-primary");
      await untilRunning(ctx, "running after Resume");
      await exitDrill(ctx);
    } else if (!st.lobby) bad.push(`in-drill Esc spam left no pause menu (phase ${st.phase})`);
    // 5. A drill still starts.
    await waitFor(ctx, "__qa.inLobby()", { timeout: 30000, what: "lobby" }).catch(() => toLobby(ctx));
    await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
    await exitDrill(ctx);
    if (bad.length) throw new Error(`finding: ${bad.join("; ")}`);
  },
};

// R8: window size / pixel ratio changes in the lobby and mid-drill.
const SIZES = [[1280, 720, 1], [800, 600, 1], [1920, 1080, 1], [1024, 768, 1.25], [1280, 720, 1.5]];
const LAYOUT_EXPR = `(() => {
  const W = innerWidth, H = innerHeight, dpr = devicePixelRatio;
  const cvs = [...document.querySelectorAll('canvas')].filter(__qa.vis).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  const cv = document.pointerLockElement && document.pointerLockElement.tagName === 'CANVAS' ? document.pointerLockElement : cvs[0];
  const r = cv ? cv.getBoundingClientRect() : null;
  const out = { W, H, dpr, canvas: cv ? { cw: cv.clientWidth, ch: cv.clientHeight, w: cv.width, h: cv.height, left: Math.round(r.left), top: Math.round(r.top) } : null };
  const cross = [...document.querySelectorAll('[class*=crosshair i],[id*=crosshair i]')].filter(__qa.vis).map((e) => { const b = e.getBoundingClientRect(); return { cls: String(e.className).slice(0, 50), cx: +(b.left + b.width / 2).toFixed(1), cy: +(b.top + b.height / 2).toFixed(1), w: b.width, h: b.height }; }).filter((e) => e.w > 0 && e.w < 200);
  out.crosshair = cross[0] || null;
  out.outside = [...document.querySelectorAll('.al-hud *, #aim-round-hud *')].filter((e) => e.children.length === 0 && __qa.vis(e) && __qa.text(e)).map((e) => ({ e, b: e.getBoundingClientRect() }))
    .filter(({ b }) => b.width > 0 && (b.left < -1 || b.top < -1 || b.right > W + 1 || b.bottom > H + 1)).slice(0, 5).map(({ e, b }) => String(e.className).slice(0, 30) + '"' + __qa.text(e).slice(0, 20) + '"@' + [b.left, b.top, b.right, b.bottom].map(Math.round).join(','));
  out.scrollW = document.scrollingElement ? document.scrollingElement.scrollWidth : null;
  out.navOk = (() => { const n = document.querySelector('.hall-topnav'); if (!n || !__qa.vis(n)) return null; const b = n.getBoundingClientRect(); return b.left >= -1 && b.right <= W + 1; })();
  return out;
})()`;

const edgeResize = {
  name: "edge:resize",
  optional: true,
  strictHealth: true,
  about: "lobby and mid-drill at 1280x720, 800x600, 1920x1080, 1024x768@1.25, 1280x720@1.5: canvas fills the view, buffer follows, crosshair centred, HUD inside",
  timeoutMs: 6 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    const bad = [];
    const setSize = async ([w, h, dpr]) => {
      await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
      await sleep(1000);
      await c.updateCenter();
    };
    // Browser.setWindowBounds once (R8): the real window resize path, if this target allows it.
    try {
      const win = await c.send("Browser.getWindowForTarget", {}, 5000);
      const old = win.bounds;
      await c.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { width: 1024, height: 768 } }, 5000);
      await sleep(800);
      const sz = await c.evaluate("[innerWidth, innerHeight]");
      await c.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { width: old.width, height: old.height } }, 5000);
      await sleep(800);
      ctx.note(`Browser.setWindowBounds 1024x768 -> page ${sz.join("x")} (window was ${old.width}x${old.height})`);
    } catch (e) {
      ctx.note(`Browser.setWindowBounds not available here (${String(e.message || e).slice(0, 80)}); using Emulation.setDeviceMetricsOverride`);
    }
    try {
      // Lobby.
      for (const s of SIZES) {
        await setSize(s);
        const L = await c.evaluate(LAYOUT_EXPR);
        const tag = `${s[0]}x${s[1]}@${s[2]}`;
        await ctx.shot(`lobby-${tag}`);
        if (L.W !== s[0] || L.H !== s[1]) bad.push(`lobby ${tag}: page is ${L.W}x${L.H}`);
        if (L.navOk === false) bad.push(`lobby ${tag}: top nav sticks out of the window`);
        if (L.scrollW > L.W + 1) ctx.warn(`lobby ${tag}: page scrolls sideways (content ${L.scrollW} px wide)`);
        if (!(await c.evaluate("__qa.inLobby()"))) bad.push(`lobby ${tag}: lobby not ready after resize`);
      }
      // Mid-drill.
      await setSize(SIZES[0]);
      await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
      const ratios = [];
      for (const s of [...SIZES.slice(1), SIZES[0]]) {
        await setSize(s);
        const L = await c.evaluate(LAYOUT_EXPR);
        const st = await status(ctx);
        const tag = `${s[0]}x${s[1]}@${s[2]}`;
        await ctx.shot(`drill-${tag}`);
        const cv = L.canvas;
        // Buffer per css pixel: must be the same at every size for one pixel ratio (else the
        // buffer kept an old size); below the pixel ratio = rendered at a lower resolution.
        const ratio = cv && cv.cw ? +(cv.w / cv.cw).toFixed(3) : null;
        ratios.push({ dpr: L.dpr, ratio, tag });
        ctx.note(`drill ${tag}: canvas ${cv ? `${cv.cw}x${cv.ch} css, buffer ${cv.w}x${cv.h} (${ratio} buffer px per css px)` : "none"}, crosshair ${L.crosshair ? `${L.crosshair.cx},${L.crosshair.cy}` : "drawn in the canvas"}, ${st.phase}${st.locked ? " locked" : ""}`);
        if (!cv) bad.push(`drill ${tag}: no canvas`);
        else if (Math.abs(cv.cw - L.W) > 2 || Math.abs(cv.ch - L.H) > 2) bad.push(`drill ${tag}: canvas ${cv.cw}x${cv.ch} does not fill the ${L.W}x${L.H} view`);
        if (L.crosshair && (Math.abs(L.crosshair.cx - L.W / 2) > 2 || Math.abs(L.crosshair.cy - L.H / 2) > 2)) bad.push(`drill ${tag}: crosshair at ${L.crosshair.cx},${L.crosshair.cy}, centre is ${L.W / 2},${L.H / 2}`);
        if (L.outside.length) bad.push(`drill ${tag}: HUD outside the view: ${L.outside.join("; ")}`);
        if (st.phase !== "running") ctx.note(`drill ${tag}: phase ${st.phase} after the resize`);
      }
      for (const d of new Set(ratios.map((x) => x.dpr))) {
        const rs = ratios.filter((x) => x.dpr === d && x.ratio > 0);
        const v = rs.map((x) => x.ratio);
        if (v.length > 1 && Math.max(...v) / Math.min(...v) > 1.1) bad.push(`drawing buffer did not follow the resize at pixel ratio ${d} (${rs.map((x) => `${x.tag} ${x.ratio}`).join(", ")} buffer px per css px)`);
        if (d > 1 && v.length && Math.max(...v) < d * 0.9) ctx.warn(`at ${d}x pixel ratio (Windows display scaling ${Math.round(d * 100)}%) the 3D view renders ${Math.max(...v)} buffer px per css px, not ${d}: lower resolution than the screen (blurrier), maybe on purpose for speed`);
      }
      if (!ratios.length || !(await c.evaluate(LAYOUT_EXPR)).crosshair) ctx.note("crosshair centring not checked: it is drawn inside the canvas (no DOM element); the canvas filling the view is checked instead");
      const r = await shootFor(ctx, { seconds: 3, enough: 1, minSeconds: 2 });
      ctx.note(`after resizes: kills ${r.kills}, shots ${r.shots}, phase ${r.phase}`);
      if (!r.shots) bad.push("no shot registered after the resizes");
    } finally {
      await c.send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
      await sleep(800);
      await c.updateCenter();
    }
    if (bad.length) throw new Error(`finding: ${bad.join("; ")}`);
    if (!(await c.evaluate("__qa.inLobby()"))) await exitDrill(ctx);
  },
};

// R10: odd saved values in localStorage (garbage, wrong types) -> the app still boots to the
// lobby without errors and a drill starts; the exact snapshot is restored after (never clear()).
// Keys the app itself rewrites on every boot (timestamps such as al-welcome-snoozed-at-v1).
const APP_REWRITES = /-at-v\d+$/;
const LS_SNAPSHOT = "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))";
async function restoreLocalStorage(ctx, snap) {
  await ctx.cdp.evaluate(`(() => { const s = JSON.parse(${J(snap)}); for (const k of Object.keys(localStorage)) if (!(k in s)) localStorage.removeItem(k); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); return true; })()`);
}

const edgeSaved = {
  name: "edge:saved",
  optional: true,
  strictHealth: true,
  about: "garbage / wrong-type saved settings (sensitivity, display, bot mode, rank picks, round setup, history keys) -> reload boots to the lobby without errors, a drill starts; snapshot restored",
  timeoutMs: 7 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    const snap = await c.evaluate(LS_SNAPSHOT);
    const keys = Object.keys(JSON.parse(snap));
    const extra = keys.filter((k) => /history|progress|stats|record|best|streak|daily|plan/i.test(k));
    ctx.note(`localStorage has ${keys.length} keys; history-like: ${extra.join(", ") || "none"}`);
    const variants = [
      ["garbage", { "al-sensitivity-v1": "banana", "al-display-settings-v1": "{not json", "aim-bot-mode": "%%%", "aim-enemy-rank": "xyz", "aim-rank-picks": "[1,2", "aim-round-setup": "{", "aim-unlimited-v1": "maybe", ...Object.fromEntries(extra.map((k) => [k, "{broken"])) }],
      ["wrong types", { "al-sensitivity-v1": "1e309", "al-display-settings-v1": "[]", "aim-bot-mode": "null", "aim-enemy-rank": "42", "aim-rank-picks": '"str"', "aim-round-setup": "42", "aim-unlimited-v1": "{}", ...Object.fromEntries(extra.map((k) => [k, "null"])) }],
    ];
    const bad = [];
    try {
      for (const [name, vals] of variants) {
        await c.evaluate(`(() => { const v = ${J(vals)}; for (const [k, x] of Object.entries(v)) localStorage.setItem(k, x); return true; })()`);
        await c.send("Page.reload", {});
        await sleep(1500);
        await c.ensureAttached();
        try {
          await waitLobby(ctx, 90000);
        } catch (e) {
          await ctx.shot(`${name.replace(/ /g, "-")}-no-lobby`);
          bad.push(`${name}: lobby did not come up (${String(e.message || e).slice(0, 120)})`);
          continue;
        }
        await ctx.shot(name.replace(/ /g, "-"));
        const sensShown = await c.evaluate("(document.querySelector('input[data-action=hall-sensitivity]') || {}).value");
        await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
        const y = await yawFor(ctx, 50);
        ctx.note(`${name}: lobby up, sensitivity shows "${sensShown}", drill started, yaw for 50 counts ${Number.isFinite(y.d) ? y.d.toFixed(4) : y.d} rad (stored sens "${y.sens}")`);
        if (!Number.isFinite(y.d) || !Number.isFinite(y.y1)) bad.push(`${name}: camera yaw became ${y.y1} after a mouse move (stored sensitivity "${y.sens}")`);
        else if (y.d === 0) bad.push(`${name}: the mouse does not turn the camera (stored sensitivity "${y.sens}")`);
        if (sensShown != null && !Number.isFinite(Number(sensShown))) bad.push(`${name}: lobby sensitivity shows "${sensShown}"`);
        await exitDrill(ctx);
      }
    } finally {
      await restoreLocalStorage(ctx, snap);
      await c.send("Page.reload", {}).catch(() => {});
      await sleep(1500);
      await c.ensureAttached();
      await waitLobby(ctx, 90000);
      const now = await c.evaluate(LS_SNAPSHOT);
      const a = JSON.parse(snap);
      const b = JSON.parse(now);
      // The app may write its own keys back on boot (fresh defaults); only our keys must match.
      const diff = Object.keys(a).filter((k) => a[k] !== b[k] && !APP_REWRITES.test(k));
      if (diff.length) ctx.warn(`after restore, keys differ from the snapshot: ${diff.slice(0, 6).join(", ")}`);
      else ctx.note("localStorage snapshot restored");
    }
    if (bad.length) throw new Error(`finding: ${bad.join("; ")}`);
  },
};

// R9: extreme / garbage sensitivity typed into the real input (Input.insertText + Enter + blur).
const SENS_KEY = "al-sensitivity-v1";
async function typeSens(ctx, text) {
  const c = ctx.cdp;
  await clickSel(ctx, "input[data-action=hall-sensitivity]");
  await c.evaluate("(() => { const i = document.querySelector('input[data-action=hall-sensitivity]'); i.focus(); i.select && i.select(); return true; })()");
  if (text) await c.send("Input.insertText", { text });
  else await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }).then(() => c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }));
  await c.key("Enter");
  await c.evaluate("(() => { const i = document.querySelector('input[data-action=hall-sensitivity]'); i && i.blur(); return true; })()");
  await sleep(400);
  return c.evaluate(`({ stored: localStorage.getItem(${J(SENS_KEY)}), shown: (document.querySelector('input[data-action=hall-sensitivity]') || {}).value })`);
}

const edgeSens = {
  name: "edge:sens",
  optional: true,
  strictHealth: true,
  about: "typed sensitivity 0.001 / 10 / out of range / garbage: clamped or rejected, stored value finite and in 0.001-10, survives reload, aim scales in a drill; restored",
  timeoutMs: 7 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    const orig = await c.evaluate(`localStorage.getItem(${J(SENS_KEY)})`);
    const bad = [];
    const table = [];
    try {
      const meta = await c.evaluate("(() => { const i = document.querySelector('input[data-action=hall-sensitivity]'); return i ? { type: i.type, min: i.min, max: i.max, step: i.step } : null; })()");
      if (!meta) throw new Error("no lobby sensitivity input (input[data-action=hall-sensitivity])");
      ctx.note(`input type=${meta.type} min=${meta.min || "-"} max=${meta.max || "-"} step=${meta.step || "-"}`);
      for (const v of ["0.001", "10", "0.0001", "11", "99999", "-1", "0", "abc", "", "1e3", "0.5"]) {
        // From 0.5 each time, so a rejected value (stays 0.5) and a clamped one can be told apart.
        if (v !== "0.5") await typeSens(ctx, "0.5");
        const r = await typeSens(ctx, v);
        table.push(`"${v}" -> stored ${r.stored == null ? "(none)" : `"${r.stored}"`}, shown "${r.shown}"`);
        const n = r.stored == null ? null : Number(r.stored);
        if (r.stored != null && !(Number.isFinite(n) && n >= 0.001 && n <= 10)) bad.push(`typed "${v}" stored "${r.stored}" (outside 0.001-10)`);
        if (r.shown !== "" && !Number.isFinite(Number(r.shown))) bad.push(`typed "${v}" shows "${r.shown}"`);
        if (r.stored != null && r.shown !== "" && Math.abs(Number(r.shown) - n) > 1e-9) bad.push(`typed "${v}": shows ${r.shown} but stored ${r.stored}`);
      }
      ctx.note(table.join("; "));
      // Extremes in a drill: yaw for 100 counts must be finite and scale with the sensitivity
      // (0.07 deg per count x sens; mouse right lowers yaw).
      const res = {};
      for (const v of ["10", "0.001"]) {
        const r = await typeSens(ctx, v);
        if (r.stored !== v && Number(r.stored) !== Number(v)) {
          bad.push(`could not set ${v} for the drill check (stored ${r.stored})`);
          continue;
        }
        // Survives a reload.
        await c.send("Page.reload", {});
        await sleep(1500);
        await c.ensureAttached();
        await waitLobby(ctx, 90000);
        const after = await c.evaluate(`localStorage.getItem(${J(SENS_KEY)})`);
        if (Number(after) !== Number(v)) bad.push(`sensitivity ${v} did not survive a reload (stored ${after})`);
        await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
        const y = await yawFor(ctx, 100);
        const want = -100 * 0.07 * Number(v) * Math.PI / 180;
        res[v] = y.d;
        ctx.note(`sens ${v}: yaw for 100 counts ${Number.isFinite(y.d) ? y.d.toExponential(3) : y.d} rad (expected ${want.toExponential(3)})`);
        if (!Number.isFinite(y.d)) bad.push(`sens ${v}: yaw ${y.d}`);
        else if (Math.abs(y.d / want - 1) > 0.1) bad.push(`sens ${v}: yaw for 100 counts ${y.d.toExponential(3)} rad, expected ${want.toExponential(3)}`);
        await exitDrill(ctx);
      }
      await ctx.shot("sens");
    } finally {
      // Restore (R9): the original value, or no key at all.
      await typeSens(ctx, orig ?? "0.5").catch(() => {});
      if (orig == null) await c.evaluate(`localStorage.removeItem(${J(SENS_KEY)}); true`);
      else await c.evaluate(`localStorage.setItem(${J(SENS_KEY)}, ${J(orig)}); true`);
      const back = await c.evaluate(`localStorage.getItem(${J(SENS_KEY)})`);
      if (back !== orig) bad.push(`could not restore the sensitivity (${back} vs ${orig})`);
    }
    if (bad.length) throw new Error(`finding: ${bad.join("; ")}`);
  },
};

// R13: settings changed mid-drill (Tab menu -> Settings dialog -> sensitivity, crosshair, FOV,
// quality -> Done -> Resume): applies at once, the drill goes on, the change is saved. The dialog
// ("Changes save right away and apply to this run") is the lobby's .hall-dialog; tabs General,
// Control, Crosshair, Video, Audio, Visuals (discovery run 2026-11-08).
const DIALOG_JS = String.raw`(() => {
  const x = [...document.querySelectorAll('.hall-dialog-close')].find(__qa.vis);
  if (!x) return null;
  let r = x.parentElement;
  while (r && !r.querySelector('.hall-dialog-btn')) r = r.parentElement;
  return r;
})()`;
// Mark an element inside the dialog with data-qa=<tag> (so clickSel can do the covered check).
// pick(root) runs in the page and returns the element or null.
async function markInDialog(ctx, tag, pick) {
  return ctx.cdp.evaluate(`(() => { const root = ${DIALOG_JS}; if (!root) return 'no dialog'; for (const e of document.querySelectorAll('[data-qa=${tag}]')) e.removeAttribute('data-qa');
    const el = (${pick})(root); if (!el) return null; el.setAttribute('data-qa', ${J(tag)}); return __qa.text(el.closest('[class*=row],[class*=item],label,li') || el).slice(0, 80) || el.tagName; })()`);
}
async function dialogTab(ctx, name) {
  const t = await markInDialog(ctx, "tab", `(root) => [...root.querySelectorAll('button,[role=tab],a,li,div')].filter((e) => __qa.vis(e) && e.children.length <= 2 && __qa.text(e).toLowerCase() === ${J(name.toLowerCase())})[0]`);
  if (!t || t === "no dialog") return false;
  await clickSel(ctx, "[data-qa=tab]");
  await sleep(500);
  return true;
}
async function typeInto(ctx, sel, text) {
  await clickSel(ctx, sel);
  await ctx.cdp.evaluate(`(() => { const i = document.querySelector(${J(sel)}); i.focus(); i.select && i.select(); return true; })()`);
  await ctx.cdp.send("Input.insertText", { text });
  await ctx.cdp.key("Enter");
  await ctx.cdp.evaluate(`(() => { const i = document.querySelector(${J(sel)}); i && i.blur(); return true; })()`);
  await sleep(400);
}
const lsDiff = (a, b) => {
  const A = JSON.parse(a);
  const B = JSON.parse(b);
  return [...new Set([...Object.keys(A), ...Object.keys(B)])].filter((k) => A[k] !== B[k]);
};

const edgeSettingsMid = {
  name: "edge:settings-mid",
  optional: true,
  strictHealth: true,
  about: "mid-drill: Tab menu -> Settings: sensitivity, crosshair, FOV, quality -> Done -> Resume: applies at once, drill goes on, saved; restored",
  timeoutMs: 6 * 60000,
  async run(ctx) {
    const c = ctx.cdp;
    const snap = await c.evaluate(LS_SNAPSHOT);
    const bad = [];
    const done = [];
    try {
      await launchAndStart(ctx, LIGHT, "scene", { loadTimeout: 180000 });
      const y0 = await yawFor(ctx, 100);
      const sens0 = Number(y0.sens) || 0.5;
      await c.key("Tab");
      await waitFor(ctx, "!!__qa.visq('.al-pause-layer.al-pause-overlay')", { timeout: 10000, what: "full pause menu" });
      await clickSel(ctx, ".al-pause-layer .al-pause-act", String.raw`^\s*Settings\b`);
      await waitFor(ctx, `!!${DIALOG_JS}`, { timeout: 10000, what: "settings dialog (.hall-dialog-close)" });
      await ctx.shot("dialog");
      // Sensitivity (General tab): a number box with max 10.
      const want = sens0 === 0.8 ? "0.9" : "0.8";
      let before = await c.evaluate(LS_SNAPSHOT);
      if (!(await dialogTab(ctx, "General"))) ctx.warn("no General tab in the settings dialog");
      const sensRow = await markInDialog(ctx, "sens", `(root) => [...root.querySelectorAll('input[type=number]')].filter((i) => __qa.vis(i) && Number(i.max) === 10)[0]`);
      if (!sensRow || sensRow === "no dialog") bad.push("no sensitivity box (number, max 10) in the in-drill settings dialog");
      else {
        const meta = await c.evaluate("(() => { const i = document.querySelector('[data-qa=sens]'); return { min: i.min, max: i.max, step: i.step, v: i.value }; })()");
        await typeInto(ctx, "[data-qa=sens]", want);
        const after = await c.evaluate(LS_SNAPSHOT);
        const keys = lsDiff(before, after);
        const stored = await c.evaluate(`localStorage.getItem(${J(SENS_KEY)})`);
        done.push(`sensitivity ${meta.v} -> ${want} (box min ${meta.min} max ${meta.max}; saved keys ${keys.join(",") || "none"})`);
        if (Number(stored) !== Number(want)) bad.push(`sensitivity typed in the in-drill dialog was not saved (al-sensitivity-v1 = ${stored}, wanted ${want})`);
        if (meta.min && Number(meta.min) !== 0.001) ctx.note(`in-drill sensitivity box min is ${meta.min}; the lobby box allows 0.001`);
        before = after;
      }
      // Crosshair: flip the first switch on the Crosshair tab whose clickable part (the box, the
      // styled knob next to it, or its label) is really on top at its centre. Each of these
      // extra changes is best effort: a control that is not found is a warning, not a failure.
      try {
        if (await dialogTab(ctx, "Crosshair")) {
          await ctx.shot("crosshair-tab");
          const row = await markInDialog(ctx, "xh", `(root) => {
            const onTop = (e) => { if (!e || !e.getClientRects().length) return false; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false; const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && (t === e || e.contains(t)); };
            for (const i of root.querySelectorAll('input[type=checkbox]')) {
              const host = i.closest('label') || i.parentElement;
              if (!host || !host.getClientRects().length) continue;
              for (const e of [i, i.nextElementSibling, host]) if (onTop(e)) return e;
            }
            return null; }`);
          if (row && row !== "no dialog") {
            await clickSel(ctx, "[data-qa=xh]");
            await sleep(400);
            const after = await c.evaluate(LS_SNAPSHOT);
            done.push(`crosshair switch "${row.slice(0, 40)}" (saved keys ${lsDiff(before, after).join(",") || "none"})`);
            if (!lsDiff(before, after).length) ctx.warn(`crosshair switch "${row.slice(0, 40)}" changed no saved value`);
            before = after;
          } else ctx.warn("no clickable switch on the Crosshair tab");
        } else ctx.warn("no Crosshair tab in the settings dialog");
      } catch (e) {
        ctx.warn(`crosshair change skipped: ${String(e.message || e).slice(0, 160)}`);
      }
      // Video: FOV number box and a quality choice.
      if (await dialogTab(ctx, "Video").catch(() => false)) try {
        await ctx.shot("video-tab");
        const fov = await markInDialog(ctx, "fov", String.raw`(root) => { for (const i of root.querySelectorAll('input[type=number],input[type=range]')) { if (!__qa.vis(i)) continue; let r = i; for (let k = 0; k < 5 && r; k++) { r = r.parentElement; if (r && /\bfov\b|field of view/i.test(__qa.text(r)) && !/viewmodel/i.test(__qa.text(r)) && __qa.text(r).length < 240) return root.contains(r) ? [...r.querySelectorAll('input[type=number]')].find(__qa.vis) || i : null; } } return null; }`);
        if (fov && fov !== "no dialog") {
          const v = await c.evaluate("(() => { const i = document.querySelector('[data-qa=fov]'); return { v: Number(i.value), min: Number(i.min), max: Number(i.max), type: i.type }; })()");
          const nv = String(v.v + 5 <= (v.max || 999) ? v.v + 5 : v.v - 5);
          if (v.type === "number") await typeInto(ctx, "[data-qa=fov]", nv);
          else await c.evaluate(`(() => { const i = document.querySelector('[data-qa=fov]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${J(nv)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
          const after = await c.evaluate(LS_SNAPSHOT);
          done.push(`FOV ${v.v} -> ${nv} (saved keys ${lsDiff(before, after).join(",") || "none"})`);
          if (!lsDiff(before, after).length) ctx.warn(`FOV ${v.v} -> ${nv} changed no saved value`);
          before = after;
        } else ctx.warn("no FOV box on the Video tab");
        const q = await markInDialog(ctx, "q", `(root) => { for (const r of root.querySelectorAll('*')) { if (!__qa.vis(r) || r.children.length < 1) continue; const t = __qa.text(r); if (t.length > 200 || !/quality|render scale|resolution/i.test(t)) continue; const bs = [...r.querySelectorAll('button')].filter(__qa.vis); if (bs.length >= 2) return bs.find((b) => !/is-on|is-active|active|selected/.test(b.className) && b.getAttribute('aria-pressed') !== 'true') || null; } return null; }`);
        if (q && q !== "no dialog") {
          const label = await c.evaluate("__qa.text(document.querySelector('[data-qa=q]'))");
          await clickSel(ctx, "[data-qa=q]");
          await sleep(600);
          const after = await c.evaluate(LS_SNAPSHOT);
          done.push(`quality -> "${label}" (saved keys ${lsDiff(before, after).join(",") || "none"})`);
          if (!lsDiff(before, after).length) ctx.warn(`quality "${label}" changed no saved value`);
          before = after;
        } else ctx.warn("no quality choice on the Video tab");
      } catch (e) {
        ctx.warn(`video change skipped: ${String(e.message || e).slice(0, 160)}`);
      }
      else ctx.warn("no Video tab in the settings dialog");
      await ctx.shot("changed");
      // Close (Done), then resume.
      await clickSel(ctx, ".hall-dialog-btn.is-primary", "Done").catch(() => clickSel(ctx, ".hall-dialog-close"));
      await waitFor(ctx, `!${DIALOG_JS}`, { timeout: 10000, what: "settings dialog closed" });
      const st = await status(ctx);
      ctx.note(`after Done: ${JSON.stringify({ phase: st.phase, pauseMenu: st.pauseMenu, pauseLite: st.pauseLite, locked: st.locked })}`);
      if (st.pauseMenu || st.pauseLite) await clickSel(ctx, ".al-pause-layer .al-pause-act.is-primary");
      await untilRunning(ctx, "running after closing the settings and resuming", 20000);
      const y1 = await yawFor(ctx, 100);
      const ratio = y1.d / y0.d;
      const expect = Number(want) / sens0;
      ctx.note(`yaw for 100 counts: ${y0.d.toFixed(4)} rad at sens ${sens0} -> ${Number.isFinite(y1.d) ? y1.d.toFixed(4) : y1.d} rad after (x${Number.isFinite(ratio) ? ratio.toFixed(2) : "?"}, expected x${expect.toFixed(2)})`);
      if (sensRow && sensRow !== "no dialog" && !(Math.abs(ratio / expect - 1) < 0.1)) bad.push(`new sensitivity not applied at once in the running drill (yaw x${Number.isFinite(ratio) ? ratio.toFixed(2) : ratio}, expected x${expect.toFixed(2)})`);
      const r = await shootFor(ctx, { seconds: 3, enough: 99, minSeconds: 3 });
      ctx.note(`drill goes on: phase ${r.phase}, shots ${r.shots}, kills ${r.kills}`);
      await ctx.shot("resumed");
      if (r.phase !== "running" || !r.shots) bad.push(`drill did not go on after the settings change (phase ${r.phase}, shots ${r.shots})`);
      await exitDrill(ctx);
    } finally {
      ctx.note(`changed: ${done.join("; ") || "nothing"}`);
      await restoreLocalStorage(ctx, snap).catch(() => {});
      await c.send("Page.reload", {}).catch(() => {});
      await sleep(1500);
      await c.ensureAttached();
      await waitLobby(ctx, 90000);
      const d = lsDiff(snap, await c.evaluate(LS_SNAPSHOT));
      const dd = d.filter((k) => !APP_REWRITES.test(k));
      if (dd.length) ctx.warn(`after restore, keys differ from the snapshot: ${dd.slice(0, 6).join(", ")}`);
    }
    if (bad.length) throw new Error(`finding: ${bad.join("; ")}`);
  },
};

export const EXTRA_STEPS = [soakRetries, soakSwitch, edgeBlur, edgeRapidRetry, edgeHitch, edgeStartOverlay, edgeBackSpam, edgeResize, edgeSettingsMid, edgeSaved, edgeSens];
