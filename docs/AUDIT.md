# Typeward — Full Audit & Modernization (2026-07-29)

Audit of the Tauri 2 + SolidJS app at commit `ac227ef`. Builds on the prior audits recorded in
CLAUDE.md (2026-06-10/11/14, 2026-07-02, 2026-07-13); items those passes fixed or explicitly
deferred are not re-flagged here.

## 0. Reconciliation with the TW-S self-review pass (merged 2026-07-30)

A second, independent audit ran in parallel on another machine (the `fix/tectonic-win-arm64-sidecar`
branch — ARM/Intel build fixes plus the TW-S1/S2/S3 remediations), landed on `main` via PR #4, and
was then merged with this modernization branch. Where both passes touched the same surface, the
merge kept the stronger side:

- **Crash-recovery remount** (H2 / TW-S1-02): kept the TW-S version — it only bumps the editor's
  adopt-generation when recovered content actually differs, avoiding a needless remount.
- **Subprocess bounding** (M1/M2 / TW-S): kept the TW-S structure — pandoc export plans off the
  event loop (`spawn_blocking`) and both pandoc and per-annotation synctex route through the single
  `compile::run_bounded` chokepoint. This branch's parallel `proc::run_bounded_sync` module was
  dropped as a redundant second runner.
- **Pandoc HTML `--embed-resources`**: kept **off** (this branch's decision + module doc rationale):
  on untrusted project content it is an egress + local-file-read channel outside the outbound
  allowlist. This differs from the binary `main` shipped, which passed the flag for a portable
  single file.
- **Annotated-PDF export**: kept the TW-S version — it caps the input PDF size up front (before
  spawning up to 500 synctex processes) and resolves the synctex binary once.
- **CI**: unioned both — this branch's `cargo fmt --check` gate + the TW-S `--locked` clippy gate,
  clippy on every OS leg, and the release artifact renamed per-`matrix.target` (the two macOS legs
  would otherwise collide) while keeping `if-no-files-found: error`.
- **Toolchain**: standardized on the TW-S pin **1.96.0**, recorded in the new
  `src-tauri/rust-toolchain.toml` so local `cargo` and CI agree. harper-core 2.7 still needs the
  vendored `as fn(...)` patch on rustc ≥ 1.93 (verified on 1.96.0).
- **Dependency bumps** present on both (DOMPurify, linkify-it, nanoid, etc.) deduplicated cleanly;
  `npm audit` and `cargo` are clean on the merged tree.

The TW-S pass's own findings table lives in the root [`AUDIT.md`](../AUDIT.md); its per-platform
release steps in [`CHECKLIST.md`](../CHECKLIST.md).

## 1. Inventory

### Repo shape

- **Frontend**: `src/` — SolidJS + TypeScript, 325 files / ~63k LOC, 73 vitest files (jsdom).
- **Backend**: `src-tauri/src/` — Rust, ~17.6k LOC, **113 `#[tauri::command]`s** across 23 files.
  IPC facade in `commands.rs` (37), then `git.rs` (13), `webdav.rs` (6), `history.rs` (6),
  `grammar/mod.rs` (6), `credentials.rs` (5), `compile.rs` (5), rest smaller.
- **Vendored**: `src-tauri/vendor/harper-core` — patched copy of harper-core (rustc ≥1.93 E0308
  build fix; `[patch.crates-io]`). Bumped to **2.7.0** in this pass; the fix is still required
  (verified empirically on rustc 1.94.1 — see §2).
- **Sibling deps**: `../texlive-wasm` (`file:` dep, mobile WASM TeX engine; CI pins commit via
  `package.json config.texliveWasm`), `../infrastructure` (Supabase SQL, separate repo).
- **Configs**: `src-tauri/tauri.conf.json` (+ `tauri.android.conf.json` / `tauri.ios.conf.json`
  overlays), `vite.config.ts` (Rolldown-Vite 8, advancedChunks vendor splitting, Sentry opt-in
  upload), `tsconfig.json` (strict; noUnusedLocals/Parameters, noUncheckedSideEffectImports),
  three capability files (`default`, `desktop` — sidecar shell:allow-execute, `preview` —
  binary-read-only for the detached PDF window).
- **CI**: `.github/workflows/` — `tests.yml` (typecheck + vitest + cargo test on push/PR),
  `build.yml` (manual matrix build), `release.yml` (tag-triggered, signing-enforced, publishes
  drafts to public `typeward/releases`). All actions SHA-pinned; Node 22/24 runners.

### Exact versions (locked, 2026-07-29)

| Layer | Package | Locked |
|---|---|---|
| Rust toolchain | rustc / cargo | 1.94.1 (no rust-toolchain.toml; edition **2021**) |
| Tauri core | tauri / tauri-build / wry / tao | 2.11.1 / 2.6.1 / 0.55.1 / 0.35.2 |
| Tauri CLI/API (npm) | @tauri-apps/cli / api | 2.11.3 / 2.11.1 |
| Plugins (Rust=npm) | fs 2.5.1, dialog 2.7.1, opener 2.5.4, updater 2.10.1, process 2.3.1, clipboard-manager 2.3.2, shell 2.3.5 (Rust-only, sidecar exec — **no npm pkg, correct**), single-instance 2.4.2, window-state 2.4.1 | |
| Frontend core | solid-js 1.9.13, @solidjs/router 0.16.1, vite 8.0.16 (Rolldown), vite-plugin-solid 2.11.12, typescript 6.0.3, vitest 4.1.9, tailwindcss 4.3.1 | |
| Heavy vendors | pdfjs-dist 6.0.227, @codemirror/view 6.43.4 (+9 sibling pkgs), katex 0.17.0, markdown-it 14.2.0, dompurify 3.4.11, @sentry/browser 10.63.0, @supabase/supabase-js 2.108.2, @kobalte/core 0.13.11, corvu 0.7.2, lucide-solid 1.21.0 | |
| Rust deps | reqwest 0.12.28 (+0.13.4 via plugin-updater), keyring 3.6.3, axum 0.8.9, git2 0.20.4 (libgit2 1.9.3), zip 2.4.2 direct (+4.6.1/7.2.0/8.6.0 transitive), harper 2.5.0 (vendored), quick-xml 0.41.0 (+0.39.4 via wayland-scanner, Linux build-time only), sentry 0.46.2 (pinned), lopdf 0.43.0, notify 8.2.0, tokio 1.52.3, which 7.0.3, rustls 0.23.40 | 930 crates total |

### Platforms & release

- **Desktop** Win/macOS/Linux: shipping path. NSIS-only on Windows; dmg+app.tar.gz on macOS;
  deb/appimage/rpm on Linux. Updater dormant (empty pubkey, `createUpdaterArtifacts:false`);
  release.yml enforces signing unless `allow_unsigned` is set; SHA256SUMS + provenance
  attestation on every asset.
- **Android**: scaffolded (`gen/android`), **never built** (openssl-sys via git2 — since gated
  off mobile; keyring hard-errors by design). **iOS**: untouched.
- Sidecar: Tectonic (desktop, per-host fetch). Mobile TeX: texlive-wasm assets (two-destination
  layout, mobile-only bundling via config overlays).

### Architecture (summary — full detail in CLAUDE.md)

Provider-based integrations substrate (citations/cloud/AI/grammar/templates) behind entitlement
gates; hand-rolled LSP-over-Tauri-events CM6 binding; single notify-based watcher; debounced
autosave + snapshot recovery; local-first cloud sync engine (Dropbox/WebDAV) with per-file
rev/hash sync-state; visual editor v3 (hidden-source WYSIWYG StateField over verbatim source);
strict CSP with build-spliced Supabase origin; main-window-only privileged IPC
(`ipc_guard.rs`); registered-roots gate on all project IPC.

Modules newer than the last CLAUDE.md refresh (flagged for doc drift, §3): `history.rs`
(project history, gzip content-addressed blobs), `export_annotated.rs` (lopdf annotation
export), `export_pandoc.rs`, `todo_scan.rs`, `trust.rs` (shell-escape trust grants),
`grammar/config.rs`, `@codemirror/merge`, harper 2.x + vendor patch.

### Local scanner results (2026-07-29)

- **`npm audit`**: 4 advisories — dompurify ≤3.4.11 (moderate; `CUSTOM_ELEMENT_HANDLING`
  bypass, GHSA-c2j3-45gr-mqc4 — we don't pass `CUSTOM_ELEMENT_HANDLING`, still upgrading),
  linkify-it ≤5.0.1 (high DoS, GHSA-v245-v573-v5vm, via markdown-it), postcss ≤8.5.17
  (high, dev-only via Tailwind), brace-expansion (high DoS, dev-only).
- **`cargo audit`**: 3 vulnerabilities — ammonia 4.1.3 XSS (RUSTSEC-2026-0213, via vendored
  harper-core; harper output renders as text in CM6 lint UI, not an HTML sink here — still
  upgrading to 4.1.4), quick-xml 0.39.4 ×2 high DoS (RUSTSEC-2026-0194/0195) — reached only
  by `wayland-scanner`, a Linux build-time proc-macro parsing trusted vendored XML; not
  exploitable, bumped anyway. Plus unmaintained/unsound warnings (gtk3-rs bindings via tao —
  inherent to Tauri Linux; git2 unsound advisories RUSTSEC-2026-0183/0184 in APIs we don't
  call — `Remote::list`, `BlameHunk`).
- **`npm outdated`**: minors across the board; majors available for @solidjs/router (1.0.0),
  katex (0.18.1), nanoid (6), typescript (7.0.2), jsdom (30).

## 2. Research findings (verified against official sources, 2026-07-29)

Six parallel research passes against crates.io / npm registry / GitHub releases / RUSTSEC / GHSA.
Full structured output archived in the session workflow journal; condensed here. **Bold = acted on
in this pass** (see §3 status column and UPGRADE_NOTES.md).

### Security-relevant (fix now)

| Subject | Ours | Fix | Detail |
|---|---|---|---|
| **libgit2 (via libgit2-sys)** | 1.9.3 | `cargo update -p libgit2-sys` → 0.18.7+**1.9.6** | libgit2 1.9.5 fixed CVE-2026-53583 (inverted SAN check, OpenSSL backend), **CVE-2026-53584 (submodule path traversal — our clone flow takes untrusted repos)**, CVE-2026-53585 (delta-header alloc DoS), **CVE-2026-53586 (auth callback receives wrong host after redirect — keyring `git.<host>` scoping)**, CVE-2026-53587 (heap OOB read). No RUSTSEC entry yet, so `cargo audit` is silent — found via release notes. git2 0.20.4 accepts ^0.18.3, zero code changes. ([libgit2 releases](https://github.com/libgit2/libgit2/releases)) |
| **nanoid** | 5.1.14 | → 5.1.16 | GHSA-28wg-ghj8-5hjv (high, 2026-07-29): infinite-loop DoS on negative size; we pass fixed sizes (low practical exposure) but in-range. |
| **dompurify** | 3.4.11 | → 3.4.12 | GHSA-jxrp-r7gx-q4j8 + GHSA-c2j3-45gr-mqc4: `CUSTOM_ELEMENT_HANDLING` hook bypass. We don't use custom-element handling (grep-verified) — patch anyway. |
| **ammonia (transitive, vendored harper)** | 4.1.3 | `cargo update -p ammonia` → ≥4.1.4 | RUSTSEC-2026-0213 XSS via SVG animate/set. Harper output is text-rendered in CM6 lint UI (no HTML sink here). |
| **linkify-it (via markdown-it)** | ≤5.0.1 | markdown-it → 14.3.0 | GHSA-v245-v573-v5vm high DoS (`mailto:` scan loop) — `.md` preview linkifies untrusted text. |
| **quick-xml 0.39.4 (transitive)** | via wayland-scanner | `cargo update` | RUSTSEC-2026-0194/0195 (high DoS) — reached only by a Linux build-time proc-macro parsing trusted XML; not exploitable, bumped for audit silence. Our attacker-facing direct dep is already on patched 0.41.0 (load-bearing for WebDAV — keep the floor). |
| postcss / brace-expansion (dev-only) | — | `npm audit fix` | High-severity advisories in dev-tree only (Tailwind chain). |
| Rust toolchain | 1.94.1 | `rustup update` → 1.97.1 | cargo CVE-2026-5222/5223 (third-party registries — we use crates.io only, low exposure) fixed in 1.96; 1.97.1 backports an LLVM miscompilation fix. Also: harper upstream tracks latest stable. |

### Version currency (stable-line upgrades, no migration risk)

- **Tauri**: core 2.11.1 → **2.11.5** (patch line: scope/listener deadlock prevention, Windows HDC
  handle leak fix — perf on our ship platform; async custom-protocol handler loading). tauri-build
  → 2.6.3, CLI → **2.11.4** (AppImage relative-symlink fix — we ship AppImage), dialog → 2.7.2
  (Android-only fix), single-instance → 2.4.3 (macOS tokio listener), tao → 0.35.3. wry 0.55.1 is
  current. fs/opener/updater/process/clipboard/window-state all already latest. GHSA-7gmj-67g7-phm9
  (origin confusion, Win/Android) was patched in 2.11.1 — we were already safe; **keep the ≥2.11.1
  floor forever**.
- **Frontend minors**: solid-js 1.9.14, vite 8.1.5, vitest 4.1.10, vite-plugin-solid 2.11.14,
  tailwind 4.3.3, supabase-js 2.111.0, @sentry/browser 10.69.0, @sentry/vite-plugin 5.4.0,
  markdown-it 14.3.0, kobalte 0.13.12, lucide-solid 1.27.0, pdfjs-dist 6.2.108 (only api-minor
  change: `getDestinations`/`getViewerPreferences`/`getOpenAction` return `Map` — grep-verified
  unused), CodeMirror drift (view 6.43.7, state 6.7.1, commands 6.10.4, language 6.12.4,
  lang-markdown 6.5.1), codemirror-vim 6.4.0, fontsource 5.3.0.
- **Rust minors via `cargo update`**: tokio 1.53.1, plus the security rows above.

### Majors / migrations (each a deliberate step)

- **@solidjs/router 0.16.1 → 1.0.0** — changelog states functionally identical to 0.16.x, no
  breaking changes (stability declaration alongside SolidStart 2.0). Requires explicit range bump.
- **harper 2.5.0 → 2.7.0** — bumped to 2.7.0. The research suggested this might let us delete the
  vendor patch, but **empirical test on rustc 1.94.1 shows 2.7.0 still fails with the same E0308
  fn-item-array class** (4 sites), so `vendor/harper-core` + the `[patch.crates-io]` block STAY,
  re-created at 2.7.0. (harper's CI fixed 1.97 *clippy* warnings, not this hard error.)
- **zip 2.4.2 → 8.x** — our usage (ZipWriter::start_file/deflate; ZipArchive by_index) is stable
  across 3–8 per changelog; MSRV 1.88 (met after toolchain bump). Removes one of four zip copies
  (harper pins 8.6.0). 9.0 is prerelease — do not take.
- **sentry 0.46.2 unpin → 0.48.5** — 0.48.2 added `rustls-no-provider` exactly for the aws-lc
  hazard; our lock already proves reqwest 0.13 + ring works (tauri-plugin-updater). Change feature
  `rustls` → `rustls-no-provider`, verify `cargo tree -i aws-lc-sys` is empty. 0.49.0 (released
  literally today) has breaking ClientOptions changes — skip.
- **git2 0.20 → 0.21** — clears RUSTSEC-2026-0183/0184 (unsound, in APIs we don't call). Accessor
  return types changed (`Option<&str>` → `Result<...>`) — mechanical edits in `vcs/git.rs`.
- **TypeScript 6.0.3 → 7.0.2** — TS 7 GA 2026-07-08 (native Go tsc, ~8–12× faster; no type-system
  changes; 6.x is a frozen line, there is no 6.1). We use tsc CLI only (no compiler-API consumer).
  tsconfig already 7-compatible on inspection. Attempt on a branch, fall back to ~6.0.3.
- **katex 0.17 → 0.18.1** — BREAKING minor (internal CSS class prefixes changed); audit theme CSS
  for KaTeX-internal selectors first. Deferred to its own pass.
- **Edition 2021 → 2024** — recommended for new code, mechanical via `cargo fix --edition`;
  rustc already ≥1.85. Do as a dedicated commit.
- **jsdom 29 → 30** — needs Node ≥22.22; CI uses Node 22 line, dev host 24. Bundle with a Node
  floor decision.
- **keyring 3 → 4** — architecture rework, June–July release churn + a yanked release; v3 data
  forward-compatible. **Stay on 3.6.3** (needs-decision later; re-verify the 2560-byte-cap and
  ensure_secure_storage behaviors if migrating).
- **nanoid 6, notify 9-rc, tao 0.36, reqwest 0.13 (direct), lopdf 0.44, which 8** — defer (majors
  with no security need / prerelease / out of tauri's range).

### Platform + practices

- **Windows floor**: effectively Win10 1803+ (WebView2 109 was the last Win7/8 build and is
  unserviced) — say that in user-facing copy, not "Windows 7".
- **Linux**: webkit2gtk-4.1 floor = Ubuntu 22.04/Debian 12. **Release AppImage leg should build on
  ubuntu-22.04** — an AppImage from 24.04 links glibc 2.39 and won't run on 22.04-era systems
  (deb/rpm from 24.04 are fine for their targets). Currently release.yml uses ubuntu-24.04 →
  actionable finding.
- **macOS**: bundle default minimumSystemVersion 10.13; dev 10.15+. No action.
- **Android** (dormant): current CLI template = AGP 8.11 / Gradle 8.14.3 / SDK 36 / minSdk 24;
  regenerate `gen/android` before the first real APK attempt. Play policy needs API 36 by
  2026-08-31 if store distribution ever happens. Keyring remains the hard blocker by design.
- **iOS** (untouched): config default minimum 14.0 — accept when work starts.
- **Tauri security guidance**: no new official guidance in 2025/26; our posture (per-window
  capabilities + ipc_guard beyond-docs hardening) matches or exceeds it. Isolation pattern is
  "highly recommended" upstream but has real costs (no ES modules, inline-script build step);
  logged as needs-decision, not adopted now.
- **CSP style-src 'unsafe-inline'**: stays. Verified: KaTeX HTML output hard-requires inline style
  *attributes* (KaTeX #4096), CSP nonces don't apply to attributes, Tauri has no per-load nonce
  infra, and Tauri's own example CSP ships it. Script-src remains the real boundary and stays
  strict.
- **SolidJS practice**: current lazy-route + boot-budget pattern matches official guidance;
  createAsync/createResource split is a Solid 2.0-era concern (2.0 still beta — do not migrate).
- **Release profile**: ours matches Tauri's official size recommendation verbatim. No change.

## 3. Audit findings

Produced by an 8-dimension multi-agent audit (security, correctness, SolidJS reactivity, visual
editor, performance, build/CI, hygiene, security-invariant drift), each finding adversarially
re-verified against the code by an independent agent. 58 raw findings → 56 confirmed → deduplicated
to the unique findings below. Items CLAUDE.md documents as fixed/deferred were excluded up front.

Status: **fixed** (this pass), **deferred** (documented, lower value or risk), **needs-decision**
(yours).

### High

| # | Location | Finding | Status |
|---|---|---|---|
| H1 | `commands.rs:664` `import_files_into_project` | Renderer-supplied absolute `source_paths` are copied into the project with only the *destination* gated. A compromised renderer (XSS is in the threat model) can copy `~/.ssh/id_rsa` into the project, then read it back via `read_project_text_file` — an arbitrary-file-read/exfil escalation beyond the deferred finding-30 write breadth. | **fixed** — Rust now records OS-delivered drag-drop paths in a TTL allowlist; import sources must be in it or the fs runtime scope. |
| H2 | `editor-store.ts:210` `restoreFileContent` | Replaces an open buffer without bumping `adoptGeneration`, which is part of the editor mount key (`text-shell.tsx:978`). The mounted CodeMirror never remounts, so crash-recovered content sits in the store invisibly and is overwritten by the next edit/save — recovery silently fails for the common case (root file already open). | **fixed** — bump `adoptGeneration`. |

### Medium

| # | Location | Finding | Status |
|---|---|---|---|
| M1 | `export_pandoc.rs:68` | Pandoc spawned via raw `Command::output()` — no timeout, no output cap, no tree-kill, no cancel; violates the documented `run_bounded` invariant. Pandoc's LaTeX reader does macro expansion, so pathological project content → hung blocking-pool thread (never resolves, no cancel) or unbounded-stderr OOM. | **fixed** — routed through a shared bounded runner. |
| M2 | `overleaf.rs:95` `overleaf_import_zip` | Renderer-supplied absolute `zip_path` read with no gate — arbitrary read of any ZIP-shaped file, extracted into a readable new project. | **fixed** — gated on the fs runtime scope (the dialog that picks the zip already adds it). |
| M3 | `trust.rs:99` `shell_escape_trust_set` | The only confirmation for granting per-machine shell-escape trust lives in TypeScript; a compromised renderer can call the IPC with `"granted"` directly, unlocking `\write18` arbitrary program execution at compile. | **fixed** — the grant path now requires a native Rust confirmation dialog the renderer can't fabricate. |
| M4 | `release.yml` | The release build job never runs the app's `npm ci`; `tauri-action` does not install project deps, so `beforeBuildCommand` (`npm run build`) fails — every release leg is broken. | **fixed** — added an explicit `npm ci` + sibling build step. |
| M5 | `VisualPopover.tsx:96` | The visual-edit popover survives an active-file switch; `Apply` then writes into whichever editor view is now active — potentially a *different file*. | **fixed** — popover intent is cleared on active-file change and Apply re-validates the target. |
| M6 | `edit-guards.ts:588` / `:658` | Enter-split inserts wrapper markup at the caret without accounting for enclosing nested constructs; `escapeInput`/`enterContext` only inspect top-level blocks, so verbatim/lstlisting nested in a transparent env gets prose auto-escaping — typed specials corrupted / invalid LaTeX. | **deferred** — real but narrow (nested-verbatim edit); needs parser-context threading; documented for a focused visual-editor pass to keep the equivalence test honest. |
| M7 | `field.ts:111/117/128` | Every keystroke does `tr.newDoc.toString()` (O(doc) flatten) **and** a full decoration rebuild, defeating the incremental parser's latency bound; a budget abort maps all decorations away and paints the whole file as raw source until idle reparse. | **deferred** — real perf ceiling on large docs; the rebuild path is guarded by the pinned `updateDoc≡full-reparse` property test, so a safe fix is a dedicated change. Documented with a plan. |
| M8 | `CLAUDE.md:332` "deliberately deferred" | Claims pandoc export + PDF annotation flattening are unbuilt; both shipped (`export_pandoc.rs`, `export_annotated.rs`). Plus history/trust/todo modules undocumented. | **fixed** — CLAUDE.md updated. |

### Low (grouped; representative locations)

**Security-adjacent**
- `export_annotated.rs:101` — up to 500 unbounded `synctex` subprocesses over attacker data → **fixed** (bounded runner + count already capped).
- `export_pandoc.rs:64` — HTML export uses `--embed-resources` (unallowlisted network/local-file embedding) → **fixed** (dropped `--embed-resources`; documented).
- `menu-bridge.ts:92` — `menu:command` listener runs *any* CommandRegistry id from an app-wide Tauri event, giving the ipc_guard-restricted preview window a command channel → **fixed** (allowlist to `MENU_COMMAND_IDS`).
- `templates.rs:27` / `overleaf.rs:29` — `TemplateError`/`OverleafError` returned as serialized enums, violating the IPC-error-contract invariant (user sees JSON/variant) → **fixed** (`.to_string()` at the boundary).
- `templates.rs:321` `collect_template_walk` — unbounded recursion over attacker trees (hostile clone → stack-overflow abort on export/capture) → **fixed** (depth cap).
- `desktop.json:9` `shell:allow-execute` — grants the renderer a sidecar-spawn primitive no frontend uses, with a stale arg validator → **fixed** (removed; sidecar spawns Rust-side).
- `compile.rs:823/1021/1203/1322` — five direct `which::which` calls bypass the `detect::resolve_program` chokepoint the invariant names (property still holds — resolved absolute path is spawned — but drift) → **fixed** (routed through `resolve_program`).

**Correctness**
- `history.rs:451/508` — readers run without the per-project mutex; a concurrent record's prune+GC can delete a blob mid-read → **fixed** (map missing-blob to a friendly "just pruned" error).
- `history.rs:296` — forced restore snapshot bypasses `MAX_SNAPSHOT_BYTES` and reads the whole file into memory → **fixed** (generous forced ceiling).
- `grammar/mod.rs:174` — five dictionary/ignore commands are sync `#[tauri::command]`s doing fsync'd writes on the main thread → **fixed** (async + spawn_blocking).
- `grammar/mod.rs:123` — curated `LintGroup` + merged dictionary rebuilt on every `grammar_check` → **fixed** (cached).
- `EditorSidebar.tsx:195` `isGitRepo` — resource keyed only on rootPath, never refetches; a repo made while open never surfaces the SCM tab → **fixed** (refetch on git-state signal).
- `todo-store.ts:22/25` — whole-project TODO disk rescan after every save even with no TODO surface open, and serves the previous project's items during the new scan → **fixed** (gate on panel open; key resource on project).
- `EditorScreen.tsx:365` — window-title effect fires `setTitle` IPC on every keystroke → **fixed** (only on title-affecting deps).
- `CodeMirror.tsx:339` — full `doc.toString()` into the store on every keystroke → **deferred** (store contract; changing it ripples through save/compile/visual — measured cheap for typical docs).
- Visual editor low-severity rendering: bare `~` renders as literal tilde (`scan-inline.ts:281`) → **fixed**; minted `{lang}` paints raw (`scan-blocks.ts:540`) → **fixed**; `docBegin`/`docEnd` delete-to-EOF removes only `\end{document}` (`decorations.ts:421`) → **fixed** (shared closure); stale search offsets throw (`search.ts:126`) → **fixed**; Apply snapshot relocation takes first ±2000 occurrence (`VisualPopover.tsx:121`) → **fixed** (nearest); `image.ts:130` O(doc) boundary → **deferred** (micro).

**Build/CI**
- `tests.yml` — no `cargo clippy`, no `cargo fmt --check`, no ESLint/Prettier anywhere → **fixed** (added gates + configs).
- `tests.yml:163` — Rust tested on Linux only; all `#[cfg(windows)]` paths never compile pre-release → **fixed** (added a Windows cargo-test leg).
- `release.yml:299` — no gate that the git tag matches the built app version → **fixed** (version-match step).
- `release.yml:124` — release floats on moving `stable` Rust → **fixed** (pinned via `rust-toolchain.toml`).
- `release.yml:267` — `if-no-files-found: ignore` silently drops a platform on a stale glob → **fixed** (`error`).
- Action pins behind majors (tauri-action, setup-node, checkout, attest) → **fixed** where safe (documented in UPGRADE_NOTES).
- npm cache key omits the sibling lockfile → **fixed**.
- macOS Intel leg absent → **needs-decision** (see §3.1).

**Hygiene**
- `.gitignore` gaps: committed `tsconfig.tsbuildinfo`, `supabase/.temp/linked-project.json`, `.claude/` only in global ignore, `src-tauri/.gitignore` ignoring all of `gen/` (Android scaffold can't be committed) → **fixed**.
- `ipc/index.ts` — 12 dead frontend exports incl. 5 IPC wrappers with zero callers → **deferred** (dead-export pruning across a 325-file tree is low value and non-trivial risk without a `knip`/`ts-prune` gate; logged for a dedicated hygiene pass).
- No linter/formatter while three files carry `eslint-disable` for a linter that can't run → **partly fixed / needs-decision**: `.editorconfig` added. ESLint deferred (eslint 9 reintroduces an unfixable dev-only `brace-expansion` advisory; eslint-plugin-solid caps eslint at 9). Prettier deferred (293/326 files disagree with its defaults — a maintainer-owned mass-reformat decision). See UPGRADE_NOTES "Tooling not adopted".
- `src-tauri/.gitignore` ignoring all of `gen/` → **deferred (deliberate)**: committing the never-built Android scaffold is premature (Phase 3 gated); revisit when a device build actually succeeds.
- `VisualPopover.tsx:153` — `role=dialog` with no focus containment / `aria-modal` → **fixed** (`aria-modal` added; a Tab focus-trap is intentionally NOT added — the popover hosts a CodeMirror mini-editor where Tab must indent, so trapping Tab would break editing; Escape-to-close and focus-return-to-view are in place).

### 3.1 Needs-decision

Resolved in the 2026-07-30 follow-up pass (after the two-audit merge):

- **macOS Intel (x86_64) release leg** — ✅ **done**: main's PR #4 added the `macos-13`
  x86_64-apple-darwin leg (artifact named per `matrix.target` so it doesn't collide with arm64).
- **katex 0.17 → 0.18** — ✅ **done**: 0.18's CSS-class prefixing doesn't touch `.katex-display`
  (our only override) or the base classes; we ship the version-matched CSS. Verified.
- **sentry unpin → 0.48.5** — ✅ **done, without the aws-lc hazard**: the pin's real cause was
  sentry's `rustls` feature (rustls-with-aws-lc-rs → cmake/NASM). Dropping it and keeping only
  `reqwest` gives sentry a reqwest 0.13 transport on ring-based rustls-tls. No aws-lc, no native-tls.
- **git2 0.20 → 0.21** — ✖ **reassessed, NOT taken**: 0.21 is a breaking API migration
  (`shorthand()`/`summary()` flipped `Option`↔`Result`, plus deprecations) across ~8 sites in the
  security-critical git auth/push code, for ~zero benefit — it only silences an *unsound* cargo-audit
  warning about `blame_buffer`, an API we never call, and CI's RustSec gate already passes on 0.20.
  Not worth the regression surface. Revisit if the advisory ever escalates to a vulnerability.
- **"Windows 7" OS-floor copy** — moot: no stale "Windows 7" string exists in any user-facing surface.

Still open (opt-in migrations, no security angle): **Edition 2021 → 2024**, **TypeScript 6 → 7**,
**jsdom 30 / Node floor**, **keyring 3 → 4** (touches the credential layer — highest risk),
**zip → 8**, **Tauri Isolation Pattern adoption**. The Linux release AppImage leg should still move
to ubuntu-22.04 for the glibc floor.

## 4. Verification

All gates run on this host (Windows 11, rustc 1.94.1, Node 24) after the fix pass:

| Gate | Result |
|---|---|
| `cargo fmt --check` | **pass** (no diff) |
| `cargo clippy --all-targets -- -D warnings` | **pass** (0 issues; 4 pre-existing warnings fixed so the new CI gate holds) |
| `cargo test` | **pass** — 262 passed, 0 failed, 1 ignored |
| `cargo build --release` (LTO profile) | **pass** (verified via true cargo exit code, not a pipeline's) |
| `cargo audit` | 3 advisories remain, all triaged: quick-xml 0.39.4 ×2 (Linux build-time only, dated ignore in CI) + ammonia now patched; the libgit2 CVE cluster is cleared |
| `tsc --noEmit` (typecheck) | **pass** |
| `vitest` | **pass** — 576 passed (was 575; +1 new menu-bridge allowlist test) |
| `npm run build` (Rolldown/Vite 8.1) | **pass** |
| `npm run check:bundle` (boot budget) | **pass** — 2 boot chunks, 33 KB boot JS, heavy vendors lazy |
| `npm audit` | **0 vulnerabilities** |

### Per-platform notes

- **Windows (host)**: fully built + tested here. The CI Cargo job now also runs on
  `windows-latest`, so `cfg(windows)` paths (compile tree-kill via `taskkill /T`, credential
  blob chunking) compile and test in PR CI for the first time.
- **Linux**: not built here. CI covers it (ubuntu-24.04). Release AppImage leg should move to
  ubuntu-22.04 (glibc floor) — logged, not yet changed pending the OS-floor decision.
- **macOS**: not buildable on this host (no macOS runner). CI covers the build; signing/notarization
  path unchanged. Manual smoke-test one installer per the release runbook.
- **Android/iOS**: unchanged (Phase 3 gated; Android still blocked on keyring, iOS untouched).

### What was deliberately NOT changed (with reasons)

- **harper vendor patch** — kept (harper 2.7.0 still hits E0308 on the pinned toolchain).
- **ESLint / Prettier** — not adopted (dev-advisory reintroduction / 293-file mass reformat; see §3
  + UPGRADE_NOTES). `.editorconfig` added.
- **Dead frontend exports, `gen/` gitignore, CodeMirror per-keystroke store write, visual-editor
  field-rebuild perf, nested-verbatim edit guards** — deferred with rationale in §3 (risk vs value,
  or touches the property-test-guarded parser).
- **git2 0.21, sentry unpin, zip 8, TS 7, katex 0.18, edition 2024, jsdom 30, keyring 4,
  Isolation Pattern, macOS Intel leg, OS-floor copy** — needs-decision / opt-in migrations (§3.1,
  UPGRADE_NOTES). The security-relevant subset was low-risk-checked; none is a blocker.

### Manual verification still recommended

- Launch `npm run tauri dev` and smoke-test: crash-recovery adopts recovered content (H2); the
  visual-edit popover closes on a file switch and Apply targets the right file (M5); a drag-dropped
  file still imports but a fabricated path is rejected (H1); shell-escape shows exactly one native
  confirmation (M3); pandoc export completes/aborts cleanly (M1).
- One installer per OS from a release dry-run (the `npm ci` fix means every leg now installs deps).
