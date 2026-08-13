# Third-party notices

Typeward is licensed under the GNU General Public License v3.0 or later
(see `LICENSE`). It bundles and links third-party components under their own
licenses. Every component distributed in a Typeward binary is compatible with
GPLv3. Build-only tooling is held to a lower bar and is listed separately at
the end — one such package is not GPL-compatible and never reaches a shipped
binary. Full license texts for components redistributed in source form live in
`LICENSES/`.

## Redistributed in this repository

### harper-core

- Path: `src-tauri/vendor/harper-core/`
- Upstream: https://github.com/automattic/harper
- Version: 2.7.0
- License: Apache License 2.0 (`LICENSES/Apache-2.0.txt`, also copied to
  `src-tauri/vendor/harper-core/LICENSE`)

A vendored copy of the grammar engine behind Typeward's on-device grammar
checking. Apache-2.0 permits redistribution under GPLv3; the license text is
kept alongside the source as Apache-2.0 section 4(a) requires.

**The copy is modified.** Three files add an `as fn(&TokenKind) -> bool` cast
to a lint predicate array so the crate compiles on current rustc — the
rationale is spelled out in `src-tauri/Cargo.toml`:

- `src/linting/for_free_of_charge.rs` (two sites)
- `src/linting/in_demand_in_depth.rs`
- `src/linting/naked_eye.rs`

Each of the three carries a header notice recording the change, as Apache-2.0
section 4(b) requires. Nothing else in the crate differs from upstream 2.7.0
beyond the dropped `tests/` and `benches/` directories.

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
| `git2` (Rust bindings) | MIT OR Apache-2.0 |
| libgit2 (C library) | GPL-2.0-only WITH a linking exception |

libgit2 is the one dependency worth spelling out: it is GPLv2, which alone
would be incompatible with GPLv3, but it ships a linking exception that
explicitly permits combining it with a program under any license. That
exception is what makes the combination lawful here.

`tao` is the second: unlike the rest of the Tauri stack it offers no MIT
option. Apache-2.0 is one-way compatible with GPLv3, so linking it into a
GPLv3-or-later work is fine — the reverse direction would not be.

The fonts and the compiled frontend assets do end up inside the binary, so
`LICENSES/OFL-1.1.txt` carries the SIL Open Font License 1.1 together with both
font copyright notices, as OFL condition 2 requires.

Typeward renders through the platform webview — WebView2 on Windows
(proprietary, Microsoft), WKWebView on macOS, and WebKitGTK on Linux (LGPL).
None is distributed with Typeward; they are operating-system components and
fall under the GPL's system library exception.

Run `cargo tree` or `npm ls` for the exhaustive dependency set.

## Redistributed in release builds

These are not in this repository — each is fetched per host during setup — but
they are copied into the packaged application, so their notices travel with it.

- **Tectonic** (MIT) — fetched by `npm run fetch:tectonic` into
  `src-tauri/binaries/` and shipped as a Tauri `externalBin` sidecar in desktop
  release builds. MIT requires its copyright notice and permission notice
  accompany binary copies; `LICENSES/MIT.txt` carries the license text, but
  Tectonic's own copyright line is not yet captured there (see Completeness).
- **TeX Live tree and wasm engines** (mobile only) — fetched by
  `npx texlive-wasm download-assets` into `src-tauri/resources/texlive-wasm/`
  and `public/texlive-wasm/`. The `tauri.android.conf.json` and
  `tauri.ios.conf.json` overlays list `resources/texlive-wasm/**/*` in
  `bundle.resources`, so the TeX Live TDS tree is bundled into Android and iOS
  packages; the desktop `tauri.conf.json` deliberately omits it. TeX Live has
  no single license — it is a collection of independently licensed packages
  (LaTeX under the LPPL, TeX and Computer Modern under Knuth's own terms, and
  others besides), all freely redistributable under TeX Live's own copying
  conditions. Those conditions ship as `LICENSE.TL` in
  https://github.com/typeward/texlive-wasm, which is the authority for the exact
  set of packages a given asset download pulls in. The
  `@typeward/texlive-wasm` wrapper itself is MIT.

## Tools invoked, not bundled

Typeward shells out to TeX and Typst toolchains the user installs themselves
(`latexmk`, `pdflatex`, `typst`, `texlab`, `tinymist`, `synctex`). Those are
separate programs under their own licenses and are not part of this work.

## Completeness

This file is a curated summary, not an exhaustive manifest. A complete
per-dependency attribution bundle — every transitive crate and package with its
own copyright holders and full license text — has not been generated;
`cargo-about` on the Rust side and `license-checker` on the npm side are the
tools that would produce it. Until then `LICENSES/MIT.txt` carries the MIT
template rather than each holder's individual copyright line, and `LICENSES/`
holds texts only for Apache-2.0, MIT, and OFL-1.1 — not for the ISC or
(MPL-2.0 OR Apache-2.0) components also present in shipped binaries.
</content>
