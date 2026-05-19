# Typeward — Claude Code project notes

Multiplatform editor app similar to Overleaf, format-agnostic: LaTeX, Typst, Markdown, R Markdown. Targets desktop (Win/Mac/Linux) and tablets (iPadOS, Android tablets — no phones). Local-first; cloud sync and real-time collaboration are future phases. (Jupyter `.ipynb` and Quarto are both out of scope for now.)

## Where to look first

- **Plan**: `./plan.md` — full stack rationale, architectural seams, phased build, verification.
- **Designs**: `./design_files/` — HTML/CSS/JS prototypes from claude.ai/design. **Source of truth for visuals.** Don't render in a browser; read the source. JSX files are React reference only — port to idiomatic Solid (signals over hooks, no `React.Children`).
- **UI/UX docs**: `./design/` — living specs for density tokens, motion, themes, widgets, per-screen redesigns. Update these alongside any visible change. `STATUS.md` tracks phase progress.
- **Approved plan archive**: `~/.claude/plans/let-s-plan-stack-for-elegant-newell.md`.

## Architecture seams — read before adding format-specific code

- **`DocumentExperience`** (`src/experiences/`) — `text` | `notebook` | `publishing`. The new-project flow picks one; downstream branches from there. `EditorScreen` routes `project.experience` to either `TextShell` (LaTeX/Typst/Markdown) or `NotebookShell` (R Markdown). `NotebookShell` is a real cell-aware editor: source parsed into `Cell[]` via `src/lib/notebook/parser.ts`, edits flow through `src/stores/notebook-store.ts` and re-serialize back to `editor-store.activeFile.content` (so save/autosave/file-watcher keep working unchanged). Per-cell R execution via `notebook.run_r_chunk` runs against a **persistent R kernel** managed by `KernelManager` in `src-tauri/src/notebook.rs` (one long-lived `R --slave` child per project, serialized through a per-kernel `tokio::Mutex`); variables defined in cell N survive into cell N+1. The notebook banner exposes a "Restart" button → `stop_r_kernel` IPC that drops the kernel; the next run respawns it. `publishing` is still unwired.
- **`EditorAdapter`** (`src/adapters/<format>/`) — per-format glue: CM extensions, compile delegate, preview kind, diagnostics, completions, commands. Four concrete impls today: `LatexAdapter` (`compile_latex` → latexmk/pdflatex or Tectonic), `MarkdownAdapter` (`compile_markdown` → pandoc → PDF, requires a LaTeX engine), `TypstAdapter` (`compile_typst` → native typst CLI), `RmarkdownAdapter` (`compile_rmarkdown` → `Rscript rmarkdown::render`). Each calls IPC directly; the `CompileProvider` interface in `src/providers/types.ts` is still aspirational. The format → adapter mapping lives in two places that must stay in lockstep: `src/commands/actions.ts` `adapterFor()` and `src/screens/editor/EditorScreen.tsx` `adapterForFormat()`.
- **`CommandRegistry`** (`src/commands/`) — wired through end-to-end. `bootCoreCommands()` runs at app startup; adapter commands register on project load (`EditorScreen`) and unregister on cleanup. The shared `<CommandPalette />` rendered at App root reads from `commands()` directly. Global shortcuts (`Mod+K`, `Mod+N`, `Mod+,`, `Mod+S`, format-specific compile) dispatch through `src/commands/keyboard.ts` — CodeMirror no longer hardcodes `Mod-s` / `Mod-Enter`. Save/compile orchestration lives in `src/commands/actions.ts` (single point that maps `project.format` → adapter). Editor-scoped commands gate on focus being inside `.cm-content` or `[data-editor-shell]`.
- **LSP transport** (`src/lib/lsp/client.ts` raw + `wrap()` JSON-RPC wrapper, `src/lib/lsp/cm6.ts` CM6 integration, `src/stores/lsp-store.ts`) — Rust owns child processes (`src-tauri/src/lsp.rs`); frontend talks over Tauri **event channels** (`emit`/`listen`), not `invoke` for streaming traffic. `invoke` is only used for `start_lsp` / `stop_lsp` / `send_lsp_message` lifecycle and outbound writes. **We hand-rolled the CM6 binding** rather than using `codemirror-languageserver` (that package is coupled to `@open-rpc/client-js` WebSocket transport).
- **Unified file watcher** (`src-tauri/src/watcher.rs`, `src/lib/watcher/client.ts`, `src/stores/watcher-store.ts`) — single `notify` service, frontend `fsVersion` signal bumps on each event, FileTree reads it as a resource key. `.typeward/` paths are filtered to avoid autosave feedback loops.
- **Autosave** (`src/lib/autosave/index.ts`, `src-tauri/src/autosave.rs`) — debounced 500ms; snapshots to `<project>/.typeward/snapshots/<rel>.snap`; `RecoveryDialog` shows orphans on project open.
- **Telemetry** (`src/lib/telemetry/index.ts`, `src-tauri/src/telemetry.rs`) — Rust panic hook + frontend `error`/`unhandledrejection` → JSONL log at `<app_data>/telemetry.log`. Capture only; no submission UI.
- **Responsive layout** (`src/stores/viewport-store.ts`, `src/components/layout/PaneSwitcher.tsx`, `src/lib/gestures.ts`) — `viewportMode()` flips at the 1024px breakpoint. Both `TextShell` and `NotebookShell` keep a desktop `DesktopLayout` (corvu Resizable, unchanged) and a tablet variant that swaps in `<Switch>`-based single-pane rendering, the `PaneSwitcher` segmented control, the slide-up `LogsSheet`, and a swipe listener. `setActivePane()` is the public lever for pane navigation; treat `cyclePane()` as gesture-only. Don't add fixed-width assumptions in shells — guard behind `isTabletViewport()` instead.
- **busytex CompileProvider** (`src/providers/compile/busytex-provider.ts`) — frontend Web Worker LaTeX engine via `texlyre-busytex`. Selected when `compileEngine() === "busytex"`. `LatexAdapter.compile()` dynamic-imports the provider so the WASM bridge isn't pulled into the bundle when unused. Assets (~32MB WASM + 90-400MB TeX Live data) live in `public/core/busytex/` and are fetched once with `npx texlyre-busytex download-assets ./public/core`; the provider HEAD-probes the asset before init and returns an actionable diagnostic when missing. PDF bytes are persisted via the project-scoped `write_project_binary_file` IPC into `<project>/.typeward/build/<base>.pdf` so the existing file-path-driven PdfViewer renders it unchanged. Diagnostics route through the shared Rust parser via the `parse_latex_log_cmd` IPC. The provider walks both text dependencies (`.tex`, `.bib`, `.cls`, `.sty`, etc., read via `read_project_text_file`) and binary figures (`.png`, `.jpg`, `.jpeg`, `.pdf`, `.gif`, `.eps`, via `read_project_binary_file`); capped at 200 files / 10 MB combined.

