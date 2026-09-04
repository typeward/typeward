# Third-party notices

Typeward's own source is licensed under the MIT License with the Commons Clause
condition (see `LICENSE`), which withholds the right to Sell the software. It
bundles and links third-party components that keep their own licenses, so the
packaged application as a whole carries no single license: the MIT-plus-clause
grant covers Typeward's code, and each third-party component below is governed
by the license named against it. The clause constrains Typeward's own code
only. It places no condition on the third-party components, which remain
available to you under their own terms. Build-only tooling never reaches a shipped binary and therefore
places no condition on the distributed work. Nothing third-party is
redistributed in this repository in source form.

## Linked at build time

Rust crates and npm packages are resolved from their registries and are not
redistributed here in source form. The notable ones and their licenses:

| Component | License |
| --- | --- |
| Tauri, wry, and the Tauri plugins | MIT OR Apache-2.0 |
| `tao` (Tauri's windowing crate) | Apache-2.0 only |
| Solid.js, `@solidjs/router` | MIT |
| CodeMirror 6 packages | MIT |
| `@replit/codemirror-vim` | MIT |
| Kobalte, corvu | MIT |
| PDF.js (`pdfjs-dist`) | Apache-2.0 |
| KaTeX | MIT |
| markdown-it | MIT |
| `markdown-it-anchor` | Unlicense |
| DOMPurify | MPL-2.0 OR Apache-2.0 |
| `nanoid` | MIT |
| Inter, JetBrains Mono (`@fontsource-variable/*`) | SIL Open Font License 1.1 |
| lucide-solid | ISC |
| `@typeward/texlive-wasm` (the JS/wasm wrapper package) | MIT |
| `harper-core`, `harper-tex`, `harper-typst` (grammar engine) | Apache-2.0 |
| `git2` (Rust bindings) | MIT OR Apache-2.0 |
| libgit2 (C library) | GPL-2.0-only WITH a linking exception |

libgit2 is the one dependency worth spelling out. It is GPLv2, which on its own
would force its terms onto anything it is linked into, but it ships a linking
exception giving unlimited permission to link the compiled library into
combinations with other programs and to distribute those combinations without
restriction. That exception is what makes shipping it inside an MIT-licensed
application lawful. libgit2 itself is still conveyed under GPLv2 with that
exception: it is used unmodified, and upstream at https://github.com/libgit2/libgit2
is the corresponding source.

`tao` is the second worth naming: unlike the rest of the Tauri stack it offers
no MIT option, so Apache-2.0 governs it. Apache-2.0 imposes nothing that
conflicts with MIT, but it does carry obligations MIT does not: preserve the
license and any NOTICE file with redistributions, state significant changes,
and accept its patent grant and the termination clause attached to it. PDF.js
and the `harper-*` grammar crates are Apache-2.0 on the same footing. DOMPurify
is taken under its Apache-2.0 option.

The fonts and the compiled frontend assets do end up inside the binary. The
SIL Open Font License 1.1 text and both font copyright notices travel with
the `@fontsource-variable/*` packages, and OFL condition 2 requires them to
accompany a full attribution bundle (see Completeness).

Typeward renders through the platform webview: WebView2 on Windows
(proprietary, Microsoft), WKWebView on macOS, and WebKitGTK on Linux (LGPL).
None is distributed with Typeward. They are operating-system components the
application loads at runtime, and the LGPL's dynamic-linking allowance covers
WebKitGTK on that basis.

Run `cargo tree` or `npm ls` for the exhaustive dependency set.

## Redistributed in release builds

These are not in this repository, since each is fetched per host during
setup, but they are copied into the packaged application, so their notices
travel with it.

- **Tectonic** (MIT), fetched by `npm run fetch:tectonic` into
  `src-tauri/binaries/` and shipped as a Tauri `externalBin` sidecar in
  desktop release builds. MIT requires its copyright notice and permission
  notice to accompany binary copies; that attribution is not yet captured
  here (see Completeness).
- **TeX Live tree and wasm engines** (mobile only), fetched by
  `npx texlive-wasm download-assets` into `src-tauri/resources/texlive-wasm/`
  and `public/texlive-wasm/`. The `tauri.android.conf.json` and
  `tauri.ios.conf.json` overlays list `resources/texlive-wasm/**/*` in
  `bundle.resources`, so the TeX Live TDS tree is bundled into Android and
  iOS packages; the desktop `tauri.conf.json` deliberately omits it. TeX Live
  has no single license: it is a collection of independently licensed
  packages (LaTeX under the LPPL, TeX and Computer Modern under Knuth's own
  terms, and others besides), all freely redistributable under TeX Live's own
  copying conditions. Those conditions ship as `LICENSE.TL` in
  https://github.com/typeward/texlive-wasm, which is the authority for the
  exact set of packages a given asset download pulls in. The
  `@typeward/texlive-wasm` wrapper itself is MIT.

## Tools invoked, not bundled

Typeward shells out to TeX and Typst toolchains the user installs themselves
(`latexmk`, `pdflatex`, `typst`, `texlab`, `tinymist`, `synctex`). Those are
separate programs under their own licenses and are not part of this work.

## Completeness

This file is a curated summary, not an exhaustive manifest. A complete
per-dependency attribution bundle, meaning every transitive crate and package
with its own copyright holders and full license text, has not been generated;
`cargo-about` on the Rust side and `license-checker` on the npm side are the
tools that would produce it. Until then, license texts for the MIT, ISC, OFL,
Apache-2.0 and (MPL-2.0 OR Apache-2.0) components ship inside their upstream
packages rather than being collected here; the only license text kept in this
repository is Typeward's own `LICENSE`.
