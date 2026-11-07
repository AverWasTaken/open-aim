// Smoke steps. Each step is {name, about, timeoutMs, run(ctx)}; ctx.cdp drives the page.
// Detections come from the live-confirmed driving map (open-aim-hq/scratch/qa/driving-map.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DRILLS = JSON.parse(fs.readFileSync(path.join(HERE, "drills.json"), "utf8"));

// ---------------------------------------------------------------- page side
// Installed on every new document (Page.addScriptToEvaluateOnNewDocument) and once on
// the current one. Records phase events, wraps __aimTick/__aimShot as soon as the shell
// scripts define them (idempotent, re-checked every 250 ms), and runs the aim lock.
export const PAGE_LIB = String.raw`(() => {
  if (window.__qa && window.__qa.v === 1) return;
  const qa = window.__qa = { v: 1, phase: null, phases: [], shots: [], hits: 0, kills: 0, hitIds: new Set(), last: null, ticks: 0, hookFail: null, aim: { on: false } };
  addEventListener('aim-round-phase', (e) => {
    const d = e.detail || {};
    qa.phase = d.phase;
    qa.phases.push({ p: d.phase, prev: d.previous, t: Date.now() });
    if (qa.phases.length > 300) qa.phases.splice(0, 100);
  });
  document.addEventListener('pointerlockchange', () => { qa.aim.primed = false; });
  qa.vis = (e) => {
    if (!e || !e.isConnected || !e.getClientRects().length) return false;
    const cs = getComputedStyle(e);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  qa.visq = (sel) => [...document.querySelectorAll(sel)].find(qa.vis) || null;
  qa.text = (e) => (e ? (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim() : '');
  qa.lobbyReady = () => !document.querySelector('.es-startup') && !!document.querySelector('.hall-root') && typeof window.__aimLaunchScene === 'function' && !!window.__aimTools;
  qa.inLobby = () => location.pathname.replace(/\/$/, '') === '/aim' && qa.lobbyReady() && !document.querySelector('.al-aimlab-root') && !!document.querySelector('.hall-topnav');
  qa.locked = () => !!document.pointerLockElement && document.pointerLockElement.tagName === 'CANVAS';
  qa.readyToStart = () => !!(qa.visq('.al-aimlab-root .al-primary-btn') || qa.visq('.al-scene-start-cue'));
  qa.loadFailed = () => { const l = document.querySelector('section.al-wkload'); return !!l && /won't open|failed/i.test(qa.text(l)); };
  qa.center = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }; };
  // Visible element -> centre point (scrolled into view) or null.
  qa.at = (sel, textRe) => {
    let els = [...document.querySelectorAll(sel)].filter(qa.vis);
    if (textRe) els = els.filter((e) => new RegExp(textRe, 'i').test(qa.text(e)));
    const el = els[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return qa.center(el);
  };
  qa.status = () => ({
    path: location.pathname, phase: qa.phase, locked: qa.locked(), lobby: qa.inLobby(), ready: qa.readyToStart(),
    loading: !!document.querySelector('section.al-wkload.is-loading'), failed: qa.loadFailed(),
    result: !!qa.visq('.al-result-overlay'), pauseLite: !!qa.visq('.al-pause-layer.al-pause-lite'), pauseMenu: !!qa.visq('.al-pause-layer.al-pause-overlay'),
    picker: !!qa.visq('.aim-pick-shade'), importModal: !!qa.visq('.es-tool-shade.valorant-import-shade'),
    hits: qa.hits, kills: qa.kills, shots: qa.shots.length, ticks: qa.ticks, alive: qa.last ? (qa.last.actors || []).filter((a) => a.alive).length : null,
    aimErr: qa.aim.err == null ? null : +qa.aim.err.toFixed(4), hookFail: qa.hookFail,
  });
  qa.resetCounters = () => { qa.shots = []; qa.hits = 0; qa.kills = 0; qa.hitIds = new Set(); qa.phases = []; };
  qa.onTick = (s) => {
    qa.last = s; qa.ticks++;
    const alive = new Set();
    for (const a of (s && s.actors) || []) if (a.alive) alive.add(a.id);
    if (qa.prevAlive) for (const id of qa.prevAlive) if (!alive.has(id) && qa.hitIds.has(id)) { qa.kills++; qa.hitIds.delete(id); }
    qa.prevAlive = alive;
  };
  qa.onShot = (e) => {
    qa.shots.push({ tick: e.tick, hit: e.hitActorId, part: e.hitPart });
    if (qa.shots.length > 400) qa.shots.splice(0, 200);
    if (e.hitActorId != null) { qa.hits++; qa.hitIds.add(e.hitActorId); }
  };
  qa.hook = () => {
    for (const [name, fn] of [['__aimTick', qa.onTick], ['__aimShot', qa.onShot]]) {
      const orig = window[name];
      if (typeof orig !== 'function' || orig.__qa) continue;
      const w = function (x) { try { fn(x); } catch (err) {} return orig.apply(this, arguments); };
      w.__qa = 1;
      window[name] = w;
      if (window[name] !== w) qa.hookFail = name + ' not writable';
    }
  };
  setInterval(qa.hook, 250);
  qa.hook();
  // ---- aim lock (plan S3): turn toward the nearest alive actor with synthetic mousemove
  // (untrusted events are accepted; driving map item 3). The runner only clicks.
  qa.aimPoint = (a) => {
    const off = qa.aim.offY;
    const dy = typeof off === 'function' ? off(a) : (off == null ? 0 : off);
    return { x: a.position.x, y: a.position.y + dy, z: a.position.z };
  };
  qa.aimStart = (o = {}) => {
    qa.aim = { on: true, eye: o.eye == null ? 1.75 : o.eye, offY: o.offY == null ? 0 : o.offY, target: null, lastTick: -1, err: null, moves: 0, primed: false };
    const frame = () => {
      const A = qa.aim;
      if (!A.on) return;
      requestAnimationFrame(frame);
      const s = qa.last;
      if (!s || !s.player || !qa.locked() || qa.phase !== 'running') return;
      if (s.tick <= A.lastTick + 1) return; // let the last move land in the sim first
      const p = s.player;
      const ex = p.position.x, ey = p.position.y + A.eye, ez = p.position.z;
      const sens = parseFloat(localStorage.getItem('al-sensitivity-v1')) || 0.5;
      const k = 0.07 * sens * Math.PI / 180;
      const list = (s.actors || []).filter((a) => a.alive && a.visible !== false && a.position);
      if (!list.length) { A.target = null; A.err = null; return; }
      const ang = (a) => {
        const t = qa.aimPoint(a);
        const dx = t.x - ex, dy = t.y - ey, dz = t.z - ez;
        let dyaw = Math.atan2(-dx, -dz) - p.yaw;
        dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        return { dyaw, dpitch: Math.atan2(dy, Math.hypot(dx, dz)) - p.pitch };
      };
      let cur = list.find((a) => a.id === A.target);
      if (!cur) {
        cur = list.map((a) => [a, ang(a)]).sort((x, y) => Math.hypot(x[1].dyaw, x[1].dpitch) - Math.hypot(y[1].dyaw, y[1].dpitch))[0][0];
        A.target = cur.id;
      }
      const d = ang(cur);
      A.err = Math.hypot(d.dyaw, d.dpitch);
      let mx = Math.round(Math.max(-900, Math.min(900, -d.dyaw / k)));
      let my = Math.round(Math.max(-900, Math.min(900, -d.dpitch / k)));
      if (!mx && !my) return;
      // The first big move after the lock is taken can be swallowed: send a tiny one first.
      if (!A.primed) { A.primed = true; mx = Math.sign(mx); my = Math.sign(my); }
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: mx, movementY: my }));
      A.lastTick = s.tick;
      A.moves++;
    };
    requestAnimationFrame(frame);
    return true;
  };
  qa.aimStop = () => { qa.aim.on = false; return true; };
})()`;

