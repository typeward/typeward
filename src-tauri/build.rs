use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

fn main() {
    inject_supabase_csp_origin();
    tauri_build::build()
}

/// The webview talks to exactly one Supabase project (supabase-js runs in the
/// renderer). Its origin is per-deployment, so `tauri.conf.json` cannot carry
/// it, and a `https://*.supabase.co` wildcard would leave an XSS payload a
/// ready-made exfil endpoint on any attacker-owned tenant. Resolve the
/// configured project at build time and splice its exact origin into
/// `connect-src` for both policies.
///
/// No configured project (free-tier build) = no Supabase source in the CSP at
/// all — the client is `null` in that case and never connects.
fn inject_supabase_csp_origin() {
    println!("cargo:rerun-if-env-changed=VITE_SUPABASE_URL");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    for file in env_files() {
        println!("cargo:rerun-if-changed={}", file.display());
    }

    let Some(origin) = supabase_origin() else {
        return;
    };

    let raw = fs::read_to_string("tauri.conf.json").expect("read tauri.conf.json");
    let conf: Value = serde_json::from_str(&raw).expect("parse tauri.conf.json");
    let security = &conf["app"]["security"];

    let mut patched = Map::new();
    for key in ["csp", "devCsp"] {
        let Some(csp) = security.get(key).and_then(Value::as_str) else {
            continue;
        };
        patched.insert(
            key.to_string(),
            Value::String(with_origin(csp, &origin, key)),
        );
    }

    let mut overlay: Value = env::var("TAURI_CONFIG")
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    merge(
        &mut overlay,
        &serde_json::json!({ "app": { "security": Value::Object(patched) } }),
    );
    let overlay = overlay.to_string();

    // Two consumers, two channels: `tauri_build::build()` reads the process
    // env; `generate_context!` reads the rustc env of the crate build.
    println!("cargo:rustc-env=TAURI_CONFIG={overlay}");
    // SAFETY: build scripts run single-threaded and no threads are spawned
    // before this point, so mutating the process environment has no data race.
    unsafe { env::set_var("TAURI_CONFIG", overlay) };
}

/// Splice the origin into the policy's `connect-src`. A missing anchor is a
/// hard build failure rather than a silently Supabase-less CSP, which would
/// only surface as a blocked request at runtime.
fn with_origin(csp: &str, origin: &str, key: &str) -> String {
    const ANCHOR: &str = "connect-src 'self'";
    assert!(
        csp.contains(ANCHOR),
        "tauri.conf.json `{key}` has no `{ANCHOR}` to extend with the Supabase origin"
    );
    csp.replace(ANCHOR, &format!("{ANCHOR} {origin}"))
}

fn env_files() -> Vec<PathBuf> {
    let app_root = Path::new("..");
    [".env.local", ".env"]
        .iter()
        .map(|name| app_root.join(name))
        .collect()
}

/// `VITE_SUPABASE_URL` from the environment (CI) or the app's `.env.local` /
/// `.env` (dev), reduced to a scheme+host origin.
fn supabase_origin() -> Option<String> {
    let raw = env::var("VITE_SUPABASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env_files()
                .iter()
                .find_map(|file| read_env_var(file, "VITE_SUPABASE_URL"))
        })?;
    Some(origin_of(raw.trim()))
}

fn read_env_var(file: &Path, key: &str) -> Option<String> {
    let content = fs::read_to_string(file).ok()?;
    content.lines().find_map(|line| {
        let value = line
            .trim()
            .strip_prefix(key)?
            .trim_start()
            .strip_prefix('=')?;
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Reduce a configured URL to `https://<host>`, rejecting anything that could
/// smuggle extra sources into the policy — a CSP source list is whitespace-
/// and `;`-delimited, so the host must be a strict hostname.
fn origin_of(url: &str) -> String {
    let host = url
        .strip_prefix("https://")
        .unwrap_or_else(|| panic!("VITE_SUPABASE_URL must be https:// (got {url})"));
    let host = host.split(['/', '?', '#']).next().unwrap_or("");
    let plain_hostname = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !host.starts_with('.')
        && !host.ends_with('.');
    assert!(
        plain_hostname,
        "VITE_SUPABASE_URL host is not a plain hostname: {url}"
    );
    format!("https://{host}")
}

fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                merge(base.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}
