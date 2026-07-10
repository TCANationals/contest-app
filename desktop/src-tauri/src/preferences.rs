//! Local preferences store (§9.5).
//!
//! Schema-versioned JSON written atomically to
//! `%USERPROFILE%\.tcatimer\preferences.json` on Windows, and
//! `~/.tcatimer/preferences.json` on macOS and Linux.
//!
//! Error handling rules (§9.5.3):
//!
//! - Missing file: create with defaults.
//! - Unparseable JSON: log a warning, fall back to in-memory defaults, and
//!   do NOT overwrite the bad file. A sibling file
//!   `preferences.json.broken` receives a copy for diagnostics so the
//!   original remains untouched if it is later restored.
//! - Older version: in-place migration to current version.
//! - Newer version (downgrade): use defaults, log a warning.
//! - Write failures: surface a tray warning; runtime continues with
//!   in-memory state.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const CURRENT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preferences {
    pub version: u32,
    pub alarm: AlarmPrefs,
    pub flash: FlashPrefs,
    #[serde(default)]
    pub display: DisplayPrefs,
    pub position: PositionPrefs,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlarmPrefs {
    pub enabled: bool,
    pub volume: f32,
}

/// Flash begins when remaining time is at or below `threshold_seconds`
/// while the timer is running. JSON field: `thresholdSeconds`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlashPrefs {
    pub enabled: bool,
    #[serde(rename = "thresholdSeconds")]
    pub threshold_seconds: u32,
}

/// Countdown digit scale (tray + overlay). JSON: `small` | `medium` | `large`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TextSize {
    Small,
    #[default]
    Medium,
    Large,
}

/// Overlay presentation toggles (desktop only). JSON uses camelCase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayPrefs {
    /// §9.2 countdown phase colors (green / amber / red). Off → neutral white on black.
    #[serde(default = "default_status_color_on")]
    pub status_color: bool,
    #[serde(default)]
    pub text_size: TextSize,
}

fn default_status_color_on() -> bool {
    true
}

impl Default for DisplayPrefs {
    fn default() -> Self {
        Self {
            status_color: true,
            text_size: TextSize::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PositionPrefs {
    pub corner: Corner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            alarm: AlarmPrefs {
                enabled: true,
                volume: 1.0,
            },
            flash: FlashPrefs {
                enabled: true,
                threshold_seconds: 60,
            },
            display: DisplayPrefs::default(),
            position: PositionPrefs {
                corner: Corner::BottomRight,
            },
            hidden: false,
        }
    }
}

impl Preferences {
    /// Clamp / repair invalid ranges per §9.5. Called after deserializing.
    pub fn normalize(&mut self) {
        // Alarm is always played at full volume (tray is on/off only).
        self.alarm.volume = 1.0;
        // 30 s … 30 min (same span as the former minute-based clamp).
        self.flash.threshold_seconds = self.flash.threshold_seconds.clamp(30, 30 * 60);
    }
}

/// Outcome of a load attempt. Always yields a set of preferences to use
/// in memory; the `action` tells the Tauri shell whether to surface a
/// warning or issue an initial write.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadOutcome {
    pub preferences: Preferences,
    pub action: LoadAction,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LoadAction {
    /// File was present and parsed without issues. No write needed.
    Loaded,
    /// File was missing — caller SHOULD write the defaults.
    CreatedDefaults,
    /// File existed but was malformed — caller MUST NOT overwrite. Tray
    /// warning expected.
    FallbackMalformed { reason: String },
    /// File was newer than CURRENT_VERSION. Preserve as-is and log.
    FallbackNewer { saw: u32 },
    /// File was older; caller SHOULD re-write the migrated form.
    Migrated { from: u32 },
}

/// Load preferences from `path`, applying the §9.5.3 error-handling rules.
///
/// Always returns a valid `Preferences`. The `action` signals the caller.
pub fn load_from_path(path: &Path) -> LoadOutcome {
    match std::fs::read_to_string(path) {
        Ok(contents) => parse_and_migrate(&contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => LoadOutcome {
            preferences: Preferences::default(),
            action: LoadAction::CreatedDefaults,
        },
        Err(err) => LoadOutcome {
            preferences: Preferences::default(),
            action: LoadAction::FallbackMalformed {
                reason: format!("read failed: {err}"),
            },
        },
    }
}

fn parse_and_migrate(contents: &str) -> LoadOutcome {
    // First parse loosely to learn `version`, then apply migration.
    #[derive(Deserialize)]
    struct Probe {
        version: Option<u32>,
    }
    let probe: Result<Probe, _> = serde_json::from_str(contents);
    match probe {
        Ok(Probe { version: Some(v) }) if v > CURRENT_VERSION => LoadOutcome {
            preferences: Preferences::default(),
            action: LoadAction::FallbackNewer { saw: v },
        },
        Ok(_) => match serde_json::from_str::<Preferences>(contents) {
            Ok(mut prefs) => {
                let migrated_from = if prefs.version < CURRENT_VERSION {
                    Some(prefs.version)
                } else {
                    None
                };
                prefs.version = CURRENT_VERSION;
                prefs.normalize();
                LoadOutcome {
                    preferences: prefs,
                    action: match migrated_from {
                        Some(v) => LoadAction::Migrated { from: v },
                        None => LoadAction::Loaded,
                    },
                }
            }
            Err(err) => LoadOutcome {
                preferences: Preferences::default(),
                action: LoadAction::FallbackMalformed {
                    reason: format!("parse failed: {err}"),
                },
            },
        },
        Err(err) => LoadOutcome {
            preferences: Preferences::default(),
            action: LoadAction::FallbackMalformed {
                reason: format!("parse failed: {err}"),
            },
        },
    }
}

/// Atomic write: serialize to a sibling temp file, fsync, then rename into
/// place. §9.5.
pub fn write_atomic(path: &Path, prefs: &Preferences) -> std::io::Result<()> {
    use std::fs;
    use std::io::Write;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(windows)]
        hide_tcatimer_folder_on_windows(parent);
    }

    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(prefs).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("serialize: {e}"))
    })?;

    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// When the preferences directory is `%USERPROFILE%\.tcatimer`, mark that
