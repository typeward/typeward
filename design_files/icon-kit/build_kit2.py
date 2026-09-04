import os, io, json, shutil
import cairosvg
from PIL import Image
import gen2 as G

ROOT = '/home/claude/icon-kit'
K = 512 / 480.0

LEFT, STEM, RIGHT = G.A_left.d(), G.A_stem.d(), G.A_right.d()
BODY_SQ = G.squircle(256, 256, 256, 112 * K)
KEY_SQ  = G.squircle(256, 256, 204, 76)

THEMES = {
    'dark': dict(
        body=['#2E3031', '#252728', '#1E2021'],
        ink=['#FFFBEC', '#F6EED6'],
        amber=['#F5AD44', '#EC9C2C'],
        edge=None,                       # dark body needs no edge definition
        shadow=('#000000', '.45'),
        flat=(30, 32, 33)),
    'light': dict(
        body=['#FCF8EC', '#F7F0DD', '#F0E6CD'],
        ink=['#333536', '#1F2122'],
        amber=['#C86D0D', '#AA5605'],    # deepened: the original amber is 1.7:1 on cream
        edge=('#241F14', '.16'),         # hairline, or the icon dissolves on a white page
        shadow=('#3A2F18', '.22'),
        flat=(246, 240, 221)),
}


def defs(t, emboss=True):
    s = f'''<defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{t['body'][0]}"/><stop offset=".5" stop-color="{t['body'][1]}"/><stop offset="1" stop-color="{t['body'][2]}"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{t['ink'][0]}"/><stop offset="1" stop-color="{t['ink'][1]}"/>
    </linearGradient>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{t['amber'][0]}"/><stop offset="1" stop-color="{t['amber'][1]}"/>
    </linearGradient>'''
    if emboss:
        s += f'''
    <filter id="raise" x="-20%" y="-25%" width="140%" height="150%">
      <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="{t['shadow'][0]}" flood-opacity="{t['shadow'][1]}"/>
    </filter>'''
    return s + '\n  </defs>'


def art(t, keyline=True, letter_scale=1.0, emboss=True, fatten=0, circle_key=False):
    f = ' filter="url(#raise)"' if emboss else ''
    inner = ''
    if keyline:
        inner += ('\n      <circle cx="256" cy="256" r="204" fill="none" stroke="url(#ink)" stroke-width="6.2"/>'
                  if circle_key else
                  f'\n      <path d="{KEY_SQ}" fill="none" stroke="url(#ink)" stroke-width="6.2"/>')
    ls = (f' transform="translate(256,255.5) scale({letter_scale}) translate(-256,-255.5)"'
          if letter_scale != 1.0 else '')
    si = sa = ''
    if fatten:
        j = f' stroke-width="{fatten}" stroke-linejoin="round"'
        si = f' stroke="{t["ink"][0]}"{j}'
        sa = f' stroke="{t["amber"][0]}"{j}'
    inner += (f'\n      <g{ls}>'
              f'\n        <path d="{LEFT}" fill="url(#ink)"{si}/>'
              f'\n        <path d="{STEM}" fill="url(#ink)"{si}/>'
              f'\n        <path d="{RIGHT}" fill="url(#amber)"{sa}/>\n      </g>')
    return f'  <g transform="translate(256,256) scale({K:.6f}) translate(-256,-256)"{f}>{inner}\n  </g>'


def svg(t, shape, keyline=True, letter_scale=1.0, emboss=True, fatten=0, edge=True):
    circle = shape == 'circle'
    bg = {'round':  f'  <path d="{BODY_SQ}" fill="url(#body)"/>',
          'square': '  <rect width="512" height="512" fill="url(#body)"/>',
          'circle': '  <circle cx="256" cy="256" r="256" fill="url(#body)"/>',
          'none':   ''}[shape]
    if t['edge'] and edge and shape in ('round', 'circle'):
        c, o = t['edge']
        bg += ('\n  <circle cx="256" cy="256" r="255" fill="none" stroke="%s" stroke-opacity="%s" stroke-width="2"/>' % (c, o)
               if circle else
               f'\n  <path d="{BODY_SQ}" fill="none" stroke="{c}" stroke-opacity="{o}" stroke-width="2"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" '
            f'role="img" aria-label="T icon">\n  {defs(t, emboss)}\n{bg}\n'
            f'{art(t, keyline, letter_scale, emboss, fatten, circle_key=circle)}\n</svg>\n')


