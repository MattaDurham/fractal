(function(root){
  'use strict';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const weight=n=>Math.sqrt(Math.max(1,Number(n.files)||Number(n.items)||1));
  function partition(nodes,rect){
    const out=[];
    const floor=nodes.length?nodes.reduce((s,n)=>s+weight(n),0)/nodes.length*.18:0;
    const effective=n=>Math.max(floor,weight(n));
    function split(items,r){
      if(!items.length)return;
      if(items.length===1){out.push({node:items[0],rect:r});return;}
      const sum=items.reduce((s,n)=>s+effective(n),0);
      let accumulated=0,cut=1,best=Infinity;
      for(let i=1;i<items.length;i++){
        accumulated+=effective(items[i-1]);const diff=Math.abs(accumulated-sum/2);
        if(diff<best){best=diff;cut=i;}else break;
      }
      const ratio=items.slice(0,cut).reduce((s,n)=>s+effective(n),0)/sum;
      if(r.w>=r.h){const w=r.w*ratio;split(items.slice(0,cut),{x:r.x,y:r.y,w,h:r.h});split(items.slice(cut),{x:r.x+w,y:r.y,w:r.w-w,h:r.h});}
      else{const h=r.h*ratio;split(items.slice(0,cut),{x:r.x,y:r.y,w:r.w,h});split(items.slice(cut),{x:r.x,y:r.y+h,w:r.w,h:r.h-h});}
    }
    split(nodes,rect);return out;
  }
  function inner(r){const pad=Math.min(r.w,r.h)*.035;return{x:r.x+pad,y:r.y+r.h*.23,w:r.w-pad*2,h:r.h*.77-pad};}
  function table(nodes,r){
    if(!nodes.length)return[];
    const cols=Math.max(1,Math.min(nodes.length,Math.ceil(Math.sqrt(nodes.length*r.w/(r.h*.85))))),rows=Math.ceil(nodes.length/cols),w=r.w/cols,h=r.h/rows;
    const gap=Math.min(w,h)*.025;
    return nodes.map((node,i)=>({node,rect:{x:r.x+(i%cols)*w+gap,y:r.y+Math.floor(i/cols)*h+gap,w:w-gap*2,h:h-gap*2}}));
  }
  function zoomAt(camera,factor,x,y){const k=clamp(camera.k*factor,1e-7,1e12),f=k/camera.k;return{k,x:x-(x-camera.x)*f,y:y-(y-camera.y)*f};}
  function rebase(camera,r){return{k:camera.k*r.w/1600,x:camera.x+r.x*camera.k,y:camera.y+r.y*camera.k};}
  function unbase(camera,r){const k=camera.k*1600/r.w;return{k,x:camera.x-r.x*k,y:camera.y-r.y*k};}
  function visible(r,c,w,h,pad=0){return r.x*c.k+c.x+r.w*c.k>=-pad&&r.y*c.k+c.y+r.h*c.k>=-pad&&r.x*c.k+c.x<=w+pad&&r.y*c.k+c.y<=h+pad;}
  const api={clamp,weight,partition,table,inner,zoomAt,rebase,unbase,visible};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FractalLayout=api;
})(typeof window!=='undefined'?window:globalThis);
