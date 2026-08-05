---
name: icons
description: Regenerate and re-route the Typeward app icon kit. design_files/icon-kit/ is the source of truth — NEVER run `npx tauri icon`. Covers every slot mapping (src-tauri/icons, msix, icns, favicons, BrandMark.tsx) and the Android re-init re-copy steps.
---

# App icons — kit workflow

Moved verbatim from the root CLAUDE.md Commands section (the root keeps a stub).

```
# Icons — DO NOT run `npx tauri icon`
# `design_files/icon-kit/` is the source of truth (2026-08-01). It ships
# optically-sized builds (icon-tiny <=24px, icon-simple 25-64px, icon >=65px)
# and two silhouettes (rounded for non-masking platforms, square full-bleed
# for masking ones). `tauri icon` resizes ONE artwork to every slot and would
# throw all of that away. Regenerate the kit with its own
# `design_files/icon-kit/build_kit2.py`, then re-route its outputs:
#   src-tauri/icons/{32,64,128}x*.png, icon.png  <- kit linux/hicolor/<size>
#   src-tauri/icons/icon.ico                     <- kit windows/app.ico
#   src-tauri/icons/Square*Logo.png, StoreLogo   <- kit windows/msix (5 sizes
#                                                   Tauri names are not in the
#                                                   kit; render icon.svg inset
#                                                   to 2/3 on transparency)
#   src-tauri/icons/icon.icns                    <- built from the kit's
#                                                   rounded PNGs + a 1024
#                                                   render (kit ships no icns)
#   public/favicon*, apple-touch-icon.png        <- kit web/
#   src-tauri/gen/android/app/src/main/res/      <- kit android/ (see below)
#   src/components/primitives/BrandMark.tsx      <- kit mark/mark-on-{dark,
#                                                   light}.svg — NOT a file
#                                                   copy: the three path `d`
#                                                   strings, VIEW_BOX and
#                                                   PALETTE are inlined
#                                                   literals, re-transcribe by
#                                                   hand (inline so the mark
#                                                   re-tints with isDarkTheme,
#                                                   not the OS appearance)
```

**Android icons live in gitignored `src-tauri/gen/`** and are wiped by
`tauri android init`. After any re-init, re-copy the kit's `android/` tree:
`drawable/ic_launcher_{background,foreground,monochrome}.xml`,
`mipmap-anydpi-v26/ic_launcher{,_round}.xml`, and the `mipmap-*` PNG
fallbacks — and delete `drawable-v24/ic_launcher_foreground.xml`, which
Tauri's template ships and which **shadows** `drawable/` on API >= 24 (i.e.
on every device that can render an adaptive icon at all).
