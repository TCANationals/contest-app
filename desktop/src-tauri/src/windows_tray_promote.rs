//! Windows 11 keeps new tray icons in the overflow ("hidden icons") area until
//! the user promotes them. There is no supported `Shell_NotifyIcon` flag for
//! this; visibility is stored per executable under `NotifyIconSettings`.
//! After our tray icon registers, match `ExecutablePath` to this process and
//! set `IsPromoted` so the glyph stays on the main taskbar strip.
//!
//! Explorer often stores `ExecutablePath` as a **Known Folder**–relative path:
//! `{FOLDERID-GUID}\relative\app.exe` instead of `C:\Program Files\...`. We
//! resolve folder roots with [`SHGetKnownFolderPath`] (same as Win32
//! `GetKnownFolderPath` / shell known-folder APIs) using [`FOLDERID_*`] ids
//! from `windows-sys`, and synthesize matching `{guid}\relative` strings from
//! the process path.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_LocalAppData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesCommon,
    FOLDERID_ProgramFilesCommonX64, FOLDERID_ProgramFilesCommonX86, FOLDERID_ProgramFilesX64,
    FOLDERID_ProgramFilesX86, FOLDERID_RoamingAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

/// Dev-only stdout traces (`cargo tauri dev` / debug builds). Release and
/// `cargo test` stay silent.
#[cfg(all(debug_assertions, not(test)))]
fn tray_promote_debug(msg: impl std::fmt::Display) {
    println!("[tca-timer tray-promote] {msg}");
}

#[cfg(not(all(debug_assertions, not(test))))]
fn tray_promote_debug(_msg: impl std::fmt::Display) {}

const NOTIFY_ICON_SETTINGS: &str = r"Control Panel\NotifyIconSettings";

/// Folders Explorer commonly uses in `NotifyIconSettings` `ExecutablePath`.
const KNOWN_TRAY_FOLDERS: &[GUID] = &[
    FOLDERID_ProgramFilesX64,
    FOLDERID_ProgramFilesX86,
    FOLDERID_ProgramFiles,
    FOLDERID_ProgramFilesCommon,
    FOLDERID_ProgramFilesCommonX64,
    FOLDERID_ProgramFilesCommonX86,
    FOLDERID_LocalAppData,
    FOLDERID_RoamingAppData,
];

/// Retry delays: Explorer often writes `NotifyIconSettings` shortly after
/// `Shell_NotifyIcon(NIM_ADD)`, not necessarily in the same tick as our tray
/// builder returning.
const RETRY_SLEEP_MS: &[u64] = &[0, 120, 400, 1000, 2500];

pub fn spawn_promote_tray_icon_for_current_exe() {
    let Ok(our_exe) = std::env::current_exe() else {
        tray_promote_debug("skipped: current_exe() failed");
        return;
    };

    tray_promote_debug(format!(
        "started background promotion for {}",
        our_exe.display()
    ));

    thread::spawn(move || {
        let mut last_io_err: Option<std::io::Error> = None;
        for (attempt, &delay_ms) in RETRY_SLEEP_MS.iter().enumerate() {
            if delay_ms > 0 {
                thread::sleep(Duration::from_millis(delay_ms));
            }
            match promote_once(&our_exe, attempt + 1, delay_ms) {
                Ok(true) => {
                    tray_promote_debug(format!(
                        "finished successfully (attempt {} after delay_ms={})",
                        attempt + 1,
                        delay_ms
                    ));
                    return;
                }
                Ok(false) => {
                    tray_promote_debug(format!(
                        "attempt {}: no matching NotifyIconSettings row yet (delay_ms={})",
                        attempt + 1,
                        delay_ms
                    ));
                }
                Err(e) => {
                    tray_promote_debug(format!(
                        "attempt {}: registry error: {e} (delay_ms={})",
                        attempt + 1,
                        delay_ms
                    ));
                    last_io_err = Some(e);
                }
            }
        }
        tray_promote_debug(format!(
            "stopped after {} attempts; {}",
            RETRY_SLEEP_MS.len(),
            match last_io_err {
                Some(e) => format!("last error: {e}"),
                None =>
                    "Explorer never registered a matching ExecutablePath (timing or path mismatch)"
                        .to_string(),
            }
        ));
    });
}

