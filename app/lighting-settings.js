// Settings > Video > "Map lighting": Enhanced (default) or Original.
// Saved in localStorage["aim-map-lighting"]; the patched three.js bundle (tools/lighting_patch.py)
// reads it when a map loads, and window.__aimMapLighting.apply() switches it live.
(()=>{
 if(window.__aimLightingControls)return;window.__aimLightingControls=true;
 const key='aim-map-lighting';
 const read=()=>{try{return localStorage.getItem(key)==='original'?'original':'enhanced'}catch{return 'enhanced'}};
 function set(mode){
  try{if(mode==='original')localStorage.setItem(key,'original');else localStorage.removeItem(key)}catch{}
  try{window.__aimMapLighting?.apply()}catch(err){console.error('MAP LIGHTING:',err)}
  dispatchEvent(new Event('aim-map-lighting-change'));
 }
 function add(){
  const anchor=document.querySelector('[data-setting="shadows"]'),parent=anchor?.parentElement;
  if(!parent||parent.querySelector('[data-setting="mapLighting"]'))return;
  const scoped=[...anchor.attributes].filter(a=>a.name.startsWith('data-v-')).map(a=>a.name);
  const row=document.createElement('div');row.className='hall-field hall-choice';row.dataset.setting='mapLighting';row.dataset.focus='mapLighting';
  row.innerHTML='<span class="hall-field-text"><span class="hall-field-head"><b>Map lighting</b><em class="hall-field-local" title="Saved on this PC only">This PC only</em></span><small>Enhanced: brighter, richer colour and contrast on maps, sharper floors at an angle. Original: the old look.</small></span><div class="hall-choice-options" role="radiogroup" aria-label="Map lighting"></div>';
  for(const el of [row,...row.querySelectorAll('*')])for(const attr of scoped)el.setAttribute(attr,'');
  const options=row.querySelector('[role=radiogroup]');
  for(const [id,label] of [['enhanced','Enhanced'],['original','Original']]){
   const b=document.createElement('button');b.type='button';b.role='radio';b.dataset.mode=id;b.textContent=label;
   for(const attr of scoped)b.setAttribute(attr,'');
   b.onclick=()=>set(id);options.append(b);
  }
  function render(){
   if(!row.isConnected){removeEventListener('aim-map-lighting-change',render);return;}
   const mode=read();
   for(const b of options.children){const on=b.dataset.mode===mode;b.classList.toggle('is-active',on);b.setAttribute('aria-checked',String(on));}
  }
  anchor.after(row);addEventListener('aim-map-lighting-change',render);render();
 }
 let queued=false;window.__aimWatchPage(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;add()})},{childList:true,subtree:true});add();
})();
