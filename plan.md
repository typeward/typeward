# Typeward — Stack & Build Plan

> Source of truth for the build plan. The original plan-mode artifact lives at
> `~/.claude/plans/let-s-plan-stack-for-elegant-newell.md`; this file is the
> repo-tracked copy and is updated as phases land.

## Status

| Phase | State | Summary |
|---|---|---|
| 0 — Skeleton | **complete** (2026-05-10) | Tauri 2 + Solid + TS scaffolded. Tailwind v4, Kobalte, lucide-solid, corvu, @solidjs/router installed. Theme tokens (Aurora/Obsidian/Graphite/Paper) + accent palettes (Violet-Cyan/Amber-Rose/Emerald-Teal/Indigo-Pink) wired with localStorage persistence. Vitest (jsdom) and `cargo test` baseline tests passing. Icons generated for all platforms. |
| 1 — Vertical slice on desktop | **complete** (2026-05-10) | All four screens (Onboarding/Projects/Editor/Settings) ported and functional. CodeMirror 6 + PDF.js wired into a 3-pane corvu Resizable shell. Real LaTeX compile via system TeX (latexmk/pdflatex) or Tectonic. Architecture seams defined (DocumentExperience, EditorAdapter, CompileProvider, PreviewProvider, LspProvider, CommandRegistry). LSP transport (texlab spawn + JSON-RPC framing over Tauri event channels), unified file watcher (notify-based), autosave + recovery dialog, and telemetry capture (panic hook + frontend error hook + JSONL log) all in. |
| 2 — Multi-format & preview polish | substantively complete | CommandRegistry bound, Markdown/Typst/RMD adapters, SyncTeX, notebook shell with cell-aware editor + persistent R kernel all landed (2026-05-11..15). Two items intentionally skipped per user direction: smart per-page PDF diff and sync-to-cursor toggle. Quarto support was scoped in then dropped 2026-05-12 — RMD-only for notebooks now. Deferred follow-ups: plot/image capture, Python/Julia per-cell execution. |
| 3 — Tablet | substantively complete (2026-05-13) | Responsive layout (viewport-store + PaneSwitcher + LogsSheet + swipe gestures), texlyre-busytex CompileProvider (multi-file walker, SyncTeX persistence, settings UI with install-status probe), Android target scaffolded via `tauri android init`. APK build-and-run on emulator/device is the only remaining piece — user-driven. |
| 4 — Cloud + collab | **deferred (2026-05-13)** | Supabase / accounts / realtime collab paused indefinitely. When it comes back, scope is **auth + collab + license keys only** — files stay local-first; nothing is mirrored to Supabase storage. The original "folder sync as files + metadata" framing has been retired. |

---

## Context

Multiplatform editor app ("Typeward") similar to Overleaf, but format-agnostic: LaTeX, Typst, Markdown, R Markdown. (Jupyter / `.ipynb` and Quarto were originally in scope but both have been dropped — focus is on text + RMD notebooks.) Targets desktop (Win/Mac/Linux) and tablets (iPadOS, Android tablets — no phones). Designs already exist in `design_files/` (HTML/CSS/JS prototypes from claude.ai/design): glassmorphism aesthetic, custom Tailwind utilities + CSS custom properties, four built-in themes (Aurora/Obsidian/Graphite/Paper) and four accent palettes. Ships local-first; cloud sync, accounts, and real-time collaboration are future phases. Approach: skeleton → pixel-perfect UI/UX with real desktop compile (vertical slice) → multi-format → tablet → cloud/collab.

---

## Final stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Tauri 2** | Desktop + tablet builds. Rust backend hosts sidecar processes (TeX, LSP servers). |
| Frontend | **SolidJS + TypeScript** | Designs only use `useState`/`useEffect`/`useRef` — translate cleanly to `createSignal`/`createEffect`/refs. |
| Bundler | **Vite** | Tauri default, fast HMR. |
| Styling | **Tailwind v4 + CSS custom properties** | Designs already use exactly this. Theme = swap a `:root` token bundle. |
| Headless primitives | **Kobalte** | Solid's Radix equivalent. Use **only** for `Dialog`, `Popover`, `DropdownMenu`, `Tooltip`, `Tabs`, `Switch`, `Combobox`, `Toast`. Everything else = plain Tailwind components. |
| Icons | **lucide-solid** | Designs use inline SVG; lucide is a 1:1 fit for the icon vocabulary used. |
| Routing | **@solidjs/router** | Onboarding / Projects / Editor / Settings are distinct top-level screens — small router beats a hand-rolled switch. |
| State | **Solid stores + signals** | No external state lib. |
| Editor | **CodeMirror 6** + `@codemirror/lang-*` (latex, markdown, etc.); custom Typst lang | Map prototype's token CSS classes to CM6 syntax classes. |
| LSP integration | **codemirror-languageserver** over Tauri **event channels** (not `invoke`) | LSP servers (texlab, tinymist, marksman, typst-lsp) run as Tauri sidecars; Rust owns child-process lifecycle, frontend owns editor protocol state. Bidirectional event streams keep autocomplete/diagnostics latency low — request/response `invoke` jitters under load. |
| PDF preview | **pdfjs-dist** (PDF.js) | Offline, hot-reload on compile output. |
| Resizable panes | **corvu** (`corvu/resizable`) | Mature Solid primitive; the prototype's `useDrag` works but corvu handles a11y + edge cases for free. |
| TeX engine — desktop (primary) | **System install** (TeX Live / MiKTeX / MacTeX) | Detect at onboarding; invoke `latexmk`/`pdflatex` directly via Rust. |
| TeX engine — desktop (quick-start) | **Tectonic** (bundled Rust binary) | Onboarding offers this as a zero-friction alternative — full TeX install can come later. Avoids losing users at the install gate. |
| TeX engine — tablet | **texlyre-busytex** (WASM) | Phase 3. |
| Other compilers | **Typst CLI**, **pandoc**, **Rscript** as detected binaries | Detected on PATH per-platform; not bundled. |
| Testing | **Vitest** + **@solidjs/testing-library** + **Playwright** + **cargo test** | E2E uses Tauri's WebDriver bridge. |
| Cloud (future, phase 4) | **Supabase** (auth, Postgres, storage, realtime) | Folder-level sync; per-file content syncs as text. |
| Real-time collab (future) | **Yjs** + **y-codemirror.next** | Transport over Supabase realtime channels. |

