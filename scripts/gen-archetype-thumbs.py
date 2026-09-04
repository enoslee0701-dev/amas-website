"""Generate strip thumbnails for the 12 growth archetypes.

Source cards (800x1200) carry the number/title at the top, the character in the
middle-left, and a right-hand column of fine print that is unreadable at strip
size. We keep only the top TOP_FRACTION so the card reads as "number + name +
face" and ship WebP at 3x the largest display width.

Run after replacing any assets/img/archetypes/*.jpg. Output is committed.
"""
import pathlib
from PIL import Image

TOP_FRACTION = 0.62          # clears every face; 06 Mercy Giver sits lowest and sets this floor
OUT_WIDTH = 384              # 3x the 128px max display width
QUALITY = 82

root = pathlib.Path(__file__).resolve().parent.parent
src_dir = root / "assets" / "img" / "archetypes"
out_dir = src_dir / "thumbs"
out_dir.mkdir(exist_ok=True)

total_src = total_out = 0
for src in sorted(src_dir.glob("*.jpg")):
    im = Image.open(src).convert("RGB")
    im = im.crop((0, 0, im.width, int(im.height * TOP_FRACTION)))
    im = im.resize((OUT_WIDTH, round(OUT_WIDTH * im.height / im.width)), Image.LANCZOS)
    out = out_dir / (src.stem + ".webp")
    im.save(out, "WEBP", quality=QUALITY, method=6)
    total_src += src.stat().st_size
    total_out += out.stat().st_size
    print("%-24s %s -> %s  %5.1fKB" % (src.name, "800x1200", "%dx%d" % im.size, out.stat().st_size / 1024))

print("\n源图合计 %.1f KB  ->  缩略图合计 %.1f KB  (%.0f%%)" % (
    total_src / 1024, total_out / 1024, 100 * total_out / total_src))
