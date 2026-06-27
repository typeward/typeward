# Typeward — Audit & Remediation Plan (Tauri v2 multiplatform)

Audit date: 2026-06-26 · Host: Windows 11 · Reviewer: Claude Code (8-way parallel audit + adversarial verification of every High finding).

**Scope:** Rust backend (`src-tauri/src/**`, ~8.5k LOC), Solid/TS frontend (`src/**`, ~27k LOC, Vite 8), Tauri config, capabilities, mobile manifests, dependencies. Targets: Windows / macOS / Linux (desktop) + iOS / Android (mobile, scaffolded).

> **Cross-platform caveat:** only the Windows host can be compiled/tested here. Findings tagged `unverified-on-host` are reasoned-about, not compiled — they must be confirmed on the relevant target.

---

## How to use this file
Each finding has: **severity** (Critical/High/Medium/Low; where adversarial verification adjusted it, shown as `raw → adjusted`), **file:line**, **platforms**, impact, and a one-line fix. The execution plan at the bottom orders fixes lowest-risk-first; run `cargo build` + `cargo clippy` + `cargo test` + `npm run build` + `npm test` after each batch.

## Progress log
- **Batch 1 — security gating gaps — DONE (2026-06-26).** SEC-1 `template_save` (is_registered_root gate), SEC-2 `overleaf_import_zip` (is_new_path_under_projects_root gate), SEC-4 `template_instantiate` (same gate), SEC-9 `start_lsp` (is_registered_root gate), SEC-10 `detect.rs run_version` (which-resolved spawn). Verified: clippy 0 warnings, cargo test 83 passed, frontend build clean, vitest 120 passed. Legit callers confirmed safe (overleaf/template pass `projectsRoot()`; template_save/start_lsp run on the opened root).
- **Batch 2 — CSP & capabilities least-privilege — DONE (2026-06-26).** SEC-5 `connect-src` trimmed to `'self' ipc: http://ipc.localhost https://*.supabase.co` (all third-party traffic goes through Rust IPC; verified zero direct `fetch`/WS/XHR in `src/`); added a separate `devCsp` carrying the loopback+dev origins so `tauri dev` HMR keeps working. SEC-6/SEC-8 dropped `https:` from `img-src` and made MarkdownPreview drop remote/explicit-scheme images entirely (+ new test). SEC-11 moved the tectonic `shell:allow-execute` grant out of the all-platform `default` capability into a new desktop-only `capabilities/desktop.json` (`"platforms": ["macOS","windows","linux"]`). Verified: clippy 0 warnings (build.rs validated the new capability + `devCsp`), cargo test 83 passed, frontend build clean, vitest 121 passed. Note: SEC-7 (fs-plugin `$DOCUMENT/**` scope) intentionally deferred — higher-touch (FileTree/PdfViewer/cloud engine use plugin-fs directly).
- **Batch 3 — move blocking IO off the main thread — DONE (2026-06-26).** Converted to `async fn` + `tokio::task::spawn_blocking` (mirroring `compile_typst`/`export_project_zip`): P-1 `read/write_project_text_file`, `read/write_project_binary_file`; P-3 `write_snapshot` (500ms autosave fsync hot path); P-5 `detect_tex` (7 serial subprocess probes); P-8g `list_projects`; P-4 `record_event`. P-4 telemetry also de-O(n²)'d: `append` now runs the full-file `trim` only on the first append + every `TRIM_INTERVAL=128` (amortized O(1); log may transiently hold MAX_ENTRIES+128 lines). Verified no command is called directly from Rust (only `project::list_projects`, a different fn, is). Verified: clippy 0 warnings (fixed a `manual_is_multiple_of` lint), cargo test 83 passed, frontend build clean, vitest 121 passed.
- **Batch 6 (partial) — frontend correctness/a11y — DONE (2026-06-26).** C-1 `AiView` now `onCleanup(() => abortController?.abort())` (stops paid-API token generation after the pane unmounts). C-3 `ConflictResolverDialog` `keepMine`/`keepTheirs` wrapped in try/catch with an inline error banner (only `clearConflict` on success). C-6 added `aria-label`s to PdfViewer prev/next, FileTree expander (+`aria-expanded`), LogsDrawer minimize. C-7 tablet tab close button bumped 36px→44px. Verified: frontend build (tsc) clean, vitest 121 passed; no Rust changed.
  - **Deferred to a follow-up frontend batch (6b):** C-2 (save-failure feedback — needs a notification/toast surface, which the app currently lacks; deferred-notifications is already a known gap), C-4 (dropdown listbox/combobox ARIA + arrow-key nav — bigger refactor across 3 custom controls), C-5a–d (silent async handlers: IntegrationsPanel disconnect/remove-key ×6, ReferencesPanel refresh, SyncStatusBadge error detail, FileTree empty-on-error — each needs a per-component error slot; grouped to keep the diff reviewable).
- **Batch 5 (partial) — frontend cold-launch/bundle — DONE (2026-06-26).** P-6: deferred the supabase boot behind a hoisted `bootSupabaseDeferred()` (dynamic import gated on `loadSupabaseConfig()`) called from `AppShell.onMount`, removing the two static App.tsx imports that forced `@supabase/supabase-js` into the entry chunk. P-8a: moved `katex/dist/katex.min.css` from `index.tsx` into `MarkdownPreview.tsx` (lazy editor chunk). P-8c: converted the adapters' dynamic `import("~/commands/actions")` to static (eval-safe cycle; warning gone). **Result: entry JS 542 KB→301 KB (−44%), entry CSS 144→115 KB, INEFFECTIVE_DYNAMIC_IMPORT gone; build clean, 0 TS errors, vitest 121 passed.** Investigated via a 4-agent workflow (verbatim edit specs + risk analysis); applied as single writer.
  - **Residual (follow-up):** SubscriptionBadge (via TopBar→ProjectsScreen) still statically imports session.ts/client.ts, so supabase-js lands in a shared *lazy* chunk loaded when Projects renders — off the critical pre-paint path, but still parses for unconfigured users. Full no-op-when-unconfigured needs gating SubscriptionBadge's supabase imports too.
  - **P-8b (fonts) — DONE (2026-06-26, user chose variable fonts).** Swapped `@fontsource/{inter,jetbrains-mono}` (7 static weight files) for `@fontsource-variable/{inter,jetbrains-mono}` (`.../index.css`); updated `tokens.css` `--font-sans`/`--font-mono` to prefer `"Inter Variable"`/`"JetBrains Mono Variable"` (kept old names as fallback). Net dep count unchanged (2 swapped for 2). Result: entry CSS 115 KB→**79 KB** (gzip 36→17), **@font-face 49→13** (variable, range-gated). Used explicit `/index.css` import so it matches the ambient `*.css` type decl (bare specifier hit TS2882). Build clean, vitest 121.
  - **P-8d (boot splash timing)** — not done (Low; optional polish).
