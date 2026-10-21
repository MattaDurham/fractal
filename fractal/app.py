"""Loopback-only application server. Only explicitly selected folders are inventoried."""
import contextlib,hashlib,json,mimetypes,secrets,sqlite3,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs,urlparse,urlencode
from .collections import Library
from .paths import write_lock
from .previews import PreviewService
from .native import build,choose
from .demo import create

WEB=Path(__file__).parent/'web'
class Application:
 def __init__(self,state,native=True):
  self.state=Path(state).resolve();self.library=Library(self.state);self.token=secrets.token_urlsafe(32);self.helpers=build(self.state) if native else {};self.services={};self.guard=threading.Lock();self.picker_guard=threading.Lock()
 def collection(self,identifier):return self.library.get(identifier)
 def preview(self,identifier):
  with self.guard:
   if identifier not in self.services:
    collection=self.collection(identifier)
    self.services[identifier]=PreviewService(collection.home,collection.db,collection.root,state=self.state,native=self.helpers.get('Preview'))
   return self.services[identifier]
 def meta(self,identifier):
  if not identifier:return {'application':'fractal','dataset':{'label':'Your folders','files':0,'directories':0,'empty':True},'roots':{'content':'content','folders':'f:1'},'taxonomy':{'domains':[]}}
  c=self.collection(identifier);return {'application':'fractal','dataset':{'label':c.record['label'],'files':c.progress['files'],'directories':c.progress['directories'],'built_at':c.progress.get('scanned_at'),'empty':False},'roots':{'content':'content','folders':'f:1'},'taxonomy':{'domains':[]},'status':c.status()}
 def decorate(self,data,identifier):
  if isinstance(data,list):return [self.decorate(v,identifier) for v in data]
  if isinstance(data,dict):return {k:(v+'&collection='+identifier if k in ('url','tile_url','large_image_url') and isinstance(v,str) and v.startswith('/api/') else self.decorate(v,identifier)) for k,v in data.items()}
  return data

def handler(application):
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def local(self):
   expected=f'127.0.0.1:{self.server.server_port}';host=self.headers.get('Host','');origin=self.headers.get('Origin');site=self.headers.get('Sec-Fetch-Site')
   return host in (expected,f'localhost:{self.server.server_port}') and (not origin or origin=='http://'+host) and site!='cross-site'
  def respond(self,data,kind='application/json',status=200):
   if kind=='application/json':data=json.dumps(data,ensure_ascii=True).encode()
   self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");self.end_headers();self.wfile.write(data)
  def failure(self,error,status=400):self.respond({'error':str(error)},status=status)
  def do_GET(self):
   if not self.local():self.failure('Local requests only',403);return
   u=urlparse(self.path);q=parse_qs(u.query);get=lambda k,d=None:q.get(k,[d])[0];identifier=get('collection');node=get('id','f:1')
   try:
    if u.path=='/api/bootstrap':self.respond({'token':application.token,'collections':application.library.list(),'native':bool(application.helpers),'state_id':hashlib.sha256(str(application.state).encode()).hexdigest()[:12]});return
    if u.path=='/api/meta':self.respond(application.meta(identifier));return
    if u.path=='/api/collections':self.respond({'items':application.library.list()});return
    if u.path=='/api/status':self.respond(application.collection(identifier).status() if identifier else {'state':'empty'});return
    if u.path.startswith('/api/previews/'):
     p=application.preview(identifier)
     if u.path=='/api/previews/info':data=p.info(int(get('node')),int(get('page',1)))
     elif u.path=='/api/previews/status':data=p.status()
     else:
      if u.path=='/api/previews/image':path=p.file(get('key',''))
      elif u.path=='/api/previews/full':path=p.full(int(get('node')),int(get('page',1)))
      elif u.path=='/api/previews/tile':path=p.tile(*[int(get(k,1 if k=='page' else 0)) for k in ['node','page','level','x','y']])
      else:raise ValueError('Unknown preview endpoint')
      self.respond(path.read_bytes(),'image/jpeg');return
     self.respond(application.decorate(data,identifier));return
    if u.path.startswith('/api/'):
     if not identifier:
      if u.path=='/api/node':data={'id':node,'label':'Choose a folder','kind':'dataset','files':0,'bytes':0,'items':0,'expandable':False}
      elif u.path=='/api/children':data={'items':[]}
      else:data={'items':[]}
     else:
      c=application.collection(identifier)
      if u.path=='/api/node':data=c.node(node)
      elif u.path=='/api/children':data={'items':c.children(node)}
      elif u.path=='/api/details':data=c.details(node)
      elif u.path=='/api/search':data={'items':c.search(get('q','')[:500])}
      else:raise ValueError('Unknown endpoint')
     self.respond(data);return
    # Exact package asset paths only. Never fall back to a selected source folder.
    relative='index.html' if u.path=='/' else u.path.lstrip('/')
    allowed={'index.html','app.js','layout.js','dataset.js','previews.js','collections.js','style.css','previews.css','collections.css','example.json','vendor/openseadragon.min.js','vendor/OpenSeadragon-LICENSE.txt'}
    if relative not in allowed:self.failure('Not found',404);return
    path=WEB/relative;kind={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'}.get(path.suffix,'text/plain; charset=utf-8')
    if kind=='application/json':self.respond(json.loads(path.read_text()))
    else:self.respond(path.read_bytes(),kind)
   except (ValueError,KeyError,TypeError,IndexError,sqlite3.Error) as e:self.failure(e)
   except OSError:self.failure('Folder or preview unavailable. Reconnect the folder and retry.',503)
  def do_POST(self):
   if not self.local() or not secrets.compare_digest(self.headers.get('X-Fractal-Token',''),application.token):self.failure('Local session required',403);return
   if self.headers.get('Content-Type','').split(';')[0]!='application/json':self.failure('JSON required',415);return
   try:
    length=int(self.headers.get('Content-Length',0))
    if not 0<length<=100000:raise ValueError('Invalid request size')
    data=json.loads(self.rfile.read(length));u=urlparse(self.path);identifier=parse_qs(u.query).get('collection',[None])[0]
    if u.path=='/api/folders/choose':
     if not application.picker_guard.acquire(blocking=False):raise ValueError('A folder dialog is already open')
     try:result=choose(application.helpers.get('ChooseFolder'))
     finally:application.picker_guard.release()
    elif u.path=='/api/collections/open':result=application.library.open(data['path'],data.get('hidden',False)).status()
    elif u.path=='/api/collections/refresh':result={'started':application.collection(identifier).scan()}
    elif u.path=='/api/collections/forget':application.library.forget(data['id']);result={'ok':True}
    elif u.path=='/api/example':
     with write_lock(application.state):root=create(application.state/'example')
     result=application.library.open(root).status()
    elif u.path=='/api/previews/request':result=application.decorate(application.preview(identifier).request(data.get('client'),data.get('items')),identifier)
    else:raise ValueError('Unknown endpoint')
    self.respond(result)
   except (ValueError,TypeError,KeyError,sqlite3.Error) as e:self.failure(e)
   except OSError:self.failure('The folder is unavailable or cannot be read.',503)
 return Handler

def serve(application,port):
 server=ThreadingHTTPServer(('127.0.0.1',port),handler(application));server.daemon_threads=True;return server
