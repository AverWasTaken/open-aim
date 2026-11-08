#!/usr/bin/env node
// Lobby layout check over CDP (ux). Needs a running test copy of the app with
// --remote-debugging-port; not part of npm test and not packaged.
//
//   node scripts/ux/lobby-layout-check.mjs <cdpPort> [shotDir]
//
// With shotDir it also saves a screenshot per size (lobby-<w>x<h>@<dpr>x.png) and, at
// 1280x720, one per step of the first 8 Tab presses (tab-1280-<n>.png).
//
// For each window size it checks the lobby's top bar, the feedback link in the bottom
// bar and the keyboard path, prints one JSON line per size, and exits non-zero if any
// check failed. The size override is cleared at the end.
// No dependencies: Node 22+ built-in fetch and WebSocket (runs from any folder,
// e.g. via hp.sh cdp-script, which copies it to /tmp).

import { mkdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
// hp.sh cdp-script already passes the port first; tolerate it being given twice.
if (argv[1] && argv[1] === argv[0]) argv.splice(1, 1);
const port = argv[0];
const shotDir = argv[1] || "";
if (!port) {
  console.error("usage: node scripts/ux/lobby-layout-check.mjs <cdpPort> [shotDir]");
  process.exit(2);
}

const SIZES = [
  { w: 1280, h: 720, dpr: 1 },
  { w: 1366, h: 768, dpr: 1 },
  { w: 1440, h: 900, dpr: 1 },
  { w: 1536, h: 864, dpr: 1 },
  { w: 1680, h: 1050, dpr: 1 },
  { w: 1920, h: 1080, dpr: 1 },
  { w: 3840, h: 2160, dpr: 1 },
  { w: 1920, h: 1080, dpr: 2 },
];
const TAB_STEPS = 25;
const TAB_SHOTS = 8;
// Must match theme-esports.css: below this width the bar shows icons only.
const LABELS_FROM = 1660;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://") && !t.url.includes("/studio/"));
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("websocket failed")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  };
  // Each call gives up after 20 s, and all open calls fail when the copy goes away
  // (it can be stopped at any time on hp), so the script never hangs.
  ws.onclose = () => { for (const p of pending.values()) p.rej(new Error("websocket closed")); pending.clear(); };
  const send = (method, params = {}) => new Promise((res, rej) => {
    if (ws.readyState !== 1) { rej(new Error("websocket closed")); return; }
    const n = ++id;
    const t = setTimeout(() => { pending.delete(n); rej(new Error(`${method}: no reply within 20 s`)); }, 20000);
    pending.set(n, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    try { ws.send(JSON.stringify({ id: n, method, params })); }
    catch (e) { pending.get(n)?.rej(e); pending.delete(n); }
  });
  return { ws, send };
}

async function evaluate(send, fn, ...args) {
  const expression = `(${fn})(...${JSON.stringify(args)})`;
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

async function waitFor(send, fn, timeout = 15000, ...args) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await evaluate(send, fn, ...args);
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(150);
  }
}

async function enter(send) {
  const common = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...common });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function key(send, name, shift = false) {
  const codes = { Tab: 9, Escape: 27 };
  const common = { key: name, code: name, windowsVirtualKeyCode: codes[name], nativeVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0 };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

// ---- page-side helpers (run inside the page) ----

function pageStart() {
  try { localStorage.setItem("aim-valorant-import-hide-startup-v1", "1"); } catch {}
  return !document.querySelector(".es-startup") && !!document.querySelector(".hall-root .hall-tab");
}

function pageOpenDrills() {
  // Close any panel or dialog left open (first-run import modal, tools).
  window.__aimTools?.close?.();
  for (const x of document.querySelectorAll(".es-tool-shade .es-tool-x")) x.click();
  const tab = document.querySelector(".hall-root .hall-tab");
  if (tab && !tab.classList.contains("is-active")) tab.click();
  return true;
}

function pageReady() {
  // The first-run import pop-up can open after pageOpenDrills ran: close it on every poll.
  for (const x of document.querySelectorAll(".es-tool-shade .es-tool-x")) x.click();
  const body = document.querySelector(".hall-board-body");
  if (body) body.scrollTop = 0;
  document.documentElement.scrollLeft = 0;
  document.scrollingElement && (document.scrollingElement.scrollLeft = 0);
  return !!document.querySelector(".al-wk-card") && !!document.querySelector(".es-bar .es-bar-quick") && !document.querySelector(".es-tool-shade");
}

// A string that changes while the layout is still settling.
function pageLayoutSig() {
  const bar = document.querySelector(".es-bar");
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return "-"; const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round).join(","); };
  // A late first-run pop-up closes here and changes the signature, so settle() waits it out.
  for (const x of document.querySelectorAll(".es-tool-shade .es-tool-x")) x.click();
  return [innerWidth, innerHeight, !!document.querySelector(".es-tool-shade"), bar?.dataset.sig, r(".es-bar"), r(".es-bar-quick"), r(".hall-topnav .hall-sens"), r(".es-discord-panel"), r(".al-wk-card"), document.documentElement.scrollWidth].join("|");
}

