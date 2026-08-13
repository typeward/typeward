# Typeward

A LaTeX and Typst editor that runs on your machine. Write, compile, and preview
scientific documents the way you would in Overleaf — split editor and PDF,
SyncTeX, a reference library, templates — except there is no account to create,
nothing to subscribe to, and no server holding your work. Projects are ordinary
folders on your disk that you can back up, version, and open with any other tool.

Everything Typeward can do is available to everyone. Third-party services
(Zotero, Mendeley, WebDAV storage, git remotes, AI providers) are optional and use
your own credentials.

## What works today

- **LaTeX and Typst projects.** LaTeX compiles through your system TeX
  (`latexmk`, falling back to `pdflatex`) or through the bundled Tectonic
  sidecar, which needs no TeX installation. Typst compiles through the `typst`
  CLI on your PATH.
- **PDF preview with SyncTeX.** Forward search from the cursor, inverse search
  by double-clicking the page. Compile errors and warnings are parsed out of the
  log into the editor gutter, with the raw log a click away. On a recompile your
  reading position is held to the content, not a pixel offset, so the preview
  doesn't jump when the document repaginates.
- **Chapter drafts for big documents.** After a full build, "Draft this chapter"
  recompiles only the chapter you are editing against the last build's
  cross-references (`\includeonly`), so one chapter of a book-length project
  redraws in seconds with its references and page numbers intact.
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
  libgit2, riding your own git setup (gitconfig identity, credential helper).
  Pulls are fast-forward only, and there is no merge-conflict UI yet.
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

## Performance on large documents

Typeward is built to stay responsive on book-length projects, not only short
papers. The `bench/` directory holds a reproducible harness: `generate.mjs`
builds a deterministic 143-chapter LaTeX book, and three drivers measure the
same operations by driving each real application — Typeward, TeXstudio 4.9.6,
and LaTeX Workshop 10.17.1 (on VS Code). The figures below are a representative
run on one Windows 11 machine; the harness is in the repo, so you can reproduce
them on your own.

One caveat first, so the table isn't misread: **compile time is not an editor
metric.** All three shell out to the same TeX engine (latexmk driving pdflatex
and biber), a full build of this book takes tens of seconds in every one of
them, and Typeward does not make TeX itself faster. The one way it shortens the
wait is by typesetting *less* — "Draft this chapter" recompiles a single chapter
against the last full build's cross-references (`\includeonly`), so one chapter
of a large book redraws in seconds. What an editor otherwise controls is
everything *around* the compile: how fast it opens, how it completes references,
how it switches files, and what it does to your place in the PDF when a build
lands. Those are what these measure.

|                                    | Typeward                    | TeXstudio 4.9.6 | LaTeX Workshop 10.17.1 |
| ---------------------------------- | --------------------------- | --------------- | ---------------------- |
| Open to an editable buffer         | ~55 ms                      | ~1.1 s          | ~1.6 s                 |
| First `\cite` / `\ref` completion  | ~0.4 ms (1287 candidates)   | ~25 ms          | ~5–120 ms              |
| Switch to a chapter tab            | ~1 ms                       | ~1 ms           | ~23 ms                 |
| Reading position after a recompile | content-anchored, 0 drift   | not measured    | raw pixel offset       |

- **Opening** hands you a live, editable buffer in tens of milliseconds — the
  file loads immediately while the outline and language-server index build in
  the background — where the rivals block on parsing the whole document first.
  The honest trade-off: Typeward's full cross-file outline (via texlab) is not
  ready the instant the editor is; on a book this size it fills in over the next
  several seconds.
- **Autocomplete** for citations and references answers from an in-process index
  of every label and citekey in the project, built in Rust and queried
  synchronously — so the list appears in well under a millisecond and holds every
  candidate rather than a truncated page. The rivals answer over an asynchronous
  language-server or extension round-trip.
- **Tab switching** keeps several files' editors mounted at once and just shows
  the active one, so returning to an already-open file never rebuilds the
  editor. A normal chapter switches in ~1 ms and even the worst case — a single
  50,000-line `.tex` — in ~9 ms (both were ~9 ms and ~30 ms before the editor
  pool). That ties TeXstudio's native in-memory widgets on a normal file, stays
  far ahead of LaTeX Workshop (~23–40 ms), and trails TeXstudio only on the
  50,000-line file — where ~9 ms is still one frame, imperceptibly instant.
- **Reading position** is the clearest preview win. After a build that
  repaginated the document, Typeward puts you back on the same *content* — it
  records the cursor's line via SyncTeX and scrolls the new PDF there — instead
  of the same pixel offset. LaTeX Workshop keeps the raw scroll offset, which
  slides off the content the moment the page count changes.

One thing the harness does not yet measure cleanly, named so it isn't taken for
a win: per-keystroke latency (single-digit milliseconds in all three on a normal
file). The drivers are `bench/drive-ui-baseline.mjs`,
`bench/drive-texstudio-baseline.mjs`, and `bench/drive-latexworkshop-baseline.mjs`;
the `bench` command block in `CLAUDE.md` explains how to run them.

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
resolves them at request time. The only thing `.env` holds is the OAuth
*client id* for an app you register yourself (`VITE_MENDELEY_CLIENT_ID`); see
`.env.example`. Without it the Mendeley sign-in button fails with a message
telling you where to register, and nothing else is affected. Git needs no
in-app credentials at all — commits use the identity from your gitconfig, and
push/pull/clone authenticate through your git credential helper.

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
