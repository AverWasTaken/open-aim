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
let ws, send, sessionAlive = false;
async function connect() {
  if (ws) { const old = ws; ws = null; try { old.close(); } catch {} }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === "page" && !x.url.startsWith("devtools"));
  if (!t) throw new Error("no page target");
  const sock = new WebSocket(t.webSocketDebuggerUrl);
  ws = sock;
  await new Promise((ok, bad) => { sock.onopen = ok; sock.onerror = bad; });
  sessionAlive = true;
  let id = 0;
  const pending = new Map();
  // Handlers of a replaced socket must not touch the current session.
  sock.onclose = () => { if (ws === sock) sessionAlive = false; for (const { bad } of pending.values()) bad(new Error("CDP connection closed")); pending.clear(); };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
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
    if (!sessionAlive || ws !== sock) return bad(new Error("CDP connection closed"));
    const i = ++id;
    pending.set(i, { ok, bad });
    sock.send(JSON.stringify({ id: i, method, params }));
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
// A drill is open when its root is on screen (the node can stay mounted but hidden in the lobby).
const ROOT_OPEN = `(()=>{const e=document.querySelector('.al-aimlab-root');if(!e)return false;const r=e.getBoundingClientRect();const cs=getComputedStyle(e);return r.width>0&&r.height>0&&cs.display!=='none'&&cs.visibility!=='hidden'})()`;
const LOBBY_PARTS = `({noStartup:!document.querySelector('.es-startup'),hallRoot:!!document.querySelector('.hall-root'),launchHook:typeof window.__aimLaunchWorkshop==='function',leaveHook:typeof window.__aimLeaveTraining==='function',noDrill:!(${ROOT_OPEN}),rootInDom:!!document.querySelector('.al-aimlab-root'),result:!!document.querySelector('.al-result-overlay'),url:location.href.slice(0,120)})`;
const LOBBY_READY = `(()=>{const p=${LOBBY_PARTS};return p.noStartup&&p.hallRoot&&p.launchHook&&p.leaveHook&&p.noDrill})()`;
async function waitLobby(ms = 60000) {
  // A drill or result card left open by an earlier check in the same session: close it first.
  try {
    if (await ev(`typeof window.__aimLeaveTraining==='function' && (${ROOT_OPEN})`)) {
      RESULT.notes.push("a drill was still open at start: left it");
      await ev(`window.__aimLeaveTraining()`);
      await sleep(1500);
    }
  } catch (e) { if (!sessionAlive) throw e; }
  const ok = await waitFor(LOBBY_READY, ms, "lobby ready");
  if (ok) await ev(HOOKS);
  else { try { RESULT.lobbyParts = await ev(LOBBY_PARTS); log("lobby parts", JSON.stringify(RESULT.lobbyParts)); } catch {} }
  return !!ok;
}
async function viewport() {
  try { await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }); } catch {}
  return ev(`[innerWidth,innerHeight,devicePixelRatio]`);
}
// Launch via the hook, handle the rank picker (one retry), wait for 'aim-local-scene'.
async function launch(code, pick = "gold") {
  const before = await ev(`window.__g3.scene`);
  const r = { code, hook: await ev(`(window.__aimLaunchByCode?window.__aimLaunchByCode(${JSON.stringify(code)}):window.__aimLaunchWorkshop(${JSON.stringify(code)}))`), picker: false, sceneEvent: false };
  for (let attempt = 0; attempt < 2 && r.hook; attempt++) {
    const st = await waitFor(`document.querySelector('.aim-pick-shade .aim-pick')?'picker':(window.__g3.scene>${before}?'scene':((${ROOT_OPEN})?'root':null))`, 15000, "picker or scene");
    if (st === "picker") {
      r.picker = true;
      await sleep(300);
      const ok = (await clickSel(`.aim-pick-tile[data-pick=${pick}]`)) || (await clickSel(`.aim-pick-tile[data-pick=default]`));
      r.pickClicked = ok;
    }
    const s = await waitFor(`window.__g3.scene>${before}||(${ROOT_OPEN})`, 20000, "scene or drill root");
    if (s) break;
    // the picker can drop a launch: retry once when nothing is open
    if (attempt === 0 && !(await ev(`(${ROOT_OPEN})`))) {
      r.retried = true;
      r.hook2 = await ev(`(window.__aimLaunchByCode?window.__aimLaunchByCode(${JSON.stringify(code)}):window.__aimLaunchWorkshop(${JSON.stringify(code)}))`);
      if (!r.hook2) break;
    } else break;
  }
  r.root = await ev(`(${ROOT_OPEN})`);
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
  const back = await waitFor(`!(${ROOT_OPEN}) && !!document.querySelector('.hall-topnav')`, 30000, "back in lobby");
  return { leaveReturned: r, lobby: !!back };
}
function takeErrors(label) {
  const e = errs.splice(0);
  if (e.length) RESULT.errors.push({ during: label, list: e });
  return e;
}
async function finish(body) {
  try {
    await body();
  } catch (e) {
    RESULT.fatal = (e instanceof Bail ? "BAIL: " : "") + (e.stack || e.message || String(e)).slice(0, 600);
    log("FATAL", RESULT.fatal);
    if (sessionAlive) await shot("zz-fatal");
  } finally {
    takeErrors("end");
    try { summarize(); } catch (e) { RESULT.notes.push("summary failed: " + e.message); }
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
const tr=top&&top.getBoundingClientRect(),cr=card&&card.getBoundingClientRect();const chipR=[...document.querySelectorAll('.al-hud-top .al-hud-chip')].map(c=>c.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0);const cb=chipR.length?Math.round(Math.max(...chipR.map(r=>r.bottom))):null;
const mm=q('.al-minimap, [class*=minimap]');const cx=innerWidth/2,cy=innerHeight/2;
return {vp:[innerWidth,innerHeight],paused:!!q('.al-stage-wrap.is-paused'),roundOn:document.documentElement.classList.contains('aim-round-on'),
chips:[...document.querySelectorAll('.al-hud-chip')].map(c=>c.innerText.replace(/\\s+/g,' ').trim()),
valuePx:b?parseFloat(getComputedStyle(b).fontSize):null,valueNum:b?getComputedStyle(b).fontVariantNumeric:null,labelPx:sp?parseFloat(getComputedStyle(sp).fontSize):null,
top:top?{display:ts.display,visibility:ts.visibility,rect:R(top)}:null,hudZ:hs&&hs.zIndex,
coversCenter:!!tr&&tr.left<=cx&&tr.right>=cx&&tr.top<=cy&&tr.bottom>=cy,
minimap:mm?R(mm):null,coversMinimap:!!(tr&&mm&&(()=>{const m=mm.getBoundingClientRect();return m.width>0&&tr.left<m.right&&m.left<tr.right&&tr.top<m.bottom&&m.top<tr.bottom})()),
layer:ov?{cls:ov.className,bg:os.backgroundColor,bgImage:os.backgroundImage.slice(0,80),alpha:a(os.backgroundColor)}:null,
card:card?{cls:card.className,rect:R(card)}:null,chipsBottom:cb,topBottom:tr?Math.round(tr.bottom):null,topAboveCard:cb===null?null:(!!cr&&cb<=cr.top),
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
  const PAUSED = `!!document.querySelector('.al-stage-wrap.is-paused')||!!document.querySelector('.al-pause-layer')`;
  if (!(await waitFor(PAUSED, 5000, "pause"))) {
    // A Tab right after a viewport change can be dropped: one more try.
    RESULT.notes.push(prefix + ": first Tab did not pause, pressed it again");
    await tabKey();
    await waitFor(PAUSED, 5000, "pause (2nd Tab)");
  }
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
    } finally { try { await viewport(); } catch {} await sleep(1500); }
    // The resize can drop key focus (Tab then does nothing): one click in the drill restores it.
    try { const vp = await ev(`[innerWidth,innerHeight]`); await clickAt(vp[0] / 2, vp[1] / 2); } catch {}
    await sleep(800);
  }
  Object.assign(D, await pausedCheck(prefix));
  if (!D.paused?.paused) RESULT.notes.push(prefix + ": Tab did not pause the drill (pointer lock: " + (D.start && D.start.lock) + ")");
  takeErrors(prefix);
  D.leave = await leave();
  return D;
}
// Round mode: open the Round panel, Start (it launches through __aimLaunchScene), then the same
// loading / start path as a drill. Records why it stopped when the round never opens.
const ROUND_STATE = `({panel:!!document.querySelector('.aim-round'),note:(document.querySelector('.aim-round-note')||{}).textContent||null,root:(${ROOT_OPEN}),rootInDom:!!document.querySelector('.al-aimlab-root'),loading:!!document.querySelector('section.al-wkload.is-loading'),roundOn:!!window.__aimRoundOn,round:window.__aimRound?{tick:window.__aimRound.tick,done:!!window.__aimRound.done}:null,phases:(window.__g3&&window.__g3.ph||[]).slice(-6),launchScene:typeof window.__aimLaunchScene})`;
// Ready, or the drill closed again (Round on a cold map drops back to the lobby at ~94%: round-
// panel.js launches with mapId:null, BOARD maps 23:22). 'gone' = back in the lobby.
const READY_OR_GONE = `(()=>{const r=${READY};if(r)return r;return (!(${ROOT_OPEN})&&!!document.querySelector('.hall-topnav'))?'gone':null})()`;
async function roundAttempt(D, n) {
  const A = { n };
  const before = await ev(`window.__g3.scene`);
  const b = await clickText("^Round( \\(beta\\))?$", "button"); // round-r5 renames it to "Round"
  D.button = b && b.t;
  A.panel = !!(await waitFor(`!!document.querySelector('.aim-round')`, 8000, "round panel"));
  if (!A.panel) { await shot("round-no-panel-" + n); return A; }
  await clickSel(`.aim-round [data-pick="default"]`);
  A.startClicked = await clickSel(".aim-round-start");
  await sleep(1500);
  A.afterStart = await ev(ROUND_STATE);
  await shot("round-after-start-" + n);
  // The panel waits up to 5 s for the map data on a cold cache, then launches by itself.
  A.open = !!(await waitFor(`(${ROOT_OPEN})||window.__g3.scene>${before}`, 20000, "round drill open"));
  if (!A.open) { A.state = await ev(ROUND_STATE); await shot("round-not-open-" + n); return A; }
  A.ready = await waitFor(READY_OR_GONE, 150000, "round ready");
  // 'gone' must hold on a second look (a scene swap can hide the root for a moment).
  if (A.ready === "gone") { await sleep(1500); const again = await ev(READY_OR_GONE); if (again !== "gone") A.ready = again || (await waitFor(READY_OR_GONE, 150000, "round ready")); }
  if (A.ready !== "cue" && A.ready !== "btn") { A.state = await ev(ROUND_STATE); await shot("round-not-ready-" + n); }
  return A;
}
async function round() {
  const D = (RESULT.checks.round = { attempts: [] });
  let A = await roundAttempt(D, 1);
  D.attempts.push(A);
  if (A.ready === "gone") {
    RESULT.notes.push("round: attempt 1 went back to the lobby while loading (cold map, known round bug); retried");
    await sleep(2000);
    A = await roundAttempt(D, 2);
    D.attempts.push(A);
  }
  D.ready = A.ready === "cue" || A.ready === "btn";
  if (!D.ready) return D;
  D.start = await startDrill();
  await sleep(2500);
  D.state = await ev(ROUND_STATE);
  D.loaded = D.state.roundOn;
  Object.assign(D, await pausedCheck("round"));
  takeErrors("round");
  D.leave = await leave();
  return D;
}

