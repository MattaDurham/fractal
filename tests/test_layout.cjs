const assert=require('node:assert/strict');
const L=require('../fractal/web/layout.js');
let cases=0;
for(const count of [0,1,2,7,64,257]){
  const nodes=Array.from({length:count},(_,i)=>({id:String(i),files:i%7===0?0:(i+1)**3}));
  const rect={x:13,y:27,w:1600,h:950},out=L.partition(nodes,rect);
  assert.equal(out.length,count);
  const area=out.reduce((s,n)=>s+n.rect.w*n.rect.h,0);assert.ok(Math.abs(area-(count?rect.w*rect.h:0))<.0001);
  for(const{rect:r}of out){assert.ok(r.w>0&&r.h>0);assert.ok(r.x>=rect.x-.00001&&r.y>=rect.y-.00001);assert.ok(r.x+r.w<=rect.x+rect.w+.00001&&r.y+r.h<=rect.y+rect.h+.00001);}
  for(let i=0;i<out.length;i++)for(let j=i+1;j<out.length;j++){const a=out[i].rect,b=out[j].rect;assert.ok(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)<.00001||Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)<.00001);}
  assert.deepEqual(out,L.partition(nodes,rect));cases++;
}
for(const factor of [.1,.7,2,15]){
  const c={k:2.3,x:-123,y:47},p={x:413,y:221},n=L.zoomAt(c,factor,p.x,p.y);
  assert.ok(Math.abs((p.x-c.x)/c.k-(p.x-n.x)/n.k)<1e-8);assert.ok(Math.abs((p.y-c.y)/c.k-(p.y-n.y)/n.k)<1e-8);cases++;
}
for(let i=0;i<100;i++){
  const camera={k:10**(i/10-4),x:-32.7*i,y:43.1*i},rect={x:31+i,y:7+i,w:13+i*3,h:92+i};
  const returned=L.unbase(L.rebase(camera,rect),rect);
  for(const key of ['k','x','y'])assert.ok(Math.abs(returned[key]-camera[key])<Math.max(1e-7,Math.abs(camera[key])*1e-9));cases++;
}
console.log(cases+' layout, coverage and camera invariance cases passed.');
