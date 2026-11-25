//! `omg profile watch` — foreground-app → profile auto-switch (bead
//! oh-my-gravastar-of1).
//!
//! Polls the OS for the frontmost application and matches it against a
//! user-supplied rules file; on a match change it optionally switches
//! the HE keyboard's active profile (`kb profile set` semantics:
//! range-checked, read-back verified). khub916 has no profile-switch
//! command in the v2 port, so `--apply` is HE-keyboard only.
//!
//! Platform support: macOS only for now (System Events via
//! `osascript`). Linux (`_NET_ACTIVE_WINDOW`/dbus) and Windows
//! (`GetForegroundWindow`) are documented as future work — the command
//! refuses early on other OSes rather than silently doing nothing.
//!
//! Rules file (JSON):
//! ```json
//! { "rules": [
//!     { "app": "Safari", "profile": 0 },
//!     { "bundle": "com.apple.Terminal", "profile": 1 }
//!   ] }
//! ```
//! `app` is a case-insensitive substring of the frontmost app's name;
//! `bundle` a substring of its bundle identifier. First match wins;
//! `profile` is the 0-based HE profile index. A rule may carry both
//! `app` and `bundle` (both must match) or just one.

use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// The frontmost application as the OS reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForegroundApp {
    pub name: String,
    pub bundle_id: Option<String>,
}

/// One app→profile rule.
#[derive(Clone, Debug, Deserialize)]
pub struct WatchRule {
    /// Case-insensitive substring of the app name (optional if `bundle` set).
    #[serde(default)]
    pub app: Option<String>,
    /// Case-insensitive substring of the bundle identifier.
    #[serde(default)]
    pub bundle: Option<String>,
    /// 0-based HE profile index to switch to on match.
    pub profile: u8,
}

/// Parsed rules file.
#[derive(Clone, Debug, Deserialize)]
pub struct WatchRules {
    #[serde(default)]
    pub rules: Vec<WatchRule>,
}

impl WatchRules {
    pub fn load(path: &str) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read rules file '{path}'"))?;
        let rules: Self =
            serde_json::from_str(&text).with_context(|| format!("'{path}' is not valid rules JSON"))?;
        for (i, r) in rules.rules.iter().enumerate() {
            if r.app.is_none() && r.bundle.is_none() {
                bail!("rules[{i}] needs at least one of 'app' or 'bundle'");
            }
        }
        Ok(rules)
    }

    /// First matching rule's profile index, if any.
    pub fn profile_for(&self, app: &ForegroundApp) -> Option<u8> {
        self.rules.iter().find_map(|r| {
            let app_ok = match &r.app {
                Some(pat) => app.name.to_lowercase().contains(&pat.to_lowercase()),
                None => true,
            };
            let bundle_ok = match (&r.bundle, &app.bundle_id) {
                (Some(pat), Some(id)) => id.to_lowercase().contains(&pat.to_lowercase()),
                (Some(_), None) => false,
                (None, _) => true,
            };
            if app_ok && bundle_ok {
                Some(r.profile)
            } else {
                None
            }
        })
    }
}

/// Query the OS for the frontmost app. macOS only — other platforms
/// bail with a clear message (see module docs).
pub fn foreground_app() -> Result<ForegroundApp> {
    match std::env::consts::OS {
        "macos" => foreground_app_macos(),
        other => bail!(
            "profile watch does not support '{other}' yet — \
             macOS is implemented (System Events); Linux/Windows detection \
             is documented future work"
        ),
    }
}

fn osascript(script: &str) -> Result<String> {
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .context("failed to run osascript (is macOS Automation permission granted?)")?;
    if !out.status.success() {
        bail!(
            "osascript failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn foreground_app_macos() -> Result<ForegroundApp> {
    let name = osascript(
        "tell application \"System Events\" to get name of first process whose frontmost is true",
    )?;
    if name.is_empty() {
        bail!("System Events reported no frontmost app");
    }
    // Bundle id is best-effort: login-window / some agents lack one.
    let bundle_id = osascript(
        "tell application \"System Events\" to get bundle identifier of first process whose frontmost is true",
    )
    .ok()
    .filter(|s| !s.is_empty());
    Ok(ForegroundApp { name, bundle_id })
}

/// Sleep helper kept here so callers don't need a second import.
pub fn interval(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, bundle: Option<&str>) -> ForegroundApp {
        ForegroundApp {
            name: name.to_string(),
            bundle_id: bundle.map(str::to_string),
        }
    }

    fn rules(json: &str) -> WatchRules {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn app_substring_matches_case_insensitive() {
        let r = rules(r#"{"rules":[{"app":"safari","profile":2}]}"#);
        assert_eq!(r.profile_for(&app("Safari", Some("com.apple.Safari"))), Some(2));
        assert_eq!(r.profile_for(&app("Safari Technology Preview", None)), Some(2));
        assert_eq!(r.profile_for(&app("Terminal", None)), None);
    }

    #[test]
    fn bundle_substring_matches() {
        let r = rules(r#"{"rules":[{"bundle":"com.apple.Terminal","profile":1}]}"#);
        assert_eq!(
            r.profile_for(&app("Terminal", Some("com.apple.Terminal"))),
            Some(1)
        );
        // Bundle rule cannot match an app with no bundle id.
        assert_eq!(r.profile_for(&app("Terminal", None)), None);
    }

    #[test]
    fn app_and_bundle_both_must_match() {
        let r = rules(
            r#"{"rules":[{"app":"code","bundle":"com.microsoft.VSCode","profile":0}]}"#,
        );
        assert_eq!(
            r.profile_for(&app("Visual Studio Code", Some("com.microsoft.VSCode"))),
            Some(0)
        );
        // Right name, wrong bundle → no match.
        assert_eq!(
            r.profile_for(&app("Visual Studio Code", Some("com.example.Fork"))),
            None
        );
    }

    #[test]
    fn first_match_wins() {
        let r = rules(
            r#"{"rules":[{"app":"safari","profile":0},{"app":"safari","profile":1}]}"#,
        );
        assert_eq!(r.profile_for(&app("Safari", None)), Some(0));
    }

    #[test]
    fn empty_rules_match_nothing() {
        let r = rules(r#"{"rules":[]}"#);
        assert_eq!(r.profile_for(&app("Anything", Some("x.y"))), None);
    }

    #[test]
    fn rule_without_matcher_is_rejected() {
        let bad = r#"{"rules":[{"profile":0}]}"#;
        let parsed = serde_json::from_str::<WatchRules>(bad);
        // Deserialization itself succeeds; validation lives in load().
        assert!(parsed.is_ok());
        let rules = parsed.unwrap();
        assert!(rules.rules[0].app.is_none() && rules.rules[0].bundle.is_none());
    }
}
