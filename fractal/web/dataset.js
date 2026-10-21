(function(root){
'use strict';
const encode=s=>btoa(encodeURIComponent(s)),decode=s=>decodeURIComponent(atob(s));
  function jsonAdapter(data){
    if(data.version!==1||!data.folders||typeof data.label!=='string')throw Error('Expected version: 1, label, and a folders tree. Download the example for the format.');
    const nodes=new Map(),children=new Map(),details=new Map(),canonical=new Set(),leaves=[],visiting=new WeakSet();let total=0;
    function walk(source,parent,path,prefix,original=false,depth=0){
      if(depth>100)throw Error('The dataset exceeds 100 nested levels.');
      if(!source||typeof source!=='object'||visiting.has(source))throw Error('Invalid or cyclic tree.');visiting.add(source);
      if(typeof source.id!=='string'||!source.id||typeof source.label!=='string')throw Error('Every item needs a nonempty string id and label.');
      const id=prefix+source.id;if(nodes.has(id))throw Error('Duplicate item ID: '+source.id);
      if(++total>200000)throw Error('This browser importer supports 200,000 nodes. Use a server adapter for a larger collection.');
      if(source.bytes!==undefined&&(!Number.isFinite(source.bytes)||source.bytes<0))throw Error('File bytes must be a nonnegative number.');
      if(source.children!==undefined&&!Array.isArray(source.children))throw Error('children must be an array.');
      const kind=source.kind||(source.children?'directory':'file');
      if(!['file','directory','symlink','other','topic','domain','dataset'].includes(kind))throw Error('Unknown kind: '+kind);
      if(kind==='file'&&source.children?.length)throw Error('Files cannot contain children.');
      const node={id,label:source.label,kind,files:kind==='file'?1:0,bytes:Number(source.bytes)||0,items:1,expandable:!!source.children?.length};
      if(source.preview!==undefined){
        const p=source.preview,url=p?.url;
        if(typeof url!=='string'||url.length>2000000||!(/^data:image\/(png|jpeg|webp);base64,/.test(url)||url.startsWith('/')&&!url.startsWith('//')))throw Error('Preview URLs must be an embedded raster image or a same-origin path.');
        node.preview={url,width:Number(p.width)||0,height:Number(p.height)||0};
      }
      nodes.set(id,node);if(original)canonical.add(source.id);
      const newpath=path+'/'+source.label;details.set(id,{node,path:newpath,description:source.description||'Imported dataset item.',ancestors:[...(parent?(details.get(parent)?.ancestors||[]):[]),{id,label:node.label}]});
      const kids=(source.children||[]).map(child=>walk(child,id,newpath,prefix,original,depth+1));children.set(id,kids);
      if(kids.length){node.files=kids.reduce((s,n)=>s+n.files,0);node.bytes=kids.reduce((s,n)=>s+n.bytes,0);node.items=1+kids.reduce((s,n)=>s+n.items,0);}
      if(original&&!kids.length)leaves.push({node,source,path:newpath});visiting.delete(source);return node;
    }
    const folderRoot=walk(data.folders,null,'','j:',true);let contentRoot;
    if(data.content){
      contentRoot=walk(data.content,null,'','c:');
    }else{
      const topics=new Map();for(const leaf of leaves){const topic=leaf.source.topic||'Unclassified & mixed';if(!topics.has(topic))topics.set(topic,[]);topics.get(topic).push(leaf);}
      contentRoot={id:'local-content',label:data.label,kind:'dataset',files:folderRoot.files,bytes:folderRoot.bytes,items:folderRoot.items,expandable:topics.size>0};nodes.set(contentRoot.id,contentRoot);
      const topicNodes=[...topics].map(([name,items],i)=>{const node={id:'local-topic:'+i,label:name,kind:'topic',files:items.reduce((s,x)=>s+x.node.files,0),bytes:items.reduce((s,x)=>s+x.node.bytes,0),items:items.length,expandable:true};nodes.set(node.id,node);children.set(node.id,items.map(x=>x.node));details.set(node.id,{node,description:'Grouped by the explicit topic field supplied with each item.'});return node;});children.set(contentRoot.id,topicNodes);details.set(contentRoot.id,{node:contentRoot,description:data.description||'Browser-local dataset. Content topics come from its supplied metadata.'});
    }
    function raw(id){if(id.startsWith('b:')){const[p,a,b]=JSON.parse(decode(id.slice(2)));return raw(p).slice(a,b);}return children.get(id)||[];}
    function grouped(id){const items=raw(id);if(items.length<=36)return items;let parent=id,start=0;if(id.startsWith('b:'))[parent,start]=JSON.parse(decode(id.slice(2)));const size=Math.ceil(items.length/36),out=[];for(let i=0;i<items.length;i+=size){const part=items.slice(i,i+size),n={id:'b:'+encode(JSON.stringify([parent,start+i,start+i+part.length])),label:part[0].label.slice(0,22)+' … '+part.at(-1).label.slice(0,22),kind:'group',files:part.reduce((s,n)=>s+n.files,0),bytes:part.reduce((s,n)=>s+n.bytes,0),items:part.length,expandable:true};nodes.set(n.id,n);out.push(n);}return out;}
    return{roots:{content:contentRoot.id,folders:folderRoot.id},meta:{dataset:{label:data.label,files:folderRoot.files,bytes:folderRoot.bytes,items:folderRoot.items},taxonomy:{domains:[]}},node:async id=>{if(!nodes.has(id))throw Error('Unknown dataset node');return nodes.get(id);},children:async id=>grouped(id),details:async id=>details.get(id)||{node:nodes.get(id),description:'Alphabetical navigation range.'},search:async q=>[...nodes.values()].filter(n=>(n.label+' '+(details.get(n.id)?.description||'')).toLowerCase().includes(q.toLowerCase())).slice(0,40)};
  }

const api={fromJSON:jsonAdapter};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FractalDatasets=api;
})(typeof window!=='undefined'?window:globalThis);
