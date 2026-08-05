//! Avatar storage for the local user profile.
//!
//! The profile itself is plain settings data; only the picture touches disk.
//! The image is *copied* into `<app_data>/profile/` rather than referenced in
//! place so the avatar keeps rendering after the user moves or deletes the
//! original — and so the app never has to widen a read scope to wherever the
//! picker happened to land.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;
use thiserror::Error;

use crate::fs_ops;
use crate::settings;

/// Generous for a picture that renders at ~64px, tight enough that a mistaken
/// pick (a RAW photo, a video with a renamed extension) is refused instead of
/// being copied into app data.
const MAX_AVATAR_BYTES: u64 = 8 * 1024 * 1024;

/// Formats the webview can render as an `<img>` source. The stored file always
/// uses the lowercased extension, so exactly one lookup name exists per format.
const ALLOWED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

#[derive(Debug, Error)]
enum ProfileError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not resolve app data dir")]
    NoAppDataDir,
    #[error("not a regular file")]
    NotAFile,
    #[error("symlinked images are not accepted")]
    Symlink,
    #[error("unsupported image type (use png, jpg, jpeg, webp, or gif)")]
    BadExtension,
    #[error("image is too large (max 8 MB)")]
    TooLarge,
    #[error("{0}")]
    Settings(#[from] settings::SettingsError),
}

fn profile_dir(app: &tauri::AppHandle) -> Result<PathBuf, ProfileError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| ProfileError::NoAppDataDir)?
        .join("profile");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Extension the copy is stored under, or a rejection. Lexical only — matching
/// on the name is what decides the stored file name, not the file's contents.
fn stored_extension(path: &Path) -> Result<String, ProfileError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(ProfileError::BadExtension)
    }
}

fn validate_source(path: &Path) -> Result<String, ProfileError> {
    let ext = stored_extension(path)?;
    // symlink_metadata, not metadata: a symlinked pick must be refused rather
    // than silently followed, matching every other user-content reader here.
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(ProfileError::Symlink);
    }
    if !meta.is_file() {
        return Err(ProfileError::NotAFile);
    }
    if meta.len() > MAX_AVATAR_BYTES {
        return Err(ProfileError::TooLarge);
    }
    Ok(ext)
}

/// Drop every stored avatar except the one named by `keep`. Only one may exist
/// at a time — otherwise switching from a `.png` to a `.jpg` would strand the
/// old image in app data forever.
fn remove_stored_avatars(dir: &Path, keep: Option<&str>) {
    for ext in ALLOWED_EXTENSIONS {
        if keep == Some(ext) {
            continue;
        }
        let _ = fs::remove_file(dir.join(format!("avatar.{ext}")));
    }
}

fn write_avatar_into(dir: &Path, source: &Path) -> Result<PathBuf, ProfileError> {
    let ext = validate_source(source)?;
    let bytes = fs::read(source)?;
    // Re-checked after the read: the stat above is a moment-in-time answer and
    // the file could have grown between the two.
    if bytes.len() as u64 > MAX_AVATAR_BYTES {
        return Err(ProfileError::TooLarge);
    }
    let dest = dir.join(format!("avatar.{ext}"));
    fs_ops::atomic_write(&dest, &bytes)?;
    remove_stored_avatars(dir, Some(&ext));
    Ok(dest)
}

fn persist_avatar_path(
    app: &tauri::AppHandle,
    avatar_path: Option<String>,
) -> Result<(), ProfileError> {
    // One locked read-modify-write: a plain load/mutate/save would race the
    // renderer's own settings save and drop whichever side wrote second.
    settings::update(app, |stored| {
        stored.profile.avatar_path = avatar_path;
    })?;
    Ok(())
}

/// Drop every stored avatar image, leaving settings.json alone. The reset path
/// writes `Settings::default()` itself — which already clears `avatarPath` — so
/// it needs the file half only; without it the picture outlives a reset and
/// orphans in app data. A no-op when nothing was ever stored.
pub(crate) fn clear_stored_avatar_files(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| ProfileError::NoAppDataDir.to_string())?
        .join("profile");
    remove_stored_avatars(&dir, None);
    Ok(())
}

