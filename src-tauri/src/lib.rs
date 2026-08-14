mod autosave;
mod commands;
mod compile;
// Subprocess-backed modules are desktop-only: mobile (iOS/Android) has no
// system TeX / language-server / synctex binaries on a PATH to spawn, and the
// frontend never reaches their IPC there (compile routes through texlive-wasm,
// LSP/synctex calls are engine-gated or caught). Gating them keeps the
// subprocess IPC surface off the mobile webview entirely.
// `detect` itself is NOT gated: it owns `resolve_program`, the single
// chokepoint every spawn in the crate resolves through (binary-planting
// invariant), and `compile.rs` compiles on mobile. Its PATH-probe surface —
// the part that actually backs an IPC — stays desktop-only inside the module.
mod detect;
mod drop_allow;
#[cfg(desktop)]
mod export_annotated;
#[cfg(desktop)]
mod export_pandoc;
mod fs_ops;
mod history;
mod index;
mod integrations;
mod ipc_guard;
#[cfg(desktop)]
mod lsp;
mod profile;
mod project;
mod rename;
mod settings;
#[cfg(desktop)]
mod synctex;
mod themes;
mod todo_scan;
mod trust;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer produces black/corrupted frames, flickering
    // hover states, and stuck highlights under virtualized GPUs (VirtualBox,
    // VMware, QEMU without 3D passthrough). Opt out before the first webview
    // initializes — but only in a VM, and never overriding an explicit user
    // setting, since disabling it costs hardware acceleration on real GPUs.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && running_in_vm() {
        // SAFETY: called at the very top of run(), before Tauri spawns any
        // thread that could read the environment concurrently.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }

    let builder = tauri::Builder::default();

    // Single-instance must be the first plugin registered. A second desktop
    // launch (trivial on Windows) is caught here and focuses the running
    // window instead of spawning a rival process that would run duplicate
    // watchers/autosave/sync engines over the same data — the shared cursor,
    // sync-state.json, snapshots, and settings.json all assume one writer.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        use tauri::Manager;
        if let Some(win) = app.webview_windows().values().next() {
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        // "Open with Typeward" on a running instance lands here: the second
        // launch's full argv (argv[0] = the exe path, hence skip), with its
        // cwd anchoring relative paths. Emitted after the focus above so the
        // window is frontmost when the frontend navigates.
        if let Some(path) =
            first_open_with_path(args.into_iter().skip(1), Some(std::path::Path::new(&cwd)))
        {
            open_with::deliver(app, path);
        }
    }));

    // Window-state must register before the config windows are created, or the
    // main window paints at the tauri.conf.json defaults and only then jumps to
    // its restored geometry. Restore/save are automatic Rust-side hooks — no JS
    // API is used, so no capability permission entry is needed.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    // Nothing may navigate the app shell off its own origin. The window has no
    // address bar, back button, or reload affordance, so a navigation is
    // unrecoverable: the SPA and everything it held (unsaved buffers, in-flight
    // compiles, pending debounced writes) is gone, and an attacker page is a
    // credible pixel-copy phish of the very Settings panel that collects the
    // user's Zotero / OpenAI / Anthropic credentials. Malicious project
    // content is an explicit adversary in the threat model, and a `.md` preview
    // renders links straight from it.
    //
    // Registered as a plugin because the main window is created from
    // tauri.conf.json, so there is no builder to hang `on_navigation` off; with
    // no window-level handler Tauri delegates the decision to plugins, and no
    // other plugin in the tree registers one. This is structural — it holds for
    // any future HTML sink, not just the markdown preview.
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard")
            .on_navigation(|_webview, url| {
                let allowed = match url.scheme() {
                    // The custom protocol the webview is served over.
                    "tauri" => true,
                    // Windows serves the app over http://tauri.localhost, and
                    // `tauri dev` over the loopback Vite server.
                    "http" | "https" => matches!(
                        url.host_str(),
                        Some("tauri.localhost") | Some("localhost") | Some("127.0.0.1")
                    ),
                    _ => false,
                };
                if !allowed {
                    eprintln!("[navigation-guard] blocked navigation to {url}");
                }
                allowed
            })
            .build(),
    );

    let builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // Learn which absolute paths the OS actually handed us, independently of
    // anything the renderer claims: `import_files_into_project` copies absolute
    // sources into a readable project, so the webview alone must not be able to
    // name them (see drop_allow.rs). Both event surfaces are registered because
    // the drop routes through the window on some platforms and the webview on
    // others; recording the same path twice is harmless.
    let builder = builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event
                && window.label() == "main"
            {
                drop_allow::record(paths);
            }
        })
        .on_webview_event(|webview, event| {
            let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event
            else {
                return;
            };
            if webview.label() == "main" {
                drop_allow::record(paths);
            }
        });

    // Auto-updater (desktop only): the plugin parses the pubkey lazily at check
    // time, so registering it with the "" placeholder pubkey doesn't touch the
    // signing path at startup. Mobile ships through app stores, not the updater.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let builder = builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            install_macos_menu(app)?;
            // Mobile has no Documents dir (dirs::document_dir() is None), so
            // both the default projects root and the containment check that
            // guards every settings write need another anchor — otherwise the
            // root degrades to a RELATIVE "Typeward" (useless as a trust root,
            // unwritable from an app sandbox cwd) and no setting can ever be
            // saved. Seed it BEFORE the first load: `load` sanitizes the stored
            // root against this same anchor.
            #[cfg(mobile)]
            {
                use tauri::Manager;
                if let Ok(data) = app.path().app_data_dir() {
                    settings::set_root_anchor(data);
                }
            }
            // Seed the project trust boundary (project.rs) from the configured
            // projects root before the webview can issue any IPC, so file IO /
            // compile / git can be gated to the projects area.
            let loaded = settings::load(app.handle()).ok();
            let projects_root = loaded
                .as_ref()
                .map(|s| std::path::PathBuf::from(&s.projects_root))
                .unwrap_or_else(settings::default_projects_root);
            let _ = std::fs::create_dir_all(&projects_root);
            project::set_projects_root(&projects_root);
            // The capabilities grant plugin-fs only the DEFAULT projects root
            // statically; a user-moved root is added here at runtime. Nothing
            // outside the projects subtree is granted by us — tauri-plugin-dialog
            // adds the paths the user picks in a save/open dialog to this same
            // runtime scope, which is what keeps exports outside the root working.
            grant_projects_root_fs_scope(app.handle(), &projects_root);
            integrations::http::set_local_ai_base_url(
                loaded
                    .as_ref()
                    .and_then(|s| s.integrations.ai.ollama_base_url.as_deref()),
            );
            // One-shot hygiene: pre-2026-08-13 builds parked a GitHub
            // device-flow PAT in the keyring (git.github.com /
            // x-access-token). The sign-in surface and every read path are
            // gone, so delete the orphaned secret. Best-effort off the main
            // thread — the Linux Secret Service backend can block on D-Bus.
            #[cfg(desktop)]
            tauri::async_runtime::spawn_blocking(|| {
                let _ = integrations::credentials::delete_secret("git.github.com", "x-access-token");
            });
            // tauri.conf.json's backgroundColor is a static compile-time value
            // (Daylight cream), but the theme is per-user runtime state — dark
            // theme users would get a light flash between window creation and
            // the boot splash re-tint. Repaint the native background from the
            // persisted theme here, before first paint. Cosmetic: errors are
            // swallowed.
            #[cfg(desktop)]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let theme = loaded
                        .as_ref()
                        .map(|s| s.theme.as_str())
                        .unwrap_or("daylight");
                    let theme = if theme == "system" {
                        match win.theme() {
                            Ok(tauri::Theme::Dark) => "lamplight",
                            _ => "daylight",
                        }
                    } else {
                        theme
                    };
                    let bg: tauri::webview::Color = match theme {
                        "lamplight" => (0x0D, 0x0C, 0x0A).into(),
                        "aurora" => (0x0A, 0x0B, 0x0F).into(),
                        "paper" => (0xFA, 0xF9, 0xF6).into(),
                        "dark" => (0x1E, 0x1E, 0x1E).into(),
                        "light" => (0xFF, 0xFF, 0xFF).into(),
                        _ => (0xF8, 0xF4, 0xEA).into(),
                    };
                    let _ = win.set_background_color(Some(bg));
                }
            }
            // First-launch "Open with Typeward": the OS passes the file as a
            // plain argv entry, long before the webview exists. Park it; the
            // frontend drains it as its listener mounts (see `open_with`).
            #[cfg(desktop)]
            if let Some(path) = first_open_with_path(
                std::env::args().skip(1),
                std::env::current_dir().ok().as_deref(),
            ) {
                open_with::deliver(app.handle(), path);
            }
            Ok(())
        })
        .manage(watcher::WatcherManager::default())
        .manage(index::IndexManager::default())
        .manage(integrations::oauth::OauthManager::default())
        .manage(integrations::grammar::GrammarState::default())
        .manage(std::sync::Arc::new(
            integrations::ai::streaming::AiStreamManager::default(),
        ));

    // The LSP child-process manager backs only the desktop texlab/tinymist
    // commands; mobile uses no language servers.
    #[cfg(desktop)]
    let builder = builder.manage(lsp::LspManager::default());

    // Every custom command is registered through this one handler, for every
    // window. `ipc_guard` re-checks the calling window's label so the detached
    // preview webview — a renderer of attacker-supplied PDF content — cannot
    // reach the privileged surface (see ipc_guard.rs).
    let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        #[cfg(desktop)]
        commands::detect_tex,
        commands::list_projects,
        commands::create_project,
        commands::open_project,
        commands::import_project_folder,
        commands::set_project_integrations,
        commands::set_project_deadline,
        commands::set_project_tags,
        commands::set_project_space,
        commands::set_project_trashed,
        commands::set_project_archived,
        commands::touch_project_opened,
        commands::rename_project,
        commands::delete_project,
        commands::duplicate_project,
        commands::set_project_build,
        commands::set_project_root_file,
        commands::rename_project_file,
        commands::delete_project_path,
        commands::create_project_dir,
        commands::duplicate_project_file,
        commands::import_files_into_project,
        commands::move_project_path,
        commands::reveal_project_path,
        trust::shell_escape_trust_get,
        trust::shell_escape_trust_set,
        trust::trust_clear_shell_escape,
        todo_scan::scan_project_todos,
        index::index_project,
        index::unindex_project,
        rename::rename_project_label,
        rename::find_project_references,
        commands::read_project_text_file,
        commands::read_project_binary_file,
        commands::write_project_text_file,
        commands::write_project_binary_file,
        compile::parse_latex_log_cmd,
        compile::compile_clean,
        compile::probe_last_build_output,
        compile::compile_latex,
        compile::compile_typst,
        compile::compile_cancel,
        #[cfg(desktop)]
        synctex::synctex_forward,
        #[cfg(desktop)]
        synctex::synctex_inverse,
        open_with::take_pending_open,
        commands::load_settings,
        commands::save_settings,
        commands::reset_settings,
        profile::set_profile_avatar,
        profile::clear_profile_avatar,
        commands::export_project_zip,
        #[cfg(desktop)]
        export_pandoc::export_pandoc,
        #[cfg(desktop)]
        export_annotated::export_pdf_annotated,
        themes::custom_themes_list,
        themes::custom_theme_write_sample,
        themes::custom_themes_open_dir,
        #[cfg(desktop)]
        lsp::start_lsp,
        #[cfg(desktop)]
        lsp::send_lsp_message,
        #[cfg(desktop)]
        lsp::stop_lsp,
        watcher::watch_project,
        watcher::unwatch_project,
        commands::write_snapshot,
        commands::clear_snapshot,
        commands::list_orphan_snapshots,
        history::history_record,
        history::history_list,
        history::history_list_project,
        history::history_read_version,
        history::history_restore,
        history::history_clear,
        integrations::credentials::credential_set,
        integrations::credentials::credential_exists,
        integrations::credentials::credential_delete,
        integrations::http::http_request,
        integrations::http::http_request_bytes,
        integrations::oauth::oauth_begin,
        integrations::oauth::oauth_wait,
        integrations::oauth::oauth_cancel,
        // Git is desktop-only: `git2`/libgit2 is a desktop-target dependency
        // (its `https` feature drags in openssl-sys on Android), so these
        // commands do not exist on iOS/Android. The frontend must treat the
        // whole VCS surface as absent on mobile, not as failing calls.
        #[cfg(desktop)]
        integrations::vcs::git::git_init,
        #[cfg(desktop)]
        integrations::vcs::git::git_status,
        #[cfg(desktop)]
        integrations::vcs::git::git_stage,
        #[cfg(desktop)]
        integrations::vcs::git::git_unstage,
        #[cfg(desktop)]
        integrations::vcs::git::git_commit,
        #[cfg(desktop)]
        integrations::vcs::git::git_log,
        #[cfg(desktop)]
        integrations::vcs::git::git_branch_list,
        #[cfg(desktop)]
        integrations::vcs::git::git_branch_create,
        #[cfg(desktop)]
        integrations::vcs::git::git_branch_checkout,
        #[cfg(desktop)]
        integrations::vcs::git::git_fetch,
        #[cfg(desktop)]
        integrations::vcs::git::git_pull,
        #[cfg(desktop)]
        integrations::vcs::git::git_push,
        #[cfg(desktop)]
        integrations::vcs::git::git_clone,
        integrations::overleaf::overleaf_import_zip,
        integrations::ai::streaming::ai_stream_start,
        integrations::ai::streaming::ai_stream_abort,
        integrations::grammar::grammar_check,
        integrations::grammar::grammar_add_word,
        integrations::grammar::grammar_remove_word,
        integrations::grammar::grammar_list_words,
        integrations::grammar::grammar_ignore_lint,
        integrations::grammar::grammar_clear_ignored,
        integrations::templates::templates_list,
        integrations::templates::template_instantiate,
        integrations::templates::template_save,
        integrations::webdav::webdav_validate_host,
        integrations::webdav::webdav_status_probe,
        integrations::webdav::webdav_enroll_probe,
        integrations::webdav::webdav_propfind,
        integrations::webdav::webdav_get,
        integrations::webdav::webdav_put,
        integrations::webdav::webdav_delete,
    ];

    builder
        .invoke_handler(move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            let label = invoke.message.webview_ref().label().to_string();
            let command = invoke.message.command().to_string();
            if !ipc_guard::is_allowed(&command, &label) {
                invoke
                    .resolver
                    .reject(ipc_guard::rejection(&command, &label));
                return true;
            }
            commands(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {
            // macOS delivers Finder/document opens via Apple Events — never
            // argv — so the bundle.fileAssociations registration is inert
            // there without this handler. Windows/Linux opens arrive through
            // argv (first launch + the single-instance plugin) instead.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                if let Some(path) = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .find(|p| p.is_file())
                {
                    // Cold launch delivers this within the first event-loop
                    // iterations, well before the webview has loaded the JS
                    // bundle — so it parks rather than emitting into the void.
                    open_with::deliver(_app_handle, path.to_string_lossy().into_owned());
                }
            }
        });
}

