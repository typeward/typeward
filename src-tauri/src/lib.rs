mod autosave;
mod commands;
mod compile;
// Subprocess-backed modules are desktop-only: mobile (iOS/Android) has no
// system TeX / language-server / synctex binaries on a PATH to spawn, and the
// frontend never reaches their IPC there (compile routes through texlive-wasm,
// LSP/synctex calls are engine-gated or caught). Gating them keeps the
// subprocess IPC surface off the mobile webview entirely.
#[cfg(desktop)]
mod detect;
mod diagnostics;
#[cfg(desktop)]
mod export_annotated;
#[cfg(desktop)]
mod export_pandoc;
mod fs_ops;
mod history;
mod integrations;
mod ipc_guard;
#[cfg(desktop)]
mod lsp;
mod project;
mod settings;
#[cfg(desktop)]
mod synctex;
mod telemetry;
mod themes;
mod todo_scan;
mod trust;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Single-instance must be the first plugin registered. A second desktop
    // launch (trivial on Windows) is caught here and focuses the running
    // window instead of spawning a rival process that would run duplicate
    // watchers/autosave/sync engines over the same data — the shared cursor,
    // sync-state.json, snapshots, and settings.json all assume one writer.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(win) = app.webview_windows().values().next() {
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // Auto-updater (desktop only): the plugin parses the pubkey lazily at check
    // time, so registering it with the "" placeholder pubkey doesn't touch the
    // signing path at startup. Mobile ships through app stores, not the updater.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let builder = builder
        .setup(|app| {
            telemetry::install(app.handle());
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
            Ok(())
        })
        .manage(watcher::WatcherManager::default())
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
        commands::reveal_project_path,
        trust::shell_escape_trust_get,
        trust::shell_escape_trust_set,
        todo_scan::scan_project_todos,
        commands::read_project_text_file,
        commands::read_project_binary_file,
        commands::write_project_text_file,
        commands::write_project_binary_file,
        compile::parse_latex_log_cmd,
        compile::compile_latex,
        compile::compile_typst,
        #[cfg(desktop)]
        synctex::synctex_forward,
        #[cfg(desktop)]
        synctex::synctex_inverse,
        commands::load_settings,
        commands::save_settings,
        commands::load_sync_state,
        commands::save_sync_state,
        commands::reset_settings,
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
        history::history_read_version,
        history::history_restore,
        history::history_clear,
        telemetry::record_event,
        telemetry::list_recent_events,
        telemetry::read_telemetry_log,
        diagnostics::preview_error_report,
        diagnostics::submit_error_report,
        diagnostics::scan_and_submit_crashes,
        diagnostics::collect_system_info,
        integrations::credentials::credential_set,
        integrations::credentials::credential_get,
        integrations::credentials::supabase_session_read,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Grant plugin-fs the configured projects root at runtime. The static
/// capability scope covers only the default root, so a user-moved root
/// (validated under Documents at the settings boundary) is added here — and
/// again from `save_settings` when it changes, so the move takes effect without
/// a restart.
pub(crate) fn grant_projects_root_fs_scope(app: &tauri::AppHandle, root: &std::path::Path) {
    use tauri_plugin_fs::FsExt;
    // The only failure mode is a path that can't be turned into a glob pattern;
    // the static capability scope still covers the default root in that case.
    let _ = app.fs_scope().allow_directory(root, true);
}
