# Typeward — Stack & Build Plan

> Source of truth for the build plan. The original plan-mode artifact lives at
> `~/.claude/plans/let-s-plan-stack-for-elegant-newell.md`; this file is the
> repo-tracked copy and is updated as phases land.

> **2026-08-03 — Typeward is open source (GPL-3.0-or-later) with no paid tier.**
> The root `LICENSE` is the verbatim GPLv3 text; `package.json` and
> `src-tauri/Cargo.toml` declare `GPL-3.0-or-later`; `THIRD-PARTY-NOTICES.md` +
> `LICENSES/Apache-2.0.txt` cover the vendored Apache-2.0 `harper-core`. There
> is **no account, no entitlement gate, no subscription, and no backend of our
> own** — every feature (Typst, all reference integrations, git/GitHub, Overleaf
> import, all AI providers, Harper grammar, cloud sync, custom templates, every
> template in the gallery) is unconditionally available. The phases below that
> built accounts and gating are recorded as history; they are not a roadmap.
> See "The account & entitlement layer — built, then removed" below.

## Status

### App build phases (original plan)

| Phase | State | Summary |
|---|---|---|
| 0 — Skeleton | **complete** (2026-05-10) | Tauri 2 + Solid + TS scaffolded. Tailwind v4, Kobalte, lucide-solid, corvu, @solidjs/router installed. Theme tokens (Aurora/Obsidian/Graphite/Paper) + accent palettes (Violet-Cyan/Amber-Rose/Emerald-Teal/Indigo-Pink) wired with localStorage persistence. Vitest (jsdom) and `cargo test` baseline tests passing. Icons generated for all platforms. |
| 1 — Vertical slice on desktop | **complete** (2026-05-10) | All four screens (Onboarding/Projects/Editor/Settings) ported and functional. CodeMirror 6 + PDF.js wired into a 3-pane corvu Resizable shell. Real LaTeX compile via system TeX (latexmk/pdflatex) or Tectonic. Architecture seams defined (DocumentExperience, EditorAdapter, CompileProvider, PreviewProvider, LspProvider, CommandRegistry). LSP transport (texlab spawn + JSON-RPC framing over Tauri event channels), unified file watcher (notify-based), autosave + recovery dialog, and telemetry capture (panic hook + frontend error hook + JSONL log) all in. |
| 2 — Multi-format & preview polish | substantively complete | CommandRegistry bound, Typst adapter, SyncTeX all landed (2026-05-11..15). Two items intentionally skipped per user direction: smart per-page PDF diff and sync-to-cursor toggle. Quarto support was scoped in then dropped 2026-05-12. Markdown/RMD adapters and notebook shell were subsequently removed (2026-05-20 scope narrowing — see below). |
| 3 — Tablet | **incomplete — gated** (status corrected 2026-07-13) | What works: the responsive shell (viewport-store + PaneSwitcher + LogsSheet + swipe gestures), the texlive-wasm CompileProvider's multi-file walker + SyncTeX persistence + log parsing, and the in-JS SyncTeX reader. What does NOT: **no APK has ever been built or run**, and three blockers stand between here and one — (1) the Android build fails in `openssl-sys` (pulled in by `git2`), (2) the WASM compile path passed no `enginePath`, so engine init threw on every mobile compile (renderer half fixed 2026-07-13; unproven on a device), (3) OS-keyring credentials would not persist on Android. Ship-blocking for a tablet release; desktop is unaffected. |
| 4 — Cloud + collab | **superseded** (2026-05-22), **remainder dropped** (2026-08-03) | The original "folder sync to our own backend + realtime collab" framing was retired 2026-05-13. The integrations program (below) picks up the still-relevant piece — third-party cloud storage providers landed as Integ Phase 2. The narrowed auth+entitlements successor (Integ Phase 7) shipped and was then removed entirely when the project went open source, so nothing in this phase remains on the roadmap. Realtime collab via Yjs is separately deferred and has no owner phase. |

### Integrations program (2026-05-22 → present)

Approved plan: `~/.claude/plans/research-and-completely-plan-resilient-brook.md`.

