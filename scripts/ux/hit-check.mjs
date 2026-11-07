// App check for the hit marker and kills line (app/ux-hud.js, tools/ux_hud_patch.py).
// Runs on hp against a hidden copy: hp.sh cdp-script <CDP> scripts/ux/hit-check.mjs [outDir]
// Node built-ins only. Prints one JSON line per step and a final summary; screenshots go to outDir.
// Order (one app start): settings switch off -> ball drill (switch off = no marker, then on;
// dot hits; no kills line) -> result -> Watch replay plays with no aim-hit -> bot drill (synthetic
// marker, real shots with head/kill flags, kills line, hidden when paused).
import fs from 'node:fs';
import path from 'node:path';

const [port = '9438', outDir = '/tmp/ux-hit-check'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const BALL = 'd43f842fb33e4d46'; // Micro tiles (spheres, 60 s)
const BOT = '406d6e47ebc89bc3'; // Head-level micro (humanoids, 60 s)
const DEADLINE = Date.now() + 9 * 60 * 1000;
const results = {};
const log = (step, data) => { results[step] = data; console.log(JSON.stringify({ step, ...data })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(`eval: ${m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text}`);
  return m.result?.result?.value;
}
async function shot(name) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
  return file;
}
async function waitFor(expr, ms, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (Date.now() > DEADLINE) throw new Error('deadline');
    try { if (await ev(expr)) return true; } catch {}
    await sleep(every);
  }
  return false;
}
async function enter() {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
let W = 1280, H = 720;
async function click(x = W / 2, y = H / 2) {
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const HOOKS = `(()=>{if(window.__hc)return 'had';window.__hc={phases:[],hits:[],huds:[],freeze:false,frozen:false};
addEventListener('aim-round-phase',e=>__hc.phases.push(e.detail.phase));
addEventListener('aim-hit',e=>{__hc.hits.push({...e.detail,phase:__hc.phases.at(-1)});
 if(__hc.freeze)requestAnimationFrame(()=>requestAnimationFrame(()=>{const m=document.querySelector('.ux-hitmarker'),a=m&&m.getAnimations()[0];if(a){a.pause();a.currentTime=40;__hc.frozen=true;__hc.freeze=false}}))});
addEventListener('aim-hud',e=>{__hc.huds.push(e.detail);if(__hc.huds.length>100)__hc.huds.shift()});
const o=window.__aimTick;window.__aimTick=s=>{__hc.state=s;return o?o(s):undefined};return 'installed'})()`;
const MARKER = `(()=>{const m=document.querySelector('.ux-hitmarker');if(!m)return null;const r=m.getBoundingClientRect(),c=document.querySelector('.al-center-crosshair')?.getBoundingClientRect();
 return {cls:m.className,inWrap:m.parentElement===document.querySelector('.al-center-crosshair')?.parentElement,anims:m.getAnimations().length,opacity:getComputedStyle(m).opacity,
 color:getComputedStyle(m).color,at:[Math.round(r.left),Math.round(r.top)],cross:c?[Math.round(c.left),Math.round(c.top)]:null}})()`;
const KILLS = `(()=>{const k=document.querySelector('.ux-hud-kills');const chip=document.querySelector('.al-hud-top .al-hud-chip')?.getBoundingClientRect();
 return k?{text:k.textContent,hidden:k.hidden,display:getComputedStyle(k).display,top:k.style.top,lineTop:Math.round(k.getBoundingClientRect().top),chipBottom:chip?Math.round(chip.bottom):null}:null})()`;
const UNFREEZE = `(()=>{__hc.freeze=false;__hc.frozen=false;document.querySelector('.ux-hitmarker')?.getAnimations().forEach(a=>a.cancel());return 1})()`;
const SYNTH = (d) => `(async()=>{__hc.freeze=true;__hc.frozen=false;dispatchEvent(new CustomEvent('aim-hit',{detail:${JSON.stringify({ pellets: 1, tick: -1, ...d })}}));
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));return ${MARKER}})()`;
// Turns the view onto the nearest live actor (head height for bots, centre for balls) with
// synthetic mouse moves (the stand-in pointer lock takes them), two correction passes.
const AIM = (head) => `(async()=>{const sens=parseFloat(localStorage.getItem('al-sensitivity-v1'))||0.5,k=0.07*Math.PI/180*sens;
 const move=(dx,dy)=>document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,movementX:dx,movementY:dy}));
 const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));let last=null;
 move(1,0);await new Promise(r=>setTimeout(r,120));
 for(let pass=0;pass<3;pass++){const s=__hc.state;if(!s)return 'nostate';const p=s.player,eye={x:p.position.x,y:p.position.y+1.75,z:p.position.z};
  const live=s.actors.filter(a=>a.alive&&a.visible!==false);if(!live.length)return 'noactor';
  const pos=a=>({x:a.position.x+(a.offset?.x||0),y:a.position.y+(a.offset?.y||0)+(${head ? 1.65 : 0}),z:a.position.z+(a.offset?.z||0)});
  const ang=a=>{const t=pos(a),dx=t.x-eye.x,dy=t.y-eye.y,dz=t.z-eye.z;return {yaw:Math.atan2(-dx,-dz),pitch:Math.atan2(dy,Math.hypot(dx,dz))}};
  const best=live.map(a=>({a,g:ang(a)})).sort((u,v)=>Math.abs(wrap(u.g.yaw-p.yaw))+Math.abs(u.g.pitch-p.pitch)-Math.abs(wrap(v.g.yaw-p.yaw))-Math.abs(v.g.pitch-p.pitch))[0];
  const mx=Math.round(-wrap(best.g.yaw-p.yaw)/k),my=Math.round(-(best.g.pitch-p.pitch)/k);last={id:best.a.id,mx,my};
  if(Math.abs(mx)+Math.abs(my)<1)break;move(mx,my);await new Promise(r=>setTimeout(r,200))}
 return last})()`;

async function startDrill(code, tag) {
  const ok = await ev(`window.__aimLaunchScene({shareCode:${JSON.stringify(code)}})`);
  const ready = await waitFor(`(()=>{const v=s=>{const e=document.querySelector(s);return !!e&&e.getClientRects().length>0};return v('.al-aimlab-root .al-primary-btn')||v('.al-scene-start-cue')})()`, 150000, 2000);
  let running = false;
  for (let i = 0; i < 3 && ready && !running; i++) {
    await enter();
    running = await waitFor(`__hc.phases.at(-1)==='running'&&!!document.pointerLockElement`, 6000, 500);
  }
  log(`${tag}-start`, { launched: ok, ready, running });
  return running;
}
async function toLobby() {
  await ev(`(()=>{const b=document.querySelector('.al-pause-act.is-exit')||document.querySelector('.al-result-overlay .al-secondary-btn')||document.querySelector('.hall-train-exit');b&&b.click();return !!b})()`);
  return waitFor(`!document.querySelector('.al-aimlab-root')&&!!document.querySelector('.hall-topnav')`, 30000);
}
async function realShots(tag, n, head) {
  const before = await ev('__hc.hits.length');
  const tries = [];
  await ev(`(__hc.freeze=true,__hc.frozen=false,1)`);
  let frozenShot = null;
  for (let i = 0; i < n; i++) {
    const aim = await ev(AIM(head));
    await click();
    await sleep(500);
    tries.push(aim);
    if (!frozenShot && await ev('__hc.frozen')) {
      results[`${tag}-marker-real`] = await ev(MARKER);
      frozenShot = await shot(`${tag}-marker-real`);
      await ev(UNFREEZE);
    }
  }
  await ev(UNFREEZE);
  const hits = await ev(`__hc.hits.slice(${before})`);
  log(`${tag}-real-shots`, { tries, hits, screenshot: frozenShot });
  return hits;
}

try {
  const vp = await ev('[innerWidth,innerHeight]');
  [W, H] = vp;
  const lobby = await waitFor(`!document.querySelector('.es-startup')&&!!document.querySelector('.hall-root')&&typeof window.__aimLaunchScene==='function'`, 120000, 2000);
  await ev(`(localStorage.setItem('aim-valorant-import-hide-startup-v1','1'),document.querySelector('.es-tool-shade .es-tool-x')?.click(),1)`);
  log('boot', { lobby, viewport: vp, hooks: await ev(HOOKS), uxHud: await ev('typeof window.__aimUxHud?.killsText') });

  // (e) Settings switch.
  await ev(`(()=>{[...document.querySelectorAll('.hall-tab')].find(t=>/Settings/i.test(t.textContent))?.click();return 1})()`);
  await waitFor(`!!document.querySelector('.st-tab[data-tab=range]')`, 15000, 500);
  await ev(`(document.querySelector('.st-tab[data-tab=range]')?.click(),1)`);
  const rowOk = await waitFor(`!!document.querySelector('[data-setting="uxHitMarker"]')`, 15000, 500);
  await ev(`(document.querySelector('[data-setting="uxHitMarker"]')?.scrollIntoView({block:'center'}),1)`);
  await sleep(400);
  const rowOn = await ev(`(()=>{const r=document.querySelector('[data-setting="uxHitMarker"]');return r&&{on:r.classList.contains('is-on'),checked:r.querySelector('input').checked,prev:r.previousElementSibling?.dataset.setting,text:r.innerText}})()`);
  const rowShot = await shot('settings-row-on');
  await ev(`(document.querySelector('[data-setting="uxHitMarker"] input')?.click(),1)`);
  await sleep(300);
  const rowOff = await ev(`(()=>{const r=document.querySelector('[data-setting="uxHitMarker"]');return r&&{on:r.classList.contains('is-on'),checked:r.querySelector('input').checked,stored:localStorage.getItem('aim-ux-hitmarker')}})()`);
  log('settings', { rowOk, rowOn, rowOff, screenshots: [rowShot, await shot('settings-row-off')] });

  // Ball drill.
  if (await startDrill(BALL, 'ball')) {
    const offSynth = await ev(SYNTH({ head: false, kill: false, dot: false }));
    await ev(UNFREEZE);
    await ev(`(window.__aimUxHud.setMarker(true),1)`);
    log('ball-switch-off', { marker: offSynth, stored: await ev(`localStorage.getItem('aim-ux-hitmarker')`) });
    const hits = await realShots('ball', 5, false);
    log('ball-kills-line', { kills: await ev(KILLS), lastHud: await ev('__hc.huds.at(-1)'), screenshot: await shot('ball-running') });
    log('ball-dot', { allDot: hits.length > 0 && hits.every((h) => h.dot), n: hits.length });
    const ended = await waitFor(`__hc.phases.at(-1)==='result'`, 80000, 2000);
    await sleep(1500);
    const watch = await ev(`(()=>{const b=document.querySelector('.al-replay-watch-btn');b&&b.click();return !!b})()`);
    const player = watch && await waitFor(`!!document.querySelector('.al-replay-library-modal.is-player')`, 20000, 500);
    const hitsBefore = await ev('__hc.hits.length');
    await ev(`(document.querySelector('.al-replay-play')?.click(),1)`);
    const scrub0 = await ev(`+(document.querySelector('.al-replay-scrub')?.value??-1)`);
    await sleep(8000);
    const scrub1 = await ev(`+(document.querySelector('.al-replay-scrub')?.value??-1)`);
    const hitsAfter = await ev('__hc.hits.length');
    log('replay', { ended, watch, player, scrub: [scrub0, scrub1], aimHitDuringReplay: hitsAfter - hitsBefore, screenshot: await shot('replay-playing') });
    await ev(`(document.querySelector('.al-rv-close')?.click(),1)`);
    await sleep(800);
  }
  log('ball-exit', { lobby: await toLobby() });

  // Bot drill.
  if (await startDrill(BOT, 'bot')) {
    const synth = await ev(SYNTH({ head: true, kill: true, dot: false }));
    log('bot-marker-synthetic', { marker: synth, screenshot: await shot('bot-marker-synthetic') });
    await ev(UNFREEZE);
    const body = await ev(SYNTH({ head: false, kill: false, dot: false }));
    log('bot-marker-body', { marker: body, screenshot: await shot('bot-marker-body') });
    await ev(UNFREEZE);
    const hits = await realShots('bot', 6, true);
    log('bot-flags', { n: hits.length, heads: hits.filter((h) => h.head).length, kills: hits.filter((h) => h.kill).length, dots: hits.filter((h) => h.dot).length });
    await sleep(600);
    log('bot-kills-line', { kills: await ev(KILLS), lastHud: await ev('__hc.huds.at(-1)'), screenshot: await shot('bot-kills-line') });
    await ev('document.exitPointerLock()');
    await waitFor(`__hc.phases.at(-1)==='paused'`, 8000, 500);
    await sleep(500);
    log('bot-paused', { kills: await ev(KILLS), screenshot: await shot('bot-paused') });
  }
  log('bot-exit', { lobby: await toLobby() });
} catch (err) {
  log('error', { message: String(err && err.stack || err) });
} finally {
  console.log(JSON.stringify({ step: 'summary', outDir, steps: Object.keys(results) }));
  ws.close();
}
