# Typeward

Multiplatform editor for LaTeX and Typst, in the spirit of Overleaf but fully local, with live `.md` preview. Tauri 2 + SolidJS + TypeScript, Rust backend. Targets desktop (Windows/macOS/Linux) and tablets (iPadOS, Android tablets; no phones).

**Fully local by design**: no account, no backend, no paid tier. Third-party services (Zotero, WebDAV, git remotes, AI providers) are optional integrations the user wires up with their own credentials. Real-time collaboration is a future phase.

**License: MIT with the Commons Clause** (source available, NOT OSI open source: the clause withholds the right to Sell, so do not describe the project as open source and do not expect OSI-only package repos to carry it). `THIRD-PARTY-NOTICES.md` covers the third-party components. Nothing is vendored today, so every dependency resolves from its registry at build time. Anything newly vendored needs a notices entry and its license text kept alongside the source.

## Commands

```bash
npm run tauri dev            # full app (Vite + Rust + window)
npm run build                # tsc + vite build (hermetic, no network)
npm run tauri build          # native bundle
npm test                     # vitest
npm run typecheck            # tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml

npm run fetch:tectonic       # per-host: Tectonic sidecar into src-tauri/binaries/ (gitignored)
npm run release -- <x.y.z>   # bump every version source, commit, tag. Add --dry-run to preview
```

Use **npm**, never pnpm or yarn.

Two per-host gotchas. `fetch-tectonic.mjs` downloads the **musl** static binary while Tauri looks up the rustc target triple, so on Linux symlink `gnu` to `musl` in `src-tauri/binaries/` if the build complains; the static binary runs fine on glibc. And `npm run capture:hero` drives the live app over CDP and photographs it **as configured**, so anything switched on that ships off by default (grammar lint especially) lands in the README image. It needs the app running with the debugger exposed, which is why CI cannot do it.

## Hard rules

- **No gating, ever.** There is no entitlement layer, tier check, sign-in, or billing surface. Do not add one, and do not write code that branches on "is this user allowed".
- **No telemetry, crash reporting, error submission, or usage tracking of any kind.** All of it was removed deliberately, and the CSP has no external origins. Do not reintroduce any part of it. `recordError` is a local `console.error` wrapper, nothing more.
- **No emojis** in code, files, or commit messages unless asked.
- **No em dashes** in user-facing text: README, repo docs, UI strings, and Rust error messages shown to users. Use commas, colons, semicolons, or parentheses. Notes written before 2026-08-14 still carry them.
- **No `Co-Authored-By:` trailers** on commits. The local git identity is the user.
- **No new docs or README files** unless requested.
- **Comments explain why, not what**, and only when non-obvious. Do not reference tasks, PRs, or callers in comments.
- **Plan mode first for changes under `src-tauri/`.** Every `#[tauri::command]` is a security boundary and the invariant list is long, so the plan is where a scope mistake is still cheap to catch.
- **Verify, do not assert.** This project has repeatedly shipped bugs that exist only in the release bundle or only on one platform. Prefer running the thing over reasoning about it, and say plainly when you did not run it.
- **Kobalte** for a11y primitives (Dialog, Popover, DropdownMenu, Tooltip, Tabs, Switch, Combobox, Toast), not shadcn/solid-ui, whose aesthetic conflicts with the glass design.
- **Never run `npx tauri icon`.** It discards the optically-sized builds that are the source of truth. See the `icons` skill.

## Layout

| Path | What lives there |
| --- | --- |
| `src/adapters/` | Per-format glue (`EditorAdapter`): LaTeX, Typst |
| `src/commands/` | Command registry, keyboard router, save/compile orchestration |
| `src/integrations/` | Third-party substrate: references, cloud, AI, grammar, templates |
| `src/lib/` | Cross-cutting: LSP client, autosave, watcher, visual editor, errors |
| `src/screens/`, `src/components/` | Screens and UI, including the editor shells |
| `src/stores/` | Solid signal stores |
| `src-tauri/src/` | Rust: IPC commands, compile, LSP host, security boundaries |
| `bench/` | Long-document benchmark harness (see `bench/README.md`) |
| `scripts/` | Build, release, and test-harness scripts |

Deeper notes load automatically when you work in these directories: `src/CLAUDE.md`, `src-tauri/CLAUDE.md`, `src/integrations/cloud/`, `src/integrations/references/`, `src/lib/visual/`. **Read the one for the area you are changing before changing it**; they carry the invariants that no test enforces.