function pageRafs() {
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(true))));
}

function pageLayout(labelsFrom) {
  const out = { fails: [], info: {} };
  const fail = (m) => out.fails.push(m);
  const vw = innerWidth, vh = innerHeight;
  const rect = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const inView = (b) => b.w > 0 && b.h > 0 && b.x >= -1 && b.y >= -1 && b.r <= vw + 1 && b.b <= vh + 1;
  const hits = (e) => { const b = e.getBoundingClientRect(); const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!t && (t === e || e.contains(t)); };
  const overlap = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

  const doc = document.documentElement;
  out.info.docScrollWidth = doc.scrollWidth;
  out.info.innerWidth = vw;
  if (doc.scrollWidth > vw) fail(`page scrolls sideways: scrollWidth ${doc.scrollWidth} > innerWidth ${vw}`);
  const nav = document.querySelector(".hall-topnav");
  if (!nav) fail("no .hall-topnav");
  else if (nav.scrollWidth > nav.clientWidth) fail(`top nav overflows: scrollWidth ${nav.scrollWidth} > clientWidth ${nav.clientWidth}`);
  // Reported only, to check the breakpoints in theme-esports.css against real widths:
  // navFree = spare room in the top nav (the bar's auto left margin), navNeed = width the
  // nav needs in its current state (labels on/off, compact tabs or not) without the tab
  // row scrolling. The breakpoint for this state fits if navNeed <= innerWidth.
  const barEl = document.querySelector(".hall-topnav .es-bar");
  const tabsEl = document.querySelector(".hall-topnav .hall-tabs");
  if (nav && barEl) {
    const free = Math.max(0, parseFloat(getComputedStyle(barEl).marginLeft) || 0);
    const hidden = tabsEl ? Math.max(0, tabsEl.scrollWidth - tabsEl.clientWidth) : 0;
    out.info.navFree = Math.round(free);
    out.info.navNeed = Math.round(vw - free + hidden);
  }

  const named = { quick: ".es-bar .es-bar-quick", sens: ".hall-topnav .hall-sens", feedback: ".hall-bottombar .es-discord-panel" };
  for (const [k, sel] of Object.entries(named)) {
    const e = document.querySelector(sel);
    if (!e) { fail(`${k}: ${sel} missing`); continue; }
    const b = rect(e);
    out.info[k] = b;
    if (!inView(b)) fail(`${k}: not fully inside the viewport ${JSON.stringify(b)}`);
    if (!hits(e)) fail(`${k}: covered at its centre by ${document.elementFromPoint(b.x + b.w / 2, b.y + b.h / 2)?.className}`);
  }
  if (document.querySelectorAll(".es-discord-panel").length !== 1) fail(`expected one feedback link, found ${document.querySelectorAll(".es-discord-panel").length}`);

  const link = document.querySelector(".hall-bottombar .es-discord-panel");
  const bottom = document.querySelector(".hall-bottombar");
  if (link && bottom) {
    const l = rect(link), bb = rect(bottom);
    if (l.x < bb.x - 1 || l.y < bb.y - 1 || l.r > bb.r + 1 || l.b > bb.b + 1) fail(`feedback link outside the bottom bar ${JSON.stringify(l)} vs ${JSON.stringify(bb)}`);
    const others = [...document.querySelectorAll(".hall-search, .al-wk-card, .al-wk-sort button")];
    // Cards and sort buttons scrolled out of the drill list are clipped by it: only the
    // visible part counts.
    const clip = (o) => {
      const r = rect(o);
      const board = o.closest(".hall-board-body");
      if (!board) return r;
      const c = rect(board);
      const x = Math.max(r.x, c.x), y = Math.max(r.y, c.y), rr = Math.min(r.r, c.r), bb2 = Math.min(r.b, c.b);
      return { x, y, r: rr, b: bb2, w: rr - x, h: bb2 - y };
    };
    const hit = others.find((o) => { const r = clip(o); return r.w > 0 && r.h > 0 && overlap(l, r); });
    if (hit) fail(`feedback link overlaps ${hit.className}`);
  }

  // The tab row may shrink and scroll inside itself as a fallback. With Bahnschrift (the
  // Windows font the widths are tuned for) no tab may be cut off; with a fallback font
  // (hp has none) it is only reported.
  const ctx = document.createElement("canvas").getContext("2d");
  const probe = "OPEN-AIM Quick start mmwwii";
  ctx.font = "700 40px monospace"; const mono = ctx.measureText(probe).width;
  ctx.font = "700 40px Bahnschrift, monospace"; const bahn = ctx.measureText(probe).width;
  out.info.bahnschrift = Math.abs(mono - bahn) > 0.5;
  const tabs = document.querySelector(".hall-topnav .hall-tabs");
  if (tabs) {
    out.info.tabsClipped = tabs.scrollWidth > tabs.clientWidth + 1;
    if (out.info.tabsClipped && out.info.bahnschrift) fail(`tab row cut off: scrollWidth ${tabs.scrollWidth} > clientWidth ${tabs.clientWidth}`);
  }

  const btns = [...document.querySelectorAll(".es-bar .es-bar-btn")];
  out.info.barButtons = btns.length;
  out.info.labelsShown = btns.length > 0 && btns.every((b) => { const s = b.querySelector("span"); return s && getComputedStyle(s).display !== "none"; });
  if (!btns.length) fail("no .es-bar-btn buttons");
  if (vw >= labelsFrom && !out.info.labelsShown) fail(`bar labels hidden at ${vw}px (should show from ${labelsFrom}px)`);
  const anyLabel = btns.some((b) => { const s = b.querySelector("span"); return s && getComputedStyle(s).display !== "none"; });
  if (vw < labelsFrom && anyLabel) fail(`bar labels shown at ${vw}px (icons only below ${labelsFrom}px)`);
  if (vw < labelsFrom) for (const b of btns) {
    const svg = b.querySelector("svg");
    if (!svg || svg.getBoundingClientRect().width <= 0) fail(`icon-only bar button has no visible icon: ${b.getAttribute("aria-label")}`);
  }
  for (const b of btns) {
    if (!(b.getAttribute("aria-label") || "").trim()) fail(`bar button without aria-label: ${b.title}`);
    if (!(b.title || "").trim()) fail(`bar button without title tooltip: ${b.getAttribute("aria-label")}`);
  }
  const fps = document.querySelector(".es-bar .es-bar-fps");
  if (!fps) fail("no FPS button");
  else if (!["true", "false"].includes(fps.getAttribute("aria-pressed"))) fail("FPS button has no aria-pressed");

  const steps = [...document.querySelectorAll(".hall-topnav .hall-sens-stepper button")];
  out.info.steppers = steps.map(rect).map((b) => `${b.w}x${b.h}`);
  if (steps.length !== 2) fail(`expected 2 Sens arrows, found ${steps.length}`);
  for (const s of steps) {
    const b = rect(s);
    if (b.w < 24 || b.h < 16) fail(`Sens arrow too small: ${b.w}x${b.h} (need 24x16)`);
    if (s.getAttribute("tabindex") !== "-1") fail("Sens arrow is a tab stop");
  }
  const file = document.querySelector(".hall-scene-import-file");
  if (file && file.getAttribute("tabindex") !== "-1") fail("hidden file input is a tab stop");
  const skip = document.querySelector(".hall-root .hall-topnav > .es-skip");
  if (!skip) fail("no Skip to drills link");
  else if (skip !== skip.parentElement.firstElementChild) fail("Skip to drills is not first in the top nav");

  const card = document.querySelector(".al-wk-card");
  out.info.firstCardTop = card ? Math.round(card.getBoundingClientRect().top) : null;
  return out;
}

