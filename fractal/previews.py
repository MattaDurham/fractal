"""Bounded, passive thumbnail service. Manifest read-only; derived cache + access receipts here.

One renderer worker, viewport cancellation, existing-hash deduplication, fingerprint
invalidation, one-writer index lock, exact page/extent receipts and a 2 GB disk budget.
"""
import base64, contextlib, hashlib, json, math, os, queue, re, sqlite3, subprocess, threading, time, sys
from pathlib import Path

HERE=Path(__file__).resolve().parent
from .paths import data_dir
IMAGE_EXTS=set('jpg jpeg png gif webp heic heif tif tiff bmp psd raf rw2 dng cr2 cr3 nef arw avif ico icns jp2'.split())
OFFICE_EXTS=set('doc docx xls xlsx ppt pptx rtf odt ods odp pages numbers key'.split())
TEXT_EXTS=set('txt md py js ts tsx jsx css sql sh swift rs go'.split())
ELIGIBLE=IMAGE_EXTS|OFFICE_EXTS|TEXT_EXTS|{'pdf','ufo'}
SECRET=re.compile(r'credential|password|api.?key|recovery phrase|secret key|private key|access token|\blogins\b',re.I)
NAME_SECRET=re.compile(r'password|credential|keychain|recovery.?phrase|id_rsa|id_ed25519|(^|[._ -])(secret|token|tokens|api.?key|private.?key|seed)([._ -]|$)|^\.env',re.I)
TIERS=(128,512,1280,2048)
VERSION='fractal-preview-0.1.0'

@contextlib.contextmanager
def index_lock(index=None,operation='preview cache'):
    root=Path(index) if index else data_dir()
    lock=Path(os.environ['FRACTAL_WRITE_LOCK']) if os.environ.get('FRACTAL_WRITE_LOCK') else root/'.write-lock'
    lock.mkdir()
    try:
        (lock/'owner.json').write_text(json.dumps({'pid':os.getpid(),'operation':operation,'started_at':time.time()}))
        yield
    finally:
        (lock/'owner.json').unlink(missing_ok=True);lock.rmdir()

def connect_manifest(path):
    c=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=3);c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON');return c

def tier_for(size):
    size=int(size)
    if size<1 or size>4096:raise ValueError('Invalid thumbnail size')
    return next((n for n in TIERS if n>=size),TIERS[-1])

def content_identity(node,stat,observation,volume_verified=False):
    if observation and observation['source_size']==stat.st_size and observation['source_mtime_ns']==stat.st_mtime_ns:
        fields={'source_ctime_ns':stat.st_ctime_ns,'source_inode':stat.st_ino}
        if not volume_verified:fields['source_device']=stat.st_dev
        if all(observation.get(k) is None or observation[k]==v for k,v in fields.items()):
            return 'sha256:'+observation['sha256'],observation['sha256']
    return f'node:{node}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}',None

