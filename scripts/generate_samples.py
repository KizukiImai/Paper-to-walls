"""Generate deterministic synthetic drawing fixtures. Requires Pillow only.
These are test images, not real camera photographs. Runtime app has no Python dependency.
"""
from pathlib import Path
import math, random, json
from PIL import Image, ImageDraw, ImageFilter
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'web' / 'samples'
OUT.mkdir(parents=True, exist_ok=True)
W, H = 1000, 800
RECT = [(160, 145, 840, 145), (840, 145, 840, 655), (840, 655, 160, 655), (160, 655, 160, 145)]
ROOM = RECT + [(500, 655, 500, 315), (500, 315, 840, 315)]
CASES = {'room': ROOM, 'rectangle': RECT, 'L': [(200, 180, 200, 620), (200, 620, 800, 620)], 'T': [(160, 200, 840, 200), (500, 200, 500, 640)], 'cross': [(160, 400, 840, 400), (500, 160, 500, 640)], 'diagonal': [(180, 180, 820, 620)], 'gap': [(160, 400, 440, 400), (550, 400, 840, 400)], 'thick': [(160, 400, 840, 400)]}
for name, lines in CASES.items():
    img = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(img)
    for line in lines: d.line(line, fill=(32, 35, 32), width=25 if name == 'thick' else 9)
    img.save(OUT / f'{name}.png')
# Mild pen jitter, a lighting gradient, and specks; useful for testing more than clean vector lines.
rng = random.Random(7)
img = Image.new('RGB', (W, H)); p = img.load()
for y in range(H):
    for x in range(W):
        val = int(245 - 27 * x / W - 9 * y / H)
        p[x, y] = (val, val, max(0, val - 3))
d = ImageDraw.Draw(img)
for ax, ay, bx, by in ROOM:
    pts = [(ax + (bx-ax)*t/30 + rng.uniform(-1.3,1.3), ay + (by-ay)*t/30 + rng.uniform(-1.3,1.3)) for t in range(31)]
    d.line(pts, fill=(25, 28, 24), width=9, joint='curve')
for _ in range(45):
    x,y=rng.randint(30,970),rng.randint(30,770); d.ellipse((x,y,x+1,y+1), fill=(125,125,120))
img.save(OUT / 'handdrawn-lighting.png')
# A paper quadrilateral on a dark tabletop, projectively distorted using Pillow's inverse mapping.
# Solve the inverse homography without numpy so the generator only requires Pillow.
quad = [(165,100),(1060,150),(1030,875),(90,820)]
src = [(0,0),(999,0),(999,799),(0,799)]
rows=[]; rhs=[]
for (x,y),(u,v) in zip(quad,src):
    rows += [[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]; rhs += [u,v]
a=[r+[b] for r,b in zip(rows,rhs)]
for i in range(8):
    pivot=max(range(i,8),key=lambda k:abs(a[k][i])); a[i],a[pivot]=a[pivot],a[i]
    div=a[i][i]; a[i]=[v/div for v in a[i]]
    for j in range(8):
        if i!=j:
            f=a[j][i]; a[j]=[v-f*u for v,u in zip(a[j],a[i])]
coeffs=tuple(a[i][8] for i in range(8))
base=Image.open(OUT/'room.png')
warped=base.transform((1200,960),Image.Transform.PERSPECTIVE,coeffs,Image.Resampling.BICUBIC,fillcolor=(91,93,86))
warped.save(OUT/'perspective.png')
(OUT/'perspective-corners.json').write_text(json.dumps({'corners':[{'x':x,'y':y} for x,y in quad], 'aspect':1.25},indent=2)+'\n')
print('Generated', len(list(OUT.glob('*.png'))), 'PNG fixtures.')