// ---------------------------------------------------------------- runner side helpers
const J = (v) => JSON.stringify(v);

async function waitFor(ctx, expr, { timeout = 30000, every = 500, what = expr } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    ctx.check?.();
    try {
      last = await ctx.cdp.evaluate(expr, { timeout: Math.max(5000, Math.min(30000, timeout)) });
      if (last) return last;
    } catch (e) {
      last = String(e.message || e);
      if (/crashed|exited/.test(last)) throw e;
    }
    await sleep(every);
  }
  throw new Error(`timed out after ${Math.round(timeout / 1000)} s waiting for ${what}${last !== undefined && last !== false && last !== null ? ` (last: ${String(typeof last === "object" ? JSON.stringify(last) : last).slice(0, 200)})` : ""}`);
}

const status = (ctx) => ctx.cdp.evaluate("__qa.status()");

// CDP click on the first visible element matching sel (optionally its text matches re).
async function clickSel(ctx, sel, re = null, { timeout = 10000 } = {}) {
  const pt = await waitFor(ctx, `__qa.at(${J(sel)}, ${J(re)})`, { timeout, what: `visible ${sel}${re ? ` /${re}/` : ""}` });
  await sleep(150); // let scrollIntoView settle
  const pt2 = (await ctx.cdp.evaluate(`__qa.at(${J(sel)}, ${J(re)})`)) || pt;
  await ctx.cdp.click(pt2.x, pt2.y);
  return pt2;
}

async function waitLobby(ctx, timeout = 120000) {
  await waitFor(ctx, "window.__qa && __qa.inLobby()", { timeout, what: "lobby ready (.hall-root, no .es-startup, __aimLaunchScene, __aimTools, no .al-aimlab-root)" });
  // The first-run import modal can show once per session; close it if it is up.
  const modal = await ctx.cdp.evaluate("!!__qa.visq('.es-tool-shade.valorant-import-shade')");
  if (modal) {
    ctx.note?.("import-settings modal was up; closed");
    await clickSel(ctx, ".es-tool-shade.valorant-import-shade .es-tool-x");
    await waitFor(ctx, "!__qa.visq('.es-tool-shade')", { timeout: 10000, what: "import modal closed" });
  }
}

