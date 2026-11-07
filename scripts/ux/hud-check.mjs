// W2-E1 app check (readable HUD, Tab menu, loading progress). Runs ON hp against 127.0.0.1:<cdp>:
//   bash C:/Users/Jacob/open-aim-hq/hp.sh cdp-script 9437 scripts/ux/hud-check.mjs [outDir]
// Node built-ins only. Writes PNGs + result.json to outDir (default /tmp/ux-hud-check) and prints
// one RESULT_JSON line. Covers: loading label + % over time (first drill), ball drill HUD + Tab menu,
// bot drill HUD + Tab menu (+ one 2560x1440 HUD shot), Round mode Tab menu.
// Launch helpers adapted from open-aim-hq/shots/training/g3ac/lib.mjs (training team).
import { writeFileSync, mkdirSync } from "node:fs";
const PORT = Number(process.argv[2] || 9437);
const OUT = process.argv[3] || "/tmp/ux-hud-check";
mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const BUDGET_MS = Number(process.env.HUD_BUDGET_MS || 9 * 60 * 1000 - 20000);
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1) + "s";
const log = (...a) => console.log(`[${elapsed()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Bail extends Error {}
const left = () => BUDGET_MS - (Date.now() - T0);
const checkBudget = (what) => { if (left() <= 0) throw new Bail("time budget used up at: " + what); };
const RESULT = { checks: {}, errors: [], notes: [] };
const errs = [];
const BENIGN = [/desktop-seen/, /aimlab\/plays\/workshop/, /lock-events/, /Insecure Content-Security-Policy/, /Multiple instances of Three\.js/];
let ws, send, sessionAlive = true;
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === "page" && !x.url.startsWith("devtools"));
  if (!t) throw new Error("no page target");
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0;
  const pending = new Map();
  ws.onclose = () => { sessionAlive = false; for (const { bad } of pending.values()) bad(new Error("CDP connection closed")); pending.clear(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { ok, bad } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errs.push({ at: elapsed(), kind: "exception", text: (d.exception?.description || d.text || "").slice(0, 400) });
    } else if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
      const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400);
      if (!BENIGN.some((r) => r.test(text))) errs.push({ at: elapsed(), kind: "console." + m.params.type, text });
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      const text = (m.params.entry.text + " " + (m.params.entry.url || "")).slice(0, 400);
      if (!BENIGN.some((r) => r.test(text))) errs.push({ at: elapsed(), kind: "log", text });
    }
  };
  send = (method, params = {}) => new Promise((ok, bad) => {
    if (!sessionAlive) return bad(new Error("CDP connection closed"));
    const i = ++id;
    pending.set(i, { ok, bad });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
}
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error("eval error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
}
async function waitFor(expr, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    checkBudget(what || expr);
    let v = null;
    try { v = await ev(`(()=>{try{return (${expr})}catch(e){return null}})()`); } catch (e) { if (!sessionAlive) throw e; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(400);
  }
}
async function shot(name) {
  try {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
    log("shot", name);
  } catch (e) { log("shot failed", name, e.message); }
}
async function clickAt(x, y, button = "left") {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
}
async function clickSel(sel) {
  const b = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return r.width>0?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`);
  if (!b) return false;
  await clickAt(b.x, b.y);
  return true;
}
// Click the first visible element whose text matches the regex source (case-insensitive).
async function clickText(re, sel = "button, a, [role=tab], [role=button], .hall-tab, span, div") {
  const b = await ev(`(()=>{const re=new RegExp(${JSON.stringify(re)},"i");const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&re.test(e.textContent.trim())});els.sort((a,b)=>a.textContent.length-b.textContent.length);const e=els[0];if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,t:e.textContent.trim().slice(0,60),c:e.className}})()`);
  if (!b) return null;
  await clickAt(b.x, b.y);
  return b;
}
async function key(k) {
  const vk = { Enter: 13, Escape: 27 }[k] || 0;
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: vk });
  if (k === "Enter") await send("Input.dispatchKeyEvent", { type: "char", text: "\r", key: k, code: k, windowsVirtualKeyCode: vk });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk });
}
// Per page load: phase + scene + result listeners, tick capture.
const HOOKS = `(()=>{if(window.__g3)return 1;const g=window.__g3={ph:[],scene:0,results:[]};
addEventListener('aim-round-phase',e=>g.ph.push(e.detail&&e.detail.phase));
addEventListener('aim-local-scene',()=>{g.scene++});
addEventListener('aim-local-result',e=>{const d=e.detail||{};g.results.push({source:d.source,eligible:d.eligible,code:d.record&&d.record.shareCode,score:d.record&&d.record.score})});
const wrap=()=>{const o=window.__aimTick;if(typeof o!=='function'||o.__g3)return;const w=function(s){g.tick=s;return o.apply(this,arguments)};w.__g3=1;window.__aimTick=w};wrap();g.wrapTimer=setInterval(wrap,1000);return 1})()`;
const LOBBY_READY = `!document.querySelector('.es-startup') && !!document.querySelector('.hall-root') && typeof window.__aimLaunchWorkshop==='function' && typeof window.__aimLeaveTraining==='function' && !document.querySelector('.al-aimlab-root')`;
async function waitLobby(ms = 60000) {
  const ok = await waitFor(LOBBY_READY, ms, "lobby ready");
  if (ok) await ev(HOOKS);
  return !!ok;
}
async function reload() {
  await send("Page.reload", { ignoreCache: false });
  await sleep(1500);
  return waitLobby(90000);
}
async function viewport() {
  try { await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }); } catch {}
  return ev(`[innerWidth,innerHeight,devicePixelRatio]`);
}
// Launch via the hook, handle the rank picker (one retry), wait for 'aim-local-scene'.
async function launch(code, pick = "gold") {
  const before = await ev(`window.__g3.scene`);
  const r = { code, hook: await ev(`window.__aimLaunchWorkshop(${JSON.stringify(code)})`), picker: false, sceneEvent: false };
  for (let attempt = 0; attempt < 2 && r.hook; attempt++) {
    const st = await waitFor(`document.querySelector('.aim-pick-shade .aim-pick')?'picker':(window.__g3.scene>${before}?'scene':(document.querySelector('.al-aimlab-root')?'root':null))`, 15000, "picker or scene");
    if (st === "picker") {
      r.picker = true;
      await sleep(300);
      const ok = (await clickSel(`.aim-pick-tile[data-pick=${pick}]`)) || (await clickSel(`.aim-pick-tile[data-pick=default]`));
      r.pickClicked = ok;
    }
    const s = await waitFor(`window.__g3.scene>${before}||!!document.querySelector('.al-aimlab-root')`, 20000, "scene or drill root");
    if (s) break;
    // the picker can drop a launch: retry once when nothing is open
    if (attempt === 0 && !(await ev(`!!document.querySelector('.al-aimlab-root')`))) {
      r.retried = true;
      r.hook2 = await ev(`window.__aimLaunchWorkshop(${JSON.stringify(code)})`);
      if (!r.hook2) break;
    } else break;
  }
  r.root = await ev(`!!document.querySelector('.al-aimlab-root')`);
  r.before = before;
  return r;
}
// 'aim-local-scene' fired since launch() (it may fire only once the scene has loaded).
async function sceneFired(r) {
  r.sceneEvent = (await ev(`window.__g3.scene`)) > r.before;
  return r.sceneEvent;
}
const READY = `(()=>{const vis=s=>{const e=document.querySelector(s);if(!e)return false;const r=e.getBoundingClientRect();const cs=getComputedStyle(e);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'&&cs.opacity!=='0'};const loading=vis('.al-wkload-stage')||!!document.querySelector('section.al-wkload.is-loading');if(loading)return null;if(vis('.al-scene-start-cue'))return 'cue';if(vis('.al-aimlab-root .al-primary-btn'))return 'btn';return null})()`;
async function waitReady(ms = 150000) { return waitFor(READY, ms, "drill ready"); }
// Start the drill (after the loading overlay is gone) and confirm phase running.
async function startDrill() {
  const vp = await ev(`[innerWidth,innerHeight]`);
  for (let i = 0; i < 3; i++) {
    const n = await ev(`window.__g3.ph.length`);
    const mode = await ev(READY);
    if (mode === "btn") await clickSel(".al-aimlab-root .al-primary-btn");
    else if (i === 1) await key("Enter");
    else await clickAt(vp[0] / 2, vp[1] / 2);
    const ok = await waitFor(`window.__g3.ph.slice(${n}).includes('running')`, 5000, "phase running");
    if (ok) return { started: true, tries: i + 1, lock: await ev(`document.pointerLockElement&&document.pointerLockElement.tagName`) };
  }
  return { started: false };
}