function pageModalCheck() {
  const link = document.querySelector(".es-discord-panel");
  if (!link) return "no feedback link";
  const b = link.getBoundingClientRect();
  const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  return t && (t === link || link.contains(t)) ? "feedback link is above the open panel's dim layer" : "";
}

function pageFocusRect() {
  const e = document.activeElement;
  if (!e || e === document.body) return null;
  const b = e.getBoundingClientRect();
  const id = (e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : "") + (e.getAttribute("aria-label") ? `[${e.getAttribute("aria-label")}]` : "") || "").slice(0, 80);
  return { id, x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), vw: innerWidth, vh: innerHeight };
}

function pageSkipResult() {
  const e = document.activeElement;
  const card = document.querySelector(".hall-board-body .al-wk-card, .al-wk-card");
  const b = e ? e.getBoundingClientRect() : null;
  const moved = [];
  for (const sel of [".hall-root", ".hall-body"]) {
    const el = document.querySelector(sel);
    if (el && (el.scrollTop || el.scrollLeft)) moved.push(`${sel} ${el.scrollLeft},${el.scrollTop}`);
  }
  const se = document.scrollingElement;
  if (se && (se.scrollTop || se.scrollLeft)) moved.push(`page ${se.scrollLeft},${se.scrollTop}`);
  return {
    focus: e ? (e.tagName.toLowerCase() + "." + String(e.className || "").trim().split(/\s+/).join(".")).slice(0, 80) : "none",
    inCard: !!(card && e && card.contains(e)),
    onScreen: !!b && b.width > 0 && b.height > 0 && b.top >= -1 && b.left >= -1 && b.bottom <= innerHeight + 1 && b.right <= innerWidth + 1,
    frameScrolled: moved.join("; "),
  };
}

