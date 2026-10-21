"""Metadata-only, resumable folder inventories. Selected folders are never written."""
import base64,contextlib,hashlib,json,math,os,sqlite3,threading,time,uuid
from pathlib import Path
from .paths import write_lock

GROUPS={'documents':('Documents','pdf doc docx odt rtf txt md pages epub'), 'spreadsheets':('Spreadsheets','xls xlsx ods csv numbers'), 'images':('Images','jpg jpeg png gif webp heic heif tif tiff bmp psd dng raw avif svg ico'), 'code':('Code','py js ts jsx tsx html htm css scss json yaml yml toml sql sh swift rs go java c h cpp ipynb'), 'audio':('Audio','mp3 m4a wav flac aiff ogg'), 'video':('Video','mov mp4 webm avi mkv'), 'archives':('Archives','zip tar gz bz2 xz 7z rar'), 'other':('Other files','')}
EXT={ext:key for key,(_,extensions) in GROUPS.items() for ext in extensions.split()}
MAX_CHILDREN=64

def atomic_json(path,value):
 temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,indent=2)+'\n');temp.replace(path)

def category(name):return EXT.get(Path(name).suffix.lower().lstrip('.'),'other')
def decoded(value):return os.fsdecode(value)

class Collection:
 def __init__(self,record,state):
  self.record=record;self.state=Path(state);self.root=Path(record['path']);self.home=self.state/'collections'/record['id'];self.db=self.home/'inventory.sqlite'
  self.progress={'state':'idle','files':0,'directories':0,'bytes':0,'errors':0};self.scan_guard=threading.Lock();self.cancel=threading.Event()
  with write_lock(self.state):
   self.home.mkdir(parents=True,exist_ok=True)
   with contextlib.closing(self.connect()) as c, c:
    c.executescript('''CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY,parent_id INTEGER,name BLOB,kind TEXT,size INTEGER,rel TEXT UNIQUE,mtime_ns TEXT,ctime_ns TEXT,inode TEXT,device TEXT,category TEXT,files INTEGER DEFAULT 0,bytes INTEGER DEFAULT 0,items INTEGER DEFAULT 1,generation TEXT);
     CREATE INDEX IF NOT EXISTS children ON entries(parent_id,name,id);
     CREATE INDEX IF NOT EXISTS kinds ON entries(category,name,id);
     CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
     CREATE TABLE IF NOT EXISTS descriptions(node_id INTEGER,rung TEXT,text TEXT,source TEXT);
     CREATE TABLE IF NOT EXISTS file_hash_observations(node_id INTEGER PRIMARY KEY,sha256 TEXT,source_size INTEGER,source_mtime_ns INTEGER,source_ctime_ns INTEGER,source_device INTEGER,source_inode INTEGER);
     CREATE TABLE IF NOT EXISTS analysis_receipts(receipt_id TEXT,node_id INTEGER);''')
    c.execute("INSERT OR IGNORE INTO entries(id,parent_id,name,kind,size,rel) VALUES(1,NULL,?,'directory',0,'')",(os.fsencode(self.root.name or str(self.root)),))
    r=c.execute("SELECT value FROM meta WHERE key='progress'").fetchone()
    if r:self.progress=json.loads(r[0])
  if self.progress['state'] in ('idle','scanning'):self.scan()
 def connect(self):
  c=sqlite3.connect(self.db,timeout=10);c.row_factory=sqlite3.Row;return c
 def scan(self):
  if not self.scan_guard.acquire(blocking=False):return False
  self.cancel.clear();self.progress={'state':'scanning','files':0,'directories':0,'bytes':0,'errors':0}
  threading.Thread(target=self._scan,daemon=True,name='Fractal folder inventory').start();return True
 def _scan(self):
  generation=uuid.uuid4().hex;progress=self.progress;pending=[(1,self.root,'')];batch=[]
  try:
   if not self.root.is_dir():raise OSError('Folder is disconnected or unavailable')
   while pending and not self.cancel.is_set():
    parent,path,relative=pending.pop()
    try:
     with os.scandir(path) as entries:children=list(entries)
    except OSError:progress['errors']+=1;continue
    # Insert directories before visiting them, so IDs and paths remain stable on refresh.
    children.sort(key=lambda e:e.name.casefold())
    with write_lock(self.state):
     with contextlib.closing(self.connect()) as c, c:
      for entry in children:
       if not self.record.get('hidden') and entry.name.startswith('.'):continue
       p=Path(entry.path)
       if p==self.state or self.state==p.absolute():continue
       try:
        s=entry.stat(follow_symlinks=False)
        kind='symlink' if entry.is_symlink() else 'directory' if entry.is_dir(follow_symlinks=False) else 'file' if entry.is_file(follow_symlinks=False) else 'other'
       except OSError:progress['errors']+=1;continue
       rel=(relative+'/'+entry.name).lstrip('/');size=s.st_size if kind=='file' else 0
       c.execute('''INSERT INTO entries(parent_id,name,kind,size,rel,mtime_ns,ctime_ns,inode,device,category,files,bytes,items,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(rel) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,kind=excluded.kind,size=excluded.size,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,inode=excluded.inode,device=excluded.device,category=excluded.category,files=excluded.files,bytes=excluded.bytes,items=1,generation=excluded.generation''',(parent,os.fsencode(entry.name),kind,size,rel,str(s.st_mtime_ns),str(s.st_ctime_ns),str(s.st_ino),str(s.st_dev),category(entry.name) if kind=='file' else None,int(kind=='file'),size,1,generation))
       if kind=='directory':
        nid=c.execute('SELECT id FROM entries WHERE rel=?',(rel,)).fetchone()[0];pending.append((nid,p,rel));progress['directories']+=1
       elif kind=='file':progress['files']+=1;progress['bytes']+=size
      c.execute("INSERT OR REPLACE INTO meta VALUES('progress',?)",(json.dumps(progress),))
   if self.cancel.is_set():progress['state']='cancelled';return
   with write_lock(self.state):
    with contextlib.closing(self.connect()) as c, c:
     c.execute('DELETE FROM entries WHERE id<>1 AND generation<>?',(generation,))
     counts={}
     for r in c.execute('SELECT id,parent_id,kind,size FROM entries ORDER BY id DESC'):
      own=[int(r['kind']=='file'),r['size'] if r['kind']=='file' else 0,1];sub=counts.pop(r['id'],[0,0,0]);total=[a+b for a,b in zip(own,sub)]
      if r['kind']=='directory':c.execute('UPDATE entries SET files=?,bytes=?,items=? WHERE id=?',(*total,r['id']))
      if r['parent_id'] is not None:
       old=counts.setdefault(r['parent_id'],[0,0,0]);counts[r['parent_id']]=[a+b for a,b in zip(old,total)]
     progress['state']='ready';progress['scanned_at']=time.time();c.execute("INSERT OR REPLACE INTO meta VALUES('progress',?)",(json.dumps(progress),))
  except (OSError,sqlite3.Error,FileExistsError) as e:progress.update(state='error',message=str(e))
  finally:self.scan_guard.release()
 def status(self):return {**self.record,**self.progress,'available':self.root.is_dir()}
 def row_node(self,r):
  return {'id':'f:'+str(r['id']),'originalId':r['id'],'label':decoded(r['name']),'kind':r['kind'],'files':r['files'],'bytes':r['bytes'],'items':r['items'],'expandable':r['kind']=='directory','path':r['rel'],'domain':'unplaced'}
 def node(self,identifier):
  if identifier=='content':return {'id':'content','label':self.record['label'],'kind':'dataset','files':self.progress['files'],'bytes':self.progress['bytes'],'items':self.progress['files'],'expandable':True}
  if identifier.startswith('t:'):
   k=identifier[2:]
   if k not in GROUPS:raise ValueError('Unknown file type')
   with contextlib.closing(self.connect()) as c:r=c.execute("SELECT count(*) files,coalesce(sum(size),0) bytes FROM entries WHERE category=? AND kind='file'",(k,)).fetchone()
   return {'id':identifier,'label':GROUPS[k][0],'kind':'topic','files':r['files'],'bytes':r['bytes'],'items':r['files'],'expandable':True,'domain':'unplaced'}
  if identifier.startswith('b:'):
   parent,start,end=json.loads(base64.urlsafe_b64decode(identifier[2:]+'='*(-len(identifier[2:])%4)));return self._bucket(parent,start,end)
  if not identifier.startswith('f:'):raise ValueError('Invalid item')
  with contextlib.closing(self.connect()) as c:r=c.execute('SELECT * FROM entries WHERE id=?',(int(identifier[2:]),)).fetchone()
  if r is None:raise ValueError('Item no longer exists; refresh the folder')
  return self.row_node(r)
 def _where(self,parent):
  if parent.startswith('f:'):return 'parent_id=?',(int(parent[2:]),)
  if parent.startswith('t:') and parent[2:] in GROUPS:return "category=? AND kind='file'",(parent[2:],)
  raise ValueError('Invalid parent')
 def _rows(self,parent,start=0,count=-1):
  where,params=self._where(parent)
  with contextlib.closing(self.connect()) as c:
   yield from c.execute('SELECT * FROM entries WHERE '+where+' ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?',(*params,count,start))
 def _bucket(self,parent,start,end,rows=None):
  if not isinstance(start,int) or not isinstance(end,int) or not 0<=start<end or parent.startswith('b:'):raise ValueError('Invalid range')
  rows=list(self._rows(parent,start,end-start)) if rows is None else rows
  if not rows:raise ValueError('Empty range')
  identifier='b:'+base64.urlsafe_b64encode(json.dumps([parent,start,end]).encode()).decode().rstrip('=')
  return {'id':identifier,'label':decoded(rows[0]['name'])[:24]+' … '+decoded(rows[-1]['name'])[:24],'kind':'group','files':sum(r['files'] for r in rows),'bytes':sum(r['bytes'] for r in rows),'items':sum(r['items'] for r in rows),'expandable':True,'groupCount':len(rows)}
 def children(self,parent):
  if parent=='content':return [n for k in GROUPS if (n:=self.node('t:'+k))['files']]
  start=0;count=-1
  if parent.startswith('b:'):parent,start,end=json.loads(base64.urlsafe_b64decode(parent[2:]+'='*(-len(parent[2:])%4)));count=end-start
  where,params=self._where(parent)
  with contextlib.closing(self.connect()) as c:total=c.execute('SELECT count(*) FROM entries WHERE '+where,params).fetchone()[0]
  count=max(0,min(total-start,count if count>=0 else total))
  if count<=MAX_CHILDREN:return [self.row_node(r) for r in self._rows(parent,start,count)]
  stride=math.ceil(count/MAX_CHILDREN);out=[];chunk=[];offset=start
  for row in self._rows(parent,start,count):
   chunk.append(row)
   if len(chunk)==stride:out.append(self._bucket(parent,offset,offset+len(chunk),chunk));offset+=len(chunk);chunk=[]
  if chunk:out.append(self._bucket(parent,offset,offset+len(chunk),chunk))
  return out
 def details(self,identifier):
  n=self.node(identifier)
  if 'originalId' not in n:return {'node':n,'description':'File-type grouping or alphabetical navigation range.','ancestors':[]}
  chain=[];nid=n['originalId'];mtime_ns=None
  with contextlib.closing(self.connect()) as c:
   while nid:
    r=c.execute('SELECT id,parent_id,name,rel,mtime_ns FROM entries WHERE id=?',(nid,)).fetchone()
    if not chain:mtime_ns=r['mtime_ns']
    chain.append({'id':'f:'+str(nid),'label':decoded(r['name'])});nid=r['parent_id']
  path=self.root/n['path'];return {'node':n,'path':str(path),'ancestors':list(reversed(chain)),'mtime_ns':mtime_ns,'description':'Folder metadata. Previews read supported files only when visible or inspected.','note':'File-type groups use extensions. Fractal does not invent semantic summaries.'}
 def search(self,q):
  with contextlib.closing(self.connect()) as c:
   if q.startswith('#') and q[1:].isdigit():rows=c.execute('SELECT * FROM entries WHERE id=?',(int(q[1:]),)).fetchall()
   elif q.startswith('/'):
    raw=q[1:];rows=c.execute('SELECT * FROM entries WHERE rel=? LIMIT 40',(raw,)).fetchall()
   else:
    escaped=q.replace('\\','\\\\').replace('%','\\%').replace('_','\\_');rows=c.execute("SELECT * FROM entries WHERE CAST(name AS TEXT) LIKE ? ESCAPE '\\' OR rel LIKE ? ESCAPE '\\' LIMIT 40",('%'+escaped+'%','%'+escaped+'%')).fetchall()
  return [self.row_node(r) for r in rows]

