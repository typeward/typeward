//! Window-label gate for the custom IPC surface.
//!
//! Tauri capabilities scope *plugin* commands per window, but every
//! `#[tauri::command]` in this crate is registered through a single
//! `generate_handler!` for the whole app — so without a caller check any
//! auxiliary webview inherits the main window's full IPC authority
//! (filesystem, keyring, outbound HTTP, git, compile, subprocesses).
//!
//! The detached PDF preview window (E11) is a thin renderer of a compiled PDF —
//! i.e. of attacker-supplied document content — and needs exactly one custom
//! command. It gets an allowlist; everything else is main-window only. This
//! composes with, and does not replace, the registered-root registry in
//! `project.rs` (which gates *which paths* the main window may touch).

pub const MAIN_LABEL: &str = "main";

/// Commands a non-main window may invoke. Keep this list minimal and justified:
/// anything added here is reachable from a webview that renders untrusted
/// content. Both entries are read-only, take no caller-supplied path, and carry
/// no secrets (those live in the keyring): `custom_themes_list` reads the user's
/// own theme JSON from app data, and `load_settings` is what the preview's
/// transitively-imported settings store reads for PDF zoom / invert-in-dark /
/// density tokens (it never writes back — see `src/lib/window-role.ts`).
const NON_MAIN_WINDOW_COMMANDS: &[&str] = &["custom_themes_list", "load_settings"];

pub fn is_allowed(command: &str, label: &str) -> bool {
    label == MAIN_LABEL || NON_MAIN_WINDOW_COMMANDS.contains(&command)
}

pub fn rejection(command: &str, label: &str) -> String {
    format!("command `{command}` is not available to the `{label}` window")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_may_call_anything() {
        for command in [
            "write_project_text_file",
            "compile_latex",
            "credential_set",
            "http_request",
            "git_push",
            "custom_themes_list",
        ] {
            assert!(is_allowed(command, MAIN_LABEL), "{command}");
        }
    }

    #[test]
    fn preview_window_is_denied_privileged_commands() {
        for command in [
            "read_project_text_file",
            "write_project_text_file",
            "write_project_binary_file",
            "compile_latex",
            "compile_typst",
            "credential_get",
            "credential_set",
            "supabase_session_read",
            "http_request",
            "http_request_bytes",
            "git_clone",
            "git_push",
            "template_save",
            "webdav_put",
            "start_lsp",
            "export_project_zip",
        ] {
            assert!(!is_allowed(command, "preview"), "{command}");
        }
    }

    #[test]
    fn preview_window_may_read_themes_and_settings() {
        assert!(is_allowed("custom_themes_list", "preview"));
        assert!(is_allowed("load_settings", "preview"));
        // ...but never write them back: the main window is the single writer.
        assert!(!is_allowed("save_settings", "preview"));
        assert!(!is_allowed("reset_settings", "preview"));
    }

    #[test]
    fn unknown_window_labels_are_denied_like_the_preview() {
        assert!(!is_allowed("compile_latex", "injected"));
        assert!(!is_allowed("compile_latex", ""));
        // Not a case-insensitive or prefix match on the main label.
        assert!(!is_allowed("compile_latex", "MAIN"));
        assert!(!is_allowed("compile_latex", "main2"));
    }

    #[test]
    fn rejection_names_the_command_and_window() {
        let message = rejection("git_push", "preview");
        assert!(message.contains("git_push"));
        assert!(message.contains("preview"));
    }
}
