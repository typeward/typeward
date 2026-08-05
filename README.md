# Typeward

A LaTeX and Typst editor that runs on your machine. Write, compile, and preview
scientific documents the way you would in Overleaf — split editor and PDF,
SyncTeX, a reference library, templates — except there is no account to create,
nothing to subscribe to, and no server holding your work. Projects are ordinary
folders on your disk that you can back up, version, and open with any other tool.

Everything Typeward can do is available to everyone. Third-party services
(Zotero, Mendeley, WebDAV storage, GitHub, AI providers) are optional and use
your own credentials.

## What works today

- **LaTeX and Typst projects.** LaTeX compiles through your system TeX
  (`latexmk`, falling back to `pdflatex`) or through the bundled Tectonic
  sidecar, which needs no TeX installation. Typst compiles through the `typst`
  CLI on your PATH.
- **PDF preview with SyncTeX.** Forward search from the cursor, inverse search
  by double-clicking the page. Compile errors and warnings are parsed out of the
  log into the editor gutter, with the raw log a click away.
- **A visual editor for `.tex`.** A hidden-source WYSIWYG mode toggled per file:
  the document on disk stays the verbatim source, and markup is edited through a
  popover rather than rendered inline. Source mode is always one click away.
- **Language servers.** texlab for LaTeX and tinymist for Typst, if they are on
  your PATH — completion, diagnostics, hover, go-to-definition.
- **Grammar checking on device.** Harper runs in-process in Rust; no text leaves
  the machine. Off by default, enabled in Settings.
- **Markdown preview.** Open a `.md` file and the right pane renders it with
  KaTeX math, sandboxed and sanitized. It does not participate in compilation.
- **Version history and recovery.** Saves are snapshotted into a local,
  content-addressed store you can browse and restore per file, and an autosave
  layer recovers unsaved buffers after a crash.
- **Templates.** Built-in LaTeX and Typst starters with variable substitution,
  plus saving any open project back out as your own template.
- **Local git.** Stage, commit, branch, clone, push, and pull over HTTPS via
  libgit2. Pulls are fast-forward only, and there is no merge-conflict UI yet.
- **Overleaf import.** Import a project `.zip`, or clone the premium git bridge
  at `git.overleaf.com` with the same clone dialog.
- **References.** Zotero (local or Web) and Mendeley are aggregated into a single
  `library.bib` inside the project, alongside DOI and arXiv lookups, so `\cite{}`
  completion works through the normal language server.
- **WebDAV sync.** Bidirectional sync against Nextcloud, ownCloud, or any WebDAV
  host, with conflict detection that preserves both sides. This is the only
  cloud backend; it needs no registered app.
- **An optional AI assistant.** Claude, ChatGPT, Gemini, or a local Ollama —
  whichever you configure with your own key or daemon. Off by default; with it
  off, no AI code path runs and no AI request is made.

## Status

Pre-1.0, version 0.0.1. It is usable for real writing but it has not been
through a stable release, and rough edges are expected. Real-time collaboration
is **not** built — Typeward is a single-user editor today. Desktop
(Windows, macOS, Linux) is what builds and ships; tablet layouts and a
WebAssembly TeX engine for iPadOS and Android exist in the tree but there are no
mobile builds yet.

## Build from source

**Prerequisites**

- **Node** `^20.19 || >=22.12` (Vite 8). CI uses 22.
- **Rust.** The toolchain is pinned in `src-tauri/rust-toolchain.toml`; with
  rustup installed, the right version is fetched automatically on first build.
- **Tauri 2 system dependencies** for your platform — see
  <https://v2.tauri.app/start/prerequisites/>. On Windows that is the WebView2
  runtime plus the MSVC build tools; on macOS, Xcode command line tools.
- On **Linux**:

  ```sh
  sudo apt install -y libdbus-1-dev libwebkit2gtk-4.1-dev build-essential \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

**Build and run**

```sh
npm install
npm run fetch:tectonic   # required — see below
npm run tauri dev
```

`npm run fetch:tectonic` downloads the Tectonic binary for your host into
`src-tauri/binaries/`. That directory is gitignored, so this step is needed on
every machine, and not only if you intend to use Tectonic: Tauri's build script
validates the declared sidecar path, so the build fails without it. On Linux the
fetched binary is the musl static build while Tauri looks for the gnu triple —
if the build complains, link them:

```sh
cd src-tauri/binaries
ln -sf tectonic-x86_64-unknown-linux-musl tectonic-x86_64-unknown-linux-gnu
```

To produce installers instead of a dev window:

```sh
npm run tauri build
```

A system TeX distribution (TeX Live, MiKTeX, MacTeX) and the `typst` CLI are
both optional and neither is bundled. Install them if you want to use them;
Tectonic covers LaTeX with no TeX install at all. `synctex`, which ships with
every TeX distribution, is what powers forward and inverse search — without it
compilation still works and sync is quietly unavailable.

## Integrations and credentials

Integrations are off until you configure them, and nothing is configured for
you. API keys, OAuth tokens, and the WebDAV password go into the **OS keyring**
(Credential Manager, Keychain, Secret Service) — never into a file in the repo,
never into `settings.json`, and the frontend has no way to read them back; Rust
resolves them at request time. The only thing `.env` holds is OAuth *client ids*
for apps you register yourself (`VITE_MENDELEY_CLIENT_ID`,
`VITE_GITHUB_CLIENT_ID`); see `.env.example`. Without them those two sign-in
buttons fail with a message telling you where to register, and nothing else is
affected.

## Contributing

Issues and pull requests are welcome. `CLAUDE.md` (mirrored as `AGENTS.md`) is
the architecture guide — read the "Architecture seams" and "Security invariants"
sections before touching compilation, IPC, the outbound HTTP allowlist, or
anything that handles a path from a project.

These must pass before a change lands, and CI runs all of them:

```sh
npm run typecheck
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Two house conventions worth knowing up front: no emoji anywhere in code, files,
or commit messages; and comments explain *why*, not *what* — if a line needs a
comment restating what it does, rewrite the line. Use npm, not pnpm or yarn.

## License

GPL-3.0-or-later. The full text is in `LICENSE`.

Typeward bundles and links third-party components under their own licenses;
`THIRD-PARTY-NOTICES.md` lists them, with full texts in `LICENSES/`. The one
component redistributed in this repository as source is the vendored,
Apache-2.0 `harper-core` under `src-tauri/vendor/harper-core/`, carrying a small
documented modification.