## Gotchas

- **Sync Tauri commands run outside the tokio runtime.** Calling `tokio::spawn` from a sync `#[tauri::command]` panics with "no reactor running" and aborts the process (Windows reports `STATUS_STACK_BUFFER_OVERRUN` / `0xc0000409`). Mark any command that touches tokio (`spawn`, `mpsc`, `tokio::process`, etc.) as `pub async fn`. Reference: `watcher.rs::watch_project`.
- **Tauri 2 fs plugin requires explicit scope.** `fs:default` + bare `fs:allow-*` permissions don't grant access to arbitrary paths — they need an `allow` list. Project files live under `~/Documents/Typeward` by default; `capabilities/default.json` scopes the fs perms to `$HOME/**` + `$DOCUMENT/**` + `$DESKTOP/**`. **`fs:allow-read-file` (binary) is separate from `fs:allow-read-text-file`** — PDF reads need the binary one.
- **PDF.js `RenderingCancelledException`** is benign — fired whenever a render is superseded by a newer one (e.g., on quick recompile). `PdfViewer` uses a generation counter and silently swallows it. Don't surface it as an error.
- **Custom Tauri commands bypass fs plugin scope** — project file IO must use `read_project_text_file` / `write_project_text_file` / `write_project_binary_file`, which validate project-relative paths against the canonical root. Compile commands also validate `project.rootFile`. Don't reintroduce raw absolute-path file IPC.
- **CodeMirror remount on tab switch** — `text-shell.tsx` keys CodeMirror on `activeFile().path` so the LSP gets a fresh `didOpen` per file. Don't try to swap content in place via dispatch; that breaks LSP doc tracking.
- **`@fontsource/inter`** ships static woff/woff2 per weight. We import 4 Inter + 3 JetBrains Mono weights. They block initial paint in dev — biggest contributor to "white flash" before `backgroundColor: "#0A0B0F"` in `tauri.conf.json` made the window paint dark on creation. A previous `visible: false` + `getCurrentWindow().show()` deferred-reveal pattern was removed: it masked render-time crashes (window stayed hidden if `onMount` never fired), and the dark background alone is sufficient.
- **Compile fallback chain**: `system-tex` engine tries `latexmk` first, falls back to `pdflatex` on spawn/exit failure (MiKTeX sometimes ships latexmk without a usable Perl). `tectonic` engine tries the sidecar (`binaries/tectonic-<triple>`) first, falls back to `tectonic` on PATH. Either way, the actual command + log get surfaced in the LogsDrawer's Logs tab.
- **Markdown compile needs a LaTeX engine.** `compile_markdown` invokes `pandoc <file> -o <base>.pdf`. Pandoc delegates PDF generation to pdflatex/xelatex/lualatex; if none are on PATH, pandoc exits non-zero and the user gets an actionable note appended to the log. There's no HTML preview path yet — adding one means a new `PreviewProvider` next to the PDF one.
- **Typst syntax highlighter is hand-rolled.** `src/adapters/typst/typst-language.ts` is a minimal CM6 `StreamLanguage` covering the visual basics (comments, strings, math, `#funcs`, headings, emphasis). It's intentionally not a full grammar — when tinymist's structured tokens become consumable through the LSP transport, prefer those over expanding this parser.
- **SyncTeX shells out to the system `synctex` CLI** (`src-tauri/src/synctex.rs`), not a Rust binding. TeX Live / MiKTeX / MacTeX all ship it; the CLI returns `Ok(None)` if not on PATH so Tectonic-only users get a graceful "no sync" rather than an error. Compile flags: `-synctex=1` for latexmk/pdflatex, `--synctex` for tectonic. Forward search wires through `requestPdfScroll(page, y)` → PdfViewer's `scrollTarget` effect. Inverse search uses **shift+click** on PDF page → `onPageClick(page, x, y)` (coords divided by current zoom to get PDF pts) → `requestGotoSource(relPath, line)` → EditorScreen opens the file and moves the cursor via the imperative `editor-view-store` handle.

