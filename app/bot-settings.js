// Settings > General > "Bots": how shooting bots behave, and an optional enemy rank for every drill.
// Saved in localStorage: "aim-bot-mode" ("classic"; absent = Human-like) and "aim-enemy-rank"
// ("iron".."radiant"; absent = each drill's own bots). The game reads both when a round starts
// (tools/bot_patch.py) and saves them in the round's replay, so changes apply from the next round.
// Also "Perfect first shot" under its own Shooting heading: "aim-perfect-first-shot" = "1" (absent = Off),
// read and saved the same way (tools/hitreg_patch.py).
(()=>{
 if(window.__aimBotControls)return;window.__aimBotControls=true;
 const MODE_KEY='aim-bot-mode',RANK_KEY='aim-enemy-rank',FIRST_KEY='aim-perfect-first-shot';
 // Mirrors RANKS in app/studio/drill.js and the stop chances in tools/bot_patch.py.
 const RANKS=[
  ['iron','Iron',[0.9,1.1],9,false,10],['bronze','Bronze',[0.75,0.9],7,false,20],['silver','Silver',[0.6,0.75],5.5,false,30],
  ['gold','Gold',[0.5,0.62],4.5,false,45],['platinum','Platinum',[0.42,0.52],3.5,true,55],['diamond','Diamond',[0.34,0.44],2.8,true,65],
  ['ascendant','Ascendant',[0.28,0.36],2.2,true,75],['immortal','Immortal',[0.22,0.3],1.6,true,85],['radiant','Radiant',[0.17,0.23],1.1,true,90],
 ];
 const get=k=>{try{return localStorage.getItem(k)}catch{return null}};
 const put=(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch{}dispatchEvent(new Event('aim-bot-settings-change'))};
 const mode=()=>get(MODE_KEY)==='classic'?'classic':'human';
 const rank=()=>{const r=get(RANK_KEY);return RANKS.some(x=>x[0]===r)?r:''};
 function css(){
  if(document.getElementById('aim-bot-settings-css'))return;
  const s=document.createElement('style');s.id='aim-bot-settings-css';
  s.textContent=`
.aim-rank-field{flex-wrap:wrap}
.aim-rank-grid{flex:1 0 100%;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-top:10px}
.aim-rank-grid button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:58px;padding:6px 2px 5px;
 background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:2px;color:rgba(236,232,225,.72);font:inherit;font-size:11px;
 letter-spacing:.02em;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.aim-rank-grid button:hover{background:rgba(255,255,255,.07);color:#ece8e1}
.aim-rank-grid button.is-active{border-color:#ff4655;background:rgba(255,70,85,.12);color:#ece8e1}
.aim-rank-grid button:focus-visible{outline:1px solid #ff4655;outline-offset:1px}
.aim-rank-grid img{width:30px;height:30px;object-fit:contain;pointer-events:none}
.aim-rank-grid .aim-rank-any{width:30px;height:30px;display:grid;place-items:center;font-size:15px;color:rgba(236,232,225,.55)}
.aim-rank-note{flex:1 0 100%;margin-top:6px;opacity:.75}`;
  document.head.append(s);
 }
 function describe(){
  const r=RANKS.find(x=>x[0]===rank());
  const human=mode()==='human';
  if(!r)return 'Drill default: every drill keeps its own bots.'+(human?' Better bots stop to shoot more often.':'');
  return `${r[1]}: reacts in about ${r[2][0].toFixed(2)}–${r[2][1].toFixed(2)} s, aim error ${r[3]}°, aims at your ${r[4]?'head':'body'}`+
   (human?`, stops to shoot ${r[5]}% of the time (moving shots whiff more).`:'. Classic: moves and stops like the drill was made.');
 }
 function choice(id,title,text,options,read,write){
  const row=document.createElement('div');row.className='hall-field hall-choice';row.dataset.setting=id;row.dataset.focus=id;
  row.innerHTML='<span class="hall-field-text"><span class="hall-field-head"><b></b><em class="hall-field-local" title="Saved on this PC only">This PC only</em></span><small></small></span><div class="hall-choice-options" role="radiogroup"></div>';
  row.querySelector('b').textContent=title;row.querySelector('small').textContent=text;row.querySelector('small').title=text;
  const box=row.querySelector('[role=radiogroup]');box.setAttribute('aria-label',title);
  for(const [v,label] of options){const b=document.createElement('button');b.type='button';b.role='radio';b.dataset.value=v;b.textContent=label;b.onclick=()=>write(v);box.append(b)}
  row.render=()=>{for(const b of box.children){const on=b.dataset.value===read();b.classList.toggle('is-active',on);b.setAttribute('aria-checked',String(on))}};
  return row;
 }
 function add(){
  const anchor=document.querySelector('[data-setting="textReadability"]'),list=anchor?.parentElement;
  if(!list||list.querySelector('[data-setting="botMode"]'))return;
  css();
  const head=document.createElement('h3');head.className='hall-dialog-section';
  head.innerHTML=' Bots <small class="hall-dialog-section-note">Bots that shoot back. Applies from the next round</small>';
  const modeRow=choice('botMode','Bot behaviour','Human-like: uneven strafes, varied reactions, a wider first shot, and only some bots stop to shoot (more often at higher ranks). Classic: the old fixed pattern.',
   [['human','Human-like'],['classic','Classic']],mode,v=>put(MODE_KEY,v==='classic'?'classic':null));
  const rankRow=document.createElement('div');rankRow.className='hall-field aim-rank-field';rankRow.dataset.setting='enemyRank';rankRow.dataset.focus='enemyRank';
  rankRow.innerHTML='<span class="hall-field-text"><span class="hall-field-head"><b>Enemy rank</b><em class="hall-field-local" title="Saved on this PC only">This PC only</em></span><small>Every bot that shoots back plays like this rank in all drills. Bots that don\'t shoot are not changed.</small></span><div class="aim-rank-grid" role="radiogroup" aria-label="Enemy rank"></div><small class="aim-rank-note" role="status"></small>';
  const grid=rankRow.querySelector('.aim-rank-grid'),note=rankRow.querySelector('.aim-rank-note');
  for(const [v,label] of [['','Drill default'],...RANKS.map(r=>[r[0],r[1]])]){
   const b=document.createElement('button');b.type='button';b.role='radio';b.dataset.value=v;b.title=label;
   b.innerHTML=v?`<img src="/aim-ranks/${v}.png" alt="" draggable="false">`:'<span class="aim-rank-any" aria-hidden="true">✦</span>';
   b.append(label);b.onclick=()=>put(RANK_KEY,v||null);grid.append(b);
  }
  rankRow.render=()=>{const cur=rank();for(const b of grid.children){const on=b.dataset.value===cur;b.classList.toggle('is-active',on);b.setAttribute('aria-checked',String(on))}note.textContent=describe()};
  const shootHead=document.createElement('h3');shootHead.className='hall-dialog-section';
  shootHead.innerHTML=' Shooting <small class="hall-dialog-section-note">Applies from the next round</small>';
  const firstRow=choice('perfectFirstShot','Perfect first shot','First shot while standing still goes exactly where you aim (VALORANT has a small random spread).',
   [['off','Off'],['on','On']],firstShot,v=>put(FIRST_KEY,v==='on'?'1':null));
  anchor.after(head,modeRow,rankRow,shootHead,firstRow);
  function render(){
   if(!rankRow.isConnected){removeEventListener('aim-bot-settings-change',render);removeEventListener('storage',render);return}
   modeRow.render();rankRow.render();firstRow.render();
  }
  addEventListener('aim-bot-settings-change',render);addEventListener('storage',render);render();
 }
 const firstShot=()=>get(FIRST_KEY)==='1'?'on':'off';
 window.__aimBotSettings={mode,rank,firstShot,ranks:RANKS};
 let queued=false;window.__aimWatchPage(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;add()})},{childList:true,subtree:true});add();
})();