Maintainer-only skills (machine-local, absent from a fresh clone): `release` for cutting a version and the updater feed, `icons` for regenerating the icon kit, `project-history` for when and why something shipped or was removed.

Subagents in `.claude/agents/` (committed; the rest of `.claude/` is machine-local). All three are read-only and report rather than edit:

| Agent | Use it for |
| --- | --- |
| `release-verify` | Driving a built release bundle over CDP. Release-only breakage (CSP nonce injection, minification, chunk splitting) cannot reproduce under `tauri dev`, so this is the only check that catches it. Wraps `npm run verify:release`. |
| `rust-security-audit` | Auditing a diff under `src-tauri/` against the invariants in `src-tauri/CLAUDE.md`. |
| `doc-drift` | Checking whether the claims in the `CLAUDE.md` files still match the code. |

## Local trees

`design_files/` is **repo content** as of 2026-09-03 (previously gitignored). It holds the HTML/CSS/JS prototypes and is the **source of truth for visuals**: read the source, do not render it in a browser, and treat JSX as React reference only, porting to idiomatic Solid. It is still untracked pending a first `git add`, so a fresh clone will not have it until that lands.

`design/`, `docs/` and `plan.md` remain gitignored notes on the maintainer's machine, **not repo content**. Most sessions and every fresh clone will not have them, so check before citing one and never make a task depend on reading one. Never commit them and never `git add -f` them. When absent, the shipped code plus these `CLAUDE.md` files are the source of truth: say so rather than guessing at what a spec would have said. `design/` holds the living UI/UX specs and should be updated alongside any visible change.

## Cross-cutting traps

- **Sync Tauri commands run outside the tokio runtime.** Calling `tokio::spawn` from a sync `#[tauri::command]` panics and aborts the process. Mark anything touching tokio `pub async fn`.
- **The Linux CI runner is the BUILD BASE, not the support list.** `build.yml` and `release.yml` build on `ubuntu-22.04` on purpose: glibc is forward-compatible only, so building on the oldest viable image is what makes the artifacts run on the widest range of distros (glibc 2.35+), and 22.04 is also the Tauri v2 floor. **Never bump these legs to a newer image for tidiness**: that raises the floor and silently drops older distros, and no test catches it. GitHub removes the runner 2027-04-17; move to a pinned `ubuntu:22.04` container then.
- **ARM64 builds ship without the Tectonic sidecar**, by decision, because upstream publishes no aarch64 Windows binary. Those legs pass `--config src-tauri/tauri.no-tectonic.conf.json`. `detect.rs::probe()` exposes `tectonic_bundled` and onboarding copy branches on it, so do not reintroduce an unconditional "bundled with Typeward" claim.
- **The auto-updater's install call does not return on Windows.** The plugin calls `std::process::exit(0)` inside `downloadAndInstall`, so anything that must survive the swap has to be flushed *before* it, on every platform. Releases publish to this repo, which must stay public for the feed to resolve. Full contract in the `release` skill.
- **Engines are user-installed.** TeX distributions, Typst, and pandoc are detected on PATH, not bundled. Tectonic is the one historical exception, shipped as a sidecar on non-ARM desktop.
- **Themes** swap via `<html data-theme>` and `<html data-accent>`. Exactly four ship: **Daylight** (default, light), **Lamplight** (dark), **Aurora**, **Paper**. Per-theme `--syntax-*` tokens drive CodeMirror colors. User custom themes are JSON validated in `themes.rs` and layered over a built-in base.
- **Out of scope**: Jupyter `.ipynb`, Quarto, R Markdown, and Markdown-as-project. Do not add them back.

## Known gaps, deliberately open

Do not re-flag these as findings.

- Cloud sync: the two-sided-conflict winner is still mtime-based, though the loser is always preserved as a `.conflict-*` sidecar.
- Renderer cloud/FileTree/PdfViewer IO still reaches plugin-fs with project-root breadth rather than routing through the registered-root-gated custom IPC. Mitigated structurally by the branded `NormalizedRelPath` funnel.
- Struct-field-level TS/Rust type drift needs codegen; only command *names* are guarded, by `src/ipc/drift.test.ts`.
- Duplicate `autocompletion()` config between the base editor config and the LSP extension.
