//! Chromium-family detection, headless launch, and ephemeral profile
//! lifecycle (JUN-289).
//!
//! The managed transport (ADR 0017, routines track) launches a detected system
//! browser headless against a fresh, throwaway profile and talks to it over the
//! Chrome DevTools Protocol pipe (see [`super::cdp`]). No browser engine is
//! bundled; if none of the supported browsers is installed the routine fails
//! with [`NO_BROWSER_MESSAGE`].
//!
//! Privacy (JUN-316): nothing here logs, prints, or traces URLs, page content,
//! profile paths, or process arguments. The browser's own stdout/stderr are
//! discarded because Chromium's stderr can echo URLs.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A supported Chromium-family browser. The variant order is the detection
/// priority order fixed by the PRD (Chrome, then Edge, then Brave, then stock
/// Chromium).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BrowserKind {
    Chrome,
    Edge,
    Brave,
    Chromium,
}

/// A browser found on disk: which kind, and the executable that was located.
#[derive(Debug, Clone)]
pub struct DetectedBrowser {
    pub kind: BrowserKind,
    pub path: PathBuf,
}

/// Actionable copy shown when no supported browser is installed. This exact
/// wording is a JUN-289 acceptance criterion (sentence case, no em dashes).
pub const NO_BROWSER_MESSAGE: &str = "No compatible browser is installed. Install Google Chrome, Microsoft Edge, Brave, or Chromium so June can run its managed browser.";

/// Detects the highest-priority installed browser, or `None` if none is present
/// (callers surface [`NO_BROWSER_MESSAGE`]).
pub fn detect_browser() -> Option<DetectedBrowser> {
    detect_browser_among(&browser_candidates())
}

/// The testable core [`detect_browser`] delegates to: returns the first
/// candidate whose path exists, preserving the caller's priority ordering.
pub fn detect_browser_among(candidates: &[(BrowserKind, PathBuf)]) -> Option<DetectedBrowser> {
    for (kind, path) in candidates {
        if path.exists() {
            return Some(DetectedBrowser {
                kind: *kind,
                path: path.clone(),
            });
        }
    }
    None
}

/// macOS candidate binaries in strict priority order. Each kind is checked in
/// `/Applications` first, then `$HOME/Applications`, before the next kind.
#[cfg(target_os = "macos")]
fn browser_candidates() -> Vec<(BrowserKind, PathBuf)> {
    let specs = [
        (
            BrowserKind::Chrome,
            "Google Chrome.app/Contents/MacOS/Google Chrome",
        ),
        (
            BrowserKind::Edge,
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ),
        (
            BrowserKind::Brave,
            "Brave Browser.app/Contents/MacOS/Brave Browser",
        ),
        (
            BrowserKind::Chromium,
            "Chromium.app/Contents/MacOS/Chromium",
        ),
    ];
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut out = Vec::with_capacity(specs.len() * 2);
    for (kind, rel) in specs {
        out.push((kind, PathBuf::from("/Applications").join(rel)));
        if let Some(home) = &home {
            out.push((kind, home.join("Applications").join(rel)));
        }
    }
    out
}

