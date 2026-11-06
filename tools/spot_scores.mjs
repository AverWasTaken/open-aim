// Off-angle scores for the spots of every shipped drill that picks a random subset of its spots
// (rules.spawnerPick). Writes app/mods/aim-ranks/spot-scores.json, which the game reads at round
// start when an explicit enemy rank is picked (tools/spotbias_patch.py): low ranks then stand on
// common spots more often, high ranks on off-angles.
//
// The scores come from the game's own bot-order planner (hy in OkAdunfX.js: nav grid from the
// player spawn, line-of-sight rays), so this runs inside the app:
//
//   1. Start a test copy of the app with a debug port (any free ports; keep your real profile out):
//        AIM_PROFILE=<empty folder> AIM_PORT=8141 app/node_modules/.bin/electron app --remote-debugging-port=9351
//   2. node tools/spot_scores.mjs [--cdp 9351] [--plots <folder>] [--only <code>,<code>]
//
// --plots writes a top-down picture per drill (minimap, planned route, spots coloured by score).
//
// Score of a spot (planner run over the whole pool, the spot's "from" = where the route first sees
// it, eye = from + stand eye height):
//   0.45 * min(1, yaw angle between the walking direction at "from" and the spot / 120 deg)
//   0.15 * min(1, |pitch to the head| / 20 deg)          (high ground / low spots)
//   0.25 * clamp((12 m - distance) / 9 m, 0, 1)            (tight corners)
//   0.15 * (seen alone ? 1 : 0)                            (not part of a group seen together)
// The walking direction is the planned route looking back 1.5 m (the spawn facing before the
// first step). Scores become a percentile p in [0, 1] within the drill's pool (ties share their
// average rank). Spots the planner can't reach or never sees get 0.5 (no bias).
//
// Keys: aimSpotKey(doc) below, the same text as in OkAdunfX.js (tools/spotbias_patch.py), a hash
// of the map, the pool and every spawner's id and position. Editing a drill's spots changes the
// key, so stale scores are never applied. scripts/test-spot-bias.cjs checks that every shipped
// drill with a pool still has its entry.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const CDP = Number(arg("--cdp", "9351"));
const PLOTS = arg("--plots", null);
const ONLY = arg("--only", null)?.split(",") ?? null;
const OUT = path.join(ROOT, "app", "mods", "aim-ranks", "spot-scores.json");

// Same text as in OkAdunfX.js.
const KEY_SRC = 'function aimSpotKey(d){const r=n=>Math.round(n*100)/100,p=d?.rules?.spawnerPick;if(!p||!Array.isArray(p.pool)||!Array.isArray(d.spawners))return null;const s=JSON.stringify([d.environment?.map??null,p.pool,d.spawners.map(x=>[x.id,r(x.position.x),r(x.position.y),r(x.position.z)])]);let e=2166136261,h=2646966556;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);e=Math.imul(e^c,16777619),h=Math.imul(h^c,2246822507)}return(e>>>0).toString(16).padStart(8,"0")+(h>>>0).toString(16).padStart(8,"0")}';
const aimSpotKey = new Function(`${KEY_SRC};return aimSpotKey;`)();

// Shipped drills: the official scene files and the training set.
function drills() {
  const out = [];
  const docOf = (scene) => (typeof scene?.doc === "string" ? JSON.parse(scene.doc) : scene?.doc);
  const dir = path.join(ROOT, "site", "prod-api", "api", "v1", "public", "val", "aimlab", "scenes");
  for (const code of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const scene = JSON.parse(fs.readFileSync(path.join(dir, code), "utf-8")).data;
      out.push({ code, name: scene.name, doc: docOf(scene) });
    } catch {}
  }
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, "app", "training-set.json"), "utf-8"));
  for (const [code, scene] of Object.entries(set.scenes)) out.push({ code, name: scene.name, doc: docOf(scene) });
  return out.filter(({ doc }) => {
    const p = doc?.rules?.spawnerPick;
    return p && Array.isArray(p.pool) && p.pool.length >= 3 && Math.floor(p.count) > 0 && Math.floor(p.count) < p.pool.length;
  });
}