- **SEC-3 — auth migration — DONE (2026-06-26, user chose migrate-into-Rust).** Direct code inspection corrected the audit's scope: a comprehensive grep of all frontend credential reads showed the **only** caller broken by the narrowed allowlist is `supabase/storage.ts:51` (`supabase.session`). **Mendeley was a false alarm** — the current `mendeley/auth.ts` (159 lines) uses `authRef` (Rust-resolved) + ungated `setCredential`/`credentialExists`, never `credential_get`; the audit/verifier cited `mendeley/auth.ts:214`, a line that doesn't exist. Dropbox likewise (authRef). Fix: added a dedicated `supabase_session_read(account)` Rust command (credentials.rs) that reassembles the chunked session (mirrors `getChunkedCredential`; `parse_chunk_count` helper + unit test), registered in lib.rs, exposed via `readSupabaseSession` (auth/credentials.ts); `storage.ts` getItem now uses it (writes/deletes stay on the ungated `credential_set`/`delete`). The generic `credential_get` stays locked to `supabase.entitlements` only. Verified: clippy 0 warnings, cargo test 84 passed (+1), frontend build clean, vitest 121. Note: session-restore round-trip needs a real Supabase login to fully verify on a live app (no creds on host); the chunk-reassembly logic is unit-tested and matches the frontend writer.
- **Batch 4 (partial) — binary IPC raw bytes — DONE (2026-06-26).** P-2 for the two project-file binary commands: `read_project_binary_file` now returns `tauri::ipc::Response` (raw ArrayBuffer on the JS side, no JSON number-array bloat); `write_project_binary_file` now takes a raw `tauri::ipc::Request` (bytes as the ArrayBuffer body) with `projectRoot`/`relPath` riding as percent-encoded `x-project-root`/`x-rel-path` headers (the JSON arg slot is consumed by the raw body, and header values must be ASCII — the renderer `encodeURIComponent`s, Rust `percent_decode`s). **Public TS wrapper signatures unchanged** (`Uint8Array` in/out), so the only consumers — `texlive-wasm-provider` and `actions.ts` `readWasmSynctex` — are untouched. Added a pure `percent_decode_header` helper + 2 unit tests (Unicode/space/`\`/`/` round-trip from real `encodeURIComponent` output; invalid-UTF-8 `%FF` rejection). Security posture identical: writes still gate on `ensure_registered` + `resolve_project_write_path` + symlink-refusal after decode. Verified: clippy 0 warnings, cargo test 86 passed (+2), frontend build clean, vitest 121.
  - **Caveat (`unverified-on-host`):** both binary commands are reached at runtime ONLY via the mobile `texlive-wasm` compile path (desktop PdfViewer reads PDFs via `@tauri-apps/plugin-fs` `readFile`, not this IPC), so these changes are build-verified + unit-tested but not runtime-exercised on the Windows desktop host. Confirm the raw-body + header round-trip on a mobile/WASM run.
  - **Deferred to P-2c (isolate):** `http_request_bytes` + `webdav_get`/`webdav_put` raw-bytes conversion. Unlike the file commands these return/accept **mixed** `{status/etag/headers, body}` structs, which can't carry raw bytes alongside JSON metadata without a custom length-prefixed framing protocol over the SSRF-screened outbound funnels (`http.rs`) and WebDAV client (`webdav.rs`) — and the Dropbox/WebDAV runtime paths can't be exercised on this host (no cloud creds). Higher risk; own pass with framing unit tests + on-target cloud verification. The 128 MB response cap already bounds the bloat in the interim.
- **Batch 6b (part 1 — toast surface + silent-handler fixes) — DONE (2026-06-27).** Built the notification surface C-2 needed (the app had none): `src/components/feedback/Toaster.tsx` wraps Kobalte's Toast primitive (free `aria-live` region) and exposes `notifyError/notifyInfo/notifySuccess` + a decoupled `errorText` (handles Error/string/Tauri-object rejections); `<Toaster/>` mounts once at the App root. **C-2** (save failures now visible): a new `commands/run.ts` `dispatchCommand` wraps every command `run()` in try/catch → toast on rejection, wired into both execution points (`keyboard.ts`, `CommandPalette.tsx`) replacing bare `void cmd.run()` — so Mod+S (`core.save`) and `references.refreshLibrary` (C-5b's command path) both surface failures; the text-shell save button catches directly. **C-5a**: all 6 IntegrationsPanel disconnect/remove-key handlers (zotero/mendeley/cloud/webdav/github/ai) try/catch → toast and skip the local-state clear on failure. **C-5b**: ReferencesPanel `handleRefresh` try/catch → toast. **C-5c**: `SyncStatusBadge` is now clickable in the `error` phase (was `disabled` when conflicts=0) and surfaces the worst status's `message` via toast + tooltip. **C-5d**: `FileTree` renders an inline "Couldn't read this folder" row on `children.error` instead of looking like an empty folder. Added `run.test.ts` (3 tests: async-reject → toast, sync-throw → toast, resolve → silent). Verified: tsc clean, vite build clean, vitest **124 passed (+3)**; no Rust changed.
  - **Adversarial review workflow (3 lenses × verify) caught one real defect in the C-5d fix, now fixed:** a Solid resource value accessor *re-throws* once its fetcher rejected, so the original `<For each={children() ?? []}>` would throw on a dir-read error — aborting the node's render (the new error row never committed) and emitting a recurring unhandled rejection on each `fsVersion` re-key. The `<For>` is now guarded with `<Show when={!children.error}>` so the throwing accessor is never read while errored; the inline error row renders and the rejection is gone (verifier confirmed both via runtime repro). (One IPC-contract verify agent died on a schema-retry cap; self-review found the binary IPC contract sound — documented Tauri raw-body pattern, lowercase headers match both sides, empty-payload edge unreachable, error path rejects, no callers missed.)
- **Batch 6b (part 2 — C-4 dropdown a11y) — DONE (2026-06-27).** New shared `src/lib/listbox-nav.ts`: `handleListboxKeydown` (roving focus among `[role="option"]` via Arrow/Home/End with wrap, Escape to close) + `useListboxOpenFocus` (focuses the selected — or first — option when the popup opens, via a `requestAnimationFrame` after the `<Show>` renders). Applied the listbox interaction contract to all four hand-rolled select popups — `SettingsScreen` `SelectStub`, `ReferencesPanel` `FlatSelect` (both compact + full trigger variants) and `TreeSelect`, `ProjectsScreen` sort menu: trigger buttons gained `aria-haspopup="listbox"` + `aria-expanded`; popups gained `role="listbox"` + `tabindex={-1}` + the keydown handler; options gained `role="option"` + `aria-selected` + `tabindex={-1}`. (Kept the glass styling rather than swapping in Kobalte Select.) Fixed a subtlety: `SelectStub.value` is a display label, so its `aria-selected` compares `o.label === props.value`, not the option value. Added `listbox-nav.test.ts` (6 tests: ArrowDown/Up next+wrap, Home/End, no-prior-focus → first, Escape → close). Verified: tsc clean, vite build clean, vitest **130 passed (+6)**; no Rust changed. **Batch 6b fully complete.**
- **Batch 8 (partial — D-1) — DONE (2026-06-27).** `cargo update -p quinn-proto` 0.11.14 → 0.11.15 to clear RUSTSEC-2026-0185. Re-confirmed unreachable first (`cargo tree -i quinn-proto -e normal` = "nothing to print" — reqwest http3/QUIC off, not in the normal build tree); lockfile-only change, `cargo build` clean. The remaining Batch 8 items (D-3/D-4 Android keyring + git2/OpenSSL, CP-1 desktop-gating, D-5 maintenance bumps, P-8i mobile size) are `unverified-on-host`.
- **Batch 7 — PdfViewer virtualization (P-7) — DONE (2026-06-27).** Replaced the eager `renderAll` (every page rasterized into an in-memory `HTMLCanvasElement[]` at full DPR) with `IntersectionObserver` windowing: each page now gets a placeholder sized from its real viewport (fetched once via `getPage(i).getViewport({scale:1})`, so the scrollbar + scroll math are correct), and only pages within an 800px buffer of the viewport own a rendered canvas. Off-screen canvases are freed (`width/height=0`) and the page's re-fetchable operator-list cache is released via `PDFPageProxy.cleanup()`. **DPR capped to 2 on tablet/mobile** (`isTabletViewport`), 3 on desktop — the OOM lever a 100-300pp thesis pulled on mobile webviews. Every async render commit is guarded on `loadGen` + current `scale()` + `slots.has` + `visible.has`. The AI/console panes moved from `<Switch>` (which **unmounted** the scroll root, destabilizing the observer) to `<Show>` + `display:none`, so the observer root + per-page slot registry stay stable across preview-mode switches (and canvases free while hidden). Side benefit: the scroll container is now the page boxes' `offsetParent`, so forward-search `offsetTop` maps straight into `scrollTop` space (removes a latent ~44px toolbar offset). Zoom anchors scroll position (`zoomAnchorTop * s/zoomAnchorScale`) and re-renders only the buffered pages. Props contract unchanged; the two `text-shell` call sites are untouched. Verified: tsc clean, vite build clean, vitest **130 passed** (no Rust changed).
  - **Adversarial review workflow (4 lenses — races/lifecycle, Solid reactivity, visual/SyncTeX/a11y, perf/edge — × independent verify) returned 5 "confirmed" findings; ground-truth verification refuted all 5 as platform-API misreadings** (the verifiers were Haiku and split 1-1 on the "critical" one): (1) "`observer.disconnect()` permanently disables the observer" — FALSE (disconnect is reusable; the spec sets no disabled flag); (2/3/5) "`PDFPageProxy.cleanup()` poisons the cached proxy / races with an in-flight render" — FALSE, confirmed by reading `pdfjs-dist/build/pdf.mjs:15693-15717` (`#tryCleanup` returns `false` untouched while `renderTasks.size > 0`; idle it clears only the re-fetchable op-list cache, never the proxy; `render()` rebuilds it; `getViewport()` never used it); (4) "Solid calls a row `ref` with `undefined` on unmount → `observe(undefined)` crash" — FALSE (a React-ism; Solid calls a ref once with the element). Applied two genuine robustness improvements the review surfaced anyway: replaced the disconnect-then-reobserve pattern with explicit per-target `unobserve` + per-row `onCleanup` (guarded slot delete) so teardown is self-cleaning on every path incl. load-error; kept `cleanup()` with a clarifying *why* comment.
  - **`unverified-on-host`:** runtime scroll/zoom/recompile/SyncTeX exercise still wants a running app (the change is build-verified + adversarially reviewed; PdfViewer has no unit test — jsdom lacks IntersectionObserver/canvas/pdf worker, consistent with prior batches).
- **Batch 5 residual — P-8d boot-splash timing — DONE (2026-06-27).** The splash (`index.html` `#boot-splash`) was removed in `index.tsx` *before* `render()`, leaving a blank gap until the lazy first screen + settings IPC resolved. Now the splash is opaque + top z-index and stays painted over the app until the first screen's `onMount` calls `dismissBootSplash()` (new `src/lib/boot-splash.ts` — idempotent fade-out), wired into ProjectsScreen + OnboardingScreen (the two cold-boot entry screens; Editor/Settings are only reached via navigation, so the splash is long gone). A 4s `setTimeout` safety net in `index.tsx` guarantees the splash never strands if a screen fails to mount. Verified: tsc clean, vite build clean, vitest 130 passed.
- **Batch 8 (partial — CP-1 subprocess IPC desktop-gating) — DONE (2026-06-27).** `#[cfg(desktop)]`-gated the three self-contained subprocess modules — `lsp`, `synctex`, `detect` — plus their 6 commands (`start_lsp`/`send_lsp_message`/`stop_lsp`, `synctex_forward`/`synctex_inverse`, `detect_tex`), the `LspManager` state (`.manage` moved behind a `#[cfg(desktop)] let builder = builder.manage(...)` shadow), and the matching `generate_handler!` entries — so that subprocess IPC surface isn't registered on the iOS/Android webview at all. A pre-implementation reachability audit (Explore agent, traced every frontend call site) confirmed **all gated commands are frontend-safe on mobile** — each call site catches rejections locally, so gating produces no error-toast regression: `synctex_*` short-circuit on `compileEngine()==="texlive-wasm"` (forced on mobile), `detect_tex` is try/caught at both onboarding sites, LSP start/send/stop are all `.catch`'d, and `compile_latex` is already unreachable (forced engine). Module-granularity gating leaves **zero dead code** (each module's helpers live entirely inside it); swept every `lsp::`/`synctex::`/`detect::`/`LspManager`/`EngineProbe`/`*Args`/`*Location` reference and confirmed all sit within gated scope, and that `parse_latex_log` (which the mobile-needed `parse_latex_log_cmd` calls) stays in `commands.rs` ungated. `tauri::generate_handler!` accepts inline `#[cfg]` entries (the desktop build confirms it parses + compiles). Verified on desktop: cargo build clean, clippy **0 warnings**, cargo test **86 passed** (1 ignored, = baseline), frontend build clean, vitest **130**.
  - **`unverified-on-host`:** the desktop build is transparent (`cfg(desktop)` true → everything is included, so this only proves the desktop path is unbroken). The *mobile exclusion* itself can't be compiled here — an Android `cargo check` dies on the `openssl-sys`/NDK C-dep (the separate D-4 gap) before reaching this crate. The exclusion is reasoned-sound (no dangling refs, no orphaned helpers per the reference sweep above); confirm on a real `tauri android build`.
  - **Deferred (CP-1 remainder):** `compile_latex`/`compile_typst` stay registered on mobile. Gating them cleanly needs their private helpers (`run_system_tex`/`run_tectonic` + sub-helpers, interleaved in the shared `commands.rs` alongside mobile-needed `parse_latex_log`/`Diagnostic`/`CompileResult`) extracted into a `#[cfg(desktop)] mod compile` — a refactor whose dead-code check wants a mobile build, so it's folded into the Android/iOS pass. Both are already unreachable on mobile (forced texlive-wasm, no binary to spawn), so the residual mobile surface is inert.
- **Batch 8 (partial — D-5 maintenance bumps) — DONE (2026-06-27).** Rust: `rand` 0.8→0.9 (only API change is `rand::thread_rng()`→`rand::rng()` in the two PKCE/state generators in `oauth.rs`; `RngCore::fill_bytes` unchanged) and `dirs` 5→6 (`document_dir()` API unchanged). npm within-range minors/patches: `@codemirror/{commands 6.10.4, language 6.12.4, state 6.7.0, view 6.43.4}`, `@types/node` 26.0.1, `nanoid` 5.1.16. Verified: cargo build clean + clippy **0 warnings** (no `rand` deprecation) + cargo test **86**; frontend tsc clean + vite build clean + vitest **130**.
  - **Held back — `vite` 8.1.0:** bumping it broke the build (`[MISSING_EXPORT] "createEventListener" … @solid-primitives/event-listener`). Root cause: vite 8.1's newer rolldown stopped honoring the `@solid-primitives/source` export condition that vite-plugin-solid relies on, so `@kobalte/utils`'s `createEventListener` re-export resolved to the package's `dist/index.js` (the symbol only exists in its `./src/index.ts` source entry). Not a code defect — 8.0.16 builds clean with the identical, unchanged dep. Lockfile pins `vite@8.0.16`; revisit when the rolldown condition regression lands a fix.
  - **Excluded — `pdfjs-dist` 6.1.200:** outside D-5's listed scope and deliberately not folded in — PdfViewer was just rewritten + verified against 6.0.227 (Batch 7), so its pdf.js minor should be bumped and re-tested as its own step rather than conflated with the rewrite.
- **Batch 4 residual — P-2c binary IPC raw bytes (download side) — DONE (2026-06-27).** The two binary-download commands now return file bytes via a length-prefixed raw `tauri::ipc::Response` instead of a `{...,body: Vec<u8>}` struct (which crossed the bridge as a 3-4x-bloated, triple-buffered JSON number array): `http_request_bytes` (meta `{status,headers}`) and `webdav_get` (meta `{etag}`). New shared frame helper `integrations::ipc::frame_meta_body` — layout `[u32 LE meta_len][meta JSON][body]`, length prefix authoritative so a JSON-looking body is never mis-split — paired with the frontend parser `src/integrations/ipc-frame.ts` `unframeMetaBody`. Public wrapper signatures stay compatible (`httpRequestBytes`/`webdavGet` now expose `body: Uint8Array`), so the Dropbox/WebDAV provider callers are untouched (the one redundant `Uint8Array.from` copy in the WebDAV downloader was dropped). Mirrors the proven `read_project_binary_file` pattern (`Result<tauri::ipc::Response, E>`; `invoke<ArrayBuffer>` on the JS side). Verified: cargo build clean + clippy **0 warnings** + cargo test **90** (+4 framing); frontend tsc clean + vite build clean + vitest **135** (+5 — the JS frame tests construct frames byte-for-byte to the Rust layout, cross-validating wire agreement). Adversarial review (read every caller + the Tauri contract + edge/error paths) found **no functional bugs**: frame layout agrees, all callers handle `Uint8Array`, and the error-path asymmetry (http returns a framed response for all statuses incl. 404; webdav rejects non-2xx before framing) is intentional and preserved.
  - **`unverified-on-host`:** the framing + caller wiring are unit-tested on both sides and follow the proven precedent, but the true end-to-end (Tauri raw transport for these commands × a real Dropbox/WebDAV server) can't be exercised without cloud credentials. Verify a real download round-trip before relying on it.
  - **Remaining (P-2c uploads):** `http_request_bytes`'s request body and `webdav_put`'s body still cross as JSON number arrays. Converting them to a raw `tauri::ipc::Request` (raw body + percent-encoded metadata headers — the proven `write_project_binary_file` pattern) is an independent follow-up; the existing size caps bound the interim upload bloat.
- Batch 8 (remainder: D-3/D-4 Android keyring + git2/OpenSSL, P-8i mobile size, CP-1 `compile_*` extraction — all `unverified-on-host`; plus held-back `vite` 8.1 + deferred `pdfjs-dist` 6.1 minor), P-2c uploads (request raw-body) — PENDING.

---

## Phase 0 — Baseline & architecture

**Build/test baseline (host = Windows, caches warm):**
- Rust: `cargo check` / `cargo clippy --all-targets` = **0 errors, 0 warnings**; `cargo test` = **83 passed, 0 failed, 1 ignored**.
- Frontend: `tsc` + `vite build` clean in ~7.9s (2402 modules); `vitest` = **120 passed**.
- `npm audit` = **0 vulnerabilities**. `cargo audit` = 1 advisory in-lock (unreachable, see Deps).
- ⚠️ **Uncommitted WIP in the working tree** (not yet committed): `webdav.rs` (+276), `credentials.rs` (+17), `capabilities/default.json` (+3), `themes.rs` (+20) — your in-progress WebDAV "allowlist-by-account" hardening. The tree compiles now; a background clippy briefly caught `webdav.rs` mid-save and failed transiently. One part of this WIP (`credentials.rs`) is a runtime regression — see SEC-3.

**Architecture map:**
- Single `main` window. **67 `#[tauri::command]`** across 15 files. Plugins: shell, fs, dialog, os, opener.
- **One** `capabilities/default.json`, applied to **all platforms** (no per-platform capability split).
- CSP **is set** (good). **No updater** plugin configured. `withGlobalTauri` off (default). Android manifest = `INTERNET` only; FileProvider `exported=false`. **No iOS project generated yet.**
- Release profile already tuned: `panic="abort"`, `codegen-units=1`, `lto=true`, `opt-level="s"`, `strip=true`.

**Cross-platform inventory (CP-1, Low):** Rust backend is platform-flat — only `#[cfg(test)]` guards + `#[cfg_attr(mobile, tauri::mobile_entry_point)]` (`lib.rs:14`). **All ~50 IPC commands register unconditionally for all 5 targets**, including desktop-only subprocess paths (`compile_latex/typst`, `lsp.rs`, `synctex.rs`) that are only unreachable on mobile because the frontend selects the `texlive-wasm` engine. Platform divergence lives in the frontend (`lib/platform.ts`, `viewport-store.ts` 1024px breakpoint, `shortcuts.ts`/`PdfViewer.tsx` isMac, `actions.ts:326` Windows path compare). *Recommendation: `#[cfg(desktop)]`-gate the subprocess IPC surface so it isn't even exposed on mobile webviews.*

---

## Phase 1 — Performance (HIGHEST priority)

### P-1 · Synchronous file-IO commands block Tauri's main thread — **High → Medium** · `all`
`commands.rs:184-246` — `read_project_text_file` (:185), `read_project_binary_file` (:197), `write_project_text_file` (:206, fsync), `write_project_binary_file` (:222) are `pub fn`, not `async fn`. Tauri runs non-async commands on the event-loop thread, so a large read/write/fsync freezes the window and serializes all other IPC. (Verified Medium: bounded by 16/128 MB caps, texlive-wasm path further bounded to 10 MB, no corruption/crash; `compile_typst`/`export_project_zip` already show the correct `async + spawn_blocking` pattern.)
**Fix:** make them `async fn` and run the `std::fs` body in `tokio::task::spawn_blocking`.

### P-2 · Binary IPC ships bytes as a JSON number array (3–4× bloat + triple buffering) — **High → Medium** · `all`
`read_project_binary_file` (`commands.rs:197`), `write_project_binary_file` (:222), `webdav_get`/`webdav_put` (`webdav.rs` body field), `http_request_bytes` (`http.rs`); frontend `ipc/index.ts:73,100`, `webdav/ipc.ts:54,59`. `Vec<u8>` is serde-encoded as a JSON integer array (~3–4 ASCII chars/byte), held simultaneously as Rust `Vec`, JSON string, and JS number array. Every cloud-synced file + mobile compile asset/PDF pays this; transient memory approaches the 128/256 MB caps (OOM-abort risk on mobile). (Verified Medium: functionally correct, caps bound it.)
**Fix:** return bytes via `tauri::ipc::Response` (raw body); accept uploads as `ArrayBuffer`/`Channel` instead of a number array.

### P-3 · Autosave snapshot does a synchronous fsync on the editing hot path — **Medium** · `all`
`write_snapshot` is sync (`commands.rs:679`) → `autosave::write` → `fs_ops::atomic_write` → `sync_all()` + rename (`fs_ops.rs:39,46`). Fires on the 500ms autosave debounce during typing; an fsync of tens-to-hundreds ms on HDD/mobile/networked storage produces a visible typing hitch and blocks other IPC.
**Fix:** make `write_snapshot` `async fn` + `spawn_blocking`.

### P-4 · Telemetry append rewrites the whole log + fsync on every event → O(n²), main-thread — **Medium** · `all`
`telemetry.rs:124-156` — `append()` calls `trim()` every event; `trim()` reads the whole log, rewrites a temp file, `sync_all()`s, renames. `record_event` is a sync command (`:92`). An error burst (the telemetry hook captures `unhandledrejection`/`error`) cascades into a full-file rewrite+fsync per event, freezing the UI.
**Fix:** append-only on the common path, trim lazily (only when file > ~1.5× MAX_ENTRIES), make `record_event` async + `spawn_blocking`.

### P-5 · `detect_tex` spawns 7 subprocesses serially+synchronously on the main thread — **Medium** · `all`
`detect_tex` sync (`commands.rs:86`); `probe()` runs `probe_one` for all 7 engines serially (`detect.rs:29`), each doing `which` + `<engine> --version` (`detect.rs:60`). On Windows process creation is expensive → the first-run engine card can freeze for hundreds of ms–seconds.
**Fix:** `async fn` + probe engines concurrently off the event-loop thread.

### P-6 · `@supabase/supabase-js` parsed in the entry chunk at every boot — **Medium** · `all`
`App.tsx:14-15` statically imports session/entitlements → `client.ts:10 createClient`. Supabase-js (~30–40 KB gzip / ~150 KB parsed) lands in the entry chunk and parses before any screen renders, even when Supabase is unconfigured/free-tier. JS parse dominates cold launch on WebKitGTK / old Android WebView.
**Fix:** dynamic-import the session/entitlements modules from a deferred boot step (post-first-paint `onMount`/`requestIdleCallback`).

### P-7 · `PdfViewer` renders all pages eagerly at full DPR, no virtualization — **Medium** · `all` (worst `ios`/`android`)
`PdfViewer.tsx:143-181` — `renderAll` loops every page creating a `width*dpr × height*dpr` canvas; every recompile/zoom re-renders the whole doc. A 100–300pp thesis at dpr 2–3 allocates hundreds of MB → jank or OOM tab-crash on mobile webviews.
**Fix:** virtualize with `IntersectionObserver` (render only on-screen pages, recycle off-screen canvases), cap DPR on mobile.

### P-8 · Lower-impact perf (Low) — `all`
- **P-8a** KaTeX CSS imported in entry (`index.tsx:5`) — dead weight on every non-editor screen. *Fix: move the import into `MarkdownPreview.tsx` (lazy editor chunk).*
- **P-8b** 7 full `@fontsource` CSS imports (`App.tsx:24-30`) emit `@font-face` for every unicode subset (cyrillic/greek/vietnamese/latin-ext) — render-blocking. *Fix: import latin-subset entrypoints or switch to `@fontsource-variable/*`.*
- **P-8c** `INEFFECTIVE_DYNAMIC_IMPORT`: `commands/actions.ts` is both dynamically (adapters) and statically imported (boot/CommandPalette/EditorScreen/text-shell/ProjectsScreen) → stays in main chunk. *Fix: pick one — static everywhere, or extract the lazy-only part.*
- **P-8d** Boot splash removed before first meaningful paint (`index.tsx:9-10`) → blank gap until settings IPC + lazy ProjectsScreen resolve. *Fix: remove splash after first screen mounts.*
- **P-8e** Every keystroke recreates `openFiles` array + active OpenFile object (`editor-store.ts:73-81`) → reference-keyed `<For>` tab strip rebuilds the active tab DOM each keystroke. *Fix: separate buffer content from tab metadata (per-file content signal).*
- **P-8f** `FileTree` re-reads every expanded dir on each watcher event (`FileTree.tsx:87-90`, global `fsVersion` resource key). *Fix: scope invalidation to directories in the event batch.*
- **P-8g** `list_projects` sync dir-walk + per-project JSON parse on main thread (`commands.rs:91`). *Fix: `async` + `spawn_blocking`.*
- **P-8h** `grammar_check` rebuilds `LintGroup::new_curated` every call (`grammar/mod.rs:63`, on 400ms debounce). *Fix: cache the constructed `LintGroup` (thread_local in the worker).* (confidence low — measure first.)
- **P-8i** Mobile binary size (`Cargo.toml:58-63`, `unverified-on-host`): A/B `opt-level="z"` vs `"s"`; drop reqwest `brotli` feature (allowlisted APIs serve gzip); narrow `tokio` from `"full"` to used features. LTO config is already optimal — no change.

---

## Phase 2 — Security (Tauri v2 model)

> Threat model (per CLAUDE.md): local user trusted; adversaries = malicious project content + attacker-controlled remote content; webview XSS ⇒ arbitrary IPC. Most documented invariants **hold**; the committed surface validated paths, which-resolved spawns, the http allowlist + redirect policy, OAuth provider-allowlisting, bounded readers. The uncommitted `webdav.rs` change is a **sound hardening**. The findings below are gaps/regressions.

### SEC-1 · `template_save` reads from an ungated renderer-supplied root → arbitrary file read/exfiltration — **High** (confirmed) · `windows/macos/linux`
`templates.rs:226-231` — canonicalizes & walks renderer-supplied `project.root_path` with **no `is_registered_root` gate** (only `root_file` is validated). Sibling `export_project_zip` gates via `checked_project_root_and_file`. A compromised webview can `template_save({root_path:"C:/Users/x/.ssh", ...})` to copy `~/.ssh`/`~/.aws`/`.env` into app-data, then `template_instantiate` into the projects root and `read_project_text_file` the copies — defeating the opened-roots registry. (Verified High, not Critical: requires XSS prerequisite.)
**Fix:** `if !project::is_registered_root(Path::new(&project.root_path)) { return Err(..) }` at the top of `template_save`.

### SEC-2 · `overleaf_import_zip` extracts to an ungated renderer-supplied destination → out-of-sandbox write — **High** (confirmed) · `all`
`overleaf.rs:74-85` — `parent_dir` (renderer-supplied) is `join`ed + `create_dir_all` + `extract_zip`'d with **no projects-root gate**, unlike `git_clone` (`validate_new_repo_path`, `git.rs:139`). In-zip traversal is blocked, but the base dir is attacker-chosen → write attacker-controlled file trees anywhere writable (create-only, no overwrite). Regression vs the 2026-06-14 "renderer roots gated to opened projects" invariant.
**Fix:** `if !project::is_new_path_under_projects_root(&dest) { return Err(..) }` before `create_dir_all`/extract.

### SEC-3 · WIP `credentials.rs` narrows `frontend_read_allowed` → breaks Supabase session restore + Mendeley — **High** (confirmed, uncommitted WIP) · `all`
`credentials.rs:140-142` — the uncommitted edit reduces the allow-list to only `supabase.entitlements`. But `storage.ts:51` (`getChunkedCredential "supabase.session"`) and `mendeley/auth.ts:77,214` still `credential_get` → `ReadForbidden`. Result: **signed-in users logged out every launch** (session can't restore → entitlements drop to free tier) and Mendeley reference sync breaks. The in-file test was updated to match, so `cargo test` passes and **masks the runtime break**.
> **Verifier correction:** the finding's Dropbox claim is **wrong** — `src/integrations/cloud/dropbox/` has zero `credential_get` calls (Dropbox reads tokens via `authRef` resolved in Rust), so Dropbox sync is **unaffected**. Only Supabase session + Mendeley break.
**Decision needed (your WIP):** either (a) restore `supabase.session` + `mendeley` to the allow-list, or (b) finish migrating those reads into Rust/authRef before landing the narrowing. See "WIP decision" below.

### SEC-4 · `template_instantiate` writes a new project tree to an ungated destination parent — **Medium** · `all`
`templates.rs:152-163` — `dest_parent` renderer-supplied, `create_dir_all` with no projects-root gate (unlike `create_project`). Create-only + template-derived names bound it, but it's an out-of-sandbox file-creation primitive (custom-template content can be attacker-seeded via SEC-1).
**Fix:** gate `dest_parent`/`dest` with `project::is_new_path_under_projects_root` before creating dirs.

### SEC-5 · CSP `connect-src` lists ~10 third-party API hosts the webview never contacts — **Medium** · `all`
`tauri.conf.json:27` — there are **zero `fetch()` calls** in `src/`; all third-party traffic is proxied through the Rust `http_request` IPC (not CSP-bound). Only supabase-js connects directly. Leaving Zotero/doi/arXiv/Mendeley/Dropbox/Gemini/GitHub/OpenAI/Anthropic in `connect-src` hands an XSS payload ready-made exfil endpoints (e.g. POST stolen text to `api.openai.com`).
**Fix:** reduce `connect-src` to `'self' ipc: http://ipc.localhost https://*.supabase.co`; keep loopback http/ws origins in a dev-only CSP. *(Verify no direct fetch before cutting.)*

### SEC-6 · CSP `img-src` wildcard `https:` → tracking beacons from previewed content — **Medium** · `all`
`tauri.conf.json:27` + `MarkdownPreview.tsx:18,122-139`. Opening a malicious `.md` (normal action on imported/cloned content, no XSS needed) beacons the user's IP + open-time to attacker-chosen hosts via `<img src>`; the wildcard also reopens a GET-exfil channel.
**Fix:** drop `https:` from `img-src` (keep `'self' file: data: blob:`); have `MarkdownPreview` strip/skip remote-origin images (or gate behind a per-project opt-in).

### SEC-7 · fs plugin grants webview read/write/remove/mkdir over all `$DOCUMENT/**`, bypassing the registered-roots gate — **Medium** · `windows/macos/linux`
`capabilities/default.json:9-66`. Custom project IPC is gated to opened roots, but directly-exposed `@tauri-apps/plugin-fs` (used by FileTree, PdfViewer, ConflictResolverDialog, cloud engine) enforces only the static `$DOCUMENT/**` scope → XSS can read/modify/delete any file under Documents, not just Typeward projects.
**Fix:** scope the fs-plugin allow-lists to the projects subtree (e.g. `$DOCUMENT/Typeward/**`) or route that file IO through the registered-root-gated custom IPC. *(Higher-touch — see Batch 2 note.)*

### SEC-8 · Markdown preview loads arbitrary remote images from untrusted `.md` — **Low** · `all`
`MarkdownPreview.tsx:18,126-132` (the frontend side of SEC-6). *Fix: same as SEC-6 — restrict to data + rewritten local `file://`.*

### SEC-9 · `start_lsp` spawns texlab/tinymist with an ungated renderer-supplied `current_dir` — **Low** · `windows/macos/linux`
`lsp.rs:81-103` — `current_dir(&args.project_root)` with no `is_registered_root` check (compile/synctex/watch_project all gate). Binary is which-resolved (no planting RCE) but on Windows the child CWD is in the default DLL search path → planted-DLL load risk. Defense-in-depth inconsistency.
**Fix:** reject when `!project::is_registered_root(Path::new(&args.project_root))` at the top of `start_lsp`.

### SEC-10 · `detect.rs` `run_version` spawns bare binary names instead of which-resolved paths — **Low** · `windows`
`detect.rs:60` — `probe_one` resolves via `which::which(name)` then `run_version(name)` spawns `Command::new(name)` (bare). On Windows `CreateProcess` searches CWD first — deviates from the which-resolved-absolute-path anti-planting invariant (low exploitability: app CWD normally isn't attacker-writable).
**Fix:** pass the which-resolved absolute path into `run_version`.

### SEC-11 · Single all-platform capability ships desktop-only `shell:allow-execute` to mobile + exposes it to the webview — **Low** · `all`
`capabilities/default.json:84-99` — no `"platforms"` filter, so the tectonic sidecar grant ships on iOS/Android (dead) and exposes `plugin:shell|execute` to the main webview though only the Rust compile path uses it. Args are validator-pinned + shell-escape off, but cwd is unconstrained (DoS/artifact-write bounded).
**Fix:** move the sidecar exec grant into a desktop-only capability (`"platforms": ["macOS","windows","linux"]`), ideally non-webview-scoped.

### SEC-12 · `style-src 'unsafe-inline'` residue — **Low** · `all`
`tauri.conf.json:27`. With a wildcard img-src this enables CSS attribute-selector → background-image beacons. Hard to remove (KaTeX/Tailwind inline styles). *Fix: treat as residual; neutralized by fixing SEC-6 (img-src).*

### SEC-13 · No updater/signing pubkey with `bundle.targets: "all"` — **Low / baseline** · `all`
`tauri.conf.json:30-42`. Direct-download builds (MSI/DMG/AppImage) have no signature-verified in-app update path. Matches the documented store-first strategy — flagged as an implication. *Fix: add the updater plugin + pinned pubkey if/when direct-download channels ship; else document store-only updates.*

---

## Phase 3 — Correctness, a11y, UX, dependencies

### C-1 · `AiView` never aborts the in-flight AI stream on unmount → leaks paid-API token generation — **Medium** · `all`
`AiView.tsx:30-105` — `abortController` held in a plain var, **no `onCleanup`**. Switching the preview pane / closing the project / navigating mid-stream orphans the `for-await` loop; `aiStream`'s `finally` only `unlisten()`s (does not call `ai_stream_abort`). The Rust task + upstream HTTP run to completion, **billing tokens with no way to stop** (Stop button unmounted).
**Fix:** `onCleanup(() => abortController?.abort())` in `AiView`.

### C-2 · Save failure (Mod+S) gives no user-visible error — **Medium** · `all`
`actions.ts:41-61` — `saveActiveFile` re-throws on failed write (read-only/disk-full/permission); dispatched as `void saveActiveFile()` (`text-shell.tsx:91`). Only outcome = telemetry + unhandled rejection; the user believes their work saved.
**Fix:** surface save failures in the UI (status-bar/toast).

### C-3 · `ConflictResolverDialog` destructive resolutions swallow IO errors — **Medium** · `all`
`ConflictResolverDialog.tsx:93-135` — `keepMine`/`keepTheirs` await `remove()`/`writeTextFile()` invoked as `void keepMine(entry)` with no try/catch. On failure the promise rejects silently, `clearConflict()` never runs, the conflict lingers — the user can't tell if their local copy was replaced.
**Fix:** try/catch each resolution, render failure, only `clearConflict` on success.

### C-4 · Hand-rolled select dropdowns lack listbox/combobox ARIA + arrow-key nav — **Medium** · `all`
`SettingsScreen.tsx:922-964` (`SelectStub`), `ReferencesPanel.tsx:467-634` (`FlatSelect`/`TreeSelect`), `ProjectsScreen.tsx:502-533` (sort menu) — trigger `<button>` + option `<button>`s with no `role=combobox/listbox/option`, no `aria-expanded/haspopup`, no Up/Down/Home/End. (CommandPalette already models the correct pattern.)
**Fix:** add combobox/listbox/option roles + arrow-key nav (or back them with Kobalte Select/Combobox).

### C-5 · Async handlers that fail silently — **Low** · `all`
- **C-5a** Settings disconnect/remove-key handlers (`IntegrationsPanel.tsx:205,336,497,607,790,1010`) — no try/catch; row stays "Ready" on keyring-delete failure.
- **C-5b** References Refresh (`ReferencesPanel.tsx:268-274`) — `refreshLibraryBib` can throw; button silently does nothing.
- **C-5c** Sync-error badge non-actionable (`SyncStatusBadge.tsx:52-77`) — `disabled` when conflicts=0, so an `error` phase shows red but isn't clickable; no per-provider error anywhere.
- **C-5d** FileTree renders empty on a failed dir read (`FileTree.tsx:87-90`) — reads as "empty folder".
**Fix:** wrap in try/catch + inline error/retry surfaces.

### C-6 · Icon-only buttons rely on `title` alone for accessible name — **Low** · `all`
`PdfViewer.tsx:344-368`, `LogsDrawer.tsx:160-169`, `FileTree.tsx:95-107` — lucide SVGs + `title` only (inconsistent with the rest of the app, no tooltip on touch).
**Fix:** add `aria-label` alongside `title`.

### C-7 · Tablet tab close button below 44px touch target — **Low** · `ios/android`
`text-shell.tsx:583-585` — `h-9 w-9` (36px) vs the project's 44px tablet standard.
**Fix:** raise to `h-11 w-11`.

### Dependencies (Phase 0)

- **D-1 · `quinn-proto` RUSTSEC-2026-0185 (CVSS 7.5) — Low (unreachable).** In `Cargo.lock` but **not in the normal build tree** (`cargo tree -i quinn-proto -e normal` empty — reqwest `http3`/QUIC off). Audit noise. *Fix: `cargo update -p quinn-proto` to clear the warning; not urgent.*
- **D-2 · `git2` 0.20.4 — RUSTSEC-2026-0183/0184 "unsound" — Low.** UB in `Remote::list()` / `Signature` from buffer-created `BlameHunk`. We use remotes (fetch/pull/push). *Fix: bump `git2` when a patched release is available; track.*
- **D-3 · keyring v3 has no Android backend — Medium · `android` (`unverified-on-host`).** Features cover apple/windows/secret-service, not Android Keystore → every `credential_*` fails on Android. *Fix: add an Android keyring backend (cfg-gated) before shipping Android.*
- **D-4 · `git2 "https"` pulls OpenSSL on Android — Medium · `android` (`unverified-on-host`).** Android/Linux use OpenSSL (libgit2-sys) → Android cross-compile needs vendored/NDK OpenSSL though git is desktop-only on mobile. *Fix: `#[cfg(desktop)]`-gate the git2 dep + IPC module, or vendor OpenSSL for Android.*
- **D-5 · Maintenance bumps — Low.** `rand` 0.8→0.9 (OsRng relocation, `gen`→`random`; backs OAuth PKCE), `dirs` 5→6; npm minors (`@codemirror/*`, `vite` 8.0.16→8.1, `nanoid`, `@types/node`). Schedule, note breaking changes.
- **D-6 · Transitive unmaintained/unsound (accept) — Low · mostly `linux`.** gtk-rs GTK3 bindings, `glib` unsound, `memmap2`, `bincode`, `paste`, `proc-macro-error`, `unic-*` — all transitive via tauri's Linux webkit stack / build deps; not directly fixable. Track upstream.
- **D-7 · Build-fragility (no action) — Low.** `texlive-wasm` `file:` sibling dep needs its `dist/` built (CI already does); `esbuild` devDep retained because `@tailwindcss/node` calls `transformWithEsbuild` under Vite 8/Rolldown — intentional.

---

## Severity summary (deduped — verified adjustments applied)

| Sev | Phase 1 (perf) | Phase 2 (security) | Phase 3 (correctness/deps) |
|-----|----------------|--------------------|----------------------------|
| **Critical** | — | — | — |
| **High** | — | SEC-1, SEC-2 | SEC-3 (WIP regression) |
| **Medium** | P-1, P-2, P-3, P-4, P-5, P-6, P-7 | SEC-4, SEC-5, SEC-6, SEC-7 | C-1, C-2, C-3, C-4, D-3, D-4 |
| **Low** | P-8a…i | SEC-8…13 | C-5, C-6, C-7, D-1, D-2, D-5, D-6, D-7, CP-1 |

*(Raw audit returned 47 findings; ~42 unique after de-duplicating overleaf/template_instantiate/credentials cross-reports. The two perf "Highs" P-1/P-2 were downgraded to Medium by adversarial verification.)*

---

## Execution plan — lowest-risk-first batches

Run after **every** batch: `cargo build` + `cargo clippy --all-targets` + `cargo test` (manifest `src-tauri/Cargo.toml`) and `npm run build` + `npm test`. Items tagged `unverified-on-host` need confirmation on the target OS.

**Batch 0 — WIP decision (blocks SEC-3, your call):** decide how to land the uncommitted `credentials.rs` change — restore `supabase.session` + `mendeley` to the allow-list, OR migrate those reads into Rust first. (`webdav.rs` hardening looks sound and can stay.)

**Batch 1 — Security gating gaps (High value, lowest risk; additive guards mirroring existing siblings):** SEC-1 (`template_save`), SEC-2 (`overleaf_import_zip`), SEC-4 (`template_instantiate`), SEC-9 (`start_lsp`), SEC-10 (`detect.rs run_version`). Each = a 1–3 line gate using `is_registered_root` / `is_new_path_under_projects_root`. Verify legit callers pass registered/projects-root paths.

**Batch 2 — CSP & capabilities least-privilege:** SEC-5 (connect-src), SEC-6/SEC-8 (img-src + MarkdownPreview remote images), SEC-11 (desktop-only shell capability). SEC-7 (fs-plugin scope) is higher-touch — handle separately after confirming FileTree/PdfViewer/cloud paths still resolve. *Test the app's real network/image/compile paths.*

**Batch 3 — Move blocking IO off the main thread (top perf wins, mechanical):** P-1, P-3, P-4, P-5, P-8g — `async fn` + `spawn_blocking`, following `compile_typst`/`export_project_zip`. Telemetry append-only + lazy trim.

**Batch 4 — Binary IPC raw bytes (bigger, Rust+frontend):** P-2 — `tauri::ipc::Response` + ArrayBuffer/Channel uploads; update `ipc/index.ts`, `webdav/ipc.ts`, cloud engine. Higher risk — isolate.

**Batch 5 — Frontend cold-launch & bundle:** P-6 (lazy supabase), P-8a (katex CSS), P-8b (font subsets), P-8c (actions.ts import), P-8d (splash timing).

**Batch 6 — Frontend correctness/UX/a11y:** C-1 (AiView abort — stops billing leak), C-2 (save errors), C-3 (conflict errors), C-4 (dropdown a11y), C-5 (silent handlers), C-6 (aria-labels), C-7 (tablet target).

**Batch 7 — PdfViewer virtualization:** P-7 — IntersectionObserver windowing + DPR cap. Larger, isolate; test scroll/zoom/recompile/SyncTeX.

**Batch 8 — Dependencies & mobile hardening (much `unverified-on-host`):** D-1 (`cargo update -p quinn-proto`), D-3/D-4 (`#[cfg(desktop)]`-gate git2 + Android keyring backend), CP-1 (gate subprocess IPC to desktop), D-5 (maintenance bumps), P-8i (mobile size A/B). Reason about, flag what to verify per target.

### Verify on non-host platforms (cannot build here)
- **Android:** keyring backend (D-3), git2/OpenSSL link (D-4), texlive-wasm compile path, cleartext-traffic resolves false in release.
- **iOS:** project not generated — when running `tauri ios init`, keep ATS enabled (no `NSAllowsArbitraryLoads`), add only required usage strings, exclude the desktop shell-exec grant via per-platform capabilities (SEC-11).
- **Linux (WebKitGTK):** cold-launch/bundle perf wins (P-6/P-8) matter most here; GTK3 transitive advisories (D-6).
