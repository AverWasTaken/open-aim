// Alternative bot positions for the static spots of every shipped pre-aim drill. Writes
// app/mods/aim-ranks/spot-alts.json, which the game reads at round start in Human-like bot mode
// (tools/spotvary_patch.py): each round every static spot moves to one of its checked alternatives
// (or stays on the authored point), so the bots can't be prefired from memory.
//
// Runs inside the app, like tools/spot_scores.mjs (it uses the game's own collision, ground snap,
// sight test and bot-order planner):
//
//   1. Start a test copy of the app with a debug port (any free ports; keep your real profile out):
//        AIM_PROFILE=<empty folder> AIM_PORT=8142 app/node_modules/.bin/electron app --remote-debugging-port=9352
//   2. node tools/spot_alts.mjs [--cdp 9352] [--plots <folder>] [--only <code>,<code>] [--check]
//
// --plots writes a top-down picture per drill (minimap, authored spots, their alternatives).
// --check validates the existing file again (every stored alternative) without rewriting it, and
// exits 1 if anything fails.
//
// Which spots: fixed spawners of drills with a map and at least 5 such spawners, whose actor is a
// humanoid with only "shooter" and/or "respawn" behaviours (the static holders of the pre-aim
// drills; peekers, strafers, path bots, area/grid/slots spawners are left alone). A spot the planner
// can't see or reach gets no alternatives.
//
// Candidates: the authored point moved 0.6 / 0.9 / 1.2 / 1.5 m sideways (perpendicular to the line
// from the planner's "from" point, where the route first sees the spot) to both sides, each also
// with 0 / +0.3 / -0.3 m depth; x and z rounded to 1 mm before testing. Stored y is always the
// authored y: the game ground-snaps from it exactly as it does for the authored point. A candidate
// must pass every check:
//   ground   groundSnap spots: the sim's own snap (bD, ray from y+2.5 m down 4 m) hits ground
//            within 0.3 m of the authored spot's snapped height, and the per-tick re-snap (0.45 m
//            up/down) keeps it there. Spots without groundSnap: the ground under the candidate is
//            within 1 cm of the ground under the authored point (same height above the floor).
//   ledge    ground within 0.15 m of the feet under 48 points on 0.25 / 0.3 / 0.35 m circles (no edge,
//            no drop, no curb or step under the body; slopes up to about 23 degrees pass).
//   body     no collision (pawn mesh) across a 0.35 m radius body at 12 heights from 17 cm to 15 cm
//            above the head (24 diameters each) and none from knee up to 25 cm above the head
//            (centre + 4 points).
//   path     clear straight lines from the authored point to the candidate at 0.5 / 1.0 / 1.5 m
//            above the feet (same side of every wall and door).
//   sight    from the player spawn eye and from the eye at every planner "from" point of the
//            drill, the candidate's head and chest are visible exactly when the authored spot's
//            are (the sim's own sight test, world.sightBlocked); so no spot becomes wallbang-only,
//            hidden, or visible from somewhere new.
//   spacing  at least 0.8 m (xz) from every other spawner's authored point (area spawners: their
//            box) and from every other spawner's kept alternatives.
// Up to 5 alternatives are kept per spot (spread out: greedy farthest-first, at least 0.5 m apart),
// with the authored point always first.
//
// Keys: aimAltKey(doc) below, the same text as in OkAdunfX.js (tools/spotvary_patch.py), a hash of
// the map, weapon, player spawn, spawnerPick and the whole spawners, blocks and actors lists (object
// keys sorted). Each entry also lists the drills' meta ids; the game only uses an entry for a drill
// whose id is listed (Studio drills never match). scripts/test-spot-vary.cjs checks the coverage.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const CDP = Number(arg("--cdp", "9352"));
const PLOTS = arg("--plots", null);
const ONLY = arg("--only", null)?.split(",") ?? null;
const CHECK = process.argv.includes("--check");
const OUT = path.join(ROOT, "app", "mods", "aim-ranks", "spot-alts.json");