| Integ Phase | State | Summary |
|---|---|---|
| 0 — Foundations | **complete** (2026-05-22; hardened 2026-05-24) | Rust integrations module: `reqwest` HTTPS, OS keyring (`keyring` v3), PKCE OAuth via `axum` loopback on `127.0.0.1:0`, `opener` plugin + scoped capability. Frontend provider interfaces (`CitationProvider`, `CloudFsProvider`, `AiProvider`, `GrammarProvider`, `TemplateProvider`), `runOauthFlow` driver. HTTP IPC is host allowlisted; `authRef` is host-bound. `IntegrationsSettings` + `ProjectIntegrations` schemas (both `#[serde(default)]`-additive). Since Dropbox's removal (2026-08-05) **Mendeley is the only OAuth provider wired up**, and it is a *confidential* client (client secret in the keyring, fixed loopback redirect the user pastes from their registration) — the PKCE machinery stays intact but no shipped provider drives it; GitHub signed in through its own device flow *(removed 2026-08-13 — Mendeley is now the only OAuth client of any kind; git credentials come from the user's credential helper)*. *(This phase also shipped the free-tier entitlement fallback plus `<FeatureGate>`/`<UpgradePrompt>`; deleted 2026-08-03.)* |
| 1 — References | **complete** (2026-05-22; Zotero local-API fallback 2026-06-11; JabRef removed 2026-06-13) | Zotero local (Better BibTeX probe, falling back to Zotero 7's built-in local API — BBT no longer required), Zotero Web (API key), Mendeley (OAuth PKCE; flagged maintenance-mode), DOI / arXiv / CrossRef lookup (no auth — `doi.org` content negotiation). Aggregator writes `<project>/.typeward/citations/library.bib` which texlive-wasm + texlab/tinymist pick up automatically. ReferencesPanel sidebar tab + DoiLookupDialog + per-provider settings card. (The JabRef `.bib`-file provider was cut — Zotero's local library covers it.) |
| 2 — Cloud storage | **complete** (2026-05-22; hardened 2026-05-24; OneDrive + Google Drive removed 2026-06-14; iCloud removed 2026-06-20; Dropbox removed 2026-08-05) | **WebDAV is the only cloud backend** — Nextcloud, ownCloud or any WebDAV host, via the dedicated SSRF-screened Rust client. It needs no registered app and no client id, only a URL and an account, which is why it is the one that survived. WebDAV has no usable change cursor, so `delta()` re-walks with PROPFIND and diffs ETags against a snapshot serialized into the engine cursor. Generic sync engine + local cache under `<projectsRoot>/.remote-cache/<provider>/<projectId>/`, conflict resolution writes `<name>.conflict-<ISO>.<ext>` siblings. Remote paths are normalized before cache IO and `.typeward/` targets are rejected. New-project Cloud branch + SyncStatusBadge + ConflictResolverDialog. Removed backends — Dropbox (longpoll cursor), OneDrive (Graph `delta`), Google Drive (`changes.list`, `drive.file`) — are covered by pointing their native desktop sync apps at a local folder under the projects root instead (OneDrive ships on Windows by default). A project whose `.typeward/project.json` still names a removed provider reads as **not cloud-backed**: it opens, edits and compiles as a plain local folder, nothing on disk is rewritten, and no sync chip is shown. |
| 3 — Git / GitHub / Overleaf | **complete** (2026-05-22; hardened 2026-05-24) | libgit2 via `git2` (12 IPCs, all `spawn_blocking`); GitHub device-flow OAuth shares its token with libgit2's HTTPS callbacks via the keyring slot `git.github.com`; Overleaf zip import (zip-slip guarded) + git-bridge clone via `git_clone`. CommitPanel (SCM sidebar tab), GitStatusBar (TopBar branch chip + ahead/behind), CloneDialog with provider sniffing, Author identity + GitHub sign-in cards in Settings. Pull is fast-forward only and refuses dirty worktrees. SSH out of scope for now. *(The GitHub sign-in, the Settings cards, and the keyring token were removed 2026-08-13 — git now uses the user's gitconfig identity + credential helper, and the CloneDialog is URL + name only.)* |
| 4 — AI providers | **complete** (2026-05-22; hardened 2026-05-24) | One Rust streaming task with format-specific parsers (Anthropic SSE / OpenAI SSE / Gemini SSE / Ollama NDJSON); abortable via `ai_stream_abort`. Frontend AsyncIterable adapter `aiStream`. Four providers (Claude / ChatGPT / Gemini / Ollama) share the same `AiProvider` shape; one active at a time per `integrations.ai.activeProvider`. The master switch `integrations.ai.enabled` defaults **off** (2026-08-03) — the surface was previously masked by the entitlement, and every provider needs a key or a local daemon first. OpenAI / Anthropic / Gemini keys attach in Rust via `authRef`; status UI uses `credential_exists`. |
| 5 — Grammar | **complete** (2026-05-23) | Harper via `harper-core` — Rust-native, in-process, zero network. `grammar_check` IPC + CM6 `@codemirror/lint` linter (400ms debounce, 3 quick-fix actions per lint). Gated on `integrations.grammar.enabled` so off = zero IPC. American English only for now. |
| 6 — Templates | **complete** (2026-05-23) | Manifest-driven (`template.json` with `variables[]` + `files[]`), Handlebars-subset `{{var}}` substitution. 4 built-in templates shipped under `src-tauri/resources/templates/`: latex/article, latex/ieee-conference, latex/beamer, typst/typst-article. `<TemplateGallery>` two-stage dialog wired into new-project flow. Custom templates load from `<app_data>/templates/custom/<id>/`. |
| 7 — accounts + entitlements | **REMOVED** (shipped 2026-05-23, deleted 2026-08-03) | Built as auth + subscription-driven feature gating (backend migrations/RPC in the separate `typeward/infrastructure` repo, `@supabase/supabase-js` with keyring-backed sessions, an AccountSection + plan badge, an entitlement source with an offline snapshot cache, website-only billing). **Deleted wholesale when the project went open source** — see "The account & entitlement layer — built, then removed" below for exactly what came out and what replaced it. Not a roadmap item; do not reintroduce gating. |

