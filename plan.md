# Typeward — Stack & Build Plan

> Source of truth for the build plan. The original plan-mode artifact lives at
> `~/.claude/plans/let-s-plan-stack-for-elegant-newell.md`; this file is the
> repo-tracked copy and is updated as phases land.

## Status

### App build phases (original plan)

| Phase | State | Summary |
|---|---|---|
| 0 — Skeleton | **complete** (2026-05-10) | Tauri 2 + Solid + TS scaffolded. Tailwind v4, Kobalte, lucide-solid, corvu, @solidjs/router installed. Theme tokens (Aurora/Obsidian/Graphite/Paper) + accent palettes (Violet-Cyan/Amber-Rose/Emerald-Teal/Indigo-Pink) wired with localStorage persistence. Vitest (jsdom) and `cargo test` baseline tests passing. Icons generated for all platforms. |
| 1 — Vertical slice on desktop | **complete** (2026-05-10) | All four screens (Onboarding/Projects/Editor/Settings) ported and functional. CodeMirror 6 + PDF.js wired into a 3-pane corvu Resizable shell. Real LaTeX compile via system TeX (latexmk/pdflatex) or Tectonic. Architecture seams defined (DocumentExperience, EditorAdapter, CompileProvider, PreviewProvider, LspProvider, CommandRegistry). LSP transport (texlab spawn + JSON-RPC framing over Tauri event channels), unified file watcher (notify-based), autosave + recovery dialog, and telemetry capture (panic hook + frontend error hook + JSONL log) all in. |
| 2 — Multi-format & preview polish | substantively complete | CommandRegistry bound, Typst adapter, SyncTeX all landed (2026-05-11..15). Two items intentionally skipped per user direction: smart per-page PDF diff and sync-to-cursor toggle. Quarto support was scoped in then dropped 2026-05-12. Markdown/RMD adapters and notebook shell were subsequently removed (2026-05-20 scope narrowing — see below). |
| 3 — Tablet | substantively complete (2026-05-13) | Responsive layout (viewport-store + PaneSwitcher + LogsSheet + swipe gestures), texlive-wasm CompileProvider (multi-file walker, bundled-resource assets, SyncTeX persistence), Android target scaffolded via `tauri android init`. APK build-and-run on emulator/device is the only remaining piece — user-driven. |
| 4 — Cloud + collab | **superseded** (2026-05-22) | The original "folder sync to Supabase + realtime collab" framing was retired 2026-05-13. The integrations program (below) picks up the still-relevant pieces — third-party cloud storage providers landed as Integ Phase 2; Supabase resurfaces as Integ Phase 7 with a narrower scope (auth + entitlements only, no file storage, no realtime collab). Realtime collab via Yjs remains separately deferred. |

### Integrations program (2026-05-22 → present)

Approved plan: `~/.claude/plans/research-and-completely-plan-resilient-brook.md`.

| Integ Phase | State | Summary |
|---|---|---|
| 0 — Foundations | **complete** (2026-05-22; hardened 2026-05-24) | Rust integrations module: `reqwest` HTTPS, OS keyring (`keyring` v3), PKCE OAuth via `axum` loopback on `127.0.0.1:0`, `opener` plugin + scoped capability. Frontend provider interfaces (`CitationProvider`, `CloudFsProvider`, `AiProvider`, `GrammarProvider`, `TemplateProvider`), free-tier entitlement fallback (`<FeatureGate>` + `<UpgradePrompt>`), `runOauthFlow` driver. HTTP IPC is host allowlisted; `authRef` is host-bound. `IntegrationsSettings` + `ProjectIntegrations` schemas (both `#[serde(default)]`-additive). |
| 1 — References | **complete** (2026-05-22; Zotero local-API fallback 2026-06-11; JabRef removed 2026-06-13) | Zotero local (Better BibTeX probe, falling back to Zotero 7's built-in local API — BBT no longer required), Zotero Web (API key), Mendeley (OAuth PKCE; flagged maintenance-mode), DOI / arXiv / CrossRef lookup (no auth — `doi.org` content negotiation). Aggregator writes `<project>/.typeward/citations/library.bib` which texlive-wasm + texlab/tinymist pick up automatically. ReferencesPanel sidebar tab + DoiLookupDialog + per-provider settings card. (The JabRef `.bib`-file provider was cut — Zotero's local library covers it.) |
| 2 — Cloud storage | **complete** (2026-05-22; hardened 2026-05-24; OneDrive + Google Drive removed 2026-06-14; iCloud removed 2026-06-20) | Dropbox (longpoll cursor). Generic sync engine + local cache under `<projectsRoot>/.remote-cache/<provider>/<projectId>/`, conflict resolution writes `<name>.conflict-<ISO>.<ext>` siblings. Remote paths are normalized before cache IO and `.typeward/` targets are rejected. CloudPickerDialog (new-project Cloud branch) + SyncStatusBadge + ConflictResolverDialog. OneDrive (Graph `delta`) and Google Drive (`changes.list`, `drive.file`) were built then removed — point their native desktop sync apps at a local folder under the projects root instead (OneDrive ships on Windows by default). |
| 3 — Git / GitHub / Overleaf | **complete** (2026-05-22; hardened 2026-05-24) | libgit2 via `git2` (12 IPCs, all `spawn_blocking`); GitHub device-flow OAuth shares its token with libgit2's HTTPS callbacks via the keyring slot `git.github.com`; Overleaf zip import (zip-slip guarded) + git-bridge clone via `git_clone`. CommitPanel (SCM sidebar tab), GitStatusBar (TopBar branch chip + ahead/behind), CloneDialog with provider sniffing, Author identity + GitHub sign-in cards in Settings. Pull is fast-forward only and refuses dirty worktrees. SSH out of scope for now. |
| 4 — AI providers | **complete** (2026-05-22; hardened 2026-05-24) | One Rust streaming task with format-specific parsers (Anthropic SSE / OpenAI SSE / Gemini SSE / Ollama NDJSON); abortable via `ai_stream_abort`. Frontend AsyncIterable adapter `aiStream`. Four providers (Claude / ChatGPT / Gemini / Ollama) share the same `AiProvider` shape; one active at a time and entitlement-gated. OpenAI / Anthropic / Gemini keys attach in Rust via `authRef`; status UI uses `credential_exists`. |
| 5 — Grammar | **complete** (2026-05-23) | Harper via `harper-core` — Rust-native, in-process, zero network. `grammar_check` IPC + CM6 `@codemirror/lint` linter (400ms debounce, 3 quick-fix actions per lint). Gated on `integrations.grammar.enabled` so off = zero IPC. American English only for now. |
| 6 — Templates | **complete** (2026-05-23) | Manifest-driven (`template.json` with `variables[]` + `files[]`), Handlebars-subset `{{var}}` substitution. 4 built-in templates shipped under `src-tauri/resources/templates/`: latex/article, latex/ieee-conference, latex/beamer, typst/typst-article. `<TemplateGallery>` two-stage dialog wired into new-project flow. Custom templates load from `<app_data>/templates/custom/<id>/`. |
| 7 — Supabase auth + entitlements | **complete** (2026-05-23; hardened 2026-05-24; staging pushed 2026-06-11; billing scoped out 2026-06-13) | Auth + subscription-driven feature gating only — no license keys, no file storage, no realtime collab, **no in-app billing**. **7.1** `supabase/` migrations (plans / subscriptions / profiles / entitlements_map / signup trigger / `get_entitlements()` RPC + shared_templates), `seed.sql` with the free/pro catalog + ~20-key entitlement matrix (Team tier retired 2026-06-20), `seed_test_users.sql` staging seed — now living in the dedicated `typeward/infrastructure` repo (sibling checkout `../infrastructure`, moved out 2026-06-12). **7.2** `@supabase/supabase-js` ^2.106 with a keyring-backed storage adapter (sessions live in `typeward.supabase.session` keyring slots, not localStorage; chunked on the frontend because Windows Credential Manager caps blobs at 2560 bytes). Reactive `supabaseSession()` signal driven by `onAuthStateChange`. **7.3** AccountSection in Settings (email/password sign-in, plan badge), SubscriptionBadge in TopBar reads `currentTier()`. **7.4** `initSupabaseEntitlements()` swaps the free fallback for a real source on sign-in, with a 7-day-TTL keyring-cached snapshot for offline and stale-result guards after sign-out/account switches. Paid Settings rows, registries, AI activation, and cloud sync startup are gated. **7.5** staging push DONE 2026-06-11 against `aepfxzsnhjonzevwglgr` (migrations + seeds + test@test.cz → Pro + advisor-driven grant hardening). **7.6** Billing is website-only (decided 2026-06-13) — the app sells nothing, has no Stripe code/webhook, and links signed-in users to `https://typeward.app/account` to purchase/manage plans; it reads the resulting tier via `get_entitlements()`. The shared `subscriptions`/`plans` tables keep their `stripe_*` columns for the website's checkout/webhook, but `database.types.ts` omits them. |

