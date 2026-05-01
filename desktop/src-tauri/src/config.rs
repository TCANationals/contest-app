//! Desktop configuration resolution (§9.4).
//!
//! At launch, the overlay resolves `roomKey` and `serverHost` by
//! checking these sources in priority order, picking the first source
//! that supplies a non-empty value for each key independently:
//!
//! 1. Command-line flags: `--room-key <key>`, `--server <host>`.
//! 2. Windows registry (production):
//!    `HKLM\Software\TCANationals\Timer\RoomKey`, `\Server`.
//! 3. Config file: `%PROGRAMDATA%\TCATimer\config.json` on Windows,
//!    `/Library/Application Support/TCATimer/config.json` on macOS, and
//!    `/etc/tca-timer/config.json` on Linux. JSON keys `roomKey`,
//!    `server`.
//! 4. Environment variables: `TCA_TIMER_ROOM_KEY`, `TCA_TIMER_SERVER`.
//!
//! `roomKey` has no default — if no source supplies it, the overlay
//! renders a "Configuration error" banner instead of attempting a
//! connection. `serverHost` defaults to [`DEFAULT_SERVER_HOST`] when
//! no source supplies it.
//!
//! The module is written against an injected [`ConfigSources`] snapshot so
//! tests can assert every resolution branch without touching real
//! registry / env / filesystem state.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Fallback server host when no source supplies one. The user can override
/// it via any of the sources in [`ConfigSources`] at runtime.
pub const DEFAULT_SERVER_HOST: &str = "timer.tcanationals.com";

/// Fully-resolved desktop configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub room_key: String,
    pub server_host: String,
}

impl DesktopConfig {
    /// WebSocket URL the overlay uses for the contestant endpoint (§5.1).
    ///
    /// Currently the frontend builds the URL on its own via the bootstrap
    /// payload, but we keep the Rust-side helper so CLI tools and tests
    /// can produce the exact same URL without duplicating the format.
    #[allow(dead_code)]
    pub fn contestant_ws_url(&self, contestant_id: &str) -> String {
        format!(
            "wss://{host}/contestant?key={key}&id={id}",
            host = self.server_host,
            key = urlencode(&self.room_key),
            id = urlencode(contestant_id),
        )
    }
}

/// Human-readable record of which sources were tried and what they
/// produced, for the tray tooltip on config error (§9.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReport {
    pub sources: Vec<SourceOutcome>,
    /// The default host used when no source supplied one.
    pub default_server_host: &'static str,
}

/// Per-source outcome entry. `found` lists the keys (`roomKey`,
/// `server`) that this specific source actually supplied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceOutcome {
    pub source: &'static str,
    pub available: bool,
    pub found: Vec<&'static str>,
    pub note: Option<String>,
}

/// Resolution failure: at least one required field was missing from every
/// source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigError {
    pub missing: Vec<&'static str>,
    pub report: ConfigReport,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Configuration error: missing {}",
            self.missing.join(", ")
        )
    }
}

impl std::error::Error for ConfigError {}

/// Raw data extracted from a single source. `None` means the source did
/// not supply a value; empty strings are normalized to `None` during
/// resolution.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SourceValues {
    pub room_key: Option<String>,
    pub server: Option<String>,
}

impl SourceValues {
    fn nonempty(raw: Option<String>) -> Option<String> {
        raw.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
    }

    fn normalize(self) -> Self {
        Self {
            room_key: Self::nonempty(self.room_key),
            server: Self::nonempty(self.server),
        }
    }

    fn found_keys(&self) -> Vec<&'static str> {
        let mut v = Vec::new();
        if self.room_key.is_some() {
            v.push("roomKey");
        }
        if self.server.is_some() {
            v.push("server");
        }
        v
    }
}

/// Snapshot of every source the resolver consults. Keep this injectable so
/// we can test every branch deterministically. The Tauri entry point
/// constructs it from real I/O via [`ConfigSources::live`].
#[derive(Debug, Default, Clone)]
pub struct ConfigSources {
    pub cli: SourceEntry,
    pub registry: SourceEntry,
    pub file: SourceEntry,
    pub env: SourceEntry,
}

#[derive(Debug, Default, Clone)]
pub struct SourceEntry {
    pub available: bool,
    pub values: SourceValues,
    pub note: Option<String>,
}

impl SourceEntry {
    fn from_values(values: SourceValues) -> Self {
        let normalized = values.normalize();
        let available = normalized.room_key.is_some() || normalized.server.is_some();
        Self {
            available,
            values: normalized,
            note: None,
        }
    }
}

