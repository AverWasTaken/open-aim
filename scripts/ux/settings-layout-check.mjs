#!/usr/bin/env node
// settings-layout-check.mjs: layout check for the lobby SETTINGS page (section.hall-center.st-view)
// in a running test copy of the app, over the Chrome DevTools Protocol. No dependencies (Node 22+).
//
// Usage:
//   node scripts/ux/settings-layout-check.mjs <cdpPort> [--sizes 1280x720,1920x1080,3840x2160]
//        [--tabs general,controls,...] [--shots <dir>] [--no-search]
//   A size may carry a scale: 1920x1080@2 (CSS 1920x1080 at device scale 2).
//
// Only run it against a HEADLESS test copy (AIM_HEADLESS=1, see open-aim-hq PROTOCOL rule 0).
// It sets Emulation.setDeviceMetricsOverride per size and clears it at the end.
//
// Checks, per size and per settings tab:
//   - no truncated description: .st-list .hall-field-text small, .st-list .al-number-hint,
//     .st-tele dt, .st-tele dd with white-space nowrap + text-overflow ellipsis + scrollWidth > clientWidth+1
//   - no horizontal scroll inside .st-view, .st-main, .st-list, .st-side, and nothing in the
//     preview stack sticks out past the left edge of .st-side (it would be clipped)
//   - live preview hidden on the Control and Audio tabs
//   - at CSS width >= 1920 with the preview shown: .st-list width in [480, 880] and
//     .st-stack width <= 1.4x .st-list width
//   - the preview stack is not cut off at the bottom of .st-side: it either fits, or .st-side
//     scrolls (overflow-y auto/scroll and scrollHeight > clientHeight) so the rest can be reached.
//     At window heights >= 1000 it must fit (scrolling there fails).
//     The line per tab shows "rest" (stack height minus the preview frame: what the CSS
//     --st-rest reserve must cover), the stat count/columns, and "fits" / "scrolls N px"
//   - at CSS width >= 3000 the page is centred: .st-main left gap ~= right gap (within 40 px),
//     and on tabs with the preview, settings column left gap ~= preview right gap (within 40 px)
//   - search on the Audio tab brings the preview back (data-tab is stale while searching),
//     clearing the search hides it again
// Exit code 0 = all passed, 1 = a check failed, 2 = could not run.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const port = argv.shift();
if (!port || !/^\d+$/.test(port)) {
  console.error("usage: node scripts/ux/settings-layout-check.mjs <cdpPort> [--sizes WxH[@s],...] [--tabs a,b] [--shots dir] [--no-search]");
  process.exit(2);
}
const opt = { sizes: "1280x720,1920x1080,3840x2160", tabs: "", shots: "", search: true };
while (argv.length) {
  const a = argv.shift();
  if (a === "--no-search") opt.search = false;
  else if (["--sizes", "--tabs", "--shots"].includes(a)) {
    const v = argv.shift();
    if (!v || v.startsWith("--")) { console.error(`${a} needs a value`); process.exit(2); }
    opt[a.slice(2)] = v;
  }
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
const sizes = opt.sizes.split(",").map((s) => {
  const m = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(s.trim());
  if (!m) { console.error(`bad size ${s}`); process.exit(2); }
  return { w: +m[1], h: +m[2], scale: m[3] ? +m[3] : 1, label: s.trim() };
});
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
    if (await evaluate(`!!(${expr})`)) return true;
    await sleep(150);
  }
  return false;
}
const settle = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))))");

// Opens the lobby SETTINGS page from the top nav (button text is translated, so match both).
async function openSettings() {
  if (await evaluate(`!!document.querySelector(".hall-root section.st-view")`)) return;
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll(".hall-root .hall-topnav .hall-tab")]
      .find((el) => /^(settings|设置)$/i.test(el.textContent.trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) throw new Error("top-nav SETTINGS button not found (is the lobby showing?)");
  if (!(await waitFor(`document.querySelector(".hall-root section.st-view")`))) throw new Error("section.st-view did not appear");
}

