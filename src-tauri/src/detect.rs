use std::process::Command;

use serde::Serialize;

/// Result of probing the user's PATH for TeX-related binaries. Frontend
/// onboarding renders one card per engine and shows the first version line.
#[derive(Debug, Clone, Serialize)]
pub struct TexEngine {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineProbe {
    pub engines: Vec<TexEngine>,
    /// True if any LaTeX engine is installed and a build manager is available
    /// (latexmk preferred, but pdflatex alone is workable).
    #[serde(rename = "anyLatexAvailable")]
    pub any_latex_available: bool,
}

const ENGINES: &[&str] = &[
    "pdflatex", "xelatex", "lualatex", "latexmk", "tectonic", "typst", "pandoc",
];

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

fn probe_one(name: &str) -> TexEngine {
    let path = which::which(name)
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let version = path.as_ref().and_then(|_| run_version(name));
    TexEngine {
        installed: path.is_some(),
        name: name.to_string(),
        path,
        version,
    }
}

fn run_version(name: &str) -> Option<String> {
    let flag = match name {
        "tectonic" => "--version",
        "typst" => "--version",
        "pandoc" => "--version",
        // TeX engines support --version too; latexmk uses -v but accepts --version on modern installs
        _ => "--version",
    };
    let output = Command::new(name).arg(flag).output().ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    raw.lines().next().map(|s| s.trim().to_string())
}