## Stack (anchors)

- Tauri 2 + Rust backend / Solid + TS frontend / Vite
- Tailwind v4 (CSS-config via `@tailwindcss/vite`) + CSS custom properties for theme tokens
- Kobalte for a11y primitives (Dialog, Popover, DropdownMenu, Tooltip, Tabs, Switch, Combobox, Toast) — **not** shadcn/solid-ui (their aesthetic conflicts with the glass design)
- lucide-solid for icons, corvu for resizable panes, @solidjs/router
- CodeMirror 6 (lang-stex for LaTeX, lang-markdown), PDF.js for preview
- Hand-rolled LSP integration (no `codemirror-languageserver`)
- TeX engines: system (TeX Live/MacTeX/MiKTeX) **or** bundled Tectonic on desktop (download via `npm run fetch:tectonic`); texlyre-busytex on tablet (Phase 3)
- Future cloud: Supabase (auth/storage/realtime) + Yjs CRDT for collab

## Conventions

- **Use npm**, not pnpm or yarn (user preference).
- **No emojis** in code, files, or commit messages unless explicitly asked.
- **No new docs/README files** unless requested.
- **No comments explaining what code does** — only *why*, when non-obvious. Don't reference tasks/PRs/callers in comments.
- **Designs are visual truth** — port HTML output, not the prototype's React structure.
- **Themes** swap via `<html data-theme="...">` and `<html data-accent="...">`. Default values live in `src/themes/tokens.css` (Aurora). See `src/themes/theme-store.ts`.

## Commands

