// Planner dump for tools/peek_cover.mjs --init. Runs the game's bot-order planner (hy, OkAdunfX.js; the
// same call as tools/spot_scores.mjs) for the six *-peekers drills inside a running test copy of the app
// and prints JSON: { <stem>: { route:[[x,y,z]...], steps:{ spawnerId: {from,head,together} | {skip} }, eye } }.
// Needs the ORIGINAL (not yet converted) scenario files.
//   node tools/peek_planner.mjs <cdpPort> <scenarioDir> > planner.json
import fs from 'node:fs';
import path from 'node:path';
const T0 = Date.now();
const [port, dir] = process.argv.slice(2);
const STEMS = ['ascent-b-retake', 'bind-a-showers', 'corrode-mid-to-a', 'haven-garage-push', 'lotus-b-attack', 'split-b-heaven-retake'].map((s) => s + '-peekers');
const deadline = () => { if (Date.now() - T0 > 8.5 * 60e3) { console.error('timeout'); process.exit(3); } };
let page = null;
for (let i = 0; i < 120 && !page; i++) {
  deadline();
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(t.url)); } catch {}
  if (!page) await new Promise((r) => setTimeout(r, 2000));
}
if (!page) { console.error('no page'); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const evaluate = async (expression) => {
  const i = ++id;
  const r = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 240000 } })); });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
// wait until the bundles are fetchable
for (let i = 0; i < 60; i++) {
  deadline();
  const ok = await evaluate(`fetch(location.origin+'/_assets/r20261021-1/next/js/OkAdunfX.js').then(r=>r.ok).catch(()=>false)`).catch(() => false);
  if (ok) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const PAGE = String.raw`async function(doc){
 const base=location.origin+'/_assets/r20261021-1/next/js/';
 if(!globalThis.__p1Hy){let src=await (await fetch(base+'OkAdunfX.js')).text();
  src=src.replace(/(from\s*|import\s*\(\s*|import\s*)(["'])\.\//g,(m,a,q)=>a+q+base).replace(/(from\s*|import\s*\(\s*|import\s*)(["'])\/(?!\/)/g,(m,a,q)=>a+q+location.origin+'/');
  if(!/function hy\(e\)\{const\{doc:t,collision:n\}=e/.test(src))throw new Error('planner hy not found');
  src+='\nexport{hy as __p1Hy};';globalThis.__p1Hy=(await import(URL.createObjectURL(new Blob([src],{type:'text/javascript'})))).__p1Hy;}
 const S=await import(base+'CnrSARj_.js'),B=await import(base+'BiMsX6Xn.js');
 const map=doc.environment?.map??null,terrain=map?await B.gu.loadMapCollision(map):null;
 const planner=globalThis.__p1Hy({doc,collision:S.o(doc.blocks,terrain),kill:terrain?.kill,ropes:terrain?.ropes});
 if(!planner)return null;
 const pool=doc.rules.spawnerPick.pool,plan=planner.plan(new Set(pool),null);
 const P=q=>q?[+q.x.toFixed(3),+q.y.toFixed(3),+q.z.toFixed(3)]:null,steps={};
 for(const s of plan.steps)steps[s.spawnerId]=s.unreachable||s.hidden?{skip:s.unreachable?'unreachable':'hidden'}:{from:P(s.from),head:P(s.head),together:s.together??0};
 return JSON.stringify({route:plan.route.map(P),steps,eye:B.aK(doc.rules.weapon).eyeHeightStand});
}`;
const out = {};
for (const stem of STEMS) {
  deadline();
  const doc = JSON.parse(JSON.parse(fs.readFileSync(path.join(dir, stem + '.json'), 'utf-8')).scene.doc);
  const v = await evaluate(`(${PAGE})(${JSON.stringify(doc)})`);
  out[stem] = v ? JSON.parse(v) : null;
  console.error(`${stem}: ${v ? Object.keys(out[stem].steps).length + ' steps, route ' + out[stem].route.length : 'no plan'}`);
}
console.log(JSON.stringify(out));
ws.close();
process.exit(0);
