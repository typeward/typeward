import os, json, math, shutil
import cairosvg
from PIL import Image
import gen2 as G

OUT = '/home/claude/icon-kit'
S = 512
K = 512 / 480.0                      # source art was drawn on a 480 body inside 512

LEFT, STEM, RIGHT = G.A_left.d(), G.A_stem.d(), G.A_right.d()
BODY_SQ = G.squircle(256, 256, 256, 112 * K)
KEY_SQ  = G.squircle(256, 256, 204, 76)          # drawn in 480-space, scaled by the group

CREAM_A, CREAM_B = '#FFFBEC', '#F6EED6'
AMBER_A, AMBER_B = '#F5AD44', '#EC9C2C'
DARK = ['#2E3031', '#252728', '#1E2021']

DEFS = f'''<defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{DARK[0]}"/><stop offset=".5" stop-color="{DARK[1]}"/><stop offset="1" stop-color="{DARK[2]}"/>
    </linearGradient>
    <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{CREAM_A}"/><stop offset="1" stop-color="{CREAM_B}"/>
    </linearGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{AMBER_A}"/><stop offset="1" stop-color="{AMBER_B}"/>
    </linearGradient>
    <filter id="raise" x="-20%" y="-25%" width="140%" height="150%">
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="#000" flood-opacity=".45"/>
    </filter>
  </defs>'''

DEFS_FLAT = DEFS.replace('''<filter id="raise" x="-20%" y="-25%" width="140%" height="150%">
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="#000" flood-opacity=".45"/>
    </filter>
  ''', '')


def art(keyline=True, letter_scale=1.0, emboss=True, fatten=0):
    """artwork group, drawn in 480-space and scaled to fill the 512 canvas"""
    f = ' filter="url(#raise)"' if emboss else ''
    inner = ''
    if keyline:
        inner += f'\n      <path d="{KEY_SQ}" fill="none" stroke="url(#cream)" stroke-width="6.2"/>'
    ls = ''
    if letter_scale != 1.0:
        ls = f' transform="translate(256,255.5) scale({letter_scale}) translate(-256,-255.5)"'
    sc = sa = ''
    if fatten:
        j = f' stroke-width="{fatten}" stroke-linejoin="round"'
        sc = f' stroke="{CREAM_A}"{j}'
        sa = f' stroke="{AMBER_A}"{j}'
    inner += (f'\n      <g{ls}>'
              f'\n        <path d="{LEFT}" fill="url(#cream)"{sc}/>'
              f'\n        <path d="{STEM}" fill="url(#cream)"{sc}/>'
              f'\n        <path d="{RIGHT}" fill="url(#amber)"{sa}/>\n      </g>')
    return f'  <g transform="translate(256,256) scale({K:.6f}) translate(-256,-256)"{f}>{inner}\n  </g>'


def svg(bg, keyline=True, letter_scale=1.0, emboss=True, fatten=0, label='T app icon'):
    defs = DEFS if emboss else DEFS_FLAT
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" '
            f'role="img" aria-label="{label}">\n  {defs}\n{bg}\n'
            f'{art(keyline, letter_scale, emboss, fatten)}\n</svg>\n')


BG_ROUND  = f'  <path d="{BODY_SQ}" fill="url(#body)"/>'
BG_SQUARE = '  <rect width="512" height="512" fill="url(#body)"/>'
BG_CIRCLE = '  <circle cx="256" cy="256" r="256" fill="url(#body)"/>'
KEY_CIRCLE = ('\n      <circle cx="256" cy="256" r="204" fill="none" '
              'stroke="url(#cream)" stroke-width="6.2"/>')

VARIANTS = {
    'icon':          svg(BG_ROUND),                                        # master, rounded, transparent corners
    'icon-square':   svg(BG_SQUARE),                                       # full bleed — iOS / stores
    'icon-simple':   svg(BG_ROUND,  keyline=False, letter_scale=1.16, emboss=False),
    'icon-square-simple': svg(BG_SQUARE, keyline=False, letter_scale=1.16, emboss=False),
    'icon-maskable': svg(BG_SQUARE, keyline=False, emboss=False),          # safe-zone friendly
    'icon-tiny':     svg(BG_ROUND,  keyline=False, letter_scale=1.16, emboss=False, fatten=9),
    'icon-square-tiny': svg(BG_SQUARE, keyline=False, letter_scale=1.16, emboss=False, fatten=9),
}

