"""Optional native macOS helper; portable preview fallback needs no compiler."""
import hashlib,json,plistlib,shutil,subprocess,sys
from pathlib import Path
from .paths import write_lock

def build(state):
 if sys.platform!='darwin' or not shutil.which('swiftc'):return {}
 if subprocess.run(['/usr/bin/xcode-select','-p'],capture_output=True).returncode:return {}
 state=Path(state);sources=Path(__file__).parent/'native';text=(sources/'ChooseFolder.swift').read_text()+'\n'+(sources/'Preview.swift').read_text();digest=hashlib.sha256(text.encode()).hexdigest()[:12]
 bundle=state/'native'/('FractalHelper-'+digest+'.app');binary=bundle/'Contents/MacOS/FractalHelper'
 if not binary.is_file():
  with write_lock(state):
   binary.parent.mkdir(parents=True,exist_ok=True);modules=state/'native/module-cache';source=state/'native/Helper.swift'
   source.write_text(text);(bundle/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'org.fractal.folder-chooser','CFBundleName':'Fractal Folder Chooser','CFBundleDisplayName':'Fractal Folder Chooser','CFBundleExecutable':'FractalHelper','CFBundlePackageType':'APPL','NSHighResolutionCapable':True}))
   try:
    result=subprocess.run(['swiftc','-O','-module-cache-path',str(modules),str(source),'-o',str(binary)],capture_output=True,timeout=120)
    if result.returncode:return {}
   except (OSError,subprocess.TimeoutExpired):return {}
   finally:shutil.rmtree(modules,ignore_errors=True);source.unlink(missing_ok=True)
 return {'Preview':binary,'ChooseFolder':binary}

def choose(helper=None):
 try:return _choose(helper)
 except subprocess.TimeoutExpired:raise ValueError('Folder dialog timed out. Enter a folder path instead.') from None

def _choose(helper=None):
 if helper:
  result=subprocess.run([str(helper),'--choose-folder'],capture_output=True,text=True,timeout=300)
  if result.returncode:raise ValueError('Folder dialog could not open. Enter a folder path instead.')
  return json.loads(result.stdout)
 result=subprocess.run([sys.executable,'-m','fractal.native'],capture_output=True,text=True,timeout=300,cwd=str(Path(__file__).parent.parent))
 if result.returncode:raise ValueError('Native picker unavailable. Enter a folder path below instead.')
 return json.loads(result.stdout)

if __name__=='__main__':
 try:
  import tkinter
  from tkinter import filedialog
  root=tkinter.Tk();root.withdraw();path=filedialog.askdirectory(title='Choose a folder for Fractal',mustexist=True);root.destroy();print(json.dumps({'path':path} if path else {'cancelled':True}))
 except Exception:raise SystemExit(2)
