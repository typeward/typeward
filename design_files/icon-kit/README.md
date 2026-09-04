# T — icon kit

One vector source, three themes' worth of output. Every PNG is rendered from the
SVG at 4× and downsampled — nothing is upscaled from a raster.

```
icon-kit/
  source/     dark-theme SVG sources
  web/  windows/  linux/  ios/  android/     dark theme (default)
  light/      the same five platform trees, light theme
  mark/       background-free marks and frames
```

## Optical sizing

A single artwork can't serve a 16px favicon and a 1024px store tile. Three builds
exist and each output size gets the right one automatically:

| Size | Build | What changes |
|---|---|---|
| ≤ 24px | `icon-tiny` | No keyline. Letter enlarged 16% and weighted up until the two diagonal channels close — below ~24px they're sub-pixel and read as dirt, not detail. |
| 25–64px | `icon-simple` | No keyline (it would render thinner than one pixel), letter enlarged 16%. Channels intact. |
| ≥ 65px | `icon` | Full artwork: keyline, channels, embossed letter. |

Two silhouettes run alongside those:

- **rounded** — the design's own squircle, transparent outside. For platforms that
  do *not* mask (Windows, Linux, web favicons).
- **square** — full bleed, no rounding, no transparency. For platforms that *do*
  mask (iOS, Android adaptive, app stores). Never ship a pre-rounded icon into a
  masking platform; you get a double-rounded corner.

The cast shadow from the presentation render is gone. Baked into an app icon it
fights the platform's own elevation and wastes canvas.

## Themes

### Dark (default)

Body `#2E3031 → #1E2021`, cream `#FFFBEC → #F6EED6`, amber `#F5AD44 → #EC9C2C`.

### Light (`light/`)

Not a colour inversion — two things had to change beyond swapping ink and ground:

**The amber is deepened** to `#C86D0D → #AA5605`. The original amber sits at
**1.7:1** against cream, so the right arm would have all but vanished; the
deepened tone reads at **3.3:1** while staying recognisably the same hue. It's
the same relationship the amber has to the dark ground (7.8:1) as far as the eye
is concerned, just solved in the other direction.

**A hairline edge** (`#241F14` at 16%) is added to the rounded and circular
builds. A cream icon on a white page has no silhouette otherwise. It is
deliberately absent from the full-bleed square builds — there, a border would
draw a rectangle that the platform's mask then slices through the corners of.

Ink is `#333536 → #1F2122` at 10.8:1 on the ground.

## `mark/` — no background

| File | Use |
|---|---|
| `mark-on-dark.svg` | Letter only, cream + amber. For dark surfaces. |
| `mark-on-light.svg` | Letter only, dark ink + deepened amber. For light surfaces. |
| `mark-white.svg` / `mark-black.svg` | Single-colour, for print, watermarks, embroidery, anywhere one ink is all you get. |
| `frame-on-dark.svg` / `frame-on-light.svg` | Keyline + letter, no filled body. The icon's full identity on any surface. |

The four `mark-*` files are cropped tight to the letterform (243 × 263) rather
than sitting on a padded square, so they can be baselined and spaced like type.
PNGs at 256 / 512 / 1024 accompany each, transparent.

## web/

Drop at your web root, paste `head-snippet.html` into `<head>`, and edit `name`,
`short_name` and `start_url` in `site.webmanifest`.

`favicon.ico` carries 16/32/48. `apple-touch-icon.png` is 180×180 opaque — iOS
rounds it itself. The `maskable-*` files are declared `purpose: maskable` so
Chrome and Android can crop them to any shape without clipping the mark.

`favicon-adaptive.svg` is optional: it carries both themes and switches on
`prefers-color-scheme`, so the favicon follows the browser's theme. Use it in
place of `favicon.svg` if you want that:

```html
<link rel="icon" href="/favicon-adaptive.svg" type="image/svg+xml">
```

The `light/web/` tree is the alternative if you'd rather serve a light favicon
explicitly by media query than rely on the in-SVG switch.

## windows/

`app.ico` carries 16/20/24/32/40/48/64/96/128/256 — everything Explorer, the
taskbar and Alt-Tab pull from. In .NET: `<ApplicationIcon>app.ico</ApplicationIcon>`.

`msix/` holds Store and tile assets, transparent with the mark inset to ~66% so
the tile background colour from `Package.appxmanifest` shows through.
`Square44x44Logo.targetsize-*` are the unplated taskbar variants.

## linux/

Freedesktop hicolor theme:

```sh
for d in icon-kit/linux/hicolor/*/apps; do
  s=$(basename $(dirname $d))
  xdg-icon-resource install --novendor --size ${s%%x*} $d/t-icon.png t-icon 2>/dev/null
done
install -Dm644 icon-kit/linux/hicolor/scalable/apps/t-icon.svg \
  ~/.local/share/icons/hicolor/scalable/apps/t-icon.svg
install -Dm644 icon-kit/linux/t-icon.desktop ~/.local/share/applications/t-icon.desktop
update-desktop-database ~/.local/share/applications
```

Rename `t-icon` to your reverse-DNS app id before shipping — Wayland matches the
icon against `StartupWMClass`/app id and a generic name will miss.

## ios/

**`AppIcon.appiconset`** — the classic full set. Drag into `Assets.xcassets`. All
PNGs are opaque sRGB with no alpha channel, which App Store validation rejects
icons for.

**`AppIcon-Appearances.appiconset`** — the modern single-size set with Default /
Dark / Tinted variants (iOS 18+). The Dark entry is `frame-on-dark` with a
transparent background: iOS composites its own dark ground behind it, so shipping
an opaque dark tile there would look wrong next to system icons. The Tinted entry
is the same artwork in greyscale, which is what the system expects to apply its
tint to — the amber arm lands as a mid-grey and survives as a distinct value.

Use one set or the other, not both.

## android/

Adaptive icon, API 26+:

- `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`
- `drawable/ic_launcher_background.xml` — gradient vector, fills the 108dp canvas
- `drawable/ic_launcher_foreground.xml` — the letter as a real `VectorDrawable`,
  scaled into the 66dp safe zone. The keyline is deliberately absent: it sits too
  close to the edge to survive a circular mask.
- `drawable/ic_launcher_monochrome.xml` — themed icons, Android 13+

`mipmap-*/ic_launcher.png` (48–192) are the pre-API-26 fallbacks, with
`ic_launcher_round.png` for launchers that request the round slot.
`play-store-512.png` is the Console listing icon: 512×512, opaque, square.

Android picks the launcher icon by manifest, not by system theme — the
`light/android/` tree is there if you want to ship a light icon as the default,
not as an automatic alternate. Theme response on Android comes from the
monochrome layer.

## Regenerating

`build_kit2.py` produces the entire tree, both themes, from the source paths in
`gen2.py`. Change a colour or a curve in one place and rebuild rather than
editing 140 PNGs.