function pageBlur() {
  document.activeElement?.blur?.();
  const body = document.querySelector(".hall-board-body");
  if (body) body.scrollTop = 0;
  // Put the lobby frame back too, so one size's failure doesn't carry into the next.
  for (const el of [document.querySelector(".hall-root"), document.querySelector(".hall-body"), document.scrollingElement]) {
    if (el) { el.scrollTop = 0; el.scrollLeft = 0; }
  }
  // Reset the sequential focus start point to the top of the page: focus a temporary
  // element at the start of <body>, then remove it, so the next Tab goes to the first stop.
  const tmp = document.createElement("span");
  tmp.tabIndex = -1;
  document.body.prepend(tmp);
  tmp.focus({ preventScroll: true });
  tmp.remove();
  return true;
}

// ---- main ----

async function settle(send) {
  await evaluate(send, pageRafs);
  let last = "", since = Date.now();
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const sig = await evaluate(send, pageLayoutSig);
    if (sig !== last) { last = sig; since = Date.now(); }
    else if (Date.now() - since >= 300) return true;
    await sleep(60);
  }
  return false;
}

async function shot(send, name) {
  if (!shotDir) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(`${shotDir}/${name}`, Buffer.from(r.data, "base64"));
}

async function checkSize(send, size) {
  const result = { size: `${size.w}x${size.h}@${size.dpr}x`, ok: false, fails: [], info: {} };
  await send("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: false, screenWidth: size.w, screenHeight: size.h });
  await evaluate(send, pageOpenDrills);
  if (!(await waitFor(send, pageReady, 10000))) result.fails.push("lobby not ready within 10 s (no drill card, no Quick start, or a panel still open)");
  if (!(await settle(send))) result.fails.push("layout did not settle within 6 s");

  const lay = await evaluate(send, pageLayout, LABELS_FROM);
  result.fails.push(...lay.fails);
  result.info = lay.info;
  await shot(send, `lobby-${size.w}x${size.h}@${size.dpr}x.png`);

  // A panel's dim layer must cover the feedback link.
  const opened = await evaluate(send, () => { if (!window.__aimTools?.openSens) return false; window.__aimTools.openSens(); return true; });
  if (!opened) result.fails.push("__aimTools.openSens missing");
  else {
    await waitFor(send, () => !!document.querySelector(".es-tool-shade"), 3000);
    await evaluate(send, pageRafs);
    const m = await evaluate(send, pageModalCheck);
    if (m) result.fails.push(m);
    await evaluate(send, () => { window.__aimTools?.close?.(); return true; });
    await waitFor(send, () => !document.querySelector(".es-tool-shade"), 3000);
  }

  // Tab walk from the top: every focused element must be inside the viewport.
  await evaluate(send, pageBlur);
  await evaluate(send, pageRafs);
  const walk = [];
  for (let i = 0; i < TAB_STEPS; i++) {
    await key(send, "Tab");
    await evaluate(send, pageRafs);
    const f = await evaluate(send, pageFocusRect);
    if (!f) { walk.push(null); continue; }
    walk.push(f.id);
    if (size.w === 1280 && i < TAB_SHOTS) await shot(send, `tab-1280-${i + 1}.png`);
    const inside = f.w > 0 && f.h > 0 && f.x >= -1 && f.y >= -1 && f.r <= f.vw + 1 && f.b <= f.vh + 1;
    if (!inside) result.fails.push(`Tab ${i + 1}: ${f.id} outside the viewport (${f.x},${f.y} ${f.w}x${f.h})`);
    if (i === 0 && !/es-skip/.test(f.id)) result.fails.push(`Tab 1 should be Skip to drills, got ${f.id}`);
  }
  result.info.tabWalk = walk;
  const walkScrolled = (await evaluate(send, pageSkipResult)).frameScrolled;
  if (walkScrolled) result.fails.push(`the Tab walk scrolled the lobby frame (${walkScrolled})`);

  // Skip to drills: Tab once, press Enter. Focus must land in the first drill card, on
  // screen, and the lobby frame must not scroll (only the drill list may).
  await evaluate(send, pageBlur);
  await evaluate(send, pageRafs);
  await key(send, "Tab");
  await evaluate(send, pageRafs);
  const onSkip = await evaluate(send, () => !!document.activeElement?.classList?.contains("es-skip"));
  if (!onSkip) result.fails.push("Skip to drills: not focused after one Tab");
  else {
    const before = (await evaluate(send, pageSkipResult)).frameScrolled;
    await enter(send);
    await evaluate(send, pageRafs);
    await evaluate(send, pageRafs);
    const s = await evaluate(send, pageSkipResult);
    result.info.skip = s;
    if (!s.inCard) result.fails.push(`Skip to drills: focus went to ${s.focus}, not the first drill card`);
    else if (!s.onScreen) result.fails.push(`Skip to drills: focused ${s.focus} is off screen`);
    if (s.frameScrolled !== before) result.fails.push(`Skip to drills: the lobby frame scrolled (before "${before}", after "${s.frameScrolled}")`);
    else if (before) result.fails.push(`focusing Skip to drills scrolled the lobby frame (${before})`);
  }
  const docAfter = await evaluate(send, () => document.documentElement.scrollWidth <= innerWidth && (document.scrollingElement?.scrollLeft || 0) === 0);
  if (!docAfter) result.fails.push("page scrolled sideways during the Tab walk");
  await evaluate(send, pageBlur);

  result.ok = result.fails.length === 0;
  return result;
}

// Hard stop so a stuck run never holds the shared hp copy past its 10-minute slot.
setTimeout(() => { console.error("lobby-layout-check: gave up after 8 minutes"); process.exit(3); }, 8 * 60 * 1000).unref();

const { ws, send } = await connect();
let failed = false;
try {
  await send("Runtime.enable");
  // The hp copy is an offscreen window: emulate focus so Tab and focus rings behave.
  try { await send("Emulation.setFocusEmulationEnabled", { enabled: true }); }
  catch (e) { console.error(`focus emulation not available: ${e.message}`); }
  if (!(await waitFor(send, pageStart, 90000))) throw new Error("lobby did not load (startup screen still up or no tabs)");
  for (const size of SIZES) {
    let r;
    try { r = await checkSize(send, size); }
    catch (e) { r = { size: `${size.w}x${size.h}@${size.dpr}x`, ok: false, fails: [String(e.message || e)] }; }
    if (!r.ok) failed = true;
    console.log(JSON.stringify(r));
    if (ws.readyState !== 1) { console.error("the app copy went away; stopping"); failed = true; break; }
  }
} catch (e) {
  failed = true;
  console.error(String(e.stack || e));
} finally {
  try { await send("Emulation.clearDeviceMetricsOverride"); } catch {}
  try { await send("Emulation.setFocusEmulationEnabled", { enabled: false }); } catch {}
  ws.close();
}
process.exit(failed ? 1 : 0);
