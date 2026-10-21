import argparse,hashlib,json,os,sys,webbrowser
from pathlib import Path
from urllib.request import Request,urlopen
from . import __version__
from .paths import data_dir

def main():
 p=argparse.ArgumentParser(description='Fractal — zoom into your folders. Runs entirely on your computer.');p.add_argument('--version',action='version',version=__version__);p.add_argument('--folder',type=Path,help='Open a folder on launch');p.add_argument('--data-dir',type=Path,help='Private local catalog/cache directory');p.add_argument('--port',type=int,default=8769);p.add_argument('--no-browser',action='store_true');p.add_argument('--no-native',action='store_true',help='Use portable previews without compiling macOS helpers');a=p.parse_args()
 if a.data_dir:os.environ['FRACTAL_DATA_DIR']=str(a.data_dir.expanduser().resolve())
 url=f'http://127.0.0.1:{a.port}'
 if a.port:
  try:
   with urlopen(url+'/api/meta',timeout=1) as r:existing=json.load(r)
   if existing.get('application')=='fractal':
    suffix=''
    if a.data_dir:
     with urlopen(url+'/api/bootstrap') as r:running=json.load(r)
     if running['state_id']!=hashlib.sha256(str(data_dir()).encode()).hexdigest()[:12]:p.error('A Fractal instance with a different data directory uses this port. Choose another --port.')
    if a.folder:
     with urlopen(url+'/api/bootstrap') as r:boot=json.load(r)
     req=Request(url+'/api/collections/open',data=json.dumps({'path':str(a.folder.expanduser().resolve())}).encode(),headers={'Content-Type':'application/json','X-Fractal-Token':boot['token']})
     with urlopen(req) as r:record=json.load(r)
     suffix='#collection='+record['id']+'&view=folders&node=f%3A1'
    print('Fractal is already running: '+url+suffix)
    if not a.no_browser:webbrowser.open(url+suffix)
    return
  except (OSError,ValueError):pass
 from .app import Application,serve
 print('Preparing Fractal’s local folder and preview support…',flush=True)
 application=Application(data_dir(),native=not a.no_native);collection=application.library.open(a.folder) if a.folder else None
 server=serve(application,a.port);url=f'http://127.0.0.1:{server.server_port}';suffix=('#collection='+collection.record['id']+'&view=folders&node=f%3A1') if collection else ''
 print('Fractal: '+url+suffix,flush=True);print('Choose a folder in the browser. Ctrl-C stops the local server.',flush=True)
 if not a.no_browser:webbrowser.open(url+suffix)
 try:server.serve_forever()
 except KeyboardInterrupt:pass
 finally:
  for service in application.services.values():service.stopped=True
  for collection in application.library.loaded.values():collection.cancel.set()
  server.server_close()

if __name__=='__main__':main()
