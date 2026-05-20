mod autosave;
mod commands;
mod detect;
mod fs_ops;
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
        .setup(|app| {
            telemetry::install(&app.handle());
            Ok(())
        })
        .manage(lsp::LspManager::default())
        .manage(watcher::WatcherManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::detect_tex,
            commands::list_projects,
            commands::create_project,
            commands::open_project,
            commands::read_project_text_file,
            commands::read_project_binary_file,
            commands::write_project_text_file,
            commands::write_project_binary_file,
            commands::parse_latex_log_cmd,
            commands::compile_latex,
            commands::compile_typst,
            commands::compile_markdown,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
