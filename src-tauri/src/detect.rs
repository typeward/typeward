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

#[cfg(desktop)]
fn probe_one(name: &str) -> TexEngine {
    let resolved = resolve_program(name).ok();
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
