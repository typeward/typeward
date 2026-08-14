use std::path::PathBuf;

/// Result of probing the user's PATH for TeX-related binaries. Frontend
/// onboarding renders one card per engine and shows the first version line.
#[cfg(desktop)]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexEngine {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub installed: bool,
}

#[cfg(desktop)]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProbe {
    pub engines: Vec<TexEngine>,
    /// True if any LaTeX engine is installed and a build manager is available
    /// (latexmk preferred, but pdflatex alone is workable).
    pub any_latex_available: bool,
}

/// Merge the user's login-shell PATH into the process environment.
///
/// Finder-launched apps inherit launchd's minimal PATH (`/usr/bin:/bin:
/// /usr/sbin:/sbin`), never the user's shell PATH — so `which` misses
/// everything MacTeX, Homebrew, MacPorts, or rustup installed, engine
/// detection reports nothing, and every compile / LSP / SyncTeX spawn fails
/// unless the app happened to be started from a terminal. Ask the login shell
/// for its PATH once at startup and fall back to the well-known install dirs
/// when the capture yields nothing (e.g. an exotic shell).
///
/// Must run before the Tauri builder: children inherit the fixed PATH, and
/// mutating the environment is only sound while the process is still
/// single-threaded.
#[cfg(target_os = "macos")]
pub fn fix_gui_path() {
    let captured = capture_login_shell_path();

    let mut merged: Vec<String> = Vec::new();
    let mut push = |dir: &str| {
        if !dir.is_empty() && !merged.iter().any(|d| d == dir) {
            merged.push(dir.to_string());
        }
    };
    for dir in captured.as_deref().unwrap_or_default().split(':') {
        push(dir);
    }
    for dir in std::env::var("PATH").unwrap_or_default().split(':') {
        push(dir);
    }
    for dir in [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/local/bin",
        "/Library/TeX/texbin",
    ] {
        push(dir);
    }
    if let Some(home) = dirs::home_dir() {
        push(&home.join(".cargo/bin").to_string_lossy());
    }

    // SAFETY: called from `run()` before the builder, plugins, or async
    // runtime exist — no other thread can be reading the environment yet.
    unsafe { std::env::set_var("PATH", merged.join(":")) };
}

/// Ask the user's login shell for its PATH, defensively: profile scripts are
/// free to echo banners on stdout (only the text between the sentinels is
/// trusted), fish joins `$PATH` with spaces unless told otherwise, and a hung
/// profile (nvm network probe, mounted-volume wait) must not turn a Finder
/// launch into a dead app with no window — hence the bounded wait + kill.
#[cfg(target_os = "macos")]
fn capture_login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::time::{Duration, Instant};

    const START: &str = "__TYPEWARD_PATH_START__";
    const END: &str = "__TYPEWARD_PATH_END__";

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = if std::path::Path::new(&shell)
        .file_name()
        .is_some_and(|n| n == "fish")
    {
        format!("printf '{START}%s{END}' (string join : $PATH)")
    } else {
        format!("printf '{START}%s{END}' \"$PATH\"")
    };
    let mut child = std::process::Command::new(&shell)
        .args(["-l", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let start = out.find(START)? + START.len();
    let end = out[start..].find(END)? + start;
    let path = out[start..end].trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Resolve a tool to its absolute path via `which`, so callers spawn the
/// resolved path and never a bare name. On Windows `CreateProcess` searches the
/// process CWD before PATH; a subprocess launched with `current_dir(project)`
/// and a bare program name would run a binary planted in a malicious project
/// (binary-planting RCE). This is the single chokepoint for that invariant:
/// subprocess sites resolve here, then `Command::new(resolved)`.
pub fn resolve_program(name: &str) -> Result<PathBuf, String> {
    which::which(name).map_err(|_| format!("`{name}` was not found on PATH"))
}

/// `CREATE_NO_WINDOW`. Release builds set `windows_subsystem = "windows"`, so
/// the app itself owns no console — and Windows then allocates a *fresh*,
/// visible console for every console-subsystem child we spawn. Piped stdio does
/// not suppress that. Without this flag an installed build pops a black window
/// for each compile (staying up for the whole latexmk run), parks one on the
/// taskbar for the lifetime of a texlab/tinymist session, and flashes one per
/// `--version` probe. `tauri-plugin-shell` already sets it for the bundled
/// Tectonic sidecar; these helpers cover every Command we build ourselves.
/// Dev builds keep a console and children inherit it, which is why `tauri dev`
/// never shows the problem.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window for a std subprocess. No-op off Windows.
pub fn hide_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Suppress the console window for a tokio subprocess. No-op off Windows.
pub fn hide_console_async(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

#[cfg(desktop)]
const ENGINES: &[&str] = &[
    "pdflatex", "xelatex", "lualatex", "latexmk", "tectonic", "typst", "pandoc",
];

#[cfg(desktop)]
pub fn probe() -> EngineProbe {
    let engines: Vec<TexEngine> = ENGINES.iter().map(|&name| probe_one(name)).collect();
    let any_latex_available = engines.iter().any(|e| {
        e.installed && (e.name == "pdflatex" || e.name == "xelatex" || e.name == "lualatex")
    });
    EngineProbe {
        engines,
        any_latex_available,
    }
}

/// The bundled Tectonic sidecar (tauri.conf.json `externalBin`) ships next to
/// the app executable, deliberately not on PATH. Without this leg the
/// onboarding card reports the engine Typeward itself ships as "not on PATH"
/// on every machine that relies on it — exactly the machines without a TeX.
#[cfg(desktop)]
fn sidecar_tectonic() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe
        .parent()?
        .join(if cfg!(windows) { "tectonic.exe" } else { "tectonic" });
    candidate.is_file().then_some(candidate)
}

#[cfg(desktop)]
fn probe_one(name: &str) -> TexEngine {
    let mut resolved = resolve_program(name).ok();
    if resolved.is_none() && name == "tectonic" {
        resolved = sidecar_tectonic();
    }
    let path = resolved.as_ref().map(|p| p.to_string_lossy().into_owned());
    let version = resolved.as_ref().and_then(|exe| run_version(name, exe));
    TexEngine {
        installed: path.is_some(),
        name: name.to_string(),
        path,
        version,
    }
}

#[cfg(desktop)]
fn run_version(name: &str, exe: &std::path::Path) -> Option<String> {
    use std::process::Command;

    let flag = match name {
        "tectonic" => "--version",
        "typst" => "--version",
        "pandoc" => "--version",
        // TeX engines support --version too; latexmk uses -v but accepts --version on modern installs
        _ => "--version",
    };
    let mut cmd = Command::new(exe);
    cmd.arg(flag);
    hide_console(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    raw.lines().next().map(|s| s.trim().to_string())
}
