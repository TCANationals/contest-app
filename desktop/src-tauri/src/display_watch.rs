//! Display-change command runner.
//!
//! Mirrors the behavior of the legacy Electron app
//! ([`index.js`](https://github.com/TCANationals/timer-desktop/blob/main/index.js)):
//! whenever the Windows display configuration changes — primary
//! resolution, DPI, monitor connect/disconnect — invoke an externally
//! configured command (typically Sysinternals' `BgInfo.exe`) so the
//! desktop wallpaper and any other resolution-dependent UI gets
//! refreshed.
//!
//! The watcher polls the monitor list every [`POLL_INTERVAL`] and fires
//! the optional external command whenever the fingerprint changes. The
//! same tick also runs [`WatchOptions::on_monitors_changed`] so the
//! overlay window can re-pin to the user's corner after resolution /
//! arrangement changes that never emit `ScaleFactorChanged`. We poll
//! instead of relying on a single platform-specific event because no
//! portable "displays-changed" event exists in Tauri / `tao`, and the
//! legacy app likewise polled (every 2 s) on top of its event listeners
//! as a safety net. The Tauri `WindowEvent::ScaleFactorChanged` handler
//! in `main.rs` calls [`DisplayWatcher::trigger`] directly so DPI
//! changes don't have to wait for the next poll tick.
//!
//! The command is **only spawned on Windows** — on macOS / Linux the
//! watcher still runs (so we surface debug logging during dev) but
//! [`spawn_command`] is a no-op. This matches the legacy app's
//! `os.platform() != 'win32'` early-return.
//!
//! When a command is configured we also run it once at overlay startup
//! ([`run_startup`]) so the desktop reflects the current layout even if
//! the display configuration did not change since the last run.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

/// Optional hook after a **real** monitor-configuration change (not the
/// initial baseline sample). `main.rs` installs this to re-pin the overlay.
pub type MonitorChangeCallback = Arc<dyn Fn(&AppHandle) + Send + Sync>;

/// Configuration for [`start`].
pub struct WatchOptions {
    /// Windows-only BgInfo-style refresh command; [`None`] skips spawning.
    pub command_argv: Option<Vec<String>>,
    /// Overlay repositioning (and any similar work) when monitors move,
    /// resize, connect, or disconnect.
    pub on_monitors_changed: Option<MonitorChangeCallback>,
}
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, PhysicalPosition, PhysicalSize};

/// How often to re-read the monitor list. The legacy Electron app polls
/// every 2 000 ms; we match that. Faster polling is wasteful (there's
/// nothing useful to do between display-config changes); slower polling
/// would visibly delay the BgInfo refresh after a real change.
const POLL_INTERVAL: Duration = Duration::from_millis(2_000);

/// Snapshot of one monitor's geometry. We compare these by value to
/// detect changes — equality on the whole `Vec<MonitorFingerprint>`
/// implies the display configuration is unchanged.
///
/// `name` is included because two monitors with identical geometry can
/// still represent different physical displays (e.g. swapping a primary
/// after a dock disconnect/reconnect), and we'd want to refresh BgInfo
/// in that case too.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MonitorFingerprint {
    name: Option<String>,
    position: (i32, i32),
    size: (u32, u32),
    /// Scale factor scaled by 1 000 so we can `Eq` it without floats.
    /// 1.0 → 1000, 1.25 → 1250. Sub-permille DPI changes are not
    /// meaningful and would just thrash the command.
    scale_milli: u32,
}

impl MonitorFingerprint {
    fn from_parts(
        name: Option<&str>,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        scale_factor: f64,
    ) -> Self {
        Self {
            name: name.map(str::to_owned),
            position: (position.x, position.y),
            size: (size.width, size.height),
            scale_milli: (scale_factor * 1_000.0).round() as u32,
        }
    }
}

/// Stable, order-independent fingerprint of the entire monitor set.
/// Sorting by name+position means the OS can hand us monitors back in a
/// different order without us spuriously firing the command.
fn normalize(mut monitors: Vec<MonitorFingerprint>) -> Vec<MonitorFingerprint> {
    monitors.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.position.cmp(&b.position))
            .then_with(|| a.size.cmp(&b.size))
    });
    monitors
}

