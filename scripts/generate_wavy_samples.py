"""Generate synthetic pen-wobble fixtures (Pillow is required only for this developer script)."""
from pathlib import Path
from PIL import Image, ImageDraw
import math
ROOT = Path(__file__).resolve().parents[1] / "web" / "samples"
def stroke(draw, a, b, amp=7, periods=4, width=8):
    dx, dy = b[0]-a[0], b[1]-a[1]
    length = math.hypot(dx,dy)
    points = []
    for i in range(int(length)+1):
        t = i/int(length)
        offset = amp*math.sin(t*math.pi*2*periods)*math.sin(math.pi*t)**0.4
        points.append((a[0]+dx*t-offset*dy/length, a[1]+dy*t+offset*dx/length))
    draw.line(points,fill=(30,30,30),width=width,joint="curve")
image=Image.new("RGB",(900,650),"white")
stroke(ImageDraw.Draw(image),(120,325),(780,325),amp=10)
image.save(ROOT / "wavy-line.png")
image=Image.new("RGB",(900,650),"white")
draw=ImageDraw.Draw(image)
for a,b in [((120,100),(780,100)),((780,100),(780,550)),((780,550),(120,550)),((120,550),(120,100)),((450,550),(450,325)),((450,325),(780,325))]:
    stroke(draw,a,b,amp=7,periods=3)
image.save(ROOT / "wavy-room.png")