/// macOS: swap the stock menu's Quit for one that respects the dirty guard.
///
/// The default menu's Quit item sends `NSApplication terminate:` directly
/// (muda `PredefinedMenuItemType::Quit`), and tao implements no
/// `applicationShouldTerminate:` veto — so Cmd+Q never surfaces as a Tauri
/// event the frontend's `onCloseRequested` dirty-buffer guard could intercept,
/// and unsaved edits would vanish. Rebuilding `Menu::default` verbatim with a
/// custom Quit item routes Cmd+Q through `window.close()` instead: the guard
/// gets its prompt, and once every window is destroyed the app exits normally.
/// (Dock-icon → Quit still terminates directly; tao exposes no hook for it —
/// autosave snapshots + RecoveryDialog remain the backstop there.)
///
/// The menu also carries the app's command surface: items whose ids are
/// frontend CommandRegistry ids (dotted) are forwarded over the
/// "menu:command" event and dispatched by src/lib/menu-bridge.ts, so menu,
/// palette, and shortcuts share one command definition.
/// The `hypervisor` CPU flag is set by every mainstream hypervisor (KVM/QEMU,
/// VirtualBox, VMware, Hyper-V) and absent on bare metal — cheap to read and
/// dependency-free, unlike shelling out to `systemd-detect-virt`.
#[cfg(target_os = "linux")]
fn running_in_vm() -> bool {
    std::fs::read_to_string("/proc/cpuinfo").is_ok_and(|s| {
        s.lines().any(|l| {
            l.starts_with("flags") && l.split_whitespace().any(|f| f == "hypervisor")
        })
    })
}

