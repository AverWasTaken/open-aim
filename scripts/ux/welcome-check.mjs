#!/usr/bin/env node
// welcome-check.mjs: app check for the first-run welcome banner (app/ux-welcome.js) in a running
// HEADLESS test copy, over the Chrome DevTools Protocol. Built-ins only (Node 22+).
//
// Usage: node scripts/ux/welcome-check.mjs <cdpPort> [--shots <dir>] [--no-play]
//
// Order (plan W3-H R1.9):
//   1. Lobby ready, first-run import modal closed (.valorant-import-shade .es-tool-x, no reload).
//      The profile should be fresh; if ux-welcome-v1 is not "shown" the script resets it and reloads.
//   2. At 1280x720 and 1920x1080: banner right after the hero, 3 steps, compact at <= 800 tall;
//      first drill title bottom vs bottom bar top with the banner and with ux-welcome-v1="done";
//      banner height.
//   3. Sens tools opens .es-tool-shade (banner stays), close it; step 1 ticked.
//   4. Crosshair settings -> Settings page, crosshair tab selected.
//   5. Back to VALORANT Training: banner back, step 2 ticked.
//   6. Play featured drill -> rank picker (.aim-pick-shade) or loading (.al-wkload) within 5 s
//      (skipped with --no-play); the page is reloaded afterwards if a drill started.
//   7. Hide -> gone; reload -> still gone.
// Exit 0 = all passed, 1 = a check failed, 2 = could not run.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const port = argv.shift();
if (!port || !/^\d+$/.test(port)) {
  console.error("usage: node welcome-check.mjs <cdpPort> [--shots dir] [--no-play]");
  process.exit(2);
}
const opt = { shots: "", play: true };
while (argv.length) {
  const a = argv.shift();
  if (a === "--no-play") opt.play = false;
  else if (a === "--shots") opt.shots = argv.shift() || "";
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
if (opt.shots) fs.mkdirSync(opt.shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message} ${msg.error.data || ""}`)) : res(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, close: () => ws.close() };
}

let cdp;
async function evaluate(expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expr, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await evaluate(`!!(${expr})`)) return true; } catch { /* page reloading */ }
    await sleep(150);
  }
  return false;
}
const settle = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))))");
async function shot(name) {
  if (!opt.shots) return;
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  const f = path.join(opt.shots, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, "base64"));
  console.log(`  shot ${f}`);
}
// Real mouse click at an element's centre (a user gesture, as fullscreen needs).
async function clickSel(sel) {
  const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!p) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  }
  return true;
}

const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? `  (${info})` : ""}`);
}

const CLOSE_IMPORT = `(() => { let n = 0; for (const x of document.querySelectorAll(".valorant-import-shade .es-tool-x")) { x.click(); n++; } return n; })()`;
const LOBBY_READY = `!document.querySelector(".es-startup") && !!document.querySelector(".hall-root .hall-tab")`;
async function toTraining() {
  await evaluate(`(() => { const t = document.querySelector(".hall-root .hall-topnav .hall-tab") || document.querySelector(".hall-root .hall-tab");
    if (t && !t.classList.contains("is-active")) t.click(); })()`);
  return waitFor(`document.querySelector(".al-wk-card") && document.querySelector(".al-wk-hero")`, 15000);
}
async function lobby() {
  if (!(await waitFor(LOBBY_READY, 120000))) throw new Error("lobby did not appear in 120 s");
  // The import modal opens a moment after the lobby: close it for a few seconds.
  for (let i = 0; i < 12; i++) { await evaluate(CLOSE_IMPORT); await sleep(250); }
  if (!(await toTraining())) throw new Error("VALORANT Training view did not appear");
  await evaluate(CLOSE_IMPORT);
  await settle();
}
async function reload() {
  await cdp.send("Page.reload", { ignoreCache: false });
  await sleep(1500);
  await lobby();
}