// Back to a clean lobby between steps (plan S14).
export async function recover(cdp, { log = () => {}, force = false } = {}) {
  const ctx = { cdp, log };
  try {
    const st = await cdp.evaluate("window.__qa ? __qa.status() : null", { timeout: 15000 }).catch(() => null);
    const clean = st && st.lobby && !st.picker && !st.importModal && !st.locked;
    const shade = clean && (await cdp.evaluate("!!__qa.visq('.es-tool-shade,.aim-pick-shade,.al-result-overlay')").catch(() => true));
    if (clean && !shade && !force) return { ok: true };
    log(`returning to /aim (state ${st ? JSON.stringify({ path: st.path, phase: st.phase, lobby: st.lobby, locked: st.locked }) : "unknown"})`);
    await cdp.evaluate("document.exitPointerLock && document.exitPointerLock(); window.__qa && __qa.aimStop(); location.assign('/aim'); true", { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    await cdp.ensureAttached();
    await waitLobby(ctx, 120000);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e.message || e) };
  }
}

// Is this share code a bot drill that shows the rank picker?
async function isVariant(ctx, code) {
  return ctx.cdp.evaluate(`fetch('/aim/drill-variants.json').then(r=>r.json()).then(j=>!!(j.variants||j)[${J(code)}])`);
}

// Launch a drill from the lobby. via: 'card' (real UI path) or 'scene' (__aimLaunchScene).
async function launchDrill(ctx, d, via) {
  if (via === "card") {
    const sel = `[data-role=workshop-card][data-share-code="${d.code}"]`;
    let have = await waitFor(ctx, `!!__qa.visq(${J(sel)})`, { timeout: 15000, what: `card ${d.code}` }).catch(() => false);
    if (!have) {
      // A category chip from an earlier step may be filtering the list: back to "All".
      await clickSel(ctx, ".al-wk-chip", String.raw`^\s*All\b`).catch(() => {});
      have = await waitFor(ctx, `!!__qa.visq(${J(sel)})`, { timeout: 5000, what: `card ${d.code}` }).catch(() => false);
    }
    if (!have) throw new Error(`pinned drill ${d.code} (${d.name}) missing from the lobby - update scripts/smoke/drills.json`);
    await clickSel(ctx, `${sel} .al-wk-split-go, ${sel} .al-wk-go`);
  } else {
    const ok = await ctx.cdp.evaluate(`window.__aimLaunchScene(${J({ shareCode: d.code, name: d.name })})`);
    if (!ok) throw new Error(`__aimLaunchScene(${d.code}) returned ${ok}`);
  }
}

// Wait for the start screen, then start (Enter; click as fallback) until running + locked.
async function startDrill(ctx, { loadTimeout = 120000 } = {}) {
  const t0 = Date.now();
  await waitFor(ctx, `(()=>{const s=__qa.status(); if(s.failed) return 'FAILED'; if(s.picker) return 'PICKER'; return s.ready ? 'READY' : (s.phase==='running' && s.locked ? 'RUNNING' : false)})()`, { timeout: loadTimeout, what: "drill start screen" }).then((v) => {
    if (v === "FAILED") throw new Error("drill failed to load (al-wkload says it won't open)");
    if (v === "PICKER") throw new Error("rank picker showed up unexpectedly");
  });
  const loadMs = Date.now() - t0;
  await ctx.cdp.updateCenter();
  for (let i = 0; i < 3; i++) {
    await ctx.cdp.moveTo(); // park the CDP mouse at the centre before the lock (moves turn the camera once locked)
    if (i === 0) await ctx.cdp.key("Enter");
    else {
      const btn = await ctx.cdp.evaluate("__qa.at('.al-aimlab-root .al-primary-btn')");
      if (btn) await ctx.cdp.click(btn.x, btn.y);
      else await ctx.cdp.click(ctx.cdp.cx, ctx.cdp.cy);
      await ctx.cdp.moveTo();
    }
    const ok = await waitFor(ctx, "__qa.phase==='running' && __qa.locked()", { timeout: 4000, every: 300 }).catch(() => false);
    if (ok) return { loadMs, tries: i + 1 };
  }
  throw new Error(`drill did not start after 3 tries (${JSON.stringify(await status(ctx))})`);
}

// Fire for `seconds` with the aim lock on. Stops early once `enough` kills land.
async function shootFor(ctx, { seconds = 10, enough = 3, offY = 0, minSeconds = 4 } = {}) {
  await ctx.cdp.updateCenter();
  await ctx.cdp.evaluate(`__qa.resetCounters(); __qa.aimStart({offY: ${J(offY)}})`);
  const t0 = Date.now();
  let st = null;
  let lastCheck = 0;
  await sleep(600); // let the aim settle on the first target
  while (Date.now() - t0 < seconds * 1000) {
    ctx.check();
    await ctx.cdp.press();
    await sleep(380);
    if (Date.now() - lastCheck > 2000) {
      lastCheck = Date.now();
      st = await status(ctx);
      if (st.phase !== "running") break;
      if (st.kills >= enough && Date.now() - t0 > minSeconds * 1000) break;
    }
  }
  await ctx.cdp.evaluate("__qa.aimStop()");
  st = await status(ctx);
  return { ...st, secs: +((Date.now() - t0) / 1000).toFixed(1) };
}