### Why not these (briefly)

- **shadcn / solid-ui** — shadcn is React-only; solid-ui inherits the shadcn aesthetic, which conflicts with Typeward's glassmorphism. You'd override ~80% of every component. solid-ui uses Kobalte under the hood anyway — go direct.
- **react-resizable-panels analog or hand-rolled drag** — corvu is small, accessible, Solid-native. Less code than maintaining the prototype's `useDrag`.

---

## Core architectural patterns

These are the seams that prevent the app from collapsing into format-specific spaghetti by Phase 2. **Define them in Phase 1**, even when only LaTeX is implemented — retrofitting later is brutal.

### 1. `DocumentExperience` (top-level)

A document **experience** owns the entire editor shell for a class of documents. Not just syntax — layout, panels, persistence semantics, toolbar, compile/preview/run model.

```ts
type DocumentExperience =
  | "text"        // LaTeX, Typst, Markdown — single body, compile to artifact
  | "notebook"    // RMarkdown chunks — cell execution, inline outputs
  | "publishing"  // future: book/multi-doc, slides
```

The new-project flow picks an experience; everything downstream branches from there. Notebook is a **distinct shell**, not a bolt-on to the text editor.

### 2. `EditorAdapter` (per format, within an experience)

```ts
interface EditorAdapter {
  languageId: string;                                  // "latex" | "typst" | "markdown" | ...
  experience: DocumentExperience;
  cmExtensions(ctx: EditorCtx): Extension[];           // CodeMirror 6 extensions
  compile(project: Project): Promise<CompileResult>;   // delegates to a CompileProvider
  previewKind: "pdf" | "html" | "notebook";
  diagnostics$: Stream<Diagnostic[]>;                  // from LSP or compile
  completions(ctx, pos): Promise<Completion[]>;        // from LSP
  commands: EditorCommand[];                           // toolbar/palette commands
}
```

Concrete today: `LatexAdapter`, `TypstAdapter`, `MarkdownAdapter`, `RmarkdownAdapter`. Common plumbing (compile/diagnostics/completion wiring) lives in a base class; adapters only declare their specifics.

### 3. Provider seams (extension boundaries)

Even with no plugin system today, define interfaces so format logic isn't hardcoded:

- `CompileProvider` — system-tex / tectonic / typst-cli / pandoc / Rscript / busytex (mobile)
- `PreviewProvider` — pdf.js / html / notebook
- `LspProvider` — texlab / tinymist / marksman / typst-lsp
- `CommandRegistry` — toolbar actions, command palette, keybindings register here, not directly in components

Plugins later become "things that register adapters and providers." Without these seams, every format leaks into every component.

### 4. LSP transport

Rust owns LSP child processes; Solid frontend talks over **Tauri event channels** (`emit`/`listen`), not `invoke`. The frontend LSP client wraps this in a JSON-RPC stream interface that `codemirror-languageserver` consumes. Live traffic stays event-driven; only one-shot lifecycle ops (start/stop server) use `invoke`.

### 5. Unified file-watcher service

A single Rust service (built on `notify` crate) emits typed events for:

- compile output changes → trigger preview reload
- external file edits (user edits in another tool) → reconcile with editor buffer
- generated files (notebook outputs, .aux/.log) → update file tree, hide/group as appropriate
- Git branch switches → invalidate caches, prompt to reload open buffers

All consumers (preview, file tree, editor buffers, build system) subscribe to one stream. **No ad-hoc `fs::watch` calls scattered around.**

### 6. Autosave & crash recovery

Sidecars (TeX, LSPs) raise the crash surface significantly. From Phase 1:

- Debounced autosave (~500ms idle) writes to `.typeward/snapshots/<file>.snap`
- On launch, scan for unrecovered snapshots → prompt the user to restore
- Project-level transaction log (file open/close, dirty state) for "what was I doing?" recovery

### 7. Telemetry & error reporting (opt-in)

Not analytics. Structured reports for:

- crashes (Sentry-compatible format) — frontend + Rust panic capture
- compile failures (engine, exit code, stderr tail, `.log` summary)
- LSP startup failures (which server, exit code, stderr)

Stored locally first; user can submit. Without this, debugging in the wild is painful.

---

## Folder structure