#[cfg(target_os = "macos")]
fn install_macos_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadata, HELP_SUBMENU_ID, Menu, MenuItem, PredefinedMenuItem, Submenu,
        WINDOW_SUBMENU_ID,
    };

    let handle = app.handle();
    let pkg = handle.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };
    let quit = MenuItem::with_id(
        handle,
        "quit",
        format!("Quit {}", pkg.name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let app_menu = Submenu::with_items(
        handle,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(about))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;
    // The predefined close_window would claim Cmd+W at the NSMenu level and
    // close the whole window on a muscle-memory "close tab". Split it: Close
    // Tab takes Cmd+W (routed to the frontend, which falls back to a window
    // close when no tab is open), Close Window moves to Shift+Cmd+W —
    // the browser convention users already know.
    let close_tab = MenuItem::with_id(handle, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_window = MenuItem::with_id(
        handle,
        "close-window",
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    // App-command items. Each dotted id below is a frontend CommandRegistry id
    // (or one of the two bridge-resolved aliases, noted at the Compile menu)
    // forwarded verbatim by the fallthrough arm in on_menu_event and dispatched
    // through the registry by src/lib/menu-bridge.ts — menu, palette, and
    // shortcuts share one command definition so they can't drift. The id list
    // is mirrored there as MENU_COMMAND_IDS (cross-referenced both ways).
    // Every accelerator here duplicates a webview shortcut the keyboard router
    // already binds: on macOS the NSMenu key equivalent swallows the keystroke
    // before the webview ever sees it, so for these keys the menu path
    // REPLACES the router path rather than double-firing.
    let new_project = MenuItem::with_id(
        handle,
        "core.newProject",
        "New Project",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let save = MenuItem::with_id(handle, "core.save", "Save", true, Some("CmdOrCtrl+S"))?;
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &new_project,
            &save,
            &PredefinedMenuItem::separator(handle)?,
            &close_tab,
            &close_window,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let focus_mode = MenuItem::with_id(
        handle,
        "core.toggleFocusMode",
        "Focus Mode",
        true,
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&focus_mode, &PredefinedMenuItem::fullscreen(handle, None)?],
    )?;
    // "editor.compile" / "editor.stopCompile" are the two bridge-resolved
    // aliases rather than literal registry ids: compile registers per-format
    // (latex.compile / typst.compile — only the open project's adapter is
    // live) and stop-compile has no palette command at all, so menu-bridge.ts
    // maps them. "latex.syncForward" IS the literal registry id; in a Typst
    // project it's unregistered and the click is a silent no-op — the correct
    // menu behavior for an inapplicable action. muda's return-key token is
    // "Enter", not "Return"; an unknown token would SILENTLY drop the
    // accelerator (MenuItem::with_id swallows accelerator parse errors).
    let compile = MenuItem::with_id(
        handle,
        "editor.compile",
        "Compile",
        true,
        Some("CmdOrCtrl+Enter"),
    )?;
    let stop_compile = MenuItem::with_id(
        handle,
        "editor.stopCompile",
        "Stop Compile",
        true,
        None::<&str>,
    )?;
    let jump_to_pdf = MenuItem::with_id(
        handle,
        "latex.syncForward",
        "Jump to PDF",
        true,
        Some("CmdOrCtrl+J"),
    )?;
    let compile_menu = Submenu::with_items(
        handle,
        "Compile",
        true,
        &[&compile, &stop_compile, &jump_to_pdf],
    )?;
    // The magic IDs mark these as NSApp's windowsMenu / helpMenu (Tauri wires
    // them by ID), which is what makes the Window list + Help search work.
    // No close_window here anymore — its Cmd+W accelerator would collide with
    // File > Close Tab (two NSMenu items on one key equivalent), and File >
    // Close Window covers the action.
    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(handle, HELP_SUBMENU_ID, "Help", true, &[])?;
    let menu = Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &compile_menu,
            &window_menu,
            &help_menu,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        use tauri::{Emitter, Manager};
        // Menu accelerators are app-global: resolve the FOCUSED window so
        // Cmd+W over the detached preview closes the preview, not an editor
        // tab in the background main window.
        let focused = handle
            .webview_windows()
            .into_values()
            .find(|w| w.is_focused().unwrap_or(false));
        match event.id().0.as_str() {
            "quit" => {
                // close() (not destroy) so the main window's frontend guard can
                // prompt; a confirmed close destroys it, and with no windows left
                // the app exits on its own.
                for (_, window) in handle.webview_windows() {
                    let _ = window.close();
                }
            }
            // The frontend decides what Cmd+W means in the MAIN window: close
            // the active editor tab if one exists, else fall through to the
            // window-close guard. Any other focused window just closes.
            "close-tab" => match focused {
                Some(w) if w.label() != "main" => {
                    let _ = w.close();
                }
                _ => {
                    let _ = handle.emit_to("main", "menu:close-tab", ());
                }
            },
            // Same close() (not destroy) path as Quit — the dirty-buffer
            // guard must get its prompt when the main window is the target.
            "close-window" => {
                let target = focused.or_else(|| handle.get_webview_window("main"));
                if let Some(w) = target {
                    let _ = w.close();
                }
            }
            // Any dotted id is a frontend CommandRegistry id (or a
            // menu-bridge alias) — forward it verbatim so the registry stays
            // the single dispatch authority (src/lib/menu-bridge.ts listens
            // for this event and runs the command through the same gated
            // path as the palette). ALWAYS to "main": the CommandRegistry
            // only lives in the main webview — the detached preview never
            // mounts the bridge, so focused-window targeting would drop every
            // command while the preview is frontmost. (Focused-window
            // resolution stays correct for close-tab/close-window above.)
            id if id.contains('.') => {
                let _ = handle.emit_to("main", "menu:command", id);
            }
            _ => {}
        }
    });
    Ok(())
}

/// "Open with Typeward" delivery, race-free on every platform.
///
/// The OS can hand us a file before the webview exists — always on a cold
/// Finder/Explorer double-click. Tauri events are fire-and-forget to *current*
/// listeners, so emitting straight away simply lost the open; the previous
/// mitigation (a 1500 ms deferred emit) was a guess that still lost the race on
/// a slow boot, and the macOS Apple Event path had no delay at all even though
/// it is the ONLY delivery route there (Finder opens never arrive via argv).
///
/// So: park the path until the frontend announces itself by draining it, and
/// emit directly only once we know a listener is mounted.
mod open_with {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    static PENDING: Mutex<Option<String>> = Mutex::new(None);
    static FRONTEND_READY: AtomicBool = AtomicBool::new(false);

    /// Route one path to the frontend, or hold it until the frontend is up.
    /// Desktop-only: every caller (argv on first launch, the single-instance
    /// callback, the macOS Apple Event) is desktop, and mobile has no
    /// "open with" surface. `take_pending_open` stays available everywhere and
    /// simply returns `None` there.
    #[cfg(desktop)]
    pub(crate) fn deliver(app: &tauri::AppHandle, path: String) {
        if FRONTEND_READY.load(Ordering::SeqCst) {
            use tauri::Emitter;
            let _ = app.emit_to(crate::ipc_guard::MAIN_LABEL, "open-with:path", path);
            return;
        }
        // Last one wins: a launch delivers at most one file, and a newer
        // request is the one the user is waiting on.
        *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    }

    /// Drain the parked path. Called once as the frontend's open-with listener
    /// mounts, which is also what marks the frontend ready for direct emits.
    #[tauri::command]
    pub fn take_pending_open() -> Option<String> {
        FRONTEND_READY.store(true, Ordering::SeqCst);
        PENDING.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// First existing file path in a launch argv tail ("Open with Typeward").
/// Args arrive OS-quoted, so each entry is already one whole path; flags are
/// skipped rather than stopping the scan because wrappers/dev runners prepend
/// their own switches. The `is_file` probe is what keeps a random non-path
/// argument from being emitted as an open request.
#[cfg(desktop)]
/// `base_dir` anchors relative argv entries: the SECOND launch's cwd for the
/// single-instance path (the plugin hands it over), this process's cwd for
/// first launch. Probing relative paths against the wrong cwd either loses
/// the open or, worse, matches a same-named file in the first instance's cwd.
fn first_open_with_path<I: Iterator<Item = String>>(
    args: I,
    base_dir: Option<&std::path::Path>,
) -> Option<String> {
    args.filter(|a| !a.starts_with('-')).find_map(|a| {
        let p = std::path::Path::new(&a);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            base_dir?.join(p)
        };
        abs.is_file().then(|| abs.to_string_lossy().into_owned())
    })
}

/// Grant plugin-fs the configured projects root at runtime. The static
/// capability scope covers only the default root, so a user-moved root
/// (validated under Documents at the settings boundary) is added here — and
/// again from `save_settings` when it changes, so the move takes effect without
/// a restart.
pub(crate) fn grant_projects_root_fs_scope(app: &tauri::AppHandle, root: &std::path::Path) {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    // The only failure mode is a path that can't be turned into a glob pattern;
    // the static capability scope still covers the default root in that case.
    let _ = app.fs_scope().allow_directory(root, true);
    // The asset protocol serves local figures (.md preview + visual-editor
    // images) to the webview as subresources via convertFileSrc; widen its scope
    // to the configured root too so a moved projects root keeps rendering images
    // (mirrors fs_scope; the static assetProtocol scope covers the default root).
    let _ = app.asset_protocol_scope().allow_directory(root, true);
}