/// Parse `argv` (excluding the process name) into a `SourceEntry`. Accepts
/// both `--flag value` and `--flag=value` forms. Unknown flags are ignored
/// — the overlay is routinely launched with other platform-specific args.
pub fn parse_cli_args(argv: &[String]) -> SourceEntry {
    let mut values = SourceValues::default();
    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        let (flag, inline_value) = split_flag(arg);
        let slot: &mut Option<String> = match flag {
            "--room-key" => &mut values.room_key,
            "--server" | "--server-host" => &mut values.server,
            _ => continue,
        };
        if let Some(v) = inline_value {
            *slot = Some(v.to_owned());
        } else if let Some(next) = iter.next() {
            *slot = Some(next.clone());
        }
    }
    SourceEntry::from_values(values)
}

fn split_flag(arg: &str) -> (&str, Option<&str>) {
    match arg.split_once('=') {
        Some((flag, value)) => (flag, Some(value)),
        None => (arg, None),
    }
}

/// Parse the JSON shape used for the config file. Unknown keys are
/// ignored. Missing / unparseable yields an `available=false` entry with a
/// diagnostic note.
pub fn parse_config_file(contents: &str) -> SourceEntry {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FileShape {
        room_key: Option<String>,
        server: Option<String>,
    }
    match serde_json::from_str::<FileShape>(contents) {
        Ok(shape) => SourceEntry::from_values(SourceValues {
            room_key: shape.room_key,
            server: shape.server,
        }),
        Err(err) => SourceEntry {
            available: false,
            values: SourceValues::default(),
            note: Some(format!("unparseable: {err}")),
        },
    }
}

/// Convenience: parse_config_file after a best-effort read.
pub fn read_config_file(path: &std::path::Path) -> SourceEntry {
    match std::fs::read_to_string(path) {
        Ok(s) => parse_config_file(&s),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => SourceEntry {
            available: false,
            values: SourceValues::default(),
            note: Some(format!("not found: {}", path.display())),
        },
        Err(err) => SourceEntry {
            available: false,
            values: SourceValues::default(),
            note: Some(format!("read failed ({}): {err}", path.display())),
        },
    }
}

/// Canonical config file path by platform (§9.4).
///
/// - **Windows:** `%PROGRAMDATA%\TCATimer\config.json`
///   (`C:\ProgramData\TCATimer\config.json` by default).
/// - **macOS:** `/Library/Application Support/TCATimer/config.json` —
///   the system-wide "Application Support" location appropriate for a
///   venue-provisioned machine.
/// - **Linux / other Unix:** `/etc/tca-timer/config.json`.
pub fn default_config_file_path() -> PathBuf {
    #[cfg(windows)]
    {
        let programdata =
            std::env::var("ProgramData").unwrap_or_else(|_| "C:/ProgramData".to_string());
        PathBuf::from(programdata)
            .join("TCATimer")
            .join("config.json")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/TCATimer/config.json")
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        PathBuf::from("/etc/tca-timer/config.json")
    }
}

/// Canonical Windows registry key path (§9.4). Consumed only by the
/// Windows-gated implementation below; kept `pub` so provisioning tooling
/// has a single source of truth.
#[allow(dead_code)]
pub const REGISTRY_SUBKEY: &str = r"Software\TCANationals\Timer";

/// Windows registry read. No-op (empty entry) on non-Windows.
pub fn read_registry() -> SourceEntry {
    #[cfg(windows)]
    {
        match read_registry_windows() {
            Ok(values) => SourceEntry::from_values(values),
            Err(err) => SourceEntry {
                available: false,
                values: SourceValues::default(),
                note: Some(format!("registry read failed: {err}")),
            },
        }
    }
    #[cfg(not(windows))]
    {
        SourceEntry {
            available: false,
            values: SourceValues::default(),
            note: Some("registry only available on Windows".to_string()),
        }
    }
}