// Same text as in OkAdunfX.js.
const KEY_SRC = 'function aimAltKey(d){if(!d||!Array.isArray(d.spawners))return null;const c=x=>Array.isArray(x)?x.map(c):x&&typeof x=="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,c(x[k])])):x,s=JSON.stringify(c([d.environment?.map??null,d.rules?.weapon??null,d.playerSpawn??null,d.rules?.spawnerPick??null,d.spawners,d.blocks??[],d.actors??[]]));let e=2166136261,h=2646966556;for(let i=0;i<s.length;i++){const k=s.charCodeAt(i);e=Math.imul(e^k,16777619),h=Math.imul(h^k,2246822507)}return(e>>>0).toString(16).padStart(8,"0")+(h>>>0).toString(16).padStart(8,"0")}';
const aimAltKey = new Function(`${KEY_SRC};return aimAltKey;`)();

// The spots that get alternatives (same rule in scripts/test-spot-vary.cjs).
export function staticSpots(doc) {
  if (!doc?.environment?.map || !Array.isArray(doc.spawners) || !Array.isArray(doc.actors)) return [];
  const tm = new Map(doc.actors.map((a) => [a.id, a]));
  const out = doc.spawners.filter((s) => {
    const t = tm.get(s.actorTemplateId);
    return s.kind === "fixed" && s.maxAlive >= 1 && t?.body?.shape === "humanoid" && t.behaviors.length > 0 &&
      t.behaviors.every((b) => b.kind === "shooter" || b.kind === "respawn");
  });
  return out.length >= 5 ? out.map((s) => s.id) : [];
}

export function drills() {
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
  return out.filter(({ doc }) => staticSpots(doc).length > 0);
}

