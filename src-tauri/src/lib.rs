mod autosave;
mod commands;
mod detect;
mod fs_ops;
mod integrations;
mod lsp;
mod project;
mod settings;
mod synctex;
mod telemetry;
mod watcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            telemetry::install(&app.handle());
            Ok(())
        })
        .manage(lsp::LspManager::default())
        .manage(watcher::WatcherManager::default())
        .manage(integrations::oauth::OauthManager::default())
        .manage(std::sync::Arc::new(integrations::ai::streaming::AiStreamManager::default()))
        .invoke_handler(tauri::generate_handler![
            commands::detect_tex,
            commands::list_projects,
            commands::create_project,
            commands::open_project,
            commands::set_project_integrations,
            commands::read_project_text_file,
            commands::read_project_binary_file,
            commands::write_project_text_file,
            commands::write_project_binary_file,
            commands::parse_latex_log_cmd,
            commands::compile_latex,
            commands::compile_typst,
            synctex::synctex_forward,
            synctex::synctex_inverse,
            commands::load_settings,
            commands::save_settings,
            lsp::start_lsp,
            lsp::send_lsp_message,
            lsp::stop_lsp,
            watcher::watch_project,
            watcher::unwatch_project,
            commands::write_snapshot,
            commands::clear_snapshot,
            commands::list_orphan_snapshots,
            telemetry::record_event,
            telemetry::list_recent_events,
            integrations::credentials::credential_set,
            integrations::credentials::credential_get,
            integrations::credentials::credential_delete,
            integrations::http::http_request,
            integrations::http::http_request_bytes,
            integrations::oauth::oauth_begin,
            integrations::oauth::oauth_wait,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
