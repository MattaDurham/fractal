import contextlib,json,math,os,sqlite3,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from fractal.collections import Library
from fractal.app import Application,serve
from fractal.previews import PreviewService,index_lock
from fractal.render import render
from fractal.demo import create
from PIL import Image

class Fixtures(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.home=Path(self.temp.name);self.root=self.home/'chosen';self.root.mkdir();self.state=self.home/'state';self.library=Library(self.state)
 def tearDown(self):
  for c in self.library.loaded.values():
   c.cancel.set()
   deadline=time.monotonic()+10
   while c.scan_guard.locked() and time.monotonic()<deadline:time.sleep(.01)
  self.temp.cleanup()
 def opened(self,hidden=False):
  c=self.library.open(self.root,hidden);deadline=time.monotonic()+10
  while c.progress['state']=='scanning' and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(c.progress['state'],'ready',c.progress);return c
 def add(self,name,text='Synthetic content'):
  p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);return p
 def test_nested_unicode_counts_and_source_unchanged(self):
  a=self.add('Notes/Café.md');self.add('Notes/plan.txt');self.add('Images/metadata.jpg');before=a.stat();c=self.opened();self.assertEqual(c.node('f:1')['files'],3);self.assertEqual(c.progress['directories'],2);self.assertEqual(a.read_text(),'Synthetic content');self.assertEqual(a.stat().st_mtime_ns,before.st_mtime_ns)
 def test_hidden_files_are_an_explicit_option(self):
  self.add('.hidden/a.txt');self.add('shown.txt');self.assertEqual(self.opened().progress['files'],1);self.assertEqual(self.opened(True).progress['files'],2)
 def test_saved_collection_reopens_without_source_copy(self):
  self.add('one.txt');c=self.opened();again=Library(self.state).get(c.record['id']);self.assertEqual(again.record['path'],str(self.root.resolve()));self.assertEqual(again.node('f:1')['files'],1);self.assertFalse((self.root/'inventory.sqlite').exists())
 def test_refresh_preserves_ids_and_removes_missing_paths(self):
  self.add('keep.txt');gone=self.add('gone.txt');c=self.opened();old=c.search('keep')[0]['id'];gone.unlink();self.add('new.txt');c.scan()
  deadline=time.monotonic()+10
  while c.progress['state']=='scanning' and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(c.search('keep')[0]['id'],old);self.assertFalse(c.search('gone'));self.assertEqual(c.node('f:1')['files'],2)
 def test_large_flat_folder_is_fully_reachable(self):
  for i in range(193):self.add(f'item-{i:03}.txt')
  c=self.opened();todo=['f:1'];ids=[]
  while todo:
   rows=c.children(todo.pop());self.assertLessEqual(len(rows),64)
   for n in rows:
    if n['kind']=='group':todo.append(n['id'])
    else:ids.append(n['id'])
  self.assertEqual(len(set(ids)),193)
 def test_file_type_groups_cover_files_once(self):
  self.add('note.md');self.add('one.pdf');self.add('tab.xlsx');self.add('program.py');self.add('blob.unknown');c=self.opened();groups=c.children('content');self.assertEqual(sum(n['files'] for n in groups),5);self.assertTrue(any(n['label']=='Spreadsheets' for n in groups))
 def test_search_literal_wildcards_and_exact_paths(self):
  self.add('a%_b.txt');self.add('other.txt');c=self.opened();self.assertEqual(len(c.search('%_')),1);self.assertEqual(len(c.search('/a%_b.txt')),1)
 def test_symbolic_links_are_listed_but_not_followed(self):
  p=self.add('real.txt')
  try:(self.root/'link.txt').symlink_to(p)
  except OSError:self.skipTest('Symlink privilege unavailable')
  c=self.opened();n=c.search('link')[0];self.assertEqual(n['kind'],'symlink');self.assertEqual(c.progress['files'],1)
 def test_empty_path_does_not_select_the_working_directory(self):
  with self.assertRaises(ValueError):self.library.open('')
 def test_collection_ids_keep_independent_source_context(self):
  self.add('Alpha.txt');a=self.opened();other=self.home/'other';other.mkdir();(other/'Beta.txt').write_text('Synthetic');b=self.library.open(other)
  deadline=time.monotonic()+10
  while b.progress['state']=='scanning' and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(a.search('Alpha')[0]['originalId'],b.search('Beta')[0]['originalId']);self.assertEqual(a.node('f:2')['label'],'Alpha.txt');self.assertEqual(b.node('f:2')['label'],'Beta.txt')
 def test_own_private_state_cannot_be_selected(self):
  with self.assertRaises(ValueError):self.library.open(self.state)
 def test_private_state_alias_is_canonicalized(self):
  alias=self.home/'state-alias'
  try:alias.symlink_to(self.state,target_is_directory=True)
  except OSError:self.skipTest('Symlink privilege unavailable')
  library=Library(alias)
  with self.assertRaises(ValueError):library.open(self.state)
 def test_forgetting_collection_does_not_delete_source(self):
  p=self.add('keep.txt');c=self.opened();self.library.forget(c.record['id']);self.assertEqual(self.library.list(),[]);self.assertTrue(p.exists())
 def test_preview_fingerprint_changes_when_source_changes(self):
  p=self.add('a.txt');c=self.opened();service=PreviewService(c.home,c.db,c.root,state=self.state,start=False);n=c.search('a.txt')[0]['originalId'];before=service.source(n)['identity'];p.write_text('A changed edition');service.source_cache.clear();self.assertNotEqual(before,service.source(n)['identity'])
 def test_cached_source_cannot_follow_a_replaced_parent_link(self):
  p=self.add('nested/a.txt');outside=self.home/'outside';outside.mkdir()
  try:os.link(p,outside/'a.txt')
  except OSError:self.skipTest('Hard-link privilege unavailable')
  c=self.opened();service=PreviewService(c.home,c.db,c.root,state=self.state,start=False);n=c.search('a.txt')[0]['originalId'];source=service.source(n);(self.root/'nested').rename(self.root/'moved')
  try:(self.root/'nested').symlink_to(outside,target_is_directory=True)
  except OSError:self.skipTest('Symlink privilege unavailable')
  job={'source':source,'key':service.key(source,1,512),'page':1,'tier':512,'kind':'thumbnail','extra':{},'result':None}
  with patch.object(service,'render',side_effect=AssertionError('must not open linked path')):
   with self.assertRaises(ValueError):service.generate(job)
 def test_credentials_are_withheld_before_render(self):
  self.add('passwords.txt','Do not display');c=self.opened();service=PreviewService(c.home,c.db,c.root,state=self.state,start=False);n=c.search('passwords')[0]['originalId'];self.assertEqual(service.request('test',[{'node':n}])['items'][0]['status'],'withheld');self.assertFalse(service.pending)
 def test_portable_pdf_preview_and_tile_fidelity(self):
  demo=create(self.home/'example');path=demo/'Documents/Field guide.pdf';out=self.home/'whole.jpg';r=render({'path':str(path),'output':str(out),'edge':1584});self.assertEqual(r['pages'],2);self.assertEqual((r['width'],r['height']),(1224,1584));tile=self.home/'tile.jpg';render({'path':str(path),'output':str(tile),'mode':'tile','level':11,'x':0,'y':0})
  with Image.open(out) as whole,Image.open(tile) as part:
   self.assertEqual(part.size,(256,256));a,b=whole.getpixel((20,20)),part.getpixel((20,20));self.assertLess(sum(abs(x-y) for x,y in zip(a,b)),15)
 def test_portable_image_orientation_and_budget(self):
  p=self.root/'rotated.jpg';im=Image.new('RGB',(80,40),'green');exif=im.getexif();exif[274]=6;im.save(p,exif=exif);out=self.home/'preview.jpg';r=render({'path':str(p),'output':str(out),'edge':128});self.assertEqual((r['width'],r['height']),(40,80));
  with Image.open(out) as preview:self.assertLessEqual(max(preview.size),128)
 def test_text_renderer_reads_only_bounded_excerpt(self):
  p=self.add('note.txt','A synthetic note\n'*10000);out=self.home/'text.jpg';r=render({'path':str(p),'output':str(out),'edge':512});self.assertIn('64 KiB',r['extent']);
  with Image.open(out) as preview:self.assertLessEqual(max(preview.size),512)
 def test_http_origin_token_and_static_boundaries(self):
  app=Application(self.state,native=False);server=serve(app,0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base=f'http://127.0.0.1:{server.server_port}'
  try:
   with urlopen(base+'/api/bootstrap') as r:boot=json.load(r)
   for path,headers in [('/api/bootstrap',{'Origin':'https://example.invalid'}),('/api/bootstrap',{'Host':'evil.invalid'}),('/api/bootstrap',{'Sec-Fetch-Site':'cross-site'}),('/inventory.sqlite',{})]:
    with self.assertRaises(HTTPError) as caught:urlopen(Request(base+path,headers=headers))
    caught.exception.close()
   with self.assertRaises(HTTPError) as caught:urlopen(Request(base+'/api/collections/open',data=b'{}',headers={'Content-Type':'application/json'}))
   caught.exception.close()
   req=Request(base+'/api/collections/open',data=json.dumps({'path':str(self.root)}).encode(),headers={'Content-Type':'application/json','X-Fractal-Token':boot['token']})
   with urlopen(req) as r:record=json.load(r)
   with urlopen(base+'/api/meta?collection='+record['id']) as r:self.assertEqual(json.load(r)['application'],'fractal')
  finally:
   server.shutdown();server.server_close();thread.join()
   for col in app.library.loaded.values():
    deadline=time.monotonic()+10
    while col.scan_guard.locked() and time.monotonic()<deadline:time.sleep(.01)

if __name__=='__main__':unittest.main()
