(function(root){
'use strict';
const EXT=new Set('jpg jpeg png gif webp heic heif tif tiff bmp psd raf rw2 dng cr2 cr3 nef arw avif ico icns jp2 pdf doc docx xls xlsx ppt pptx rtf odt ods odp pages numbers key txt md py js ts tsx jsx css sql sh swift rs go ufo'.split(' '));
const fetch=(...args)=>window.FractalFetch(...args);
const entries=new Map(),loading=[],client=crypto.randomUUID();
const PIXEL_BUDGET=16_000_000;
let visible=new Set();
let enabled=true,remote=true,onChange=()=>{},onSpread=()=>{},lastItems=[],signature='',timer=0,poll=0,active=0,pixels=0,canvas,ctx,lastEpoch=0,viewer=null,focusInfo=null,focusToken=0;
const $=s=>document.querySelector(s),esc=s=>String(s),key=n=>String(n.originalId||n.id)+':'+(n.page||1);
const ext=n=>(n.label||'').split('.').pop().toLowerCase();
const safeURL=url=>{try{const u=new URL(url,location.href);return u.origin===location.origin||/^data:image\/(png|jpeg|webp);base64,/.test(url);}catch{return false;}};
function available(n){return ['file','page'].includes(n.kind)&&(n.preview?.url||EXT.has(ext(n)));}
function entry(n){return entries.get(key(n));}
function tier(size){return size<=128?128:size<=512?512:size<=1280?1280:2048;}
function isCard(m,c){return enabled&&['file','page'].includes(m.node.kind)&&m.r.w*c.k>=45&&m.r.h*c.k>=60;}
const imageWidth=image=>image.naturalWidth||image.width;
const imageHeight=image=>image.naturalHeight||image.height;
const imagePixels=image=>imageWidth(image)*imageHeight(image);
function boundedImage(image,limit){
 if(imagePixels(image)<=limit)return image;
 const scale=Math.sqrt(limit/imagePixels(image)),copy=document.createElement('canvas');
 copy.width=Math.max(1,Math.floor(imageWidth(image)*scale));copy.height=Math.max(1,Math.floor(imageHeight(image)*scale));
 copy.getContext('2d').drawImage(image,0,0,copy.width,copy.height);return copy;
}
function trimImages(){
 const share=Math.floor(PIXEL_BUDGET/Math.max(1,visible.size));
 for(const e of visible){if(e.image&&imagePixels(e.image)>share){pixels-=imagePixels(e.image);e.image=boundedImage(e.image,share);pixels+=imagePixels(e.image);}}
 for(const e of [...entries.values()].filter(e=>e.image&&!visible.has(e)).sort((a,b)=>(a.used||0)-(b.used||0))){
  if(pixels<=PIXEL_BUDGET)break;pixels-=imagePixels(e.image);e.image=null;
 }
}
function load(e,url){
 if(e.url===url&&(e.image||e.loading))return;e.url=url;e.loading=true;
 loading.push({entry:e,url,epoch:lastEpoch});pump();
}
function pump(){while(active<3&&loading.length){
 const task=loading.shift();if(task.epoch!==lastEpoch||task.entry.url!==task.url)continue;
 if(!visible.has(task.entry)){task.entry.loading=false;continue;}active++;
 const image=new Image();image.decoding='async';image.onload=()=>{
  active--;if(task.epoch===lastEpoch&&task.entry.url===task.url){
   const e=task.entry;if(e.image)pixels-=imagePixels(e.image);
   e.image=boundedImage(image,Math.floor(PIXEL_BUDGET/Math.max(1,visible.size)));e.loading=false;e.used=performance.now();pixels+=imagePixels(e.image);
   trimImages();
   onChange();
  }pump();
 };image.onerror=()=>{active--;if(task.epoch===lastEpoch&&task.entry.url===task.url){task.entry.loading=false;task.entry.status=remote?'pending':'unavailable';if(!remote)task.entry.failedURL=task.url;task.entry.meta=null;task.entry.url=null;task.entry.reason=remote?'Refreshing cached preview':'The supplied preview image could not be decoded';signature='';onChange();}pump();};image.src=task.url;
}}
function observe(marks,c,w,h){
 if(entries.size>4096){for(const[k,e]of entries){if(entries.size<=4096)break;if(!e.image&&!e.loading&&performance.now()-(e.used||0)>30000)entries.delete(k);}}
 const candidates=[];visible=new Set();
 for(const m of marks){if(!m.card||m.opacity<.5)continue;const n=m.node,k=key(n);let e=entries.get(k);
  if(!e){const canPreview=remote?available(n):!!n.preview?.url;e={node:n,status:canPreview?'pending':'unavailable',reason:canPreview?'':remote?'No passive preview for this format':'Dataset has not supplied preview pixels'};entries.set(k,e);}visible.add(e);
 }trimImages();
 for(const m of marks){
  if(!m.card||m.opacity<.5)continue;
  const n=m.node,k=key(n),size=tier(Math.min(m.r.w*c.k*.84,m.r.h*c.k*.72)*Math.min(2,devicePixelRatio||1));
  let e=entries.get(k);if(!e){const canPreview=remote?available(n):!!n.preview?.url;e={node:n,status:canPreview?'pending':'unavailable',reason:canPreview?'':remote?'No passive preview for this format':'Dataset has not supplied preview pixels'};entries.set(k,e);}
  e.used=performance.now();
  if(n.preview?.url&&safeURL(n.preview.url)){if(e.failedURL===n.preview.url)continue;e.failedURL=null;e.meta=n.preview;e.status='ready';load(e,n.preview.url);continue;}
  if(!remote||!n.originalId||!available(n))continue;
  candidates.push({node:n.originalId,page:n.page||1,size,priority:10,distance:Math.hypot((m.r.x+m.r.w/2)*c.k+c.x-w/2,(m.r.y+m.r.h/2)*c.k+c.y-h/2)});
  if(e.url&&!e.image&&!e.loading)load(e,e.url);
 }
 const needs=n=>{const e=entries.get(n.node+':'+n.page);return !e?.meta||e.status==='pending'||e.status==='ready'&&(e.meta.tier||0)<n.size;};
 lastItems=[...new Map(candidates.sort((a,b)=>Number(needs(b))-Number(needs(a))||a.distance-b.distance).slice(0,64).map(x=>[x.node+':'+x.page,x])).values()];
 clearTimeout(timer);timer=setTimeout(flush,150);
}
async function flush(){
 clearTimeout(poll);if(!remote||!enabled)return;
 const items=lastItems.filter(n=>{const e=entries.get(n.node+':'+n.page);return !e||e.status==='pending'||e.status==='ready'&&(e.meta?.tier||0)<n.size;});
 const next=items.map(x=>[x.node,x.page,x.size].join(':')).join('|');
 if(next===signature&&!items.some(n=>entries.get(n.node+':'+n.page)?.status==='pending'))return;signature=next;
 const epoch=lastEpoch;
 try{
  const response=await fetch('/api/previews/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client,items})});
  if(!response.ok)throw Error('Preview service is unavailable');const data=await response.json();if(epoch!==lastEpoch)return;
  let pending=false,changed=false;
  for(const meta of data.items){const k=meta.node+':'+(meta.page||1),e=entries.get(k)||{};entries.set(k,e);
   const before=e.status;e.meta=meta;e.status=meta.status;e.reason=meta.reason;
   if(meta.url)load(e,meta.url);if(before!==e.status)changed=true;if(e.status==='pending')pending=true;
  }
  if(changed)onChange();if(pending)poll=setTimeout(flush,450);
 }catch(error){$('#preview-health').textContent=error.message;poll=setTimeout(flush,1800);}
}
function paper(m,c){
 const r=m.r,e=entry(m.node),ratio=(e?.meta?.width||(e?.image&&imageWidth(e.image))||.77)/(e?.meta?.height||(e?.image&&imageHeight(e.image))||1);
 const margin=Math.min(r.w,r.h)*.075,box={x:r.x+margin,y:r.y+margin,w:r.w-margin*2,h:r.h*.73-margin};
 const w=Math.min(box.w,box.h*ratio),h=w/ratio;
 return {x:box.x+(box.w-w)/2,y:box.y+(box.h-h)/2,w,h};
}
function draw(marks,c,selected){
 if(!canvas)return;const b=canvas.parentElement.getBoundingClientRect(),dpr=Math.min(2,devicePixelRatio||1);
 observe(marks,c,b.width,b.height);
 if(canvas.width!==Math.round(b.width*dpr)||canvas.height!==Math.round(b.height*dpr)){canvas.width=Math.round(b.width*dpr);canvas.height=Math.round(b.height*dpr);}
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,b.width,b.height);
 for(const m of marks){if(!m.card)continue;
  const e=entry(m.node),p=paper(m,c),x=p.x*c.k+c.x,y=p.y*c.k+c.y,w=p.w*c.k,h=p.h*c.k;
  ctx.globalAlpha=m.opacity;ctx.fillStyle='#d3d1c7';ctx.fillRect(x+2,y+3,w,h);ctx.fillStyle='#fffef9';ctx.fillRect(x,y,w,h);
  if(e?.image){ctx.drawImage(e.image,x,y,w,h);}
  else{ctx.fillStyle='#8b8b7f';ctx.textAlign='center';ctx.font=`${Math.max(9,Math.min(18,w*.14))}px ui-monospace,Menlo,monospace`;ctx.fillText((ext(m.node)||'FILE').toUpperCase(),x+w/2,y+h*.46,w*.85);
   if(w>70&&h>70){ctx.font='9px -apple-system,sans-serif';const status=e?.status||((remote&&available(m.node)||m.node.preview?.url)?'pending':'unavailable'),text=status==='pending'?'Resolving preview…':status==='ready'?'Loading cached preview…':status==='withheld'?'Preview withheld':'Preview unavailable';ctx.fillText(text,x+w/2,y+h*.57,w*.9);}
  }
  ctx.strokeStyle=selected?.id===m.node.id?'#b1492d':'#d7d4c9';ctx.lineWidth=selected?.id===m.node.id?1.5:.6;ctx.strokeRect(x,y,w,h);
  if(e?.meta?.preview_source){ctx.fillStyle='#8c442e';ctx.font='10px -apple-system,sans-serif';ctx.textAlign='center';ctx.fillText(e.meta.preview_source.format+' · source preview',(m.r.x+m.r.w/2)*c.k+c.x,(m.r.y+m.r.h*.79)*c.k+c.y,m.r.w*c.k*.9);}
 }ctx.globalAlpha=1;ctx.textAlign='start';
 const ready=[...entries.values()].filter(e=>e.image).length,pending=[...visible].filter(e=>e.status==='pending').length;
 $('#preview-health').textContent=enabled?`${ready} previews · ${Math.round(pixels*4/1e6)} MB decoded${pending?' · '+pending+' resolving':''}`:'Word map';
}
function caption(node,r){
 const s=node.page?'Page '+node.page:node.label,max=42,words=s.match(new RegExp('.{1,'+max+'}(?:\\s|$)|.{1,'+max+'}','g'))||[s];
 return {lines:words.slice(0,2),x:r.x+r.w*.06,y:r.y+r.h*.84,size:Math.min(r.h*.048,r.w*.88/(Math.min(max,s.length)*.60))};
}
function reset(isRemote){lastEpoch++;remote=isRemote;signature='';lastItems=[];clearTimeout(timer);clearTimeout(poll);entries.clear();visible.clear();loading.length=0;pixels=0;}
function setEnabled(value){enabled=value;signature='';if(!value){lastItems=[];clearTimeout(timer);clearTimeout(poll);fetch('/api/previews/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client,items:[]})}).catch(()=>{});}onChange();}
async function info(node,page,token){
 for(let i=0;i<300;i++){
  const r=await fetch(`/api/previews/info?node=${node.originalId}&page=${page}`);if(!r.ok)throw Error('The preview service could not read this item');const d=await r.json();
  if(token!==focusToken)return null;if(d.status!=='pending')return d;await new Promise(resolve=>setTimeout(resolve,400));
 }throw Error('Preview is still queued. Close this view and try again shortly.');
}
async function show(node,page=node.page||1){
 const token=++focusToken,dialog=$('#document-dialog');if(!dialog.open)dialog.showModal();
 $('#document-name').textContent=node.label;$('#document-message').hidden=false;$('#document-message').textContent='Resolving the original’s preview…';
 $('#document-page').disabled=true;$('#document-prev').disabled=true;$('#document-next').disabled=true;$('#document-spread').disabled=true;
 if(viewer){viewer.destroy();viewer=null;}
 try{
  let d;
  if(!remote){if(!node.preview?.url||!safeURL(node.preview.url))throw Error('This dataset has not supplied preview pixels for this file');d={status:'ready',label:node.label,pages:1,renderer:'Dataset-supplied preview',extent:'Imported image',deep_zoom:false,large_image_url:node.preview.url};}
  else d=await info(node,page,token);
  if(!d)return;focusInfo={...d,node,page};$('#document-name').textContent=d.label||node.label;
  $('#document-provenance').textContent=d.renderer||d.reason||'';
  if(d.status==='unavailable'||d.status==='withheld'){throw Error(d.reason||'No content preview is available');}
  $('#document-page').value=page;$('#document-page').max=d.pages;$('#document-page').disabled=d.pages<=1;
  $('#document-pages').textContent='/ '+d.pages;$('#document-prev').disabled=page<=1;$('#document-next').disabled=page>=d.pages;$('#document-spread').disabled=d.pages<=1;
  const source=d.deep_zoom?{width:d.virtual_width,height:d.virtual_height,tileSize:256,tileOverlap:0,minLevel:0,maxLevel:d.max_level,getTileUrl:(level,x,y)=>d.tile_url.replace('{level}',level).replace('{x}',x).replace('{y}',y)}:{type:'image',url:d.large_image_url};
  viewer=OpenSeadragon({element:$('#document-viewer'),tileSources:source,showNavigationControl:false,showNavigator:true,navigatorPosition:'TOP_RIGHT',navigatorSizeRatio:.12,maxImageCacheCount:64,imageLoaderLimit:2,timeout:120000,maxZoomPixelRatio:3,animationTime:matchMedia('(prefers-reduced-motion: reduce)').matches?0:.25,blendTime:.15,visibilityRatio:.8,constrainDuringPan:true});
  viewer.addHandler('open',()=>{$('#document-message').hidden=true;});
  viewer.addHandler('open-failed',()=>{$('#document-message').hidden=false;$('#document-message').textContent='The detailed preview could not be loaded. Its thumbnail and original path remain in the Fractal.';});
  $('#document-provenance').textContent=d.renderer+' · '+d.extent+(d.preview_source?' · Linked '+d.preview_source.format+' source: '+d.preview_source.label:'')+(d.resolution_limit?' · viewer limited to 8,192 pixels on the long edge':'');
 }catch(error){if(token===focusToken){$('#document-message').hidden=false;$('#document-message').textContent=error.message;}}
}
function configure(options){
 canvas=$('#paper-layer');ctx=canvas.getContext('2d');onChange=options.onChange;onSpread=options.onSpread;
 $('#tables-button').onclick=()=>{setEnabled(!enabled);$('#tables-button').setAttribute('aria-pressed',String(enabled));};
 $('#document-close').onclick=()=>$('#document-dialog').close();$('#document-dialog').addEventListener('close',()=>{focusToken++;if(viewer)viewer.destroy();viewer=null;});
 $('#document-prev').onclick=()=>{if(focusInfo&&focusInfo.page>1)show(focusInfo.node,focusInfo.page-1);};
 $('#document-next').onclick=()=>{if(focusInfo&&focusInfo.page<focusInfo.pages)show(focusInfo.node,focusInfo.page+1);};
 $('#document-page').onchange=()=>{if(focusInfo)show(focusInfo.node,Math.max(1,Math.min(focusInfo.pages,parseInt($('#document-page').value)||1)));};
 $('#document-zoom-in').onclick=()=>viewer?.viewport.zoomBy(1.6);$('#document-zoom-out').onclick=()=>viewer?.viewport.zoomBy(1/1.6);$('#document-fit').onclick=()=>viewer?.viewport.goHome();
 $('#document-spread').onclick=()=>{if(focusInfo){$('#document-dialog').close();onSpread(focusInfo);}};
}
root.FractalPreviews={configure,available,isCard,draw,caption,entry,reset,enabled:()=>enabled,show,stats:()=>({images:[...entries.values()].filter(e=>e.image).length,pixels})};
})(window);