// Runs in the page. Loads a private copy of OkAdunfX.js with its planner exported (the shipped
// module is not touched), plans a route over the whole pool and scores every spot.
const PAGE_SRC = String.raw`async function(doc,opt){
 const base=location.origin+'/_assets/r20261021-1/next/js/';
 if(!globalThis.__aimSpotPlanner){let src=await (await fetch(base+'OkAdunfX.js')).text();
  src=src.replace(/(from\s*|import\s*\(\s*|import\s*)(["'])\.\//g,(m,a,q)=>a+q+base).replace(/(from\s*|import\s*\(\s*|import\s*)(["'])\/(?!\/)/g,(m,a,q)=>a+q+location.origin+'/');
  if(!/function hy\(e\)\{const\{doc:t,collision:n\}=e/.test(src))throw new Error('planner hy not found in OkAdunfX.js');
  src+='\nexport{hy as __aimHy};';globalThis.__aimSpotPlanner=(await import(URL.createObjectURL(new Blob([src],{type:'text/javascript'})))).__aimHy;}
 const S=await import(base+'CnrSARj_.js'),B=await import(base+'BiMsX6Xn.js');
 const map=doc.environment?.map??null,terrain=map?await B.gu.loadMapCollision(map):null;
 const planner=globalThis.__aimSpotPlanner({doc,collision:S.o(doc.blocks,terrain),kill:terrain?.kill,ropes:terrain?.ropes});
 if(!planner)return null;
 const pool=doc.rules.spawnerPick.pool,plan=planner.plan(new Set(pool),null);
 const EYE=B.aK(doc.rules.weapon).eyeHeightStand,deg=180/Math.PI,route=plan.route,sp=doc.playerSpawn,spawnDir={x:-Math.sin(sp.yaw),z:-Math.cos(sp.yaw)};
 const approach=f=>{let bi=0,bd=1e9;for(let i=0;i<route.length;i++){const d=Math.hypot(route[i].x-f.x,route[i].z-f.z);if(d<bd-1e-9){bd=d;bi=i}}
  for(let j=bi-1;j>=0;j--){const dx=route[bi].x-route[j].x,dz=route[bi].z-route[j].z,L=Math.hypot(dx,dz);if(L>=1.5)return{x:dx/L,z:dz/L}}return spawnDir};
 const feats={};
 for(const s of plan.steps){if(s.unreachable||s.hidden){feats[s.spawnerId]={skip:s.unreachable?'unreachable':'hidden'};continue}
  const eye={x:s.from.x,y:s.from.y+EYE,z:s.from.z},v={x:s.head.x-eye.x,y:s.head.y-eye.y,z:s.head.z-eye.z},h=Math.hypot(v.x,v.z),d=Math.hypot(h,v.y);
  const a=approach(s.from),cos=h>1e-6?(a.x*v.x+a.z*v.z)/h:1,yawOff=Math.acos(Math.max(-1,Math.min(1,cos)))*deg,pitch=Math.atan2(v.y,h)*deg;
  const raw=0.45*Math.min(1,yawOff/120)+0.15*Math.min(1,Math.abs(pitch)/20)+0.25*Math.max(0,Math.min(1,(12-d)/9))+0.15*(s.together===1?1:0);
  feats[s.spawnerId]={raw,yawOff,pitch,d,together:s.together}}
 const ids=pool.filter(id=>feats[id]&&feats[id].raw!==undefined),sorted=[...ids].sort((x,y)=>feats[x].raw-feats[y].raw),p={};
 for(const id of pool)p[id]=0.5;
 if(sorted.length>1){let i=0;while(i<sorted.length){let j=i;while(j+1<sorted.length&&Math.abs(feats[sorted[j+1]].raw-feats[sorted[i]].raw)<1e-9)j++;const r=(i+j)/2/(sorted.length-1);for(let k=i;k<=j;k++)p[sorted[k]]=Math.round(r*1000)/1000;i=j+1}}
 let png=null;
 if(opt.plot&&map){const mm=await B.gu.loadMapMinimap(map),img=new Image();img.src='/aim-maps/'+mm.image;await img.decode();const t=mm.transform;
  const pts=[sp.position,...plan.steps.map(s=>s.head),...route];let mnx=1e9,mxx=-1e9,mnz=1e9,mxz=-1e9;for(const q of pts){mnx=Math.min(mnx,q.x);mxx=Math.max(mxx,q.x);mnz=Math.min(mnz,q.z);mxz=Math.max(mxz,q.z)}
  const U=(x,z)=>[(x*t.scaleU+t.offsetU)*img.width,(z*t.scaleV+t.offsetV)*img.height];
  const [u0,v0]=U(mnx-6,mnz-6),[u1,v1]=U(mxx+6,mxz+6),ux=Math.min(u0,u1),vy=Math.min(v0,v1),uw=Math.abs(u1-u0),vh=Math.abs(v1-v0),sc=Math.min(1100/uw,1100/vh);
  const c=document.createElement('canvas');c.width=Math.round(uw*sc)+440;c.height=Math.max(Math.round(vh*sc),560);const g=c.getContext('2d');g.fillStyle='#111';g.fillRect(0,0,c.width,c.height);
  g.drawImage(img,ux,vy,uw,vh,0,0,uw*sc,vh*sc);const P=(x,z)=>{const [u,v]=U(x,z);return[(u-ux)*sc,(v-vy)*sc]};
  g.strokeStyle='rgba(255,255,255,.7)';g.lineWidth=2;g.beginPath();route.forEach((q,i)=>{const [x,y]=P(q.x,q.z);i?g.lineTo(x,y):g.moveTo(x,y)});g.stroke();
  const [sx,sy]=P(sp.position.x,sp.position.z),[ex,ey]=P(sp.position.x+spawnDir.x*4,sp.position.z+spawnDir.z*4);g.fillStyle='#0f0';g.beginPath();g.arc(sx,sy,8,0,7);g.fill();g.strokeStyle='#0f0';g.lineWidth=3;g.beginPath();g.moveTo(sx,sy);g.lineTo(ex,ey);g.stroke();
  const col=q=>'hsl('+(240-240*q)+',90%,55%)';g.font='bold 15px sans-serif';
  for(const s of plan.steps){const q=p[s.spawnerId],[hx,hy]=P(s.head.x,s.head.z),[fx,fy]=P(s.from.x,s.from.z);g.strokeStyle=col(q);g.globalAlpha=.6;g.lineWidth=1.5;g.beginPath();g.moveTo(fx,fy);g.lineTo(hx,hy);g.stroke();g.globalAlpha=1;
   g.fillStyle=col(q);g.beginPath();g.arc(hx,hy,9,0,7);g.fill();g.strokeStyle='#000';g.lineWidth=2;g.stroke();g.fillStyle='#fff';g.lineWidth=3;const lab=s.spawnerId.replace('spawner-','')+' '+q.toFixed(2);g.strokeText(lab,hx+11,hy+5);g.fillText(lab,hx+11,hy+5)}
  let ly=22;const lx=c.width-430;g.fillStyle='#fff';g.font='bold 16px sans-serif';g.fillText(String(opt.title||'').slice(0,44),lx,ly);ly+=22;g.font='13px monospace';
  g.fillText('blue = common spot (p 0), red = off-angle (p 1)',lx,ly);ly+=17;g.fillText('green = spawn + facing, white = planned route',lx,ly);ly+=17;g.fillText('thin line = where the spot is first seen',lx,ly);ly+=22;
  g.fillText('spot  p    yawOff pitch  dist  tog',lx,ly);ly+=16;
  for(const id of [...pool].sort((a,b)=>p[b]-p[a])){const f=feats[id];g.fillStyle=col(p[id]);g.fillText(f&&f.raw!==undefined?id.replace('spawner-','').padEnd(4)+' '+p[id].toFixed(2)+'  '+f.yawOff.toFixed(0).padStart(4)+'° '+f.pitch.toFixed(0).padStart(4)+'° '+f.d.toFixed(1).padStart(5)+'m '+f.together:id.replace('spawner-','').padEnd(4)+' 0.50  '+(f?.skip??'n/a'),lx,ly);ly+=15}
  png=c.toDataURL('image/png')}
 return JSON.stringify({p,png,skipped:Object.entries(feats).filter(([,f])=>f.skip).map(([k,f])=>k+':'+f.skip)});
}`;

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((p) => p.type === "page" && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(p.url));
  if (!page) throw new Error(`no app page on debug port ${CDP}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const evaluate = async (expression) => {
    const i = ++id;
    const r = await new Promise((resolve) => { pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, timeout: 300000 } })); });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

const cdp = await connect();
const scenes = {};
let previous = {};
try { previous = JSON.parse(fs.readFileSync(OUT, "utf-8")).scenes ?? {}; } catch {}
if (PLOTS) fs.mkdirSync(PLOTS, { recursive: true });
for (const { code, name, doc } of drills()) {
  if (ONLY && !ONLY.includes(code)) continue;
  const key = aimSpotKey(doc);
  const value = await cdp.evaluate(`(${PAGE_SRC})(${JSON.stringify(doc)},${JSON.stringify({ plot: !!PLOTS, title: name })})`);
  if (!value) { console.log(`skip ${code} ${name}: no planner route`); continue; }
  const { p, png, skipped } = JSON.parse(value);
  const codes = [...(scenes[key]?.codes ?? []), code];
  scenes[key] = { codes, name: scenes[key]?.name ?? name, map: doc.environment?.map ?? null, scores: p };
  if (PLOTS && png) fs.writeFileSync(path.join(PLOTS, `${code}.png`), Buffer.from(png.split(",")[1], "base64"));
  console.log(`${code} ${key} ${Object.keys(p).length} spots${skipped.length ? `, no score: ${skipped.join(" ")}` : ""}  ${name}`);
}
cdp.close();
const merged = ONLY ? { ...previous, ...scenes } : scenes;
const sorted = Object.fromEntries(Object.entries(merged).sort((a, b) => a[1].codes[0].localeCompare(b[1].codes[0])));
fs.writeFileSync(OUT, JSON.stringify({ version: 1, about: "Off-angle score p (0 common spot .. 1 off-angle) per spot, by aimSpotKey; made by tools/spot_scores.mjs", scenes: sorted }, null, 1) + "\n");
console.log(`wrote ${Object.keys(sorted).length} drills to ${path.relative(ROOT, OUT)}`);
process.exit(0);
