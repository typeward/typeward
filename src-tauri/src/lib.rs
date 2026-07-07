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
mod integrations;
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            telemetry::install(app.handle());
            // Seed the project trust boundary (project.rs) from the configured
            // projects root before the webview can issue any IPC, so file IO /
            // compile / git can be gated to the projects area.
            let projects_root = settings::load(app.handle())
                .map(|s| std::path::PathBuf::from(s.projects_root))
                .unwrap_or_else(|_| settings::default_projects_root());
            let _ = std::fs::create_dir_all(&projects_root);
            project::set_projects_root(&projects_root);
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

    builder
        .invoke_handler(tauri::generate_handler![
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
            integrations::vcs::git::git_init,
            integrations::vcs::git::git_status,
            integrations::vcs::git::git_stage,
            integrations::vcs::git::git_unstage,
            integrations::vcs::git::git_commit,
            integrations::vcs::git::git_log,
            integrations::vcs::git::git_branch_list,
            integrations::vcs::git::git_branch_create,
            integrations::vcs::git::git_branch_checkout,
            integrations::vcs::git::git_fetch,
            integrations::vcs::git::git_pull,
            integrations::vcs::git::git_push,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
