//! Bounded subprocess runner for synchronous call sites.
//!
//! `compile.rs` owns the async equivalent (`run_bounded`), which every compile
//! spawn goes through. This is its sync twin for the paths that are not inside
//! a future — today the `synctex` CLI, which `export_annotated` drives once per
//! annotation over project data an attacker can shape (a crafted or truncated
//! `.synctex.gz`). Same three guarantees: a hard deadline, a process-TREE kill
//! (the CLI can fork helpers), and capped capture.
//!
//! Both pipes are drained on their own threads. Reading them in sequence would
//! deadlock the moment the child fills the pipe we are not reading yet, which
//! is exactly the "unbounded" failure mode this exists to prevent.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Matches the compile path's per-stream ceiling.
const OUTPUT_CAP: usize = 4 * 1024 * 1024;

/// How often the deadline loop re-checks an unfinished child.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

pub struct BoundedOutput {
    pub stdout: Vec<u8>,
    pub status: Option<std::process::ExitStatus>,
    pub timed_out: bool,
}

impl BoundedOutput {
    pub fn success(&self) -> bool {
        self.status.map(|s| s.success()).unwrap_or(false)
    }
}

fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Keep reading past the cap so the child never blocks
                        // on a full pipe; just stop growing the buffer.
                        if buf.len() < OUTPUT_CAP {
                            let room = OUTPUT_CAP - buf.len();
                            buf.extend_from_slice(&chunk[..n.min(room)]);
                        }
                    }
                }
            }
        }
        let _ = tx.send(buf);
    });
    rx
}

#[cfg(windows)]
fn kill_tree(child: &mut std::process::Child) {
    let Ok(system_root) = std::env::var("SystemRoot") else {
        let _ = child.kill();
        return;
    };
    let taskkill = Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe");
    let _ = Command::new(taskkill)
        .args(["/F", "/T", "/PID", &child.id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(unix)]
fn kill_tree(child: &mut std::process::Child) {
    // The child was made its own group leader at spawn, so signalling the
    // negative pid takes any helpers it forked down with it.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
}

/// Spawn `program` with a deadline and capped stdout capture. `Err` is a spawn
/// failure; a killed-on-deadline run comes back as `Ok` with `timed_out` set so
/// callers can treat it as "no result" rather than an error.
pub fn run_bounded_sync(
    program: &Path,
    args: &[&std::ffi::OsStr],
    cwd: Option<&Path>,
    timeout: Duration,
) -> std::io::Result<BoundedOutput> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;

    let stdout_rx = drain(child.stdout.take());
    let stderr_rx = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None if Instant::now() >= deadline => {
                kill_tree(&mut child);
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            None => std::thread::sleep(POLL_INTERVAL),
        }
    };

    // The reader threads end when the pipes close, which the kill guarantees.
    let stdout = stdout_rx.recv().unwrap_or_default();
    let _ = stderr_rx.recv();

    Ok(BoundedOutput {
        stdout,
        status,
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    /// A shell that exists on the host, plus the args to echo `hello` and to
    /// sleep far past any test deadline.
    fn echo_cmd() -> Option<(std::path::PathBuf, Vec<String>)> {
        #[cfg(windows)]
        {
            let cmd = which::which("cmd").ok()?;
            Some((cmd, vec!["/C".into(), "echo hello".into()]))
        }
        #[cfg(unix)]
        {
            let sh = which::which("sh").ok()?;
            Some((sh, vec!["-c".into(), "echo hello".into()]))
        }
    }

    fn sleep_cmd() -> Option<(std::path::PathBuf, Vec<String>)> {
        #[cfg(windows)]
        {
            let cmd = which::which("cmd").ok()?;
            // `timeout` needs a console; ping the loopback as a portable sleep.
            Some((cmd, vec!["/C".into(), "ping -n 60 127.0.0.1 > NUL".into()]))
        }
        #[cfg(unix)]
        {
            let sh = which::which("sh").ok()?;
            Some((sh, vec!["-c".into(), "sleep 60".into()]))
        }
    }

    #[test]
    fn short_output_passes_through() {
        let Some((program, args)) = echo_cmd() else {
            return; // no shell on this host: nothing to assert
        };
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();

        let out = run_bounded_sync(&program, &args, None, Duration::from_secs(30)).unwrap();

        assert!(out.success());
        assert!(!out.timed_out);
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello"));
    }

    #[test]
    fn a_runaway_child_is_killed_at_the_deadline() {
        let Some((program, args)) = sleep_cmd() else {
            return;
        };
        let args: Vec<&OsStr> = args.iter().map(OsStr::new).collect();

        let started = Instant::now();
        let out = run_bounded_sync(&program, &args, None, Duration::from_millis(300)).unwrap();

        assert!(out.timed_out);
        assert!(!out.success());
        // The deadline, not the child's own 60s runtime, ended the call.
        assert!(started.elapsed() < Duration::from_secs(20));
    }
}
