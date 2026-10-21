const assert=require('node:assert/strict'),fs=require('node:fs');
const {fromJSON}=require('../fractal/web/dataset.js');
(async()=>{
 let cases=0;
 const example=JSON.parse(fs.readFileSync('./fractal/web/example.json','utf8')),adapter=fromJSON(example);
 assert.equal(adapter.meta.dataset.files,2);assert.equal(adapter.meta.dataset.bytes,700);cases++;
 const topics=await adapter.children(adapter.roots.content);assert.equal(topics.length,2);
 assert.equal(topics.reduce((s,n)=>s+n.files,0),2);cases++;
 const leaf=(await adapter.children(topics[0].id))[0],details=await adapter.details(leaf.id);
 assert.equal(details.ancestors.at(-1).id,leaf.id);assert.equal(details.ancestors.at(-2).label,'Field notes');cases++;
 assert.equal((await adapter.search('synthetic')).length,2);cases++;
 for(const data of [
  {version:2,label:'bad',folders:{}},
  {version:1,label:'bad',folders:{id:'x',label:'x',children:[{id:'x',label:'duplicate'}]}},
  {version:1,label:'bad',folders:{id:'x',label:'x',kind:'file',bytes:-1}},
  {version:1,label:'bad',folders:{id:'x',label:'x',kind:'file',children:[{id:'y',label:'y'}]}}
 ]){assert.throws(()=>fromJSON(data));cases++;}
 const big=fromJSON({version:1,label:'Unicode',folders:{id:'世界',label:'世界',kind:'directory',children:Array.from({length:10001},(_,i)=>({id:'файл'+i,label:'Filename '+i,kind:'file',bytes:i,topic:'A topic'}))}});
 const root=big.roots.folders,stack=await big.children(root),found=[];
 while(stack.length){const n=stack.pop();if(n.kind==='group'){const kids=await big.children(n.id);assert.ok(kids.length<=36);stack.push(...kids);}else found.push(n.id);}
 assert.equal(found.length,10001);assert.equal(new Set(found).size,10001);cases++;
 console.log(cases+' dataset import, metadata, validation and Unicode coverage cases passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