async function leave() {
  const r = await ev(`window.__aimLeaveTraining()`);
  const back = await waitFor(`!document.querySelector('.al-aimlab-root') && !!document.querySelector('.hall-topnav')`, 30000, "back in lobby");
  return { leaveReturned: r, lobby: !!back };
}
function takeErrors(label) {
  const e = errs.splice(0);
  if (e.length) RESULT.errors.push({ during: label, list: e });
  return e;
}
async function finish(body) {
  try {
    await connect();
    await body();
  } catch (e) {
    RESULT.fatal = (e instanceof Bail ? "BAIL: " : "") + (e.stack || e.message || String(e)).slice(0, 600);
    log("FATAL", RESULT.fatal);
    if (sessionAlive) await shot("zz-fatal");
  } finally {
    takeErrors("end");
    RESULT.elapsed = elapsed();
    try { writeFileSync(`${OUT}/result.json`, JSON.stringify(RESULT, null, 2)); } catch {}
    console.log("RESULT_JSON " + JSON.stringify(RESULT));
    try { ws && ws.close(); } catch {}
    setTimeout(() => process.exit(0), 200);
  }
}

// ---------------- W2-E1 checks ----------------
const MICRO = "d43f842fb33e4d46"; // Micro tiles: ball/target drill, no rank picker
const JIGGLE = "1ee402b08e6fe47b"; // jiggle peek duels: bot drill
// HUD + pause DOM state. Rect = [x, y, w, h].
const HUD = `(()=>{const q=s=>document.querySelector(s);const R=e=>{if(!e)return null;const r=e.getBoundingClientRect();return [r.x|0,r.y|0,r.width|0,r.height|0]};
const a=c=>{const m=/rgba?\\(([^)]+)\\)/.exec(c||'');if(!m)return null;const p=m[1].split(',').map(Number);return p.length>3?p[3]:1};
const top=q('.al-hud-top'),b=q('.al-hud-chip b'),sp=q('.al-hud-chip span'),hud=q('.al-hud'),ov=q('.al-pause-layer'),card=q('.al-pause-id')||q('.al-pause-lite-body');
const ts=top&&getComputedStyle(top),hs=hud&&getComputedStyle(hud);const os=ov&&getComputedStyle(ov);
const tr=top&&top.getBoundingClientRect(),cr=card&&card.getBoundingClientRect();
const mm=q('.al-minimap, [class*=minimap]');const cx=innerWidth/2,cy=innerHeight/2;
return {vp:[innerWidth,innerHeight],paused:!!q('.al-stage-wrap.is-paused'),roundOn:document.documentElement.classList.contains('aim-round-on'),
chips:[...document.querySelectorAll('.al-hud-chip')].map(c=>c.innerText.replace(/\\s+/g,' ').trim()),
valuePx:b?parseFloat(getComputedStyle(b).fontSize):null,valueNum:b?getComputedStyle(b).fontVariantNumeric:null,labelPx:sp?parseFloat(getComputedStyle(sp).fontSize):null,
top:top?{display:ts.display,visibility:ts.visibility,rect:R(top)}:null,hudZ:hs&&hs.zIndex,
coversCenter:!!tr&&tr.left<=cx&&tr.right>=cx&&tr.top<=cy&&tr.bottom>=cy,
minimap:mm?R(mm):null,coversMinimap:!!(tr&&mm&&(()=>{const m=mm.getBoundingClientRect();return m.width>0&&tr.left<m.right&&m.left<tr.right&&tr.top<m.bottom&&m.top<tr.bottom})()),
layer:ov?{cls:ov.className,bg:os.backgroundColor,bgImage:os.backgroundImage.slice(0,80),alpha:a(os.backgroundColor)}:null,
card:card?{cls:card.className,rect:R(card)}:null,topAboveCard:!!(tr&&cr)&&tr.bottom<=cr.top,
meta:(q('.al-pause-meta')||{}).innerText||null,menuText:ov?ov.innerText.replace(/\\s+/g,' ').slice(0,300):null,roundHud:!!q('#aim-round-hud:not([hidden])')}})()`;
// Loading overlay sample: shell stage text + any % shown by the workshop loader.
const LOAD = `(()=>{const s=document.querySelector('.aim-loading-stage');const w=document.querySelector('.al-wkload');const t=w?w.innerText:'';const m=t.match(/(\\d+(?:\\.\\d+)?)\\s*%/);
return {stage:s?s.textContent:null,step:s?s.dataset.step:null,pct:m?Number(m[1]):null,dots:[...document.querySelectorAll('.aim-loading-track i')].map(i=>i.className||'-').join(',')}})()`;