fn snapshot_monitors(app: &AppHandle) -> Option<Vec<MonitorFingerprint>> {
    let monitors = app.available_monitors().ok()?;
    let fingerprints = monitors
        .iter()
        .map(|m| {
            MonitorFingerprint::from_parts(m.name().map(String::as_str), *m.position(), *m.size(), m.scale_factor())
        })
        .collect();
    Some(normalize(fingerprints))
}

/// Spawn the configured command and detach. We deliberately do **not**
/// wait for it: BgInfo and similar refresh tools take noticeable
/// wall-clock time, and blocking the watcher thread on them would mean
/// we'd miss a rapid second display change (e.g. user toggling
/// projector mode). Errors are logged to stderr and otherwise ignored —
/// a missing or unreadable command must not crash the overlay.
#[cfg(windows)]
fn spawn_command(argv: &[String]) {
    use std::process::Command;
    let Some((program, args)) = argv.split_first() else {
        return;
    };
    match Command::new(program).args(args).spawn() {
        Ok(_child) => {
            eprintln!(
                "tca-timer: display-change command spawned: {} ({} args)",
                program,
                args.len()
            );
        }
        Err(err) => {
            eprintln!(
                "tca-timer: display-change command failed to spawn ({}): {err}",
                program
            );
        }
    }
}

#[cfg(not(windows))]
fn spawn_command(argv: &[String]) {
    // Match the legacy Electron app: the BgInfo refresh hook is a
    // Windows-only concept (it pokes Win32 shell APIs). On macOS /
    // Linux we still emit a debug line so dev builds can confirm the
    // watcher is wired up correctly.
    if let Some(program) = argv.first() {
        eprintln!(
            "tca-timer: display-change detected; not spawning {program} (non-Windows host)"
        );
    }
}

/// Run the configured refresh command once at application startup.
///
/// Independent of [`DisplayWatcher`] change detection: the watcher still
/// skips firing on its first fingerprint sample so this does not cause a
/// duplicate spawn on the next poll tick when the layout is unchanged.
pub fn run_startup(argv: &[String]) {
    spawn_command(argv);
}

/// Handle returned by [`start`]. Holding it keeps the watcher thread
/// alive; dropping it is fine in `main.rs` (the thread runs for the
/// lifetime of the process) but exposing the explicit handle lets us
/// trigger the command on demand from the `ScaleFactorChanged` window
/// event without waiting for the next poll tick.
#[derive(Clone)]
pub struct DisplayWatcher {
    inner: Arc<Inner>,
}

struct Inner {
    command_argv: Option<Vec<String>>,
    on_monitors_changed: Option<MonitorChangeCallback>,
    /// Fingerprint of the last monitor configuration we observed.
    /// Shared with the polling thread so [`DisplayWatcher::trigger`] can
    /// re-check before firing — that way the explicit
    /// `ScaleFactorChanged` trigger doesn't double-fire alongside the
    /// next poll tick.
    last_fingerprint: Mutex<Option<Vec<MonitorFingerprint>>>,
    /// Flipped to `true` once the polling thread has captured the
    /// initial configuration. We don't fire the command on this initial
    /// read — only on real *changes* — but a `trigger()` call from a
    /// scale-factor event before the first poll should still establish
    /// the baseline (firing if a real change is detected).
    initialized: AtomicBool,
}

impl DisplayWatcher {
    /// Force a re-check of the monitor configuration. Fires the
    /// configured command if the configuration has changed since the
    /// last observation. Cheap to call; safe to call before the
    /// polling thread has produced its first reading.
    pub fn trigger(&self, app: &AppHandle) {
        self.check(app);
    }

    fn check(&self, app: &AppHandle) {
        let Some(current) = snapshot_monitors(app) else {
            return;
        };
        let mut guard = self
            .inner
            .last_fingerprint
            .lock()
            .expect("display fingerprint mutex poisoned");
        let changed = match guard.as_ref() {
            Some(prev) => prev != &current,
            None => false,
        };
        let was_initialized = self.inner.initialized.swap(true, Ordering::SeqCst);
        *guard = Some(current);
        drop(guard);

        // Only react on real changes. The first observation (whether from
        // the polling thread or an early `trigger()`) establishes the
        // baseline silently.
        if was_initialized && changed {
            if let Some(argv) = self.inner.command_argv.as_ref() {
                spawn_command(argv);
            }
            if let Some(cb) = self.inner.on_monitors_changed.as_ref() {
                cb(app);
            }
        }
    }
}

