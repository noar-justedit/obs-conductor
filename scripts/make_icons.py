# OBS Conductor icons: python3 scripts/make_icons.py   (needs: pip install cairosvg pillow)
# Writes app.ico / tray_*.ico (Windows), app.svg, app-512.png (Linux) and
# app-mac-1024.png (macOS, turned into AppIcon.icns by build_mac.command).
#
# The drawing is Lucide's "list-video" icon (ISC licence, see
# src/icons/LUCIDE-LICENSE.txt), on the just edit lab black tile: white lines,
# pink play triangle. Taskbar variants: the same icon, only the triangle's
# colour changes (no added shape): green = all good, orange = needs a look,
# red = connection lost. Each size is drawn
# from the vector (sharper than shrinking the big one) and packed into one .ico.
import io, os, sys
import cairosvg
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'src', 'icons')
SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
PINK, WHITE, TILE = '#ff5ca8', '#eef0f4', '#0a0b0e'
COLORS = {'app': PINK, 'tray_ok': '#35c98b', 'tray_warn': '#f2a03d', 'tray_error': '#f2555a'}

# Lucide list-video, 24 x 24
LINES = '<path d="M21 5H3"/><path d="M10 12H3"/><path d="M10 19H3"/>'
PLAY = '<path d="M15 12.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997a1 1 0 0 1-1.517-.86z"/>'

def svg(color, small):
    sw = 2.6 if small else 2.2          # thicker strokes stay visible at 16 px
    s = 1.15
    tx, ty = 16 - 12.45 * s, 16 - 12 * s
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
            f'<rect width="32" height="32" rx="7" fill="{TILE}"/>'
            f'<g transform="translate({tx:.3f} {ty:.3f}) scale({s})" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="{sw}">'
            f'<g stroke="{WHITE}">{LINES}</g><g stroke="{color}" fill="{color}">{PLAY}</g></g></svg>')

def render(markup, size):
    png = cairosvg.svg2png(bytestring=markup.encode(), output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert('RGBA')

os.makedirs(OUT, exist_ok=True)
for name, color in COLORS.items():
    imgs = [render(svg(color, size <= 24), size) for size in SIZES]
    imgs[-1].save(os.path.join(OUT, name + '.ico'), format='ICO',
                  sizes=[(i.width, i.height) for i in imgs], append_images=imgs[:-1])
    if name == 'app':
        with open(os.path.join(OUT, 'app.svg'), 'w') as f: f.write(svg(PINK, False))

# Linux (.deb, AppImage): the tile as is, 512 px
render(svg(PINK, False), 512).save(os.path.join(OUT, 'app-512.png'))
# macOS: Apple's icon grid - the tile is 824 px wide in a 1024 px canvas,
# centred, with a soft shadow below (build_mac.command makes the .icns)
tile = render(svg(PINK, False), 824)
mac = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
from PIL import ImageFilter
shadow = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
mask = tile.split()[3].point(lambda a: int(a * 0.35))
shadow.paste((0, 0, 0, 255), (100, 112), mask)
mac = Image.alpha_composite(mac, shadow.filter(ImageFilter.GaussianBlur(14)))
mac.alpha_composite(tile, (100, 100))
mac.save(os.path.join(OUT, 'app-mac-1024.png'))
print('icons written to', os.path.abspath(OUT))
