//! Windows 11 keeps new tray icons in the overflow ("hidden icons") area until
//! the user promotes them. There is no supported `Shell_NotifyIcon` flag for
//! this; visibility is stored per executable under `NotifyIconSettings`.
//! After our tray icon registers, match `ExecutablePath` to this process and
//! set `IsPromoted` so the glyph stays on the main taskbar strip.

use std::path::Path;
use std::thread;
use std::time::Duration;

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const NOTIFY_ICON_SETTINGS: &str = r"Control Panel\NotifyIconSettings";

/// Retry delays: Explorer often writes `NotifyIconSettings` shortly after
/// `Shell_NotifyIcon(NIM_ADD)`, not necessarily in the same tick as our tray
/// builder returning.
const RETRY_SLEEP_MS: &[u64] = &[0, 120, 400, 1000, 2500];

pub fn spawn_promote_tray_icon_for_current_exe() {
    let Ok(our_exe) = std::env::current_exe() else {
        return;
    };

    thread::spawn(move || {
        for &delay_ms in RETRY_SLEEP_MS {
            if delay_ms > 0 {
                thread::sleep(Duration::from_millis(delay_ms));
            }
            match promote_once(&our_exe) {
                Ok(true) => break,
                Ok(false) | Err(_) => continue,
            }
        }
    });
}

fn normalize_compare_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    trimmed.replace('/', "\\").to_lowercase()
}

fn exe_compare_candidates(exe: &Path) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(s) = exe.to_str() {
        out.push(normalize_compare_path(s));
    }

    if let Ok(canonical) = std::fs::canonicalize(exe) {
        out.push(normalize_compare_path(&canonical.to_string_lossy()));
    }

    out.sort();
    out.dedup();
    out
}

fn registry_exe_matches(registry_path: &str, candidates: &[String]) -> bool {
    let reg = normalize_compare_path(registry_path);
    candidates.contains(&reg)
}

/// Returns `Ok(true)` if at least one `NotifyIconSettings` entry belongs to
/// this executable (whether or not we had to set `IsPromoted`).
fn promote_once(our_exe: &Path) -> std::io::Result<bool> {
    let candidates = exe_compare_candidates(our_exe);
    if candidates.is_empty() {
        return Ok(false);
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = match hkcu.open_subkey(NOTIFY_ICON_SETTINGS) {
        Ok(k) => k,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };

    let mut saw_ours = false;

    for key_name in settings.enum_keys().filter_map(Result::ok) {
        let sub = match settings.open_subkey_with_flags(&key_name, KEY_READ | KEY_WRITE) {
            Ok(k) => k,
            Err(_) => continue,
        };

        let exe_path: String = match sub.get_value("ExecutablePath") {
            Ok(s) => s,
            Err(_) => continue,
        };

        if !registry_exe_matches(&exe_path, &candidates) {
            continue;
        }

        saw_ours = true;

        let promoted: u32 = sub.get_value("IsPromoted").unwrap_or(0);
        if promoted != 1 {
            sub.set_value("IsPromoted", &1u32)?;
        }
    }

    Ok(saw_ours)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_verbatim_and_slash_style() {
        assert_eq!(
            normalize_compare_path(r"\\?\C:\APP\Foo.exe"),
            r"c:\app\foo.exe".to_string()
        );
        assert_eq!(
            normalize_compare_path("C:/APP/Foo.exe"),
            r"c:\app\foo.exe".to_string()
        );
    }

    #[test]
    fn registry_exe_matches_accounts_for_verbatim_canonical() {
        let candidates = vec![normalize_compare_path(r"C:\App\Foo.exe")];
        assert!(registry_exe_matches(r"\\?\C:\App\Foo.exe", &candidates));
    }
}
