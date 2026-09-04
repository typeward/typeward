# Rust backend notes

Loads when you work under `src-tauri/`. The root `CLAUDE.md` has the project-wide rules.

## Threat model

The local user is trusted. Adversaries are **malicious project content** (cloned repos, Overleaf zips, custom templates, `.tex`/`.bib`/`.md`/log files) and **attacker-controlled remote content** (cloud-synced files, Zotero/Mendeley records, git remotes, AI endpoints). Webview XSS equals arbitrary IPC, which equals file write plus process spawn, so every command below is a security boundary.

## Security invariants: do not regress these

- **Project file IO goes through the custom IPC**, never raw absolute paths: `read_project_text_file` / `read_project_binary_file` / `write_project_text_file` / `write_project_binary_file`. They validate canonical project-relative paths. Compile commands also validate `project.rootFile`.
- **Renderer-supplied roots are gated to opened projects.** `project.rs` keeps a registry; `register_root` is called only from `open_project` / `list_projects` / `create_project` / `import_project_folder` after those prove the root is registered or under the configured projects root. Read/write, compile, snapshots, synctex, `set_project_integrations` and `watch_project` all check `is_registered_root`. Without this, XSS reads `~/.ssh`.
- **Project-relative paths reject leading-dash components** (`validate_project_relative_path`). `rootFile` becomes a positional argument to latexmk/pdflatex/tectonic/typst, so a file named `-shell-escape` would be parsed as a flag.
- **`include_only` is validated as TeX code, not just a path.** Chapter drafts splice names into `\includeonly{...}`, so `validated_include_only` also rejects `\ { } $ % # ~ ^ &` `"` and ASCII controls. Keep the allowlist tight.
- **Spawn `which`-resolved absolute paths, never bare names.** `Command::new("latexmk")` plus `current_dir(project)` lets Windows resolve the program against the *project* directory first, so a planted `typst.exe` runs. Route every spawn through `detect::resolve_program`.
- **Every self-built `Command` needs `detect::hide_console` / `hide_console_async`.** Release builds are `windows_subsystem = "windows"`, so a console child without `CREATE_NO_WINDOW` allocates a visible console window. Piped stdio does not suppress it, and `tauri dev` never reproduces it.
- **Writes must not follow symlinks.** `write_project_binary_file` rejects a symlink leaf; text writes use `fs_ops::atomic_write`, which `create_new`s an unpredictable temp file before rename so a malicious project cannot pre-plant `.name.tmp`.
- **Privileged IPC is main-window only** (`ipc_guard.rs`). Capabilities scope plugin commands per window, but every `#[tauri::command]` is registered through one `generate_handler!`, so the `invoke_handler` checks the window label. `NON_MAIN_WINDOW_COMMANDS` is today `custom_themes_list` + `load_settings`. Adding to it is a security decision: the detached preview window renders attacker-supplied PDFs.
- **Outbound HTTP goes through `http::outbound_client_builder()`**, which installs `allowlist_redirect_policy()`. The allowlist is re-validated on *every* redirect hop, not just the initial URL, or an allowlisted open redirect becomes an SSRF primitive.
- **WebDAV has its own SSRF-screened client** (`integrations/webdav.rs`), not the fixed allowlist, because the host is user-supplied. It resolves, screens every resolved IP (loopback / link-local / cloud metadata / `0.0.0.0` always blocked; RFC1918 only with opt-in), pins the connection to the vetted IP, screens numeric-literal hosts, and follows only same-host https redirects. A host is accepted only if it matches a persisted, user-confirmed account. `request_url` rejects `.`, `..` and `.typeward` segments. `webdav_enroll_probe` is the one command not resolving its account from settings, so it recomputes the account id from host + username and requires a match.
- **PROPFIND XML is parsed in Rust with `quick-xml`** (non-validating, so immune to XXE), never the webview DOMParser.
- **OAuth endpoints are provider allowlisted** in `oauth_begin` (today only `api.mendeley.com`). Extra params cannot override PKCE core fields. The `redirect_uri` override is loopback-only.
- **Loopback HTTP is not general egress.** `is_allowed_loopback_url` pins plaintext loopback to Zotero (23119) and Ollama (11434 or the configured port). An arbitrary-port allowance is a localhost port scanner.
- **The frontend cannot read keyring secrets.** `credentials.rs` exposes only `credential_set`, `credential_exists`, `credential_delete`. Secrets are resolved inside Rust via `authRef`, bound to expected hosts. Do not add a generic read.
- **Secure storage never silently mocks.** `keyring` 3.x has no Android backend and falls through to an in-memory store where a write "succeeds" and the next read returns `None`. `ensure_secure_storage` makes that a hard error.
- **Tectonic compiles `--untrusted`** unless the per-machine shell-escape trust grant applies (`trust.rs`).
- **Zip and template import are bounded**: 5k entries, 500 MB uncompressed, and entries rejecting symlinks, `.typeward`/`.git`, traversal, absolute paths and leading dashes.
- **IPC error contract**: every `#[tauri::command]` maps its typed error to `String` at the boundary (`.map_err(|e| e.to_string())`); internal fns keep `thiserror`. A serialized enum surfaces as `[object Object]` in the webview. Never put secrets, tokens, or response bodies in error strings.

## Traps that cost real debugging time