def variants(t):
    return {
        'icon':               svg(t, 'round'),
        'icon-square':        svg(t, 'square'),
        'icon-circle':        svg(t, 'circle'),
        'icon-simple':        svg(t, 'round',  keyline=False, letter_scale=1.16, emboss=False),
        'icon-square-simple': svg(t, 'square', keyline=False, letter_scale=1.16, emboss=False),
        'icon-tiny':          svg(t, 'round',  keyline=False, letter_scale=1.16, emboss=False, fatten=9),
        'icon-square-tiny':   svg(t, 'square', keyline=False, letter_scale=1.16, emboss=False, fatten=9),
        'icon-maskable':      svg(t, 'square', keyline=False, emboss=False),
        'frame':              svg(t, 'none',   emboss=False),   # keyline + letter, no background
    }


def pick(size, square=False):
    base = 'icon-square' if square else 'icon'
    if size <= 24: return base + '-tiny'
    if size <= 64: return base + '-simple'
    return base


# ── tight-cropped marks (letter only, no frame, no background) ───────────────
def mark_svg(fills, box):
    x, y, w, h = box
    body = ''.join(f'\n  <path d="{d}" fill="{c}"/>' for d, c in fills)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x:.1f} {y:.1f} {w:.1f} {h:.1f}" '
            f'width="{w:.0f}" height="{h:.0f}" role="img" aria-label="T mark">{body}\n</svg>\n')


def measure_bbox():
    probe = mark_svg([(LEFT, '#000'), (STEM, '#000'), (RIGHT, '#000')], (0, 0, 512, 512))
    png = cairosvg.svg2png(bytestring=probe.encode(), output_width=2048, output_height=2048)
    im = Image.open(io.BytesIO(png)).convert('RGBA')
    bb = im.getbbox()
    s = 512 / 2048.0
    return (bb[0]*s, bb[1]*s, (bb[2]-bb[0])*s, (bb[3]-bb[1])*s)


