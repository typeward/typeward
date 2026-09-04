//! How this build was installed, as the updater sees it.
//!
//! `tauri::utils::platform::bundle_type()` reads a string the bundler patches
//! into each produced binary, so the same source yields a deb binary that knows
//! it is a deb and an AppImage binary that knows it is an AppImage. The updater
//! plugin uses exactly this value to pick which manifest entry to download: it
//! looks for `{os}-{arch}-{installer}` first and falls back to `{os}-{arch}`.
//!
//! The frontend needs the same fact for two reasons. It decides whether an
//! update is deliverable at all (a `.deb` install can only be updated by a
//! signed `.deb`, never by the AppImage sitting under the generic key), and it
//! decides what to tell the user when it is not.
//!
//! An unpatched binary (`tauri dev`, a raw `cargo run`, a binary someone copied
//! out of a bundle) reports `unknown` on Linux and Windows; macOS reports `app`
//! because there is no other way to run one.

/// Stable, lowercase identifiers shared with `src/lib/updater.ts`. These match
/// the installer names the updater plugin appends to its target string, so a
/// value here is directly comparable to the suffix of a manifest platform key.
#[tauri::command]
pub fn updater_install_kind() -> String {
    #[cfg(desktop)]
    {
        use tauri::utils::config::BundleType;
        match tauri::utils::platform::bundle_type() {
            Some(BundleType::Deb) => "deb",
            Some(BundleType::Rpm) => "rpm",
            Some(BundleType::AppImage) => "appimage",
            Some(BundleType::Msi) => "msi",
            Some(BundleType::Nsis) => "nsis",
            // Dmg installs run the .app it carried, so both report `app` - the
            // same bundle the updater replaces.
            Some(BundleType::App) | Some(BundleType::Dmg) => "app",
            _ => "unknown",
        }
        .to_string()
    }
    #[cfg(not(desktop))]
    {
        "unknown".to_string()
    }
}