async function tabKey() {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
}
// Sample the loading overlay every 250 ms until the drill is ready; screenshot the first weapon
// label and again ~1 s later.
async function sampleLoading(prefix, ms = 150000) {
  const samples = [];
  let firstWeaponAt = null, shot2 = false;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkBudget("loading " + prefix);
    let s = null;
    try { s = await ev(LOAD); } catch {}
    const ready = await ev(READY).catch(() => null);
    if (s) {
      const t = Date.now() - T0;
      const prev = samples[samples.length - 1];
      if (!prev || prev.stage !== s.stage || prev.pct !== s.pct) samples.push({ t, ...s });
      if (s.stage && /weapon \d+\/\d+/.test(s.stage)) {
        if (firstWeaponAt === null) { firstWeaponAt = t; await shot(prefix + "-loading-weapon-1"); }
        else if (!shot2 && t - firstWeaponAt >= 1000) { shot2 = true; await shot(prefix + "-loading-weapon-2"); }
      }
    }
    if (ready) break;
    await sleep(250);
  }
  // time spent on each stage label (weapon labels folded into one)
  const per = {};
  for (let i = 0; i < samples.length; i++) {
    const k = (samples[i].stage || "(none)").replace(/weapon \d+\/(\d+)/, "weapon i/$1");
    const next = samples[i + 1] ? samples[i + 1].t : Date.now() - T0;
    per[k] = (per[k] || 0) + (next - samples[i].t);
  }
  return { samples: samples.slice(0, 80), msPerStage: per, firstWeaponAt };
}
async function pausedCheck(prefix) {
  const run = await ev(HUD);
  await shot(prefix + "-hud");
  await tabKey();
  await waitFor(`!!document.querySelector('.al-stage-wrap.is-paused')||!!document.querySelector('.al-pause-layer')`, 5000, "pause");
  await sleep(700); // card entrance animation
  const paused = await ev(HUD);
  await shot(prefix + "-tab");
  return { running: run, paused };
}
async function drill(prefix, code, { loading = true, big = false } = {}) {
  const D = (RESULT.checks[prefix] = {});
  D.launch = await launch(code);
  if (loading) D.loading = await sampleLoading(prefix);
  D.ready = await waitReady(150000);
  if (!D.ready) { await shot(prefix + "-not-ready"); return D; }
  D.start = await startDrill();
  await sleep(2500);
  if (big) {
    // In-drill HUD at 2560x1440 first (Tab while paused only opens the menu, it never resumes).
    try {
      await send("Emulation.setDeviceMetricsOverride", { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false });
      await sleep(1500);
      D.big = await ev(HUD);
      await shot(prefix + "-hud-2560");
    } finally { await viewport(); await sleep(1500); }
  }
  Object.assign(D, await pausedCheck(prefix));
  if (!D.paused?.paused) RESULT.notes.push(prefix + ": Tab did not pause the drill (pointer lock: " + (D.start && D.start.lock) + ")");
  takeErrors(prefix);
  D.leave = await leave();
  return D;
}
async function round() {
  const D = (RESULT.checks.round = {});
  const b = await clickText("Round \\(beta\\)", "button");
  D.button = b && b.t;
  D.panel = !!(await waitFor(`!!document.querySelector('.aim-round')`, 8000, "round panel"));
  if (!D.panel) { await shot("round-no-panel"); return D; }
  for (const sel of [`.aim-round [data-pick="default"]`]) await clickSel(sel);
  await clickSel(".aim-round-start");
  D.loaded = !!(await waitFor(`window.__aimRoundOn && window.__aimRound && window.__aimRound.tick>=0`, 150000, "round state"));
  await sleep(2000);
  const vp = await ev(`[innerWidth,innerHeight]`);
  await clickAt(vp[0] / 2, vp[1] / 2); // pointer lock / start
  await sleep(2500);
  Object.assign(D, await pausedCheck("round"));
  takeErrors("round");
  D.leave = await leave();
  return D;
}

