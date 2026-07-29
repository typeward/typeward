# Upgrade Notes — 2026-07-29 modernization pass

Every dependency bump applied in this pass, the migration steps taken, and the
things you must do by hand. Companion to `docs/AUDIT.md`.

## Rust (`src-tauri/Cargo.toml` + `Cargo.lock`)

| Crate | From → To | Kind | Notes / migration |
|---|---|---|---|
| libgit2-sys | 0.18.4+1.9.3 → 0.18.7+**1.9.6** | security, lockfile-only | Clears the libgit2 1.9.5 CVE cluster (submodule path traversal CVE-2026-53584 in the clone flow; auth-callback host confusion after redirect CVE-2026-53586; delta-header alloc DoS; inverted SAN check; smart-transport OOB read). git2 0.20.4 accepts `^0.18.3`, so no code changed. `cargo audit` did not flag it (no RUSTSEC entry yet) — done proactively from the libgit2 release notes. |
| ammonia | 4.1.3 → 4.1.4 | security, lockfile-only | RUSTSEC-2026-0213 (SVG `animate`/`set` XSS); transitive via harper. Harper output is text-rendered in the CM6 lint UI here, not an HTML sink — patched anyway. |
| tokio | 1.52.3 → 1.53.1 | currency | 1.x semver, no code. |
| tauri (+ tauri-build/runtime/runtime-wry/codegen/macros/utils, tray-icon) | 2.11.1 → **2.11.5** | currency | Patch line: scope + listener deadlock prevention, **Windows HDC handle leak fix** (undecorated-window resize perf on the ship platform), async custom-protocol handler loading. No capabilities/permissions/fs-scope model change. GHSA-7gmj-67g7-phm9 (origin confusion, Win/Android) was already patched in 2.11.1 — keep the ≥2.11.1 floor. |
| tao | 0.35.2 → 0.35.3 | currency | In-range for tauri 2.11 (do not chase 0.36 until tauri bumps its requirement). |
| tauri-plugin-single-instance | 2.4.2 → 2.4.3 | currency | macOS: tokio UnixListener (yields instead of blocking a thread). |
| **harper-core / harper-tex / harper-typst** | 2.5.0 → **2.7.0** | major-ish | Upgraded to the crates.io release; **`vendor/harper-core` + the `[patch.crates-io]` block deleted**. Grammar tests + a clean release build verified. See the "harper vendor patch" note under Verification below. |
| quick-xml (direct) | already 0.41.0 | — | Load-bearing for WebDAV PROPFIND parsing — keep the ≥0.41 floor. The residual transitive 0.39.4 (RUSTSEC-2026-0194/0195) is pinned by `wayland-scanner`, a Linux build-time proc-macro parsing trusted vendored XML — not runtime-exploitable; kept as a documented, dated `cargo audit` ignore in `tests.yml`. |

**Rust toolchain** pinned via new `src-tauri/rust-toolchain.toml` (channel 1.94.1
+ rustfmt/clippy) so CI stops floating on `stable`. A later bump to 1.97.1 is a
separate, deliberate step (re-run clippy + tests first).

### Deliberately NOT bumped (needs-decision — see AUDIT §3.1)
- **git2 0.20 → 0.21** (clears RUSTSEC-2026-0183/0184, unsound APIs we don't call
  — `Remote::list`, `BlameHunk`): accessor return types changed
  (`Option<&str>` → `Result<...>`), needs mechanical edits in `vcs/git.rs`.
- **sentry 0.46.2 → 0.48.5** (unpin): 0.48.2's `rustls-no-provider` feature lets
  reqwest 0.13 build without aws-lc; the lockfile already proves ring works via
  tauri-plugin-updater. Left pinned this pass to avoid churn in the same PR;
  low-risk to take next.
- **zip 2 → 8** (removes 3 duplicate zip builds; harper already on 8.6): MSRV 1.88
  (met). APIs we use are stable across 3–8.
- **keyring 3 → 4**, **lopdf 0.43 → 0.44**, **which 7 → 8**, **notify 9-rc**,
  **reqwest 0.13 (direct)**, **edition 2021 → 2024** — all opt-in.

## npm (`package.json` + `package-lock.json`)