// Pause (simulated alt-tab = lock lost) and exit to the lobby.
async function exitDrill(ctx, { to = "lobby" } = {}) {
  const st = await status(ctx);
  if (st.result) {
    await clickSel(ctx, ".al-result-overlay .al-secondary-btn");
  } else {
    if (st.locked) await ctx.cdp.evaluate("document.exitPointerLock(); true");
    await waitFor(ctx, "!!__qa.visq('.al-pause-layer .al-pause-act.is-exit') || !!__qa.visq('.hall-train-exit')", { timeout: 10000, what: "pause menu with Exit" });
    const viaPause = await ctx.cdp.evaluate("!!__qa.visq('.al-pause-layer .al-pause-act.is-exit')");
    await clickSel(ctx, viaPause ? ".al-pause-layer .al-pause-act.is-exit" : ".hall-train-exit");
  }
  if (to === "lobby") await waitFor(ctx, "__qa.inLobby()", { timeout: 30000, what: "back in the lobby" });
}

// ---------------------------------------------------------------- steps
const boot = {
  name: "boot",
  always: true,
  about: "lobby ready on a fresh profile; first-run import modal shows and closes",
  timeoutMs: 150000,
  async run(ctx) {
    const t0 = Date.now();
    await waitFor(ctx, "window.__qa && __qa.lobbyReady()", { timeout: 120000, what: "lobby ready" });
    ctx.note(`lobby ready ${((Date.now() - t0) / 1000).toFixed(1)} s after attach`);
    // First run: "Import VALORANT settings" modal over the lobby (fresh profile only).
    const modal = await waitFor(ctx, "!!__qa.visq('.es-tool-shade.valorant-import-shade')", { timeout: 8000, what: "first-run import modal" }).catch(() => false);
    if (!modal) {
      if (ctx.opts.profile) ctx.warn("no first-run import modal (reused profile)");
      else throw new Error("first-run 'Import VALORANT settings' modal did not appear on a fresh profile");
    } else {
      await ctx.shot("import-modal");
      await clickSel(ctx, ".es-tool-shade.valorant-import-shade .es-tool-x");
      await waitFor(ctx, "!__qa.visq('.es-tool-shade')", { timeout: 10000, what: "import modal closed" });
    }
    await waitFor(ctx, "__qa.inLobby()", { timeout: 10000, what: "lobby clickable" });
    // Lobby clickable: the element at the centre of the top nav is part of the lobby, not a shade.
    const ok = await ctx.cdp.evaluate(`(()=>{const n=document.querySelector('.hall-topnav'); const c=__qa.center(n); const e=document.elementFromPoint(c.x,c.y); return !!e && !e.closest('.es-tool-shade,.es-startup');})()`);
    if (!ok) throw new Error("lobby is covered by an overlay after boot");
  },
};

const lobby = {
  name: "lobby",
  about: "click every top lobby tab; each renders without errors",
  timeoutMs: 120000,
  async run(ctx) {
    const tabs = await ctx.cdp.evaluate("[...document.querySelectorAll('.hall-tab')].filter(__qa.vis).map(t=>__qa.text(t))");
    if (!tabs || tabs.length < 3) throw new Error(`expected lobby tabs (.hall-tab), found ${JSON.stringify(tabs)}`);
    ctx.note(`${tabs.length} tabs`);
    for (let i = 0; i < tabs.length; i++) {
      const pt = await ctx.cdp.evaluate(`(()=>{const t=[...document.querySelectorAll('.hall-tab')].filter(__qa.vis)[${i}]; if(!t) return null; t.scrollIntoView({block:'center',inline:'center'}); return __qa.center(t);})()`);
      if (!pt) throw new Error(`tab ${i} (${tabs[i]}) vanished`);
      await ctx.cdp.click(pt.x, pt.y);
      await sleep(1200);
      const st = await ctx.cdp.evaluate(`({active: __qa.text(document.querySelector('.hall-tab.is-active, .hall-tab[aria-selected=true], .hall-tab.active')), lobby: __qa.inLobby(), body: document.body.innerText.length})`);
      if (!st.lobby) throw new Error(`clicking tab "${tabs[i]}" left the lobby`);
      await ctx.shot(`tab${i + 1}`);
    }
    // Back to the first tab (drill cards live there).
    const first = await ctx.cdp.evaluate("(()=>{const t=[...document.querySelectorAll('.hall-tab')].filter(__qa.vis)[0]; t.scrollIntoView({block:'center'}); return __qa.center(t);})()");
    await ctx.cdp.click(first.x, first.y);
    await sleep(800);
  },
};

// Category chip in the lobby drill list (button.al-wk-chip: label + count). Clicks it and
// checks the pinned card is listed under it.
async function pickChip(ctx, d) {
  const re = String.raw`^\s*` + d.chip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`\b`;
  await clickSel(ctx, ".al-wk-chip", re);
  await waitFor(ctx, `(()=>{const c=__qa.visq('.al-wk-chip.al-wk-on'); return !!c && new RegExp(${J(re)}, 'i').test(__qa.text(c));})()`, { timeout: 5000, what: `chip "${d.chip}" active` });
  const card = `[data-role=workshop-card][data-share-code="${d.code}"]`;
  const seen = await waitFor(ctx, `!!__qa.visq(${J(card)})`, { timeout: 5000, what: `card ${d.code} under chip ${d.chip}` }).catch(() => false);
  if (!seen) throw new Error(`pinned drill ${d.code} (${d.name}) is not listed under the "${d.chip}" chip - update scripts/smoke/drills.json`);
}

