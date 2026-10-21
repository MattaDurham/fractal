import contextlib,json,os,sys,time
from pathlib import Path

def data_dir():
 if os.environ.get('FRACTAL_DATA_DIR'):return Path(os.environ['FRACTAL_DATA_DIR']).expanduser().resolve()
 if sys.platform=='darwin':return Path.home()/'Library/Application Support/Fractal'
 if sys.platform=='win32':return Path(os.environ.get('LOCALAPPDATA',Path.home()/'AppData/Local'))/'Fractal'
 return Path(os.environ.get('XDG_DATA_HOME',Path.home()/'.local/share'))/'fractal'

@contextlib.contextmanager
def write_lock(root=None,wait=30):
 root=Path(root) if root else data_dir();root.mkdir(mode=0o700,parents=True,exist_ok=True)
 lock=Path(os.environ['FRACTAL_WRITE_LOCK']) if os.environ.get('FRACTAL_WRITE_LOCK') else root/'.write-lock'
 deadline=time.monotonic()+wait
 while True:
  try:lock.mkdir();break
  except FileExistsError:
   if time.monotonic()>=deadline:raise
   time.sleep(.1)
 try:
  (lock/'owner.json').write_text(json.dumps({'pid':os.getpid(),'started_at':time.time()}))
  yield
 finally:
  (lock/'owner.json').unlink(missing_ok=True);lock.rmdir()
