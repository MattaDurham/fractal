// Execute the production preview loop with synthetic oversized decoded images.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(process.argv[2]||require('node:path').join(__dirname,'../fractal/web/previews.js'),'utf8');
let pending=[],loads=0,dirty=false,now=1,dimensions={w:2048,h:2662};
const context={setTransform(){},clearRect(){},fillRect(){},strokeRect(){},fillText(){},drawImage(){}};
function element(){return {width:1,height:1,getContext:()=>context,parentElement:{getBoundingClientRect:()=>({width:1800,height:1800})},addEventListener(){},setAttribute(){}};}
const elements=new Map();const document={querySelector(s){if(!elements.has(s))elements.set(s,element());return elements.get(s);},createElement:()=>element()};
class FakeImage {set src(url){this.url=url;this.naturalWidth=dimensions.w;this.naturalHeight=dimensions.h;loads++;pending.push(this);}}
const sandbox={window:{},document,Image:FakeImage,URL,location:{href:'http://127.0.0.1:8768/',origin:'http://127.0.0.1:8768'},crypto:require('node:crypto'),performance:{now:()=>now++},devicePixelRatio:2,setTimeout:()=>1,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({items:[]})})};
vm.runInNewContext(source,sandbox);const P=sandbox.window.FractalPreviews;
P.configure({onChange:()=>{dirty=true;},onSpread(){}});P.reset(false);
const node=i=>({id:'f'+i,label:'Page '+i+'.md',kind:'file',preview:{url:'/synthetic/'+i+'.jpg',width:2048,height:2662}});
const marks=Array.from({length:8},(_,i)=>({node:node(i),r:{x:i%4*400,y:Math.floor(i/4)*800,w:400,h:800},card:true,opacity:1}));
let current=marks.slice(0,4);const draw=()=>P.draw(current,{k:1,x:0,y:0},null);
function settle(){
 for(let n=0;n<100;n++){
  dirty=false;if(pending.length)pending.shift().onload();
  if(dirty)draw();
  assert.ok(P.stats().pixels<=16_000_000,'retained image pixels must stay bounded');
  if(!pending.length&&!dirty)return;
 }
 throw Error('Image cache never settles: visible previews are being evicted and reloaded');
}
let cases=0;
draw();settle();assert.equal(loads,4);assert.ok(current.every(m=>P.entry(m.node).image));cases++;
for(let i=0;i<40;i++)draw();settle();assert.equal(loads,4,'idle redraws must not reload visible pixels');cases++;
current=marks.slice(4);draw();settle();assert.equal(loads,8);assert.ok(current.every(m=>P.entry(m.node).image));cases++;
current=marks.slice(0,4);draw();settle();assert.equal(loads,12);assert.ok(current.every(m=>P.entry(m.node).image));cases++;
const old=P.entry(current[0].node).image;current[0].node.preview.url='/synthetic/sharper.jpg';draw();assert.equal(P.entry(current[0].node).image,old,'keep coarse preview until sharper pixels finish');settle();assert.notEqual(P.entry(current[0].node).image,old);cases++;
P.reset(false);dimensions={w:9000,h:6000};current=[marks[0]];draw();settle();assert.equal(P.stats().images,1);assert.ok(P.stats().pixels<=16_000_000,'one oversized imported image is downsampled too');cases++;
// Reset while a decode is in flight: its callback must not corrupt the new cache.
P.reset(false);current=marks.slice(0,4);draw();P.reset(false);current=[marks[7]];draw();settle();assert.equal(P.stats().images,1);assert.ok(P.entry(current[0].node).image);cases++;
P.reset(false);current=[marks[0]];current[0].node.preview.url='/synthetic/invalid.jpg';const beforeBad=loads;draw();pending.shift().onerror();if(dirty)draw();settle();for(let i=0;i<20;i++)draw();assert.equal(loads,beforeBad+1,'an undecodable imported image must not retry forever');assert.equal(P.entry(current[0].node).status,'unavailable');cases++;
console.log(cases+' preview cache stability scenarios passed; visible images settle and remain within 16 million pixels.');
