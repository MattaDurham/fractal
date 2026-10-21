"""Portable passive rendering in an isolated process; never execute selected files."""
import json,math,re,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageOps
Image.MAX_IMAGE_PIXELS=100_000_000

def render(req):
 path=Path(req['path']);edge=max(64,min(4096,int(req.get('edge',512))));page=max(1,int(req.get('page',1)));mode=req.get('mode','render');ext=path.suffix.lower()
 if ext=='.pdf':
  import pypdfium2 as pdfium
  document=pdfium.PdfDocument(str(path))
  try:
   pages=len(document)
   if page>pages:raise ValueError('Page outside document')
   p=document[page-1]
   try:
    w,h=p.get_size();width,height=math.ceil(w*2),math.ceil(h*2)
    if mode=='tile':
     level,x,y=int(req['level']),int(req['x']),int(req['y']);maximum=math.ceil(math.log2(max(width,height)));factor=2**(level-maximum);lw,lh=math.ceil(width*factor),math.ceil(height*factor)
     if not 0<=level<=maximum or x<0 or y<0 or x*256>=lw or y*256>=lh:raise ValueError('Invalid tile')
     tw,th=min(256,lw-x*256),min(256,lh-y*256);scale=2*factor
     crop=(x*256/scale,max(0,h-(y*256+th)/scale),max(0,w-(x*256+tw)/scale),y*256/scale)
     bitmap=p.render(scale=scale,crop=crop,may_draw_forms=False);image=bitmap.to_pil().copy();bitmap.close()
     if image.size!=(tw,th):image=image.resize((tw,th),Image.Resampling.LANCZOS)
    else:
     factor=min(1,edge/max(width,height));bitmap=p.render(scale=2*factor,may_draw_forms=False);image=bitmap.to_pil().copy();bitmap.close()
    result={'width':width,'height':height,'pages':pages,'renderer':'PDFium / pypdfium2','extent':f'PDF page {page} of {pages}; passive raster rendering'}
   finally:p.close()
  finally:document.close()
 elif ext in {'.txt','.md','.py','.js','.ts','.tsx','.jsx','.css','.sql','.sh','.swift','.rs','.go'}:
  with path.open('rb') as f:text=f.read(65536).decode('utf-8')
  if re.search(r'(?i)(password|api[_ -]?key|access[_ -]?token|secret[_ -]?key|recovery phrase)\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY',text):raise ValueError('Credential-like text; preview withheld')
  width,height=1000,1300;factor=edge/height;image=Image.new('RGB',(max(1,round(width*factor)),edge),'#fffef9');draw=ImageDraw.Draw(image);font=ImageFont.load_default(size=max(8,round(14*factor)))
  for i,line in enumerate(text.splitlines()[:60]):draw.text((round(40*factor),round((40+i*20)*factor)),line[:180],font=font,fill='#282e29')
  result={'width':width,'height':height,'pages':1,'renderer':'Pillow text','extent':'First 64 KiB / first 60 lines; text excerpt'}
 else:
  with Image.open(path) as original:
   original.seek(0);image=ImageOps.exif_transpose(original);width,height=image.size
   if mode=='tile':
    maximum=math.ceil(math.log2(max(1,round(max(width,height)*min(1,8192/max(width,height))))))
    level,x,y=int(req['level']),int(req['x']),int(req['y']);factor=min(1,8192/max(width,height));vw,vh=max(1,round(width*factor)),max(1,round(height*factor));scale=2**(level-maximum);lw,lh=math.ceil(vw*scale),math.ceil(vh*scale)
    if not 0<=level<=maximum or x<0 or y<0 or x*256>=lw or y*256>=lh:raise ValueError('Invalid tile')
    image=image.resize((lw,lh),Image.Resampling.LANCZOS).crop((x*256,y*256,min(lw,(x+1)*256),min(lh,(y+1)*256)))
   else:image.thumbnail((edge,edge),Image.Resampling.LANCZOS)
   image=image.copy()
  result={'width':width,'height':height,'pages':1,'renderer':'Pillow','extent':'First image; orientation-corrected preview'}
 if image.mode in ('RGBA','LA') or 'transparency' in image.info:
  rgba=image.convert('RGBA');paper=Image.new('RGBA',rgba.size,'white');paper.alpha_composite(rgba);image=paper.convert('RGB')
 else:image=image.convert('RGB')
 image.save(req['output'],'JPEG',quality=83,optimize=True)
 return {'ok':True,**result,'preview_width':image.width,'preview_height':image.height}

if __name__=='__main__':
 try:print(json.dumps(render(json.load(sys.stdin))))
 except Exception as e:print(json.dumps({'ok':False,'error':str(e) or 'No compatible passive renderer'}));raise SystemExit(2)