### UI/UX overhaul + finish-the-wiring program (2026-06-11 → 2026-06-12)

Detailed per-pass record in `design/STATUS.md` rows G–M; theme spec in `design/themes.md`; widget roster in `design/widgets.md`. Summary:

- **Desk Lamp re-theme** — theme roster cut to exactly four: **Daylight** (new default; t1 light tuned to `design_files/sample_identity.txt` — ivory paper, charcoal ink, near-black primary, brass selection, seal-red errors), **Lamplight** (t1 dark, amber accent), **Aurora** (`tokens.css` baseline), **Paper**. Obsidian/Graphite deleted. New token groups: per-theme `--syntax-*` (CodeMirror colors), `--color-accent-fg` (text on accent surfaces), `--color-text-selection`. Boot splash re-tints from the persisted theme via `src/boot-theme.ts` (external file — CSP forbids inline scripts). A serif display-type experiment was reverted on user direction; the re-apply recipe is preserved in `design/themes.md`.
- **Full app review + remediation** — 5-dimension review (visual / architecture / security / UX / build); all high and most medium findings fixed, including the 2026-06-11 security hardening pass (see CLAUDE.md security invariants).
- **Projects screen composition** — ComposerHero deleted; the library grid is the hero. Widget shelf curated to 4 functional opt-in widgets (recent projects, library summary, persisted pinned notes, real Pomodoro focus timer); all stubs removed.
- **Editor wiring** — focus mode (Mod+Shift+F), vim mode option (`@replit/codemirror-vim` via compartment + settings toggle), auto-compile-on-save option, `stopOnFirstError` → `-halt-on-error`, real exports (compiled-PDF save-as + `export_project_zip` source bundle), double-click PDF inverse search (replaces the toolbar-button/crosshair UX; shift+click retained), dirty-close confirm, in-sidebar new-file creation, SCM tab gated on `.git` presence, Refs tab gated on configured reference providers, selection-visibility fix.
- **Settings restructure** — nav categories Account / Workspace / Integrations with per-provider subsections (`IntegrationsPanel` takes a `section` prop), live Reset-app-data (`reset_settings` IPC), shortcuts panel driven by the command registry, `validEnum` load-boundary validation for persisted enums.
- **Supabase login fix** — the "[object Object]" sign-in failure was the Windows Credential Manager 2560-byte blob cap breaking session persistence; fixed with chunked keyring storage (`src/integrations/auth/chunked.ts`). Staging DB fully provisioned (7.5).
- **Integration friction** — Zotero no longer requires Better BibTeX (Zotero 7 built-in local API fallback, paginated BibTeX export); Ollama auto-probes `127.0.0.1:11434` and lists installed models, with the custom-URL field only shown when unreachable.
- **Repo/CI hygiene** — `infrastructure/` moved to the dedicated sibling repo; CI builds the `texlive-wasm` sibling before the app (`build.yml`), new `tests.yml` (typecheck + vitest + cargo test); `.gitattributes` line-ending normalization.
- **2026-06-12 follow-up** (`design/STATUS.md` row N) — locked paid features hide entirely on lower plans (FeatureGate renders nothing; UpgradePrompt deleted); `integrations.ai.enabled` master switch hides every AI surface and deactivates providers when off; **custom themes shipped** (the formerly deferred JSON loader): `src-tauri/src/themes.rs` validates `<app_data>/themes/*.json`, `src/themes/custom-themes.ts` layers tokens over a built-in base, Settings has the full authoring loop (Open folder / Create sample / Reload) with the "Harbor" sample as reference; the widget shelf became the opt-in **Dashboard panel** (fixed Activity card + drag-reorderable cards, persisted enable/order).
- **2026-06-13 follow-up** — **JabRef removed** (provider, settings field, UI row, entitlement key — Zotero's local library covers the workflow); **in-app billing scoped out** — no Stripe code/checkout/webhook in the app, plans are bought on the Typeward website, Account links to `https://typeward.app/account`, and `database.types.ts` drops the `stripe_*` columns.
- **Deliberately deferred** (honestly badged "soon" in the UI; build only on explicit request): notifications system, pandoc docx/html exports, PDF annotation flattening, tablet layouts for Projects/Settings screens.

---

## Context

Multiplatform editor app ("Typeward") similar to Overleaf, format-agnostic: LaTeX and Typst, with live `.md` file preview. (Jupyter / `.ipynb`, Quarto, Markdown-as-project, and R Markdown / notebook experience were all dropped — see "Scope narrowing — 2026-05-20" below.) Targets desktop (Win/Mac/Linux) and tablets (iPadOS, Android tablets — no phones). Designs already exist in `design_files/` (HTML/CSS/JS prototypes from claude.ai/design): glassmorphism aesthetic, custom Tailwind utilities + CSS custom properties, four built-in themes and four accent palettes. (The original Aurora/Obsidian/Graphite/Paper roster was replaced 2026-06-11 by the Desk Lamp system — Daylight default / Lamplight / Aurora / Paper, per `design_files/t1`+`t2` and `sample_identity.txt`; see the UI/UX overhaul section above.) Ships local-first; cloud sync, accounts, and real-time collaboration are future phases. Approach: skeleton → pixel-perfect UI/UX with real desktop compile (vertical slice) → multi-format → tablet → cloud/collab.

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
| LSP integration | **Hand-rolled CM6 binding** over Tauri **event channels** (not `invoke`) | LSP servers (texlab, tinymist) run as Tauri sidecars; Rust owns child-process lifecycle, frontend owns editor protocol state. Bidirectional event streams keep autocomplete/diagnostics latency low; lifecycle writes still use `invoke`. We avoided `codemirror-languageserver` because its transport stack is WebSocket/open-rpc oriented. |
| PDF preview | **pdfjs-dist** (PDF.js) | Offline, hot-reload on compile output. |
| Resizable panes | **corvu** (`corvu/resizable`) | Mature Solid primitive; the prototype's `useDrag` works but corvu handles a11y + edge cases for free. |
| TeX engine — desktop (primary) | **System install** (TeX Live / MiKTeX / MacTeX) | Detect at onboarding; invoke `latexmk`/`pdflatex` directly via Rust. |
| TeX engine — desktop (quick-start) | **Tectonic** (bundled Rust binary) | Onboarding offers this as a zero-friction alternative — full TeX install can come later. Avoids losing users at the install gate. |
| TeX engine — tablet | **texlive-wasm** (WASM) | Local sibling package; bundled as Tauri resources for mobile. |
| Other compilers | **Typst CLI** as a detected binary | Detected on PATH per-platform; not bundled. |
| Testing | **Vitest** + **@solidjs/testing-library** + **Playwright** + **cargo test** | E2E uses Tauri's WebDriver bridge. |
| Cloud / accounts | **Third-party cloud providers + Supabase auth** | Dropbox syncs through its API and a local cache. (OneDrive / Google Drive were removed 2026-06-14 — use their desktop sync apps pointed at a local projects folder.) Supabase is auth + subscription entitlements only; no document storage or realtime collab in the current scope. |
| Real-time collab (future) | **Yjs** + **y-codemirror.next** | Transport over Supabase realtime channels. |

### Why not these (briefly)

- **shadcn / solid-ui** — shadcn is React-only; solid-ui inherits the shadcn aesthetic, which conflicts with Typeward's glassmorphism. You'd override ~80% of every component. solid-ui uses Kobalte under the hood anyway — go direct.
- **react-resizable-panels analog or hand-rolled drag** — corvu is small, accessible, Solid-native. Less code than maintaining the prototype's `useDrag`.

---

## Core architectural patterns

These are the seams that prevent the app from collapsing into format-specific spaghetti by Phase 2. **Define them in Phase 1**, even when only LaTeX is implemented — retrofitting later is brutal.

### 1. `EditorAdapter` (per format)

```ts
interface EditorAdapter {
  languageId: string;                                  // "latex" | "typst"
  cmExtensions(ctx: EditorCtx): Extension[];           // CodeMirror 6 extensions
  compile(project: Project): Promise<CompileResult>;   // delegates to a CompileProvider
  previewKind: "pdf";
  diagnostics$: Stream<Diagnostic[]>;                  // from LSP or compile
  completions(ctx, pos): Promise<Completion[]>;        // from LSP
  commands: EditorCommand[];                           // toolbar/palette commands
}
```

Concrete today: `LatexAdapter`, `TypstAdapter`. Common plumbing (compile/diagnostics/completion wiring) lives in a base class; adapters only declare their specifics.

`.md` files open in the text editor but their right pane renders `<MarkdownPreview>` (markdown-it + KaTeX + DOMPurify) instead of `<PdfViewer>`. Markdown does not have an adapter and does not participate in compile.

### 3. Provider seams (extension boundaries)

Even with no plugin system today, define interfaces so format logic isn't hardcoded:

- `CompileProvider` — system-tex / tectonic / typst-cli / texlive-wasm (mobile)
- `PreviewProvider` — pdf.js / html (html = MarkdownPreview, frontend-only)
- `LspProvider` — texlab / tinymist
- `CommandRegistry` — toolbar actions, command palette, keybindings register here, not directly in components

Plugins later become "things that register adapters and providers." Without these seams, every format leaks into every component.

### 4. LSP transport

Rust owns LSP child processes; Solid frontend talks over **Tauri event channels** (`emit`/`listen`), not `invoke`, for inbound server traffic. The frontend LSP client wraps this in a JSON-RPC stream and a local CM6 integration (`src/lib/lsp/cm6.ts`). Live traffic stays event-driven; only one-shot lifecycle ops (start/stop server) and outbound writes use `invoke`.

### 5. Unified file-watcher service

A single Rust service (built on `notify` crate) emits typed events for:

- compile output changes → trigger preview reload
- external file edits (user edits in another tool) → reconcile with editor buffer
- generated files (.aux/.log) → update file tree, hide/group as appropriate
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
    projects/                 # Project list + new project (LaTeX or Typst)
    editor/                   # Hosts the editor shell
      shells/
        text-shell.tsx        # 3-pane text editor (LaTeX/Typst; .md files get MarkdownPreview)
    settings/                 # Themes, editor opts, integrations, billing
  adapters/                   # EditorAdapter implementations
    latex/                    # LatexAdapter, latex CM extensions, snippets
    typst/
  providers/                  # Pluggable seams
    compile/                  # CompileProvider impls: system-tex, tectonic, typst, texlive-wasm
    preview/                  # PreviewProvider impls: pdf
    lsp/                      # LspProvider impls
  components/
    primitives/               # Thin Tailwind wrappers around Kobalte
    glass/                    # Glass card variants
    forms/                    # Toggle, Slider, ColorPicker, Combobox
    editor/                   # CodeMirror integration, gutters, status bar
    preview/                  # MarkdownPreview.tsx (markdown-it + KaTeX + DOMPurify)
    pdf/                      # PDF.js viewer with retained scroll/zoom + SyncTeX (Phase 2)
    layout/                   # ResizablePanes, Tabs, Sidebar
  themes/
    tokens.css                # Baseline tokens (Aurora — no data-theme attr)
    themes/daylight.css, lamplight.css, paper.css   # Daylight is the default
    accents.css               # 4 accent palettes
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
      texlive_wasm.rs         # Phase 3 (mobile target only; frontend provider today)
    lsp/
      mod.rs                  # Sidecar lifecycle + event-channel transport
      texlab.rs
      tinymist.rs
    detect.rs                 # System TeX/engine detection
    autosave.rs               # Snapshot store
    telemetry.rs              # Panic hook + structured error capture
    main.rs
  binaries/                   # Sidecar binaries (Tectonic, optionally LSPs/typst)
  tauri.conf.json
  Cargo.toml
fixtures/                     # Compile fixture projects for regression tests
  latex-basic/
  latex-bib/
  typst-basic/
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
- Theme system: `:root` tokens via `@theme` (Aurora default) + `[data-theme]` overrides for Obsidian/Graphite/Paper + `[data-accent]` for the four palettes *(roster replaced 2026-06-11 — Daylight default / Lamplight / Aurora / Paper; see the UI/UX overhaul section)*
- `theme-store.ts` — Solid signals → `<html>` attrs → localStorage
- Vitest with jsdom, dev-conditions gated on `VITEST` env var (avoids polluting production builds with Solid's dev runtime). 4 passing tests cover theme/accent state + DOM application + persistence.
- `cargo test` baseline (1 smoke test) wired in `src-tauri/src/lib.rs`
- Icons generated for desktop + iOS + Android via `npx tauri icon`
- Temporary `DevShell` in `src/App.tsx` with route nav + theme/accent dropdowns — to be removed when porting real designs

### Phase 1 — Vertical slice on desktop — complete (2026-05-10)

What landed:

- **Glass + accent utilities** (`src/themes/utilities.css`): theme-aware `.glass` / `.glass-soft` / `.glass-inset`, accent gradients tied to `--color-accent-1/2`, `.lift`, `.label-xs`, `.mono`, plus `pulse` / `blink` / `shimmer` keyframes. Shadow tokens override per theme (Paper gets soft drops).
- **Architecture seams** (interfaces only, types tested): `EditorAdapter` + `Project` + `Diagnostic` + `CompileResult` + `EditorCommand` (`src/adapters/types.ts`), `CompileProvider` / `PreviewProvider` / `LspProvider` (`src/providers/types.ts`), reactive `CommandRegistry` (`src/commands/registry.ts`).
- **Onboarding** (3 steps): welcome, engine probe (auto-runs `which` for pdflatex/xelatex/lualatex/latexmk/tectonic/typst), choose system TeX vs bundled Tectonic. Persists choice to settings.
- **Projects** screen: list + search + new-project dialog (LaTeX or Typst), backed by `~/Documents/Typeward/<folder>/.typeward/project.json`.
- **Settings** screen: Theme + Editor sections fully wired; placeholder cards for Account/Notifications/Security/Billing/Integrations until cloud lands.
- **Editor** screen: corvu Resizable 3-pane shell, CodeMirror 6 with `lang-stex` (LaTeX) and `lang-markdown`, theme-aware editor styling, FileTree from disk via Tauri fs plugin, PDF.js viewer with retained scroll position + zoom across recompiles, status bar (line count / language / encoding / compile time), Problems pane.
- **LatexAdapter** (`src/adapters/latex/LatexAdapter.ts`) — first concrete `EditorAdapter`. Delegates to `compileLatex` IPC.
- **CompileProvider impls** in Rust (`src-tauri/src/commands.rs`): system TeX path runs `latexmk -pdf` (falling back to `pdflatex`); Tectonic path runs `tectonic -X compile`. Minimal `.log` parser produces error/warning diagnostics.
- **LSP transport** (`src-tauri/src/lsp.rs` + `src/lib/lsp/client.ts` + `src/lib/lsp/cm6.ts`): Rust spawns texlab/tinymist as a child process, parses Content-Length-framed JSON-RPC, emits inbound payloads as Tauri events. Outbound traffic via `send_lsp_message` invoke. Lifecycle ops (`start_lsp` / `stop_lsp`) via invoke. The CM6 binding is local, not `codemirror-languageserver`.
- **Unified file watcher** (`src-tauri/src/watcher.rs` + `src/lib/watcher/client.ts`): `notify`-based, one watcher per project, typed events emitted on a single channel.
- **Autosave + crash recovery**: debounced 500ms snapshots to `<project>/.typeward/snapshots/<rel>.snap`. On project open, the editor scans for orphans (snapshots newer than file mtime) and prompts via `RecoveryDialog`.
- **Telemetry**: Rust panic hook + frontend `window.error` / `unhandledrejection` hook → structured JSONL log at `<app_data>/telemetry.log`. Compile failures forwarded automatically. No submission UI yet.

Iteration items intentionally deferred:
- **Structured LSP token/semantic support** — the hand-rolled CM6 binding covers diagnostics/completion; richer semantic tokens are still deferred.
- **Bundled Tectonic binary** — compile path invokes the `tectonic` CLI from PATH; the actual sidecar binary download/bundling lands separately.
- **Multi-tab editor** — only one file open at a time for now.
- **Pixel-perfect parity** with `design_files/Editor.html` — the layout and components match design intent but were not pixel-matched line-by-line; iterate visually after the user reviews.

Original breakdown follows for reference:

1. **Theme + glass primitives** — port `.glass`, `.glass-soft`, `.glass-inset`, `.lift`, `.accent-grad` to Tailwind plugin or component layer (see `design_files/Editor.html` line 304+ for canonical styles)
2. **Architectural seams** (build the interfaces even if only one implementation exists):
   - `EditorAdapter` interface + `LatexAdapter` concrete impl
   - `CompileProvider` trait + `system_tex.rs` and `tectonic.rs` impls
   - `PreviewProvider` trait + `pdf.rs` impl
   - `LspProvider` trait + `texlab.rs` impl
   - `CommandRegistry` — at least the LaTeX commands (compile, format, jump-to-error) registered through it
   - LSP transport over event channels (not `invoke`)
   - Unified `watcher.rs` service with one frontend client
3. **Onboarding** — port `design_files/Onboarding.html`; engine step offers two paths: "Use installed TeX" (runs `detect.rs`) or "Use Typeward's quick-start engine" (Tectonic, no install needed)
4. **Projects screen** — port `design_files/Projects.html`; backed by a Tauri command listing `~/Documents/Typeward/`. New-project flow picks LaTeX or Typst and writes it into `project.json`
5. **Settings screen** — port `design_files/Settings.html`; themes + accent palettes wire to store; editor options persist to `settings.json`
6. **Editor screen** (`text-shell` + `LatexAdapter`) — port `design_files/Editor.html`:
   - Resizable 3-pane layout via corvu
   - CodeMirror 6 with `@codemirror/lang-tex` (extensions provided by `LatexAdapter.cmExtensions()`)
   - texlab spawned as sidecar; LSP wired through the local CM6 binding over event channels
   - "Compile" → goes through `CompileProvider` (system-tex or Tectonic per project setting)
   - PDF.js renders compiled output via `PreviewProvider`, **retains scroll position + zoom across recompile** (don't naively rebuild the viewer)
   - File tree from disk via `watcher.rs`; tabs from open files; status bar live (line/col/encoding)
7. **Autosave + crash recovery** — debounced snapshots to `.typeward/snapshots/`; on launch, recovery prompt for any unflushed snapshots
8. **Telemetry scaffolding** — Rust panic hook → `telemetry.rs`; structured compile/LSP failure capture; local-only for now, no submission UI yet

### Phase 2 — Multi-format & preview polish

> **Note:** Quarto support was scoped and built (2026-05-11) then removed (2026-05-12). Markdown-as-project, R Markdown, and the notebook shell were built then removed (2026-05-20) — see "Scope narrowing — 2026-05-20" below. The historical entries for those features are omitted to avoid confusion.

**Deferred from Phase 2 (next slices):**

- Smart per-page PDF diff (only re-render changed pages on recompile)
- Sync-to-cursor toggle (auto-scroll PDF as the user types)

**Landed (2026-05-11) — SyncTeX forward + inverse search**

- Rust: new `src-tauri/src/synctex.rs` module shells out to the system `synctex` CLI for both directions. `synctex_forward(projectRoot, pdfPath, sourceFile, line) → {page, x, y, h, v}` and `synctex_inverse(pdfPath, page, x, y) → {file, line}`. Returns `Ok(None)` when the CLI isn't on PATH so the frontend can quietly disable sync features. 5 unit tests cover the result-block parsers (multi-block input, missing fields, no-block-at-all).
- `compile_latex` now passes `-synctex=1` to latexmk + pdflatex and `--synctex` to tectonic (sidecar + PATH branches). Without this, no `.synctex.gz` is produced and forward/inverse silently return empty.
- IPC: `ipc.synctexForward({...})` and `ipc.synctexInverse({...})` typed wrappers.
- Editor view handle: `src/stores/editor-view-store.ts` keeps an imperative reference to the active CodeMirror `EditorView` in module scope (not Solid reactive — actions fire from outside Solid's render context). Exposes `currentCursorLine()` and `setCursorLine(line)`.
- PdfViewer:
  - New `scrollTarget` prop (page + y in PDF pts + generation). When generation changes, the viewer scrolls smoothly and pulses a gradient ribbon at the target Y (`@keyframes synctex-pulse` in utilities.css).
  - New `onPageClick(page, x, y)` prop. Fires on **shift+click** *(2026-06-11: double-click became the primary gesture; shift+click retained)*; click-coords are translated from CSS pixels back to PDF points by dividing by the current zoom scale — exactly what `synctex edit` expects.
- Editor store gains `pdfScrollTarget` + `gotoSourceIntent` signals with `requestPdfScroll(page, y)` and `requestGotoSource(relPath, line)` mutators. Each carries a strictly-increasing `generation` so re-firing the same target re-triggers effects.
- Actions: `syncForwardFromCursor()` reads cursor → IPC → bumps pdfScrollTarget. `syncInverseFromPdfClick(page, x, y)` calls IPC and routes the absolute source path back through `pathRelativeTo()` (case-insensitive comparison on Windows) into `requestGotoSource()`.
- LatexAdapter registers a second command: `latex.syncForward` with Mod+J, scope `editor`, in the Navigation group. It shows up in the palette only while a LaTeX project is open.
- EditorScreen subscribes to `gotoSourceIntent`: opens the target file via `openFile()` if not already active, then moves the cursor through the editor-view-store handle. Generation tracking keeps it idempotent.
- Smart per-page diff and a sync-to-cursor toggle were considered and **deferred** — they add substantial complexity (PDF page hashing, settings UI, opt-in plumbing) without changing the core SyncTeX UX in this slice.
- Tests: 5 Rust unit tests + new LatexAdapter test (2 cases covering shape of `latex.syncForward`). 37 frontend tests + 11 Rust tests pass.

**Landed (2026-05-11) — Typst adapter** [MarkdownAdapter removed 2026-05-20]

- Rust: `compile_typst` runs `typst compile <file>` (native PDF, no LaTeX needed). Returns `CompileResult` mirroring `compile_latex`. Log parser (`parse_typst_log`) classifies error/warning prefixes; unit tests cover both + the shared `replace_ext` helper.
- IPC: `ipc.compileTypst(project)` wrapper in `src/ipc/index.ts`.
- Adapter: `src/adapters/typst/TypstAdapter.ts` publishes `typst.compile` with Mod+Enter and Build group. Registered via `EditorScreen`'s `adapterForFormat()` on project load.
- Typst syntax highlighting: `src/adapters/typst/typst-language.ts` — minimal hand-rolled CM6 `StreamLanguage` (comments, strings, math `$...$`, `#funcs`, headings, emphasis, brackets). text-shell's `languageFor()` routes `.typ` → typst.
- `commands/actions.ts` `adapterFor()` and `EditorScreen.adapterForFormat()` updated in lockstep.
- Tests: shared adapter contract test (covering LaTeX/Typst). 35 frontend tests + 6 Rust tests pass.

**Landed (2026-05-11) — CommandRegistry binding**

- `EditorCommand` shape tightened: `run()` takes no args (commands read stores), plus `scope: "global" | "editor"`, `when()` predicate, and `subtitle` for the palette.
- Single source-of-truth actions module (`src/commands/actions.ts`) — save/compile orchestration lives there instead of inside `text-shell.tsx`. Adapter command runners delegate into it.
- Core commands registered at boot (`src/commands/boot.ts`): toggle palette (Mod+K), close palette (Esc), new project (Mod+N), open Settings (Mod+,), save (Mod+S). `core.compile` deliberately omitted — adapters publish their own format-specific compile so the palette can show "Compile LaTeX" / future "Compile Typst" with context.
- Adapter commands register on project load / unregister on cleanup (`EditorScreen`). `LatexAdapter.commands` now goes through the registry.
- Global keyboard router (`src/commands/keyboard.ts`) installed once from `App.tsx`; respects scope (`editor`-scoped commands only fire when focus is inside `[data-editor-shell]` or `.cm-content`) and `when()` predicates. CodeMirror's hardcoded `Mod-s` / `Mod-Enter` keymap entries removed so the registry is authoritative.
- Shared `<CommandPalette />` (`src/components/CommandPalette.tsx`) rendered once at the App root, driven by `paletteOpen_` signal. Reads registry commands + recent projects, supports arrow-key nav, group headers, and per-key `<kbd>` chips via `shortcutTokens()` from the new `src/lib/shortcuts.ts`.
- ProjectsScreen no longer hosts its own palette / keyboard handler — they're global now.
- Tests: shortcuts parser (10 tests), palette-store (4), boot (4), registry (4 existing). All 26 frontend tests pass.

**Preview-quality work** (this is what separates a serious LaTeX tool from a toy):

- **SyncTeX** — forward search (cursor → PDF location) and inverse search (click PDF → jump to source). Big differentiator for serious LaTeX users.
- Retained scroll position, zoom, and current page across recompile (already scaffolded in Phase 1; refine here)
- Smart page refresh — diff pages, only re-render changed ones
- Sync-to-cursor toggle

### Phase 3 — Tablet — substantively complete (2026-05-13)

The plan called for "drop-in replacement for desktop's `compile.rs` on mobile target via cfg-gated Rust"; we landed something simpler and stronger — a frontend Web Worker provider that runs the same way on desktop and tablet, with no Rust cfg-gates needed. `texlive-wasm` owns the worker; Typeward dispatches.

**Landed (2026-05-13) — Responsive layout pass**

- `src/stores/viewport-store.ts` — reactive `viewportMode` (`desktop` ≥1024 / `tablet` <1024), `activePane` (`sidebar`/`editor`/`preview`), `logsSheetOpen`. Test-only `__setViewportWidthForTest` helper for unit tests.
- `src/components/layout/PaneSwitcher.tsx` — bottom segmented control with 44px+ tap targets (FolderTree/FileText/Eye + ScrollText for logs toggle).
- `src/lib/gestures.ts` `installSwipeListener` — horizontal swipe detector, touch/pen only (no mouse), 70px threshold, 1.5x horizontal:vertical ratio gate so the editor's vertical scrolls don't get hijacked.
- `text-shell.tsx` — split into `DesktopLayout` (corvu Resizable, unchanged) and `TabletLayout` (single-pane `<Switch>` + PaneSwitcher + slide-up LogsSheet + swipe listener). File-select on tablet auto-swaps active pane back to "editor". CenterPane scales tab strip and close-button hit areas in tablet mode.
- 3 new viewport-store tests.

**Landed (2026-05-13; replaced 2026-06-04) — texlive-wasm CompileProvider**

- Local `texlive-wasm` package (`file:../texlive-wasm`). One-time asset fetch via `npx texlive-wasm download-assets ./src-tauri/resources/texlive-wasm`, bundled as Tauri resources for mobile builds.
- `src/providers/compile/texlive-wasm-provider.ts` — wraps `latexmk()` with a lazy `pdflatex` engine handle. Walks the project tree for `.tex`/`.bib`/`.cls`/`.sty`/`.bst`/`.def`/`.ldf`/`.fd`/`.cnf`/`.clo`/`.aux` plus binary figures (capped 200 files / 10MB), auto-enables BibTeX when any `.bib` is present. Sniffs SyncTeX magic bytes (`1f 8b`) to write either `.synctex.gz` or `.synctex` next to the PDF. Reuses the Rust `parse_latex_log` extractor via `parse_latex_log_cmd`.
- Rust: new project-scoped `write_project_binary_file` and `parse_latex_log_cmd` Tauri commands.
- `CompileEngine` type is `"system-tex" | "tectonic" | "texlive-wasm"`, with old persisted `"busytex"` migrated on load.
- `LatexAdapter.compile()` routes the texlive-wasm branch via dynamic import so the WASM bridge stays out of desktop bundles when unused.
- Settings → Editor → Compilation hides the engine picker on mobile; mobile locks to texlive-wasm.
- Test: smoke test for the assets-missing error path.

**Deferred from texlive-wasm slice:**
- Device/emulator compile smoke tests after mobile build hardware is available.

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
- **texlive-wasm** integration: mobile CompileProvider backed by bundled WASM TeX Live resources

### Scope narrowing — 2026-05-20

Supported project formats reduced to **LaTeX and Typst**. The following were built and then removed:

- Markdown-as-project (MarkdownAdapter, `compile_markdown` via pandoc, marksman LSP)
- R Markdown / notebook experience (RmarkdownAdapter, `compile_rmarkdown`, notebook shell, cell parser, notebook-store, persistent R kernel via `KernelManager`, notebook.rs)
- Quarto was removed earlier (2026-05-12)

`.md` files can still be opened inside any project; the right pane swaps from `<PdfViewer>` to `<MarkdownPreview>` (markdown-it + KaTeX + DOMPurify) for a live HTML preview. Markdown does not compile and has no adapter.

See `docs/ntb_feature.md` (archival notes on what was removed) and `docs/superpowers/specs/2026-05-20-narrow-formats-md-preview-design.md` (spec for the replacement preview).

### Phase 4 — Cloud + collaboration — superseded by the integrations program (2026-05-22)

Originally deferred 2026-05-13 with the framing "Supabase auth + realtime collab + license keys, no Storage." Superseded by the integrations program above, which picks up the still-relevant pieces with sharper scope:

- **Third-party cloud storage** (Dropbox) landed as **Integ Phase 2**. Files remain local-first; the sync engine maintains a per-project cache under `<projectsRoot>/.remote-cache/<provider>/<projectId>/` and reconciles via per-provider delta APIs. (OneDrive / Google Drive were built then removed 2026-06-14 — their native desktop sync apps cover the same need via a local folder.)
- **Supabase** resurfaced as **Integ Phase 7** and shipped 2026-05-23 (staging push done 2026-06-11). Scope narrowed once more to **auth + subscription-driven entitlements only** — no file storage of user docs, no license keys (subscription-only revenue model), and **no in-app billing** (purchases happen on the Typeward website; the app only reads the resulting tier). License-key validation is explicitly retired. The default offline/unsigned state is the free-tier matrix, not an allow-all stub.
- **Realtime collab via Yjs** remains separately deferred — it has no current owner phase. When it resumes, the design questions below still apply.

Open design questions for a future collab phase:

- What does collab look like without cloud file storage? (Live-session model where one peer hosts and others join via Yjs awareness/edits, with no Supabase persistence? Bring-your-own-storage via Git/Dropbox?)
- What does the subscription gate? Phase 7's tier matrix (see `../infrastructure/supabase/seed.sql`) is the starting point — Pro covers third-party cloud providers and hosted AI/reference integrations. (Two tiers only — Free and Pro; the Team tier was retired 2026-06-20, so shared templates / future collab would be Pro-gated or out of scope.)

**Evaluated 2026-06-10 → postponed (decision record, so the research isn't re-done):**

- **Transport decision: Supabase Realtime** (reuse the server already run for auth; broadcast for Yjs updates, presence primitive for cursors). Rejected p2p/WebRTC — "direct" still needs a signaling server *and* a TURN relay for restrictive NATs (so it's *more* new infra than reusing Supabase) and has no persistence when all peers are offline. Rejected a dedicated y-websocket server (new service to deploy) and a custom Rust relay (reinventing y-websocket).
- **Why postponed — Supabase Realtime economics for Yjs:** Free = 200 concurrent / **2M messages/mo** / **100 msg/sec project-wide cap** / 256 KB payload; Pro = 500 / 5M then $2.50/M. **Messages are billed per recipient** (a broadcast to N peers = 1 + N messages), and Yjs is chatty (per-edit + awareness). Rough math: two people debounced to ~10 updates/s ≈ 40 msg/s ⇒ ~**14 hours of 2-person co-editing exhausts the entire free monthly quota**, and a 3-4 person room can hit the 100 msg/s cap that throttles the *whole* project. Live co-editing cost scales with `edits × participants`.
- **Recommended phasing when it resumes (NOT full realtime first):**
  - *Phase 1 — Presence:* who's in the project, who's viewing which file, live cursor/selection over Realtime's presence primitive (cheap, throttleable). Content keeps merging via the **already-shipped bidirectional cloud sync** (eventually consistent). Delivers the social layer Free-tier-affordably.
  - *Phase 2 — Live co-editing:* Yjs concurrent editing of the active shared file, heavily throttled (batched ~150 ms, awareness rate-limited, active-file only), **Pro-tier gated** so cost-generators pay, with message-usage monitoring. CM6 binding via `y-codemirror.next`; the open architectural problem is reconciling the Yjs doc with the local-first file model (autosave / compile / watcher / cloud-sync all read the file on disk).
  - The CRDT-into-file-model reconciliation and a server-side persistence/snapshot story (Postgres table, RLS-gated) are the hard parts to design before Phase 2.

---

## Critical files to reference during build

| File | Why |
|---|---|
| `design_files/Editor.html` (line 304+ for layout, design tokens at top) | Canonical Editor layout, glass utilities, token vocabulary |
| `design_files/Settings.html` | Defines the theme & customization surface (4 themes + 4 accent palettes + editor options) |
| `design_files/Projects.html` | Projects list visual spec |
| `design_files/Onboarding.html` | Onboarding flow + engine detection UI (both "Workshop" and "Console" directions — pick one) |
| `design_files/editors/editor-variants.jsx` | Per-format editor variants (Typst; Markdown/RMD/Quarto/Jupyter prototypes there are historical) |
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
9. Open Settings → switch theme to Lamplight → all surfaces re-skin instantly
10. Switch accent palette → gradients, focus rings, active states all update
11. Resize the three panes → smooth, persists across reload

Automated:

- `npm test` — Vitest passes (stores, theme switcher, file utils, autosave snapshots, command registry)
- `npm run test:e2e` — Playwright drives the full flow above against the desktop build
- `cargo test --manifest-path src-tauri/Cargo.toml` — Rust unit tests for `fs.rs`, `detect.rs`, `compile/`, `watcher.rs`, `autosave.rs`
- **Compile fixture regression suite** — `fixtures/{latex-basic,latex-bib,typst-basic}/` each have an expected output (PDF hash or text snapshot, expected diagnostics, expected compile time bound). CI compiles each via the relevant `CompileProvider` and asserts. Catches engine-bump regressions and adapter wiring bugs.

---

## Cross-cutting concerns (live across all phases)

| Concern | Approach | Phase |
|---|---|---|
| **Autosave / crash recovery** | Debounced snapshots in `.typeward/snapshots/`; recovery prompt on launch | Phase 1 |
| **Unified file watcher** | One Rust `notify` service → typed events → frontend stream; consumed by preview, file tree, buffers, build | Phase 1 |
| **Telemetry / error reporting** | Structured local logs for crashes, compile failures, LSP failures; opt-in submission | Phase 1 (capture) → later (submission UI) |
| **Extension seams** | `EditorAdapter`, `CompileProvider`, `PreviewProvider`, `LspProvider`, `CommandRegistry` defined day one | Phase 1 (interfaces) → Phase 5+ (real plugin loader) |
| **SyncTeX** | Forward + inverse search through PDF preview | Phase 2 |

---

## Open items deliberately deferred

- ~~**Vim mode binding plugin selection**~~ → **done 2026-06-11.** `@replit/codemirror-vim` behind a Settings → Editor toggle, loaded via a CM6 compartment so toggling doesn't remount the editor.
- **Whether to bundle the Typst binary vs detect-system** — decide per-platform
- **Smart per-page PDF diff** and **sync-to-cursor toggle** — original Phase 2 deferrals
- ~~**Cloud-storage push side wiring to autosave** (Integ Phase 2)~~ → **done 2026-06-10; conflict hardening 2026-06-11.** Saves (`saveActiveFile`/`saveAllDirtyFiles`) feed `notifyLocalSave` → `engine.queuePush` (1.5s debounce, 15s retry), serialized with pull, rev-keyed echo suppression. Snapshot autosave does not push. A per-file `sync-state.json` manifest (provider rev + local content hash) now drives conflict detection, deletion push, and remote-delete-vs-local-edit preservation; only the two-sided-conflict *winner* decision is still mtime-based (the loser is always kept as a `.conflict-*` sidecar).
- **Conversation persistence + selection-driven AI commands** (Integ Phase 4 polish) — chat stays in memory per session; "Explain selection" / "Rewrite paragraph" haven't landed as commands yet.
- ~~**Save-as-template** (Integ Phase 6)~~ → **done 2026-06-10.** `template_save` IPC captures the open project into `<app_data>/templates/custom/<id>/` (excludes `.typeward/`/`.git/`, symlinks, and LaTeX build junk; copies the rest verbatim and writes a `template.json`). Reachable via the "Save project as template" command → `<SaveTemplateDialog>` (mounted at App root). Variable extraction is still manual — authors add `variables`/`files[*].template` to the generated manifest by hand.
- **Grammar language picker** (Integ Phase 5) — Harper ships American English only at the moment; British and other dialects depend on Harper's dictionary set growing.
- **SSH transport for git** — HTTPS + PAT covers the integration phase's scope; SSH agent forwarding + host verification is its own UX surface.
- **iPadOS target** — waits for the Tauri iOS target to be exercised.
- ~~**Stripe webhook edge function** (Integ Phase 7.6)~~ → **dropped from the app 2026-06-13.** Billing moved entirely to the Typeward website (Stripe checkout + webhook live there). The app sells nothing and only reads the subscription tier; the Account section links to `https://typeward.app/account`. The shared `subscriptions` table keeps its `stripe_*` columns for the website's webhook; `seed_test_users.sql` still seeds test rows for staging.
- ~~**Staging push** (Integ Phase 7.5)~~ → **done 2026-06-11.** Migrations + seeds applied to `aepfxzsnhjonzevwglgr` via the Supabase MCP; test@test.cz signs in with the Pro plan badge. Future pushes follow the CLI flow in `../infrastructure/README.md`.

Resolved by the integrations program:

- ~~Spell-check engine choice~~ → Harper (Integ Phase 5).
- ~~BibTeX/Zotero integration~~ → Integ Phase 1 (Zotero / Mendeley / DOI lookup shipped; JabRef shipped then removed 2026-06-13).
- Update mechanism (Tauri updater vs app stores) — phase 3+
