// Settings > General > "Bots": how shooting bots behave. Saved in localStorage: "aim-bot-mode"
// ("classic"; absent = Human-like). The enemy rank ("aim-enemy-rank", "iron".."radiant"; absent =
// the drill's own bots) is picked per drill when you press play (rank-picker.js). The game reads
// both when a round starts (tools/bot_patch.py) and saves them in the round's replay.
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
  const head=document.createElement('h3');head.className='hall-dialog-section';
  head.innerHTML=' Bots <small class="hall-dialog-section-note">Bots that shoot back. Pick their rank when you press play</small>';
  const modeRow=choice('botMode','Bot behaviour','Human-like: uneven strafes, varied reactions, a wider first shot, and only some bots stop to shoot (more often at higher ranks). Classic: the old fixed pattern.',
   [['human','Human-like'],['classic','Classic']],mode,v=>put(MODE_KEY,v==='classic'?'classic':null));
  const shootHead=document.createElement('h3');shootHead.className='hall-dialog-section';
  shootHead.innerHTML=' Shooting <small class="hall-dialog-section-note">Applies from the next round</small>';
  const firstRow=choice('perfectFirstShot','Perfect first shot','First shot while standing still goes exactly where you aim (VALORANT has a small random spread).',
   [['off','Off'],['on','On']],firstShot,v=>put(FIRST_KEY,v==='on'?'1':null));
  anchor.after(head,modeRow,shootHead,firstRow);
  function render(){
   if(!modeRow.isConnected){removeEventListener('aim-bot-settings-change',render);removeEventListener('storage',render);return}
   modeRow.render();firstRow.render();
  }
  addEventListener('aim-bot-settings-change',render);addEventListener('storage',render);render();
 }
 const firstShot=()=>get(FIRST_KEY)==='1'?'on':'off';
 // Rank a shooter config plays like: same math as aimBotRankOf in tools/bot_patch.py (nearest rank
 // by reaction midpoint and aim error, log distance, first rank wins ties). Used by rank-picker.js.
 function rankOf(n){
  const w=Array.isArray(n?.reaction)&&n.reaction.length===2?n.reaction:[.5,.62],m=Math.max(.01,(w[0]+w[1])/2),er=Math.max(.05,Number(n?.aimErrorDeg)||.05);
  let bd=1/0,b;
  for(const R of RANKS){const d=Math.abs(Math.log(m/((R[2][0]+R[2][1])/2)))+Math.abs(Math.log(er/R[3]));if(d<bd){bd=d;b=R[0]}}
  return b;
 }
 window.__aimBotSettings={mode,rank,firstShot,ranks:RANKS};
 // The one rank table and rank math for the rank picker (rank-picker.js).
 window.__aimBots={RANKS,rankOf};
 let queued=false;window.__aimWatchPage(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;add()})},{childList:true,subtree:true});add();
})();