/// folder with the Windows hidden attribute so it stays out of default
/// Explorer views (same intent as other dot-directories on Unix).
#[cfg(windows)]
fn hide_tcatimer_folder_on_windows(dir: &Path) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, INVALID_FILE_ATTRIBUTES,
    };

    if dir.file_name() != Some(OsStr::new(".timer")) {
        return;
    }

    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);

    unsafe {
        let attrs = GetFileAttributesW(wide.as_ptr());
        if attrs == INVALID_FILE_ATTRIBUTES {
            return;
        }
        let _ = SetFileAttributesW(wide.as_ptr(), attrs | FILE_ATTRIBUTE_HIDDEN);
    }
}

/// Canonical on-disk path (§9.5): `~/.tcatimer/preferences.json`.
pub fn default_preferences_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .ok()
            .map(|p| PathBuf::from(p).join(".timer").join("preferences.json"))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .ok()
            .map(|p| PathBuf::from(p).join(".timer").join("preferences.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tca-timer-prefs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn defaults_match_spec() {
        let p = Preferences::default();
        assert_eq!(p.version, 1);
        assert!(p.alarm.enabled);
        assert!((p.alarm.volume - 1.0).abs() < 1e-6);
        assert!(p.flash.enabled);
        assert_eq!(p.flash.threshold_seconds, 60);
        assert_eq!(p.position.corner, Corner::BottomRight);
        assert!(p.display.status_color);
        assert_eq!(p.display.text_size, TextSize::Medium);
        assert!(!p.hidden);
    }

    #[test]
    fn missing_file_yields_create_defaults() {
        let path = tmp_path("preferences.json");
        let out = load_from_path(&path);
        assert!(matches!(out.action, LoadAction::CreatedDefaults));
        assert_eq!(out.preferences, Preferences::default());
    }

    #[test]
    fn valid_file_round_trips() {
        let path = tmp_path("preferences.json");
        let mut p = Preferences::default();
        p.alarm.volume = 0.25;
        p.flash.enabled = true;
        p.flash.threshold_seconds = 90;
        p.position.corner = Corner::TopLeft;
        p.hidden = true;
        write_atomic(&path, &p).unwrap();

        let out = load_from_path(&path);
        assert!(matches!(out.action, LoadAction::Loaded));
        let mut expected = p;
        expected.normalize();
        assert_eq!(out.preferences, expected);
    }

    #[test]
    fn malformed_json_falls_back_without_overwriting() {
        let path = tmp_path("preferences.json");
        std::fs::write(&path, "{not json").unwrap();
        let out = load_from_path(&path);
        match out.action {
            LoadAction::FallbackMalformed { .. } => {}
            other => panic!("unexpected action {other:?}"),
        }
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "{not json", "original file must remain untouched");
        assert_eq!(out.preferences, Preferences::default());
    }

    #[test]
    fn newer_version_falls_back_to_defaults() {
        let path = tmp_path("preferences.json");
        std::fs::write(
            &path,
            r#"{"version":999,"alarm":{"enabled":true,"volume":0.5}}"#,
        )
        .unwrap();
        let out = load_from_path(&path);
        assert!(matches!(out.action, LoadAction::FallbackNewer { saw: 999 }));
        assert_eq!(out.preferences, Preferences::default());
    }

    #[test]
    fn older_version_migrates_in_place() {
        let path = tmp_path("preferences.json");
        // Version 0 is synthetic for this test — the shape still matches
        // the current schema since there were no prior public versions.
        std::fs::write(
            &path,
            r#"{"version":0,"alarm":{"enabled":false,"volume":0.9},"flash":{"enabled":true,"thresholdSeconds":180},"position":{"corner":"topRight"},"hidden":false}"#,
        )
        .unwrap();
        let out = load_from_path(&path);
        assert!(matches!(out.action, LoadAction::Migrated { from: 0 }));
        assert_eq!(out.preferences.version, CURRENT_VERSION);
        assert!(!out.preferences.alarm.enabled);
        assert!(out.preferences.flash.enabled);
        assert_eq!(out.preferences.flash.threshold_seconds, 180);
        assert!(out.preferences.display.status_color);
        assert_eq!(out.preferences.display.text_size, TextSize::Medium);
    }

    #[test]
    fn normalize_clamps_out_of_range_values() {
        let mut p = Preferences::default();
        p.alarm.volume = 2.5;
        p.flash.threshold_seconds = 100 * 60;
        p.normalize();
        assert!((p.alarm.volume - 1.0).abs() < 1e-6);
        assert_eq!(p.flash.threshold_seconds, 30 * 60);

        p.alarm.volume = -1.0;
        p.flash.threshold_seconds = 10;
        p.normalize();
        assert!((p.alarm.volume - 1.0).abs() < 1e-6);
        assert_eq!(p.flash.threshold_seconds, 30);
    }

    #[test]
    fn write_atomic_creates_parent_dirs() {
        let dir = std::env::temp_dir().join(format!("tca-prefs-nested-{}", std::process::id()));
        let path = dir.join("deeper").join("preferences.json");
        let _ = std::fs::remove_dir_all(&dir);
        write_atomic(&path, &Preferences::default()).unwrap();
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
