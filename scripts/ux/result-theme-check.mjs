// App check for the result card theme and container (app/theme-esports.css "result card colours
// and shapes", app/ux-result.js). Runs on hp against a hidden copy:
//   hp.sh cdp-script <CDP> scripts/ux/result-theme-check.mjs [outDir]
// Node built-ins only. Plays ONE mapless 60 s drill to the result card, waits 2.5 s, then in one
// evaluate: sweeps the card for rounded corners, checks the real nodes (--run-good, container
// placement, R/Esc hints) and reads computed colours/radii from probe elements that carry the
// run report's scope attribute (removed again right after). Prints one JSON line per check and a
// final RESULTS line; the screenshot goes to outDir. Bails out at ~9 min.
import fs from 'node:fs';
import path from 'node:path';

const [port = '9431', outDir = '/tmp/ux-d2'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const MAPLESS = 'e3c17ccb9f5a1500'; // micro-flicks (arena, 60 s)
const T0 = Date.now();
const BUDGET = 9 * 60 * 1000;
const left = () => BUDGET - (Date.now() - T0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const results = { checks: {} };
const errors = [];

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
let closed = false;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
};
ws.onclose = () => { closed = true; };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const send = (method, params = {}) => new Promise((r, j) => {
  if (closed) return j(new Error('CDP closed (copy killed?)'));
  const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr) {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (m.result?.exceptionDetails) throw new Error('eval: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
  return m.result?.result?.value;
}
async function waitFor(expr, ms, what) {
  const end = Date.now() + Math.min(ms, left());
  for (;;) {
    if (closed) throw new Error('CDP closed (copy killed?)');
    let v = null;
    try { v = await ev(expr); } catch {}
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout: ' + (what || expr));
    await sleep(500);
  }
}
async function shot(name) {
  const m = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
  say('shot', file);
  return file;
}
async function clickXY(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function key(k) {
  const vk = { Escape: 27, Enter: 13 }[k] || 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
}
const startText = `(document.body.innerText || "").toLowerCase().includes("click anywhere to start")`;
const overlayUp = `(() => { const s = document.querySelector(".al-wkload-stage"); if (!s) return false; const cs = getComputedStyle(s); const r = s.getBoundingClientRect(); return cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.05 && r.width > 0; })()`;
const resultUp = `!!document.querySelector(".al-result-overlay .al-result-modal")`;

async function launch(code) {
  const ok = await ev(`window.__aimLaunchWorkshop ? window.__aimLaunchWorkshop(${JSON.stringify(code)}) : "no hook"`);
  say('launch', ok);
  if (ok !== true) throw new Error('launch returned ' + ok);
  await sleep(2500);
  const gate = await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.offsetParent && /^(play|start|confirm)$/i.test(x.innerText.trim()) && x.closest('[class*="rank"]')); if (!b) return null; b.click(); return b.innerText; })()`);
  if (gate) say('rank gate clicked', gate);
}
async function startDrill() {
  await waitFor(`document.querySelector(".hall-train-layer") && !${overlayUp}`, 200000, 'loading overlay gone');
  try { await waitFor(startText, 60000, 'start text'); } catch { say('no start text seen; assuming the run started'); return; }
  await sleep(1500);
  const vw = await ev(`({ w: innerWidth, h: innerHeight })`);
  for (let i = 0; i < 6; i++) {
    if (i % 2 === 0) await clickXY(vw.w / 2, vw.h / 2); else await key('Enter');
    await sleep(2500);
    if (!(await ev(startText))) { say('started after try', i + 1); return; }
  }
  throw new Error('drill did not start');
}
async function playOut(maxMs) {
  const vw = await ev(`({ w: innerWidth, h: innerHeight })`);
  const t = Date.now();
  const end = t + Math.min(maxMs, left());
  while (Date.now() < end) {
    if (await ev(resultUp)) { say('result card after', ((Date.now() - t) / 1000).toFixed(0), 's'); return; }
    if (Date.now() - t < 20000) await clickXY(vw.w / 2, vw.h / 2);
    await sleep(2000);
  }
  throw new Error('no result card');
}

// One evaluate: radius sweep and real-node checks first, then probes (added, read, removed).
const INSPECT = `(() => {
  const out = {};
  const radius = (cs) => [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
  const rounded = (cs) => radius(cs).some((r) => parseFloat(r) > 0);
  const modal = document.querySelector(".al-result-overlay .al-result-modal");
  out.rounded = [];
  for (const el of modal.querySelectorAll("*:not(canvas):not(.es-shotgraph-sum *):not(.tr-bar *)")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    if (rounded(cs)) out.rounded.push((el.tagName.toLowerCase() + "." + String(el.className).trim().replace(/\\s+/g, ".")).slice(0, 80) + " " + radius(cs).join(" "));
  }
  const body = document.querySelector(".al-result-overlay .al-run-body");
  out.runGood = body ? getComputedStyle(body).getPropertyValue("--run-good").trim() : null;
  const extra = body ? [...body.children].filter((c) => c.classList.contains("ux-result-extra")) : [];
  out.extraCount = extra.length;
  const ex = extra[0] || null;
  const next = ex && ex.nextElementSibling;
  out.extraNext = next ? String(next.className) : null;
  out.extraBeforeActions = !!next && (next.classList.contains("al-run-actions") || (next.classList.contains("es-shotgraph-sum") && !!next.nextElementSibling && next.nextElementSibling.classList.contains("al-run-actions")));
  out.extraDisplay = ex ? getComputedStyle(ex).display : null;
  out.extraApi = !!(window.__aimUxResult && window.__aimUxResult.extra() === ex && ex);
  out.order = body ? [...body.children].map((c) => String(c.className).split(" ")[0]) : [];
  const prim = document.querySelector(".al-result-overlay .al-run-actions .al-primary-btn");
  const sec = document.querySelector(".al-result-overlay .al-run-actions .al-secondary-btn");
  const vis = (b) => !!b && b.getClientRects().length > 0 && getComputedStyle(b).visibility !== "hidden";
  out.hintR = prim ? getComputedStyle(prim, "::before").content : null;
  out.hintEsc = sec ? getComputedStyle(sec, "::before").content : null;
  out.hintsVisible = vis(prim) && vis(sec);

  const S = "data-v-36d44781";
  const mk = (tag, cls, parent, scoped = true) => { const e = document.createElement(tag); if (cls) e.className = cls; if (scoped) e.setAttribute(S, ""); parent.appendChild(e); return e; };
  const overlay = document.querySelector(".al-result-overlay");
  const probes = [];
  const delta = mk("span", "al-run-delta is-up", body); probes.push(delta);
  const deltaB = mk("b", "", delta); deltaB.textContent = "+1";
  const track = mk("div", "al-run-pb-track", body); probes.push(track);
  const fill = mk("i", "", track); fill.style.width = "50%";
  const legend = mk("span", "al-run-legend", body); probes.push(legend);
  const legendSpan = mk("span", "", legend); legendSpan.textContent = "Score";
  const side = mk("aside", "al-bots-card is-side", overlay, false); probes.push(side);
  const sideB = mk("b", "", mk("h3", "", side, false), false); sideB.textContent = "5";
  const map = mk("div", "al-bots-card-map", side, false);
  const verdicts = {};
  for (const k of ["is-cleared", "is-time", "is-died"]) {
    const v = mk("div", "al-result-verdict " + k, overlay, false); probes.push(v);
    const b = mk("b", "", v, false); b.textContent = "X";
    verdicts[k] = b;
  }
  const cs = (e, pseudo) => getComputedStyle(e, pseudo || null);
  out.probe = {
    deltaColor: cs(delta).color,
    deltaChipRadius: cs(deltaB).borderTopLeftRadius,
    pbFillBg: cs(fill).backgroundColor,
    pbFillImage: cs(fill).backgroundImage,
    pbFillRadius: cs(fill).borderTopLeftRadius,
    pbTrackRadius: cs(track).borderTopLeftRadius,
    legendLine: cs(legendSpan, "::before").borderTopColor,
    sideCount: cs(sideB).color,
    mapRadius: cs(map).borderTopLeftRadius,
    verdictCleared: cs(verdicts["is-cleared"]).color,
    verdictTime: cs(verdicts["is-time"]).color,
    verdictDied: cs(verdicts["is-died"]).color,
  };
  for (const p of probes) p.remove();
  out.probesLeft = probes.filter((p) => p.isConnected).length;
  return out;
})()`;

function check(name, pass, data) {
  results.checks[name] = { pass: !!pass, ...data };
  console.log(JSON.stringify({ check: name, pass: !!pass, ...data }));
}

try {
  await send('Runtime.enable');
  await waitFor(`typeof window.__aimLaunchWorkshop === "function"`, 180000, 'lobby hooks');
  await ev(`localStorage.setItem("aim-valorant-import-hide-startup-v1", "1"), true`);
  await sleep(2000);
  results.page = await ev(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
  say('page', JSON.stringify(results.page));
  await launch(MAPLESS);
  await startDrill();
  await playOut(120000);
  await sleep(2500);
  const r = await ev(INSPECT);
  results.raw = r;
  const p = r.probe;
  check('no rounded corners in the card', r.rounded.length === 0, { rounded: r.rounded });
  check('--run-good is the green token', /^#4ade80$/i.test(r.runGood), { runGood: r.runGood });
  check('one container right above the buttons (or the shot summary)', r.extraCount === 1 && r.extraBeforeActions && r.extraApi, { extraCount: r.extraCount, next: r.extraNext, api: r.extraApi, display: r.extraDisplay, order: r.order });
  check('R / Esc hints still there', r.hintR === '"R"' && r.hintEsc === '"Esc"' && r.hintsVisible, { hintR: r.hintR, hintEsc: r.hintEsc, visible: r.hintsVisible });
  check('delta up is green, chip square', p.deltaColor === 'rgb(74, 222, 128)' && p.deltaChipRadius === '0px', { color: p.deltaColor, radius: p.deltaChipRadius });
  check('best-score bar solid warn, square', p.pbFillBg === 'rgb(255, 209, 102)' && p.pbFillImage === 'none' && p.pbFillRadius === '0px' && p.pbTrackRadius === '0px', { bg: p.pbFillBg, image: p.pbFillImage, fill: p.pbFillRadius, track: p.pbTrackRadius });
  check('legend score line red', p.legendLine === 'rgb(255, 70, 85)', { line: p.legendLine });
  check('bot card count white, map square', p.sideCount === 'rgb(244, 245, 247)' && p.mapRadius === '0px', { count: p.sideCount, map: p.mapRadius });
  check('verdict badge colours', p.verdictCleared === 'rgb(74, 222, 128)' && p.verdictTime === 'rgb(255, 209, 102)' && p.verdictDied === 'rgb(255, 70, 85)', { cleared: p.verdictCleared, time: p.verdictTime, died: p.verdictDied });
  results.screenshot = await shot('result-theme.png');
  results.done = true;
} catch (err) {
  results.error = String(err.message || err);
  say('ERROR', results.error);
  try { results.screenshot = await shot('result-theme-error.png'); } catch {}
} finally {
  results.errors = errors.slice(0, 20);
  results.allPass = !!results.done && Object.values(results.checks).every((c) => c.pass);
  console.log('RESULTS ' + JSON.stringify(results));
  try { ws.close(); } catch {}
  process.exit(0);
}