```
# Dev
npm run dev                  # Vite only (frontend)
npm run tauri dev            # Full app (Vite + Rust + window)

# Build
npm run build                # tsc + vite build → dist/
npm run tauri build          # Native bundle

# Test
npm test                     # Vitest (frontend, jsdom)
npm run test:watch
cargo test --manifest-path src-tauri/Cargo.toml

# Sidecar binary
npm run fetch:tectonic       # Downloads Tectonic 0.15.0 for the host platform
                             # to src-tauri/binaries/tectonic-<triple>[.exe].
                             # tauri.conf.json already declares
                             # `externalBin: ["binaries/tectonic"]`, so once
                             # fetched it ships with `tauri build` and the
                             # sidecar resolves in `tauri dev`. Required per
                             # dev host because the binary is gitignored.

# busytex (WASM TeX Live 2026) — one-time asset fetch
npx texlyre-busytex download-assets ./public/core
                             # Downloads ~32MB WASM + 90-400MB data into
                             # public/core/busytex/, served at /core/busytex
                             # via Vite. Only needed if the user picks the
                             # `busytex` engine in settings.

# Icons (regenerate from source)
npx tauri icon ./typeward-icon.png
```

## Folder layout

```
src/
  screens/      onboarding | projects | editor (shells/text-shell.tsx + notebook-shell.tsx) | settings
  experiences/  DocumentExperience definitions (types only)
  adapters/     EditorAdapter impls — latex, markdown, typst, rmarkdown + shared adapter-contract test
  providers/    Compile/Preview/Lsp interfaces (aspirational — adapters call IPC directly today)
  components/
    editor/     CodeMirror, FileTree, LogsDrawer, RecoveryDialog, EditorSidebar, CellEditor
    notebook/   Cell, CellOutput
    pdf/        PdfViewer (page nav, zoom dropdown, retained scroll, Recompile, SyncTeX pulse + shift-click)
    glass/      Glass card variants
    forms/      Switch, Slider
    primitives/ Button, Dialog (Kobalte wrappers)
    layout/     AmbientBackdrop, TopBar
    CommandPalette.tsx — rendered once at App root
  themes/       tokens.css + themes/{obsidian,graphite,paper}.css + accents.css + utilities.css + theme-store.ts
  commands/     registry, palette-store, boot (core commands), keyboard (global router), actions (save/compile/sync orchestration)
  stores/       editor-store, editor-view-store (imperative CM handle), projects-store, settings-store,
                lsp-store, watcher-store, notebook-store, notebook-outputs-store
  lib/
    lsp/        client.ts (transport + JsonRpcClient), cm6.ts (CodeMirror binding)
    watcher/    client.ts (Tauri event subscription)
    autosave/   debounced snapshot writer
    notebook/   parser.ts (RMD ↔ Cell[] round-trip)
    telemetry/  frontend error hook + recordError()
    shortcuts.ts — Mod+X token parser shared by keyboard router + palette
  ipc/          typed Tauri command wrappers (one big index.ts)
src-tauri/
  src/          commands.rs, detect.rs, fs_ops.rs, project.rs, settings.rs,
                autosave.rs, telemetry.rs, lsp.rs, watcher.rs, synctex.rs, notebook.rs, lib.rs, main.rs
  binaries/     sidecar binaries (gitignored; Tectonic via fetch script)
  capabilities/default.json — fs/dialog/shell/os scopes + tectonic sidecar shell:allow-execute
scripts/        fetch-tectonic.mjs
design_files/   HTML/JSX prototypes (read-only reference)
```

## Status