#[cfg(windows)]
fn read_registry_windows() -> std::io::Result<SourceValues> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    match hklm.open_subkey(REGISTRY_SUBKEY) {
        Ok(key) => {
            let get = |name: &str| -> Option<String> { key.get_value::<String, _>(name).ok() };
            Ok(SourceValues {
                room_key: get("RoomKey"),
                server: get("Server"),
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(SourceValues::default()),
        Err(err) => Err(err),
    }
}

/// Read relevant environment variables.
pub fn read_env() -> SourceEntry {
    SourceEntry::from_values(SourceValues {
        room_key: std::env::var("TCA_TIMER_ROOM_KEY").ok(),
        server: std::env::var("TCA_TIMER_SERVER").ok(),
    })
}

impl ConfigSources {
    /// Build sources from real I/O at the canonical paths / env vars.
    pub fn live(argv: &[String]) -> Self {
        let cli = parse_cli_args(argv);
        let registry = read_registry();
        let file = read_config_file(&default_config_file_path());
        let env = read_env();
        Self {
            cli,
            registry,
            file,
            env,
        }
    }
}

/// Resolve the config values using the priority order in §9.4.
pub fn resolve(sources: &ConfigSources) -> Result<(DesktopConfig, ConfigReport), ConfigError> {
    let ordered: [(&'static str, &SourceEntry); 4] = [
        ("cli", &sources.cli),
        ("registry", &sources.registry),
        ("file", &sources.file),
        ("env", &sources.env),
    ];

    let mut room_key: Option<String> = None;
    let mut server: Option<String> = None;

    let mut outcomes = Vec::with_capacity(ordered.len());
    for (name, entry) in ordered {
        outcomes.push(SourceOutcome {
            source: name,
            available: entry.available,
            found: entry.values.found_keys(),
            note: entry.note.clone(),
        });
        if room_key.is_none() {
            if let Some(v) = entry.values.room_key.clone() {
                room_key = Some(v);
            }
        }
        if server.is_none() {
            if let Some(v) = entry.values.server.clone() {
                server = Some(v);
            }
        }
    }

    let report = ConfigReport {
        sources: outcomes,
        default_server_host: DEFAULT_SERVER_HOST,
    };

    let mut missing: Vec<&'static str> = Vec::new();
    if room_key.is_none() {
        missing.push("roomKey");
    }

    if !missing.is_empty() {
        return Err(ConfigError { missing, report });
    }

    Ok((
        DesktopConfig {
            room_key: room_key.expect("roomKey present"),
            server_host: server.unwrap_or_else(|| DEFAULT_SERVER_HOST.to_owned()),
        },
        report,
    ))
}

#[allow(dead_code)]
fn urlencode(s: &str) -> String {
    // We only need a minimal encoder — contestant IDs and room keys are
    // drawn from a narrow character set per §3.1 and §8.2.
    // Non-alphanumerics that appear (`-`, `.`, `_`) are URL-safe. Anything
    // else (shouldn't happen in practice) is percent-encoded.
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' || ch == '~' {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for byte in ch.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vals(key: &str, server: &str) -> SourceValues {
        SourceValues {
            room_key: opt(key),
            server: opt(server),
        }
    }

    fn opt(s: &str) -> Option<String> {
        if s.is_empty() {
            None
        } else {
            Some(s.to_owned())
        }
    }

    #[test]
    fn defaults_to_timer_tcanationals_com_when_no_source_supplies_server() {
        let sources = ConfigSources {
            cli: SourceEntry::from_values(vals("key-abcdef0123456789", "")),
            ..Default::default()
        };
        let (cfg, _) = resolve(&sources).expect("resolves");
        assert_eq!(cfg.server_host, "timer.tcanationals.com");
        assert_eq!(cfg.room_key, "key-abcdef0123456789");
    }

    #[test]
    fn cli_args_win_over_lower_priority_sources() {
        let sources = ConfigSources {
            cli: SourceEntry::from_values(vals("cli-key", "cli.host")),
            registry: SourceEntry::from_values(vals("reg-key", "reg.host")),
            file: SourceEntry::from_values(vals("file-key", "file.host")),
            env: SourceEntry::from_values(vals("env-key", "env.host")),
        };
        let (cfg, _) = resolve(&sources).unwrap();
        assert_eq!(cfg.room_key, "cli-key");
        assert_eq!(cfg.server_host, "cli.host");
    }

    #[test]
    fn priority_falls_through_per_key_independently() {
        // CLI supplies only server, env supplies the room key — each key
        // resolves from its own first source.
        let sources = ConfigSources {
            cli: SourceEntry::from_values(vals("", "cli.host")),
            registry: SourceEntry::default(),
            file: SourceEntry::default(),
            env: SourceEntry::from_values(vals("env-key", "")),
        };
        let (cfg, _) = resolve(&sources).unwrap();
        assert_eq!(cfg.room_key, "env-key");
        assert_eq!(cfg.server_host, "cli.host");
    }

    #[test]
    fn empty_strings_are_treated_as_absent() {
        let sources = ConfigSources {
            cli: SourceEntry::from_values(vals("   ", "")),
            env: SourceEntry::from_values(vals("k", "s")),
            ..Default::default()
        };
        let (cfg, _) = resolve(&sources).unwrap();
        assert_eq!(cfg.room_key, "k");
        assert_eq!(cfg.server_host, "s");
    }

    #[test]
    fn missing_room_key_is_reported_in_config_error() {
        let sources = ConfigSources {
            cli: SourceEntry::from_values(vals("", "h.example")),
            ..Default::default()
        };
        let err = resolve(&sources).unwrap_err();
        assert_eq!(err.missing, vec!["roomKey"]);
        assert_eq!(err.report.default_server_host, "timer.tcanationals.com");
    }

    #[test]
    fn missing_everything_reports_room_key() {
        let sources = ConfigSources::default();
        let err = resolve(&sources).unwrap_err();
        assert_eq!(err.missing, vec!["roomKey"]);
        assert_eq!(err.report.sources.len(), 4);
        assert!(err
            .report
            .sources
            .iter()
            .all(|o| !o.available && o.found.is_empty()));
    }

    #[test]
    fn report_records_per_source_found_keys() {
        let sources = ConfigSources {
            cli: SourceEntry::from_values(vals("k", "")),
            file: SourceEntry::default(),
            env: SourceEntry::from_values(vals("", "h")),
            ..Default::default()
        };
        let (_, report) = resolve(&sources).unwrap();
        let names: Vec<_> = report.sources.iter().map(|s| s.source).collect();
        assert_eq!(names, vec!["cli", "registry", "file", "env"]);
        assert_eq!(report.sources[0].found, vec!["roomKey"]);
        assert!(report.sources[1].found.is_empty());
        assert!(report.sources[2].found.is_empty());
        assert_eq!(report.sources[3].found, vec!["server"]);
    }

    #[test]
    fn parse_cli_accepts_equals_and_space_forms() {
        let entry = parse_cli_args(&[
            "--room-key=hunter2-key-0123456789".to_string(),
            "--server".to_string(),
            "my.host".to_string(),
        ]);
        assert_eq!(
            entry.values.room_key.as_deref(),
            Some("hunter2-key-0123456789"),
        );
        assert_eq!(entry.values.server.as_deref(), Some("my.host"));
    }

    #[test]
    fn parse_cli_ignores_unknown_flags() {
        let entry = parse_cli_args(&[
            "--weird".to_string(),
            "stuff".to_string(),
            "--room-key".to_string(),
            "demo-key-0123456789".to_string(),
        ]);
        assert_eq!(
            entry.values.room_key.as_deref(),
            Some("demo-key-0123456789"),
        );
    }

    #[test]
    fn parse_config_file_accepts_all_keys_and_ignores_extras() {
        let entry = parse_config_file(
            r#"{"roomKey":"k1-0123456789abcdef","server":"s.example","ignored":42}"#,
        );
        assert_eq!(
            entry.values.room_key.as_deref(),
            Some("k1-0123456789abcdef"),
        );
        assert_eq!(entry.values.server.as_deref(), Some("s.example"));
        assert!(entry.note.is_none());
    }

    #[test]
    fn parse_config_file_reports_unparseable_in_note() {
        let entry = parse_config_file("not json");
        assert!(!entry.available);
        assert!(entry.note.as_deref().unwrap().starts_with("unparseable:"));
    }

    #[test]
    fn contestant_ws_url_embeds_host_and_scopes_per_spec() {
        let cfg = DesktopConfig {
            room_key: "hunter2-key-0123456789".to_string(),
            server_host: "timer.tcanationals.com".to_string(),
        };
        let url = cfg.contestant_ws_url("contestant-07");
        assert_eq!(
            url,
            "wss://timer.tcanationals.com/contestant?key=hunter2-key-0123456789&id=contestant-07"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_default_config_path_is_library_application_support() {
        let p = default_config_file_path();
        assert_eq!(
            p,
            std::path::PathBuf::from("/Library/Application Support/TCATimer/config.json"),
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_default_config_path_uses_programdata() {
        let p = default_config_file_path();
        assert!(p.ends_with("TCATimer/config.json") || p.ends_with("TCATimer\\config.json"));
    }

    #[test]
    #[cfg(all(not(windows), not(target_os = "macos")))]
    fn linux_default_config_path_is_etc_tca_timer() {
        let p = default_config_file_path();
        assert_eq!(p, std::path::PathBuf::from("/etc/tca-timer/config.json"),);
    }

    #[test]
    fn contestant_ws_url_percent_encodes_unexpected_chars() {
        let cfg = DesktopConfig {
            room_key: "a b".to_string(),
            server_host: "h".to_string(),
        };
        let url = cfg.contestant_ws_url("user@domain");
        assert!(url.contains("id=user%40domain"));
        assert!(url.contains("key=a%20b"));
    }
}