async function setSearch(text) {
  const ok = await evaluate(`(() => {
    const el = document.querySelector(".hall-root .st-view .st-searchrow input");
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error("settings search input not found");
  await settle();
}

async function selectTab(id) {
  await evaluate(`document.querySelector('.hall-root .st-view .st-tabbar [data-tab="${id}"]').click()`);
  if (!(await waitFor(`document.querySelector('.hall-root section.st-view[data-tab="${id}"]')`, 5000))) throw new Error(`tab ${id} did not open`);
  if (id === "video" && !(await waitFor(`document.querySelector('.hall-root .st-view [data-setting="mapLighting"]')`, 8000))) {
    console.log("  note: video tab has no [data-setting=mapLighting] row after 8 s (lighting-settings.js not injected?)");
  }
  await evaluate(`(() => { const l = document.querySelector(".hall-root .st-view .st-list"); if (l) l.scrollTop = 0; })()`);
  await settle();
}

// Runs in the page; returns plain measurements.
const MEASURE = `(() => {
  const view = document.querySelector(".hall-root section.st-view");
  const q = (s) => view.querySelector(s);
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  const shown = (el) => !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
  const truncated = [];
  for (const el of view.querySelectorAll(".st-list .hall-field-text small, .st-list .al-number-hint, .st-tele dt, .st-tele dd")) {
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.whiteSpace === "nowrap" && cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1)
      truncated.push(el.textContent.trim().slice(0, 70));
  }
  const hscroll = [];
  for (const s of [":scope", ".st-main", ".st-list", ".st-main > .st-side"]) {
    const el = s === ":scope" ? view : q(s);
    if (el && el.scrollWidth > el.clientWidth + 1) hscroll.push(s === ":scope" ? ".st-view" : s === ".st-main > .st-side" ? ".st-side" : s);
  }
  const side = q(".st-main > .st-side");
  const stack = q(".st-stack");
  const on = shown(side) && shown(stack);
  const kids = on ? [...stack.querySelectorAll("*")].filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect()) : [];
  const mon = on ? stack.querySelector(".st-monitor") : null;
  const tele = on ? stack.querySelector(":scope > .st-tele") : null;
  const sideCs = on ? getComputedStyle(side) : null;
  return {
    tab: view.dataset.tab,
    searching: !q(".st-list.st-brief") && !["controls", "crosshair"].includes(view.dataset.tab),
    innerWidth, innerHeight,
    list: box(q(".st-list")), side: shown(side) ? box(side) : null, stack: shown(stack) ? box(stack) : null,
    stackBottom: on ? Math.round(Math.max(...kids.map((r) => r.bottom), stack.getBoundingClientRect().bottom)) : null,
    stackLeft: on ? Math.round(Math.min(...kids.map((r) => r.left), stack.getBoundingClientRect().left)) : null,
    stackRight: on ? Math.round(Math.max(...kids.map((r) => r.right), stack.getBoundingClientRect().right)) : null,
    rest: on && mon ? Math.round(stack.getBoundingClientRect().height - mon.getBoundingClientRect().height) : null,
    tele: tele ? { n: tele.children.length, cols: getComputedStyle(tele).gridTemplateColumns.split(" ").length } : null,
    sideScroll: on ? { overflowY: sideCs.overflowY, sh: side.scrollHeight, ch: side.clientHeight } : null,
    main: box(q(".st-main")), clientWidth: document.documentElement.clientWidth,
    truncated, hscroll,
  };
})()`;

const failures = [];
function check(ctx, m) {
  const f = (msg) => failures.push(`${ctx}: ${msg}`);
  if (m.truncated.length) f(`${m.truncated.length} truncated text(s): ${m.truncated.slice(0, 4).map((t) => JSON.stringify(t)).join(", ")}`);
  if (m.hscroll.length) f(`horizontal scroll in ${m.hscroll.join(", ")}`);
  if (!m.searching && ["controls", "audio"].includes(m.tab) && m.side) f(`preview shown on ${m.tab}`);
  if (m.side && m.stack) {
    if (m.innerWidth >= 1920) {
      if (m.list.w < 480 || m.list.w > 880) f(`settings column ${m.list.w}px, want 480-880`);
      if (m.stack.w > 1.4 * m.list.w + 1) f(`preview ${m.stack.w}px is more than 1.4x the settings column ${m.list.w}px`);
    }
    if (m.stackBottom > m.side.bottom + 1) {
      const sc = m.sideScroll;
      const scrolls = ["auto", "scroll"].includes(sc.overflowY) && sc.sh > sc.ch + 1;
      if (!scrolls) f(`preview cut off: content bottom ${m.stackBottom} > side bottom ${m.side.bottom} and .st-side does not scroll`);
      else if (m.innerHeight >= 1000) f(`preview column scrolls ${sc.sh - sc.ch}px at ${m.innerHeight}px tall (it should fit there)`);
    }
    if (m.stackLeft < m.side.x - 1) f(`preview sticks out ${m.side.x - m.stackLeft}px past the left edge of .st-side (clipped)`);
  }
  if (m.innerWidth >= 3000 && m.main) {
    const gl = m.main.x, gr = m.clientWidth - (m.main.x + m.main.w);
    if (Math.abs(gl - gr) > 40) f(`settings page not centred: .st-main left gap ${gl}px, right gap ${gr}px`);
    if (m.side && m.stack) {
      const cl = m.list.x, cr = m.clientWidth - m.stackRight;
      if (Math.abs(cl - cr) > 40) f(`settings + preview not centred: left gap ${cl}px, right gap ${cr}px`);
    }
  }
}
const fit = (m) => {
  if (!m.side || !m.stack) return "";
  const t = m.tele ? `  stats ${m.tele.n} in ${m.tele.cols} col` : "  no stats";
  const over = m.sideScroll.sh - m.sideScroll.ch;
  return `  rest ${m.rest}px${t}  ${over > 1 ? `scrolls ${over}px` : "fits"}`;
};
const fmt = (m) => `list ${m.list?.w}x${m.list?.h}  preview ${m.side ? `${m.stack?.w}px (side ${m.side.w}x${m.side.h})` : "hidden"}${fit(m)}  truncated ${m.truncated.length}  hscroll ${m.hscroll.length ? m.hscroll.join("/") : "none"}${m.innerWidth >= 3000 && m.main ? `  main x ${m.main.x}..${m.main.x + m.main.w} of ${m.clientWidth}` : ""}`;

async function main() {
  cdp = await connect();
  try {
    for (const size of sizes) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: size.scale, mobile: false });
      await settle();
      await openSettings();
      await setSearch("");
      const all = await evaluate(`[...document.querySelectorAll(".hall-root .st-view .st-tabbar [data-tab]")].map((b) => b.dataset.tab)`);
      const tabs = opt.tabs ? opt.tabs.split(",").filter((t) => all.includes(t)) : all;
      console.log(`== ${size.label}  tabs: ${tabs.join(", ")}`);
      for (const tab of tabs) {
        await selectTab(tab);
        const m = await evaluate(MEASURE);
        console.log(`  ${tab.padEnd(10)} ${fmt(m)}`);
        check(`${size.label} ${tab}`, m);
        if (opt.shots) {
          const r = await cdp.send("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(path.join(opt.shots, `settings-${size.label.replace("@", "-dpr")}-${tab}.png`), Buffer.from(r.data, "base64"));
        }
      }
      if (opt.search && all.includes("audio")) {
        await selectTab("audio");
        await setSearch("volume");
        const s1 = await evaluate(MEASURE);
        console.log(`  audio+search ${fmt(s1)}`);
        if (!s1.side) failures.push(`${size.label} audio search: preview did not come back while searching`);
        check(`${size.label} audio search`, s1);
        await setSearch("");
        const s2 = await evaluate(MEASURE);
        if (s2.side) failures.push(`${size.label} audio after clearing search: preview still shown`);
      }
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    cdp.close();
  }
  if (failures.length) {
    console.log(`\nFAIL (${failures.length})`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(2); });
