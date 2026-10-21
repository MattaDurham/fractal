"""A synthetic, redistributable example. Contains no user files."""
from pathlib import Path
from PIL import Image,ImageDraw

def create(root):
 root=Path(root);root.mkdir(parents=True,exist_ok=True)
 folders={'Research':['A question worth keeping.md','Field observations.md','Reading notes.md'],'Projects':['The small observatory.md','Materials and methods.md'],'Images':[],'Documents':[]}
 for folder,names in folders.items():
  p=root/folder;p.mkdir(exist_ok=True)
  for name in names:
   target=p/name
   if not target.exists():target.write_text('# '+name[:-3]+'\n\nThis is a synthetic example for Fractal.\n\n## Follow a thread\n\nA folder can be a place to think. Start with the big picture, then zoom toward the detail.\n\n- Gather observations\n- Notice a pattern\n- Keep the source close\n')
 for i,color in enumerate(['#bd6749','#7b9588','#c1b58f']):
  p=root/'Images'/('Study '+str(i+1)+'.png')
  if not p.exists():
   im=Image.new('RGB',(1200,900),'#f5f1e8');d=ImageDraw.Draw(im);d.rectangle((110,110,1090,790),outline='#d4cdbf',width=2);d.ellipse((240+i*70,180,850,780-i*70),fill=color);d.line((110,700,1090,260),fill='#282e29',width=7);im.save(p)
 p=root/'Documents/Field guide.pdf'
 if not p.exists():
  content=b'0.96 0.94 0.90 rg 0 0 612 792 re f\n0.16 0.19 0.16 rg\nBT /F1 38 Tf 48 700 Td (A field guide) Tj ET\nBT /F1 14 Tf 48 664 Td (A synthetic document for Fractal.) Tj ET\n0.72 0.28 0.17 rg 48 320 240 260 re f\n0.50 0.60 0.53 rg 312 320 252 170 re f\n0.16 0.19 0.16 rg BT /F1 14 Tf 48 260 Td (Zoom into a place. Let the detail resolve.) Tj ET'
  objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(content)).encode()+b' >>\nstream\n'+content+b'\nendstream'];second=b'0.96 0.94 0.90 rg 0 0 612 792 re f 0.16 0.19 0.16 rg BT /F1 32 Tf 48 700 Td (Notes from the field) Tj ET BT /F1 14 Tf 48 650 Td (A second page to spread out and explore.) Tj ET';objects.extend([b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',b'<< /Length '+str(len(second)).encode()+b' >>\nstream\n'+second+b'\nendstream']);data=b'%PDF-1.4\n';offsets=[0]
  for i,obj in enumerate(objects,1):offsets.append(len(data));data+=str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
  xref=len(data);data+=b'xref\n0 8\n0000000000 65535 f \n'+b''.join(f'{n:010} 00000 n \n'.encode() for n in offsets[1:])+b'trailer << /Size 8 /Root 1 0 R >>\nstartxref\n'+str(xref).encode()+b'\n%%EOF\n';p.write_bytes(data)
 return root