// Runs in the page. opt: {ids: spot ids, check: {spawnerId: [[x,y,z],...]} | null, plot, title}.
const PAGE_SRC = String.raw`async function(doc,opt){
 const base=location.origin+'/_assets/r20261021-1/next/js/';
 if(!globalThis.__aimAltPlanner){let src=await (await fetch(base+'OkAdunfX.js')).text();
  src=src.replace(/(from\s*|import\s*\(\s*|import\s*)(["'])\.\//g,(m,a,q)=>a+q+base).replace(/(from\s*|import\s*\(\s*|import\s*)(["'])\/(?!\/)/g,(m,a,q)=>a+q+location.origin+'/');
  if(!/function hy\(e\)\{const\{doc:t,collision:n\}=e/.test(src))throw new Error('planner hy not found in OkAdunfX.js');
  src+='\nexport{hy as __aimHy};';globalThis.__aimAltPlanner=(await import(URL.createObjectURL(new Blob([src],{type:'text/javascript'})))).__aimHy;}
 const S=await import(base+'CnrSARj_.js'),B=await import(base+'BiMsX6Xn.js');
 const map=doc.environment.map,terrain=await B.gu.loadMapCollision(map),col=S.o(doc.blocks,terrain),pawn=col.pawn;
 const planner=globalThis.__aimAltPlanner({doc,collision:col,kill:terrain?.kill,ropes:terrain?.ropes});
 if(!planner)return null;
 const plan=planner.plan(new Set(doc.spawners.map(s=>s.id)),null);
 const world=S.c(doc,{seed:1,terrain,sensitivity:1,bots:'human'});
 const EYE=B.aK(doc.rules.weapon).eyeHeightStand,R=.35,STEP=.3,SPACE=.8,r3=v=>Math.round(v*1000)/1000;
 const FOOT=.15,BODY_H=hy=>[.17,.25,.35,.5,.7,.9,1.1,1.3,1.5,1.7,hy,hy+.15],RING=[R,.3,.25],DIRS=48;
 const hit=(ax,ay,az,bx,by,bz)=>{const dx=bx-ax,dy=by-ay,dz=bz-az,L=Math.hypot(dx,dy,dz);return L>1e-6&&B.bm(pawn,ax,ay,az,dx/L,dy/L,dz/L,L)!==null};
 const snap=(x,y,z,u,d)=>B.bD({x,y,z},pawn,u,d);
 const seen=(e,p)=>!world.sightBlocked(e,p);
 const sp=doc.playerSpawn.position,views=[{x:sp.x,y:sp.y+EYE,z:sp.z}];
 const stepOf=new Map;for(const s of plan.steps){stepOf.set(s.spawnerId,s);if(!s.hidden&&!s.unreachable&&s.from)views.push({x:s.from.x,y:s.from.y+EYE,z:s.from.z})}
 const byId=new Map(doc.spawners.map(s=>[s.id,s]));
 // others: every spawner's authored footprint (area/grid/slots: their box), for spacing
 const foot=s=>{const p=s.position,h=s.kind==='fixed'?{x:0,z:0}:{x:Math.abs(s.size?.x??0)/2,z:Math.abs(s.size?.z??0)/2};return{id:s.id,x:p.x,z:p.z,hx:h.x,hz:h.z}};
 const boxDist=(b,x,z)=>Math.hypot(Math.max(0,Math.abs(x-b.x)-b.hx),Math.max(0,Math.abs(z-b.z)-b.hz));
 const others=doc.spawners.map(foot),kept=[];
 const rej={},count=k=>{rej[k]=(rej[k]??0)+1};
 const res={alts:{},info:{},rejects:rej};
 function ground0(s){const p=s.position;if(!s.groundSnap)return p.y;const g=snap(p.x,p.y,p.z);return g===null?p.y:g}
 function test(s,ctx,x,z){ // -> reason string or {fy}
  const p=s.position;let fy;
  if(s.groundSnap){fy=snap(x,p.y,z);if(fy===null)return'ground';if(Math.abs(fy-ctx.f0)>STEP)return'height';const again=snap(x,fy,z,.45,.45);if(again===null||Math.abs(again-fy)>1e-3)return'resnap'}
  else{const g1=snap(x,p.y,z);if(ctx.g0===null||g1===null||Math.abs(g1-ctx.g0)>.01)return'ground';fy=p.y}
  for(const rr of RING)for(let k=0;k<DIRS;k++){const a=k*2*Math.PI/DIRS,g=snap(x+Math.cos(a)*rr,fy,z+Math.sin(a)*rr,.5,1);if(g===null||Math.abs(g-fy)>FOOT)return'ledge'}
  for(const h of BODY_H(ctx.hy))for(let k=0;k<DIRS/2;k++){const a=k*2*Math.PI/DIRS,c=Math.cos(a)*R,d=Math.sin(a)*R;if(hit(x-c,fy+h,z-d,x+c,fy+h,z+d))return'body'}
  for(const [ox,oz] of [[0,0],[.7*R,0],[-.7*R,0],[0,.7*R],[0,-.7*R]])if(hit(x+ox,fy+.4,z+oz,x+ox,fy+ctx.hy+.25,z+oz))return'body';
  return{fy}}
 function full(s,ctx,x,z){
  const t=test(s,ctx,x,z);if(typeof t==='string')return t;const fy=t.fy;
  if(x!==ctx.x0||z!==ctx.z0)for(const h of [.5,1,1.5])if(hit(ctx.x0,ctx.f0+h,ctx.z0,x,fy+h,z))return'path';
  for(let v=0;v<views.length;v++)for(let k=0;k<2;k++){const q={x:x+ctx.ho.x,y:fy+(k?ctx.chest:ctx.ho.y),z:z+ctx.ho.z};if(seen(views[v],q)!==ctx.vis[v*2+k])return'sight'}
  for(const o of others)if(o.id!==s.id&&boxDist(o,x,z)<SPACE)return'spacing';
  for(const o of kept)if(o.id!==s.id&&Math.hypot(o.x-x,o.z-z)<SPACE)return'spacing';
  return{fy}}
 const plot=[],ctxOf=new Map;
 for(const id of opt.ids){
  const s=byId.get(id),st=stepOf.get(id),p=s.position;
  if(!st||st.hidden||st.unreachable||!st.from){count('noView');res.info[id]={skip:!st?'noPlan':st.hidden?'hidden':'unreachable'};continue}
  const f0=ground0(s),ho={x:st.head.x-p.x,y:st.head.y-f0,z:st.head.z-p.z},ctx={x0:p.x,z0:p.z,f0,g0:snap(p.x,p.y,p.z),hy:ho.y,ho,chest:ho.y*.6,vis:[]};
  for(const v of views)for(let k=0;k<2;k++)ctx.vis.push(seen(v,{x:p.x+ho.x,y:f0+(k?ctx.chest:ho.y),z:p.z+ho.z}));
  const own=test(s,ctx,p.x,p.z);
  let dx=p.x-st.from.x,dz=p.z-st.from.z;const L=Math.hypot(dx,dz)||1;dx/=L;dz/=L;const sx=-dz,sz=dx;
  ctxOf.set(id,{s,ctx,ax:Math.round(sx*1e4)/1e4,az:Math.round(sz*1e4)/1e4,eye:{x:st.from.x,y:st.from.y+EYE,z:st.from.z}});
  if(opt.check){const list=opt.check[id]??[];const out=[];
   list.forEach((q,i)=>{if(i===0){if(q[0]!==p.x||q[1]!==p.y||q[2]!==p.z)out.push('first entry is not the authored point');return}
    if(q[1]!==p.y)out.push('alt '+i+' y differs from authored y');const r=full(s,ctx,q[0],q[2]);if(typeof r==='string')out.push('alt '+i+' '+r);else kept.push({id,x:q[0],z:q[2]})});
   res.info[id]={n:list.length,own:typeof own==='string'?own:'ok',fail:out};plot.push({id,p,from:st.from,alts:list.slice(1).map(q=>({x:q[0],z:q[2]}))});continue}
  const cands=[];for(const d of [0,.3,-.3])for(const m of [.6,.9,1.2,1.5])for(const sg of [1,-1]){const x=r3(p.x+sx*m*sg+dx*d),z=r3(p.z+sz*m*sg+dz*d);cands.push({x,z})}
  const ok=[];for(const c of cands){const r=full(s,ctx,c.x,c.z);if(typeof r==='string')count(r);else ok.push(c)}
  const pick=[];let pool=ok.slice();
  while(pick.length<5&&pool.length){let bi=-1,bd=-1;for(let i=0;i<pool.length;i++){const c=pool[i];let d=Math.hypot(c.x-p.x,c.z-p.z);for(const q of pick)d=Math.min(d,Math.hypot(c.x-q.x,c.z-q.z));if(d>bd){bd=d;bi=i}}
   if(bd<.5)break;pick.push(pool[bi]);pool.splice(bi,1)}
  for(const c of pick)kept.push({id,x:c.x,z:c.z});
  res.alts[id]=[[p.x,p.y,p.z],...pick.map(c=>[c.x,p.y,c.z])];res.info[id]={n:pick.length,valid:ok.length,of:cands.length,own:typeof own==='string'?own:'ok'};
  plot.push({id,p,from:st.from,alts:pick})}
 // Movement lanes (tools/peekmove_patch.py): from each position (authored point or alternative)
 // walk sideways in 2.5 cm steps both ways, up to 1.6 m, stop at the first step that fails and keep
 // the lane 10 cm short of it (so at most 1.5 m).
 // Every step: per-tick re-snap (0.45 m) finds ground within 0.3 m of the last step and within
 // 0.5 m of the start (no groundSnap: same floor height within 1 cm, the bot never re-snaps),
 // ledge ring, body, clear path from the last step, head and the bot's eye visible from the spot's "from" eye,
 // 0.7 m from other spawners, their alternatives and the lanes already kept (so two bots never meet).
 const LSTEP=.025,LMAX=64,LEND=.1,LSPACE=.7,laneKept=[];
 function laneOf(id,x0,z0){const c=ctxOf.get(id),s=c.s,ctx=c.ctx,p=s.position;
  const y0=s.groundSnap?snap(x0,p.y,z0):p.y;if(y0===null)return null;const ext=[0,0];
  for(const [i,dir] of [[1,1],[0,-1]]){ // ext[1] = positive side, ext[0] = negative side
  let px=x0,py=y0,pz=z0;
   for(let k=1;k<=LMAX;k++){const x=x0+dir*k*LSTEP*c.ax,z=z0+dir*k*LSTEP*c.az;let y;
    if(s.groundSnap){y=snap(x,py,z,.45,.45);if(y===null||Math.abs(y-py)>STEP||Math.abs(y-y0)>.5)break}
    else{const g=snap(x,p.y,z);if(ctx.g0===null||g===null||Math.abs(g-ctx.g0)>.01)break;y=p.y}
    let bad=!1;
    for(const rr of RING)for(let j=0;j<DIRS&&!bad;j++){const a=j*2*Math.PI/DIRS,g=snap(x+Math.cos(a)*rr,y,z+Math.sin(a)*rr,.5,1);if(g===null||Math.abs(g-y)>FOOT)bad=!0}
    for(const h of BODY_H(ctx.hy))for(let j=0;j<DIRS/2&&!bad;j++){const a=j*2*Math.PI/DIRS,cx=Math.cos(a)*R,cz=Math.sin(a)*R;if(hit(x-cx,y+h,z-cz,x+cx,y+h,z+cz))bad=!0}
    for(const [ox,oz] of [[0,0],[.7*R,0],[-.7*R,0],[0,.7*R],[0,-.7*R]])if(!bad&&hit(x+ox,y+.4,z+oz,x+ox,y+ctx.hy+.25,z+oz))bad=!0;
    for(const h of [.5,1,1.5])if(!bad&&hit(px,py+h,pz,x,y+h,z))bad=!0;
    if(!bad&&(!seen(c.eye,{x:x+ctx.ho.x,y:y+ctx.ho.y,z:z+ctx.ho.z})||!seen(c.eye,{x,y:y+EYE,z})))bad=!0; // head, and the bot's own eye (its canSee)
    for(const o of others)if(!bad&&o.id!==id&&boxDist(o,x,z)<LSPACE)bad=!0;
    for(const o of kept)if(!bad&&o.id!==id&&Math.hypot(o.x-x,o.z-z)<LSPACE)bad=!0;
    for(const o of laneKept)if(!bad&&o.id!==id&&Math.hypot(o.x-x,o.z-z)<LSPACE)bad=!0;
    if(bad)break;ext[i]=Math.round(k*LSTEP*1000)/1000;px=x;py=y;pz=z}}
  for(const i of [0,1])ext[i]=Math.max(0,Math.round((ext[i]-LEND)*1000)/1000); // keep 10 cm back from the first failing step
  if(ext[0]+ext[1]<.3)return null;
  for(let k=-Math.round(ext[0]/LSTEP);k<=Math.round(ext[1]/LSTEP);k++)laneKept.push({id,x:x0+k*LSTEP*c.ax,z:z0+k*LSTEP*c.az});
  return[c.ax,c.az,-ext[0],ext[1]]}
 res.lanes={};const laneStats={spots:0,withLane:0,positions:0,lanes:0,width:0};
 for(const id of opt.ids){if(!ctxOf.has(id))continue;const p=byId.get(id).position;
  const list=opt.check?(opt.check[id]??[[p.x,p.y,p.z]]):(res.alts[id]?.length>=2?res.alts[id]:[[p.x,p.y,p.z]]);
  const ls=list.map(q=>laneOf(id,q[0],q[2]));laneStats.spots++;laneStats.positions+=ls.length;
  for(const l of ls)if(l){laneStats.lanes++;laneStats.width+=l[3]-l[2]}
  if(ls.some(Boolean)){laneStats.withLane++;res.lanes[id]=ls}
  if(opt.check){const st=opt.checkLanes?.[id];const f=res.info[id]?.fail;if(st&&f){if(st.length!==ls.length)f.push('lane count');
   else st.forEach((l,i)=>{const r=ls[i];if(l===null)return;if(!r||l[0]!==r[0]||l[1]!==r[1]||l[2]<r[2]-1e-9||l[3]>r[3]+1e-9)f.push('lane '+i+' '+JSON.stringify(l)+' vs '+JSON.stringify(r))})}}}
 res.laneStats=laneStats;
 let png=null;
 if(opt.plot){const mm=await B.gu.loadMapMinimap(map),img=new Image();img.src='/aim-maps/'+mm.image;await img.decode();const t=mm.transform;
  const pts=[sp,...plot.map(q=>q.p)];let mnx=1e9,mxx=-1e9,mnz=1e9,mxz=-1e9;for(const q of pts){mnx=Math.min(mnx,q.x);mxx=Math.max(mxx,q.x);mnz=Math.min(mnz,q.z);mxz=Math.max(mxz,q.z)}
  const U=(x,z)=>[(x*t.scaleU+t.offsetU)*img.width,(z*t.scaleV+t.offsetV)*img.height];
  const [u0,v0]=U(mnx-5,mnz-5),[u1,v1]=U(mxx+5,mxz+5),ux=Math.min(u0,u1),vy=Math.min(v0,v1),uw=Math.abs(u1-u0),vh=Math.abs(v1-v0),sc=Math.min(1400/uw,1400/vh);
  const c=document.createElement('canvas');c.width=Math.round(uw*sc);c.height=Math.round(vh*sc)+60;const g=c.getContext('2d');g.fillStyle='#111';g.fillRect(0,0,c.width,c.height);
  g.drawImage(img,ux,vy,uw,vh,0,0,uw*sc,vh*sc);const P=(x,z)=>{const [u,v]=U(x,z);return[(u-ux)*sc,(v-vy)*sc]};
  const [px,py]=P(sp.x,sp.z);g.fillStyle='#0f0';g.beginPath();g.arc(px,py,8,0,7);g.fill();
  g.font='bold 13px sans-serif';
  for(const q of plot){const [hx,hy]=P(q.p.x,q.p.z),[fx,fy]=P(q.from.x,q.from.z);g.strokeStyle='rgba(255,255,255,.35)';g.lineWidth=1;g.beginPath();g.moveTo(fx,fy);g.lineTo(hx,hy);g.stroke();
   for(const l of (res.lanes[q.id]??[]).slice(0,1))if(l){const [l0x,l0y]=P(q.p.x+l[0]*l[2],q.p.z+l[1]*l[2]),[l1x,l1y]=P(q.p.x+l[0]*l[3],q.p.z+l[1]*l[3]);g.strokeStyle='#00e5ff';g.lineWidth=3;g.beginPath();g.moveTo(l0x,l0y);g.lineTo(l1x,l1y);g.stroke()}
   for(const a of q.alts){const [ax,ay]=P(a.x,a.z);g.strokeStyle='#ffb000';g.lineWidth=1.5;g.beginPath();g.moveTo(hx,hy);g.lineTo(ax,ay);g.stroke();g.fillStyle='#ffb000';g.beginPath();g.arc(ax,ay,4,0,7);g.fill()}
   g.fillStyle='#fff';g.beginPath();g.arc(hx,hy,5,0,7);g.fill();g.strokeStyle='#000';g.lineWidth=3;const lab=q.id.replace('spawner-','')+' ('+q.alts.length+')';g.strokeText(lab,hx+7,hy-6);g.fillText(lab,hx+7,hy-6)}
  g.fillStyle='#fff';g.font='bold 15px sans-serif';g.fillText(String(opt.title||'').slice(0,60),10,c.height-36);g.font='13px monospace';
  g.fillText('white = authored spot (n alternatives), orange = alternatives, cyan = movement lane of the authored point, thin line = seen from, green = spawn',10,c.height-14);
  png=c.toDataURL('image/png')}
 res.png=png;res.views=views.length;
 return JSON.stringify(res);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cdp = await connect();
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(OUT, "utf-8")).scenes ?? {}; } catch {}
  if (CHECK && !Object.keys(previous).length) throw new Error(`--check: ${OUT} missing or empty`);
  if (PLOTS) fs.mkdirSync(PLOTS, { recursive: true });
  const scenes = {};
  let failed = 0;
  const totals = {};
  for (const { code, name, doc } of drills()) {
    if (ONLY && !ONLY.includes(code)) continue;
    const key = aimAltKey(doc);
    const ids = staticSpots(doc);
    const check = CHECK ? previous[key]?.alts ?? null : null;
    const checkLanes = CHECK ? previous[key]?.lanes ?? null : null;
    if (CHECK && !check) { console.log(`FAIL ${code}: no entry`); failed++; continue; }
    const value = await cdp.evaluate(`(${PAGE_SRC})(${JSON.stringify(doc)},${JSON.stringify({ ids, check, checkLanes, plot: !!PLOTS, title: name })})`);
    if (!value) { console.log(`skip ${code} ${name}: no planner route`); continue; }
    const res = JSON.parse(value);
    if (PLOTS && res.png) fs.writeFileSync(path.join(PLOTS, `${code}.png`), Buffer.from(res.png.split(",")[1], "base64"));
    if (CHECK) {
      const bad = Object.entries(res.info).filter(([, i]) => i.fail?.length);
      const n = Object.values(res.info).reduce((a, i) => a + Math.max(0, (i.n ?? 1) - 1), 0);
      console.log(`${bad.length ? "FAIL" : "ok  "} ${code} ${n} alternatives checked${bad.length ? ": " + bad.map(([id, i]) => id + " " + i.fail.join(", ")).join("; ") : ""}  ${name}`);
      failed += bad.length;
      continue;
    }
    const codes = [...(scenes[key]?.codes ?? []), code];
    const metaIds = [...new Set([...(scenes[key]?.ids ?? []), doc.meta?.id].filter((x) => typeof x === "string"))];
    const alts = Object.fromEntries(Object.entries(res.alts).filter(([, a]) => a.length >= 2));
    scenes[key] = { codes, ids: metaIds, name: scenes[key]?.name ?? name, map: doc.environment.map, alts, lanes: res.lanes };
    const info = Object.values(res.info);
    const two = info.filter((i) => (i.n ?? 0) >= 2).length, one = info.filter((i) => i.n === 1).length, none = ids.length - two - one;
    for (const [k, v] of Object.entries(res.rejects)) totals[k] = (totals[k] ?? 0) + v;
    for (const k of ["withLane", "positions", "lanes", "width"]) totals["lane_" + k] = (totals["lane_" + k] ?? 0) + res.laneStats[k];
    totals.spots = (totals.spots ?? 0) + ids.length; totals.two = (totals.two ?? 0) + two; totals.alts = (totals.alts ?? 0) + info.reduce((a, i) => a + (i.n ?? 0), 0);
    console.log(`${code} ${ids.length} spots: ${two} with >=2 alternatives, ${one} with 1, ${none} with none; rejected ${JSON.stringify(res.rejects)}; lanes ${res.laneStats.withLane} spots, ${res.laneStats.lanes}/${res.laneStats.positions} positions, avg ${(res.laneStats.width / Math.max(1, res.laneStats.lanes)).toFixed(2)} m  ${name}`);
  }
  cdp.close();
  if (CHECK) { console.log(failed ? `${failed} spots failed` : "all stored alternatives pass"); process.exit(failed ? 1 : 0); }
  const merged = ONLY ? { ...previous, ...scenes } : scenes;
  const sorted = Object.fromEntries(Object.entries(merged).sort((a, b) => a[1].codes[0].localeCompare(b[1].codes[0])));
  // One drill per line keeps diffs readable.
  const about = "Checked alternative positions [x,y,z] per static spot (first = authored point) and a movement lane [ax,az,min,max] per position (lanes[id][i] for alts[id][i], or for the authored point when there are no alternatives; null = none), by aimAltKey; made by tools/spot_alts.mjs";
  const lines = Object.entries(sorted).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  fs.writeFileSync(OUT, `{"version": 1, "about": ${JSON.stringify(about)}, "scenes": {\n${lines.join(",\n")}\n}}\n`);
  console.log(`totals ${JSON.stringify(totals)}`);
  console.log(`wrote ${Object.keys(sorted).length} drills to ${path.relative(ROOT, OUT)}`);
  process.exit(0);
}