await finish(async () => {
  log("waiting for lobby");
  if (!(await waitLobby(150000))) throw new Error("lobby never ready");
  await ev(`(()=>{localStorage.setItem('aim-valorant-import-hide-startup-v1','1');return 1})()`);
  RESULT.viewport = await viewport();
  log("viewport", RESULT.viewport);
  await sleep(2000);
  takeErrors("boot");
  await drill("ball", MICRO, { loading: true });
  log("ball", JSON.stringify(RESULT.checks.ball.paused || {}).slice(0, 300));
  await drill("bot", JIGGLE, { loading: true, big: true });
  log("bot", JSON.stringify(RESULT.checks.bot.paused || {}).slice(0, 300));
  if (left() > 150000) await round();
  else RESULT.notes.push("round check skipped: time budget");
  // summary
  const S = (RESULT.summary = {});
  for (const k of ["ball", "bot", "round"]) {
    const p = RESULT.checks[k]?.paused;
    if (!p) continue;
    S[k] = { paused: p.paused, valuePx: p.valuePx, labelPx: p.labelPx, topDisplay: p.top && p.top.display, topAboveCard: p.topAboveCard, overlayAlpha: p.layer && p.layer.alpha, layer: p.layer && p.layer.cls, coversCenter: RESULT.checks[k].running?.coversCenter, coversMinimap: RESULT.checks[k].running?.coversMinimap, meta: p.meta };
  }
  S.big = RESULT.checks.bot?.big && { vp: RESULT.checks.bot.big.vp, valuePx: RESULT.checks.bot.big.valuePx, top: RESULT.checks.bot.big.top, coversCenter: RESULT.checks.bot.big.coversCenter, coversMinimap: RESULT.checks.bot.big.coversMinimap };
});