def pick(size, square=False):
    base = 'icon-square' if square else 'icon'
    if size <= 24:  return base + '-tiny'
    if size <= 64:  return base + '-simple'
    return base
# circular build for Android's round launcher slot
VARIANTS['icon-circle'] = (svg(BG_CIRCLE).replace(f'<path d="{KEY_SQ}" fill="none" stroke="url(#cream)" stroke-width="6.2"/>',
                                                  KEY_CIRCLE.strip()))
# single-colour silhouette
VARIANTS['icon-mono'] = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n'
                         f'  <g transform="translate(256,256) scale({K:.6f}) translate(-256,-256)" fill="#000">\n'
                         f'    <path d="{LEFT}"/><path d="{STEM}"/><path d="{RIGHT}"/>\n  </g>\n</svg>\n')


def mk(*p):
    d = os.path.join(OUT, *p); os.makedirs(d, exist_ok=True); return d

def render(variant, size, path, opaque=False, canvas=None):
    """render at 4x then Lanczos down — much cleaner small sizes than direct rasterising"""
    src = os.path.join(OUT, 'source', variant + '.svg')
    big = min(size * 4, 2048)
    png = cairosvg.svg2png(url=src, output_width=big, output_height=big)
    import io
    im = Image.open(io.BytesIO(png)).convert('RGBA').resize((size, size), Image.LANCZOS)
    if canvas:
        bg = Image.new('RGBA', canvas, (0, 0, 0, 0))
        bg.paste(im, ((canvas[0]-size)//2, (canvas[1]-size)//2), im)
        im = bg
    if opaque:
        flat = Image.new('RGB', im.size, (30, 32, 33))
        flat.paste(im, mask=im.split()[3]); im = flat
    im.save(path)
    return im


# ───────────────────────── source ─────────────────────────
mk('source')
for name, body in VARIANTS.items():
    open(os.path.join(OUT, 'source', name + '.svg'), 'w').write(body)

# ───────────────────────── web ─────────────────────────
w = mk('web')
shutil.copy(os.path.join(OUT, 'source', 'icon.svg'), os.path.join(w, 'favicon.svg'))
ico = [render(pick(s), s, f'/tmp/f{s}.png') for s in (16, 32, 48)]
ico[-1].save(os.path.join(w, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)],
             append_images=ico[:-1])
render('icon', 96, os.path.join(w, 'favicon-96x96.png'))
render('icon-square', 180, os.path.join(w, 'apple-touch-icon.png'), opaque=True)
for s in (192, 512):
    render('icon', s, os.path.join(w, f'web-app-manifest-{s}x{s}.png'))
    render('icon-maskable', s, os.path.join(w, f'maskable-{s}x{s}.png'), opaque=True)

json.dump({
    "name": "T", "short_name": "T", "id": "/",
    "start_url": "/", "display": "standalone",
    "background_color": "#252728", "theme_color": "#252728",
    "icons": [
        {"src": "/web-app-manifest-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "/web-app-manifest-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "/maskable-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
        {"src": "/maskable-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}
    ]}, open(os.path.join(w, 'site.webmanifest'), 'w'), indent=2)

open(os.path.join(w, 'head-snippet.html'), 'w').write('''<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#252728">
''')

# ───────────────────────── windows ─────────────────────────
win = mk('windows')
sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
imgs = [render(pick(s), s, f'/tmp/w{s}.png') for s in sizes]
imgs[-1].save(os.path.join(win, 'app.ico'), sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
tiles = mk('windows', 'msix')
for name, box, inner in [('Square44x44Logo', (44, 44), 44), ('Square71x71Logo', (71, 71), 47),
                         ('Square150x150Logo', (150, 150), 100), ('Square310x310Logo', (310, 310), 205),
                         ('Wide310x150Logo', (310, 150), 100), ('StoreLogo', (50, 50), 50)]:
    render(pick(inner), inner, os.path.join(tiles, name + '.png'), canvas=box)
for t in (16, 24, 32, 48, 256):
    render(pick(t), t, os.path.join(tiles, f'Square44x44Logo.targetsize-{t}.png'))

# ───────────────────────── linux ─────────────────────────
for s in (16, 22, 24, 32, 48, 64, 128, 256, 512):
    d = mk('linux', 'hicolor', f'{s}x{s}', 'apps')
    render(pick(s), s, os.path.join(d, 't-icon.png'))
d = mk('linux', 'hicolor', 'scalable', 'apps')
shutil.copy(os.path.join(OUT, 'source', 'icon.svg'), os.path.join(d, 't-icon.svg'))
open(os.path.join(OUT, 'linux', 't-icon.desktop'), 'w').write('''[Desktop Entry]
Type=Application
Name=T
Comment=T application
Exec=t-app %U
Icon=t-icon
Terminal=false
Categories=Utility;
StartupWMClass=t-app
''')

# ───────────────────────── ios ─────────────────────────
ios = mk('ios', 'AppIcon.appiconset')
spec = [(20, 1, 'iphone'), (20, 2, 'iphone'), (20, 3, 'iphone'),
        (29, 1, 'iphone'), (29, 2, 'iphone'), (29, 3, 'iphone'),
        (40, 2, 'iphone'), (40, 3, 'iphone'), (60, 2, 'iphone'), (60, 3, 'iphone'),
        (20, 1, 'ipad'), (20, 2, 'ipad'), (29, 1, 'ipad'), (29, 2, 'ipad'),
        (40, 1, 'ipad'), (40, 2, 'ipad'), (76, 1, 'ipad'), (76, 2, 'ipad'), (83.5, 2, 'ipad')]
images, done = [], {}
for pt, sc, idiom in spec:
    px = int(round(pt * sc))
    fn = f'AppIcon-{px}.png'
    if px not in done:
        render(pick(px, square=True), px, os.path.join(ios, fn), opaque=True)
        done[px] = fn
    images.append({"size": f"{pt:g}x{pt:g}", "idiom": idiom,
                   "filename": done[px], "scale": f"{sc}x"})
render('icon-square', 1024, os.path.join(ios, 'AppIcon-1024.png'), opaque=True)
images.append({"size": "1024x1024", "idiom": "ios-marketing",
               "filename": "AppIcon-1024.png", "scale": "1x"})
json.dump({"images": images, "info": {"version": 1, "author": "xcode"}},
          open(os.path.join(ios, 'Contents.json'), 'w'), indent=2)

# ───────────────────────── android ─────────────────────────
for name, dpi in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    d = mk('android', f'mipmap-{name}')
    render('icon', dpi, os.path.join(d, 'ic_launcher.png'))
    render('icon-circle', dpi, os.path.join(d, 'ic_launcher_round.png'))
render('icon-square', 512, os.path.join(mk('android'), 'play-store-512.png'), opaque=True)

adap = mk('android', 'mipmap-anydpi-v26')
for f in ('ic_launcher.xml', 'ic_launcher_round.xml'):
    open(os.path.join(adap, f), 'w').write('''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>
''')

drw = mk('android', 'drawable')
SC, TX, TY = 0.15, 54 - 256 * 0.15, 54 - 255.5 * 0.15
def vector(paths, extra=''):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"{extra}
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <group android:scaleX="{SC}" android:scaleY="{SC}"
           android:translateX="{TX:.3f}" android:translateY="{TY:.3f}">
{paths}
    </group>
</vector>
'''
open(os.path.join(drw, 'ic_launcher_foreground.xml'), 'w').write(vector(
    f'        <path android:fillColor="#FBF5E2" android:pathData="{LEFT}"/>\n'
    f'        <path android:fillColor="#FBF5E2" android:pathData="{STEM}"/>\n'
    f'        <path android:fillColor="#F1A438" android:pathData="{RIGHT}"/>'))
open(os.path.join(drw, 'ic_launcher_monochrome.xml'), 'w').write(vector(
    f'        <path android:fillColor="#FFFFFF" android:pathData="{LEFT}"/>\n'
    f'        <path android:fillColor="#FFFFFF" android:pathData="{STEM}"/>\n'
    f'        <path android:fillColor="#FFFFFF" android:pathData="{RIGHT}"/>'))
open(os.path.join(drw, 'ic_launcher_background.xml'), 'w').write('''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient android:type="linear"
                android:startX="54" android:startY="0" android:endX="54" android:endY="108">
                <item android:offset="0" android:color="#FF2E3031"/>
                <item android:offset="0.5" android:color="#FF252728"/>
                <item android:offset="1" android:color="#FF1E2021"/>
            </gradient>
        </aapt:attr>
    </path>
</vector>
''')
print('built')