fn store_avatar(app: &tauri::AppHandle, source: &Path) -> Result<String, ProfileError> {
    let dir = profile_dir(app)?;
    let dest = write_avatar_into(&dir, source)?;
    let dest = dest.to_string_lossy().into_owned();
    persist_avatar_path(app, Some(dest.clone()))?;
    Ok(dest)
}

fn clear_avatar(app: &tauri::AppHandle) -> Result<(), ProfileError> {
    let dir = profile_dir(app)?;
    remove_stored_avatars(&dir, None);
    persist_avatar_path(app, None)
}

/// Copy `source_path` into `<app_data>/profile/avatar.<ext>` and record it as
/// the profile avatar. Returns the absolute stored path.
#[tauri::command]
pub async fn set_profile_avatar(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    // Whole-file read + two settings writes; keep them off the event loop.
    tokio::task::spawn_blocking(move || {
        store_avatar(&app, Path::new(&source_path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forget the profile avatar. Succeeds whether or not one was stored.
#[tauri::command]
pub async fn clear_profile_avatar(app: tauri::AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || clear_avatar(&app).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod portable_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "typeward-profile-portable-{}-{}",
            std::process::id(),
            id
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_the_supported_extensions_case_insensitively() {
        for name in ["a.png", "a.JPG", "a.Jpeg", "a.WEBP", "a.gif"] {
            assert!(stored_extension(Path::new(name)).is_ok(), "{name}");
        }
        assert_eq!(stored_extension(Path::new("a.JPG")).unwrap(), "jpg");
    }

    #[test]
    fn rejects_unsupported_and_missing_extensions() {
        for name in ["a.svg", "a.bmp", "a.exe", "a.png.exe", "avatar", "a."] {
            assert!(stored_extension(Path::new(name)).is_err(), "{name}");
        }
    }

    #[test]
    fn rejects_a_directory_and_a_missing_file() {
        let dir = temp_dir();
        let as_image = dir.join("holder.png");
        fs::create_dir(&as_image).unwrap();
        assert!(validate_source(&as_image).is_err());
        assert!(validate_source(&dir.join("nope.png")).is_err());
    }

    #[test]
    fn rejects_an_oversized_image() {
        let dir = temp_dir();
        let big = dir.join("big.png");
        fs::write(&big, vec![0u8; MAX_AVATAR_BYTES as usize + 1]).unwrap();
        assert!(validate_source(&big).is_err());
    }

    #[test]
    fn stores_the_copy_and_leaves_only_one_avatar_behind() {
        let source_dir = temp_dir();
        let store = temp_dir();
        let png = source_dir.join("me.png");
        fs::write(&png, b"png-bytes").unwrap();

        let stored = write_avatar_into(&store, &png).unwrap();
        assert_eq!(stored, store.join("avatar.png"));
        assert_eq!(fs::read(&stored).unwrap(), b"png-bytes");

        // Switching format must not leave the previous image on disk.
        let jpg = source_dir.join("me.JPG");
        fs::write(&jpg, b"jpg-bytes").unwrap();
        let stored = write_avatar_into(&store, &jpg).unwrap();
        assert_eq!(stored, store.join("avatar.jpg"));
        assert!(!store.join("avatar.png").exists());
    }

    #[test]
    fn removing_avatars_is_a_no_op_when_none_are_stored() {
        let store = temp_dir();
        remove_stored_avatars(&store, None);
        assert!(fs::read_dir(&store).unwrap().next().is_none());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!("typeward-profile-{}-{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_a_symlinked_source() {
        let dir = temp_dir();
        let target = dir.join("real.png");
        let link = dir.join("link.png");
        fs::write(&target, b"png-bytes").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(validate_source(&link).is_err());
        assert!(validate_source(&target).is_ok());
    }
}