// Play on until the drill ends by itself (timer) and the result screen is up.
async function playToResult(ctx, { maxSeconds, offY = 0 }) {
  await ctx.cdp.evaluate(`__qa.aimStart({offY: ${J(offY)}}); true`);
  const t0 = Date.now();
  let st;
  let lastCheck = 0;
  while (Date.now() - t0 < maxSeconds * 1000) {
    ctx.check();
    await ctx.cdp.press();
    await sleep(400);
    if (Date.now() - lastCheck > 2000) {
      lastCheck = Date.now();
      st = await status(ctx);
      if (st.phase === "result" || st.result) break;
      if (st.phase === "paused") throw new Error("drill paused by itself (lost pointer lock?)");
    }
  }
  await ctx.cdp.evaluate("__qa.aimStop()");
  await waitFor(ctx, "__qa.phase==='result' && !!__qa.visq('.al-result-overlay')", { timeout: 15000, what: "result phase + .al-result-overlay" });
  return { ...(await status(ctx)), secs: Math.round((Date.now() - t0) / 1000) };
}

function drillStep(d) {
  return {
    name: `drill:${d.id}`,
    about: `${d.chip}: ${d.name} (${d.code})${d.result ? "; played to its end when result-replay follows" : ""}`,
    timeoutMs: d.result ? 420000 : 240000, // +play to the end (60 s drill, slower when the sim runs below real time)
    async run(ctx) {
      await pickChip(ctx, d);
      // Bots that shoot back show the rank picker on a card click (the rank-picker step covers
      // that); launch those directly.
      const via = (await isVariant(ctx, d.code)) ? "scene" : "card";
      await launchDrill(ctx, d, via);
      const s = await startDrill(ctx);
      ctx.note(`via ${via}, loaded in ${(s.loadMs / 1000).toFixed(1)} s, start tries ${s.tries}`);
      ctx.data("loadMs", s.loadMs);
      const r = await shootFor(ctx, { seconds: d.seconds || 10, offY: d.offY ?? 0 });
      ctx.note(`kills ${r.kills}, hits ${r.hits}/${r.shots} shots in ${r.secs} s`);
      if (r.hookFail) throw new Error(`could not hook ${r.hookFail}`);
      if (!r.ticks) throw new Error("no sim frames seen (__aimTick never called)");
      if (d.noKillOk) {
        if (r.kills === 0) ctx.note("no kill (expected for this drill)");
      } else if (r.kills === 0) throw new Error(`no kill in ${r.secs} s (hits ${r.hits}/${r.shots})`);
      // Plan R9b: the result-replay step continues from this drill's own result screen.
      if (d.result && ctx.next === "result-replay" && r.phase === "running") {
        const e = await playToResult(ctx, { maxSeconds: (DRILLS.result.seconds || 60) * 3, offY: d.offY ?? 0 });
        ctx.note(`played to the end: result after ${e.secs} s more, kills ${e.kills}`);
        ctx.keepState = true;
        return;
      }
      if (r.phase === "result" && ctx.next === "result-replay") {
        ctx.keepState = true;
        return;
      }
      await exitDrill(ctx);
    },
  };
}

// Timing probe (plan R9a; only with --only=probe): first vs repeat load of a target drill and a
// map drill, sim seconds per wall second, frames per second, CDP round trip.
const probe = {
  name: "probe",
  optional: true,
  about: "timing probe: first vs repeat drill load, sim speed, fps, CDP round trip",
  timeoutMs: 660000,
  async run(ctx) {
    for (const d of DRILLS.probe) {
      for (const rep of ["first", "repeat"]) {
        await launchDrill(ctx, d, "scene");
        const s = await startDrill(ctx, { loadTimeout: 180000 });
        const sample = () => ctx.cdp.evaluate("({tick: __qa.last ? __qa.last.tick : null, frames: __qa.ticks, t: Date.now()})");
        const r0 = Date.now();
        const a = await sample();
        const rtt = Date.now() - r0;
        await sleep(8000);
        const b = await sample();
        const wall = (b.t - a.t) / 1000;
        const simRate = a.tick != null && b.tick != null ? (b.tick - a.tick) / 128 / wall : null;
        const fps = (b.frames - a.frames) / wall;
        const k = await shootFor(ctx, { seconds: 8, enough: 99 });
        const line = `${d.name} ${rep}: load ${(s.loadMs / 1000).toFixed(1)} s, sim ${simRate == null ? "?" : simRate.toFixed(2)} s/s, ${fps.toFixed(1)} frames/s, CDP rtt ${rtt} ms, kills ${k.kills} in ${k.secs} s`;
        ctx.note(line);
        ctx.log(line);
        ctx.data(`${d.code}-${rep}`, { loadMs: s.loadMs, simRate, fps, rtt, kills: k.kills, secs: k.secs });
        await exitDrill(ctx);
        await sleep(500);
      }
    }
  },
};