### UI/UX overhaul + finish-the-wiring program (2026-06-11 → 2026-06-12)

Detailed per-pass record in `design/STATUS.md` rows G–M; theme spec in `design/themes.md`; widget roster in `design/widgets.md`. Summary:

- **Desk Lamp re-theme** — theme roster cut to exactly four: **Daylight** (new default; t1 light tuned to `design_files/sample_identity.txt` — ivory paper, charcoal ink, near-black primary, brass selection, seal-red errors), **Lamplight** (t1 dark, amber accent), **Aurora** (`tokens.css` baseline), **Paper**. Obsidian/Graphite deleted. New token groups: per-theme `--syntax-*` (CodeMirror colors), `--color-accent-fg` (text on accent surfaces), `--color-text-selection`. Boot splash re-tints from the persisted theme via `src/boot-theme.ts` (external file — CSP forbids inline scripts). A serif display-type experiment was reverted on user direction; the re-apply recipe is preserved in `design/themes.md`.
- **Full app review + remediation** — 5-dimension review (visual / architecture / security / UX / build); all high and most medium findings fixed, including the 2026-06-11 security hardening pass (see CLAUDE.md security invariants).
- **Projects screen composition** — ComposerHero deleted; the library grid is the hero. Widget shelf curated to 4 functional opt-in widgets (recent projects, library summary, persisted pinned notes, real Pomodoro focus timer); all stubs removed.
- **Editor wiring** — focus mode (Mod+Shift+F), vim mode option (`@replit/codemirror-vim` via compartment + settings toggle), auto-compile-on-save option, `stopOnFirstError` → `-halt-on-error`, real exports (compiled-PDF save-as + `export_project_zip` source bundle), double-click PDF inverse search (replaces the toolbar-button/crosshair UX; shift+click retained), dirty-close confirm, in-sidebar new-file creation, SCM tab gated on `.git` presence, Refs tab gated on configured reference providers, selection-visibility fix.
- **Settings restructure** — nav categories Account / Workspace / Integrations with per-provider subsections (`IntegrationsPanel` takes a `section` prop), live Reset-app-data (`reset_settings` IPC), shortcuts panel driven by the command registry, `validEnum` load-boundary validation for persisted enums. *(The Account category became the local **Profile** section on 2026-08-03.)*
- **Sign-in persistence fix** *(obsolete — the account layer was removed 2026-08-03)* — the "[object Object]" failure was the Windows Credential Manager 2560-byte blob cap breaking session persistence; fixed at the time with chunked keyring storage (`src/integrations/auth/chunked.ts`, since deleted). The underlying cap still applies to any large frontend-side credential.
- **Integration friction** — Zotero no longer requires Better BibTeX (Zotero 7 built-in local API fallback, paginated BibTeX export); Ollama auto-probes `127.0.0.1:11434` and lists installed models, with the custom-URL field only shown when unreachable.
- **Repo/CI hygiene** — `infrastructure/` moved to the dedicated sibling repo *(nothing in this app has referenced it since 2026-08-03)*; CI checked out and built the `texlive-wasm` sibling before the app (`build.yml`) *(superseded 2026-08-05 — the engine ships as the npm package `@typeward/texlive-wasm`, so all three workflows are back to a plain `npm ci`)*; new `tests.yml` (typecheck + vitest + cargo test); `.gitattributes` line-ending normalization.
- **2026-06-12 follow-up** (`design/STATUS.md` row N) — *(the gating half is moot since 2026-08-03: nothing is gated)* locked paid features hid entirely on lower plans (FeatureGate rendered nothing; UpgradePrompt deleted); `integrations.ai.enabled` master switch hides every AI surface and deactivates providers when off; **custom themes shipped** (the formerly deferred JSON loader): `src-tauri/src/themes.rs` validates `<app_data>/themes/*.json`, `src/themes/custom-themes.ts` layers tokens over a built-in base, Settings has the full authoring loop (Open folder / Create sample / Reload) with the "Harbor" sample as reference; the widget shelf became the opt-in **Dashboard panel** (fixed Activity card + drag-reorderable cards, persisted enable/order).
- **2026-06-13 follow-up** — **JabRef removed** (provider, settings field, UI row, entitlement key — Zotero's local library covers the workflow); **in-app billing scoped out** — no Stripe code/checkout/webhook in the app. *(The website-purchase model it left behind was itself retired 2026-08-03 when the paid tier was dropped.)*
- **Deliberately deferred** (honestly badged "soon" in the UI; build only on explicit request): notifications system, pandoc docx/html exports, PDF annotation flattening, tablet layouts for Projects/Settings screens.

### The account & entitlement layer — built, then removed (2026-08-03)

Typeward went open source under **GPL-3.0-or-later**, and with it the whole
commercial layer came out. This is a record, not a plan — there is nothing here
to resume.

**What was deleted (frontend):** `src/integrations/entitlements.ts`;
`src/components/entitlement/` (FeatureGate, ProChip, ProLockedPanel, ProDialog,
pro-gate); `src/config/pro.ts`; `src/integrations/supabase/` (client, session,
storage, entitlements-source, settings-sync, `database.types.ts`);
`src/config/supabase.ts`; `src/integrations/auth/chunked.ts`;
`src/components/account/`; `src/screens/settings/AccountSection.tsx`. The
`Tier`, `EntitlementKey`, `KNOWN_ENTITLEMENT_KEYS` and `EntitlementSource` types
left `src/integrations/types.ts`, as did `TemplateManifest.entitlement`.

**What was deleted (Rust):** `build.rs` is back to
`fn main() { tauri_build::build() }` — the Supabase CSP splice and its
`serde_json` build-dependency are gone, so `tauri.conf.json`'s `csp`/`devCsp`
are standalone and complete. `credentials.rs` lost `supabase_session_read`,
`credential_get`, `frontend_read_allowed`, and the chunked-session reader (it
keeps `get_secret`/`set_secret`/`credential_exists`/`credential_delete` for
`authRef` resolution). `settings.rs` lost `SyncSettings`, `AccountSettings`,
`sync_state_path`, `load_sync_state`, `save_sync_state`. `ipc_guard.rs` no
longer lists `supabase_session_read`.

**Also removed:** the in-app feedback form (`feedback-submit.ts`,
`feedback-prompt.ts`, `FeedbackCard.tsx`, the `requestFeedbackCard` signal), because
it POSTed to a Supabase edge function. The GitHub-issue path stays —
`BUG_REPORT_ISSUE_URL` in `src/config/feedback.ts`, `src/lib/bug-report.ts`, the
`core.reportBug` command, Diagnostics' "Report a bug" and "Report this error".
Sentry is untouched and still opt-in. *(superseded 2026-08-13 — the GitHub-issue
path, the Diagnostics tab, and Sentry were all deleted with the full
telemetry/crash-reporting removal; there is no in-app feedback, telemetry, or
crash reporting of any kind.)*

**What replaced the Account section:** a **local user profile**. Persisted
settings section `profile` (`displayName`, `email`, `affiliation`, plus a
backend-owned `avatarPath` that `merge_backend_owned` carries across a renderer
settings roundtrip), Rust struct in `settings.rs`, and `src-tauri/src/profile.rs`
owning two commands — `set_profile_avatar` (extension must be png/jpg/jpeg/webp/gif,
rejects symlinks and non-regular files, caps at 8 MiB, copies into
`<app_data>/profile/avatar.<ext>` keeping exactly one) and
`clear_profile_avatar`. `tauri.conf.json`'s `assetProtocol.scope` gained
`$APPDATA/profile/**` so `convertFileSrc` can render the avatar. UI is
`src/screens/settings/ProfileSection.tsx`, mounted in the Settings slot Account
used. The profile name+email seed a template's `author` variable default and
nothing else *(the git-author fallback was removed 2026-08-13 — commit identity
comes from the user's gitconfig)*.

**Defaults changed:** `integrations.ai.enabled` now defaults to `false` on both
the TS and Rust sides. The AI surface used to be masked by the entitlement, so
keeping the old `true` default would have switched it on for everyone with no
provider configured. Grammar already defaulted false.

**Repo hygiene:** `docs/`, `design/` and `design_files/` are gitignored and
untracked — they still exist on the maintainer's disk as local notes, so
in-repo references to them no longer resolve for a fresh clone.

**Verified green at removal:** `npx tsc --noEmit`, `npx vitest run`
(66 files, 537 tests), `cargo test` (270 tests),
`cargo clippy --all-targets -- -D warnings`.

---

## Context

Multiplatform editor app ("Typeward") similar to Overleaf, format-agnostic: LaTeX and Typst, with live `.md` file preview. (Jupyter / `.ipynb`, Quarto, Markdown-as-project, and R Markdown / notebook experience were all dropped — see "Scope narrowing — 2026-05-20" below.) Targets desktop (Win/Mac/Linux) and tablets (iPadOS, Android tablets — no phones). Designs already exist in `design_files/` (HTML/CSS/JS prototypes from claude.ai/design): glassmorphism aesthetic, custom Tailwind utilities + CSS custom properties, four built-in themes and four accent palettes. (The original Aurora/Obsidian/Graphite/Paper roster was replaced 2026-06-11 by the Desk Lamp system — Daylight default / Lamplight / Aurora / Paper, per `design_files/t1`+`t2` and `sample_identity.txt`; see the UI/UX overhaul section above.) Ships local-first and stays that way: project files live in plain folders on disk, optional sync goes through third-party storage the user configures, and there is no Typeward-operated backend. Accounts were built and removed (2026-08-03); real-time collaboration is deferred with no owner phase. Approach: skeleton → pixel-perfect UI/UX with real desktop compile (vertical slice) → multi-format → tablet → third-party integrations.

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
| TeX engine — tablet | **texlive-wasm** (WASM) | npm package `@typeward/texlive-wasm`, pinned `0.2.4-alpha` (MIT, Typeward's sibling project). TeX Live tree bundled as Tauri resources on mobile only. |
| Other compilers | **Typst CLI** as a detected binary | Detected on PATH per-platform; not bundled. |
| Testing | **Vitest** + **@solidjs/testing-library** + **Playwright** + **cargo test** | E2E uses Tauri's WebDriver bridge. |
| Cloud sync | **WebDAV, and only WebDAV** | A user-supplied host (Nextcloud, ownCloud, any WebDAV server) reached through a dedicated SSRF-screened Rust client and a local cache. No registered app, no client id, no vendor API to track. (Dropbox was removed 2026-08-05; OneDrive / Google Drive 2026-06-14 — use their desktop sync apps pointed at a local projects folder.) No Typeward-operated storage or auth: the account layer was removed 2026-08-03. |
| Real-time collab (future) | **Yjs** + **y-codemirror.next** | Deferred, no owner phase. Any transport would be new infrastructure — the server-side research below assumed a backend the app no longer has. |
| License | **GPL-3.0-or-later** | Root `LICENSE` (verbatim GPLv3), declared in `package.json` + `src-tauri/Cargo.toml`; `THIRD-PARTY-NOTICES.md` + `LICENSES/Apache-2.0.txt` for the vendored Apache-2.0 `harper-core`. |

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

> **Update (2026-07-02):** the `CompileProvider`/`PreviewProvider`/`LspProvider`
> interfaces were only ever aspirational — the two `EditorAdapter`s call IPC
> directly (through the `src/commands/compile-runner.ts` leaf), preview-kind is a
> per-file `.md`-vs-PDF switch, and LSP dispatch lives in `src/adapters/languages.ts`.
> The dead `src/providers/types.ts` was deleted; only the mobile
> `providers/compile/texlive-wasm-provider.ts` remains. `CommandRegistry` shipped
> as planned. See CLAUDE.md's `EditorAdapter` seam for the current shape.

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

> **Removed 2026-08-13.** All telemetry and crash reporting were deleted — no panic capture, no on-disk log, no submission path; `recordError()` is a local console.error wrapper only. Do not reintroduce.

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
    settings/                 # Themes, editor opts, integrations, local profile
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
    telemetry/                # recordError() — local console.error wrapper (nothing persisted or transmitted)
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
    telemetry.rs              # Panic hook + structured error capture (removed 2026-08-13)
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

Plays well with Git; third-party cloud sync mirrors the folder (minus `.typeward/`).

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
- **Settings** screen: Theme + Editor sections fully wired; placeholder cards for the other categories until the integrations program landed. *(The Account/Billing placeholders were never filled by a real account layer that survived — see the 2026-08-03 removal above; that slot is the local Profile section today.)*
- **Editor** screen: corvu Resizable 3-pane shell, CodeMirror 6 with `lang-stex` (LaTeX) and `lang-markdown`, theme-aware editor styling, FileTree from disk via Tauri fs plugin, PDF.js viewer with retained scroll position + zoom across recompiles, status bar (line count / language / encoding / compile time), Problems pane.
- **LatexAdapter** (`src/adapters/latex/LatexAdapter.ts`) — first concrete `EditorAdapter`. Delegates to `compileLatex` IPC.
- **CompileProvider impls** in Rust (`src-tauri/src/commands.rs`): system TeX path runs `latexmk -pdf` (falling back to `pdflatex`); Tectonic path runs `tectonic -X compile`. Minimal `.log` parser produces error/warning diagnostics.
- **LSP transport** (`src-tauri/src/lsp.rs` + `src/lib/lsp/client.ts` + `src/lib/lsp/cm6.ts`): Rust spawns texlab/tinymist as a child process, parses Content-Length-framed JSON-RPC, emits inbound payloads as Tauri events. Outbound traffic via `send_lsp_message` invoke. Lifecycle ops (`start_lsp` / `stop_lsp`) via invoke. The CM6 binding is local, not `codemirror-languageserver`.
- **Unified file watcher** (`src-tauri/src/watcher.rs` + `src/lib/watcher/client.ts`): `notify`-based, one watcher per project, typed events emitted on a single channel.
- **Autosave + crash recovery**: debounced 500ms snapshots to `<project>/.typeward/snapshots/<rel>.snap`. On project open, the editor scans for orphans (snapshots newer than file mtime) and prompts via `RecoveryDialog`.
- **Telemetry**: Rust panic hook + frontend `window.error` / `unhandledrejection` hook → structured JSONL log at `<app_data>/telemetry.log`. Compile failures forwarded automatically. No submission UI yet. *(removed 2026-08-13 — all telemetry and crash reporting were deleted; `recordError()` is a local console.error wrapper only.)*

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
8. **Telemetry scaffolding** — Rust panic hook → `telemetry.rs`; structured compile/LSP failure capture; local-only for now, no submission UI yet *(removed 2026-08-13 — all telemetry and crash reporting were deleted.)*

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

### Phase 3 — Tablet — INCOMPLETE, gated (status corrected 2026-07-13)

**Reality check (2026-07-13).** This section was written as "substantively complete"; it wasn't. The
desktop-side work below did land and is used every day. The *mobile* target has never run: no APK has
been built on an emulator or device, and until one is, nothing in this phase is verified on the actual
target. Three named blockers:

1. **Android build fails in `openssl-sys`** — `git2` (libgit2) drags OpenSSL into the Android link, which
   has no system OpenSSL. Fix in flight: cfg-gate the git commands (and `git2`) out of mobile builds. The
   renderer degrades accordingly — `ipc.gitAvailable()` is false on mobile, so the SCM sidebar tab, the git
   status bar and the clone entry point don't render, and every git IPC wrapper fails fast with an
   actionable message instead of an opaque unknown-command rejection.
2. **The WASM compile path threw at engine init** — the provider called `createEngine("pdflatex")` with no
   `enginePath`, and texlive-wasm's worker requires one (`config.enginePath is required`). So mobile compile
   had never worked end to end. Fixed on the renderer side 2026-07-13 (`texlive-wasm-assets.ts`: real
   engine URLs for the tex engine *and* the bibtexu/biber/makeindex helpers, an honest glue+wasm+TDS
   availability probe, actionable unavailable-state). Still unproven on a device.
3. **Android credentials would not persist** — the OS keyring backend has no Android implementation, so
   every `credential_*` write is silently lost (integration API keys, OAuth tokens). Since 2026-07-13
   `credentials.rs::ensure_secure_storage` turns that into a hard error instead of a silent no-op;
   shipping Android still needs a Keystore-backed store.

SyncTeX on mobile is fine (`src/adapters/latex/synctex.ts` has a complete in-JS reader) — it was merely
unreachable while compile was broken.

The plan called for "drop-in replacement for desktop's `compile.rs` on mobile target via cfg-gated Rust"; we landed something simpler and stronger — a frontend Web Worker provider that runs the same way on desktop and tablet, with no Rust cfg-gates needed. `texlive-wasm` owns the worker; Typeward dispatches.

**Landed (2026-05-13) — Responsive layout pass**

- `src/stores/viewport-store.ts` — reactive `viewportMode` (`desktop` ≥1024 / `tablet` <1024), `activePane` (`sidebar`/`editor`/`preview`), `logsSheetOpen`. Test-only `__setViewportWidthForTest` helper for unit tests.
- `src/components/layout/PaneSwitcher.tsx` — bottom segmented control with 44px+ tap targets (FolderTree/FileText/Eye + ScrollText for logs toggle).
- `src/lib/gestures.ts` `installSwipeListener` — horizontal swipe detector, touch/pen only (no mouse), 70px threshold, 1.5x horizontal:vertical ratio gate so the editor's vertical scrolls don't get hijacked.
- `text-shell.tsx` — split into `DesktopLayout` (corvu Resizable, unchanged) and `TabletLayout` (single-pane `<Switch>` + PaneSwitcher + slide-up LogsSheet + swipe listener). File-select on tablet auto-swaps active pane back to "editor". CenterPane scales tab strip and close-button hit areas in tablet mode.
- 3 new viewport-store tests.

**Landed (2026-05-13; replaced 2026-06-04) — texlive-wasm CompileProvider**

- The `texlive-wasm` package — a `file:../texlive-wasm` sibling checkout until 2026-08-05, now the published npm release **`@typeward/texlive-wasm`** pinned at `0.2.4-alpha`, so a bare clone builds after a plain `npm install` with no second repo to check out. Only the module specifiers moved; the engine *identifier* `"texlive-wasm"` (the `CompileEngine` member, the asset directory names) and the `npx texlive-wasm download-assets` CLI are unchanged. One-time asset fetch, **two destinations** (corrected 2026-07-13): engines to `./public/texlive-wasm` (the worker imports the glue + fetches the wasm by URL, so they must sit on the app origin the CSP allows), the TeX Live tree to `./src-tauri/resources/texlive-wasm` (read off disk via TauriFS). See CLAUDE.md > Commands for the exact invocations.
- `src/providers/compile/texlive-wasm-provider.ts` — wraps `latexmk()` with a lazy `pdflatex` engine handle (`texlive-wasm-assets.ts` owns the engine paths + asset probe). Walks the project tree for `.tex`/`.bib`/`.cls`/`.sty`/`.bst`/`.def`/`.ldf`/`.fd`/`.cnf`/`.clo`/`.aux` plus binary figures (capped 200 files / 10MB), auto-enables BibTeX when any `.bib` is present. Sniffs SyncTeX magic bytes (`1f 8b`) to write either `.synctex.gz` or `.synctex` next to the PDF. Reuses the Rust `parse_latex_log` extractor via `parse_latex_log_cmd`.
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

See `docs/ntb_feature.md` (archival notes on what was removed).

### Phase 4 — Cloud + collaboration — superseded (2026-05-22), remainder dropped (2026-08-03)

Originally deferred 2026-05-13 as "hosted auth + realtime collab + license keys, no Storage". What became of each piece:

- **Third-party cloud storage** landed as **Integ Phase 2** and is live, now with **WebDAV as the sole backend** (Dropbox removed 2026-08-05). Files remain local-first; the sync engine maintains a per-project cache under `<projectsRoot>/.remote-cache/<provider>/<projectId>/` and reconciles remote changes against a per-file sync-state manifest. (OneDrive / Google Drive were built then removed 2026-06-14 — their native desktop sync apps, like Dropbox's, cover the same need via a local folder.)
- **Hosted auth + entitlements** resurfaced as **Integ Phase 7**, shipped 2026-05-23, and was **removed on 2026-08-03** when Typeward went open source. License keys were already retired; now the accounts, tiers, gating and backend are gone too. Nothing here is scheduled to come back.
- **Realtime collab via Yjs** remains separately deferred with no owner phase.

Open design question for any future collab phase: **what does collab look like with no backend at all?** A live-session model (one peer hosts, others join via Yjs awareness/edits, nothing persisted server-side) and bring-your-own-storage via Git or the user's own WebDAV server are the two shapes that fit a local-first, server-less app. The hard architectural problem is unchanged — reconciling a Yjs doc with the local-first file model, since autosave, compile, the watcher and cloud sync all read the file on disk.

**Superseded research (2026-06-10, kept so it isn't re-done blindly):** the postponement decision at the time assumed the hosted backend the app had. It picked that backend's realtime channels as the transport specifically because the server was *already being run for auth* — an argument that no longer holds, so re-evaluate rather than reuse the conclusion. Two findings survive the premise change and are worth keeping:

- **p2p/WebRTC is not "no infrastructure".** Direct peer connections still need a signaling server *and* a TURN relay for restrictive NATs, and offer no persistence when every peer is offline.
- **Yjs message volume is the cost driver, whoever hosts it.** Broadcast traffic bills per recipient (a broadcast to N peers = 1 + N messages) and Yjs is chatty (per-edit plus awareness). Two people debounced to ~10 updates/s is already ~40 msg/s; cost scales with `edits × participants`. Any transport choice has to start from throttling (batched ~150 ms, awareness rate-limited, active-file only) rather than add it later.

If it resumes, presence (who is in the project, who is viewing which file, cursors) is still the cheap first slice — content can keep merging through the already-shipped bidirectional cloud sync.

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
| **Telemetry / error reporting** | Structured local logs for crashes, compile failures, LSP failures; opt-in submission | Phase 1 (capture) → **removed 2026-08-13** (all telemetry/crash reporting deleted; no submission UI ever shipped) |
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
- ~~**Billing / accounts / entitlements** (Integ Phase 7)~~ → **removed from the app 2026-08-03.** In-app billing was scoped out 2026-06-13; the whole account and entitlement layer followed when Typeward went open source under GPL-3.0-or-later. There is no paid tier to gate, no plan to purchase, and no backend to push to. Not a deferred item — a closed one.

Resolved by the integrations program:

- ~~Spell-check engine choice~~ → Harper (Integ Phase 5).
- ~~BibTeX/Zotero integration~~ → Integ Phase 1 (Zotero / Mendeley / DOI lookup shipped; JabRef shipped then removed 2026-06-13).
- Update mechanism (Tauri updater vs app stores) — phase 3+