const MEASURE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
  const banner = document.querySelector(".ux-welcome");
  const hero = document.querySelector(".hall-root header.al-wk-hero");
  const title = document.querySelector(".hall-board-body .al-wk-card h3, .al-wk-card h3");
  const bar = document.querySelector(".hall-bottombar");
  const h1 = document.querySelector(".al-wk-hero-copy > h1");
  return {
    vw: innerWidth, vh: innerHeight,
    key: localStorage.getItem("ux-welcome-v1"), steps: localStorage.getItem("ux-welcome-steps-v1"),
    banner: r(banner), connected: !!banner && banner.isConnected,
    afterHero: !!banner && !!hero && hero.nextElementSibling === banner,
    compact: !!banner && banner.classList.contains("is-compact"),
    stepCount: banner ? banner.querySelectorAll(".ux-welcome-step").length : 0,
    done: banner ? [...banner.querySelectorAll(".ux-welcome-step")].map((s) => s.classList.contains("is-done")) : [],
    htmlOn: document.documentElement.classList.contains("ux-welcome-on"),
    hero: r(hero), h1Shown: !!h1 && getComputedStyle(h1).display !== "none",
    go: !!document.querySelector(".al-wk-hero .al-wk-go"),
    titleBottom: title ? Math.round(title.getBoundingClientRect().bottom) : null,
    barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
    hscroll: document.documentElement.scrollWidth > innerWidth + 1,
    overflowBanner: banner ? [...banner.querySelectorAll("button, .ux-welcome-name")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim()) : [],
  };
})()`;
const resync = `new Promise((r) => { window.__aimUxWelcome && window.__aimUxWelcome.sync([]); requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))); })`;

async function main() {
  cdp = await connect();
  const info = {};
  try {
    await cdp.send("Page.enable");
    await lobby();
    check("ux-welcome.js installed", await evaluate("!!window.__aimUxWelcome"));
    const key0 = await evaluate(`localStorage.getItem("ux-welcome-v1")`);
    info.initialKey = key0;
    if (key0 !== "shown") {
      console.log(`  note: ux-welcome-v1 was ${JSON.stringify(key0)} (profile not fresh); resetting to "shown" and reloading`);
      await evaluate(`(() => { localStorage.setItem("ux-welcome-v1", "shown"); localStorage.removeItem("ux-welcome-steps-v1"); })()`);
      await reload();
    }
    info.preKeys = await evaluate(`({ sens: localStorage.getItem("al-sensitivity-v1"), crosshair: localStorage.getItem("al-crosshair-v1"),
      runs: [localStorage.getItem("al-workshop-runs-v1"), localStorage.getItem("al-pw-runs-v1")].map((v) => (v || "").length) })`);
    console.log(`  keys before: ${JSON.stringify(info.preKeys)}`);

    // 2. Placement + numbers per size.
    info.sizes = {};
    for (const [w, h] of [[1280, 720], [1920, 1080]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await evaluate(`(() => { const b = document.querySelector(".hall-board-body"); if (b) b.scrollTop = 0; })()`);
      await settle();
      await evaluate(resync);
      const m = await evaluate(MEASURE);
      const label = `${w}x${h}`;
      check(`${label} banner right after the hero`, m.connected && m.afterHero);
      check(`${label} 3 steps`, m.stepCount === 3, `${m.stepCount}`);
      check(`${label} compact ${h <= 800 ? "on" : "off"}`, m.compact === (h <= 800));
      check(`${label} html.ux-welcome-on`, m.htmlOn);
      check(`${label} banner height`, m.banner && m.banner.h <= (h <= 800 ? 40 : 104), `${m.banner?.h}px, max ${h <= 800 ? 40 : 104}`);
      check(`${label} no horizontal scroll`, !m.hscroll);
      check(`${label} no cut-off banner text`, !m.overflowBanner.length, m.overflowBanner.join(" | "));
      if (h <= 800) check(`${label} hero heading hidden while banner shows`, !m.h1Shown);
      check(`${label} hero play button still there`, m.go);
      await shot(`welcome-${label}`);
      // Baseline: same page with the banner off.
      await evaluate(`localStorage.setItem("ux-welcome-v1", "done")`);
      await evaluate(resync);
      const b = await evaluate(MEASURE);
      check(`${label} banner off with ux-welcome-v1="done"`, !b.connected && !b.htmlOn);
      await evaluate(`localStorage.setItem("ux-welcome-v1", "shown")`);
      await evaluate(resync);
      info.sizes[label] = {
        bannerH: m.banner?.h, heroH_banner: m.hero?.h, heroH_done: b.hero?.h,
        titleBottom_banner: m.titleBottom, titleBottom_done: b.titleBottom, barTop: m.barTop,
      };
      console.log(`  ${label}: ${JSON.stringify(info.sizes[label])}`);
      if (h <= 800) {
        // Lead decision: allowed to fail while the banner is up; reported, not fatal.
        const fits = m.titleBottom != null && m.barTop != null && m.titleBottom <= m.barTop;
        console.log(`${fits ? "ok  " : "WARN"} ${label} first drill title (${m.titleBottom}) above bottom bar (${m.barTop}) with banner; without banner ${b.titleBottom}`);
        info.fits720 = fits;
      }
    }

    // Function checks in the full layout.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await settle();
    await evaluate(resync);

    // 3. Sens tools.
    check("click Sens tools", await clickSel('.ux-welcome [data-ux-welcome="sens"]'));
    const shade = await waitFor(`document.querySelector(".es-tool-shade")`, 3000);
    check("Sens tools opens .es-tool-shade", shade);
    const under = await evaluate(MEASURE);
    check("banner stays while a dialog is open", under.connected && under.afterHero);
    await shot("welcome-sens-open");
    await evaluate(`(() => { window.__aimTools?.close?.(); for (const x of document.querySelectorAll(".es-tool-shade .es-tool-x")) x.click(); })()`);
    await waitFor(`!document.querySelector(".es-tool-shade")`, 3000);
    await evaluate(resync);
    const s1 = await evaluate(MEASURE);
    check("step 1 ticked after Sens tools", s1.done[0] === true, JSON.stringify(s1.done));

    // 4. Crosshair settings.
    check("click Crosshair settings", await clickSel('.ux-welcome [data-ux-welcome="crosshair"]'));
    const xh = await waitFor(`document.querySelector('.st-view .st-tab[data-tab="crosshair"][aria-selected="true"]')`, 5000);
    check("Settings page with the crosshair tab selected", xh);
    await settle();
    const onSettings = await evaluate(MEASURE);
    check("banner out on the Settings page", !onSettings.connected && !onSettings.htmlOn);
    await shot("welcome-crosshair-tab");

    // 5. Back to VALORANT Training.
    check("back to VALORANT Training", await toTraining());
    await evaluate(resync);
    const back = await evaluate(MEASURE);
    check("banner back after the hero", back.connected && back.afterHero);
    check("step 2 ticked", back.done[1] === true, JSON.stringify(back.done));
    await shot("welcome-back");

    // 6. Play featured drill (optional).
    if (opt.play) {
      check("click Play featured drill", await clickSel('.ux-welcome [data-ux-welcome="play"]'));
      const started = await waitFor(`document.querySelector(".aim-pick-shade, .al-wkload, .aim-loading-compact, .al-aimlab-root")`, 5000);
      const what = await evaluate(`["aim-pick-shade","al-wkload","aim-loading-compact","al-aimlab-root"].filter((c) => document.querySelector("." + c)).join(",")`);
      check("Play featured drill opens the rank picker or starts loading", started, what);
      await shot("welcome-play");
      if (/al-wkload|aim-loading|al-aimlab/.test(what)) {
        await reload();
      } else {
        await evaluate(`(() => { for (const x of document.querySelectorAll(".aim-pick-shade .es-tool-x, .aim-pick-shade [aria-label*=lose i]")) x.click(); })()`);
        if (!(await waitFor(`!document.querySelector(".aim-pick-shade")`, 2000))) {
          await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await waitFor(`!document.querySelector(".aim-pick-shade")`, 2000);
        }
        if (await evaluate(`!!document.querySelector(".aim-pick-shade, .al-wkload, .al-aimlab-root")`)) await reload();
      }
      await evaluate(resync);
    }

    // 7. Hide.
    check("banner showing before Hide", (await evaluate(MEASURE)).connected);
    check("click Hide", await clickSel('.ux-welcome [data-ux-welcome="hide"]'));
    await settle();
    const hid = await evaluate(MEASURE);
    check("Hide removes the banner and the html class", !hid.connected && !hid.htmlOn);
    check('Hide writes ux-welcome-v1="done"', hid.key === "done", String(hid.key));
    await reload();
    await sleep(1500);
    await evaluate(resync);
    const after = await evaluate(MEASURE);
    check("still gone after reload", !after.connected && after.key === "done");
    await shot("welcome-hidden-after-reload");
  } finally {
    try { await cdp.send("Emulation.clearDeviceMetricsOverride"); } catch { /* ignore */ }
    cdp.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${JSON.stringify(info)}`);
  console.log(`${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(`could not run: ${e.message}`); try { cdp?.close(); } catch { /* ignore */ } process.exit(2); });