/// Spawn the polling thread and return a handle. The thread runs until
/// the process exits; the returned handle can be used to force an
/// extra check from a window event.
///
pub fn start(app: AppHandle, options: WatchOptions) -> DisplayWatcher {
    let watcher = DisplayWatcher {
        inner: Arc::new(Inner {
            command_argv: options.command_argv,
            on_monitors_changed: options.on_monitors_changed,
            last_fingerprint: Mutex::new(None),
            initialized: AtomicBool::new(false),
        }),
    };
    let watcher_for_thread = watcher.clone();
    let app_for_thread = app.clone();
    thread::Builder::new()
        .name("tca-timer-display-watch".into())
        .spawn(move || loop {
            watcher_for_thread.check(&app_for_thread);
            thread::sleep(POLL_INTERVAL);
        })
        .expect("failed to spawn display-watch thread");
    watcher
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(name: &str, x: i32, y: i32, w: u32, h: u32, scale: f64) -> MonitorFingerprint {
        MonitorFingerprint::from_parts(
            Some(name),
            PhysicalPosition::new(x, y),
            PhysicalSize::new(w, h),
            scale,
        )
    }

    #[test]
    fn normalize_is_stable_across_input_orderings() {
        let a = fp("DP-1", 0, 0, 1920, 1080, 1.0);
        let b = fp("HDMI-1", 1920, 0, 2560, 1440, 1.25);
        let c = fp("eDP-1", -1440, 0, 1440, 900, 2.0);

        let one = normalize(vec![a.clone(), b.clone(), c.clone()]);
        let two = normalize(vec![c, b, a]);
        assert_eq!(one, two, "fingerprint must be order-independent");
    }

    #[test]
    fn fingerprint_distinguishes_resolution_changes() {
        let before = vec![fp("DP-1", 0, 0, 1920, 1080, 1.0)];
        let after = vec![fp("DP-1", 0, 0, 2560, 1440, 1.0)];
        assert_ne!(normalize(before), normalize(after));
    }

    #[test]
    fn fingerprint_distinguishes_dpi_changes() {
        let before = vec![fp("DP-1", 0, 0, 1920, 1080, 1.0)];
        let after = vec![fp("DP-1", 0, 0, 1920, 1080, 1.25)];
        assert_ne!(normalize(before), normalize(after));
    }

    #[test]
    fn fingerprint_ignores_subpermille_dpi_drift() {
        // Real monitors occasionally report `1.0000001`-style scale
        // factors due to float rounding. Treating those as a real
        // change would re-fire BgInfo on every poll — guard against it
        // by quantizing to milli-units.
        let before = vec![fp("DP-1", 0, 0, 1920, 1080, 1.0)];
        let after = vec![fp("DP-1", 0, 0, 1920, 1080, 1.0001)];
        assert_eq!(normalize(before), normalize(after));
    }

    #[test]
    fn fingerprint_distinguishes_added_or_removed_monitors() {
        let single = vec![fp("DP-1", 0, 0, 1920, 1080, 1.0)];
        let dual = vec![
            fp("DP-1", 0, 0, 1920, 1080, 1.0),
            fp("HDMI-1", 1920, 0, 1920, 1080, 1.0),
        ];
        assert_ne!(normalize(single), normalize(dual));
    }

    #[test]
    fn fingerprint_distinguishes_repositioned_monitors() {
        // User dragged the secondary monitor from "right of primary"
        // to "above primary" in the OS display arrangement panel.
        let before = vec![
            fp("DP-1", 0, 0, 1920, 1080, 1.0),
            fp("HDMI-1", 1920, 0, 1920, 1080, 1.0),
        ];
        let after = vec![
            fp("DP-1", 0, 0, 1920, 1080, 1.0),
            fp("HDMI-1", 0, -1080, 1920, 1080, 1.0),
        ];
        assert_ne!(normalize(before), normalize(after));
    }
}