fn normalize_compare_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    trimmed.replace('/', "\\").to_lowercase()
}

/// Lowercase hyphenated GUID string (matches `NotifyIconSettings` brace-inner text).
fn format_guid_lower(g: &GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        g.data1,
        g.data2,
        g.data3,
        g.data4[0],
        g.data4[1],
        g.data4[2],
        g.data4[3],
        g.data4[4],
        g.data4[5],
        g.data4[6],
        g.data4[7],
    )
}

fn folder_id_matching_registry_guid(guid_str: &str) -> Option<GUID> {
    let needle = guid_str.trim().to_ascii_lowercase();
    KNOWN_TRAY_FOLDERS
        .iter()
        .copied()
        .find(|id| format_guid_lower(id) == needle)
}

/// `{GUID}\relative\exe` → `(guid_inner, relative)` where `guid_inner` is the text inside `{…}`.
fn split_known_folder_executable(raw: &str) -> Option<(String, String)> {
    let s = raw.trim();
    let inner = s.strip_prefix('{')?;
    let close = inner.find('}')?;
    let guid = inner[..close].trim().to_string();
    let after = inner[close + 1..].trim_start();
    let tail = after.strip_prefix('\\').unwrap_or(after);
    if guid.is_empty() {
        return None;
    }
    Some((guid, tail.to_string()))
}

fn get_known_folder_path(folder_id: &GUID) -> Option<PathBuf> {
    let mut pwstr = std::ptr::null_mut();
    let hr =
        unsafe { SHGetKnownFolderPath(folder_id, KF_FLAG_DEFAULT, HANDLE::default(), &mut pwstr) };
    if hr != 0 || pwstr.is_null() {
        return None;
    }

    unsafe {
        let mut len = 0usize;
        while *pwstr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(pwstr, len);
        let path = PathBuf::from(OsString::from_wide(slice));
        CoTaskMemFree(pwstr.cast());
        Some(path)
    }
}

fn path_for_registry_known_folder_guid(guid_str: &str) -> Option<PathBuf> {
    let id = folder_id_matching_registry_guid(guid_str)?;
    get_known_folder_path(&id)
}

fn normalized_registry_paths(reg_value: &str) -> Vec<String> {
    let mut out = Vec::new();
    out.push(normalize_compare_path(reg_value));

    if let Some((guid, tail)) = split_known_folder_executable(reg_value) {
        if let Some(base) = path_for_registry_known_folder_guid(&guid) {
            let joined = base.join(&tail);
            out.push(normalize_compare_path(&joined.to_string_lossy()));
            if let Ok(canon) = std::fs::canonicalize(&joined) {
                out.push(normalize_compare_path(&canon.to_string_lossy()));
            }
        }
    }

    out.sort();
    out.dedup();
    out
}

fn push_synthetic_guid_paths(canonical_norm: &str, out: &mut Vec<String>) {
    for folder_id in KNOWN_TRAY_FOLDERS {
        let Some(base) = get_known_folder_path(folder_id) else {
            continue;
        };
        let base_norm = normalize_compare_path(&base.to_string_lossy());
        let prefix = format!("{base_norm}\\");
        let Some(rest) = canonical_norm.strip_prefix(&prefix) else {
            continue;
        };
        let synthetic = format!("{{{}}}\\{rest}", format_guid_lower(folder_id));
        out.push(normalize_compare_path(&synthetic));
    }
}

fn exe_compare_candidates(exe: &Path) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(s) = exe.to_str() {
        out.push(normalize_compare_path(s));
    }

    let canonical_opt = std::fs::canonicalize(exe).ok();
    if let Some(ref canonical) = canonical_opt {
        out.push(normalize_compare_path(&canonical.to_string_lossy()));
    }

    let canonical_norm = canonical_opt
        .as_ref()
        .map(|p| normalize_compare_path(&p.to_string_lossy()))
        .or_else(|| exe.to_str().map(normalize_compare_path));

    if let Some(cn) = canonical_norm {
        push_synthetic_guid_paths(&cn, &mut out);
    }

    out.sort();
    out.dedup();
    out
}