// Leave a drill's start screen without starting it (side-panel exit, or start then pause-exit).
async function leaveFromStartScreen(ctx) {
  const exitBtn = await ctx.cdp.evaluate("!!__qa.visq('.hall-train-exit')");
  if (exitBtn) {
    await clickSel(ctx, ".hall-train-exit");
    await waitFor(ctx, "__qa.inLobby()", { timeout: 30000, what: "back in the lobby" });
    return;
  }
  await startDrill(ctx);
  await exitDrill(ctx);
}

// One short drill played to its natural end, its replay, then Play again (plan steps 3+4,
// S6: replay before Play again). Settings must not change before this (a run with changed
// settings saves no replay), which is why the settings step runs after it.
const resultReplay = {
  name: "result-replay",
  about: "short drill to its natural end; result screen; replay plays",
  timeoutMs: 420000,
  async run(ctx) {
    const fromPrev = ctx.prev && ctx.prev.keepState && (await ctx.cdp.evaluate("__qa.phase==='result' && !!__qa.visq('.al-result-overlay')"));
    if (fromPrev) {
      ctx.note(`continues from ${ctx.prev.step}'s result screen`);
    } else {
      // Run on its own (--only=result-replay): play the result drill to its end first.
      const d = DRILLS.result;
      await launchDrill(ctx, d, "scene");
      const s = await startDrill(ctx);
      ctx.note(`${d.name} (${d.seconds} s) loaded in ${(s.loadMs / 1000).toFixed(1)} s`);
      await ctx.cdp.evaluate("__qa.resetCounters(); true");
      const e = await playToResult(ctx, { maxSeconds: d.seconds * 3, offY: d.offY ?? 0 });
      ctx.note(`ended after ${e.secs} s, kills ${e.kills}, hits ${e.hits}/${e.shots}`);
    }
    const text = await ctx.cdp.evaluate("__qa.text(__qa.visq('.al-result-modal') || __qa.visq('.al-result-overlay')).slice(0, 160)");
    ctx.note(`result: ${text}`);
    await ctx.shot("result");
    // Replay (driving map 8): opens paused at 0; play; scrub value must rise.
    await clickSel(ctx, ".al-replay-watch-btn");
    await waitFor(ctx, "!!__qa.visq('.al-replay-library-modal.is-player') && !!__qa.visq('.al-replay-play')", { timeout: 20000, what: "replay player" });
    await clickSel(ctx, ".al-replay-play");
    const v0 = Number(await ctx.cdp.evaluate("document.querySelector('.al-replay-scrub').value"));
    await sleep(3000);
    const v1 = Number(await ctx.cdp.evaluate("document.querySelector('.al-replay-scrub').value"));
    await ctx.shot("replay");
    if (!(v1 > v0)) throw new Error(`replay did not advance (.al-replay-scrub ${v0} -> ${v1})`);
    ctx.note(`replay scrub ${v0} -> ${v1}`);
    await clickSel(ctx, ".al-rv-close");
    await waitFor(ctx, "!!__qa.visq('.al-result-overlay') && !__qa.visq('.al-replay-library-modal.is-player')", { timeout: 10000, what: "back on the result screen" });
    ctx.keepState = true; // play-again continues from this result screen
  },
};

const playAgain = {
  name: "play-again",
  about: "Play again from the result screen restarts the drill",
  timeoutMs: 90000,
  async run(ctx) {
    const onResult = await ctx.cdp.evaluate("!!__qa.visq('.al-result-overlay .al-primary-btn')");
    if (!onResult) throw new Error("no result screen to retry from (result-replay step failed or was skipped)");
    await ctx.cdp.evaluate("__qa.resetCounters(); true");
    await ctx.cdp.moveTo();
    await clickSel(ctx, ".al-result-overlay .al-primary-btn");
    await ctx.cdp.moveTo();
    await waitFor(ctx, "__qa.phase==='running' && __qa.locked() && !__qa.visq('.al-result-overlay')", { timeout: 15000, what: "running again after Play again" });
    const ph = await ctx.cdp.evaluate("__qa.phases.map(p=>p.p).join('>')");
    ctx.note(`phases ${ph}`);
    await sleep(1500);
    await exitDrill(ctx);
  },
};

const pause = {
  name: "pause",
  about: "lock lost pauses (light menu), resume; Tab full menu, resume; Restart",
  timeoutMs: 150000,
  async run(ctx) {
    await launchDrill(ctx, DRILLS.light, "scene");
    await startDrill(ctx);
    await sleep(1000);
    // Simulated alt-tab = pointer lock lost.
    await ctx.cdp.evaluate("document.exitPointerLock(); true");
    await waitFor(ctx, "__qa.phase==='paused' && !!__qa.visq('.al-pause-layer.al-pause-lite') && !!document.querySelector('.al-stage-wrap.is-paused')", { timeout: 10000, what: "paused + light pause menu" });
    await ctx.shot("lite");
    await clickSel(ctx, ".al-pause-layer .al-pause-act.is-primary");
    await ctx.cdp.moveTo();
    await waitFor(ctx, "__qa.phase==='running' && __qa.locked() && !document.querySelector('.al-stage-wrap.is-paused')", { timeout: 10000, what: "running after Resume" });
    // Tab opens the full menu.
    await ctx.cdp.key("Tab");
    await waitFor(ctx, "!!__qa.visq('.al-pause-layer.al-pause-overlay')", { timeout: 10000, what: "full pause menu after Tab" });
    await ctx.shot("menu");
    await clickSel(ctx, ".al-pause-layer .al-pause-act.is-primary");
    await ctx.cdp.moveTo();
    await waitFor(ctx, "__qa.phase==='running' && __qa.locked() && !__qa.visq('.al-pause-layer.al-pause-overlay')", { timeout: 10000, what: "running after resuming the full menu" });
    // Restart from the light menu (second retry path).
    await ctx.cdp.evaluate("__qa.phases = []; document.exitPointerLock(); true");
    await waitFor(ctx, "!!__qa.visq('.al-pause-layer.al-pause-lite')", { timeout: 10000, what: "light pause menu" });
    await clickSel(ctx, ".al-pause-layer .al-pause-act", "Restart");
    await ctx.cdp.moveTo();
    const r = await waitFor(ctx, "(__qa.phase==='running' && __qa.locked()) ? 'running' : (__qa.readyToStart() ? 'ready' : false)", { timeout: 20000, what: "drill restarted" });
    if (r === "ready") await startDrill(ctx);
    ctx.note(`restart -> ${r}; phases ${await ctx.cdp.evaluate("__qa.phases.map(p=>p.p).join('>')")}`);
    await exitDrill(ctx);
  },
};

