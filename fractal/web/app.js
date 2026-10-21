(async function(){
  'use strict';
  const L=window.FractalLayout,P=window.FractalPreviews,$=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
  const board=$('#board'),svg=$('#vector'),world=$('#world');
  const fetch=(...args)=>window.FractalFetch(...args);
  const NS='http://www.w3.org/2000/svg',reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const initialRoute=new URLSearchParams(location.hash.slice(1));
  const palette={knowledge:['#e6ebdf','#bdc8b5'],software:['#e1e8e2','#b7c6bb'],work:['#eee7da','#d0c1a6'],personal:['#eee1d9','#d2baaa'],media:['#e2e8e7','#b8c7c5'],agents:['#e5e3eb','#c4becf'],machine:['#e6e7e0','#c5c8b9'],unplaced:['#efede5','#d4d0c4']};
  const state={view:'folders',root:null,stack:[],width:1600,height:1000,camera:{k:1,x:0,y:0},w:1,h:1,fitK:1,selected:null,marks:[],nodes:new Map(),children:new Map(),pending:new Map(),errors:new Map(),frame:0,animation:0,epoch:0,fetches:0,rebasing:false};
  let meta,adapter;
  const fmt=n=>Number(n||0).toLocaleString('en-US');
  const bytes=n=>{if(!n)return'0 B';const units=['B','KB','MB','GB','TB','PB'];const i=Math.min(5,Math.floor(Math.log(n)/Math.log(1000)));return (n/1000**i).toLocaleString('en-US',{maximumFractionDigits:i?1:0})+' '+units[i];};
  const el=(tag,cls,content)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(content!==undefined)e.textContent=content;return e;};
  function svgEl(tag,attrs){const e=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));return e;}
  async function api(path){const r=await fetch(path);let data;try{data=await r.json();}catch{throw Error('The local server is unavailable. Restart it and retry.');}if(!r.ok||data.error)throw Error(data.error||'The index request failed.');return data;}
  const remote={
    node:id=>api('/api/node?id='+encodeURIComponent(id)),
    children:async id=>(await api('/api/children?id='+encodeURIComponent(id))).items,
    details:id=>api('/api/details?id='+encodeURIComponent(id)),
    search:async q=>(await api('/api/search?q='+encodeURIComponent(q))).items,
    roots:{content:'content',folders:'f:1'}
  };
  function remember(n){state.nodes.set(n.id,n);return n;}
  function requestChildren(node){
    if(!node.expandable||state.children.has(node.id)||state.pending.has(node.id)||state.errors.has(node.id))return;
    if(node.pageRange){const items=pageChildren(node);items.forEach(remember);state.children.set(node.id,items);if(node.id===state.root.id)updateBrowse();schedule();return;}
    const epoch=state.epoch,id=node.id;state.fetches++;
    const p=adapter.children(id).then(items=>{
      if(epoch!==state.epoch)return;
      items.forEach(remember);state.children.set(id,items);
      if(state.children.size>1500){const protectedIds=new Set([state.root.id,...state.stack.map(f=>f.node.id)]);for(const key of state.children.keys()){if(!protectedIds.has(key)){state.children.delete(key);break;}}}
      if(id===state.root.id)updateBrowse();
    }).catch(e=>{if(epoch===state.epoch)state.errors.set(id,e.message);}).finally(()=>{
      if(epoch!==state.epoch)return;state.pending.delete(id);schedule();if(id===state.root.id)updateBrowse();
    });state.pending.set(id,p);
  }
  async function ensureNode(id){return state.nodes.get(id)||remember(await adapter.node(id));}
  function schedule(){if(!state.frame)state.frame=requestAnimationFrame(render);}
  function resize(){
    const r=board.getBoundingClientRect(),oldW=state.w,oldH=state.h;
    const wasFit=state.root&&!state.stack.at(-1)?.rect&&Math.abs(state.camera.k-state.fitK)<state.fitK*.02;
    state.w=Math.max(1,r.width);state.h=Math.max(1,r.height);
    svg.setAttribute('viewBox',`0 0 ${state.w} ${state.h}`);
    state.camera.x+=(state.w-oldW)/2;state.camera.y+=(state.h-oldH)/2;
    if(wasFit){state.width=1600;state.height=1600*state.h/state.w;state.camera=fitted();}
    if(state.root&&oldW===1)fit(false);schedule();
  }
  function fitted(){const k=Math.min(state.w/state.width,state.h/state.height)*.93;state.fitK=k;return{k,x:(state.w-state.width*k)/2,y:(state.h-state.height*k)/2};}
  function moveCamera(target,animate=true){
    cancelAnimationFrame(state.animation);state.animation=0;
    if(!animate||reduced){state.camera=target;schedule();return;}
    const from={...state.camera},start=performance.now();
    const tick=t=>{const p=L.clamp((t-start)/420,0,1),e=1-(1-p)**3;state.camera={k:Math.exp(Math.log(from.k)+(Math.log(target.k)-Math.log(from.k))*e),x:from.x+(target.x-from.x)*e,y:from.y+(target.y-from.y)*e};schedule();if(p<1)state.animation=requestAnimationFrame(tick);else state.animation=0;};
    state.animation=requestAnimationFrame(tick);
  }
  function fit(animate=true){if(state.root)moveCamera(fitted(),animate);}
  function currentFrame(){return{node:state.root,width:state.width,height:state.height,camera:{...state.camera},rect:null};}
  async function setScene(node,{push=false,rect=null,auto=false}={}){
    if(push){const frame=currentFrame();frame.rect=rect;state.stack.push(frame);}
    const old={...state.camera};state.root=remember(node);
    state.width=1600;state.height=rect?1600*rect.h/rect.w:1600*state.h/state.w;
    state.fitK=Math.min(state.w/state.width,state.h/state.height)*.93;
    if(auto&&rect)state.camera=L.rebase(old,rect);else state.camera=fitted();
    requestChildren(node);updateCrumbs();updateBrowse();schedule();
    if(adapter===remote){const route=new URLSearchParams({collection:window.FractalSources.current||'',view:state.view,node:node.pageRange?'f:'+node.originalId:node.id});history.replaceState(null,'','#'+route.toString());}
  }
  async function home(){
    cancelAnimationFrame(state.animation);state.animation=0;state.stack=[];state.selected=null;
    try{await setScene(await ensureNode(adapter.roots[state.view]));}catch(e){showError(e.message);}
  }
  function up(auto=false){
    if(!state.stack.length){if(!auto)home();return;}
    cancelAnimationFrame(state.animation);state.animation=0;
    const f=state.stack.pop();state.root=f.node;state.width=f.width;state.height=f.height;
    state.fitK=Math.min(state.w/state.width,state.h/state.height)*.93;
    state.camera=auto&&f.rect?L.unbase(state.camera,f.rect):f.camera;
    updateCrumbs();updateBrowse();schedule();
    if(adapter===remote)history.replaceState(null,'','#'+new URLSearchParams({collection:window.FractalSources.current||'',view:state.view,node:state.root.pageRange?'f:'+state.root.originalId:state.root.id}).toString());
  }
  function updateCrumbs(){
    const nav=$('#breadcrumbs');nav.replaceChildren();
    const frames=[...state.stack.map(f=>f.node),state.root];
    const shown=frames.length>6?[frames[0],...frames.slice(-5)]:frames;
    shown.forEach((n,i)=>{
      if(i)nav.append(el('span','slash','/'));
      const b=el('button','',i===0?meta.dataset.label:n.label);b.title=n.label;
      b.onclick=()=>{const index=frames.findIndex(f=>f.id===n.id);while(state.stack.length>index)up();};nav.append(b);
    });nav.scrollLeft=nav.scrollWidth;
    $('#scope').textContent=state.root.kind==='dataset'?'ALL INDEXED ENTRIES':state.root.kind==='group'?'ALPHABETICAL RANGE':state.view==='content'?'BY FILE TYPE':'FOLDERS';
    $('#file-total').textContent=state.root.pageRange?fmt(state.root.rangeEnd-state.root.rangeStart+1)+' PAGES':fmt(state.root.files)+' FILES · '+bytes(state.root.bytes);
    $('#up-button').disabled=!state.stack.length;
  }
  function updateBrowse(){
    const list=$('#browse-list');if(!state.root)return;
    const items=state.children.get(state.root.id);list.replaceChildren();
    if(state.errors.has(state.root.id)){list.append(el('p','loading-note',state.errors.get(state.root.id)));const retry=el('button','action','Retry this level');retry.onclick=()=>{state.errors.delete(state.root.id);requestChildren(state.root);};list.append(retry);return;}
    if(!items){list.append(el('p','loading-note',state.root.expandable?'Resolving this level…':'This is a file. Its source and evidence appear above.'));return;}
    if(!items.length){list.append(el('p','loading-note','No children in this region.'));return;}
    for(const n of items){
      const b=el('button','browse-row'),name=el('span','label',n.label);
      if(n.path&&n.path!==n.label)name.append(el('small','source-caption',n.path));
      b.append(el('span','symbol',n.expandable?'↳':'·'),name,el('small','',n.pageRange?fmt(n.rangeEnd-n.rangeStart+1)+' pp':n.kind==='page'?'p.'+n.page:n.kind==='file'?bytes(n.bytes):fmt(n.files)));
      b.title=(n.expandable?'Enter ':'Inspect ')+n.label+(n.path?' · '+n.path:'');
      b.onclick=()=>{select(n);if(n.expandable)setScene(n,{push:true});};list.append(b);
    }
  }
  function labelLines(label,kind,ratio=1.5){
    const max=kind==='file'?40:L.clamp(Math.round(ratio*14),7,32);
    if(label.length<=max||!label.includes(' '))return[label.length>90?label.slice(0,87)+'…':label];
    const words=label.split(' '),lines=[''];
    for(const word of words){const last=lines.length-1;if((lines[last]+' '+word).trim().length>max&&lines[last]&&lines.length<3)lines.push(word);else lines[last]+=(lines[last]?' ':'')+word;}
    if(lines[lines.length-1].length>60)lines[lines.length-1]=lines.at(-1).slice(0,57)+'…';return lines;
  }
  function collect(){
    const marks=[];let candidate=null;
    const c=state.camera;
    function visit(node,r,depth,opacity,domain,isRoot=false){
      if(depth>6||!L.visible(r,c,state.w,state.h,25))return;
      const pw=r.w*c.k,ph=r.h*c.k,min=Math.min(pw,ph),area=pw*ph;
      if(pw<3||ph<3)return;
      const detail=node.expandable?L.clamp(Math.min((min-330)/200,(Math.sqrt(area)-470)/220),0,1):0;
      let reveal=L.clamp((detail-.35)/.65,0,1),heading=L.clamp(detail/.35,0,1);
      if(isRoot)reveal=node.expandable?1:0;
      const children=state.children.get(node.id);
      if(node.expandable&&(isRoot||min>190&&area>100000))requestChildren(node);
      if(!children){reveal=0;heading=0;}
      const effectiveDomain=node.domain||domain||'unplaced';
      if(!isRoot||!node.expandable){
        marks.push({node,r,depth,opacity,reveal,heading,domain:effectiveDomain});
        const x=r.x*c.k+c.x,y=r.y*c.k+c.y;
        if(node.expandable&&depth===1&&children&&x<-state.w*.18&&y<-state.h*.18&&x+pw>state.w*1.18&&y+ph>state.h*1.18)candidate={node,r};
      }
      if(reveal>0&&children){
        const region=isRoot?r:L.inner(r);
        const fileLevel=P.enabled()&&children.length&&children.filter(n=>['file','page'].includes(n.kind)||n.pageRange).length/children.length>=.5;
        for(const child of (fileLevel?L.table:L.partition)(children,region))visit(child.node,child.rect,depth+1,opacity*reveal,effectiveDomain);
      }
    }
    visit(state.root,{x:0,y:0,w:state.width,h:state.height},0,1,'unplaced',true);
    return{marks,candidate};
  }
  function typography(mark){
    const{r,node,heading}=mark,lines=labelLines(node.label,node.kind,r.w/r.h),longest=Math.max(...lines.map(s=>s.length));
    const family=node.kind==='file'||node.kind==='symlink'?'ui-monospace, SFMono-Regular, Menlo, monospace':'Iowan Old Style, Baskerville, Georgia, serif';
    const base=Math.min(r.w*.84/Math.max(3,longest*.53),r.h*.29/Math.max(1,lines.length*.85));
    const size=base*(1-heading)+Math.min(base*.42,r.h*.12/(lines.length*1.08))*heading,x=r.x+r.w*.065,y=r.y+r.h*(.40-heading*.28);
    return{lines,longest,family,size,x,y};
  }
  function sourceCaption(node){if(!node.path||node.path===node.label)return'';const root=node.path.split('/').filter(Boolean)[0]||'Drive root';return root.length>32?root.slice(0,29)+'…':root;}
  function drawVector(marks){
    const frag=document.createDocumentFragment();
    for(const m of marks){
      const{node,r,opacity,domain,reveal}=m,[fill,line]=palette[domain]||palette.unplaced;
      const g=svgEl('g',{'data-node':node.id,opacity});
      g.append(svgEl('rect',{x:r.x+1/state.camera.k,y:r.y+1/state.camera.k,width:Math.max(0,r.w-2/state.camera.k),height:Math.max(0,r.h-2/state.camera.k),fill,'fill-opacity':m.depth>1?.75:1,stroke:line,'stroke-width':.65,class:'tile-boundary'}));
      const t=typography(m),px=t.size*state.camera.k;
      if(m.card){
        const caption=P.caption(node,r),text=svgEl('text',{x:caption.x,y:caption.y,'font-family':'ui-monospace,Menlo,monospace','font-size':caption.size,fill:'#485044'});
        caption.lines.forEach((s,i)=>{const tspan=svgEl('tspan',{x:caption.x,dy:i?caption.size*1.3:0});tspan.textContent=s;text.append(tspan);});g.append(text);
      }else if(px>=6){
        const text=svgEl('text',{x:t.x,y:t.y,'font-family':t.family,'font-size':t.size,'letter-spacing':node.kind==='file'?'-.01em':'-.045em',fill:'#2b352b'});
        t.lines.forEach((s,i)=>{const span=svgEl('tspan',{x:t.x,dy:i?t.size*1.08:0});span.textContent=s;text.append(span);});g.append(text);
        const countFont=Math.min(t.size*.29,r.h*.045),cy=t.y+t.size*(t.lines.length-1)*1.08+countFont*2.3;
        if(countFont*state.camera.k>=7&&(!reveal||cy<r.y+r.h*.22)){
          const count=svgEl('text',{x:t.x,y:cy,'font-family':'ui-monospace, Menlo, monospace','font-size':countFont,fill:'#687160'});
          count.textContent=node.kind==='file'?bytes(node.bytes):fmt(node.files)+' files'+(node.kind==='group'?' · range':'');g.append(count);
          const caption=sourceCaption(node);
          if(caption&&!reveal&&countFont*state.camera.k>=9){const source=svgEl('text',{x:t.x,y:cy+countFont*1.7,'font-family':'ui-monospace, Menlo, monospace','font-size':Math.min(countFont*.8,r.w*.86/(caption.length*.65)),fill:'#687160'});source.textContent='↳ '+caption;g.append(source);}
        }
      }
      if(state.selected?.id===node.id)g.append(svgEl('rect',{x:r.x+2/state.camera.k,y:r.y+2/state.camera.k,width:r.w-4/state.camera.k,height:r.h-4/state.camera.k,class:'selected-outline'}));
      frag.append(g);
    }
    world.replaceChildren(frag);world.setAttribute('transform',`translate(${state.camera.x} ${state.camera.y}) scale(${state.camera.k})`);
  }
  function render(){
    state.frame=0;if(!state.root)return;
    const start=performance.now(),{marks,candidate}=collect();state.marks=marks;
    for(const m of marks)m.card=P.isCard(m,state.camera);
    drawVector(marks);
    P.draw(marks,state.camera,state.selected);
    const noMarks=!marks.length;
    $('#map-message').hidden=!noMarks;
    if(noMarks)$('#map-message').textContent=meta.dataset.empty?'Choose a folder to begin.':state.errors.get(state.root.id)||(!state.root.expandable?'This is a file.':'This folder is empty.');
    const globalDepth=state.stack.length;$('#zoom-readout').textContent=Math.max(.1,state.camera.k/state.fitK).toFixed(1)+'×';
    const suffix=state.pending.size?' · resolving '+state.pending.size+' regions':'';
    $('#render-stats').textContent=`${marks.length} visible regions · depth ${globalDepth}`+suffix;
    if(!state.animation&&!state.rebasing){
      if(candidate){state.rebasing=true;setScene(candidate.node,{push:true,rect:candidate.r,auto:true}).finally(()=>state.rebasing=false);}
      else if(state.stack.at(-1)?.rect&&state.width*state.camera.k<state.w*.72&&state.height*state.camera.k<state.h*.72)up(true);
    }
  }
  function showError(message){$('#map-message').hidden=false;$('#map-message').textContent=message;}
  let detailToken=0;
  async function select(node){
    state.selected=node;schedule();const token=++detailToken;
    const panel=$('#selection');panel.replaceChildren(el('span','kind-label',node.kind),el('h2','',node.label),el('p','quiet','Reading file details…'));
    if(innerWidth<781)document.body.classList.add('show-notes');
    try{
      const d=await adapter.details(node.pageRange||node.kind==='page'?'f:'+node.originalId:node.id);if(token!==detailToken)return;
      panel.replaceChildren(el('span','kind-label',node.kind==='group'?'navigational range':node.kind),el('h2','',node.label));
      const facts=el('dl','facts');
      for(const[label,value]of(node.kind==='page'?[['Page',String(node.page)],['Source','PDF']]:[['Files',fmt(node.files)],['Size',bytes(node.bytes)]])){const cell=el('div');cell.append(el('dt','',label),el('dd','',value));facts.append(cell);}panel.append(facts);
      if(d.path)panel.append(el('div','path',d.path));
      if(P.available(node)){const inspect=el('button','document-preview-action','Inspect '+(node.kind==='page'?'page '+node.page:d.preview_source?d.preview_source.format:'document')+' ↗');inspect.onclick=()=>P.show(node);panel.append(inspect);const cached=P.entry(node);if(cached?.reason)panel.append(el('p','preview-note',cached.reason));}
      if(d.preview_source){const linked=d.preview_source;panel.append(el('span','evidence-label',linked.format+' SOURCE PREVIEW'),el('p','quiet','This file is a Markdown extraction. Its preview comes from the linked source document.'),el('p','path',linked.path),el('p','source',linked.edition_note));const b=el('button','action','Show source document ↗');b.onclick=async()=>{setViewButtons('folders');await goToSource(linked.node);await select(await ensureNode('f:'+linked.node));};panel.append(b);}
      if(d.inventory_files_in_source_folder!=null&&node.id.startsWith('r:')&&node.files!==d.inventory_files_in_source_folder)panel.append(el('p','quiet',`This topic contains ${fmt(node.files)} of the folder’s ${fmt(d.inventory_files_in_source_folder)} files. Other regions appear under their own topics.`));
      const descriptions=d.descriptions||[],inherited=d.inherited||[];
      const best=descriptions.find(x=>x.rung==='summary')||descriptions.find(x=>x.rung==='label');
      const fallback=inherited.find(x=>x.rung==='summary')||inherited.find(x=>x.rung==='label');
      const desc=best||fallback;
      if(desc){
        panel.append(el('span','evidence-label',best?'RECORDED DESCRIPTION':'INHERITED FROM '+desc.from));
        const content=desc.text;
        panel.append(el('p','description',content.length>1300?content.slice(0,650)+'…':content));
        if(content.length>1300){const full=el('details','description-disclosure');full.append(el('summary','','Read the full recorded description'),el('p','description',content));panel.append(full);}
        panel.append(el('p','source',desc.source+(desc.batch?' · '+desc.batch:'')));
        if(best&&inherited.length)panel.append(el('p','quiet','Additional context is inherited from its source folder.'));
      }else panel.append(el('p','description',d.description||'The source path stays reachable. Supported previews load on demand.'));
      if(d.region){const r=d.region;panel.append(el('span','evidence-label','WHY THIS TOPIC'),el('p','quiet',`${r.topic} · ${r.basis}${r.match?' · matched “'+r.match+'”':''}`));if(r.path)panel.append(el('p','source','Membership inherited from '+r.path));}
      if(d.method){panel.append(el('span','evidence-label','METHOD'),el('p','quiet',d.method));}
      if(node.expandable){const b=el('button','action primary','Step inside ↗');b.onclick=()=>{setScene(node,{push:true});document.body.classList.remove('show-notes');};panel.append(b);}
      if(node.originalId){
        const original=el('button','action','Show original location ↗');original.onclick=async()=>{
          setViewButtons('folders');await goToSource(node.originalId);document.body.classList.remove('show-notes');
        };panel.append(original);
      }
      if(d.ancestors?.length>1){const parent=d.ancestors.at(-2),b=el('button','action','Open parent folder');b.onclick=async()=>{setViewButtons('folders');await setScene(await ensureNode(parent.id),{push:true});document.body.classList.remove('show-notes');};panel.append(b);}
      if(d.hashes?.length){const disclosure=el('details','description-disclosure');disclosure.append(el('summary','','Recorded hashes'));for(const h of d.hashes)disclosure.append(el('p','source',h.sha256||JSON.stringify(h)));panel.append(disclosure);}
      if(d.note)panel.append(el('p','source',d.note));
    }catch(e){if(token===detailToken){panel.append(el('p','quiet',e.message));const b=el('button','action','Retry details');b.onclick=()=>select(node);panel.append(b);}}
  }
  function setViewButtons(view){state.view=view;$$('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));$('#view-note').textContent=view==='content'?'Files grouped by type. Original paths stay reachable.':'The selected folder. Source files stay unchanged.';}
  async function goToSource(nid){state.stack=[];await setScene(await ensureNode('f:1'));if(nid!==1)await setScene(await ensureNode('f:'+nid),{push:true});}
  async function switchView(view){
    if(view===state.view)return;setViewButtons(view);
    try{
      const source=state.selected?.originalId;
      if(source&&adapter===remote){
        if(view==='folders'){await goToSource(source);return;}
        const d=await adapter.details('f:'+source),region=d.region;
        if(region){state.stack=[];const root=await ensureNode('content');await setScene(root);const domain=meta.taxonomy.domains.find(x=>x.topics.some(t=>t.id===region.topic));if(domain){await setScene(await ensureNode('d:'+domain.id),{push:true});await setScene(await ensureNode('t:'+region.topic),{push:true});}return;}
      }
      await home();
    }catch(e){showError(e.message);}
  }
  function zoom(f,x=state.w/2,y=state.h/2){cancelAnimationFrame(state.animation);state.animation=0;state.camera=L.zoomAt(state.camera,f,x,y);schedule();}
  function hit(x,y){const c=state.camera,wx=(x-c.x)/c.k,wy=(y-c.y)/c.k;return [...state.marks].reverse().find(m=>m.opacity>.3&&wx>=m.r.x&&wx<=m.r.x+m.r.w&&wy>=m.r.y&&wy<=m.r.y+m.r.h);}
  let pointers=new Map(),drag=null,pinch=null,lastTap=0,lastTapId=null;
  board.addEventListener('wheel',e=>{e.preventDefault();const r=board.getBoundingClientRect(),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?state.h:1);zoom(Math.exp(-L.clamp(delta,-250,250)*.003),e.clientX-r.left,e.clientY-r.top);},{passive:false});
  board.addEventListener('pointerdown',e=>{
    if(e.button!==0&&e.pointerType!=='touch')return;
    board.focus({preventScroll:true});board.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===1){drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false};board.classList.add('dragging');}
    if(pointers.size===2){const[a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};if(drag)drag.moved=true;}
  });
  board.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===2&&pinch){
      const[a,b]=[...pointers.values()],distance=Math.hypot(a.x-b.x,a.y-b.y),x=(a.x+b.x)/2,y=(a.y+b.y)/2,r=board.getBoundingClientRect();
      zoom(distance/Math.max(1,pinch.distance),pinch.x-r.left,pinch.y-r.top);state.camera.x+=x-pinch.x;state.camera.y+=y-pinch.y;pinch={distance,x,y};schedule();return;
    }
    if(drag){if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>5)drag.moved=true;cancelAnimationFrame(state.animation);state.animation=0;state.camera.x+=e.clientX-drag.x;state.camera.y+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;schedule();}
  });
  function pointerEnd(e){
    const wasPinch=!!pinch;pointers.delete(e.pointerId);if(pointers.size<2)pinch=null;
    if(!pointers.size){board.classList.remove('dragging');if(drag&&!drag.moved&&!wasPinch){const r=board.getBoundingClientRect(),m=hit(e.clientX-r.left,e.clientY-r.top);if(m){const now=performance.now();if(now-lastTap<350&&lastTapId===m.node.id&&(m.node.expandable||P.available(m.node))){if(m.node.expandable)setScene(m.node,{push:true});else P.show(m.node);document.body.classList.remove('show-notes');lastTap=0;}else{select(m.node);lastTap=now;lastTapId=m.node.id;}}}drag=null;}
    else{const p=[...pointers.values()][0];drag={x:p.x,y:p.y,startX:p.x,startY:p.y,moved:true};}
  }
  board.addEventListener('pointerup',pointerEnd);board.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);drag=null;pinch=null;board.classList.remove('dragging');});
  board.addEventListener('keydown',e=>{
    const pan={ArrowLeft:[70,0],ArrowRight:[-70,0],ArrowUp:[0,70],ArrowDown:[0,-70]};
    if(pan[e.key]){e.preventDefault();state.camera.x+=pan[e.key][0];state.camera.y+=pan[e.key][1];schedule();}
    else if(['+','=','-','0','Escape','Home','Enter'].includes(e.key)){e.preventDefault();if(e.key==='+'||e.key==='=')zoom(1.5);if(e.key==='-')zoom(1/1.5);if(e.key==='0')fit();if(e.key==='Escape')up();if(e.key==='Home')home();if(e.key==='Enter'&&state.selected?.expandable)setScene(state.selected,{push:true});}
  });
  $('#zoom-plus').onclick=()=>zoom(1.7);$('#zoom-minus').onclick=()=>zoom(1/1.7);$('#up-button').onclick=()=>up();$('#fit-button').onclick=()=>fit();
  $$('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view));
  $('#about-button').onclick=()=>{$('#about-dialog').showModal();$('#about-button').setAttribute('aria-expanded','true');};$('#about-dialog').addEventListener('close',()=>$('#about-button').setAttribute('aria-expanded','false'));
  $('#dataset-button').onclick=()=>window.FractalSources.show();$$('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  $('#notes-button').onclick=()=>document.body.classList.toggle('show-notes');
  $('#close-details').onclick=()=>{detailToken++;state.selected=null;schedule();document.body.classList.remove('show-notes');$('#selection').replaceChildren(el('span','index-number','KEEP EXPLORING'),el('h2','','There’s more inside.'),el('p','quiet','Scroll toward a word, or choose a region below.'));};
  $('#browse-toggle').onclick=()=>{const b=$('#browse-toggle'),open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));$('#browse-list').hidden=!open;};
  let searchToken=0;
  $('#search-form').onsubmit=async e=>{
    e.preventDefault();const q=$('#search').value.trim();if(!q)return;const token=++searchToken;
    const list=$('#results-list');$('#search-results').hidden=false;list.replaceChildren(el('p','loading-note','Searching file names and paths…'));if(innerWidth<781)document.body.classList.add('show-notes');
    try{const results=await adapter.search(q);if(token!==searchToken)return;list.replaceChildren();if(!results.length)list.append(el('p','loading-note','No match. Try a file name or a /path relative to the selected folder.'));
      results.forEach(n=>{remember(n);const b=el('button','browse-row');b.append(el('span','symbol','↗'),el('span','label',n.label),el('small','',n.kind));b.onclick=()=>{select(n);if(adapter===remote&&n.originalId){setViewButtons('folders');goToSource(n.originalId);}else setScene(n,{push:true});};list.append(b);});
      if(results.length===40)list.append(el('p','loading-note','First 40 matches. Add another word to narrow the search.'));
    }catch(error){if(token===searchToken)list.replaceChildren(el('p','loading-note',error.message));}
  };
  $('#clear-search').onclick=()=>{searchToken++;$('#search-results').hidden=true;$('#search').value='';};
  // Browser-local imports and local filesystem adapters share the same renderer.
  async function useAdapter(next,nextMeta){
    P.reset(next===remote);
    state.epoch++;detailToken++;searchToken++;adapter=next;meta=nextMeta;state.nodes.clear();state.children.clear();state.pending.clear();state.errors.clear();state.stack=[];state.selected=null;
    $('#dataset-name').textContent=meta.dataset.label.toUpperCase();$('#provenance').textContent=adapter===remote?'Folder names, paths, sizes and file types. Content is read only for supported previews. No upload or cloud account.':'Browser-local dataset import. No upload.';
    $('#search-results').hidden=true;$('#search').value='';setViewButtons('folders');await home();
    $('#selection').replaceChildren(el('span','index-number','01 / '+meta.dataset.label.toUpperCase()),el('h2','','Big words. Small worlds.'),el('p','','Scroll into a folder. Its contents resolve as you get closer.'),el('p','quiet','Click for details. Double-click to step inside.'));
  }
  async function importData(data){const next=window.FractalDatasets.fromJSON(data);await useAdapter(next,next.meta);$('#dataset-dialog').close();}
  $('#dataset-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>40*1024*1024)throw Error('Use a server adapter for files larger than 40 MB.');await importData(JSON.parse(await file.text()));$('#import-message').textContent='';}catch(error){$('#import-message').textContent=error.message;}e.target.value='';};
  $('#example-button').onclick=async()=>{try{await importData(await api('/example.json'));}catch(e){$('#import-message').textContent=e.message;}};
  let originalMeta;
  async function restoreRoute(route){
    const id=route.get('node');if(!id||id.length>=2000||adapter!==remote)return;
    const view=route.get('view')==='folders'?'folders':'content',node=await ensureNode(id),base=await ensureNode(adapter.roots[view]);
    setViewButtons(view);state.stack=[];await setScene(base);if(node.id!==base.id)await setScene(node,{push:true});fit(false);
  }
  window.addEventListener('hashchange',()=>{if(originalMeta)restoreRoute(new URLSearchParams(location.hash.slice(1))).catch(e=>showError(e.message));});
  function pageChildren(node){
    const start=node.rangeStart,end=node.rangeEnd,count=end-start+1,stride=count>64?Math.ceil(count/64):1,out=[];
    for(let p=start;p<=end;p+=stride){const last=Math.min(end,p+stride-1);out.push(stride===1?{id:'p:'+node.originalId+':'+p,originalId:node.originalId,label:'Page '+p+' · '+node.sourceLabel,page:p,kind:'page',files:0,bytes:0,items:1,expandable:false}:{id:'page-range:'+node.originalId+':'+p+':'+last,originalId:node.originalId,label:'Pages '+p+'–'+last,kind:'group',files:0,bytes:0,items:last-p+1,expandable:true,pageRange:true,rangeStart:p,rangeEnd:last,sourceLabel:node.sourceLabel});}
    return out;
  }
  P.configure({onChange:schedule,onSpread:info=>{const n={id:'pages:'+info.node.originalId,originalId:info.node.originalId,label:info.node.label,kind:'pages',files:1,bytes:info.node.bytes||0,items:info.pages,expandable:true,pageRange:true,rangeStart:1,rangeEnd:info.pages,sourceLabel:info.node.label};setScene(n,{push:true});document.body.classList.remove('show-notes');}});
  $('#local-folder-button').onclick=async()=>{try{await useAdapter(remote,originalMeta);$('#dataset-dialog').close();}catch(e){$('#import-message').textContent=e.message;}};
  new ResizeObserver(resize).observe(board);resize();
  window.addEventListener('fractal:collection',async()=>{try{originalMeta=await api('/api/meta');await useAdapter(remote,originalMeta);}catch(e){showError(e.message);}});
  window.addEventListener('fractal:scan-ready',async()=>{if(adapter!==remote||!state.root)return;try{originalMeta=await api('/api/meta');const camera={...state.camera};meta=originalMeta;state.children.clear();state.errors.clear();state.root=remember(await adapter.node(state.root.id));requestChildren(state.root);updateCrumbs();updateBrowse();state.camera=camera;schedule();}catch(e){showError(e.message);}});
  try{await window.FractalSources.ready;originalMeta=await api('/api/meta');await useAdapter(remote,originalMeta);if(!initialRoute.get('collection')||initialRoute.get('collection')===window.FractalSources.current)await restoreRoute(initialRoute);fit(false);if(meta.dataset.empty)window.FractalSources.show();}catch(e){showError(e.message);$('#render-stats').textContent='Source unavailable';}
  // Observable diagnostics for review; no mutation or filesystem access.
  window.FractalDiagnostics={snapshot:()=>({dataset:meta?.dataset.label,view:state.view,root:state.root?.id,depth:state.stack.length,visible:state.marks.length,pending:state.pending.size,loaded:state.children.size,errors:[...state.errors.values()],}),validateImport:data=>{const a=window.FractalDatasets.fromJSON(data);return a.meta;}};
})();
