# Typeward — Audit & Remediation

Tauri v2 (Rust) + SolidJS (TS) multiplatform editor. Targets: Windows 10+, macOS 12+,
Linux (X11+Wayland), Android/iOS tablets.

Audit started: 2026-07-25 · Branch: `fix/tectonic-win-arm64-sidecar` · Auditor: Claude (Opus 4.8)

> **Post-audit change of premise (2026-08-03).** Typeward went open source under
> **GPL-3.0-or-later** with **no paid tier, no accounts, no entitlement gate and no
> backend**. Findings below that lean on tier language ("Pro-gated", "free-tier
> binaries") are unaffected in substance but changed in framing: the features they
> describe are now available to every user, which *raises* the share of users who
> pay a given cost rather than lowering it. See the annotations on TW-S2-04 and
> TW-S2-10. The deleted modules (`src/integrations/supabase/`,
> `src/integrations/entitlements.ts`, `src/components/entitlement/`) appear in the
> repo map below as it stood at audit time. No finding in this file was fixed *by*
> the removal — nothing here targeted the account layer.

> **Two audit passes were run in parallel and merged 2026-07-30.** This file is the
> **TW-S** self-review pass (ARM/Intel build fixes + TW-S1/S2/S3 remediations), merged to
> `main` via PR #4. A second, independent modernization pass — dependency currency, the
> H1 drag-drop arbitrary-read gate, and CI hardening — is recorded in `docs/AUDIT.md`
> with per-bump notes in `docs/UPGRADE_NOTES.md`. Where the two passes fixed the same
> surface (crash-recovery remount, subprocess bounding, clippy CI gate, DOMPurify/linkify
> bumps) the merge kept the stronger of the two; `docs/AUDIT.md` §0 carries the reconciliation.
> **Those two are maintainer-local notes, not repo content** — `docs/` is gitignored, so
> they exist only on the maintainer's disk and are deliberately not linked here. Everything
> a reader needs about the merged outcome is in this file.

> **Later structural changes (2026-08-05) — no finding here is affected.** Dropbox was
> deleted (provider, OAuth flow, client id, allowlisted hosts, UI), leaving **WebDAV as the
> only cloud backend**; and `texlive-wasm` became the npm package `@typeward/texlive-wasm`
> (pinned `0.2.4-alpha`) instead of a `file:../texlive-wasm` sibling checkout. Nothing below
> targeted the Dropbox provider or the old dependency wiring: the two cloud findings
> (**TW-S2-01** sync cursor, **TW-S3-30** untested `resolve.ts`) live in the generic engine and
> apply unchanged to WebDAV, and the `texlive-wasm` references below are to the engine
> *identifier*, which did not change — only module specifiers did.

---

## Phase 0 — Repo map & baseline

### Distribution (from `tauri.conf.json` + CLAUDE.md)
- **Windows**: NSIS only (MSI intentionally dropped — updater prefers NSIS).
- **macOS**: DMG + `app.tar.gz`.
- **Linux**: deb + appimage + rpm.
- **Auto-update**: Tauri updater configured but **dormant** — `createUpdaterArtifacts:false`,
  `plugins.updater.pubkey:""`. Feed endpoint points at public `typeward/releases` repo.
- **Signing**: enforced in `release.yml` (updater key + platform certs) but dormant until keys exist.

### Non-negotiable constraints (inferred — CONFIRM)
- npm only (not pnpm/yarn). No emojis in code/commits. No `Co-Authored-By` trailers.
- Keep the ~34 KB boot bundle budget (`check:bundle`); Sentry SDK must stay off boot path.
- `sentry` crate pinned to 0.46.x (reqwest 0.12 tree); don't bump past without checking aws-lc-sys.
- Mature codebase: 5+ prior security/architecture audits (2026-06-10 → 2026-07-13). Many
  intentional decisions & deferred gaps are documented in CLAUDE.md and must NOT be re-flagged.

### Layout
```
src/                 SolidJS frontend — 325 TS/TSX files, ~63k LOC
  screens/           onboarding | projects | editor (shells/text-shell.tsx) | settings
  adapters/          EditorAdapter impls (latex, typst) + language/format tables
  integrations/      references, cloud, ai, supabase*, vcs, grammar, http, auth, entitlements*
  components/        editor, pdf, preview, glass, entitlement*, sync, vcs, templates, layout, ...
  commands/          registry, palette, boot, keyboard, actions, compile-runner
  stores/            editor, editor-view, projects, settings, lsp, watcher, ui, review, viewport
  lib/               lsp, reviews, watcher, autosave, telemetry, grammar, errors, toast, ...
  themes/            tokens.css + daylight/lamplight/paper + theme-store + custom-themes
  ipc/               typed Tauri command wrappers (index.ts)
src-tauri/           Rust backend — 34 files, ~17.6k LOC, 113 #[tauri::command]
  src/               commands.rs, compile.rs, detect.rs, fs_ops.rs, project.rs, settings.rs,
                     themes.rs, autosave.rs, telemetry.rs, diagnostics.rs, lsp.rs, watcher.rs,
                     synctex.rs, trust.rs, history.rs*, todo_scan.rs*, export_pandoc.rs*,
                     export_annotated.rs*, ipc_guard.rs, lib.rs, main.rs
    integrations/    credentials, http, oauth, overleaf, templates, webdav, ipc,
                     vcs/{mod,git}, ai/{mod,streaming}, grammar/{mod,config*}
  capabilities/      default.json (fs/dialog/shell/os scopes + sidecar + opener)
  resources/         templates/{latex,typst} (bundled)
  binaries/          sidecars (Tectonic; gitignored)
.github/workflows/   build.yml, release.yml, tests.yml
scripts/             fetch-tectonic.mjs, bump-version.mjs, check-bundle-shape.mjs
```
(*) in `src-tauri/` = modules newer than CLAUDE.md's documented layout — higher audit priority.
(*) in `src/` = deleted 2026-08-03 with the account/entitlement layer; listed as the tree stood at audit time.

### Baseline (2026-07-25, Windows-on-ARM dev host)
| Check | Result |
|---|---|
| `tsc --noEmit` | **PASS** (exit 0) |
| `cargo clippy --all-targets` | **compiles, exit 0**, 4 warnings (see below) |
| `vitest run` | **RED — 6 failures / 566 pass** across 2 files |
| `cargo tauri build` | not yet run (slow on ARM; deferred to fix-verification) |

**Clippy warnings (S3):**
- `compile.rs:994` `run_engine_recipe` — `too_many_arguments` (8/7)
- `integrations/templates.rs:130`, `project.rs:323`, `themes.rs:183` — `unnecessary_sort_by` → `sort_by_key`
- `commands.rs:1172/1175/1206` (tests) — `cloned_ref_to_slice_refs` → `std::slice::from_ref`

**Baseline test failures (recorded so they are not attributed to later changes):**
- `scripts/fetch-tectonic.test.mjs` — Rolldown/Oxc **parse failure** loading `fetch-tectonic.mjs`,
  which is valid JS (`node --check` passes). 0 tests run. Likely the `#!/usr/bin/env node`
  shebang + Rolldown transform. On the current branch. → Testing/Build axis finding.
- `src/themes/theme-store.test.ts` — `localStorage` is `undefined` at `beforeEach` despite
  global `environment:"jsdom"` (vite.config.ts:214). 5 failures. → Testing axis finding.

_Findings and fix plan are appended in Phase 1–2 below (audit in progress)._


---

## Phase 1 & 2 — Findings

Produced by a 15-axis multi-agent review (find -> adversarial verify). 48 raised, 3 rejected as hallucinated/intentional, 42 verified + 3 recovered (verifier crashed) = **45 real findings**. Severity shown is the verifier-corrected value. No S0.

Duplicate clusters (multiple finders hit the same root cause) are tagged `[CLUSTER:x]` and fixed as one work item:
- `PANDOC` (x6) — export_pandoc raw subprocess spawn
- `SYNCTEX` (x2) — synctex unbounded spawn / repeated PATH resolve in annotated export
- `MACINTEL` (x2) — no macOS x86_64 / universal build


### S1 findings

#### [S1] TW-S1-01 — Tests workflow is RED on every push/PR — required gate is non-functional and the bundle-shape guard never runs
- **Location:** `.github/workflows/tests.yml:78-93` · axis: (recovered) · confidence: high · effort: M · platform: all
- **Verdict:** PLAUSIBLE (verifier crashed; recovered from journal — re-verify on fix)
- **Problem:** The `frontend` job runs `npm test` (vitest run) which currently exits non-zero: `vitest run` reports 6 failures across 2 files (confirmed by running it). Because the `Vitest` step (78-80) precedes `Build frontend bundle` (87-89) and `Check bundle shape` (91-93), and GitHub Actions aborts a job at the first failing step, the load-bearing `check:bundle` guard (which tests.yml's own comment calls out as protecting the editor code-split) NEVER executes. The Tests check is red on main, so it is either blocking every merge (if required) or being ignored (if not). Two independent root causes: (1) scripts/fetch-tectonic.test.mjs imports ./fetch-tectonic.mjs, whose #!/usr/bin/env node shebang gets relocated after Vite/Rolldown injects CJS import shims, producing `...['spawn'];#!/usr/bin/env node` — a shebang not at 1:1 is a parse error under Rolldown-Vite (Vite 8). (2) src/themes/theme-store.test.ts calls localStorage.clear() but localStorage is undefined: jsdom's default opaque origin (no url) leaves Storage unavailable even though test.environment:'jsdom' is set.
- **Evidence:** ```
vitest run: Test Files 2 failed (2), Tests 5+ failed. fetch-tectonic.mjs:1:1003  ...spawn=...['spawn'];#!/usr/bin/env node (parse error). theme-store.test.ts:9 TypeError: Cannot read properties of undefined (reading 'clear'). tests.yml order: Typecheck(74)->Vitest(78 FAILS)->Build frontend bundle(87 never runs)->Check bundle shape(91 never runs).
```
- **Fix:** Make `npm test` green so the gate and check:bundle actually run: (1) extract assertAllowedUrl/PLATFORMS into a shebang-less module the CLI imports (or strip the shebang before test transform) so the imported file has no shebang; (2) add test.environmentOptions:{ jsdom:{ url:'http://localhost' } } in vite.config.ts so localStorage is available. Optionally move build+check:bundle into a separate job so a vitest failure can't hide the bundle-shape regression.
- **Risk:** None to the app; test-config/structure only. Reordering could mask a real vitest regression unless kept as its own required check.

#### [S1] TW-S1-02 — Crash-recovery "Restore" updates the store but never re-renders the mounted editor (stale display + shown-vs-saved desync)
- **Location:** `src/stores/editor-store.ts:210-219` · axis: solid-frontend · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** `restoreFileContent()` replaces an already-open tab's `content` and flips `dirty=true` but, unlike `adoptDiskContent()` (line 187-202), it does NOT bump `adoptGeneration`. The editor in text-shell.tsx CenterPane is a `<Show keyed>` whose key (`editorKey`, text-shell.tsx:971-979) is `${f.path}::a${f.adoptGeneration ?? 0}::...`. The CodeMirror `value` prop is a snapshot of the object captured at mount (`const f = activeFile()!; ...value={f.content}`, text-shell.tsx:1217/1281), and its value-sync effect (CodeMirror.tsx:370) only fires when `props.value` changes, which never happens because `f` is an immutable snapshot and the new content lives in a different object. So after RecoveryDialog's "Restore all" (EditorScreen.tsx:463-478 -> restoreFileContent), the visible editor keeps showing the pre-crash on-disk content while the store holds the recovered content marked dirty. The comment even says content reflects "on next read", but a keyed already-mounted editor never re-reads. The most common recovery target is the root file, already opened as a tab on project-open, so the primary recovery case is affected. On next keystroke CM's onChange overwrites the recovered content with the displayed (old) content; on save, unshown content is written.
- **Evidence:** ```
next[i] = { ...next[i], content: file.content, dirty: true }; // no adoptGeneration bump -> keyed editor never remounts
```
- **Fix:** Mirror adoptDiskContent: when replacing an already-open tab whose content actually changed, bump adoptGeneration so editorKey changes and the keyed editor remounts on the recovered content, e.g. `next[i] = { ...next[i], content: file.content, dirty: true, adoptGeneration: (prev[i].adoptGeneration ?? 0) + (prev[i].content === file.content ? 0 : 1) };`. Losing undo history across a crash restore is acceptable (same trade-off already accepted for history-restore/conflict adoption).
- **Risk:** Remount discards CM undo history for the restored tab and resets cursor/scroll to the restore-position stash — acceptable and consistent with the existing adoptDiskContent path; verify restoring multiple tabs at once still lands each on its own content.
- **Verifier note:** Severity S1 defensible (silent shown-vs-saved desync + revert-on-edit in a data-recovery feature); a reasonable argument exists for S2 since a plain save-without-editing would still persist the recovered store content — the desync is display + first-keystroke-loss. Fix location editor-store.ts:215; proposed conditional adoptGeneration bump is sound.

#### [S1] TW-S1-03 — theme-store.test.ts fails on Node >=22 (incl. CI): Node's native experimental localStorage global shadows jsdom
- **Location:** `src/themes/theme-store.test.ts:9` · axis: testing · confidence: high · effort: S · platform: all (CI Node 22 + dev host Node 26; any Node >=22.4)
- **Verdict:** CONFIRMED
- **Problem:** On Node 22.4+ (CI runs Node 22 per .github/workflows/tests.yml:60; dev host runs Node 26) Node defines an experimental global `localStorage` that returns `undefined` unless `--localstorage-file` is passed. This non-enumerable global is NOT overwritten by vitest's jsdom environment, so bare `localStorage` resolves to Node's undefined native accessor rather than jsdom's `window.localStorage`. All 5 tests fail in `beforeEach` at `localStorage.clear()` with `TypeError: Cannot read properties of undefined (reading 'clear')`. Because `npm test` (tests.yml:80) is `vitest run` with no per-file allowance, this makes the ENTIRE frontend test job RED on CI, so the quality gate provides no signal. It also means theme-store.ts's own persistence (theme-store.ts:92,169 use bare `localStorage`) is silently no-op under this Node and can never be regression-tested.
- **Evidence:** ```
$ node --version -> v26.4.0
$ node -e "console.log(typeof localStorage)" -> undefined  (ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.)
$ npx vitest run src/themes/theme-store.test.ts -> 5 failed, TypeError at theme-store.test.ts:9:16 `localStorage.clear()`
vite.config.ts test block (line 213) has NO `setupFiles`.
```
- **Fix:** Add a vitest setup file that bridges jsdom's storage over Node's native global, and register it in vite.config.ts `test.setupFiles`. Setup contents: `import { beforeAll } from 'vitest'; beforeAll(() => { if (typeof window !== 'undefined' && window.localStorage) { Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true }); Object.defineProperty(globalThis, 'sessionStorage', { value: window.sessionStorage, configurable: true }); } });`. Alternatively (narrower) change the test + theme-store.ts to reference `window.localStorage`. Prefer the setup file so all suites are covered and CI stops being pinned to the pre-22.4 behavior CLAUDE.md still assumes.
- **Risk:** None material; the setup only defines storage when jsdom provides it.
- **Verifier note:** All cited evidence verified verbatim. The failure breaks the whole `vitest run` job (not just this file) since any failing test yields a non-zero exit, so the frontend quality gate provides no signal on CI Node 22.x and on the Node 26 dev host. Proposed setup-file fix is sound; the narrower window.localStorage change would also work but wouldn't cover other suites.

#### [S1] TW-S1-04 — fetch-tectonic.test.mjs never runs: Rolldown SSR transform hoists CJS imports above the file's shebang -> parse failure
- **Location:** `scripts/fetch-tectonic.mjs:1` · axis: testing · confidence: high · effort: S · platform: all (Rolldown-Vite, version-independent of Node)
- **Verdict:** CONFIRMED
- **Problem:** The supply-chain guard test imports the real script (`import { assertAllowedUrl, PLATFORMS } from './fetch-tectonic.mjs'`). Vitest transforms that module through Rolldown's SSR path, which rewrites the ESM `import`s into `const x = __vite__cjsImport...` statements and HOISTS them to the very top of line 1 — placing them BEFORE the `#!/usr/bin/env node` shebang that was on line 1. The `#!` sequence then appears mid-line and Rolldown's parser aborts with `Invalid Character '!'`. The whole test file collects 0 tests. This means the digest-pinning and host-allowlist assertions (assertAllowedUrl rejecting evil hosts / non-https, sha256 pinned per platform) — the actual supply-chain regression guards for a binary that ships inside signed installers — provide ZERO protection and also break CI's `npm test` job.
- **Evidence:** ```
$ npx vitest run scripts/fetch-tectonic.test.mjs ->
RolldownError: Parse failure: Invalid Character `!`
  File: /scripts/fetch-tectonic.mjs:1:1003
  1 | ...ateHash"];const get = __vite__cjsImport7_node_https["get"];#!/usr/bin/env node
    |                                                             ^
Test Files 1 failed (1), Tests: no tests
```
- **Fix:** Remove the `#!/usr/bin/env node` shebang line from scripts/fetch-tectonic.mjs (line 1). The script is invoked as `node scripts/fetch-tectonic.mjs` via the `fetch:tectonic` npm script, so the shebang is decorative and its removal is behavior-neutral while it unblocks the Rolldown SSR transform. (If direct `./scripts/...` execution must stay, instead move the test's import to a `vi.importActual`-free plain dynamic import, or split the pure guards `assertAllowedUrl`/`PLATFORMS` into a shebang-free `fetch-tectonic.lib.mjs` that both the CLI and test import.)
- **Risk:** Removing the shebang breaks only `chmod +x ./script` direct invocation, which is not used here.
- **Verifier note:** S1 defensible; S2 also arguable. The defect is test-only: assertAllowedUrl and the per-platform sha256 pins still execute correctly at runtime under `node scripts/fetch-tectonic.mjs` (a shebang is valid there), so live supply-chain protection is intact. What is actually lost is (a) the regression guard on those functions and (b) a green `npm test` (CI breakage). Proposed fix is correct and behavior-neutral for the sole `node scripts/...` invocation path. Location scripts/fetch-tectonic.mjs:1 is accurate.


### S2 findings

#### [S2] TW-S2-01 — Cloud sync cursor is persisted non-atomically and never validated — a torn write can wedge sync permanently
- **Location:** `src/integrations/cloud/core/engine.ts:716-730` · axis: (recovered) · confidence: medium · effort: M · platform: all
- **Verdict:** PLAUSIBLE (verifier crashed; recovered from journal — re-verify on fix)
- **Problem:** persistCursor uses plugin-fs writeTextFile (truncate-in-place, not temp+rename), and ensureCursorLoaded accepts ANY non-empty string as a valid cursor with no shape/validation (unlike sync-state at 738-739, which checks version===1). A power-loss or crash mid-write leaves a truncated/partial cursor string on disk. On next boot that garbage-but-non-empty cursor is loaded and handed to provider.delta(rootId, cursor) on every pull. Depending on the provider it either errors every pass (sync wedged, never self-heals because the bad cursor is never reset) or is silently misinterpreted as a valid position, skipping deltas. sync-state.json (745-750) has the same non-atomic write; a torn write there degrades to emptySyncState, after which reconcile-on-start iterates an empty files map and never re-queues locally-diverged edits to previously-synced files, so an offline local edit can stop being pushed until the file is touched again.
- **Evidence:** ```
private async ensureCursorLoaded(): Promise<void> {
  ...
  try { this.cursor = (await readTextFile(path)).trim() || undefined; }  // no validation
  catch { this.cursor = undefined; }
}
private async persistCursor(value: string): Promise<void> {
  const path = cursorPathForCacheRoot(this.cacheRoot(), this.opts.providerId);
  await mkdirParents(path);
  await writeTextFile(path, value);   // truncate-in-place, non-atomic
}
```
- **Fix:** Route cursor + sync-state writes through the atomic project IPC (write_project_text_file -> fs_ops::atomic_write) instead of plugin-fs writeTextFile, so a torn write is impossible. Additionally, wrap delta() so that a provider error indicating an invalid/expired cursor resets this.cursor=undefined and re-pulls from scratch, giving the cursor a self-heal path it currently lacks.
- **Risk:** Switching the cache writes to the registered-root IPC requires the cache root to be a registered project root (it is a real Typeward project per CLAUDE.md), otherwise the IPC rejects; verify registration timing. The delta-error reset must distinguish 'invalid cursor' from generic transport errors so a network blip doesn't force a full re-pull.

#### [S2] TW-S2-02 [CLUSTER:MACINTEL] — macOS matrix ships arm64 only — Intel Macs on the macOS 12+ target get no runnable installer
- **Location:** `.github/workflows/release.yml:68-72` · axis: build-ci · confidence: medium · effort: M · platform: macos
- **Verdict:** CONFIRMED
- **Problem:** release.yml and build.yml build only aarch64-apple-darwin for macOS. An arm64 .dmg/.app cannot launch on Intel Macs (Rosetta translates x86->arm, not arm->x86). The stated target macOS 12+ includes Intel hardware; those users have no download that runs, and build-latest-json.mjs will carry only the darwin-aarch64 updater key.
- **Evidence:** ```
release.yml:69-72 only 'macOS (Apple Silicon) target: aarch64-apple-darwin'; build.yml:71-78 same. No x86_64-apple-darwin leg anywhere.
```
- **Fix:** If Intel is in scope, add an x86_64-apple-darwin leg (or build universal-apple-darwin) plus a Typeward_*_x64.dmg copy_one entry in the release Flatten step. If Apple-Silicon-only is deliberate, document it in CLAUDE.md and state the minimum as macOS-on-Apple-Silicon so the download page doesn't over-promise.
- **Risk:** Adds build time and assets; if Intel was intentionally dropped this is a doc-only fix.
- **Verifier note:** Cited lines slightly off (matrix include block is 67-80, macOS entry 69-72) but substance is correct. The download-page over-promise is real: 'macOS 12+' in AUDIT.md:3 and the t1 marketing prototype. Fix options as proposed are valid: add x86_64-apple-darwin (or universal) leg plus a matching x64 copy_one entry, or narrow the advertised minimum to Apple Silicon.

#### [S2] TW-S2-03 — Local images in Markdown preview and visual-editor figure widgets use raw file:// URLs, which are blocked by WKWebView (macOS) and WebKitGTK (Linux) — figures render broken
- **Location:** `src/lib/file-url.ts:9-18` · axis: cross-platform · confidence: high · effort: M · platform: macos, linux (and likely windows)
- **Verdict:** CONFIRMED (severity corrected from S1)
- **Problem:** fileUrlFromPath() builds raw `file://` / `file:///C:/...` URLs that are handed to <img src> in the Markdown preview (MarkdownPreview.tsx:127) and the visual editor's figure widgets (text-shell.tsx:1306 -> resolveProjectAsset). The Tauri webview document is served from a non-file origin (`tauri://localhost` on macOS/Linux, `http://tauri.localhost` on Windows). WKWebView refuses to load `file://` subresources from a custom-scheme page (it requires loadFileURL:allowingReadAccessToURL:), WebKitGTK applies the same cross-scheme restriction, and Chromium/WebView2 blocks `file://` loads from http(s) origins as a hard rule. There is no `app.security.assetProtocol` config in tauri.conf.json and no convertFileSrc/asset:// usage anywhere in src, so the app relies solely on file://. Allowing `file:` in the CSP img-src (tauri.conf.json:27) does not override the engine's scheme restriction. Net effect: any local figure in an .md preview or the LaTeX visual editor shows the '[image not shown]' placeholder is NOT even hit (the URL resolves) — instead a broken-image icon appears. Dev host is Windows-on-ARM only, so this likely shipped untested on macOS/Linux.
- **Evidence:** ```
return /^[A-Za-z]:\//.test(normalized) ? `file:///${encoded}` : `file://${encoded}`;   // file-url.ts:17
// consumers:
//   MarkdownPreview.tsx:127  return fileUrlFromPath(`${root}/${safeRel}`);
//   text-shell.tsx:1306      return resolveProjectAsset(root, rel);
// tauri.conf.json has NO assetProtocol; grep for convertFileSrc/asset:// => no matches
```
- **Fix:** Enable Tauri's asset protocol (app.security.assetProtocol = { enable: true, scope: [...project roots] }) and generate URLs with `convertFileSrc(absPath)` (from @tauri-apps/api/core) instead of hand-rolled file:// strings; update the CSP img-src to allow `asset:` and (Windows) `http://asset.localhost`. Keep the existing safeRelativePath() guard to derive the absolute path before conversion. This is the only cross-platform-correct way to surface local files as webview subresources.
- **Risk:** convertFileSrc requires the asset protocol scope to include the project root; if the scope is too narrow, images silently fail (same visible symptom as today). Must widen the asset scope at runtime the same way lib.rs::grant_projects_root_fs_scope widens fs scope.
- **Verifier note:** Finding is technically correct but its cross-platform framing is off: the file://-from-non-file-origin block applies on Windows/WebView2 and in dev (localhost:1420) too, so figures break on ALL platforms, not only macOS/Linux — the feature was simply never exercised with a local image, not a mac/linux-only regression. Severity lowered S1->S2: genuine functional defect in core features (md preview images, visual-editor figures) but degrades gracefully to a broken-image icon, no security or data-loss impact. Note the '[image not shown]' placeholder path is NOT hit (as the finding itself states) because rewriteImageUrl resolves the URL successfully — it just resolves to an unloadable file:// URL. Proposed fix (assetProtocol + convertFileSrc + CSP asset:/http://asset.localhost, keeping safeRelativePath) is the correct approach.

#### [S2] TW-S2-04 — Harper grammar (off by default) drags the entire `burn` 0.19 deep-learning framework into every desktop build
> **2026-08-03 reframe:** written when grammar was a Pro-tier feature. It is free for everyone now, and still off by default (`integrations.grammar.enabled` = false). The defect is unchanged — the `burn` stack compiles and links into every desktop binary regardless — but the "gate it behind a Pro build" option below is void: there is only one build. The live options are a cargo feature flag, a lighter harper, or accepting the footprint (owner accepted it 2026-07-26).
- **Location:** `src-tauri/Cargo.toml:72-74` · axis: deps · confidence: high · effort: L · platform: all
- **Verdict:** CONFIRMED
- **Problem:** harper-core is a hard (non-optional) dependency. Its transitive chain harper-core -> harper-brill -> harper-pos-utils depends unconditionally on `burn` 0.19.1 and `burn-ndarray` (a full ML framework used only for POS-tagging). Cargo.lock confirms burn-ndarray hard-pulls matrixmultiply, ndarray, macerator, burn-tensor, burn-autodiff, burn-ir, safetensors (via burn-store), half, float8; the graph also contains burn-cuda/burn-rocm/burn-wgpu/candle-core/cubecl-cuda/cubecl-hip (GPU backends are feature-gated off, but the CPU tensor stack compiles unconditionally). This ML stack is compiled and linked into every desktop binary even though grammar is OFF by default and does zero IPC when disabled (per CLAUDE.md). Result: large compile-time and binary-size cost paid by 100% of users, ~0% of whom use it. With `lto=true, codegen-units=1` (Cargo.toml:128-131) this also dominates release link time.
- **Evidence:** ```
harper-core = "2.5" (Cargo.toml:72); Cargo.lock: harper-pos-utils deps = [burn, burn-ndarray, ...]; burn-ndarray deps = [matrixmultiply, ndarray, macerator, burn-tensor, burn-autodiff, ...]; burn 0.19.1 lists burn-cuda/burn-rocm/burn-wgpu/burn-candle
```
- **Fix:** Check whether harper-brill/harper-pos-utils expose a lighter feature that avoids the burn tensor backend, or pin to an older harper-core (pre-brill) that used a non-ML POS tagger. If the ML tagger is required, feature-gate the whole grammar module behind a Cargo feature (e.g. `grammar`) so a build that doesn't ship grammar doesn't carry burn/ndarray/candle. *(As written this assumed a separate free-tier build; since 2026-08-03 there is one build for everyone, so the feature flag only helps if grammar is genuinely dropped from the shipped binary — otherwise the footprint is simply accepted.)* At minimum, confirm via `cargo tree -e features` which burn backends actually compile and document the accepted footprint.
- **Risk:** Feature-gating grammar requires wiring a Cargo feature through lib.rs command registration and the Harper IPC; disabling it changes the shipped feature set. Downgrading harper may lose lint rules.
- **Verifier note:** Claimed location Cargo.toml:72-74 is correct for the harper deps. Minor correction: harper-core is actually vendored via [patch.crates-io] path = "vendor/harper-core" (Cargo.toml:125-126) for a rustc-compat E0308 fix, but the vendored copy carries the identical dependency tree, so the burn pull-in is unchanged. Severity S2 defensible for dependency-hygiene given the lto/single-codegen-unit amplification; it is a build-footprint/compile-time concern with no correctness or security impact, so an argument for S3 exists, but S2 is reasonable. Proposed fix (feature-gate the grammar module) is sound and not already implemented.

#### [S2] TW-S2-05 — Frontend Sentry SDK sends live crashes/errors UNSCRUBBED, violating the UI's "scrubbed" guarantee (home dir / username / absolute paths leak)
- **Location:** `src/lib/sentry.ts:19-30` · axis: errors-observability · confidence: high · effort: M · platform: all
- **Verdict:** CONFIRMED
- **Problem:** There are two egress paths to the same Sentry project (same DSN in diagnostics.rs and sentry.ts). The Rust submission path (diagnostics.rs::scrub_event → scrub_text) carefully collapses the home directory to `~` and every remaining absolute path to its basename before send. The frontend @sentry/browser path does NOT: `initSentry()` calls `Sentry.init({ dsn, environment })` with NO `beforeSend`, no `denyUrls`, and default integrations left on. Its default GlobalHandlers integration auto-captures every `window.onerror` and `unhandledrejection`, and App.tsx:143 forwards ErrorBoundary crashes via `reportCrash → Sentry.captureException(err)`. All of these carry the raw error `.message` and `.stack`. IPC rejections routinely embed absolute paths/usernames (e.g. compile.rs surfaces "spawn failed: C:\Users\<name>\...", pandoc/synctex/lopdf errors, `history_read_version` UnknownVersion with rel path, fs errors). Any such value that reaches an uncaught rejection or a render throw is transmitted to Sentry verbatim. This directly contradicts the consent copy the user is shown: DiagnosticsPanel.tsx:285 states in-app error reporting sends events "scrubbed exactly like the preview below" (home → "~", other absolute paths → file name), and DiagnosticsPanel.tsx:400-401 repeats the guarantee. The same toggle (`privacy.shareCrashReports`) enables BOTH paths (sentry-gate.ts:32), so a user who opts in believing reports are scrubbed leaks their OS username and filesystem layout to a third party on the first uncaught frontend error. Triggers on all desktop platforms whenever the opt-in is on. Not remotely exploitable (opt-in gated), but a real PII leak that breaks the app's stated privacy contract.
- **Evidence:** ```
// src/lib/sentry.ts:23  — no beforeSend, no scrub, default integrations capture window.onerror/unhandledrejection
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.DEV ? "development" : "production",
    // Errors only, deliberately: ...
  });

// src/App.tsx:143  — raw error (message+stack, may contain C:\Users\<name>\...) forwarded unscrubbed
    void import("~/lib/sentry").then((m) => m.reportCrash(props.err)).catch(() => {});

// src/screens/settings/DiagnosticsPanel.tsx:285  — the promise the frontend path does NOT keep
  hint="...in-app error reporting is enabled ... (at most five, scrubbed exactly like the preview below)..."
```
- **Fix:** Add a `beforeSend` (and `beforeBreadcrumb`) hook in `initSentry()` that runs the same scrub the Rust side does before any event leaves the renderer: replace the home dir with `~` and collapse remaining absolute paths to basename over `event.message`, every `event.exception.values[].value`, and frame `filename`s (and breadcrumb messages). The home dir isn't known in the webview, so fetch it once at init (e.g. a small `get_home_dir_basename`-style IPC or reuse os path APIs) or, at minimum, apply the path→basename collapse (a pure string transform needing no home dir) plus a username redaction. Port `collapse_abs_paths`/`replace_home` from diagnostics.rs to a shared TS helper so both egress paths use identical logic, and add a unit test asserting a captured event with an absolute path is basename-collapsed. Until scrubbing is in place, the DiagnosticsPanel/Privacy copy overstates the guarantee for the live path.
- **Risk:** beforeSend that throws would drop events; wrap the scrub in try/catch and return the original event on failure so error reporting degrades to (unscrubbed) rather than silently disabled — or better, return null (drop) on scrub failure to keep the privacy guarantee strict. Over-aggressive path collapsing could reduce debuggability of stack frames (filenames become basenames), which is the same tradeoff the Rust path already accepts.
- **Verifier note:** S2 defensible but arguably S3: default-OFF opt-in, egress only to Sentry (the vendor the user consented to), and the scrub promise for the live path is implied rather than explicit — the primary Security toggle copy (SettingsScreen.tsx:2032) promises no scrubbing at all; only the Diagnostics hint (285) and preview dialog (400-401) mention it, and 285 grammatically ties "scrubbed" mainly to the previous-run Rust scan. Leaked data is OS username + filesystem layout. Fix as proposed: add a beforeSend that ports collapse_abs_paths/replace_home to a shared TS helper.

#### [S2] TW-S2-06 [CLUSTER:PANDOC] — export_pandoc spawns pandoc via raw Command::output() with no timeout or output cap (violates the run_bounded invariant)
- **Location:** `src-tauri/src/export_pandoc.rs:68-74` · axis: ipc · confidence: high · effort: M · platform: all
- **Verdict:** CONFIRMED
- **Problem:** CLAUDE.md's compile-subprocess invariant is explicit: 'Route new compile spawns through run_bounded, not raw Command::output().' export_pandoc runs a subprocess on adversarial project content (a cloned repo / imported folder's .tex or .typ), yet uses cmd.output() directly. There is NO 10-minute deadline and NO process-tree kill, so a malicious document that makes pandoc loop or block (pathological \input recursion, huge generated output, a Lua filter) hangs the export forever — the spawn_blocking task pins a blocking-pool thread indefinitely and repeated attempts exhaust the pool. output() also buffers the child's entire stderr into memory BEFORE the 4 KiB cap() at line 72, so a document that spews unbounded warnings to stderr causes unbounded renderer-driven memory growth. This is exactly the DoS class run_bounded was introduced to close for latexmk/pdflatex/tectonic/typst.
- **Evidence:** ```
let output = cmd
    .output()
    .map_err(|e| format!("pandoc spawn failed: {e}"))?;
if !output.status.success() {
    let stderr = cap(&String::from_utf8_lossy(&output.stderr), MAX_STDERR_BYTES);
```
- **Fix:** Route the pandoc spawn through compile::run_bounded (or an equivalent bounded helper) so it inherits the deadline, process-tree kill, and head+tail output cap. At minimum wrap the spawn in a tokio timeout with a tree kill on deadline and stream stderr into a bounded buffer instead of output().
- **Risk:** run_bounded lives in compile.rs tuned for TeX; exposing it may need a small refactor. A too-short timeout could abort a legitimately long docx conversion of a large book.
- **Verifier note:** Same raw-output() pattern also at require_pandoc_typst (line 83) for `pandoc --version`, but fixed args + trusted resolved binary make it negligible; the load-bearing issue is the compile spawn at 68-74. run_bounded is currently private (async fn, not pub) in compile.rs, so the fix must either expose it or wrap the pandoc spawn in a tokio timeout + tree kill + bounded stderr read. Severity arguably borderline S3 (DoS, needs user export or XSS) but S2 is defensible given it bypasses an explicit security invariant.

#### [S2] TW-S2-07 [CLUSTER:MACINTEL] — No macOS Intel (x86_64) build and no universal binary — Intel Macs unsupported and unreachable by the updater
- **Location:** `.github/workflows/release.yml:66-80` · axis: packaging · confidence: medium · effort: M · platform: macos
- **Verdict:** CONFIRMED
- **Problem:** The release matrix builds only aarch64-apple-darwin for macOS (no x86_64-apple-darwin leg, no universal target, and tauri.conf.json has no bundle.macOS entry / minimumSystemVersion). An arm64-only .app will not launch on Intel Macs at all (it is not a universal binary, so Rosetta does not help). The stated support floor is macOS 12+, which includes many 2018-2020 Intel machines. Compounding it, build-latest-json.mjs:58-60 can only ever emit a `darwin-aarch64` platform key from the shipped bundles, so even an Intel user who somehow installed would never receive an updater entry (`darwin-x86_64` is absent from latest.json). The download-page stable-name copy step (release.yml:339) likewise only produces `Typeward-macos-aarch64.dmg`.
- **Evidence:** ```
matrix.include:
  - label: macOS (Apple Silicon)
    runner: macos-latest
    target: aarch64-apple-darwin
# (no x86_64-apple-darwin / universal-apple-darwin leg)

# build-latest-json.mjs:
if (lower.endsWith(".app.tar.gz")) {
  return isX64 ? "darwin-x86_64" : "darwin-aarch64";
}
```
- **Fix:** Either add a `universal-apple-darwin` build leg (tauri-action `--target universal-apple-darwin`; the resulting .app.tar.gz still maps cleanly), or add a second x86_64-apple-darwin leg so latest.json carries both darwin keys. Set bundle.macOS.minimumSystemVersion explicitly to match the advertised floor. If Intel is genuinely out of scope, state the actual macOS support (Apple Silicon only) so it isn't advertised as macOS 12+.
- **Risk:** Universal builds ~double macOS build time and bundle size; a separate x86_64 leg adds a runner.
- **Verifier note:** All four evidence points confirmed exactly. Added corroboration: AUDIT.md:3 advertises macOS 12+ (includes Intel), establishing the advertised-vs-shipped contradiction. Fix options in finding are sound: universal-apple-darwin leg is the cleanest (single .app.tar.gz maps fine and covers both arches). Also update release.yml:339 stable-name copy and add bundle.macOS.minimumSystemVersion. S2 correct: an entire advertised hardware class is uninstallable and unreachable by the updater, but packaging/distribution rather than security/data-loss.

#### [S2] TW-S2-08 [CLUSTER:PANDOC] — pandoc export spawns an unbounded subprocess (no timeout / process-tree kill) — violates the run_bounded invariant
- **Location:** `src-tauri/src/export_pandoc.rs:68-70` · axis: performance · confidence: high · effort: ? · platform: all
- **Verdict:** CONFIRMED
- **Problem:** export_pandoc runs pandoc over attacker-influenceable project content (LaTeX/Typst with \input/#include, --embed-resources image inlining) via raw std::process::Command::output() with no deadline and no process-tree kill, on all platforms. CLAUDE.md's compile invariant is explicit: route new compile spawns through run_bounded (10-min timeout + taskkill /T on Windows / setsid group-SIGKILL on Unix), not raw output(). A large/adversarial document, or a pandoc that stalls on --embed-resources, makes pandoc run indefinitely; because it sits inside tokio::task::spawn_blocking, the export never returns AND the blocking worker thread is pinned forever. Repeated exports leak blocking-pool threads over a long session. require_pandoc_typst() at line 83 has the same unbounded raw spawn.
- **Evidence:** ```
let output = cmd
    .output()
    .map_err(|e| format!("pandoc spawn failed: {e}"))?;
if !output.status.success() { ... }   // no timeout, no tree-kill
```
- **Fix:** Route the pandoc spawn (and the --version probe) through compile.rs::run_bounded or an equivalent bounded wrapper so it inherits the deadline + process-tree kill + capped output. run_bounded is async and already does a non-blocking wait, so call it from the async command body rather than under spawn_blocking, or wrap the child in a wait-with-timeout that kills the tree on expiry.
- **Verifier note:** CLAUDE.md line 332 lists pandoc exports as 'deferred', but the code is actually shipped and wired (lib.rs:235, ExportMenu.tsx) — the note is stale and does not authorize the run_bounded bypass. Implementation note for the fix: run_bounded is currently private to compile.rs; routing through it requires making it pub(crate) or adding an equivalent bounded wrapper. Both spawn sites need bounding.

#### [S2] TW-S2-09 — Unreadable/corrupt settings.json on boot silently resets ALL settings and overwrites the file
- **Location:** `src-tauri/src/settings.rs:649-657` · axis: persistence · confidence: high · effort: M · platform: all (most likely Windows)
- **Verdict:** CONFIRMED
- **Problem:** settings::load propagates any error (serde parse error OR fs::read IO error) instead of degrading, unlike every other JSON sidecar in the app (history read_index:183, load_sync_state:720, grammar ignored.json:62 all degrade-to-default on corruption). On the frontend, the boot loader treats a thrown loadSettings() identically to first-boot: the catch block (settings-store.ts:824) neither hydrates from disk nor sets a read-only guard, leaving in-memory defaults in place. The persistence effect (settings-store.ts:935-949) then sees json != lastSavedJson(null) and, 250ms later, WRITES the default Settings back over the still-present settings.json. So a transient boot-time read failure (Windows AV/backup/Search-indexer briefly locking the file — the save path at line 838 explicitly acknowledges 'settings.json locked by another process' as real) or a single corrupt/truncated file destroys the user's projectsRoot, all integration account ids, editor prefs, deadlines, spaces, dashboard layout — none of which are mirrored in localStorage. The review-store (review-store.ts:203-247) goes to great lengths to distinguish NotFound from read-failure precisely to avoid this clobber; settings does not.
- **Evidence:** ```
pub fn load(app_handle: &tauri::AppHandle) -> Result<Settings, SettingsError> {
    let path = settings_path(app_handle)?;
    if !path.exists() { return Ok(Settings::default()); }
    let bytes = fs::read(path)?;                       // IO error (lock) -> Err
    let settings: Settings = serde_json::from_slice(&bytes)?;  // parse error -> Err
    Ok(sanitize_loaded_settings(settings))
}
// settings-store.ts:820-834
try { const s = await ipc.loadSettings(); for (const f of FIELDS) f.hydrate(s); lastSavedJson = JSON.stringify(buildSettings()); }
catch { /* 'First boot or non-Tauri context' */ if (isTauriMobile()) setCompileEngine('texlive-wasm'); }
finally { ... setSettingsLoaded(true); }  // -> persistence effect overwrites with defaults
```
- **Fix:** Make load() fail-safe like the other sidecars: on parse error, rename the bad file to settings.json.corrupt-<ts> (preserve for recovery) and return Settings::default(); on IO/read error propagate a DISTINCT error the frontend can recognize. On the frontend, mirror review-store: when loadSettings() fails for a reason other than 'file absent', keep settingsLoaded false OR set a persist-blocking read-only flag so the effect never overwrites settings.json until a clean load establishes on-disk state. Do not silently write defaults over a file that merely failed to read.
- **Risk:** Backing up + defaulting on parse error changes behavior for genuinely corrupt files (they now reset rather than block boot); the read-only guard must still allow a legitimate first-boot to write. Ensure the corrupt-file rename doesn't loop if the dir is unwritable.
- **Verifier note:** Cleanest reachable trigger is a corrupt/truncated or schema-incompatible settings.json (serde parse error, file unlocked) -> default write always succeeds -> full settings loss. The transient-lock scenario is also real but timing-dependent (write may also fail while locked, then succeed when the lock releases). Proposed fix (quarantine on parse error + distinct IO error + frontend persist-block until a clean load) is sound and matches the pattern already used by load_sync_state and review-store.

#### [S2] TW-S2-10 — AI conversations never reload on project switch while the AI pane stays open (load is onMount-only, no reactive trigger)
- **Location:** `src/components/editor/AiView.tsx:87-93` · axis: solid-frontend · confidence: medium · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** `ensureConversationsLoaded()` is invoked only from AiView's onMount. The ai-chat-store project-switch effect (ai-chat-store.ts:424-438) resets loadedRoot=null and clears conversations() on switch but does NOT re-trigger a load. AiView lives inside TextShell -> PreviewPane -> PdfViewer, gated on previewMode()==='ai' (a persistent signal never reset on project change, ui-store.ts:36). So if the user is viewing the AI pane and switches projects via ProjectSwitcherMenu (which only changes the ?path query, leaving TextShell/AiView mounted), AiView does not remount, loadedRoot is reset but nothing calls ensureConversationsLoaded again, and project B's saved conversations under .typeward/ai/conversations/ never load. The pane shows an empty list for B until the user toggles the pane closed and open again.
- **Evidence:** ```
onMount(() => { void ensureConversationsLoaded().then(() => { if (!activeConversationId() && conversations().length > 0) selectConversation(conversations()[0].id); }); }); // never re-runs when project() changes under a still-mounted AiView
```
- **Fix:** Replace the onMount one-shot with a createEffect keyed on project()?.rootPath (e.g. createEffect(on(() => project()?.rootPath ?? null, () => { void ensureConversationsLoaded().then(...); }))), or add the same reactive load to the store's project-switch effect after resetChatState(). ensureConversationsLoaded already guards on loadedRoot === proj.rootPath, so re-running it is cheap and idempotent.
- **Risk:** Low; the load fn is guarded and idempotent. Keep the auto-select-first-conversation branch gated on nothing being active so it doesn't yank the user off a conversation they picked.
- **Verifier note:** S2 is defensible but on the high side: impact is a confusing empty list (looks like lost conversations) on an opt-in feature (Pro-gated when written; free for everyone since 2026-08-03, still off by default), but it is fully self-healing by toggling the pane closed/open and involves no data loss (JSONL files stay on disk). S3 would also be reasonable. Location cited (AiView.tsx:87-93) and the store effect (ai-chat-store.ts:424-438) are both accurate.


### S3 findings

#### [S3] TW-S3-01 [CLUSTER:PANDOC] — ExportMenu invokes desktop-only export_pandoc / export_pdf_annotated with no mobile guard
- **Location:** `src/components/editor/ExportMenu.tsx:95-159` · axis: (recovered) · confidence: medium · effort: S · platform: mobile
- **Verdict:** PLAUSIBLE (verifier crashed; recovered from journal — re-verify on fix)
- **Problem:** export_pandoc and export_pdf_annotated are registered under #[cfg(desktop)] in lib.rs (lines 235-237), so they do not exist as commands on Android/iOS — the same pattern as git/lsp, for which CLAUDE.md states 'the frontend must treat the whole surface as absent on mobile, not as failing calls.' ExportMenu offers Word (.docx), HTML, and PDF+annotations unconditionally, with no isTauriMobile() guard (the app has lib/platform.ts:isTauriMobile used in 18 other places). On a mobile build these three menu rows would reject with an unknown-command error surfaced raw in the menu. This is dormant today (mobile has never been built) but is a latent boundary inconsistency: the established seam requires the renderer to hide desktop-only command surfaces on mobile.
- **Evidence:** ```
const artifact = await ipc.exportPandoc(p, format);   // command is #[cfg(desktop)]
...
const result = await ipc.exportPdfAnnotated(p, props.pdfPath, annotations);   // #[cfg(desktop)]
```
- **Fix:** Gate the Word/HTML/annotated OptionRows behind !isTauriMobile() (or a capability check), mirroring how the VCS surface is treated as absent on mobile. Source-zip and PDF-copy exports use dialog-plugin fs only and can stay.
- **Risk:** None on desktop; purely additive hiding on mobile.

#### [S3] TW-S3-02 — Boot splash spinner ignores prefers-reduced-motion during the boot window
- **Location:** `index.html:31-41` · axis: a11y-i18n · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** The boot splash draws an infinite CSS spinner (`animation: boot-spin 0.9s linear infinite`) in the inline <style> that paints before any bundled CSS loads. The app's motion kill-switch lives in src/themes/motion.css (a separate stylesheet loaded via the app bundle), so during the entire boot window - HTML parse until the JS/CSS graph is fetched and parsed - a user with prefers-reduced-motion: reduce still sees a continuously spinning ring. On slow disks, cold starts, or the emulated Windows-on-ARM / mobile targets this window is multiple seconds. The inline style has no reduced-motion guard of its own.
- **Evidence:** ```
#boot-splash::after { ... animation: boot-spin 0.9s linear infinite; }
@keyframes boot-spin { to { transform: rotate(360deg); } }
```
- **Fix:** Add a guard inside the same inline <style> block so it applies before the bundle loads: `@media (prefers-reduced-motion: reduce){ #boot-splash::after{ animation: none; } }` (optionally show a static ring or the wordmark alone). Self-contained in index.html, needs no bundle CSS.
- **Risk:** None - only removes motion for users who requested it; the splash is transient.
- **Verifier note:** Fix is correct and self-contained. Severity S3 is appropriate: genuine but minor accessibility polish, short-lived, no functional/security impact.

#### [S3] TW-S3-03 — SyncTeX inverse search relies on dblclick, unreliable for double-tap on touch tablets
- **Location:** `src/components/pdf/PdfViewer.tsx:1387-1398` · axis: a11y-i18n · confidence: medium · effort: M · platform: mobile
- **Verdict:** CONFIRMED
- **Problem:** Inverse search (PDF -> editor jump) is bound only to onDblClick on the page box, and the shift+click alternative is also mouse-only. The comment at line 822 claims 'double-click (double-tap on touch)', but there is no touch/pointer handler and no touch-action: manipulation on the page box. On touch tablets (a declared Phase-3 target) webviews do not reliably synthesize a dblclick from a double-tap - the gesture is commonly consumed by double-tap-to-zoom or fires with a long delay - so tablet users have no working way to invoke inverse search, and no keyboard fallback exists.
- **Evidence:** ```
onDblClick={(e) => { ...; triggerInverseSearch(e, pageNum, selText); }}  // only mouse dblclick; no onTouch*/onPointer* on the page box; no touch-action set.
```
- **Fix:** Add an explicit double-tap detector via pointerdown/pointerup timing that calls triggerInverseSearch, and set touch-action: manipulation on the page box so the browser does not hijack the second tap. Fix the line-822 comment until then.
- **Risk:** A hand-rolled double-tap detector can conflict with text selection/pan; gate it to coarse pointers so desktop dblclick is untouched.
- **Verifier note:** Finding is accurate as written. The proposed fix (double-tap detector via pointer timing + touch-action: manipulation, plus correcting the line-822 comment) is appropriate. Impact is forward-looking only: Phase 3 tablet target has never been built/run on hardware, so no currently-shipped surface exercises this path today — hence S3 is correct, not understated.

#### [S3] TW-S3-04 — No i18n layer and no RTL support: all user-facing strings hardcoded English, lang fixed to en
- **Location:** `index.html:2` · axis: a11y-i18n · confidence: high · effort: L · platform: all
- **Verdict:** CONFIRMED
- **Problem:** There is no internationalization layer: package.json has no i18n/intl dependency, <html lang="en"> is hardcoded, no dir is ever set, and every user-facing string (labels, tooltips, aria-labels, toasts, dialog copy) is inlined at the call site. Pluralization is done ad hoc (error${n===1?'':'s'}). This is a structural gap: the app cannot be localized or run RTL without a broad refactor, and screen-reader users in non-English locales get English announcements regardless of OS language. Whether this is acceptable is currently undocumented as a decision.
- **Evidence:** ```
package.json: NO i18n dependency. index.html:2 <html lang="en">. No dir= anywhere in src. Strings inline, e.g. PaneSwitcher.tsx:21-23 labels; PaneSwitcher.tsx:35 error${n===1?'':'s'}.
```
- **Fix:** If localization is out of scope, document that explicitly. If in scope, introduce a lightweight message catalog (e.g. @solid-primitives/i18n), route strings + plural rules through it, set lang/dir from a locale signal, and migrate left/right-anchored layout to logical properties before enabling RTL.
- **Risk:** Full i18n is a large refactor; the immediate low-risk action is a documented scope decision.

#### [S3] TW-S3-05 — history_record reads settings.json + project.json from disk on every save, before the throttle gate
- **Location:** `src-tauri/src/history.rs:426-448` · axis: architecture · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** The history_record command wrapper unconditionally calls settings::load(&app) (reads settings.json) and project_name(&root) (which calls project::read_project → parses .typeward/project.json) on EVERY invocation, *before* the cheap index-based throttle check inside record_in_store. recordHistorySnapshots (src/commands/actions.ts:142-152) fires this on every real save, and with autosave on (default) saveOpenFile runs on each editing pause, so the common case — a throttled/deduped record that returns Ok(false) and writes nothing — still performs 2-3 disk reads (settings.json, project.json, index.json). `max` is only used when pruning and `name` only when writing the index, so both are computed needlessly for the ~95% of calls that skip. Over a long editing session (especially on battery-powered tablets, an explicit target) this is thousands of redundant small reads on the hot save path.
- **Evidence:** ```
let max = settings::load(&app).map_err(err)?.history.max_versions_per_file;
        let store = store_dir(&app, &root)?;
        let name = project_name(&root);   // read_project() → parses project.json
        let lock = project_mutex(&project_id(&root));
        let _guard = lock.lock()...;
        record_in_store(&store, &root, &rel_path, max, forced, now_ms(), &name)
```
- **Fix:** Move the settings::load and project_name reads inside record_in_store, computed lazily only after should_record returns true (i.e. only when a version is actually about to be written). The throttle window can be decided from read_index alone, which is already the first thing record_in_store does.
- **Risk:** record_in_store would need the AppHandle or a closure to fetch settings/name lazily; keep the existing pure-function test seams by passing closures rather than the AppHandle.
- **Verifier note:** Nuance vs. the finding: record_in_store already contains an index-only throttle fast-path (lines 283-294) that avoids reading+hashing the target file within the window — so the redundant reads on a throttled call are 3 small JSON reads (settings.json, project.json, index.json) where only index.json is required, not a file-content read. Impact remains minor performance. Proposed fix is sound.

#### [S3] TW-S3-06 [CLUSTER:SYNCTEX] — export_pdf_annotated re-resolves the synctex binary (PATH scan) once per annotation, up to 500×
- **Location:** `src-tauri/src/synctex.rs:41-46` · axis: architecture · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** synctex::forward() calls detect::resolve_program("synctex") — a which/PATH scan — on every call. export_annotated.rs loops over up to MAX_ANNOTATIONS (500) annotations calling synctex::forward per annotation (export_annotated.rs:101), so a review-heavy document triggers up to 500 redundant PATH scans, even though export_annotated already did a one-time resolve_program("synctex") pre-check at line 76. Each scan hits the filesystem for every PATH entry. It runs on the blocking pool so it won't freeze the UI, but a 500-comment annotated export does hundreds of pointless directory stats.
- **Evidence:** ```
// synctex.rs:46 (inside pub fn forward)
    let Ok(synctex) = crate::detect::resolve_program("synctex") else {
// export_annotated.rs:101 (in the per-annotation loop)
        match crate::synctex::forward(&pdf, &source, ann.line)? {
```
- **Fix:** Resolve the synctex program once in export_pdf_annotated (it already does at line 76) and pass the resolved absolute path into a forward-with-program variant, or have synctex expose a resolved handle the loop reuses. Keep the absolute-path spawn invariant intact.
- **Risk:** Adding a param to forward() touches its callers (single forward-search path + tests); keep the existing forward() as a thin wrapper that resolves once and delegates.

#### [S3] TW-S3-07 — Dead frontend wrapper historyList (single-file history) — never called by any component
- **Location:** `src/ipc/index.ts:968-972` · axis: architecture · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** The single-file historyList wrapper (backing the history_list Rust command) is defined but not referenced by any component — HistoryPanel uses historyListProject exclusively, and base-actions/HistoryMenu open the project-wide panel. The history_list command therefore exists in the handler solely to back an unused wrapper (my command-vs-invoke diff only marks it 'used' because the dead wrapper itself contains the invoke string). It is dead surface area that still costs an IPC registration, a Rust command, and its maintenance.
- **Evidence:** ```
export const historyList = (
  projectRoot: string,
  relPath: string,
): Promise<HistoryVersion[]> => invoke("history_list", { projectRoot, relPath });
// grep for historyList( across src/ (excluding ipc/index.ts) returns nothing
```
- **Fix:** Either wire a per-file history view (the original intent) or delete historyList + list_in_store's command wrapper (history::history_list) to keep the IPC surface minimal. list_in_store is still used internally by record/restore, so only the command + wrapper need removal.
- **Risk:** Confirm HistoryPanel.test.tsx doesn't assert on historyList before deleting; if a per-file view is planned, keep it instead.

#### [S3] TW-S3-08 [CLUSTER:PANDOC] — Duplicated UTF-8-boundary truncation helper across export_pandoc and telemetry
- **Location:** `src-tauri/src/export_pandoc.rs:113-123` · axis: architecture · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** The 'truncate a string on a char boundary so String::truncate can't panic' helper is reimplemented in export_pandoc.rs (fn cap) and again in telemetry.rs, with compile.rs's run_bounded output-cap doing a conceptually identical head/tail char-safe truncation. Three copies of the same boundary-safe truncation logic is exactly the kind of small duplicated primitive that drifts (one copy gets a fix or an off-by-one that the others miss). It belongs in fs_ops or a shared util module the same way describeIpcError was consolidated on the frontend.
- **Evidence:** ```
// export_pandoc.rs
fn cap(s: &str, max: usize) -> String {
    if s.len() <= max { return s.to_string(); }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    s[..end].to_string()
}
// telemetry.rs also contains is_char_boundary truncation
```
- **Fix:** Extract one `pub fn truncate_on_char_boundary(s: &str, max: usize) -> &str` (or String) into a shared module (e.g. fs_ops or a new util.rs) and have export_pandoc, telemetry, and diagnostics scrubbing call it.
- **Risk:** Minimal; keep the existing unit tests pointed at the shared fn.
- **Verifier note:** Two &str copies (export_pandoc, telemetry) are the solid duplication; the compile.rs case is a byte-buffer head/tail capper, only conceptually similar. Consolidating the two &str copies into a shared util is the accurate scope. Pure code-quality/architecture nit — no bug.

#### [S3] TW-S3-09 — clippy never runs in CI — lint regressions and denied lints cannot gate merges
- **Location:** `.github/workflows/tests.yml:161-211` · axis: build-ci · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** tests.yml runs cargo test and cargo-audit but no cargo clippy (grep across all three workflows: no clippy, no rustfmt). The baseline claims clippy is exit-0, but nothing in CI enforces it. A change introducing #![deny(...)], a correctness lint, or new warnings would merge undetected; the clean-clippy invariant rests on developer discipline on one dev host.
- **Evidence:** ```
grep -rn 'clippy|--locked|fmt' .github/workflows/ => NONE
```
- **Fix:** Add to the `rust` job (with components: clippy): cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings. The Tectonic sidecar + Linux deps are already set up in that job so build.rs/externalBin validation passes.
- **Risk:** If the tree has warnings under -D warnings the step fails until the 4 known style warnings are fixed; can start non-blocking.
- **Verifier note:** Code matches the finding exactly. Severity downgraded S2->S3: this is a CI quality-gate/hygiene gap, not a runtime defect, data-loss, or security issue. Clippy warnings do not fail cargo build/test, so no shipped artifact breaks; the risk is undetected lint drift resting on single-dev-host discipline. Proposed fix (add clippy component + `cargo clippy --all-targets --all-features -- -D warnings` to the rust job) is correct and the job already has the sidecar/Linux deps needed for build.rs/externalBin validation.

#### [S3] TW-S3-10 — Rust toolchain unpinned (floating 'stable') and cargo builds not --locked — non-reproducible pipeline
- **Location:** `.github/workflows/release.yml:121-125` · axis: build-ci · confidence: medium · effort: S · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** No rust-toolchain.toml exists (checked repo root + src-tauri/), and all workflows use dtolnay/rust-toolchain@<sha> # stable with toolchain: stable — whatever the newest stable is on run day. A new stable (new compiler errors/lints, MSRV drift) can break release.yml/build.yml/tests.yml with no code change. cargo test (tests.yml:211) and tauri build run without --locked, so Cargo may resolve outside the committed Cargo.lock, defeating lockfile reproducibility for a release artifact.
- **Evidence:** ```
ls rust-toolchain* src-tauri/rust-toolchain* => none. release.yml:121-125 toolchain: stable. tests.yml:211 cargo test ... (no --locked).
```
- **Fix:** Commit rust-toolchain.toml pinning an exact channel (e.g. 1.NN.0) so CI and dev share one compiler, bumped deliberately. Pass --locked to cargo test and to tauri build args so Cargo.lock is enforced in the release pipeline.
- **Risk:** Requires periodic toolchain bumps; --locked fails the build if Cargo.lock drifts from Cargo.toml (intended signal, but can surprise on a legit dep change).
- **Verifier note:** Code matches claim exactly. Severity downgraded S2 -> S3: real reproducibility/robustness hardening gap but nothing broken today, no security/data-loss impact. Note the missing --locked degrades to a silent Cargo.lock update (cargo still reads the committed lock by default), not arbitrary dependency resolution — so the practical reproducibility risk is bounded. The floating-stable toolchain is the more impactful half. Fix should also cover build.yml and tests.yml, not just release.yml.

#### [S3] TW-S3-11 — EditorSidebar 'Copy path' uses navigator.clipboard.writeText, which the codebase itself documents as unreliable in the webview — silently fails on WebKitGTK
- **Location:** `src/components/editor/EditorSidebar.tsx:471-477` · axis: cross-platform · confidence: medium · effort: S · platform: linux (WebKitGTK), inconsistent everywhere
- **Verdict:** CONFIRMED
- **Problem:** copyRelPath() calls navigator.clipboard.writeText() directly, whereas every other clipboard operation in the app routes through the Tauri clipboard-manager plugin precisely because navigator.clipboard is 'unreliable in the webview' (base-actions.ts:26-28 says so explicitly, and cut/copy/paste there use plugin writeText/readText). On WebKitGTK, navigator.clipboard.writeText can reject when not tied to a fresh user gesture or when the async permission model differs, producing a 'Couldn't copy path' toast on Linux while the same action works on Windows/macOS. It is an avoidable per-platform inconsistency.
- **Evidence:** ```
const copyRelPath = async (node: FileNode) => {
  try {
    await navigator.clipboard.writeText(node.relPath);   // EditorSidebar.tsx:473
  } catch (e) {
    notifyError("Couldn't copy path", describeIpcError(e));
  }
};
// vs base-actions.ts:2  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
```
- **Fix:** Import writeText from @tauri-apps/plugin-clipboard-manager and use it here (as base-actions.ts already does), so copy-path behaves identically on all three desktop engines.
- **Risk:** None meaningful; the plugin path is already the app's blessed clipboard route.
- **Verifier note:** Location is accurate (line 473 within 471-477). Fix as proposed: import writeText from @tauri-apps/plugin-clipboard-manager (already a dep) and use it in copyRelPath, matching base-actions.ts. Consistency + documented-unreliability rationale make this a legitimate S3 cross-platform cleanup.

#### [S3] TW-S3-12 — Selection/focus/accent theme tokens are defined only via color-mix() with no fallback — on WebKitGTK versions lacking color-mix the properties become invalid and UI affordances vanish
- **Location:** `src/themes/tokens.css:103-118` · axis: cross-platform · confidence: low · effort: M · platform: linux (older WebKitGTK, e.g. pre-2.40 on LTS bases)
- **Verdict:** PLAUSIBLE
- **Problem:** --color-text-selection and --color-focus-ring (and many glass/accent tokens in utilities.css) are declared solely as `color-mix(in srgb/oklab, ...)` with no preceding solid-color fallback. color-mix() shipped in WebKitGTK 2.40 (and oklab in color-mix a bit later). On a supported-but-older Linux WebKitGTK, these custom properties resolve to an invalid value at computed-value time and fall back to unset, so `::selection { background: var(--color-text-selection) }` yields an invisible text selection and the focus ring disappears — an accessibility regression, not just cosmetic. Because the value is behind a CSS variable, there is no automatic graceful degradation.
- **Evidence:** ```
--color-text-selection: color-mix(in srgb, var(--color-accent-1) 32%, transparent);   // tokens.css:103
--color-focus-ring: color-mix(in srgb, var(--color-accent-1) 90%, transparent);       // tokens.css:118
--accent-text-1: color-mix(in oklab, var(--color-accent-1) 70%, white);               // tokens.css:245
```
- **Fix:** Provide a solid-color fallback declaration immediately before each color-mix line (browsers ignore the invalid override and keep the fallback), or wrap the color-mix definitions in an `@supports (color: color-mix(in srgb, red, blue))` block with a plain-rgba fallback outside it. At minimum do this for the selection and focus-ring tokens, which are accessibility-critical.
- **Risk:** Fallback colors must be picked to roughly match the mixed result per theme, or the fallback path looks slightly off on the affected old engines (still better than invisible).
- **Verifier note:** Accessibility-critical portion (selection/focus ring vanishing) is refuted: selection is plain rgb() in every shipping theme and both accessibility tokens use color-mix(in srgb), which is present at the required libwebkit2gtk-4.1/WebKitGTK 2.40 floor. Only genuine exposure is the cosmetic `in oklab` accent-text gradient tokens (tokens.css:245-246, and utilities.css) on early WebKitGTK 2.40-2.43. If any fix is warranted it should target the oklab tokens, not the srgb selection/focus tokens the finding emphasized.

#### [S3] TW-S3-13 — Heavy duplicate crate versions bloat the binary — four `zip`, five `windows-sys`, five `hashbrown`, two `reqwest`
- **Location:** `src-tauri/Cargo.lock:1` · axis: deps · confidence: high · effort: M · platform: all
- **Verdict:** CONFIRMED
- **Problem:** The dependency graph compiles many parallel major versions of the same crate. Most severe: FOUR versions of `zip` (2.4.2, 4.6.1, 7.2.0, 8.6.0) — the 8.6.0 copy is pulled solely by the vendored harper-core, while the app's own `zip = 2` (Cargo.toml:56) handles Overleaf import; zip is not tiny (deflate/bzip codecs). Also FIVE `windows-sys` (0.45/0.52/0.59/0.60/0.61), FIVE `hashbrown` (0.12/0.13/0.15/0.16/0.17), THREE `rand` (0.8/0.9/0.10), and two each of reqwest/sha2/base64/thiserror/quick-xml/syn/png/derive_more. Each distinct version is a separately compiled, separately linked copy — cumulative binary-size and compile-time cost that grows silently as deps are added.
- **Evidence:** ```
Cargo.lock: zip 2.4.2 / 4.6.1 / 7.2.0 / 8.6.0 (8.6.0 consumer = harper-core 2.5.0, vendored); windows-sys 0.45/0.52/0.59/0.60/0.61; hashbrown 0.12.3/0.13.2/0.15.5/0.16.1/0.17.1; rand 0.8.6/0.9.4/0.10.2
```
- **Fix:** Run `cargo tree -d` to attribute each duplicate. The app-controlled ones are actionable: align the app's own `quick-xml` (0.41 vs transitive 0.39), `sha2` (0.10 vs 0.11), and `base64` to a single version where a dep already forces the other; the zip 8.6 copy disappears if harper's footprint is reduced (see the burn finding). The windows-sys/hashbrown spread is largely transitive from tauri/burn and only shrinks as those deps converge — track it but accept for now. Add a CI `cargo deny` check with a duplicate-version budget to stop new duplication regressing silently.
- **Risk:** Forcing a single version via `[patch]`/`=` pins can break a transitive consumer that needs the other major; needs per-crate verification.
- **Verifier note:** Finding is factually accurate on all counts. Severity S3 is correct — pure dependency-hygiene / binary-bloat concern, no security or correctness consequence. Most duplication (windows-sys, hashbrown) is transitive from tauri/burn/harper and only converges as those upstreams do; the app can only directly influence its own quick-xml/sha2/base64/zip alignment. The proposed CI `cargo deny` duplicate-budget check is a reasonable, low-risk mitigation. Note the zip 8.6.0 copy is tied to the vendored harper-core footprint, so it is coupled to any burn/harper reduction work rather than independently removable.

#### [S3] TW-S3-14 — Stale rationale: sentry pinned to 0.46 to "keep the tree on reqwest ^0.12" but reqwest 0.13.4 is already pulled by tauri + updater
- **Location:** `src-tauri/Cargo.toml:84` · axis: deps · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** Cargo.toml:84 pins `sentry = 0.46.2` and CLAUDE.md documents this as deliberate — "the last release on reqwest ^0.12, so it rides the repo's existing reqwest/rustls(ring) tree; 0.47+ moves to reqwest 0.13 and drags in aws-lc-sys." But the tree ALREADY contains reqwest 0.13.4, pulled by `tauri` and `tauri-plugin-updater` (Cargo.lock). So the stated goal (a single reqwest 0.12 tree) is no longer achieved — both reqwest 0.12.28 and 0.13.4 compile today. The genuine hazard (aws-lc-sys via ring->aws-lc migration) is in fact still avoided — grep confirms NO aws-lc-sys/aws-lc-rs in the lock, only `ring` — so nothing is broken, but the pin's documented justification is now factually wrong and will mislead the next person deciding whether to bump sentry.
- **Evidence:** ```
Cargo.lock: `reqwest 0.13.4` consumers = tauri, tauri-plugin-updater (lines ~7202/7442); also reqwest 0.12.28. grep for aws-lc-sys/aws-lc-rs: none present; `ring` present.
```
- **Fix:** Update the CLAUDE.md sentry note (and any Cargo.toml comment) to reflect reality: reqwest 0.13 is already in the tree via tauri; the real reason to hold sentry at 0.46 is avoiding aws-lc-sys/cmake/NASM, which is orthogonal to the reqwest major. Re-verify that constraint whenever tauri or sentry is bumped, since aws-lc could enter through reqwest 0.13's default TLS on a future tauri release.
- **Risk:** Doc-only change; no build impact.
- **Verifier note:** Location accurate (Cargo.toml:84). The stale text lives both in the Cargo.toml comment context and the CLAUDE.md Sentry note. Real remaining constraint is avoiding aws-lc-sys (cmake/NASM), orthogonal to the reqwest major; re-verify on every tauri/sentry bump since aws-lc could enter via reqwest 0.13 default TLS on a future tauri release.

#### [S3] TW-S3-15 — Rust broadcasts watcher/LSP/AI-stream events with global app.emit(), leaking them to the untrusted detached preview window
- **Location:** `src-tauri/src/watcher.rs:149` · axis: ipc · confidence: medium · effort: S · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** ipc_guard.rs treats the detached PDF preview window as an untrusted renderer of attacker-supplied PDF content and blocks it from privileged commands. But Tauri's app.emit(name, payload) broadcasts to EVERY webview, not just main. Three high-value streams use the global emit: the file watcher (watcher.rs:149, emits absolute file paths), the LSP reader (lsp.rs:186, emits full JSON-RPC payloads — document symbols, hover text, completions containing source snippets), and the AI stream (streaming.rs:203 and emit_delta at 339, emits the model's reply deltas). A compromised preview webview — the exact threat ipc_guard defends — can listen() to these. The watcher name is watcher:<sanitizeId(root)>:event, and the preview already receives the PDF's absolute path in its PreviewState (PreviewBridge.tsx:55), from which the project root and its sanitized id are computable. The menu/open-with emits deliberately use emit_to("main", ...) (lib.rs:55,164,576,597); these three streaming emits are the inconsistency.
- **Evidence:** ```
// watcher.rs:149
emit_app.emit(&event_name, payload)
// lsp.rs:186
let event = format!("lsp:{}:message", reader_id); reader_app.emit(&event, payload)
// ai/streaming.rs:203 & 339
app_for_task.emit(&event_name(&stream_id), event); app.emit(&event_name(stream_id), payload);
```
- **Fix:** Change these three emits to emit_to(ipc_guard::MAIN_LABEL, ...) (or emit_filter restricting to main) so document paths, LSP payloads, and AI content reach only the main webview — matching the menu emits and the ipc_guard boundary. The preview gets its state via its own PreviewBridge channel and needs none of these.
- **Risk:** If any legitimate non-main window ever needs these events, emit_to(main) would starve it — but today only main consumes them. Preview exfiltration is further limited by the preview CSP connect-src, so this is defense-in-depth hardening.
- **Verifier note:** Code and inconsistency confirmed exactly as described; proposed fix (emit_to(MAIN_LABEL,...)) is correct and matches the existing menu-emit pattern. Downgrading S2->S3: this is a real defense-in-depth info-disclosure gap but conditional — it requires the preview webview to already be compromised (PDF.js/webview exploit) AND an exfil channel past the app CSP connect-src. S2 is defensible since the app treats a compromised preview as an in-scope adversary, but the two-step precondition makes S3 the more accurate rating. Locations accurate: watcher.rs:149, lsp.rs:186, streaming.rs:203 and 339.

#### [S3] TW-S3-16 [CLUSTER:SYNCTEX] — synctex CLI subprocesses are unbounded and amplified 500x by export_pdf_annotated
- **Location:** `src-tauri/src/synctex.rs:56-90` · axis: ipc · confidence: medium · effort: M · platform: all
- **Verdict:** CONFIRMED
- **Problem:** synctex.rs shells out to the synctex CLI with raw Command::output() and no timeout; the CLI gunzips the .synctex.gz beside the PDF. A crafted repo can commit .typeward/build/<name>.synctex.gz (the .git/info/exclude sidecar guard is applied by us AFTER clone and does not strip files already tracked in the remote), so a decompression-bomb .synctex.gz lands on disk. export_pdf_annotated (export_annotated.rs:101) calls synctex::forward once PER annotation, up to MAX_ANNOTATIONS=500, each spawning an unbounded synctex process against the same archive — a multiplied hang/OOM triggered from one IPC call on adversarial content. The double-click inverse/forward path has the same unbounded spawn without the multiplier.
- **Evidence:** ```
// synctex.rs:56
let output = Command::new(&synctex)
    .args([...])
    .output()   // no run_bounded: no timeout, unbounded gunzip
```
- **Fix:** Route synctex spawns through a bounded runner (short timeout + tree kill), and in export_annotated resolve all placements from a single synctex pass rather than re-spawning per annotation. Optionally cap the on-disk .synctex(.gz) size before invoking the CLI.
- **Risk:** Depends on the system synctex binary's behavior on a malformed/bomb archive (it may already bail); a per-call timeout could clip legitimately large lookups on huge documents.
- **Verifier note:** Impact is a local hang/resource-exhaustion DoS on adversarial content, not RCE/data loss — S3 as claimed is accurate. Fix as proposed: route synctex spawns through run_bounded (short timeout + tree kill) and resolve all export_annotated placements from a single synctex pass. The 500x amplification is bounded to 500 by MAX_ANNOTATIONS but each spawn is individually unbounded (no timeout), which is the core defect.

#### [S3] TW-S3-17 — Update install relaunches without flushing dirty buffers or autosave — dialog promises a save that never runs
- **Location:** `src/lib/updater.ts:131-147` · axis: packaging · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** installPendingUpdate() calls update.downloadAndInstall() then immediately `relaunch()` (tauri-plugin-process), with no call to save dirty buffers or flush the pending autosave. The app's unsaved-work protection lives in the window `onCloseRequested` handler (App.tsx:222 comment: "close(), not destroy() — onCloseRequested must get its prompt") and in the 500ms-debounced autosave (src/lib/autosave/index.ts:13). `relaunch()` performs a hard process restart that does NOT dispatch the webview's onCloseRequested event, so neither the save-prompt nor a forced autosave flush runs. Any edits made within the last 500ms (autosave debounce window) — and any unsaved dirty buffer whose save relies on the close guard — are lost on update. Meanwhile UpdateDialog.tsx:109-111 explicitly tells the user "Unsaved work is saved by autosave first," a guarantee no code fulfills.
- **Evidence:** ```
await update.downloadAndInstall((e) => { ... });
  // A fresh install is staged; relaunch swaps into it. On Windows the NSIS
  // installer replaces the running exe, so relaunch is the natural handoff.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();   // <- no save/flush of dirty buffers or autosave beforehand
```
- **Fix:** Before `relaunch()`, await an explicit flush: call the same save path the app uses on clean close (e.g. saveAllDirtyFiles() / autosave.flush()) so pending edits hit disk. If saving can fail, surface it and abort the relaunch rather than losing data. At minimum, await a forced autosave-snapshot flush so RecoveryDialog can restore on next launch; otherwise soften the dialog copy in UpdateDialog.tsx to stop promising a save.
- **Risk:** A save-before-relaunch could hang on a slow disk/IPC; guard with a timeout so a stuck save can't wedge the update.
- **Verifier note:** Two caveats reduce the finding's blast radius vs. its framing. (1) The updater is fully DORMANT in the checked-in tree: installPendingUpdate is only reachable via UpdateDialog -> checkForUpdates, which returns early unless isUpdaterConfigured() (requires a non-empty pubkey; CLAUDE.md confirms plugins.updater.pubkey is ''). Not currently triggerable, though not documented as intentional data-loss either, so not a deferred/intentional rejection. (2) With autosave ON (default) buffers older than 500ms are already on disk via saveOpenFile, and with autosave OFF debounced snapshots let RecoveryDialog restore most content next launch — so 'any unsaved dirty buffer is lost' overstates it; the real unrecoverable losses are the last <500ms of edits and review-comment/AI-chat saves. Bounded loss + dormancy => S3 is fairer than S2, though S2 is defensible if the feature ships with the current false dialog copy. Proposed fix (flush saveAllDirtyFiles()/snapshots before relaunch, or soften the dialog copy) is sound.

#### [S3] TW-S3-18 — Prerelease tags are served to the stable updater channel — betas auto-offered to all users
- **Location:** `scripts/bump-version.mjs:38` · axis: packaging · confidence: medium · effort: S · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** bump-version accepts prerelease versions (SEMVER regex allows `-beta.1` etc.) and tags them `v0.2.0-beta.1`. release.yml's publish step (softprops/action-gh-release, lines 426-437) sets `draft: true` but never sets `prerelease`, and does not infer it from the tag — so when the human publishes the draft it becomes a normal release. The updater endpoint is `.../releases/latest/download/latest.json` (tauri.conf.json:70-72). A prerelease published as a full release becomes GitHub's `latest`, and the Tauri updater offers any semver-newer version, so every stable user (e.g. on 0.1.0) would be auto-prompted to install 0.2.0-beta.1. There is no channel/track separation between beta and stable.
- **Evidence:** ```
# bump-version.mjs
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

# release.yml publish (softprops/action-gh-release)
with:
  tag_name: ${{ env.TAG }}
  draft: true
  # no `prerelease:` input -> published as a full 'latest' release
```
- **Fix:** In release.yml pass `prerelease: ${{ contains(env.TAG, '-') }}` to action-gh-release so `-beta`/`-rc` tags publish as GitHub prereleases (excluded from `/latest/`). For a real beta channel, point beta builds at a separate manifest (e.g. latest-beta.json) gated behind a settings toggle. At minimum document that prerelease tags must be manually marked prerelease before publishing.
- **Risk:** Marking prerelease excludes it from `/latest/`, so beta testers must fetch the manifest/download manually — acceptable and expected.
- **Verifier note:** Fix is valid: pass `prerelease: ${{ contains(env.TAG, '-') }}` to action-gh-release so `-beta`/`-rc` tags are excluded from GitHub's /latest/. Real channel separation (separate latest-beta.json manifest) is the fuller solution. Impact gated behind updater dormancy (pubkey empty, latest.json only built from .sig files) — hence S3 not S2.

#### [S3] TW-S3-19 — build.yml Windows artifact glob references dropped MSI target
- **Location:** `.github/workflows/build.yml:84-86` · axis: packaging · confidence: high · effort: S · platform: windows
- **Verdict:** CONFIRMED
- **Problem:** The Windows leg's upload path list includes `.../bundle/msi/*.msi`, but tauri.conf.json bundle.targets is ["nsis", ...] with MSI deliberately removed (CLAUDE.md: "Windows: NSIS only"). No MSI is ever produced, so that glob is dead. It doesn't break the upload (the nsis glob matches, so `if-no-files-found: error` is satisfied), but it is misleading and would silently mask a future case where NSIS output moves/renames — the job would still 'succeed' as long as either glob matched. Harmless today, stale/confusing.
- **Evidence:** ```
paths: |
  app/src-tauri/target/release/bundle/msi/*.msi
  app/src-tauri/target/release/bundle/nsis/*.exe
```
- **Fix:** Drop the `msi/*.msi` line from build.yml's Windows matrix entry to match bundle.targets (NSIS only).
- **Risk:** None.
- **Verifier note:** Evidence and location accurate. Fix (drop the msi/*.msi line) is correct. Note the fix only concerns build.yml (manual test builds); release.yml handles actual release artifacts separately.

#### [S3] TW-S3-20 — FileTree re-reads every expanded directory (one readDir IPC each) on every file save
- **Location:** `src/components/editor/FileTree.tsx:251-256` · axis: performance · confidence: medium · effort: ? · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** Each DirectoryNode's createResource is keyed on `${props.path}|${fsVersion()}`. fsVersion() is a single global signal bumped by ANY watcher event, and a normal project-file save fires one (.typeward/ is filtered, real files are not). So every save re-runs readChildren -> readDir (Tauri plugin-fs IPC) for EVERY currently-expanded directory node at once. In a deep project with 10-30 expanded folders, each autosave (500ms debounce) fans out to 10-30 concurrent readDir IPCs plus re-sort/re-merge, scaling with tree depth and how much is expanded — the long-session/large-project degradation this axis targets. Affects all platforms.
- **Evidence:** ```
const [children] = createResource(
  () => (expanded() ? `${props.path}|${fsVersion()}` : null),
  async (key) => { const fresh = await readChildren(props.path, props.relPath); ... }
);
```
- **Fix:** Make invalidation per-directory: have the Rust watcher surface the changed parent dir(s) and key each DirectoryNode's resource on a per-path version (e.g. fsVersionForDir(path) from a Map signal) so only the directory that actually changed re-reads. Keep the existing prevByRelPath identity-merge that stops folders collapsing on refresh.
- **Verifier note:** Trigger frequency overstated (autosave snapshots are filtered; only real saves/external changes fan out). readDir on local dirs is cheap and the identity-merge already handles the visible regression, so real-world impact is modest — S3, not S2. Proposed per-directory invalidation is a valid refinement, matching the existing in-code TODO comment.

#### [S3] TW-S3-21 — Rust release profile uses opt-level = "s" for a CPU-bound backend
- **Location:** `src-tauri/Cargo.toml:128-134` · axis: performance · confidence: low · effort: ? · platform: all
- **Verdict:** CONFIRMED
- **Problem:** The release profile is well-tuned (lto=true, codegen-units=1, panic=abort, strip=true) but sets opt-level = "s" (optimize for size). The desktop backend does CPU-bound work on interactive paths: Harper grammar checking in-process (400ms-debounced per edit), SHA-256 hashing (autosave conflict guard, cloud sync, history content-addressing), gzip compress/decompress per history blob, zip extraction for Overleaf import, LaTeX log parsing. opt-level "s" trades throughput on these loops for a smaller binary; for a desktop installer where size is not the binding constraint, opt-level = 3 is the more appropriate default.
- **Evidence:** ```
[profile.release]
panic = "abort"
codegen-units = 1
lto = true
opt-level = "s"
strip = true
```
- **Fix:** Set opt-level = 3 for desktop release builds. If "s" exists to shrink the Android/iOS libs, scope it to the mobile targets via a target-specific profile override rather than penalizing the desktop hot paths globally.
- **Verifier note:** Location off by one line (block is 128-133, opt-level at 132; finding said 128-134). Severity S3 appropriate: lto=true + codegen-units=1 already recover much of the gap, and several hot paths live in third-party crates whose SIMD/inlining is less affected by opt-level="s". Legitimate tuning recommendation, no correctness/reachability failure.

#### [S3] TW-S3-22 — History read commands skip the per-project mutex that writers hold, racing GC into a spurious 'version not found'
- **Location:** `src-tauri/src/history.rs:507-522` · axis: persistence · confidence: low · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** history_record and history_restore serialize through project_mutex (443, 541), but history_list, history_read_version, and history_list_project do NOT take the lock. read_version_in_store reads the index (no lock), validates hash membership, then read_blob. A concurrent record/restore holding the lock can push a new version, prune the oldest entry, and gc_blobs the just-read hash's blob (record_in_store:313-320) in the window between the lock-free index read and read_blob. The read then hits fs::read of a deleted blob and surfaces an io 'not found' as a failed version-preview/restore. Not corruption or data loss, but a user opening an old version while autosave is actively recording can get a transient hard error. Narrow trigger (requires the read to target the exact entry crossing the retention cap at that instant).
- **Evidence:** ```
fn read_version_in_store(store, rel_path, hash) -> Result<String, HistoryError> {
  let index = read_index(store)?;                 // lock-free
  let known = valid_hash(hash) && index.files.get(&rel)...any(|e| e.hash == hash);
  if !known { return Err(UnknownVersion{..}); }
  read_blob(store, hash)                           // blob may have been gc'd meanwhile
}
// history_read_version wrapper does NOT acquire project_mutex, unlike history_restore (541)
```
- **Fix:** Acquire the same project_mutex in history_read_version (and history_list/list_project for a fully consistent snapshot) before reading the index+blob, OR have read_blob treat a missing blob for an index-referenced hash as a retryable/soft error rather than a raw io failure. Cheapest correct fix: take the lock in history_read_version so it can't interleave with a pruning record/restore.
- **Risk:** Taking the mutex in read paths adds contention with the autosave-driven record burst; keep the critical section to just the index+blob read. Minimal risk.
- **Verifier note:** Finding overstates scope: restore is NOT affected. history_restore takes project_mutex at line 541 and restore_in_store reads the version at line 368 inside that lock, so it cannot interleave with a pruning record. history_list/history_list_project are lock-free but only read the index (never a blob), so their worst case is a stale list, not a hard error. The only genuinely reachable failure is the preview path (history_read_version). Trigger is narrow: the read must target the exact oldest entry crossing the retention cap at that instant AND that content hash must not be shared by any surviving entry (blobs are content-addressed, so gc_blobs only removes a blob when unreferenced). Transient spurious error, no corruption/data loss. Proposed fix (take project_mutex in history_read_version) is correct; alternatively treat a missing blob for an index-referenced hash as retryable. S3 confirmed.

#### [S3] TW-S3-23 [CLUSTER:PANDOC] — export_pandoc spawns a subprocess with raw Command::output() — unbounded stderr buffering + no timeout (regresses the run_bounded invariant)
- **Location:** `src-tauri/src/export_pandoc.rs:55-74` · axis: rust-backend · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** run() (reached via the export_pandoc IPC command) spawns pandoc with std::process::Command and captures via cmd.output(), which buffers the ENTIRE stderr (and stdout) into memory before returning. The MAX_STDERR_BYTES cap is applied only AFTER output() has already fully buffered, so it bounds the error string, not memory used during capture. There is also no timeout and stdin is not set to Stdio::null(). Threat model: malicious project content (a cloned repo / Overleaf import). A large or adversarial .tex/.typ that makes pandoc emit huge stderr blows up process memory during capture; a pandoc that hangs leaves the spawn_blocking worker parked forever, and repeated invocations exhaust the bounded blocking pool. This regresses the documented invariant (CLAUDE.md: 'Route new compile spawns through run_bounded, not raw Command::output()') in a newer, un-catalogued module — compile.rs was hardened for exactly this, export_pandoc.rs reintroduced the raw pattern.
- **Evidence:** ```
let output = cmd.output().map_err(|e| format!("pandoc spawn failed: {e}"))?;
if !output.status.success() {
    let stderr = cap(&String::from_utf8_lossy(&output.stderr), MAX_STDERR_BYTES); // cap AFTER full buffering
    return Err(format!("pandoc export failed: {stderr}"));
}
```
- **Fix:** Route this spawn (and require_pandoc_typst's --version probe) through compile.rs::run_bounded (or a shared bounded-spawn helper): stream stdout/stderr into a CappedBuffer so memory stays bounded during capture, enforce a deadline with tree-kill on timeout, and set .stdin(Stdio::null()). At minimum, wrap in tokio::time::timeout and read stderr with a running cap instead of Command::output().
- **Risk:** Low — run_bounded already exists and is used by every compile spawn; pathological pandoc runs would now abort with a bounded error instead of hanging/OOMing.
- **Verifier note:** Severity lowered from S2 to S3: the code and invariant regression are confirmed, but the path is user-initiated (explicit export), not an automatic untrusted-content trigger, and pandoc rarely emits unbounded stderr — the missing timeout (parked blocking worker) is the strongest real concern, not memory during capture. Two raw spawns need fixing, not one: the export at export_pandoc.rs:68-70 and the --version probe at :83-86. run_bounded in compile.rs is currently a private fn, so the fix requires exposing a shared bounded-spawn helper or making it pub(crate).

#### [S3] TW-S3-24 — AI streaming client has no read/idle timeout — an attacker-controlled endpoint can hold a task + TLS connection open indefinitely
- **Location:** `src-tauri/src/integrations/ai/streaming.rs:121-132` · axis: rust-backend · confidence: medium · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** stream_client() sets only connect_timeout; it deliberately omits a total .timeout() (correct — streams are long-lived), but also omits any read/idle timeout. run_stream's select loop awaits stream.next() with no per-read deadline, so a malicious or misbehaving AI endpoint (explicitly in the threat model) that completes the TLS handshake then withholds/trickles bytes keeps the spawned tokio task and pooled connection alive forever. The AbortSignal is the only teardown; stalled streams accumulate held connections/tasks. connect_timeout=10s does not cover a stall AFTER connect.
- **Evidence:** ```
outbound_client_builder(OutboundRedirect::Allowlist)
    .connect_timeout(std::time::Duration::from_secs(10))
    .pool_idle_timeout(Some(std::time::Duration::from_secs(90)))
    // Deliberately no total `.timeout()`: streams are long-lived ...
    .build()
```
- **Fix:** Add reqwest's per-read idle timeout: .read_timeout(Duration::from_secs(N)) (e.g. 60-120s) on the stream_client builder. This bounds the gap between chunks without killing a legitimately slow-but-progressing completion, and turns a stalled malicious endpoint into a clean stream-read error that ends the task and drops the connection.
- **Risk:** Low, but tune N: too small could truncate a legitimately slow model that pauses between tokens. 60-120s is safe for real providers while bounding a full stall.
- **Verifier note:** Reachability is bounded: outbound URLs must pass the fixed host allowlist, so the stalling endpoint is a misbehaving/compromised allowlisted provider or Ollama loopback, not an arbitrary attacker host. Single-user desktop app; impact is one held task/connection per stalled stream, with the user's Stop/generator-disposal abort as manual teardown. This makes it a defense-in-depth robustness gap rather than unbounded remote DoS — S3 (lowest) is accurate, not over- or understated.

#### [S3] TW-S3-25 — arXiv Atom fallback issues a plaintext http:// request that the outbound allowlist rejects — dead fallback + latent MITM channel
- **Location:** `src/integrations/references/doi-lookup/lookup.ts:94-96` · axis: security-injection · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** lookupArxivAtom() (the fallback for older arXiv papers with no minted DOI) builds a plaintext URL http://export.arxiv.org/api/query?... . The Rust outbound funnel only permits http:// for loopback URLs (http.rs validate_outbound_url: ("http", Some(_)) => is_allowed_loopback_url at line 380; export.arxiv.org is on the https allowlist at line 320 but not reachable over http). So every older-arXiv lookup that falls through the synthetic-DOI path fails at the IPC boundary instead of returning a citation. Security angle: the intent was an unencrypted outbound request whose response is turned directly into citation/BibTeX data — had the allowlist ever been loosened to accept this host over http, it would be a MITM-injectable content channel. Current impact is functional (dead fallback), but the plaintext scheme should not be in the code path.
- **Evidence:** ```
const url = `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;  // http.rs: ("http", Some(_)) => is_allowed_loopback_url(url) rejects non-loopback http
```
- **Fix:** Use https: https://export.arxiv.org/api/query?... (export.arxiv.org serves the API over TLS and is already on the https allowlist). This restores the fallback and removes the plaintext request entirely.
- **Risk:** None — export.arxiv.org supports https; the only behavior change is the fallback starts working.
- **Verifier note:** Primary impact is correctness (broken older-arXiv fallback), not a live security hole — the allowlist already blocks it. Fix (use https://export.arxiv.org, already on the https allowlist) both restores the fallback and removes the plaintext scheme. S3 is accurate.

#### [S3] TW-S3-26 — export_pdf_annotated parses an attacker-controllable PDF with lopdf on the blocking pool without a size/DoS bound
- **Location:** `src-tauri/src/export_annotated.rs:107` · axis: security-injection · confidence: low · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** run() calls Document::load(&pdf) on a path the renderer supplies (pdf_path), gated only to a .pdf file under the registered project root (resolve_pdf_under_root). A malicious project (cloned repo / Overleaf zip) can ship a crafted or huge .pdf under the project tree; when the user invokes annotated export, lopdf parses the whole document in-memory with no upfront size cap (unlike the IPC readers elsewhere, which are byte-bounded per the bounded-IPC-readers invariant). lopdf on malformed/oversized input can spike memory or CPU. It runs in spawn_blocking so a panic is contained to an Err, but a memory-exhaustion PDF is not bounded. User-triggered (not silent) and pure-Rust (no RCE), hence low severity.
- **Evidence:** ```
let mut doc = Document::load(&pdf).map_err(|e| format!("failed to read PDF: {e}"))?;  // pdf from resolve_pdf_under_root(&root, pdf_path): only extension + under-root checked, no size cap
```
- **Fix:** Add a size guard before Document::load (fs::metadata, reject over a few hundred MB, mirroring ensure_read_size in commands.rs), keeping the blocking-pool + Err-on-panic containment while removing the unbounded-parse edge.
- **Risk:** A legitimate large compiled PDF could hit the cap; choose the bound generously (build PDFs are typically <100MB).
- **Verifier note:** Accurate as written. Minor caveat: lopdf usually returns Err on malformed input rather than OOMing; the realistic unbounded vector is a very large but well-formed PDF. Proposed fix (fs::metadata size guard mirroring ensure_read_size before Document::load) is correct and consistent with the bounded-reader invariant.

#### [S3] TW-S3-27 — Vulnerable linkify-it 5.0.1 (ReDoS) ships in prod and is reachable via the .md preview on attacker-controlled project content
- **Location:** `src/components/preview/MarkdownPreview.tsx:104-109` · axis: security-tauri · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** MarkdownPreview builds markdown-it with `linkify: true`, and markdown-it 14.2.0 pulls in linkify-it 5.0.1 (confirmed installed). linkify-it <=5.0.1 has GHSA-v245-v573-v5vm (HIGH): quadratic-complexity DoS in the mailto: validator scan-loop on attacker text. The preview auto-renders any .md file opened from a project (cloned repo / Overleaf zip / synced content) after an ~80ms debounce, running linkify over the whole document on the single webview thread. A crafted .md with a pathological mailto-triggering run forces O(n^2) work, freezing the UI for seconds-to-minutes (or OOM on large input) with no way to interrupt. This is exactly the 'malicious PROJECT CONTENT' branch of the threat model. npm audit --omit=dev flags it as a shipping (non-dev) dependency.
- **Evidence:** ```
const md = new MarkdownIt({ html: false, linkify: true, typographer: false }) // linkify-it 5.0.1 = GHSA-v245-v573-v5vm ; npm audit --omit=dev: 'linkify-it <=5.0.1 Severity: high Quadratic-complexity DoS via the mailto: validator scan-loop on attacker text' ; installed linkify-it 5.0.1, markdown-it 14.2.0 (dep linkify-it ^5.0.1)
```
- **Fix:** Bump linkify-it to >=5.0.2 (published, satisfies markdown-it's ^5.0.1 range) via `npm update linkify-it` / `npm audit fix` and pin in package-lock.json. Additionally, since the preview does not need autolinking, consider `linkify: false` in buildMd() to remove the sink entirely (ai-markdown.ts already sets it false).
- **Risk:** Setting linkify:false stops raw URLs from becoming clickable links in preview; the dep bump alone is behavior-preserving and is the safer minimal fix.
- **Verifier note:** Finding is accurate and well-evidenced. Severity trimmed from S2 to S3: impact is availability-only (recoverable local UI freeze / possible OOM, force-killable), no confidentiality or integrity effect and no persistence. S2 is defensible given it's a published HIGH advisory directly reachable via the documented malicious-project-content branch, but a pure recoverable local DoS is more accurately S3. Proposed fix (npm audit fix to >=5.0.2 and/or linkify:false in buildMd) is correct and low-risk.

#### [S3] TW-S3-28 — Vulnerable DOMPurify 3.4.11 shipped as the sole XSS boundary for attacker-controlled HTML sinks
- **Location:** `src/components/preview/MarkdownPreview.tsx:178-182` · axis: security-tauri · confidence: medium · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** DOMPurify 3.4.11 is installed (declared ^3.4.11) and is the sanitizer guarding both attacker-controlled .md project content (MarkdownPreview) and remote AI output (ai-markdown.ts). 3.4.11 is covered by GHSA-c2j3-45gr-mqc4 (CUSTOM_ELEMENT_HANDLING bypass of afterSanitizeElements). The current configs do not enable custom-element handling / ADD_TAGS, so this exact bypass is not reachable today, but shipping a version of the app's only XSS boundary with an open advisory is a latent supply-chain risk — in this app an XSS bypass equals arbitrary IPC (file write + process spawn). Fix version 3.4.12 is already published and satisfies the declared ^3.4.11 range.
- **Evidence:** ```
host.innerHTML = DOMPurify.sanitize(dirty, { ADD_ATTR: ['target'], ALLOWED_URI_REGEXP: /.../i }); // installed dompurify 3.4.11 ; npm view dompurify version -> 3.4.12 (fixed)
```
- **Fix:** `npm update dompurify` to 3.4.12+ and pin in package-lock.json; keep ADD_TAGS/CUSTOM_ELEMENT_HANDLING unused so the advisory precondition stays absent.
- **Risk:** Patch-level bump of a mature sanitizer; negligible behavior risk. Not exploitable in the current config, so treat as hygiene rather than an active hole.
- **Verifier note:** Not a live/reachable exploit — the GHSA precondition (custom-element handling) is absent in both configs, as the finding acknowledges. This is correctly a latent supply-chain hygiene item, and S3 (lowest) is the right severity. Fix is low-cost: npm update dompurify to 3.4.12 (satisfies declared ^3.4.11).

#### [S3] TW-S3-29 — Export dropdown shows the loading spinner on ALL five rows while any single export runs
- **Location:** `src/components/editor/ExportMenu.tsx:205-207` · axis: solid-frontend · confidence: high · effort: S · platform: all
- **Verdict:** CONFIRMED
- **Problem:** Each OptionRow's icon slot renders `<Show when={busy()} fallback={o.icon}><Loader2/></Show>`, and busy() is a single shared signal for the whole menu. When the user triggers one export (e.g. Word/pandoc, which can take seconds), every row's icon turns into a spinner, implying all five actions are running simultaneously. Misleading feedback rather than a crash, but it misrepresents which operation is in flight.
- **Evidence:** ```
<Show when={busy()} fallback={o.icon}><Loader2 size={13} class="animate-spin" /></Show>
```
- **Fix:** Track which action is busy (a busyAction signal set to the row id before each export and cleared in finally) and gate the spinner on busyAction() === o.id while keeping disabled on busy() for all rows. Only the invoked row then spins.
- **Risk:** Cosmetic-only; ensure the busy id is cleared in every finally branch so a failed export doesn't strand the spinner.
- **Verifier note:** Purely cosmetic/misleading-feedback bug; no crash or data issue. Proposed fix (busyAction id signal gating the spinner, keeping disabled on shared busy()) is correct.

#### [S3] TW-S3-30 — Cloud conflict resolution (resolve.ts) — the destructive on-disk keep-mine/keep-theirs state machine — is entirely untested
- **Location:** `src/integrations/cloud/core/resolve.ts:37-95` · axis: testing · confidence: high · effort: M · platform: all (cloud-synced projects)
- **Verdict:** CONFIRMED (severity corrected from S2)
- **Problem:** resolve.ts owns the actual data-destroying conflict transitions: resolveConflictKeepMine removes the `.conflict-*` sibling; resolveConflictKeepTheirs overwrites the canonical file with sibling content then removes the sibling; findLatestConflictSibling parses `<stem>.conflict-<ISO>.<ext>` names from the directory and picks the latest. No test imports resolve.ts (conflict.test.ts only covers the pure naming/decision helpers `decideConflict`/`suffixWithConflict` from conflict.ts). The 2026-07-02 remediation moved conflict resolution OUT of the dialog INTO the engine specifically for correctness, but left it without regression coverage. A bug in findLatestConflictSibling's ISO-sort/prefix-match (e.g. lexical vs chronological ordering, or matching a wrong stem prefix) makes keep-theirs restore the WRONG sibling over the user's canonical file — silent data loss on a code path users invoke exactly when they can least afford a mistake.
- **Evidence:** ```
grep -rn 'core/resolve' src --include=*.test.ts -> (no results). resolve.ts:71 findLatestConflictSibling walks parent + `${stem}.conflict-` prefix match to choose the sibling that resolveConflictKeepTheirs (line 51-58) reads then writes over the original via `writeTextFile`.
```
- **Fix:** Add src/integrations/cloud/core/resolve.test.ts with a temp-dir/fs-mock harness: multiple `.conflict-<ISO>` siblings -> assert findLatestConflictSibling returns the chronologically newest (and does not match a different stem like `report2.conflict-...` when resolving `report.tex`); keep-mine removes only the sibling; keep-theirs writes sibling content to the canonical path then removes the sibling; no-sibling paths are no-ops / handled. Assert on exact bytes and remaining files.
- **Risk:** Test-only; surfaces latent ordering bug if present.
- **Verifier note:** Finding is factually correct as a test-coverage gap (CONFIRMED), but the impact is potential not actual — the current code passes the ISO-sort and stem-prefix cases the finding fears. S2 overstates a coverage gap with no live bug; S3 is appropriate. Location src/integrations/cloud/core/resolve.ts:37-107 is accurate.

#### [S3] TW-S3-31 [CLUSTER:PANDOC] — export_pandoc.rs run()/arg construction and unbounded subprocess spawn are untested (only version+cap helpers covered)
- **Location:** `src-tauri/src/export_pandoc.rs:26-77` · axis: testing · confidence: medium · effort: M · platform: all (desktop pandoc export)
- **Verdict:** CONFIRMED
- **Problem:** This newer, less-reviewed export module only tests version_at_least and cap (export_pandoc.rs:130,141). The security- and correctness-relevant logic in run() is untested: the `format` allowlist rejection (docx/html only, line 27-31), the LaTeX/Typst -> from-reader mapping (line 39-45), and the Typst version gate branch. Separately, run() spawns pandoc via raw `cmd.output()` (line 68) rather than the mandated `run_bounded` used elsewhere in compile.rs — so a pandoc invocation on a malicious/pathological project has no timeout and no output cap (only stderr is capped after the fact at line 72), violating the 'route new compile spawns through run_bounded' invariant, and there is no test that would have flagged the divergence.
- **Evidence:** ```
export_pandoc.rs:68 `let output = cmd.output().map_err(...)` (no run_bounded). tests mod (lines 128-143) covers only `version_gate_accepts_new_and_rejects_old` and `cap_truncates_on_char_boundary`. No test exercises the `unsupported export format` error path or the from/to mapping.
```
- **Fix:** Refactor the `to`/`from` mapping + format rejection out of the spawn (a pure `fn export_readers(project_format, format) -> Result<(&str,&str), String>`) and unit-test it (docx/html accepted, unknown rejected, latex->latex, typst->typst). Route the pandoc spawn through crate compile::run_bounded (or the shared bounded helper) so it inherits the timeout + head/tail output cap, and add a test asserting a bounded spawn is used (or at least that stderr/stdout caps apply).
- **Risk:** Extracting the mapping is behavior-neutral; switching to run_bounded changes timeout semantics (intended).
- **Verifier note:** The security/correctness sub-claim (unbounded spawn violating the run_bounded invariant) is real and independently valid; as framed here it's a test-coverage finding, so S3 fits. One nuance: run_bounded is async while run() runs inside spawn_blocking, so the proposed fix needs minor restructuring (finding acknowledges this). The pure-fn refactor + tests for the from/to mapping and format rejection is a sound, low-cost fix.


---

## Phase 2 — Ordered fix plan (batched)

No S0. Cheap high-impact items pulled forward. Each batch commits atomically referencing finding IDs; verify (`tsc`, `clippy`, `vitest`, and — where affected — `cargo test`) after each.

### Batch 1 — Make the CI/test gate real (unblocks everything)
`TW-S1-01` `TW-S1-03` `TW-S1-04` `TW-S3-09` `TW-S3-10` `TW-S3-19`
Fix the two red test files (Rolldown-can't-parse `fetch-tectonic.mjs` shebang; `theme-store` `localStorage` under Node 22+ jsdom), which makes the `tests.yml` gate + `check:bundle` actually run. While in the CI files: add a clippy job, pin the Rust toolchain + `cargo --locked`, fix the `build.yml` MSI artifact glob (MSI target was dropped).

### Batch 2 — S1 data-loss-adjacent correctness
`TW-S1-02` Crash-recovery "Restore" must bump `adoptGeneration` so the keyed editor remounts on recovered content (today it shows stale on-disk text and can overwrite the recovered copy on next keystroke/save).

### Batch 3 — Rust subprocess bounding (regressed `run_bounded` invariant)
`TW-S2-06` `TW-S2-08` `TW-S3-23` `TW-S3-31` (PANDOC) · `TW-S3-16` `TW-S3-06` (SYNCTEX) · `TW-S3-26` · `TW-S3-24`
Expose `run_bounded` as `pub(crate)`; route pandoc export + `--version` probe through it (timeout, tree-kill, bounded output, `stdin(null)`). Bound synctex spawns, resolve the binary once, and do a single synctex pass in `export_annotated`. Add a size cap before `lopdf::Document::load`. Add `.read_timeout()` to the AI stream client.

### Batch 4 — Data integrity / persistence
`TW-S2-01` cloud cursor + sync-state → atomic write + shape validation. `TW-S2-09` surface corrupt `settings.json` (back up + toast) instead of silently resetting all settings. `TW-S3-22` history read commands take the per-project mutex (or document why safe).

### Batch 5 — Security & dependency hygiene
`TW-S2-05` frontend Sentry `beforeSend` path-scrub to match the Rust scrubber + consent copy. `TW-S3-27` bump linkify-it (ReDoS) + `linkify:false` in preview. `TW-S3-28` bump DOMPurify. `TW-S3-25` arXiv fallback → https. `TW-S3-15` `emit_to(main)` for watcher/LSP/AI-stream (don't broadcast to the untrusted preview window). `TW-S3-14` correct the stale sentry-pin comment.

### Batch 6 — Frontend correctness / UX / mobile / a11y
`TW-S2-03` local asset URLs via `convertFileSrc`/asset protocol (WebKitGTK + `file:` CSP). `TW-S2-10` reload AI conversation on project switch. `TW-S3-29` per-row export spinner. `TW-S3-01` hide desktop-only exports on mobile. `TW-S3-11` clipboard fallback for `Copy path`. `TW-S3-20` FileTree incremental refresh. `TW-S3-07` remove dead `historyList` wrapper+command. `TW-S3-03` pointer/tap inverse-search. `TW-S3-02` reduced-motion boot splash. `TW-S3-12` color-mix fallback (investigate).

### Batch 7 — Rust cleanup / perf profile
`TW-S3-05` lazy settings/name reads in `history_record`. `TW-S3-08` shared char-boundary truncation util. `TW-S3-21` re-evaluate release `opt-level`. Clear the 4 clippy warnings (`sort_by_key` ×3, `too_many_arguments`, `cloned_ref_to_slice_refs`).

### Batch 8 — Regression tests
`TW-S3-31` pandoc arg/spawn-bounding tests. `TW-S3-30` destructive cloud-resolve test. Plus tests for the S1/S2 fixes (recovery remount, cursor atomicity, settings-corrupt recovery, Sentry scrub).

### Propose-and-wait / needs platform (NOT auto-applied)
- `TW-S2-02` `TW-S2-07` (MACINTEL): I'll add the macOS x86_64 release leg (or `universal-apple-darwin`) to `release.yml`, but it's **NEEDS-PLATFORM-VERIFY** — I can't build/sign macOS here.
- `TW-S2-04` (harper→burn bloat): removing it is a **feature/dep change that can break grammar** — I'll investigate feasibility and **propose** before touching it.
- `TW-S3-13` (duplicate crates): mostly transitive; documented, low-value to force.
- `TW-S3-17` `TW-S3-18` updater flush + prerelease channel: implement (updater is dormant, so unverifiable at runtime — mark NEEDS-VERIFY).
- `TW-S3-04` (i18n/RTL): large product decision — **deferred**, documented.

---

## Phase 3 & 4 — Remediation status

Branch `fix/tectonic-win-arm64-sidecar`. 13 atomic commits. Every code batch verified
with `tsc --noEmit`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and
`vitest run` (full suite: **581 frontend + 257 Rust tests green**; baseline was 6 red).
`cargo tauri build` was NOT run (slow/uncertain on this Windows-ARM host) — bundle-level
items are marked NEEDS-PLATFORM-VERIFY.

### Fixed (29)

| ID | Sev | Commit |
|---|---|---|
| TW-S1-01 tests.yml gate non-functional | S1 | 9f6e47c + 49f4be0 |
| TW-S1-02 crash-restore stale editor | S1 | ce19bf7 |
| TW-S1-03 theme-store localStorage (Node 22+) | S1 | 9f6e47c |
| TW-S1-04 fetch-tectonic test parse failure | S1 | 9f6e47c |
| TW-S2-01 sync cursor/state torn write | S2 | 4141d37 |
| TW-S2-05 Sentry egress unscrubbed | S2 | d257d90 |
| TW-S2-06 / 08 / 23 / 31 export_pandoc unbounded spawn (+tests) | S2 | 59b5312 |
| TW-S2-09 corrupt settings silent reset | S2 | 4141d37 |
| TW-S2-10 AI convos don't reload on project switch | S2 | ff4e6f2 |
| TW-S3-06 / 16 synctex unbounded + 500× PATH scan | S3 | 59b5312 |
| TW-S3-09 clippy not in CI | S3 | 49f4be0 |
| TW-S3-10 toolchain unpinned / not --locked | S3 | 49f4be0 |
| TW-S3-14 stale sentry-pin rationale | S3 | c9c446e |
| TW-S3-15 broadcast emits leak to preview window | S3 | d257d90 |
| TW-S3-19 build.yml stale MSI glob | S3 | 49f4be0 |
| TW-S3-22 history read races the writer | S3 | 4141d37 |
| TW-S3-24 AI stream no read timeout | S3 | 59b5312 |
| TW-S3-25 arXiv fallback over http | S3 | d257d90 |
| TW-S3-26 annotated-PDF unbounded lopdf parse | S3 | 59b5312 |
| TW-S3-27 linkify-it ReDoS | S3 | c9c446e |
| TW-S3-28 DOMPurify advisory | S3 | c9c446e |
| TW-S3-29 export spinner on all rows | S3 | ff4e6f2 |
| TW-S3-01 desktop-only exports shown on mobile | S3 | ff4e6f2 |
| TW-S3-02 boot splash ignores reduced-motion | S3 | 85a6675 |
| TW-S3-11 copy-path via navigator.clipboard | S3 | ff4e6f2 |
| clippy warnings (sort_by_key ×3, from_ref ×3, too_many_args) | S3 | 49f4be0 |

### Proposed — need a decision or a platform I can't build here (7)

- **TW-S2-02 / TW-S2-07 — no macOS Intel / universal build.** Add an
  `x86_64-apple-darwin` leg (or `universal-apple-darwin`) to `release.yml`/`build.yml`.
  Mechanical, but I can't build/sign macOS here → NEEDS-PLATFORM-VERIFY. Decision:
  ship universal (bigger, one artifact) vs a separate Intel dmg.
- **TW-S2-03 — local images use raw `file://`** (broken on WKWebView/WebKitGTK, and
  WebView2 blocks `file://` from the app origin too). Correct fix = enable Tauri's
  asset protocol + `convertFileSrc` + CSP `img-src asset:` (+ `http://asset.localhost`
  on Windows) + a runtime asset-scope grant for the moved projects root. Touches the
  CSP/security surface and is unverifiable on this host — I did not apply it blind.
  Recommended and low-code once verifiable on macOS/Linux.
- **TW-S2-04 — Harper grammar drags the whole `burn` ML stack** into every desktop
  binary though grammar is off by default (and, since 2026-08-03, ungated — free for
  everyone). Removing it is a feature/dep change that can break grammar; options:
  feature-gate `harper` behind a cargo feature, or accept the size. Needs a
  size/functionality decision + build verification.
- **TW-S3-21 — release `opt-level = "s"`.** Size-vs-speed tradeoff for the CPU-bound
  in-process work (harper, lopdf, sha256). Bumping to `2`/`3` speeds those up but grows
  the installer. Owner's call; I did not flip it blind.
- **TW-S3-17 — updater relaunch doesn't flush dirty buffers.** Updater is dormant
  (no pubkey), so unverifiable at runtime; implement + NEEDS-VERIFY when keys land.
- **TW-S3-18 — prerelease tags feed the stable updater channel.** Release-logic change
  in `bump-version.mjs`/`build-latest-json.mjs`; low urgency while the updater is dormant.
- **TW-S3-20 — FileTree re-reads every expanded dir on each fs event.** Perf refactor
  (incremental/scoped refresh); moderate, no correctness bug.

### Deferred — low value or churn outweighs benefit (documented)

- **TW-S3-03** synctex inverse-search dblclick → pointer/tap (a11y; touch-handling
  change, low incidence on desktop).
- **TW-S3-04** i18n / RTL — no i18n layer at all; a large product decision, not a bug.
- **TW-S3-05** `history_record` reads settings.json/project.json on the throttled save
  path. The file read+hash is already skipped by the existing index fast-path; the
  residual is 3 small JSON reads and the lazy fix needs a closure refactor across ~15
  test call-sites. Minor perf; recommended follow-up.
- **TW-S3-07** dead `history_list` command/wrapper — removing it orphans the
  heavily-tested `list_in_store` and creates a `dead_code` lint in non-test builds.
- **TW-S3-08** three near-duplicate char-boundary truncation helpers — pure cleanup,
  no bug; consolidate into one util when convenient.
- **TW-S3-12** selection/accent tokens rely on `color-mix()` (PLAUSIBLE — needs a check
  on the oldest supported WebKitGTK; add a fallback if it's missing there).
- **TW-S3-13** duplicate crate versions (zip ×4, windows-sys ×5, etc.) — almost all
  transitive; not forceable without upstream bumps. Documented.
- **TW-S3-30** add a regression test for the destructive `resolve.ts` keep-mine branch
  (recommended; the code is correct, the coverage is the gap).

### Remaining risks, ranked

1. **Local images broken on macOS/Linux (and likely Windows)** — TW-S2-03. Most
   user-visible open item; fix is understood but needs device verification.
2. **No Intel macOS build** — TW-S2-02/07. Excludes Intel Macs from the stated macOS 12+
   target until the release matrix gains the leg.
3. **Installer bloat from `burn`** — TW-S2-04. Ships a large ML stack for an off-by-default
   feature. (Declined by the owner 2026-07-26; grammar stays always-compiled.)
4. Everything else is S3 polish/perf with no correctness or security exposure.

### Highest-leverage follow-ups

1. Verify + land TW-S2-03 (asset protocol) on a Mac/Linux box — restores figures everywhere.
2. Add the macOS Intel/universal release leg (TW-S2-02/07).
3. Decide on Harper/`burn` feature-gating (TW-S2-04) before the first signed release.

---

## Update — after owner decisions (2026-07-26)

- **TW-S2-03 (local images) — IMPLEMENTED, NEEDS-PLATFORM-VERIFY.** Enabled Tauri's
  asset protocol: `app.security.assetProtocol` in tauri.conf.json (scope
  `$DOCUMENT/Typeward/**`) + the `protocol-asset` cargo feature; `fileUrlFromPath`
  now returns `convertFileSrc(absPath)` (with a `file://` fallback outside a Tauri
  webview for tests); CSP `img-src` gained `asset: http://asset.localhost`; and
  `grant_projects_root_fs_scope` also widens the asset-protocol scope to the
  configured (possibly moved) projects root. **Verify** figures render in the `.md`
  preview and visual editor on macOS (WKWebView), Linux (WebKitGTK) and Windows
  (WebView2) — see CHECKLIST.md. The `file:` token stays in the CSP only for the
  test fallback path.
- **TW-S2-02 / TW-S2-07 (macOS Intel) — IMPLEMENTED, NEEDS-PLATFORM-VERIFY.** Added a
  separate `x86_64-apple-darwin` leg (runner `macos-13`) to `build.yml` and
  `release.yml`. To avoid an artifact-name collision between the two macOS legs,
  release.yml now names the per-leg artifact `release-bundle-<target>` and adds a
  stable `Typeward-macos-x64.dmg` copy. **Verify** the Intel dmg builds + runs on an
  Intel Mac (can't build/sign macOS from the dev host).
- **TW-S2-04 (Harper/burn bloat) — DECLINED by owner; left as-is** (grammar stays
  always-compiled). Revisit before the first signed release if installer size matters.

---

## Review pass — self-review of the remediation diff (2026-07-26)

An 11-unit adversarial review of `git diff c2c19ba..HEAD` (find → verify) surfaced
10 issues, 1 rejected. It caught real regressions in the fixes above. All fixed:

- **[S2] settings.rs corrupt-backup ignored `fs::rename` failure.** If the rename to
  `settings.json.corrupt` failed (e.g. a Windows sharing violation) the code still
  returned defaults, so the next `save()` overwrote the real file — the exact loss the
  fix promised to prevent. Now returns `Err` when the backup fails, so nothing overwrites.
- **[S2] scrubPaths leaked the surname on spaced usernames.** `C:\Users\First Last\…`
  collapsed to `~ Last\…`, shipping "Last" to Sentry. Username segment now allows spaces
  (bounded by the separator). +test.
- **[S2] scrubPaths didn't collapse non-home POSIX paths** (broke the "scrubbed" consent
  promise on macOS/Linux). Added a URL-safe POSIX basename rule (no lookbehind — WebKit/JSC
  got lookbehind only in Safari 16.4, below the macOS 12+/WebKitGTK floor and the safari13
  build target; uses a captured preceding char instead). +test. Also scrub stack-frame
  filenames + string breadcrumb `data`.
- **[S2] macOS Intel leg collided with the arm64 updater bundle.** Both legs emit
  `Typeward.app.tar.gz` (Tauri names it after productName, no arch), which would collapse
  at flatten and misclassify in `latest.json` (Apple-Silicon auto-updating to the Intel
  bundle) once the updater goes live. Added a per-leg rename to `…_<target>.app.tar.gz`
  before flatten; `platformKey` maps both correctly. NEEDS-VERIFY on a signed macOS build.
- **[S3] Annotated-PDF size cap** moved before the synctex loop (was after up to 500 spawns).
- **[S3] synctex `forward`/`inverse` → `pub(crate)`** + a doc note: they now use
  `block_on` and must run under `spawn_blocking` (footgun hardening; no live bug — all
  callers already do).
- **[S3] AI stream `read_timeout` 120s → 300s** so a reasoning model's pre-first-token
  silence (o-series / slow local Ollama) isn't truncated.

**Accepted / documented (not code-changed):**
- **[S3] The preview window inherits the global CSP's `asset:` img-src.** Tauri v2 has no
  per-window CSP or per-window asset scope, so the detached (untrusted) preview window can
  `<img src="http://asset.localhost/…">` any file under the asset scope. Accepted as
  defense-in-depth only: exploiting it needs a preview-webview XSS (PDF.js renders to
  canvas, not script), exfil is blocked (connect-src has no `asset:`; cross-origin canvas
  is tainted), and the preview already sits on the app-global fs runtime-scope floor that
  grants an equivalent read given XSS — so no new primitive. Revisit if Tauri gains
  per-window CSP.

**Rejected (1):** the atomicWriteText Windows rename concern — correctly, it's a net
improvement (the old truncate-write was equally lock-susceptible; no data loss).