const settings = {
  name: "settings",
  about: "change sensitivity in the lobby; survives a reload; restored",
  timeoutMs: 180000,
  async run(ctx) {
    const KEY = "al-sensitivity-v1";
    const old = await ctx.cdp.evaluate(`localStorage.getItem(${J(KEY)})`);
    const want = old === "0.37" ? "0.41" : "0.37";
    const setSens = (v) => ctx.cdp.evaluate(`(()=>{const i=document.querySelector('input[data-action=hall-sensitivity]'); if(!i) return 'no input';
      i.scrollIntoView({block:'center'}); i.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i, ${J(v)});
      i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true}));
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); i.blur(); return 'ok';})()`);
    const r = await setSens(want);
    if (r !== "ok") throw new Error("sensitivity input input[data-action=hall-sensitivity] not found");
    await waitFor(ctx, `localStorage.getItem(${J(KEY)})===${J(want)}`, { timeout: 5000, what: `localStorage ${KEY} = ${want}` });
    await ctx.cdp.send("Page.reload", {});
    await sleep(1500);
    await ctx.cdp.ensureAttached();
    await waitLobby(ctx);
    const after = await ctx.cdp.evaluate(`({ls: localStorage.getItem(${J(KEY)}), input: document.querySelector('input[data-action=hall-sensitivity]')?.value})`);
    await ctx.shot("after-reload");
    if (after.ls !== want) throw new Error(`sensitivity not persisted: ${KEY}=${after.ls}, wanted ${want}`);
    if (Number(after.input) !== Number(want)) throw new Error(`lobby input shows ${after.input} after reload, wanted ${want}`);
    ctx.note(`sens ${old ?? "default"} -> ${want}, persisted over reload`);
    // Restore.
    await setSens(old ?? "0.5");
    if (old == null) await ctx.cdp.evaluate(`localStorage.removeItem(${J(KEY)}); true`);
    const back = await ctx.cdp.evaluate(`localStorage.getItem(${J(KEY)})`);
    if (back !== old) throw new Error(`could not restore sensitivity (${back} vs ${old})`);
  },
};

const rankPicker = {
  name: "rank-picker",
  about: "card launch of a bot drill shows the rank picker; gold launches and is saved",
  timeoutMs: 210000,
  async run(ctx) {
    const d = DRILLS.rankPicker;
    if (!(await isVariant(ctx, d.code))) throw new Error(`pinned rank-picker drill ${d.code} is not in /aim/drill-variants.json - update drills.json`);
    const oldRank = await ctx.cdp.evaluate("localStorage.getItem('aim-enemy-rank')");
    await ctx.cdp.evaluate("localStorage.removeItem('aim-rank-picks'); true");
    let shown = false;
    for (let i = 0; i < 2 && !shown; i++) {
      await launchDrill(ctx, d, "card");
      shown = await waitFor(ctx, "__qa.visq('.aim-pick-shade') ? 'picker' : (document.querySelector('.al-aimlab-root') ? 'launched' : false)", { timeout: 5000, what: "rank picker" }).catch(() => false);
      if (shown === "launched") throw new Error("drill launched without the rank picker");
    }
    if (!shown) throw new Error("rank picker (.aim-pick-shade) did not appear after 2 clicks");
    await ctx.shot("picker");
    await clickSel(ctx, ".aim-pick-tile[data-pick=gold]");
    await waitFor(ctx, "!__qa.visq('.aim-pick-shade') && !!document.querySelector('.al-aimlab-root')", { timeout: 15000, what: "drill launched after picking gold" });
    const ls = await ctx.cdp.evaluate("({rank: localStorage.getItem('aim-enemy-rank'), picks: localStorage.getItem('aim-rank-picks')})");
    if (ls.rank !== "gold") throw new Error(`aim-enemy-rank = ${ls.rank}, wanted gold`);
    const picks = JSON.parse(ls.picks || "{}");
    if (picks[d.code] !== "gold") throw new Error(`aim-rank-picks = ${ls.picks}, wanted ${d.code}: gold`);
    await waitFor(ctx, "__qa.status().failed ? 'FAILED' : __qa.readyToStart()", { timeout: 120000, what: "drill start screen" }).then((v) => {
      if (v === "FAILED") throw new Error("drill failed to load");
    });
    await leaveFromStartScreen(ctx);
    // Restore.
    await ctx.cdp.evaluate(`(()=>{ const o=${J(oldRank)}; if (o==null) localStorage.removeItem('aim-enemy-rank'); else localStorage.setItem('aim-enemy-rank', o); localStorage.removeItem('aim-rank-picks'); return true; })()`);
  },
};