fn registry_exe_matches(registry_path: &str, candidates: &[String]) -> bool {
    let reg_norms = normalized_registry_paths(registry_path);
    reg_norms.iter().any(|r| candidates.contains(r))
}

/// Returns `Ok(true)` if at least one `NotifyIconSettings` entry belongs to
/// this executable (whether or not we had to set `IsPromoted`).
fn promote_once(our_exe: &Path, attempt: usize, delay_ms: u64) -> std::io::Result<bool> {
    let candidates = exe_compare_candidates(our_exe);
    if candidates.is_empty() {
        tray_promote_debug(format!(
            "attempt {attempt}: no path candidates from {}",
            our_exe.display()
        ));
        return Ok(false);
    }

    tray_promote_debug(format!(
        "attempt {attempt}: {} normalized path candidate(s) (delay_ms={delay_ms})",
        candidates.len()
    ));
    if attempt == 1 {
        for (i, c) in candidates.iter().take(8).enumerate() {
            tray_promote_debug(format!("  candidate[{}]: {}", i, c));
        }
        if candidates.len() > 8 {
            tray_promote_debug(format!(
                "  … and {} more",
                candidates.len().saturating_sub(8)
            ));
        }
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = match hkcu.open_subkey(NOTIFY_ICON_SETTINGS) {
        Ok(k) => k,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tray_promote_debug(format!(
                "attempt {attempt}: registry key missing: HKCU\\{NOTIFY_ICON_SETTINGS}"
            ));
            return Ok(false);
        }
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

        let reg_norms = normalized_registry_paths(&exe_path);
        let promoted: u32 = sub.get_value("IsPromoted").unwrap_or(0);

        tray_promote_debug(format!(
            "matched setting {} … ExecutablePath={exe_path:?}",
            key_name
        ));
        tray_promote_debug(format!(
            "  normalized registry forms: {}",
            reg_norms.join(" | ")
        ));
        tray_promote_debug(format!(
            "  IsPromoted={promoted}{}",
            if promoted == 1 {
                " (already on taskbar strip)"
            } else {
                ", writing IsPromoted=1"
            }
        ));

        saw_ours = true;

        if promoted != 1 {
            sub.set_value("IsPromoted", &1u32)?;
            tray_promote_debug("  registry updated");
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

    #[test]
    fn split_known_folder_round_trip() {
        let s = r"{6D809377-6AF0-444B-8957-A3773F02200E}\Timer\timer-desktop.exe";
        let (g, tail) = split_known_folder_executable(s).unwrap();
        assert_eq!(g, "6D809377-6AF0-444B-8957-A3773F02200E");
        assert_eq!(tail, r"Timer\timer-desktop.exe");
    }

    #[test]
    fn folder_id_format_matches_typical_notify_icon_program_files_x64() {
        assert_eq!(
            format_guid_lower(&FOLDERID_ProgramFilesX64),
            "6d809377-6af0-444b-8957-a3773f02200e"
        );
    }

    #[test]
    fn synthetic_guid_path_matches_registry_style() {
        let cn = normalize_compare_path(r"C:\Program Files\Timer\timer-desktop.exe");
        let bn = normalize_compare_path(r"C:\Program Files");
        let prefix = format!("{bn}\\");
        let rest = cn.strip_prefix(&prefix).unwrap();
        let synthetic = normalize_compare_path(&format!(
            "{{{}}}\\{rest}",
            format_guid_lower(&FOLDERID_ProgramFilesX64)
        ));
        let reg_line = normalize_compare_path(
            r"{6D809377-6AF0-444B-8957-A3773F02200E}\Timer\timer-desktop.exe",
        );
        assert_eq!(synthetic, reg_line);
    }
}