| Package | From → To | Kind | Notes |
|---|---|---|---|
| nanoid | 5.1.14 → 5.1.16 | security | GHSA-28wg-ghj8-5hjv (negative-size infinite loop). Same API. |
| dompurify | 3.4.11 → 3.4.12 | security | `CUSTOM_ELEMENT_HANDLING` hook bypass — we don't use that config, patched anyway. |
| markdown-it | 14.1 → 14.3 | security | Pulls linkify-it 5.0.2 (GHSA-v245 `mailto:` DoS — the `.md` preview linkifies untrusted text). |
| (postcss, brace-expansion) | — | security | Dev-tree advisories cleared as a side effect of the vite/tailwind bumps; `npm audit` is clean (0). |
| @solidjs/router | 0.16.1 → **1.0.0** | major | Changelog: functionally identical to 0.16.x, no breaking changes (stability release). Range widened to `^1.0.0`. 575 tests + build pass. |
| solid-js | 1.9.13 → 1.9.14 | currency | |
| vite / vitest / vite-plugin-solid | 8.0.16→8.1.5 / 4.1.9→4.1.10 / 2.11.12→2.11.14 | currency | Rolldown-Vite; no config change. |
| tailwindcss + @tailwindcss/vite | 4.3.1 → 4.3.3 | currency | Lockstep. |
| pdfjs-dist | 6.0.227 → 6.2.108 | currency | Only api-minor change (`getDestinations`/`getViewerPreferences`/`getOpenAction` now return `Map`) is grep-verified unused. |
| CodeMirror | view 6.43.4→6.43.7, state 6.6→6.7.1, commands 6.10.3→6.10.4, language 6.12.3→6.12.4, lang-markdown 6.5→6.5.1 | currency | Visual-editor freeze + equivalence tests pass. |
| @replit/codemirror-vim | 6.3 → 6.4 | currency | |
| @kobalte/core | 0.13.11 → 0.13.12 | currency | |
| @supabase/supabase-js | 2.108.2 → 2.111.0 | currency | Above the ≥2.106 floor for `sb_publishable_` keys. |
| @sentry/browser + @sentry/vite-plugin | 10.63→10.69 / 5.3→5.4 | currency | Crash-only config + dynamic-import gate unchanged. |
| lucide-solid | 1.21 → 1.27 | currency | |
| fontsource inter/jetbrains-mono | 5.2.8 → 5.3.0 | currency | |
| @tauri-apps/cli | 2.11.3 → 2.11.4 | currency | AppImage relative-symlink fix (we ship AppImage). |
| @tauri-apps/plugin-dialog | 2.7.1 → 2.7.2 | currency | Android-only fix. |

### Deferred npm (needs-decision)
- **TypeScript 6.0.3 → 7.0.2** — TS 7 GA'd 2026-07-08 (native Go tsc, ~8–12×
  faster; no type-system change; 6.x is frozen, no 6.1). We use the tsc CLI only.
  tsconfig looks 7-compatible; attempt on a branch, keep ~6.0.3 as the fallback.
- **katex 0.17 → 0.18.1** — 0.18 is a BREAKING minor (internal CSS class prefixes
  changed); audit theme CSS + `MarkdownPreview` + visual-editor math styles for
  KaTeX-internal selectors first.
- **jsdom 29 → 30** — needs Node ≥22.22; align the Node floor first.
- **nanoid 5 → 6** — drops Node 18/20; stay on 5.x.

### Tooling not adopted (with reasons)
- **ESLint** — adding eslint 9 reintroduces a dev-only `brace-expansion` DoS
  advisory with **no upstream fix** in eslint's dep line (eslint-plugin-solid caps
  eslint at 9; eslint 10 would clear it), which would take `npm audit` from 0 back
  to 6 high. Deferred until eslint-plugin-solid supports eslint 10. The 3 existing
  `eslint-disable` comments are harmless no-ops meanwhile.
- **Prettier** — the repo has a consistent hand-maintained style; Prettier's
  defaults disagree with 293 of 326 files, so adopting it means a one-time
  293-file mass reformat — a maintainer decision, not an audit-pass change.
  `.editorconfig` (added) covers the low-risk part.

## Manual steps required of you

1. **Nothing blocking** for local dev or the existing (dormant) release — every
   change above is applied and the build/tests pass on this host.
2. **Before the next `cargo` run on a fresh machine**: `rustup` will auto-install
   the pinned 1.94.1 toolchain from `rust-toolchain.toml`. To move to 1.97.1
   later, bump the channel there + the `toolchain:` in the three workflows, then
   re-run clippy/tests.
3. **CI**: the new `cargo clippy -- -D warnings` gate means any new warning fails
   CI — keep clippy clean. The Windows cargo-test leg needs no new secrets.
4. **No signing keys, store metadata, or CI secrets changed.** The release
   pipeline's dormancy switches are untouched.