```
src/                          # Solid frontend
  app.tsx                     # Router root
  screens/
    onboarding/               # Welcome, formats, detect engines, install (incl. Tectonic quick-start)
    projects/                 # Project list + new project (picks DocumentExperience)
    editor/                   # Hosts a DocumentExperience shell
      shells/
        text-shell.tsx        # 3-pane text editor (LaTeX/Typst/Markdown)
        notebook-shell.tsx    # Cell-based shell (RMD cells)
        publishing-shell.tsx  # Phase 4+
    settings/                 # Themes, editor opts, integrations, billing
  experiences/                # DocumentExperience definitions
  adapters/                   # EditorAdapter implementations
    latex/                    # LatexAdapter, latex CM extensions, snippets
    typst/
    markdown/
    rmarkdown/
  providers/                  # Pluggable seams
    compile/                  # CompileProvider impls: system-tex, tectonic, typst, pandoc, Rscript, busytex
    preview/                  # PreviewProvider impls: pdf, html, notebook
    lsp/                      # LspProvider impls
  components/
    primitives/               # Thin Tailwind wrappers around Kobalte
    glass/                    # Glass card variants
    forms/                    # Toggle, Slider, ColorPicker, Combobox
    editor/                   # CodeMirror integration, gutters, status bar
    pdf/                      # PDF.js viewer with retained scroll/zoom + SyncTeX (Phase 2)
    layout/                   # ResizablePanes, Tabs, Sidebar
  themes/
    tokens.css                # Default tokens (Aurora)
    obsidian.css, graphite.css, paper.css
    accents.ts                # 4 accent palettes
    theme-store.ts
  commands/                   # CommandRegistry — toolbar actions, palette, keybindings
  stores/                     # Solid stores (project, editor, settings, autosave)
  lib/
    fs/                       # Tauri file I/O wrappers
    watcher/                  # Frontend client for unified file-watcher events
    autosave/                 # Snapshot writer + recovery probe
    telemetry/                # Crash/error report builder
  ipc/                        # Typed Tauri command + event-channel wrappers
src-tauri/
  src/
    fs.rs                     # Project folder ops
    watcher.rs                # Unified file watcher (notify crate) — emits typed events
    compile/
      mod.rs                  # CompileProvider trait
      system_tex.rs           # latexmk/pdflatex
      tectonic.rs             # bundled Tectonic
      typst.rs
      pandoc.rs
      rmarkdown.rs
      busytex.rs              # Phase 3 (mobile target only)
    lsp/
      mod.rs                  # Sidecar lifecycle + event-channel transport
      texlab.rs
      tinymist.rs
      marksman.rs
    detect.rs                 # System TeX/engine detection
    autosave.rs               # Snapshot store
    telemetry.rs              # Panic hook + structured error capture
    main.rs
  binaries/                   # Sidecar binaries (Tectonic, optionally LSPs/typst/pandoc)
  tauri.conf.json
  Cargo.toml
fixtures/                     # Compile fixture projects for regression tests
  latex-basic/
  latex-bib/
  typst-basic/
  markdown-pandoc/
  notebook-basic/
design_files/                 # Untouched reference (HTML/JSX prototypes)
```

### Project on-disk format

A project = a plain folder. Optional `.typeward/` sidecar holds:

- `project.json` — root file, format, last-opened tab order
- `build/` — compile artifacts (gitignored)
- `cache/` — LSP/compile caches

Plays well with Git; future Supabase sync mirrors the folder.

---

## Build phases

### Phase 0 — Skeleton (complete, 2026-05-10)

What landed:

- Tauri 2 + Solid + TS scaffolded directly into the repo (no `create-tauri-app` because of pre-existing `design_files/` and `.git/`)
- npm package install + `cargo check` clean (Tauri 2.11, Solid 1.9, Vite 6, TypeScript 5.7)
- Tailwind v4 wired through `@tailwindcss/vite` (CSS-config, no `tailwind.config.js`)
- Kobalte, lucide-solid, corvu, @solidjs/router installed
- Theme system: `:root` tokens via `@theme` (Aurora default) + `[data-theme]` overrides for Obsidian/Graphite/Paper + `[data-accent]` for the four palettes
- `theme-store.ts` — Solid signals → `<html>` attrs → localStorage
- Vitest with jsdom, dev-conditions gated on `VITEST` env var (avoids polluting production builds with Solid's dev runtime). 4 passing tests cover theme/accent state + DOM application + persistence.
- `cargo test` baseline (1 smoke test) wired in `src-tauri/src/lib.rs`
- Icons generated for desktop + iOS + Android via `npx tauri icon`
- Temporary `DevShell` in `src/App.tsx` with route nav + theme/accent dropdowns — to be removed when porting real designs

### Phase 1 — Vertical slice on desktop — complete (2026-05-10)

What landed:

- **Glass + accent utilities** (`src/themes/utilities.css`): theme-aware `.glass` / `.glass-soft` / `.glass-inset`, accent gradients tied to `--color-accent-1/2`, `.lift`, `.label-xs`, `.mono`, plus `pulse` / `blink` / `shimmer` keyframes. Shadow tokens override per theme (Paper gets soft drops).
- **Architecture seams** (interfaces only, types tested): `DocumentExperience` (`src/experiences/`), `EditorAdapter` + `Project` + `Diagnostic` + `CompileResult` + `EditorCommand` (`src/adapters/types.ts`), `CompileProvider` / `PreviewProvider` / `LspProvider` (`src/providers/types.ts`), reactive `CommandRegistry` (`src/commands/registry.ts`).
- **Onboarding** (3 steps): welcome, engine probe (auto-runs `which` for pdflatex/xelatex/lualatex/latexmk/tectonic/typst/pandoc), choose system TeX vs bundled Tectonic. Persists choice to settings.
- **Projects** screen: list + search + new-project dialog (all six formats), backed by `~/Documents/Typeward/<folder>/.typeward/project.json`.
- **Settings** screen: Theme + Editor sections fully wired; placeholder cards for Account/Notifications/Security/Billing/Integrations until cloud lands.
- **Editor** screen: corvu Resizable 3-pane shell, CodeMirror 6 with `lang-stex` (LaTeX) and `lang-markdown`, theme-aware editor styling, FileTree from disk via Tauri fs plugin, PDF.js viewer with retained scroll position + zoom across recompiles, status bar (line count / language / encoding / compile time), Problems pane.
- **LatexAdapter** (`src/adapters/latex/LatexAdapter.ts`) — first concrete `EditorAdapter`. Delegates to `compileLatex` IPC.
- **CompileProvider impls** in Rust (`src-tauri/src/commands.rs`): system TeX path runs `latexmk -pdf` (falling back to `pdflatex`); Tectonic path runs `tectonic -X compile`. Minimal `.log` parser produces error/warning diagnostics.
- **LSP transport** (`src-tauri/src/lsp.rs` + `src/lib/lsp/client.ts`): Rust spawns texlab/tinymist/marksman as a child process, parses Content-Length-framed JSON-RPC, emits inbound payloads as Tauri events. Outbound traffic via `send_lsp_message` invoke. Lifecycle ops (`start_lsp` / `stop_lsp`) via invoke. **codemirror-languageserver binding into LatexAdapter is iteration work; the channel is functional today.**
- **Unified file watcher** (`src-tauri/src/watcher.rs` + `src/lib/watcher/client.ts`): `notify`-based, one watcher per project, typed events emitted on a single channel.
- **Autosave + crash recovery**: debounced 500ms snapshots to `<project>/.typeward/snapshots/<rel>.snap`. On project open, the editor scans for orphans (snapshots newer than file mtime) and prompts via `RecoveryDialog`.
- **Telemetry**: Rust panic hook + frontend `window.error` / `unhandledrejection` hook → structured JSONL log at `<app_data>/telemetry.log`. Compile failures forwarded automatically. No submission UI yet.

Iteration items intentionally deferred:
- **codemirror-languageserver wiring** into the editor — LSP transport + frontend client are functional but not yet bound to CM6's autocomplete/diagnostics.
- **Bundled Tectonic binary** — compile path invokes the `tectonic` CLI from PATH; the actual sidecar binary download/bundling lands separately.
- **Multi-tab editor** — only one file open at a time for now.
- **Pixel-perfect parity** with `design_files/Editor.html` — the layout and components match design intent but were not pixel-matched line-by-line; iterate visually after the user reviews.

Original breakdown follows for reference:

1. **Theme + glass primitives** — port `.glass`, `.glass-soft`, `.glass-inset`, `.lift`, `.accent-grad` to Tailwind plugin or component layer (see `design_files/Editor.html` line 304+ for canonical styles)
2. **Architectural seams** (build the interfaces even if only one implementation exists):
   - `DocumentExperience` enum + `text-shell.tsx` route
   - `EditorAdapter` interface + `LatexAdapter` concrete impl
   - `CompileProvider` trait + `system_tex.rs` and `tectonic.rs` impls
   - `PreviewProvider` trait + `pdf.rs` impl
   - `LspProvider` trait + `texlab.rs` impl
   - `CommandRegistry` — at least the LaTeX commands (compile, format, jump-to-error) registered through it
   - LSP transport over event channels (not `invoke`)
   - Unified `watcher.rs` service with one frontend client
3. **Onboarding** — port `design_files/Onboarding.html`; engine step offers two paths: "Use installed TeX" (runs `detect.rs`) or "Use Typeward's quick-start engine" (Tectonic, no install needed)
4. **Projects screen** — port `design_files/Projects.html`; backed by a Tauri command listing `~/Documents/Typeward/`. New-project flow picks a `DocumentExperience` and writes it into `project.json`
5. **Settings screen** — port `design_files/Settings.html`; themes + accent palettes wire to store; editor options persist to `settings.json`
6. **Editor screen** (`text-shell` + `LatexAdapter`) — port `design_files/Editor.html`:
   - Resizable 3-pane layout via corvu
   - CodeMirror 6 with `@codemirror/lang-tex` (extensions provided by `LatexAdapter.cmExtensions()`)
   - texlab spawned as sidecar; LSP wired via codemirror-languageserver over event channels
   - "Compile" → goes through `CompileProvider` (system-tex or Tectonic per project setting)
   - PDF.js renders compiled output via `PreviewProvider`, **retains scroll position + zoom across recompile** (don't naively rebuild the viewer)
   - File tree from disk via `watcher.rs`; tabs from open files; status bar live (line/col/encoding)
7. **Autosave + crash recovery** — debounced snapshots to `.typeward/snapshots/`; on launch, recovery prompt for any unflushed snapshots
8. **Telemetry scaffolding** — Rust panic hook → `telemetry.rs`; structured compile/LSP failure capture; local-only for now, no submission UI yet

### Phase 2 — Multi-format & preview polish

> **Note:** Quarto support was scoped and built (2026-05-11) then removed (2026-05-12). References to QuartoAdapter, compile_quarto, parse_quarto_log, and .qmd routing have been stripped from the codebase. The historical entries below preserve "what landed" for context — some of what they describe (Quarto adapter, `.qmd` parsing) is no longer in the tree.

**Landed (2026-05-12) — Cell-aware notebook editor + R execution** (kernel made persistent 2026-05-15)

- Cell parser/serializer (`src/lib/notebook/parser.ts`): RMD source ↔ `Cell[]` (metadata | markdown | code). Round-trip is idempotent after the first parse-serialize; preserves chunk options (`{r, echo=FALSE}`) verbatim. 11 parser tests.
- Notebook cells store (`src/stores/notebook-store.ts`): derives a reactive `Cell[]` from `activeFile.content` when the active file is `.Rmd`. Cell edits re-serialize back through `updateActiveFile` so save + autosave + file-watcher reconciliation all keep working. Guards against the parse/serialize feedback loop via a `lastSyncedContent` token.
- Cell UI: `Cell.tsx` (per-cell card with type badge, language picker for code cells, move/delete/run controls), `CellEditor.tsx` (slim CodeMirror surface — no line numbers, no global view-store push, language registry covers markdown / yaml / r / python / julia / sql / shell), `CellOutput.tsx` (stdout + stderr + exit/duration footer).
- `notebook-shell.tsx` rewritten as a real cell-aware layout: shared `EditorSidebar` (extracted to its own file so both shells reuse it), cells column, PdfViewer, LogsDrawer. Falls back to a clear "open the main notebook" placeholder when the active tab isn't `.Rmd`.
- Per-cell execution (`src-tauri/src/notebook.rs` `run_r_chunk`): originally spawned a fresh `Rscript` per call. **Upgraded 2026-05-15 to a persistent R kernel** — `KernelManager` (Tauri-managed state) holds one long-lived `R --slave --no-save --no-restore --no-echo --no-readline` child process per project, gated through a `tokio::Mutex<KernelHandle>`. Chunk bodies write to `.typeward/cache/cell_<nonce>.R` and source from a one-line wrapper sent over stdin; sentinels `<<<__TYPEWARD_END__:NONCE:STATUS>>>` on both streams demarcate end-of-output so leftover bytes never bleed between runs. Variables defined in cell N persist into cell N+1. Returns `{ok, stdout, stderr, exitCode, durationMs}` with the same shape as before. Non-R languages still return a stub message. Two new IPCs: `stop_r_kernel` (kill + drop kernel) and `r_kernel_status` (bool). 4 new Rust tests cover the sentinel parser.
- `notebook-outputs-store.ts`: outputs map keyed by cell id + a `runningIds` set so Run All can advance cells sequentially while the user inspects earlier output.
- New global command `notebook.runAll` (Mod+Shift+Enter) registered in `boot.ts` with `when: () => project()?.experience === "notebook"` so it's only active while a notebook project is open. Bails on the first failed cell.
- IPC: `ipc.runRChunk({projectRoot, code}) → CellRunResult`.
- 45 frontend tests + 12 Rust tests pass (after Quarto removal).

**Deferred follow-ups** (smaller next slices):
- Plot/image capture (capture the R graphics device, surface as `<img>` outputs below the code)
- Per-cell Python/Julia execution

**Landed (2026-05-11) — Notebook shell (whole-file render)** [Quarto pieces since removed]

- Rust: `compile_rmarkdown` runs `Rscript -e "rmarkdown::render('<file>', output_format='pdf_document', quiet=TRUE)"`. (Originally also `compile_quarto` via `quarto render --to pdf`; removed 2026-05-12.) Both returned `CompileResult` mirroring the LaTeX/Typst/Markdown adapters. Log parser `parse_r_log` classifies the canonical R/knitr error/warning prefixes.
- IPC: `ipc.compileRmarkdown(project)`.
- Adapter: `RmarkdownAdapter` declares `experience: "notebook"` and publishes `rmarkdown.render` with Mod+Enter and Build group.
- `notebook-shell.tsx` — originally a thin wrapper around `TextShell`; subsequently rewritten as a real cell-aware layout (see entry above).
- `EditorScreen` picks shell from `project.experience` (`<Show when={project()?.experience === "notebook"}>`). LSP startup routes RMD through the markdown LSP (marksman) for basic prose completions; a chunk-aware server is deferred.
- `actions.adapterFor()` and `EditorScreen.adapterForFormat()` route the format → adapter mapping in lockstep.

**Deferred from Phase 2 (next slices):**

- Cell-aware notebook editor (split source into per-chunk CodeMirror instances; reorder/add/delete cells)
- Cell-level execution (inline outputs, persistent R / Python kernels)
- Smart per-page PDF diff (only re-render changed pages on recompile)
- Sync-to-cursor toggle (auto-scroll PDF as the user types)

**Landed (2026-05-11) — SyncTeX forward + inverse search**

- Rust: new `src-tauri/src/synctex.rs` module shells out to the system `synctex` CLI for both directions. `synctex_forward(projectRoot, pdfPath, sourceFile, line) → {page, x, y, h, v}` and `synctex_inverse(pdfPath, page, x, y) → {file, line}`. Returns `Ok(None)` when the CLI isn't on PATH so the frontend can quietly disable sync features. 5 unit tests cover the result-block parsers (multi-block input, missing fields, no-block-at-all).
- `compile_latex` now passes `-synctex=1` to latexmk + pdflatex and `--synctex` to tectonic (sidecar + PATH branches). Without this, no `.synctex.gz` is produced and forward/inverse silently return empty.
- IPC: `ipc.synctexForward({...})` and `ipc.synctexInverse({...})` typed wrappers.
- Editor view handle: `src/stores/editor-view-store.ts` keeps an imperative reference to the active CodeMirror `EditorView` in module scope (not Solid reactive — actions fire from outside Solid's render context). Exposes `currentCursorLine()` and `setCursorLine(line)`.
- PdfViewer:
  - New `scrollTarget` prop (page + y in PDF pts + generation). When generation changes, the viewer scrolls smoothly and pulses a gradient ribbon at the target Y (`@keyframes synctex-pulse` in utilities.css).
  - New `onPageClick(page, x, y)` prop. Fires on **shift+click**; click-coords are translated from CSS pixels back to PDF points by dividing by the current zoom scale — exactly what `synctex edit` expects.
- Editor store gains `pdfScrollTarget` + `gotoSourceIntent` signals with `requestPdfScroll(page, y)` and `requestGotoSource(relPath, line)` mutators. Each carries a strictly-increasing `generation` so re-firing the same target re-triggers effects.
- Actions: `syncForwardFromCursor()` reads cursor → IPC → bumps pdfScrollTarget. `syncInverseFromPdfClick(page, x, y)` calls IPC and routes the absolute source path back through `pathRelativeTo()` (case-insensitive comparison on Windows) into `requestGotoSource()`.
- LatexAdapter registers a second command: `latex.syncForward` with Mod+J, scope `editor`, in the Navigation group. It shows up in the palette only while a LaTeX project is open.
- EditorScreen subscribes to `gotoSourceIntent`: opens the target file via `openFile()` if not already active, then moves the cursor through the editor-view-store handle. Generation tracking keeps it idempotent.
- Smart per-page diff and a sync-to-cursor toggle were considered and **deferred** — they add substantial complexity (PDF page hashing, settings UI, opt-in plumbing) without changing the core SyncTeX UX in this slice.
- Tests: 5 Rust unit tests + new LatexAdapter test (2 cases covering shape of `latex.syncForward`). 37 frontend tests + 11 Rust tests pass.

**Landed (2026-05-11) — Markdown + Typst adapters**

- Rust: `compile_typst` runs `typst compile <file>` (native PDF, no LaTeX needed); `compile_markdown` runs `pandoc <file> -o <out.pdf>` (delegates PDF generation to a LaTeX engine). Both return `CompileResult` mirroring `compile_latex`. Log parsers (`parse_typst_log`, `parse_pandoc_log`) classify error/warning prefixes; unit tests cover both + the shared `replace_ext` helper.
- IPC: `ipc.compileTypst(project)` and `ipc.compileMarkdown(project)` wrappers in `src/ipc/index.ts`.
- Adapters: `src/adapters/markdown/MarkdownAdapter.ts` and `src/adapters/typst/TypstAdapter.ts`. Each publishes a format-specific compile command (`markdown.compile`, `typst.compile`) with Mod+Enter and Build group. Registered via `EditorScreen`'s `adapterForFormat()` on project load; the keyboard router shows them in the palette only while a project of that format is open.
- Typst syntax highlighting: `src/adapters/typst/typst-language.ts` — minimal hand-rolled CM6 `StreamLanguage` (comments, strings, math `$...$`, `#funcs`, headings, emphasis, brackets). text-shell's `languageFor()` routes `.typ` → typst.
- `commands/actions.ts` `adapterFor()` and `EditorScreen.adapterForFormat()` updated in lockstep — keep them aligned when notebook adapters land.
- Tests: shared adapter contract test (9 across LaTeX/Markdown/Typst). 35 frontend tests + 6 Rust tests pass.

**Landed (2026-05-11) — CommandRegistry binding**

- `EditorCommand` shape tightened: `run()` takes no args (commands read stores), plus `scope: "global" | "editor"`, `when()` predicate, and `subtitle` for the palette.
- Single source-of-truth actions module (`src/commands/actions.ts`) — save/compile orchestration lives there instead of inside `text-shell.tsx`. Adapter command runners delegate into it.
- Core commands registered at boot (`src/commands/boot.ts`): toggle palette (Mod+K), close palette (Esc), new project (Mod+N), open Settings (Mod+,), save (Mod+S). `core.compile` deliberately omitted — adapters publish their own format-specific compile so the palette can show "Compile LaTeX" / future "Compile Typst" with context.
- Adapter commands register on project load / unregister on cleanup (`EditorScreen`). `LatexAdapter.commands` now goes through the registry.
- Global keyboard router (`src/commands/keyboard.ts`) installed once from `App.tsx`; respects scope (`editor`-scoped commands only fire when focus is inside `[data-editor-shell]` or `.cm-content`) and `when()` predicates. CodeMirror's hardcoded `Mod-s` / `Mod-Enter` keymap entries removed so the registry is authoritative.
- Shared `<CommandPalette />` (`src/components/CommandPalette.tsx`) rendered once at the App root, driven by `paletteOpen_` signal. Reads registry commands + recent projects, supports arrow-key nav, group headers, and per-key `<kbd>` chips via `shortcutTokens()` from the new `src/lib/shortcuts.ts`.
- ProjectsScreen no longer hosts its own palette / keyboard handler — they're global now.
- Tests: shortcuts parser (10 tests), palette-store (4), boot (4), registry (4 existing). All 26 frontend tests pass.

**Still pending in Phase 2:**

Each new format = a new `EditorAdapter` + `CompileProvider` + (sometimes) `LspProvider`. **No format logic outside its adapter.**

**Text-experience formats** (reuse `text-shell`):

- **Typst** — custom CodeMirror lang, **tinymist** LSP, `typst compile` sidecar
- **Markdown** — `@codemirror/lang-markdown`, **marksman** LSP, **pandoc** sidecar for PDF/HTML preview

**Notebook experience** (new `notebook-shell` — distinct layout, distinct persistence semantics):

- Cell-based editor (markdown / code / output cells), per `design_files/editors/editor-variants.jsx`
- Chunk execution: R via a persistent kernel per project (long-lived `R --slave` child, sentinel-delimited stdin/stdout protocol). Variables carry across cells. No Jupyter kernel — `.ipynb` support is out of scope.
- **R Markdown** as the sole notebook adapter (Quarto was scoped and then removed)

**Preview-quality work** (this is what separates a serious LaTeX tool from a toy):

- **SyncTeX** — forward search (cursor → PDF location) and inverse search (click PDF → jump to source). Big differentiator for serious LaTeX users.
- Retained scroll position, zoom, and current page across recompile (already scaffolded in Phase 1; refine here)
- Smart page refresh — diff pages, only re-render changed ones
- Sync-to-cursor toggle

### Phase 3 — Tablet — substantively complete (2026-05-13)

The plan called for "drop-in replacement for desktop's `compile.rs` on mobile target via cfg-gated Rust"; we landed something simpler and stronger — a frontend Web Worker provider that runs the same way on desktop and tablet, with no Rust cfg-gates needed. busytex's own runtime owns the worker; we just dispatch.

**Landed (2026-05-13) — Responsive layout pass**

- `src/stores/viewport-store.ts` — reactive `viewportMode` (`desktop` ≥1024 / `tablet` <1024), `activePane` (`sidebar`/`editor`/`preview`), `logsSheetOpen`. Test-only `__setViewportWidthForTest` helper for unit tests.
- `src/components/layout/PaneSwitcher.tsx` — bottom segmented control with 44px+ tap targets (FolderTree/FileText/Eye + ScrollText for logs toggle).
- `src/lib/gestures.ts` `installSwipeListener` — horizontal swipe detector, touch/pen only (no mouse), 70px threshold, 1.5x horizontal:vertical ratio gate so the editor's vertical scrolls don't get hijacked.
- `text-shell.tsx` + `notebook-shell.tsx` — both split into `DesktopLayout` (corvu Resizable, unchanged) and `TabletLayout` (single-pane `<Switch>` + PaneSwitcher + slide-up LogsSheet + swipe listener). File-select on tablet auto-swaps active pane back to "editor". CenterPane scales tab strip and close-button hit areas in tablet mode.
- 3 new viewport-store tests.

**Landed (2026-05-13) — busytex WASM CompileProvider**

- `npm install texlyre-busytex` (v1.1.1). One-time asset fetch via `npx texlyre-busytex download-assets ./public/core` → `public/core/busytex/` (~32MB WASM + 90-400MB TeX Live data), served at `/core/busytex` by Vite.
- `src/providers/compile/busytex-provider.ts` — wraps `BusyTexRunner` + `PdfLatex` as lazy singletons (`runner.initialize(true)` uses the package's built-in Web Worker). Walks the project tree for `.tex`/`.bib`/`.cls`/`.sty`/`.bst`/`.def`/`.ldf`/`.fd`/`.cnf`/`.clo`/`.aux` (capped 200 files / 5MB), passes them as `additionalFiles`, auto-enables BibTeX when any `.bib` is present. Sniffs SyncTeX magic bytes (`1f 8b`) to write either `.synctex.gz` or `.synctex` next to the PDF so the existing `synctex` CLI resolves forward/inverse search against busytex output. Reuses the Rust `parse_latex_log` extractor via the new `parse_latex_log_cmd` IPC.
- Rust: new project-scoped `write_project_binary_file` and `parse_latex_log_cmd` Tauri commands.
- `CompileEngine` type extended to `"system-tex" | "tectonic" | "busytex"`.
- `LatexAdapter.compile()` routes the busytex branch via dynamic import so the ~32MB bridge stays out of desktop bundles when unused.
- Settings → Editor → Compilation now lets users pick engine; HEAD-probes `/core/busytex/busytex_pipeline.js` and surfaces a "Not installed" pill with the exact `npx texlyre-busytex download-assets ./public/core` command when missing.
- Test: smoke test for the assets-missing error path.

**Deferred from busytex slice:**
- Shipping binary assets (`.png`, `.pdf` figures) into the worker's in-memory FS.

**Landed (2026-05-13) — Android build pipeline scaffold**

- `tauri android init --skip-targets-install --ci` with `JAVA_HOME\bin` prepended to PATH (Java is only available via Android Studio's bundled JBR 21 on the dev host).
- Generated `src-tauri/gen/android/` (Gradle wrapper, `app` module, `buildSrc`, gitignores for build artifacts).
- All four Android Rust targets (`aarch64`, `armv7`, `i686`, `x86_64`-linux-android) installed. `Cargo.toml` already had `crate-type = ["staticlib", "cdylib", "rlib"]`.
- `tauri.conf.json` left unchanged (mobile-specific config lives under `gen/android/tauri.android.conf.json`).

**Deferred (user-driven):**
- Actual `tauri android dev` or `tauri android build` against an emulator/device — needs the user to spin up AVD / connect hardware.
- iPadOS target. Plan still calls for it; doable on macOS only. We'll come back to it.

**Original breakdown (kept for reference):**

- Responsive layout pass: collapse split panes to drawers/sheets; touch hit targets ≥44px; gesture-driven pane toggle
- Tauri 2 mobile build pipeline (Xcode + Android Studio)
- **texlyre-busytex** integration: drop-in replacement for desktop's `compile.rs` on mobile target via cfg-gated Rust

### Phase 4 — Cloud + collaboration — deferred (2026-05-13)

Paused indefinitely. When it resumes, scope has been narrowed: **no cloud file storage**. Files remain local-first; Supabase is only used for:

- Email/password auth (no OAuth in v0)
- Real-time collaboration (Yjs over Supabase Realtime channels, files streamed during the session rather than persisted to Supabase Storage)
- License keys / subscription tier validation

The original Phase 4 bullets ("Supabase auth/storage", "Folder sync as files + metadata in Supabase storage + Postgres", "Account UI in Settings") are superseded by this narrower scope and should not be implemented as written.

Pending design questions, to revisit when the phase resumes:

- What does collab look like without cloud file storage? (Live-session model where one peer hosts and others join via Yjs awareness/edits, with no Supabase persistence? Bring-your-own-storage via Git/Dropbox/iCloud?)
- What does the subscription gate? (Feature gates, project count, compile minutes, or just Pro vs Free with no concrete restrictions?)
- Where do entitlements live and how often are they refreshed?

---

## Critical files to reference during build

| File | Why |
|---|---|
| `design_files/Editor.html` (line 304+ for layout, design tokens at top) | Canonical Editor layout, glass utilities, token vocabulary |
| `design_files/Settings.html` | Defines the theme & customization surface (4 themes + 4 accent palettes + editor options) |
| `design_files/Projects.html` | Projects list visual spec |
| `design_files/Onboarding.html` | Onboarding flow + engine detection UI (both "Workshop" and "Console" directions — pick one) |
| `design_files/editors/editor-variants.jsx` | Per-format editor variants (Markdown, Typst, RMD; Quarto/Jupyter prototypes there are historical) |
| `design_files/onboarding/screens.jsx` | Onboarding screen list |

> The HTML prototypes are the source of truth for **visual output**. The JSX files are React; do **not** copy structure verbatim — port to idiomatic Solid (signals over hooks, no `React.Children`, no portals where unneeded).

---

## Verification (end of Phase 1)

End-to-end manual check on desktop:

1. Launch `npm run tauri dev` → onboarding screen appears, pixel-matches design
2. Onboarding detects system TeX (or shows install prompt if missing)
3. Land on Projects screen → matches design, lists real folders
4. Click "New Project" → folder created on disk, `.typeward/project.json` written
5. Open project → Editor screen opens with file tree from disk, `main.tex` in CodeMirror
6. Type `\begin{equa` → texlab autocompletes `\begin{equation}`; warnings underline as expected
7. Click Compile → see compile log, PDF appears in right pane
8. Edit → recompile → PDF updates
9. Open Settings → switch theme to Obsidian → all surfaces re-skin instantly
10. Switch accent palette → gradients, focus rings, active states all update
11. Resize the three panes → smooth, persists across reload

Automated:

- `npm test` — Vitest passes (stores, theme switcher, file utils, autosave snapshots, command registry)
- `npm run test:e2e` — Playwright drives the full flow above against the desktop build
- `cargo test --manifest-path src-tauri/Cargo.toml` — Rust unit tests for `fs.rs`, `detect.rs`, `compile/`, `watcher.rs`, `autosave.rs`
- **Compile fixture regression suite** — `fixtures/{latex-basic,latex-bib,typst-basic,markdown-pandoc,notebook-basic}/` each have an expected output (PDF hash or text snapshot, expected diagnostics, expected compile time bound). CI compiles each via the relevant `CompileProvider` and asserts. Catches engine-bump regressions and adapter wiring bugs.

---

## Cross-cutting concerns (live across all phases)

| Concern | Approach | Phase |
|---|---|---|
| **Autosave / crash recovery** | Debounced snapshots in `.typeward/snapshots/`; recovery prompt on launch | Phase 1 |
| **Unified file watcher** | One Rust `notify` service → typed events → frontend stream; consumed by preview, file tree, buffers, build | Phase 1 |
| **Telemetry / error reporting** | Structured local logs for crashes, compile failures, LSP failures; opt-in submission | Phase 1 (capture) → later (submission UI) |
| **Extension seams** | `EditorAdapter`, `CompileProvider`, `PreviewProvider`, `LspProvider`, `CommandRegistry` defined day one | Phase 1 (interfaces) → Phase 5+ (real plugin loader) |
| **SyncTeX** | Forward + inverse search through PDF preview | Phase 2 |
| **Document experiences** | `text` vs `notebook` vs `publishing` shells — chosen at project creation | text in Phase 1, notebook in Phase 2 |

---

## Open items deliberately deferred

- Spell-check engine choice (Hunspell vs LanguageTool) — phase 2
- Vim mode binding plugin selection — phase 2
- BibTeX/Zotero integration — phase 2 once core editor is solid
- Whether to bundle Typst/pandoc binaries vs detect-system — decide per-platform during phase 2
- Update mechanism (Tauri updater vs app stores) — phase 3+