/// Non-macOS fallback: resolve each kind's binary names against `PATH`, keeping
/// the same kind priority order.
#[cfg(not(target_os = "macos"))]
fn browser_candidates() -> Vec<(BrowserKind, PathBuf)> {
    let names: [(BrowserKind, &[&str]); 4] = [
        (
            BrowserKind::Chrome,
            &["google-chrome", "google-chrome-stable"],
        ),
        (BrowserKind::Edge, &["microsoft-edge"]),
        (BrowserKind::Brave, &["brave-browser"]),
        (BrowserKind::Chromium, &["chromium", "chromium-browser"]),
    ];
    let mut out = Vec::new();
    for (kind, bins) in names {
        for bin in bins {
            if let Some(path) = which_in_path(bin) {
                out.push((kind, path));
            }
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Root directory holding every ephemeral browser profile, under app-controlled
/// temporary storage. The app sweeps it once at startup (see
/// [`sweep_profiles_root`]) so a crash that skipped Drop never leaves a stale
/// profile behind on the next run.
pub fn profiles_root() -> PathBuf {
    std::env::temp_dir().join("co.opensoftware.june.browser-profiles")
}

/// Best-effort delete of everything under [`profiles_root`]. Called once at app
/// startup, before any session exists; all errors are ignored (a missing root
/// is already the desired state).
pub fn sweep_profiles_root() {
    sweep_profiles_root_at(&profiles_root());
}

pub(super) fn sweep_profiles_root_at(root: &Path) {
    let _ = std::fs::remove_dir_all(root);
}

/// A fresh, uuid-named profile directory. Drop deletes it best-effort, and Drop
/// is the single teardown mechanism: graceful close, kill, and app exit all end
/// by dropping the guard, so the profile is gone after any of them.
pub struct EphemeralProfile {
    path: PathBuf,
}

impl EphemeralProfile {
    /// Creates a new uuid-named profile directory under [`profiles_root`].
    pub fn create() -> io::Result<EphemeralProfile> {
        Self::create_in(&profiles_root())
    }

    /// Test seam: create a profile under an arbitrary root so unit tests never
    /// touch the shared real [`profiles_root`] (which parallel tests would race
    /// over).
    fn create_in(root: &Path) -> io::Result<EphemeralProfile> {
        std::fs::create_dir_all(root)?;
        let path = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&path)?;
        Ok(EphemeralProfile { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Explicit teardown for graceful close. Idempotent and best-effort; Drop
    /// repeats it as the backstop.
    pub fn delete(&self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl Drop for EphemeralProfile {
    fn drop(&mut self) {
        self.delete();
    }
}

/// A launched browser process plus the parent ends of the two CDP pipes.
///
/// This owns only the process and pipes; it never owns the profile. The
/// [`EphemeralProfile`] guard is the sole profile owner, so kill/Drop here must
/// not delete profile data.
pub struct LaunchedBrowser {
    child: std::process::Child,
    /// `(read from browser, write to browser)`. Taken once by the CDP client.
    cdp_pipes: Option<(File, File)>,
    killed: bool,
}

impl LaunchedBrowser {
    /// Hands the CDP pipe ends to the client. Returns `None` if already taken.
    pub fn take_cdp_pipes(&mut self) -> Option<(File, File)> {
        self.cdp_pipes.take()
    }

    /// Kills the process and reaps it. Idempotent: a second call (including from
    /// Drop) is a no-op once the child has been killed or observed as exited.
    pub fn kill(&mut self) {
        if self.killed {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.killed = true;
    }

    /// The process id while the child has not been reaped, for diagnostics and
    /// the E2E harness's crash-path check.
    pub fn pid(&self) -> Option<u32> {
        if self.killed {
            None
        } else {
            Some(self.child.id())
        }
    }

    /// Non-blocking check for whether the process has exited on its own. Reaps
    /// it if so, so a later kill/Drop does not signal a recycled pid.
    pub fn try_wait_exited(&mut self) -> bool {
        if self.killed {
            return true;
        }
        match self.child.try_wait() {
            Ok(Some(_)) => {
                self.killed = true;
                true
            }
            Ok(None) => false,
            // Treat an inability to query as exited so callers do not spin.
            Err(_) => {
                self.killed = true;
                true
            }
        }
    }
}

impl Drop for LaunchedBrowser {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Launches `binary` headless against `profile_dir`, routing all traffic through
/// the loopback policy proxy on `proxy_port`, and wires the CDP transport onto
/// the child's fds 3/4 per the `--remote-debugging-pipe` contract.
#[cfg(unix)]
pub fn launch(binary: &Path, profile_dir: &Path, proxy_port: u16) -> io::Result<LaunchedBrowser> {
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;

    // Two anonymous pipes carry the null-delimited CDP JSON. The child reads
    // commands on fd 3 and writes output on fd 4; the parent keeps the opposite
    // ends.
    let cmd_pipe = make_pipe()?; // [read (child fd 3), write (parent -> browser)]
    let out_pipe = match make_pipe() {
        Ok(p) => p,
        Err(e) => {
            close_fds(&cmd_pipe);
            return Err(e);
        }
    };
    let cmd_read = cmd_pipe[0]; // child fd 3
    let cmd_write = cmd_pipe[1]; // parent writes CDP commands to the browser
    let out_read = out_pipe[0]; // parent reads CDP output from the browser
    let out_write = out_pipe[1]; // child fd 4

    // Mark every raw fd close-on-exec. Parent ends must not leak into the child;
    // the child ends are relocated onto 3/4 in the pre_exec hook (dup2 clears
    // close-on-exec on the relocated fds), so their originals must auto-close on
    // exec instead of leaking as extra descriptors.
    let all = [cmd_read, cmd_write, out_read, out_write];
    for &fd in &all {
        if let Err(e) = set_cloexec(fd) {
            close_fds(&all);
            return Err(e);
        }
    }

    let mut command = Command::new(binary);

    // Command-line flags, in order. Grouped by intent; every flag is load-bearing
    // for a headless, isolated, policy-proxied browsing session.
    command
        // Headless engine and the pipe transport (no debugging TCP port opens).
        .arg("--headless=new")
        .arg("--remote-debugging-pipe");
    // Fresh throwaway profile.
    let mut user_data = std::ffi::OsString::from("--user-data-dir=");
    user_data.push(profile_dir);
    command.arg(user_data);
    // Force all traffic, including loopback, through the policy proxy. Without
    // --proxy-bypass-list=<-loopback> Chromium bypasses the proxy for localhost,
    // which would open a hole in the public-web-only policy.
    command
        .arg(format!("--proxy-server=http://127.0.0.1:{proxy_port}"))
        .arg("--proxy-bypass-list=<-loopback>")
        // WebRTC can otherwise emit ICE/STUN traffic directly over UDP,
        // outside the HTTP/CONNECT proxy, and reach private or link-local
        // destinations. Managed read sessions never need realtime media.
        .arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
        .arg("--webrtc-ip-handling-policy=disable_non_proxied_udp")
        .arg("--enforce-webrtc-ip-permission-check")
        // Quiet, non-phoning-home, extension-free session.
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg("--disable-component-update")
        .arg("--disable-sync")
        .arg("--disable-extensions")
        .arg("--disable-default-apps")
        .arg("--disable-breakpad")
        .arg("--metrics-recording-only")
        .arg("--mute-audio")
        .arg("--hide-scrollbars")
        .arg("--window-size=1280,900")
        // Start on a blank page; the broker navigates via CDP.
        .arg("about:blank");

    // Discard stdio. Chromium's stderr can contain URLs, and the privacy rule
    // (JUN-316) forbids capturing page-adjacent content in any log stream.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // In the forked child, before exec: relocate the child pipe ends onto exactly
    // fd 3 and fd 4. Dup them above 4 first so an original that already sits on 3
    // or 4 is not clobbered by dup2, then place them and drop the temporaries.
    unsafe {
        command.pre_exec(move || {
            let relocated_read = libc::fcntl(cmd_read, libc::F_DUPFD, 5);
            if relocated_read < 0 {
                return Err(io::Error::last_os_error());
            }
            let relocated_write = libc::fcntl(out_write, libc::F_DUPFD, 5);
            if relocated_write < 0 {
                libc::close(relocated_read);
                return Err(io::Error::last_os_error());
            }
            if libc::dup2(relocated_read, 3) < 0 {
                let err = io::Error::last_os_error();
                libc::close(relocated_read);
                libc::close(relocated_write);
                return Err(err);
            }
            if libc::dup2(relocated_write, 4) < 0 {
                let err = io::Error::last_os_error();
                libc::close(relocated_read);
                libc::close(relocated_write);
                return Err(err);
            }
            libc::close(relocated_read);
            libc::close(relocated_write);
            Ok(())
        });
    }

    let spawned = command.spawn();

    // The child ends are duplicated onto 3/4 in the child; the parent no longer
    // needs the originals whether or not the spawn succeeded.
    unsafe {
        libc::close(cmd_read);
        libc::close(out_write);
    }

    let child = match spawned {
        Ok(child) => child,
        Err(e) => {
            unsafe {
                libc::close(cmd_write);
                libc::close(out_read);
            }
            return Err(e);
        }
    };

    // The parent ends become the CDP transport files.
    let write_to_browser = unsafe { File::from_raw_fd(cmd_write) };
    let read_from_browser = unsafe { File::from_raw_fd(out_read) };

    Ok(LaunchedBrowser {
        child,
        cdp_pipes: Some((read_from_browser, write_to_browser)),
        killed: false,
    })
}

/// The managed browser requires the unix pipe/pre_exec machinery.
#[cfg(not(unix))]
pub fn launch(
    _binary: &Path,
    _profile_dir: &Path,
    _proxy_port: u16,
) -> io::Result<LaunchedBrowser> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the managed browser is only supported on unix platforms",
    ))
}

#[cfg(unix)]
fn make_pipe() -> io::Result<[libc::c_int; 2]> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: fds is a valid two-element array for libc::pipe to fill.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(fds)
}

#[cfg(unix)]
fn close_fds(fds: &[libc::c_int]) {
    for &fd in fds {
        // SAFETY: each fd was returned by libc::pipe and is not otherwise owned.
        unsafe {
            libc::close(fd);
        }
    }
}

#[cfg(unix)]
fn set_cloexec(fd: libc::c_int) -> io::Result<()> {
    // SAFETY: fd is a valid open descriptor; fcntl only reads/sets its flags.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_prefers_priority_order() {
        let root = tempfile::tempdir().unwrap();
        let brave = root.path().join("brave");
        let chromium = root.path().join("chromium");
        std::fs::write(&brave, b"x").unwrap();
        std::fs::write(&chromium, b"x").unwrap();
        // Chrome and Edge are missing; Brave outranks Chromium.
        let candidates = vec![
            (BrowserKind::Chrome, root.path().join("missing-chrome")),
            (BrowserKind::Edge, root.path().join("missing-edge")),
            (BrowserKind::Brave, brave.clone()),
            (BrowserKind::Chromium, chromium),
        ];
        let detected = detect_browser_among(&candidates).unwrap();
        assert_eq!(detected.kind, BrowserKind::Brave);
        assert_eq!(detected.path, brave);
    }

    #[test]
    fn detect_none_when_empty() {
        // No candidate exists: callers fall back to NO_BROWSER_MESSAGE.
        assert!(detect_browser_among(&[]).is_none());
        assert!(NO_BROWSER_MESSAGE.contains("No compatible browser is installed"));
    }

    #[test]
    fn ephemeral_profile_create_and_drop() {
        let root = tempfile::tempdir().unwrap();
        let path;
        {
            let profile = EphemeralProfile::create_in(root.path()).unwrap();
            path = profile.path().to_path_buf();
            assert!(path.exists());
            assert!(path.starts_with(root.path()));
        }
        // Drop removed the directory.
        assert!(!path.exists());
    }

    #[test]
    fn ephemeral_profile_explicit_delete() {
        let root = tempfile::tempdir().unwrap();
        let profile = EphemeralProfile::create_in(root.path()).unwrap();
        let path = profile.path().to_path_buf();
        assert!(path.exists());
        profile.delete();
        assert!(!path.exists());
    }

    #[test]
    fn create_places_profile_under_profiles_root() {
        let profile = EphemeralProfile::create().unwrap();
        assert!(profile.path().starts_with(profiles_root()));
        assert!(profile.path().exists());
        // Drop cleans up the real-root profile on scope exit.
    }

    #[test]
    fn sweep_removes_stale_entries() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("browser-profiles");
        std::fs::create_dir_all(base.join("stale1")).unwrap();
        std::fs::create_dir_all(base.join("stale2")).unwrap();
        std::fs::write(base.join("loose"), b"x").unwrap();
        assert!(base.exists());
        sweep_profiles_root_at(&base);
        assert!(!base.exists());
    }

    #[cfg(unix)]
    #[test]
    fn profile_guard_deletes_after_kill() {
        // Hermetic: a cheap long-running child stands in for the browser; we
        // never launch a real Chromium. The profile guard must still delete the
        // directory after the process is killed.
        let root = tempfile::tempdir().unwrap();
        let profile = EphemeralProfile::create_in(root.path()).unwrap();
        let dir = profile.path().to_path_buf();
        assert!(dir.exists());

        let child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut launched = LaunchedBrowser {
            child,
            cdp_pipes: None,
            killed: false,
        };

        launched.kill();
        // Idempotent second kill and exited check.
        launched.kill();
        assert!(launched.try_wait_exited());

        // The launched browser must not touch the profile; the guard owns it.
        assert!(dir.exists());
        drop(profile);
        assert!(!dir.exists());
    }
}