class Library:
 def __init__(self,state):
  self.state=Path(state);self.path=self.state/'collections.json';self.loaded={};self.guard=threading.RLock()
  with write_lock(self.state):
   if not self.path.exists():atomic_json(self.path,{'version':1,'collections':[]})
 def records(self):return json.loads(self.path.read_text())['collections']
 def open(self,path,hidden=False):
  if not str(path).strip():raise ValueError('Enter a folder path')
  if not isinstance(hidden,bool):raise ValueError('Hidden files must be true or false')
  root=Path(path).expanduser().resolve(strict=True)
  if not root.is_dir():raise ValueError('Choose a folder')
  if root==self.state or (self.state in root.parents and root!=self.state/'example'):raise ValueError('Choose a folder outside Fractal’s private data directory')
  with self.guard:
   rows=self.records();record=next((r for r in rows if r['path']==str(root) and r.get('hidden',False)==bool(hidden)),None)
   if record is None:
    record={'id':uuid.uuid4().hex,'label':root.name or str(root),'path':str(root),'hidden':bool(hidden),'created_at':time.time()};rows.append(record)
    with write_lock(self.state):atomic_json(self.path,{'version':1,'collections':rows})
   return self.get(record['id'])
 def get(self,identifier):
  with self.guard:
   if identifier not in self.loaded:
    record=next((r for r in self.records() if r['id']==identifier),None)
    if not record:raise ValueError('Choose a saved folder')
    self.loaded[identifier]=Collection(record,self.state)
   return self.loaded[identifier]
 def list(self):return [self.loaded[r['id']].status() if r['id'] in self.loaded else {**r,'state':'saved','available':Path(r['path']).is_dir()} for r in self.records()]
 def forget(self,identifier):
  with self.guard:
   rows=[r for r in self.records() if r['id']!=identifier]
   with write_lock(self.state):atomic_json(self.path,{'version':1,'collections':rows})