const studio = {
  name: "studio",
  about: "Studio: new Flicks drill, Play lands in /aim, runs, exit returns to Studio",
  timeoutMs: 180000,
  async run(ctx) {
    await ctx.cdp.evaluate("location.assign('/studio/'); true");
    await sleep(1500);
    await waitFor(ctx, "location.pathname==='/studio/' && window.__studio && __studio.screen==='library'", { timeout: 60000, what: "Studio library" });
    const n0 = await ctx.cdp.evaluate("(__studio.drills||[]).length");
    await clickSel(ctx, ".btn.primary", "New drill");
    await clickSel(ctx, ".starter", "Flicks");
    await clickSel(ctx, ".dialog button.btn.primary", "Create");
    await waitFor(ctx, "__studio.screen==='editor'", { timeout: 20000, what: "Studio editor" });
    await ctx.shot("editor");
    await clickSel(ctx, "[data-coach=play]");
    await waitFor(ctx, "location.pathname.replace(/\\/$/,'')==='/aim' && !!sessionStorage.getItem('studio-return')", { timeout: 30000, what: "/aim with sessionStorage studio-return" });
    const code = await ctx.cdp.evaluate("sessionStorage.getItem('studio-return')");
    await startDrill(ctx, { loadTimeout: 90000 });
    const r = await shootFor(ctx, { seconds: 5, enough: 99 });
    ctx.note(`studio drill ${code} (library had ${n0}), kills ${r.kills}`);
    await exitDrill(ctx, { to: "none" });
    await waitFor(ctx, "location.pathname==='/studio/' && window.__studio && __studio.screen==='library' && !sessionStorage.getItem('studio-return')", { timeout: 30000, what: "auto-return to the Studio library" });
    const n1 = await ctx.cdp.evaluate("(__studio.drills||[]).length");
    if (!(n1 > n0)) ctx.warn(`studio library has ${n1} drills after creating one (was ${n0})`);
    await ctx.shot("back-in-studio");
  },
};

const round = {
  name: "round",
  about: "Round (beta): panel, start, round HUD live, exit resets round state",
  timeoutMs: 240000,
  async run(ctx) {
    const has = await ctx.cdp.evaluate("!!(window.__aimRoundPanel && __aimRoundPanel.open)");
    if (!has) throw new Error("window.__aimRoundPanel.open missing");
    await ctx.cdp.evaluate("__aimRoundPanel.open(); true");
    await clickSel(ctx, ".aim-round-start");
    await waitFor(ctx, "window.__aimRoundOn===true", { timeout: 20000, what: "__aimRoundOn" });
    const t0 = Date.now();
    await waitFor(ctx, "__qa.status().failed ? 'FAILED' : __qa.readyToStart()", { timeout: 150000, every: 1000, what: "round start screen" }).then((v) => {
      if (v === "FAILED") throw new Error("round scene failed to load");
    });
    ctx.note(`round loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    await ctx.cdp.moveTo();
    await ctx.cdp.key("Enter");
    await waitFor(ctx, "__qa.phase==='running' && __qa.locked()", { timeout: 15000, what: "round running" }).catch(async () => {
      await ctx.cdp.click(ctx.cdp.cx, ctx.cdp.cy);
      await waitFor(ctx, "__qa.phase==='running' && __qa.locked()", { timeout: 10000, what: "round running (2nd try)" });
    });
    const rs = await waitFor(ctx, "(()=>{const r=window.__aimRound, h=document.getElementById('aim-round-hud'); return r && r.phase && h && !h.hidden && __qa.vis(h) ? {phase:r.phase, enemies:r.enemiesAlive, alive:r.playerAlive} : false})()", { timeout: 20000, what: "__aimRound.phase + visible #aim-round-hud" });
    ctx.note(`round phase ${rs.phase}, enemies ${rs.enemies}`);
    await sleep(1500);
    await ctx.shot("hud");
    await exitDrill(ctx);
    const after = await ctx.cdp.evaluate("({on: window.__aimRoundOn, round: window.__aimRound, hud: (()=>{const h=document.getElementById('aim-round-hud'); return !!h && !h.hidden && __qa.vis(h);})()})");
    if (after.on !== false) throw new Error(`__aimRoundOn is ${after.on} after exit`);
    if (after.round != null) throw new Error("__aimRound not reset after exit");
    if (after.hud) throw new Error("round HUD still visible after exit");
  },
};

// Order matters: settings AFTER result-replay (a run with changed settings saves no replay).
export const STEPS = [boot, probe, lobby, ...DRILLS.drills.map(drillStep), resultReplay, playAgain, pause, settings, rankPicker, studio, round];
