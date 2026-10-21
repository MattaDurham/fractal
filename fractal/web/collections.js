(function(){
'use strict';
let current=null,token='',lastState='',polling=false;
const $=s=>document.querySelector(s),dialog=$('#folder-dialog');
async function request(path,options={}){
 const u=new URL(path,location.href);if(current&&u.pathname.startsWith('/api/'))u.searchParams.set('collection',current);
 const headers={...options.headers};if(options.method&&options.method!=='GET'){headers['X-Fractal-Token']=token;headers['Content-Type']='application/json';}
 return fetch(u.pathname+u.search,{...options,headers});
}
async function json(path,body){const r=await request(path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),data=await r.json();if(!r.ok||data.error)throw Error(data.error||'The folder could not be opened');return data;}
function activate(id){$('#folder-message').textContent='';current=id;localStorage.setItem('fractal.collection',id);lastState='';dialog.close();window.dispatchEvent(new Event('fractal:collection'));status();}
function row(record){
 const item=document.createElement('div');item.className='saved-collection';const open=document.createElement('button');open.className='collection-open';const label=document.createElement('strong');label.textContent=record.label;const path=document.createElement('span');path.textContent=record.path;open.append(label,path);open.onclick=()=>activate(record.id);
 const forget=document.createElement('button');forget.className='collection-forget';forget.textContent='×';forget.setAttribute('aria-label','Forget '+record.label);forget.title='Remove from this list; source files stay unchanged';forget.onclick=async()=>{await json('/api/collections/forget',{id:record.id});if(current===record.id){current=null;localStorage.removeItem('fractal.collection');window.dispatchEvent(new Event('fractal:collection'));}await populate();};item.append(open,forget);return item;
}
async function populate(){try{const data=await json('/api/collections');$('#saved-folders').replaceChildren(...data.items.map(row));$('#saved-heading').hidden=!data.items.length;}catch(e){$('#folder-message').textContent=e.message;}}
function show(){populate();if(!dialog.open)dialog.showModal();}
async function open(path){
 $('#folder-message').textContent='Opening folder…';
 try{const r=await json('/api/collections/open',{path,hidden:$('#include-hidden').checked});$('#folder-message').textContent='';activate(r.id);}catch(e){$('#folder-message').textContent=e.message;}
}
async function status(){
 if(polling||!current)return;polling=true;
 const requested=current;try{const s=await json('/api/status');if(requested!==current)return;$('#source-health').textContent=s.state==='scanning'?'Indexing · '+s.files.toLocaleString()+' files':s.state==='ready'?s.files.toLocaleString()+' files'+(s.errors?' · '+s.errors+' unreadable entries':''):s.message||s.state;
  if(s.state==='ready'&&lastState!=='ready')window.dispatchEvent(new Event('fractal:scan-ready'));lastState=s.state;
 }catch(e){$('#source-health').textContent=e.message;}finally{polling=false;}
}
window.FractalFetch=request;
window.FractalSources={get current(){return current;},show,ready:(async()=>{const r=await fetch('/api/bootstrap');if(!r.ok)throw Error('The local server is unavailable');const boot=await r.json();token=boot.token;let wanted=new URLSearchParams(location.hash.slice(1)).get('collection')||localStorage.getItem('fractal.collection');current=boot.collections.some(r=>r.id===wanted)?wanted:boot.collections[0]?.id||null;populate();status();})()};
$('#folder-form').onsubmit=e=>{e.preventDefault();open($('#folder-path').value.trim());};
$('#folder-browse').onclick=async()=>{const b=$('#folder-browse');b.disabled=true;$('#folder-message').textContent='Choose a folder in the system dialog…';try{const r=await json('/api/folders/choose',{});if(r.path){$('#folder-path').value=r.path;await open(r.path);}else $('#folder-message').textContent='No folder selected.';}catch(e){$('#folder-message').textContent=e.message;}finally{b.disabled=false;}};
$('#folder-example').onclick=async()=>{try{$('#folder-message').textContent='Preparing the example…';const r=await json('/api/example',{});activate(r.id);}catch(e){$('#folder-message').textContent=e.message;}};
$('#folder-import').onclick=()=>{dialog.close();$('#dataset-dialog').showModal();};$('#folder-close').onclick=()=>dialog.close();
$('#refresh-folder').onclick=async()=>{if(!current){show();return;}try{await json('/api/collections/refresh',{});lastState='scanning';status();}catch(e){$('#source-health').textContent=e.message;}};
setInterval(status,2000);
})();