- **Sync commands run outside the tokio runtime.** Calling `tokio::spawn` from a sync `#[tauri::command]` panics with "no reactor running" and aborts the process (Windows reports `0xc0000409`). Mark anything touching tokio `pub async fn`. See `watcher.rs::watch_project`.
- **`validate_projects_root` needs an anchor and mobile has none.** `dirs::document_dir()` is `None` on Android/iOS and on Linux without `xdg-user-dirs`, which meant no setting could ever persist. `root_anchor()` resolves Documents, then the mobile-seeded app-data anchor, then `~/Documents`. Seed it before the first `settings::load`, which sanitizes against the same anchor.
- **Tauri 2 fs plugin scope is static capability entries UNION the runtime scope**, and a runtime *forbid* beats both. Static entries in `capabilities/default.json` cover only the default projects root plus resources, and `lib.rs::grant_projects_root_fs_scope` adds the configured root at startup and from `save_settings`. Dialog-picked paths are added by the dialog plugin. Do not reintroduce a Documents-wide static grant. `fs:allow-read-file` (binary) is separate from `fs:allow-read-text-file`; PDFs need the binary one.
- **Compile subprocesses are bounded.** `run_bounded` enforces a 10-minute timeout and a head+tail-capped capture (4 MiB head + 256 KiB rolling tail, so TeX's trailing `! ...` lines survive), and kills the whole process tree on deadline (`taskkill /T`, or `setsid` + group SIGKILL). A timeout does not trigger the latexmk-to-pdflatex or sidecar-to-PATH fallbacks. Route new spawns through it.
- **Git is desktop-only at the dependency level.** `git2`'s `https` feature links openssl-sys on non-Apple unix including Android, which kills that build. `git2` sits in the `cfg(not(any(target_os = "android", target_os = "ios")))` section, `integrations::vcs` is `#[cfg(desktop)]`, and every `git_*` command is gated to match. On mobile the git IPC **does not exist**; the frontend must treat VCS as absent, not failing.
- **Git rides on the user's own setup.** Identity comes from gitconfig via `repo.signature()`, credentials from the user's git credential helper via `Cred::credential_helper`. The app stores no git credentials. The callback refuses non-matching hosts and caps at 3 attempts. HTTPS only; `git_pull` is fast-forward only and requires a clean worktree.
- **`.typeward` and git compose via `.git/info/exclude`**, never the user's `.gitignore`. `is_sidecar_path()` also filters it out of `git_status`, `ensure_clean_worktree` and the `git_stage` add-all default. Keep both layers.
- **Keyring records must stay short.** Windows Credential Manager silently fails above 2560 bytes. Every secret is one key or token; there is no chunking layer.
- **Keyring on Linux blocks on D-Bus**, so every `credential_*` handler wraps the sync API in `spawn_blocking`. New callers must too.
- **macOS GUI PATH**: Finder launches inherit launchd's minimal PATH, so `detect.rs::fix_gui_path()` runs at the very top of `run()`, before the builder, because the env mutation is only sound single-threaded. Without it every `which`-based probe, compile, LSP and SyncTeX spawn fails unless launched from a terminal.
- **SyncTeX shells out to the system `synctex` CLI**, not a binding. It returns `Ok(None)` when absent, so Tectonic-only users get "no sync" rather than an error.
- **The compile fallback chain is deliberate**: the `system-tex` engine tries `latexmk` and falls back to `pdflatex` on spawn or exit failure (MiKTeX sometimes ships latexmk without a usable Perl); the `tectonic` engine tries the bundled sidecar first, then `tectonic` on PATH. A `run_bounded` timeout triggers neither fallback, since that would double the wait.
- **Backend-owned settings survive a renderer roundtrip.** `settings::merge_backend_owned` carries fields the frontend must not clear (the profile's `avatarPath` and `localId`, `compile.strictOffline`) forward from disk, because a renderer `buildSettings()` roundtrip would otherwise drop them. The profile picture is *copied* into `<app_data>/profile/` by `set_profile_avatar` alone, with an extension allowlist, symlink rejection and an 8 MiB cap re-checked after the read, so it survives the user moving the original and no read scope has to widen to wherever the picker landed.
- **Grammar (`integrations/grammar/`) runs in-process and is OFF by default.** When `integrations.grammar.enabled` is false there is zero IPC. Diagnostics come back in the same shape as compile and LSP diagnostics so the existing gutter renders them unchanged.

## Config

- **Platform overlays merge with RFC 7386 JSON Merge Patch, where arrays REPLACE rather than append.** `tauri.android.conf.json` / `tauri.ios.conf.json` must restate the full `bundle.resources` list; dropping `templates` from it silently un-bundles the built-in templates. `tauri.no-tectonic.conf.json` uses the same mechanism to zero `bundle.externalBin` for ARM builds.
- **CSP `connect-src` carries exact origins, never wildcards**, and today has no external origins at all. `build.rs` is just `tauri_build::build()` and splices nothing in, so the config file is what ships.
- **`dangerousDisableAssetCspModification: ["style-src"]` is load-bearing, not tidy-up.** Tauri stamps a nonce onto every `<style>` tag it serves and appends that `'nonce-...'` to `style-src`. Under CSP, a nonce in a directive makes `'unsafe-inline'` ignored, so the policy the config declares silently inverts: runtime `<style>` elements and `style="..."` attributes get blocked. CodeMirror mounts its whole theme that way through style-mod, so the editor loses every `.cm-*` rule and renders unstyled with no wrapping or scrolling. `index.html` has one inline `<style>` (the pre-paint boot splash), which is what triggers the injection. This reproduces **only in release**: `tauri dev` loads the page from Vite, whose responses Tauri never rewrites, so the nonce is absent and `'unsafe-inline'` holds. `style-src-elem` / `style-src-attr` are not a fix, WebKit does not implement them, so macOS and Linux would stay broken.
- **Adding a command?** Register it in `lib.rs`'s `generate_handler!` and add a frontend caller, or `src/ipc/drift.test.ts` fails. New commands are main-window-only by default.

## Test

```
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```