class PreviewService:
    def __init__(self,root,manifest,drive,budget=2_000_000_000,start=True,state=None,native=None):
        self.root=Path(root);self.manifest=Path(manifest);self.drive=Path(drive)
        self.index=Path(state) if state else self.root
        self.cache=self.root/'cache';self.db=self.cache/'previews.sqlite';self.budget=budget
        self.native=native
        links=self.root/'preview-links.json'
        self.preview_links=json.loads(links.read_text()).get('mappings',[]) if links.is_file() else []
        self.expected_uuid=None;self.volume_verified=False;self.volume_device=None
        with contextlib.closing(connect_manifest(self.manifest)) as c:
            if c.execute("SELECT 1 FROM sqlite_master WHERE name='meta'").fetchone():
                identity=c.execute("SELECT value FROM meta WHERE key='source_identity'").fetchone()
                if identity:self.expected_uuid=json.loads(identity[0]).get('VolumeUUID')
        self.verify_volume()
        self.jobs=queue.PriorityQueue();self.pending={};self.clients={};self.mutex=threading.RLock();self.counter=0
        self.paused=False;self.busy=False;self.stopped=False;self.source_cache={};self.hits=0;self.misses=0;self.finished=0
        with index_lock(self.index,'initialize preview cache'):
            self.cache.mkdir(exist_ok=True);(self.cache/'objects').mkdir(exist_ok=True);(self.cache/'tmp').mkdir(exist_ok=True)
            with contextlib.closing(self.connection()) as c, c:c.executescript('''
                CREATE TABLE IF NOT EXISTS objects(key TEXT PRIMARY KEY,node INTEGER,page INTEGER,tier INTEGER,kind TEXT,status TEXT,path TEXT,bytes INTEGER DEFAULT 0,metadata TEXT,reason TEXT,created REAL,last_used REAL);
                CREATE TABLE IF NOT EXISTS accesses(id INTEGER PRIMARY KEY,node INTEGER,path TEXT,page INTEGER,request TEXT,source_size INTEGER,source_mtime_ns TEXT,source_ctime_ns TEXT,known_sha256 TEXT,prior_receipt TEXT,status TEXT,renderer TEXT,extent TEXT,duration_ms REAL,object_key TEXT,observed_at REAL);
                CREATE INDEX IF NOT EXISTS accesses_node ON accesses(node);
                CREATE TABLE IF NOT EXISTS sources(node INTEGER PRIMARY KEY,identity TEXT,metadata TEXT,reason TEXT,observed_at REAL);
            ''')
        self.thread=threading.Thread(target=self.worker,name='Atlas passive preview worker',daemon=True)
        if start:self.thread.start()
    def connection(self):
        c=sqlite3.connect(self.db,timeout=3);c.row_factory=sqlite3.Row;return c
    def verify_volume(self):
        self.volume_device=self.drive.stat().st_dev
        self.volume_verified=False
    def source(self,node):
        self.verify_volume()
        node=int(node)
        if node<=1:raise ValueError('Choose an inventoried file')
        cached=self.source_cache.get(node)
        if cached and time.monotonic()-cached[0]<5:return cached[1]
        with contextlib.closing(connect_manifest(self.manifest)) as c:
            own=c.execute('SELECT id,parent_id,name,kind,size FROM entries WHERE id=?',(node,)).fetchone()
            if own is None or own['kind']!='file':raise ValueError('Only regular inventoried files can be previewed')
            names=[];parent=node;seen=set()
            while parent!=1:
                if parent in seen:raise ValueError('Inventory parent cycle')
                seen.add(parent);r=c.execute('SELECT id,parent_id,name,kind FROM entries WHERE id=?',(parent,)).fetchone()
                if r is None or r['kind']=='symlink':raise ValueError('Source path unavailable')
                names.append(os.fsdecode(r['name']));parent=r['parent_id']
            path=self.drive.joinpath(*reversed(names))
            # No symlink in the physical path is followed, and nothing leaves the drive.
            p=self.drive
            for component in reversed(names):
                if component in ('','.','..') or '/' in component:raise ValueError('Invalid source path')
                p=p/component
                if p.is_symlink():raise ValueError('Linked source is not opened')
            stat=path.stat(follow_symlinks=False)
            if not path.is_file():raise ValueError('Original is not a regular file')
            descriptions=c.execute("SELECT text,source FROM descriptions WHERE node_id=? AND rung IN ('label','summary')",(node,)).fetchall()
            evidence=[r['source'] for r in descriptions]
            withheld=bool(NAME_SECRET.search(path.name) or path.suffix.lower() in ('.key','.pem','.p12','.pfx','.kdbx','.keystore') or any(SECRET.search(r['text']) for r in descriptions))
            observation=c.execute('SELECT * FROM file_hash_observations WHERE node_id=?',(node,)).fetchone()
            prior=c.execute('SELECT receipt_id FROM analysis_receipts WHERE node_id=? LIMIT 1',(node,)).fetchone()
            identity,sha=content_identity(node,stat,dict(observation) if observation else None,self.volume_verified)
        info={'node':node,'path':str(path),'ext':path.suffix.lower().lstrip('.'),'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'ctime_ns':stat.st_ctime_ns,
              'identity':identity,'known_sha256':sha,'prior_receipt':prior[0] if prior else None,'evidence_sources':evidence,'withheld':withheld,'ancestors':seen}
        if len(self.source_cache)>2048:self.source_cache.pop(next(iter(self.source_cache)))
        self.source_cache[node]=(time.monotonic(),info);return info
    def linked_source(self,node):
        """Resolve an explicitly configured extraction tree, never a basename guess."""
        source=self.source(node)
        if source['withheld']:return source,None
        for mapping in self.preview_links:
            if mapping['mirror_root'] not in source['ancestors']:continue
            try:
                relative=Path(source['path']).relative_to(self.drive/mapping['mirror_path'])
                suffix=mapping.get('suffix','.md')
                if not relative.name.endswith(suffix):continue
                original=relative.with_name(relative.name[:-len(suffix)])
                if original.suffix.lower().lstrip('.') not in ELIGIBLE:continue
                target=mapping['original_root']
                with contextlib.closing(connect_manifest(self.manifest)) as c:
                    for part in original.parts:
                        if part in ('','.','..'):raise ValueError('Invalid linked path')
                        rows=c.execute('SELECT id,kind FROM entries WHERE parent_id=? AND name=?',(target,os.fsencode(part))).fetchall()
                        if len(rows)!=1 or rows[0]['kind']=='symlink':raise ValueError('Linked original missing or ambiguous')
                        target=rows[0]['id']
                linked=self.source(target)
                expected=self.drive/mapping['original_path']/original
                if Path(linked['path'])!=expected or linked['withheld']:continue
                return linked,{'node':target,'path':linked['path'],'label':expected.name,'format':linked['ext'].upper(),
                    'mirror_node':node,'mirror_path':source['path'],'basis':mapping['basis'],'edition_note':mapping.get('edition_note','Linked source; not a duplicate claim')}
            except (ValueError,OSError,KeyError):continue
        return source,None
    def describe_link(self,node):
        return self.linked_source(node)[1]
    def key(self,source,page,tier,kind='thumbnail'):
        return hashlib.sha256(f'{VERSION}|{source["identity"]}|{page}|{tier}|{kind}'.encode()).hexdigest()
    def object(self,key):
        with contextlib.closing(self.connection()) as c, c:r=c.execute('SELECT * FROM objects WHERE key=?',(key,)).fetchone()
        if not r:return None
        d=dict(r);d['metadata']=json.loads(d['metadata'] or '{}')
        if d['status']=='evicted':return None
        if d['status']=='ready' and not (self.cache/d['path']).is_file():return None
        return d
    def public(self,source,page,tier):
        if source['withheld']:return {'node':source['node'],'page':page,'tier':tier,'status':'withheld','reason':'Credential-bearing filename or recorded credential location; preview withheld'}
        key=self.key(source,page,tier);obj=self.object(key)
        if obj:
            self.hits+=1
            return {'node':source['node'],'page':page,'tier':tier,'status':obj['status'],'key':key,'url':'/api/previews/image?key='+key if obj['status']=='ready' else None,'reason':obj['reason'],**obj['metadata']}
        # Display an already-cached lower/higher tier immediately while the desired tier runs.
        fallback=None
        for other in reversed(TIERS):
            if other==tier:continue
            candidate=self.object(self.key(source,page,other))
            if candidate and candidate['status']=='ready':fallback=candidate;break
        result={'node':source['node'],'page':page,'tier':tier,'status':'pending','key':key}
        if fallback:result.update(url='/api/previews/image?key='+fallback['key'],**fallback['metadata'])
        if source['withheld']:result.update(status='withheld',reason='Recorded credential location; preview withheld')
        elif source['ext'] not in ELIGIBLE:result.update(status='unavailable',reason='No passive preview renderer for this file type')
        elif source['size']==0:result.update(status='unavailable',reason='This file is empty')
        return result
    def request(self,client,items):
        if not isinstance(client,str) or len(client)>100 or not isinstance(items,list) or len(items)>96:raise ValueError('Invalid preview request batch')
        results=[];wanted=set()
        for item in items:
            try:
                requested=int(item['node']);source,link=self.linked_source(requested);page=int(item.get('page',1));tier=tier_for(item.get('size',512))
                if not 1<=page<=100000:raise ValueError('Invalid page number')
                result=self.public(source,page,tier);result['node']=requested
                if link:result['preview_source']=link
                key=self.key(source,page,tier);wanted.add(key)
                if result['status']=='pending':self.enqueue(key,source,page,tier,'thumbnail',priority=int(item.get('priority',10)))
                results.append(result)
            except (ValueError,OSError,sqlite3.Error,KeyError,TypeError) as e:results.append({'node':item.get('node'),'page':item.get('page',1),'status':'unavailable','reason':str(e)})
        with self.mutex:self.clients[client]=(time.monotonic(),wanted)
        return {'items':results,'queue':len(self.pending),'paused':self.paused}
    def enqueue(self,key,source,page,tier,kind,priority=10,extra=None):
        with self.mutex:
            if key in self.pending:return self.pending[key]
            self.counter+=1;job={'key':key,'source':source,'page':page,'tier':tier,'kind':kind,'extra':extra or {},'event':threading.Event(),'result':None,'priority':max(0,min(20,priority))}
            self.pending[key]=job;self.jobs.put((job['priority'],self.counter,key));self.misses+=1;return job
    def wanted(self,key):
        now=time.monotonic()
        with self.mutex:return any(now-t<20 and key in keys for t,keys in self.clients.values())
    def worker(self):
        while not self.stopped:
            if self.paused:time.sleep(.05);continue
            try:priority,sequence,key=self.jobs.get(timeout=.2)
            except queue.Empty:continue
            with self.mutex:job=self.pending.get(key)
            if not job:self.jobs.task_done();continue
            # A short grace period permits the request's viewport set to arrive first.
            if priority>0 and not self.wanted(key):
                time.sleep(.025)
                if not self.wanted(key):
                    with self.mutex:self.pending.pop(key,None)
                    job['result']={'status':'cancelled'};job['event'].set();self.jobs.task_done();continue
            self.busy=True
            try:
                while not self.stopped:
                    try:
                        with index_lock(self.index,'passive original preview + receipt'):self.generate(job)
                        break
                    except FileExistsError:
                        self.busy=False;time.sleep(.2)
                        if self.paused:break
                        self.busy=True
                if self.paused and job['result'] is None:
                    self.counter+=1;self.jobs.put((priority,self.counter,key));self.jobs.task_done();continue
            except Exception:
                job['result']={'status':'unavailable','reason':'Preview processing failed; see cache access receipts'}
            finally:self.busy=False
            with self.mutex:self.pending.pop(key,None)
            job['event'].set();self.jobs.task_done()
    def render(self,source,page,tier,output,extra):
        req={'path':source['path'],'output':str(output),'edge':tier,'page':page,**extra}
        commands=[]
        if self.native and source['ext'] in (IMAGE_EXTS|OFFICE_EXTS|{'pdf'}):commands.append([str(self.native)])
        commands.append([sys.executable,'-m','fractal.render'])
        result={'ok':False,'error':'No compatible passive renderer'}
        for command in commands:
            try:
                p=subprocess.run(command,input=json.dumps(req),text=True,capture_output=True,timeout=25,cwd=str(HERE.parent),env={**os.environ,'TMPDIR':str(self.cache/'tmp')})
                result=json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else {'ok':False,'error':'Preview renderer returned no image'}
                if result.get('ok'):break
            except subprocess.TimeoutExpired:result={'ok':False,'error':'Preview renderer timed out'}
            except (OSError,ValueError,IndexError):result={'ok':False,'error':'Preview renderer unavailable or failed'}
        return result
    def generate(self,job):
        source=job['source'];key=job['key'];page=job['page'];tier=job['tier'];start=time.monotonic()
        physical=self.drive
        if physical.is_symlink():
            self.source_cache.pop(source['node'],None);raise ValueError('Linked source root is not opened')
        for part in Path(source['path']).relative_to(self.drive).parts:
            physical=physical/part
            if physical.is_symlink():
                self.source_cache.pop(source['node'],None);raise ValueError('Linked source is not opened')
        current=Path(source['path']).stat(follow_symlinks=False)
        if (current.st_size,current.st_mtime_ns,current.st_ctime_ns)!=(source['size'],source['mtime_ns'],source['ctime_ns']):
            job['result']={'status':'unavailable','reason':'Source edition changed; refresh the view'};return
        tmp=self.cache/'tmp'/(key+'.jpg');tmp.unlink(missing_ok=True)
        result=self.render(source,page,tier,tmp,job['extra'])
        result['page']=page
        try:
            after=Path(source['path']).stat(follow_symlinks=False)
            if (current.st_size,current.st_mtime_ns,current.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):result={'ok':False,'error':'Source changed during preview'}
        except OSError:result={'ok':False,'error':'Source became unavailable during preview'}
        status='ready' if result.get('ok') and tmp.is_file() else 'unavailable'
        path=None;size=0;reason=None if status=='ready' else result.get('error','Cannot preview this format')
        if status=='ready':
            path='objects/'+key[:2]+'/'+key+'.jpg';dest=self.cache/path;dest.parent.mkdir(exist_ok=True);tmp.replace(dest);size=dest.stat().st_size
        tmp.unlink(missing_ok=True);duration=(time.monotonic()-start)*1000;now=time.time()
        with contextlib.closing(self.connection()) as c, c:
            c.execute('INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(key,source['node'],page,tier,job['kind'],status,path,size,json.dumps(result),reason,now,now))
            c.execute('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?)',(source['node'],source['identity'],json.dumps(result),reason,now))
            c.execute('INSERT INTO accesses(node,path,page,request,source_size,source_mtime_ns,source_ctime_ns,known_sha256,prior_receipt,status,renderer,extent,duration_ms,object_key,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (source['node'],source['path'],page,job['kind']+':'+str(tier),source['size'],str(source['mtime_ns']),str(source['ctime_ns']),source['known_sha256'],source['prior_receipt'],status,result.get('renderer'),result.get('extent','Decoder attempt; no whole-content reading claim'),duration,key,now))
            total=c.execute('SELECT coalesce(sum(bytes),0) FROM objects WHERE status="ready"').fetchone()[0]
            if total>self.budget:
                for old in c.execute('SELECT key,path,bytes FROM objects WHERE status="ready" AND key<>? ORDER BY last_used',(key,)).fetchall():
                    (self.cache/old['path']).unlink(missing_ok=True);c.execute('UPDATE objects SET status="evicted",bytes=0,path=NULL WHERE key=?',(old['key'],));total-=old['bytes']
                    if total<=self.budget:break
        self.finished+=1;job['result']={'status':status,'reason':reason,'key':key,'duration_ms':round(duration,2),**result}
    def info(self,node,page=1):
        source,link=self.linked_source(node);target=source['node']
        with contextlib.closing(self.connection()) as c, c:r=c.execute('SELECT * FROM sources WHERE node=?',(target,)).fetchone()
        stored=json.loads(r['metadata']) if r and r['identity']==source['identity'] else {}
        fields=('width','height','pages','renderer','extent','ok')
        metadata={k:v for k,v in stored.items() if k in fields} if stored.get('page')==page else {}
        result=self.public(source,page,512)
        if result['status']=='pending':
            key=self.key(source,page,512);self.enqueue(key,source,page,512,'thumbnail',priority=0)
        metadata={**metadata,**{k:v for k,v in result.items() if k in ('width','height','pages','renderer','extent','ok')}}
        width,height=metadata.get('width',0),metadata.get('height',0)
        scale=min(1,8192/max(1,width,height)) if source['ext'] in IMAGE_EXTS else 1;vw=max(1,round(width*scale));vh=max(1,round(height*scale))
        native=source['ext']=='pdf' or source['ext'] in IMAGE_EXTS
        return {**result,**metadata,'node':node,'page':page,'pages':metadata.get('pages',stored.get('pages',1)),'label':Path(source['path']).name,
                'deep_zoom':bool(metadata.get('ok') and native),'virtual_width':vw,'virtual_height':vh,'tile_size':256,'max_level':math.ceil(math.log2(max(vw,vh))),
                'tile_url':f'/api/previews/tile?node={target}&page={page}&level={{level}}&x={{x}}&y={{y}}','large_image_url':f'/api/previews/full?node={target}&page={page}',
                'preview_source':link,'source_width':width,'source_height':height,'resolution_limit':8192 if scale<1 else None}
    def file(self,key):
        if not re.fullmatch('[0-9a-f]{64}',key):raise ValueError('Invalid preview object key')
        obj=self.object(key)
        if not obj or obj['status']!='ready':raise FileNotFoundError('Preview not cached')
        return self.cache/obj['path']
    def tile(self,node,page,level,x,y):
        info=self.info(node,page)
        source,link=self.linked_source(node)
        if source['withheld']:raise ValueError('Credential location; preview withheld')
        if not info.get('deep_zoom'):raise ValueError('Document preview is not ready')
        level,x,y=map(int,(level,x,y));maxlevel=info['max_level'];scale=2**(level-maxlevel)
        if not 0<=level<=maxlevel or x<0 or y<0 or x*256>=math.ceil(info['virtual_width']*scale) or y*256>=math.ceil(info['virtual_height']*scale):raise ValueError('Invalid tile address')
        kind=f'tile:{level}:{x}:{y}';key=self.key(source,page,256,kind);cached=self.object(key)
        if cached and cached['status']=='ready':return self.file(key)
        job=self.enqueue(key,source,page,256,kind,priority=0,extra={'mode':'tile','level':level,'x':x,'y':y})
        if not job['event'].wait(120):raise TimeoutError('Tile generation is busy')
        return self.file(key)
    def full(self,node,page):
        source,link=self.linked_source(node);key=self.key(source,page,2048);cached=self.object(key)
        if source['withheld']:raise ValueError('Credential location; preview withheld')
        if not cached or cached['status']!='ready':
            job=self.enqueue(key,source,page,2048,'thumbnail',priority=0)
            if not job['event'].wait(120):raise TimeoutError('Preview generation is busy')
        return self.file(key)
    def status(self):
        with contextlib.closing(self.connection()) as c, c:
            rows=[dict(r) for r in c.execute('SELECT status,count(*) AS objects,sum(bytes) AS bytes FROM objects GROUP BY status')]
            count=c.execute('SELECT count(*) FROM accesses').fetchone()[0]
        return {'queue':len(self.pending),'busy':self.busy,'paused':self.paused,'cache':rows,'access_receipts':count,'budget_bytes':self.budget,'hits':self.hits,'misses':self.misses,'finished':self.finished,'workers':1,'renderer_version':VERSION,'volume_uuid':self.expected_uuid,'volume_verified':self.volume_verified}
    def pause(self,value=True):
        self.paused=bool(value)
        deadline=time.monotonic()+30
        while self.paused and self.busy and time.monotonic()<deadline:time.sleep(.05)
        return self.status()