- **Phase 0** — skeleton (Tauri+Solid+TS, Tailwind v4, Kobalte/corvu/router/lucide, themes, baseline tests).
- **Phase 1** — vertical slice complete on desktop: four screens fully ported with visual passes; multi-tab editor; LSP transport + hand-rolled CM6 integration (texlab/tinymist/marksman when on PATH); real LaTeX compile via system TeX with `latexmk → pdflatex` fallback or Tectonic; PDF.js preview with toolbar (Recompile, page nav, zoom dropdown); LogsDrawer with Logs + Issues tabs; autosave + crash recovery; telemetry capture; first-run onboarding redirect; unified file watcher driving FileTree refresh. Tectonic sidecar bundled via `externalBin: ["binaries/tectonic"]` (enabled 2026-05-15); binary fetched per-dev-host with `npm run fetch:tectonic`.
- **Phase 2 — complete** (2026-05-12). CommandRegistry binding (boot core commands + adapter register/unregister on project load, global keyboard router with scope/when gates, shared `<CommandPalette />` at App root), Markdown/Typst/RMD adapters routed in lockstep between `actions.adapterFor()` and `EditorScreen.adapterForFormat()`, SyncTeX forward (Mod+J → PDF pulse-ribbon) + inverse (shift+click on PDF → editor cursor), notebook shell (cell parser, notebook-store with feedback-loop guard, Cell/CellEditor/CellOutput UI, persistent R kernel via `KernelManager` so variables carry across cells, Mod+Shift+Enter `notebook.runAll`). Smart per-page PDF diff and sync-to-cursor toggle were intentionally skipped per user direction. Quarto was scoped in then removed (2026-05-12). Persistent R kernel added 2026-05-15 (replaces stateless `Rscript` model); 56 frontend tests + 19 Rust tests pass. **Deferred follow-ups**: plot/image capture, Python/Julia per-cell execution.
- **Phase 3 — complete (2026-05-13)**. Tablet target scaffolding all landed; only user-driven steps (emulator/device build, iPadOS target) remain.
  - **Responsive layout**. `src/stores/viewport-store.ts` derives `viewportMode` (desktop ≥1024 / tablet <1024) + `activePane` (sidebar/editor/preview) + `logsSheetOpen`. `TextShell` and `NotebookShell` branch on `isTabletViewport()`: desktop keeps the corvu 3-pane Resizable; tablet collapses to a single `<Switch>`-rendered pane plus `<PaneSwitcher />` (bottom segmented control, 44px+ tap targets) and a slide-up `LogsSheet` overlay. `src/lib/gestures.ts` `installSwipeListener` cycles panes on touch/pen horizontal swipe (>70px, ratio-gated so vertical scrolls don't trigger). Bumped tab strip + close-button hit areas in `CenterPane` when in tablet mode. File-select on tablet auto-swaps the active pane back to "editor".
  - **busytex WASM CompileProvider**. `src/providers/compile/busytex-provider.ts` wraps `texlyre-busytex` 1.1.1: lazy `BusyTexRunner` + `PdfLatex` singletons (`runner.initialize(true)` uses the package's built-in Web Worker), walks the project tree for `.tex`/`.bib`/`.cls`/`.sty`/`.bst`/`.def`/`.ldf`/`.fd`/`.cnf`/`.clo`/`.aux` as UTF-8 and `.png`/`.jpg`/`.jpeg`/`.pdf`/`.gif`/`.eps` as `Uint8Array` via the new `read_project_binary_file` IPC (capped 200 files / 10 MB combined) and passes them as `additionalFiles`, auto-enables BibTeX when any `.bib` is found, writes the PDF via the project-scoped `write_project_binary_file` Tauri command, sniffs SyncTeX magic bytes and writes either `.synctex.gz` or `.synctex` next to the PDF so the existing `synctex` CLI resolves forward/inverse against busytex output, and reuses the Rust `parse_latex_log` extractor via the new `parse_latex_log_cmd` IPC so diagnostics match the desktop shape. `CompileEngine` is `"system-tex" | "tectonic" | "busytex"`; `LatexAdapter.compile()` dispatches via dynamic import so the ~32MB bridge stays out of desktop bundles when unused. Settings → Editor → Compilation now lets users pick the engine and HEAD-probes `/core/busytex/busytex_pipeline.js` to show an install-status badge with the exact `npx texlyre-busytex download-assets ./public/core` command when missing.
  - **Android build pipeline**. `tauri android init` ran cleanly with `JAVA_HOME` pointing at Android Studio's bundled JBR 21 (Java not on PATH on the dev host — prefix `$JAVA_HOME\bin` before Android commands). Generated `src-tauri/gen/android/` with Gradle wrapper, app module, and gitignores for build artifacts. All four Android Rust targets (`aarch64`, `armv7`, `i686`, `x86_64`-linux-android) installed. `Cargo.toml` already had `crate-type = ["staticlib", "cdylib", "rlib"]`. Actually building an APK on an emulator/device is deferred — needs the user to drive emulator setup.
- **Phase 4 — deferred (2026-05-13)**. Supabase / accounts / collab / licensing paused indefinitely. When it resumes, scope narrows to **auth + collab + license keys only** — files stay local-first, nothing mirrored to Supabase Storage. The plan.md "folder sync" framing is retired.