await finish(async () => {
  log("waiting for lobby");
  // The page can reload/navigate while the app boots (start screen -> lobby): reconnect.
  let lobby = false;
  for (let i = 0; i < 10 && !lobby; i++) {
    checkBudget("connect");
    try {
      if (!sessionAlive) { if (i) await sleep(3000); await connect(); log(i ? "reconnected" : "connected"); }
      lobby = await waitLobby(150000);
      if (!lobby) break;
    } catch (e) {
      if (e instanceof Bail) throw e;
      log("lobby wait:", e.message);
      if (ws && ws.readyState !== 1) sessionAlive = false; // only reconnect when the socket is really gone
      if (!ws) sessionAlive = false;
    }
  }
  if (!lobby) throw new Error("lobby never ready");
  await ev(`(()=>{localStorage.setItem('aim-valorant-import-hide-startup-v1','1');localStorage.setItem('ux-welcome-v1','done');return 1})()`);
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
});

function summarize() {
  const S = (RESULT.summary = {});
  for (const k of ["ball", "bot", "round"]) {
    const p = RESULT.checks[k]?.paused;
    if (!p) continue;
    S[k] = { paused: p.paused, valuePx: p.valuePx, labelPx: p.labelPx, topDisplay: p.top && p.top.display, topAboveCard: p.topAboveCard, chipsBottom: p.chipsBottom, topBottom: p.topBottom, cardTop: p.card && p.card.rect && p.card.rect[1], overlayAlpha: p.layer && p.layer.alpha, layer: p.layer && p.layer.cls, coversCenter: RESULT.checks[k].running?.coversCenter, coversMinimap: RESULT.checks[k].running?.coversMinimap, meta: p.meta, roundOn: p.roundOn, roundHud: p.roundHud };
  }
  S.big = RESULT.checks.bot?.big && { vp: RESULT.checks.bot.big.vp, valuePx: RESULT.checks.bot.big.valuePx, top: RESULT.checks.bot.big.top, coversCenter: RESULT.checks.bot.big.coversCenter, coversMinimap: RESULT.checks.bot.big.coversMinimap };
  S.loading = { ball: RESULT.checks.ball?.loading?.msPerStage, bot: RESULT.checks.bot?.loading?.msPerStage };
}
