use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write bytes to `path` via a temp-file rename, so a process crash mid-write
/// can never leave a half-written project.json on disk.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("typeward");

    for _ in 0..100 {
        let nonce = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp = dir.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            now ^ nonce as u128
        ));

        let mut f = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };

        if let Err(e) = f.write_all(bytes).and_then(|_| f.sync_all()) {
            drop(f);
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        drop(f);

        if let Err(e) = fs::rename(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        return Ok(());
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary file",
    ))
}

pub fn read_text(path: &Path) -> io::Result<String> {
    fs::read_to_string(path)
}

pub fn write_text(path: &Path, content: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(path, content.as_bytes())
}

#[cfg(test)]
mod portable_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "typeward-fs-portable-test-{}-{}",
            std::process::id(),
            id
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_produces_intact_content() {
        let dir = temp_dir();
        let dest = dir.join("project.json");
        atomic_write(&dest, b"{\"ok\":true}").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "{\"ok\":true}");
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let dir = temp_dir();
        let dest = dir.join("settings.json");
        atomic_write(&dest, b"first").unwrap();
        atomic_write(&dest, b"second-longer").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "second-longer");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files_behind() {
        // The temp-then-rename primitive must clean up after itself so a
        // directory listing never shows the transient `.<name>.<pid>.<n>.tmp`.
        let dir = temp_dir();
        let dest = dir.join("main.tex.snap");
        atomic_write(&dest, b"content").unwrap();
        let leftover: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "unexpected temp files: {leftover:?}");
    }

    #[test]
    fn write_text_creates_parent_directories() {
        let dir = temp_dir();
        let dest = dir.join("nested").join("deep").join("file.txt");
        write_text(&dest, "hello").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!("typeward-fs-test-{}-{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_does_not_follow_preexisting_temp_symlink() {
        let dir = temp_dir();
        let target = dir.join("outside.txt");
        let dest = dir.join("note.txt");
        let old_fixed_temp = dir.join(".note.txt.tmp");
        fs::write(&target, "keep").unwrap();
        std::os::unix::fs::symlink(&target, &old_fixed_temp).unwrap();

        write_text(&dest, "new").unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new");
        assert!(old_fixed_temp.exists());
    }
}