def render(src, size, path, opaque=None, canvas=None, grayscale=False):
    big = min(size * 4, 2048)
    png = cairosvg.svg2png(url=src, output_width=big, output_height=big)
    im = Image.open(io.BytesIO(png)).convert('RGBA').resize((size, size), Image.LANCZOS)
    if grayscale:
        a = im.split()[3]
        im = Image.merge('RGBA', (*[im.convert('L')] * 3, a))
    if canvas:
        bg = Image.new('RGBA', canvas, (0, 0, 0, 0))
        bg.paste(im, ((canvas[0]-size)//2, (canvas[1]-size)//2), im)
        im = bg
    if opaque:
        flat = Image.new('RGB', im.size, opaque)
        flat.paste(im, mask=im.split()[3]); im = flat
    im.save(path)
    return im


def build(theme_name, base):
    t = THEMES[theme_name]
    src_dir = os.path.join(base, 'source'); os.makedirs(src_dir, exist_ok=True)
    for n, body in variants(t).items():
        open(os.path.join(src_dir, n + '.svg'), 'w').write(body)
    S = lambda n: os.path.join(src_dir, n + '.svg')
    flat = t['flat']
    mk = lambda *p: (os.makedirs(os.path.join(base, *p), exist_ok=True) or os.path.join(base, *p))

    # web ──────────────────────────────────────────────
    w = mk('web')
    shutil.copy(S('icon'), os.path.join(w, 'favicon.svg'))
    ico = [render(S(pick(s)), s, f'/tmp/{theme_name}f{s}.png') for s in (16, 32, 48)]
    ico[-1].save(os.path.join(w, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)],
                 append_images=ico[:-1])
    render(S('icon'), 96, os.path.join(w, 'favicon-96x96.png'))
    render(S('icon-square'), 180, os.path.join(w, 'apple-touch-icon.png'), opaque=flat)
    for s in (192, 512):
        render(S('icon'), s, os.path.join(w, f'web-app-manifest-{s}x{s}.png'))
        render(S('icon-maskable'), s, os.path.join(w, f'maskable-{s}x{s}.png'), opaque=flat)
    json.dump({"name": "T", "short_name": "T", "id": "/", "start_url": "/",
               "display": "standalone",
               "background_color": t['body'][1], "theme_color": t['body'][1],
               "icons": [
                   {"src": "/web-app-manifest-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                   {"src": "/web-app-manifest-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                   {"src": "/maskable-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
                   {"src": "/maskable-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]},
              open(os.path.join(w, 'site.webmanifest'), 'w'), indent=2)
    open(os.path.join(w, 'head-snippet.html'), 'w').write(
        '<link rel="icon" href="/favicon.ico" sizes="32x32">\n'
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n'
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n'
        '<link rel="manifest" href="/site.webmanifest">\n'
        f'<meta name="theme-color" content="{t["body"][1]}">\n')

    # windows ──────────────────────────────────────────
    win = mk('windows')
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    imgs = [render(S(pick(s)), s, f'/tmp/{theme_name}w{s}.png') for s in sizes]
    imgs[-1].save(os.path.join(win, 'app.ico'), sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
    tiles = mk('windows', 'msix')
    for name, box, inner in [('Square44x44Logo', (44, 44), 44), ('Square71x71Logo', (71, 71), 47),
                             ('Square150x150Logo', (150, 150), 100), ('Square310x310Logo', (310, 310), 205),
                             ('Wide310x150Logo', (310, 150), 100), ('StoreLogo', (50, 50), 50)]:
        render(S(pick(inner)), inner, os.path.join(tiles, name + '.png'), canvas=box)
    for s in (16, 24, 32, 48, 256):
        render(S(pick(s)), s, os.path.join(tiles, f'Square44x44Logo.targetsize-{s}.png'))

    # linux ────────────────────────────────────────────
    for s in (16, 22, 24, 32, 48, 64, 128, 256, 512):
        render(S(pick(s)), s, os.path.join(mk('linux', 'hicolor', f'{s}x{s}', 'apps'), 't-icon.png'))
    shutil.copy(S('icon'), os.path.join(mk('linux', 'hicolor', 'scalable', 'apps'), 't-icon.svg'))
    open(os.path.join(mk('linux'), 't-icon.desktop'), 'w').write(
        '[Desktop Entry]\nType=Application\nName=T\nComment=T application\n'
        'Exec=t-app %U\nIcon=t-icon\nTerminal=false\nCategories=Utility;\nStartupWMClass=t-app\n')

    # ios ──────────────────────────────────────────────
    ios = mk('ios', 'AppIcon.appiconset')
    spec = [(20,1,'iphone'),(20,2,'iphone'),(20,3,'iphone'),(29,1,'iphone'),(29,2,'iphone'),(29,3,'iphone'),
            (40,2,'iphone'),(40,3,'iphone'),(60,2,'iphone'),(60,3,'iphone'),
            (20,1,'ipad'),(20,2,'ipad'),(29,1,'ipad'),(29,2,'ipad'),(40,1,'ipad'),(40,2,'ipad'),
            (76,1,'ipad'),(76,2,'ipad'),(83.5,2,'ipad')]
    images, done = [], {}
    for pt, sc, idiom in spec:
        px = int(round(pt * sc))
        if px not in done:
            render(S(pick(px, square=True)), px, os.path.join(ios, f'AppIcon-{px}.png'), opaque=flat)
            done[px] = f'AppIcon-{px}.png'
        images.append({"size": f"{pt:g}x{pt:g}", "idiom": idiom, "filename": done[px], "scale": f"{sc}x"})
    render(S('icon-square'), 1024, os.path.join(ios, 'AppIcon-1024.png'), opaque=flat)
    images.append({"size": "1024x1024", "idiom": "ios-marketing", "filename": "AppIcon-1024.png", "scale": "1x"})
    json.dump({"images": images, "info": {"version": 1, "author": "xcode"}},
              open(os.path.join(ios, 'Contents.json'), 'w'), indent=2)

    # android ──────────────────────────────────────────
    for name, dpi in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
        d = mk('android', f'mipmap-{name}')
        render(S('icon'), dpi, os.path.join(d, 'ic_launcher.png'))
        render(S('icon-circle'), dpi, os.path.join(d, 'ic_launcher_round.png'))
    render(S('icon-square'), 512, os.path.join(mk('android'), 'play-store-512.png'), opaque=flat)
    adap = mk('android', 'mipmap-anydpi-v26')
    for f in ('ic_launcher.xml', 'ic_launcher_round.xml'):
        open(os.path.join(adap, f), 'w').write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@drawable/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n'
            '    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n'
            '</adaptive-icon>\n')
    drw = mk('android', 'drawable')
    SC, TX, TY = 0.15, 54 - 256*0.15, 54 - 255.5*0.15
    def vector(paths, ns=''):
        return (f'<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"{ns}\n'
                f'    android:width="108dp" android:height="108dp"\n'
                f'    android:viewportWidth="108" android:viewportHeight="108">\n'
                f'    <group android:scaleX="{SC}" android:scaleY="{SC}" '
                f'android:translateX="{TX:.3f}" android:translateY="{TY:.3f}">\n{paths}\n    </group>\n</vector>\n')
    ink_solid = t['ink'][0]; amb_solid = t['amber'][0]
    open(os.path.join(drw, 'ic_launcher_foreground.xml'), 'w').write(vector(
        f'        <path android:fillColor="{ink_solid}" android:pathData="{LEFT}"/>\n'
        f'        <path android:fillColor="{ink_solid}" android:pathData="{STEM}"/>\n'
        f'        <path android:fillColor="{amb_solid}" android:pathData="{RIGHT}"/>'))
    open(os.path.join(drw, 'ic_launcher_monochrome.xml'), 'w').write(vector(
        '\n'.join(f'        <path android:fillColor="#FFFFFF" android:pathData="{d}"/>' for d in (LEFT, STEM, RIGHT))))
    b = t['body']
    open(os.path.join(drw, 'ic_launcher_background.xml'), 'w').write(
        '<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    xmlns:aapt="http://schemas.android.com/aapt"\n'
        '    android:width="108dp" android:height="108dp"\n'
        '    android:viewportWidth="108" android:viewportHeight="108">\n'
        '    <path android:pathData="M0,0h108v108h-108z">\n        <aapt:attr name="android:fillColor">\n'
        '            <gradient android:type="linear" android:startX="54" android:startY="0" '
        'android:endX="54" android:endY="108">\n'
        f'                <item android:offset="0" android:color="#FF{b[0][1:]}"/>\n'
        f'                <item android:offset="0.5" android:color="#FF{b[1][1:]}"/>\n'
        f'                <item android:offset="1" android:color="#FF{b[2][1:]}"/>\n'
        '            </gradient>\n        </aapt:attr>\n    </path>\n</vector>\n')


# ═══════════════════════════ run ═══════════════════════════
shutil.rmtree(ROOT, ignore_errors=True)
build('dark',  ROOT)
build('light', os.path.join(ROOT, 'light'))

# ── background-free marks ────────────────────────────────────
BOX = measure_bbox()
m = os.path.join(ROOT, 'mark'); os.makedirs(m, exist_ok=True)
D, L = THEMES['dark'], THEMES['light']
MARKS = {
    'mark-on-dark':  [(LEFT, D['ink'][0]), (STEM, D['ink'][0]), (RIGHT, D['amber'][0])],
    'mark-on-light': [(LEFT, L['ink'][0]), (STEM, L['ink'][0]), (RIGHT, L['amber'][0])],
    'mark-white':    [(LEFT, '#FFFFFF'), (STEM, '#FFFFFF'), (RIGHT, '#FFFFFF')],
    'mark-black':    [(LEFT, '#000000'), (STEM, '#000000'), (RIGHT, '#000000')],
}
for name, fills in MARKS.items():
    open(os.path.join(m, name + '.svg'), 'w').write(mark_svg(fills, BOX))
    for s in (256, 512, 1024):
        big = min(s * 4, 2048)
        png = cairosvg.svg2png(url=os.path.join(m, name + '.svg'), output_width=big)
        im = Image.open(io.BytesIO(png)).convert('RGBA')
        im = im.resize((s, round(s * im.height / im.width)), Image.LANCZOS)
        im.save(os.path.join(m, f'{name}-{s}.png'))
# framed, background-free (keyline + letter)
shutil.copy(os.path.join(ROOT, 'source', 'frame.svg'), os.path.join(m, 'frame-on-dark.svg'))
shutil.copy(os.path.join(ROOT, 'light', 'source', 'frame.svg'), os.path.join(m, 'frame-on-light.svg'))
for n in ('frame-on-dark', 'frame-on-light'):
    for s in (512, 1024):
        render(os.path.join(m, n + '.svg'), s, os.path.join(m, f'{n}-{s}.png'))

# ── iOS 18 appearance set (default / dark / tinted) ──────────
app = os.path.join(ROOT, 'ios', 'AppIcon-Appearances.appiconset'); os.makedirs(app, exist_ok=True)
shutil.copy(os.path.join(ROOT, 'ios', 'AppIcon.appiconset', 'AppIcon-1024.png'),
            os.path.join(app, 'AppIcon-Default-1024.png'))
render(os.path.join(m, 'frame-on-dark.svg'), 1024, os.path.join(app, 'AppIcon-Dark-1024.png'))
render(os.path.join(m, 'frame-on-dark.svg'), 1024, os.path.join(app, 'AppIcon-Tinted-1024.png'), grayscale=True)
json.dump({"images": [
    {"filename": "AppIcon-Default-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"},
    {"appearances": [{"appearance": "luminosity", "value": "dark"}],
     "filename": "AppIcon-Dark-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"},
    {"appearances": [{"appearance": "luminosity", "value": "tinted"}],
     "filename": "AppIcon-Tinted-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
    "info": {"author": "xcode", "version": 1}},
    open(os.path.join(app, 'Contents.json'), 'w'), indent=2)

# ── theme-adaptive favicon ───────────────────────────────────
dark_svg = open(os.path.join(ROOT, 'source', 'icon.svg')).read()
light_svg = open(os.path.join(ROOT, 'light', 'source', 'icon.svg')).read()
def strip(svg_text, sfx):
    body = svg_text.split('>', 1)[1].rsplit('</svg>', 1)[0]
    for name in ('body', 'ink', 'amber', 'raise'):
        body = body.replace(f'id="{name}"', f'id="{name}{sfx}"')
        body = body.replace(f'url(#{name})', f'url(#{name}{sfx})')
    return body

adaptive = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n'
            '<style>.lt{display:block}.dk{display:none}'
            '@media (prefers-color-scheme:dark){.lt{display:none}.dk{display:block}}</style>\n'
            f'<g class="lt">{strip(light_svg, "L")}</g>\n'
            f'<g class="dk">{strip(dark_svg, "D")}</g>\n</svg>\n')
open(os.path.join(ROOT, 'web', 'favicon-adaptive.svg'), 'w').write(adaptive)
print('bbox', [round(v, 1) for v in BOX])
print('done')
