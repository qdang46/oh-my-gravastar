//! `omg schema` / `omg guide` / `omg config *` command implementations.
//!
//! These are the agent-facing config surface (ADR + migration spec §15
//! R1/R2+). All output is JSON — success documents and the §8 error
//! envelope alike — so agents never parse human text. Writes exist only
//! through `config apply` (khub916-k1pro, `--yes`-gated).

use omg_hid::{find_devices, DeviceInfo};

use crate::config::document::{self, TargetContext};
use crate::config::{apply, diff, guide, schema, state, ConfigError};
use crate::{device, print_json, Cli};

/// `omg config` subcommands.
#[derive(clap::Subcommand)]
pub enum ConfigCommands {
    /// Read the device's current configuration as a desired-state
    /// document (baseline for editing; `config validate` accepts it
    /// verbatim). khub916 K1 Pro only in this release.
    Get,
    /// Strictly validate a desired-state document against a schema
    /// family (`--device khub916_wired`) or a physical device
    /// (`--device <path|vid:pid|…>` binds model+firmware via cmd 130).
    Validate {
        /// Desired-state JSON document (`-` = stdin).
        file: String,
    },
    /// Compare a desired-state document against the device's current
    /// configuration. Requires a physical device; prints every leaf
    /// difference (`equal: true` = nothing would change).
    Diff {
        /// Desired-state JSON document (`-` = stdin).
        file: String,
    },
    /// Verify the device matches a desired-state document: reads
    /// current state, normalizes both sides and reports `verified:
    /// true|false` plus the differing leaves. Exit 0 on match, 1 on
    /// drift — the scripting counterpart of `config diff`.
    Verify {
        /// Desired-state JSON document (`-` = stdin).
        file: String,
    },
    /// Apply a validated desired-state document to the device
    /// (khub916-k1pro only). Requires `--yes`; every section write is
    /// read-back verified and the command stops on the first failure.
    Apply {
        /// Desired-state JSON document (`-` = stdin).
        file: String,
        #[command(flatten)]
        yes: crate::Yes,
    },
}

/// `omg config <sub>` dispatcher.
pub fn run(cli: &Cli, command: &ConfigCommands) -> anyhow::Result<std::process::ExitCode> {
    match command {
        ConfigCommands::Get => cmd_get(cli),
        ConfigCommands::Validate { file } => cmd_validate(cli, file),
        ConfigCommands::Diff { file } => cmd_diff(cli, file),
        ConfigCommands::Verify { file } => cmd_verify(cli, file),
        ConfigCommands::Apply { file, yes } => apply::apply(cli, file, yes),
    }
}

/// `omg schema [--device <sel>] [--section <name>]` — the *config* schema
/// surface. No `--device` lists the family index; a family selector
/// (kind id or schema id) emits that family's JSON Schema offline; a
/// physical device selector resolves through cmd 130 so the K1 Pro
/// model gate applies.
pub fn cmd_schema(
    cli: &Cli,
    device_sel: Option<&str>,
    section: Option<&str>,
) -> anyhow::Result<std::process::ExitCode> {
    let _ = cli;
    let sel = device_sel.filter(|s| *s != "current");
    let Some(sel) = sel else {
        // No --device (or `--device current` with nothing to name): the
        // family index is the offline answer.
        if device_sel == Some("current") {
            // `--device current` asks for the attached device's schema.
            let devices = match devices() {
                Ok(d) => d,
                Err(e) => return fail(e),
            };
            let d = match pick_device(&devices, None) {
                Ok(d) => d,
                Err(e) => return fail(e),
            };
            let ctx = match state::target_context(&d) {
                Ok(c) => c,
                Err(e) => return fail(e),
            };
            return emit_schema_doc(&ctx.schema_id, section);
        }
        return print_json(&schema::schema_index()).map(|_| std::process::ExitCode::SUCCESS);
    };
    // Family selector → offline schema doc (no device needed).
    if let Some(sid) = schema::selector_schema_id(sel) {
        return emit_schema_doc(sid, section);
    }
    // Physical device → resolve kind + (for khub916) the cmd-130 model.
    let devices = match devices() {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let d = match pick_device(&devices, Some(sel)) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let ctx = match state::target_context(&d) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    emit_schema_doc(&ctx.schema_id, section)
}

fn emit_schema_doc(
    schema_id: &str,
    section: Option<&str>,
) -> anyhow::Result<std::process::ExitCode> {
    match schema::schema_doc(schema_id, section) {
        Ok(doc) => print_json(&doc).map(|_| std::process::ExitCode::SUCCESS),
        Err(e) => fail(e),
    }
}

/// `omg guide [--json]`.
pub fn cmd_guide(cli: &Cli) -> anyhow::Result<std::process::ExitCode> {
    if cli.json {
        print_json(&guide::doc())?;
    } else {
        print!("{}", guide::text());
    }
    Ok(std::process::ExitCode::SUCCESS)
}

// ── device resolution ──────────────────────────────────────────────────

/// Enumerate GravaStar devices; HID enumeration failure is a read error.
pub(crate) fn devices() -> Result<Vec<DeviceInfo>, ConfigError> {
    find_devices().map_err(|e| ConfigError::state_read_failed("device enumeration", e))
}

/// Does `sel` name this device's *family* (kind id or schema id)?
fn kind_selector_matches(d: &DeviceInfo, sel: &str) -> bool {
    let Some(sid) = schema::selector_schema_id(sel) else {
        return false;
    };
    schema::kind_for_schema(sid) == Some(device::kind_id(d.kind))
}

/// Pick exactly one device for `sel` (or auto-pick the only device).
/// `current` is the README-documented alias for "the connected device"
/// (auto-pick; ambiguous when several are attached). Mirrors
/// `select_device` semantics but yields the §8 error codes:
/// `device_not_found` / `device_ambiguous` instead of anyhow bails.
pub(crate) fn pick_device(
    devices: &[DeviceInfo],
    sel: Option<&str>,
) -> Result<DeviceInfo, ConfigError> {
    let sel = sel.filter(|s| *s != "current");
    let matches: Vec<DeviceInfo> = match sel {
        Some(s) => devices
            .iter()
            .filter(|d| crate::device_matches(d, s) || kind_selector_matches(d, s))
            .cloned()
            .collect(),
        None => devices.to_vec(),
    };
    match matches.len() {
        0 => Err(ConfigError::device_not_found(match sel {
            Some(s) => format!("--device '{s}' matched no connected GravaStar device"),
            None => "no GravaStar device connected".to_string(),
        })),
        1 => Ok(matches.into_iter().next().unwrap()),
        n => Err(ConfigError::device_ambiguous(format!(
            "{} devices match{} — pass a more specific --device <path|vid:pid|kind>",
            n,
            sel.map(|s| format!(" '{s}'"))
                .unwrap_or_else(|| " the empty selector".into())
        ))),
    }
}

/// Family-level `TargetContext` for `config validate --device <family>`
/// (no device I/O; model/firmware checks are skipped).
fn family_context(sel: &str) -> Result<TargetContext, ConfigError> {
    let sid = schema::selector_schema_id(sel).ok_or_else(|| {
        ConfigError::invalid_document(format!(
            "'{sel}' is not a config schema family — use a kind id \
             ({}) or a physical --device selector",
            schema::family_selectors().join(", ")
        ))
    })?;
    let device_kind = schema::kind_for_schema(sid)
        .unwrap_or("unknown")
        .to_string();
    Ok(TargetContext {
        schema_id: sid.to_string(),
        device_kind,
        model: None,
        firmware: None,
    })
}

/// Resolve the validation context for `config validate`/`diff`:
/// family selector → offline ctx; otherwise a physical device (auto-
/// picked when exactly one is connected) with cmd-130 binding.
fn resolve_ctx(cli: &Cli) -> Result<TargetContext, ConfigError> {
    if let Some(sel) = cli.device.as_deref() {
        if schema::selector_schema_id(sel).is_some() {
            return family_context(sel);
        }
    }
    let devs = devices()?;
    let d = pick_device(&devs, cli.device.as_deref())?;
    state::target_context(&d)
}

// ── subcommands ────────────────────────────────────────────────────────

/// `config get` — full current state as a desired-state document.
fn cmd_get(cli: &Cli) -> anyhow::Result<std::process::ExitCode> {
    let devs = devices()?;
    let d = match pick_device(&devs, cli.device.as_deref()) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    // Only the live-verified writable family has a readable desired-state
    // document; gated/observation families are `unsupported`.
    let sid = match schema::schema_id_for_kind(d.kind) {
        Some(s) => s,
        None => {
            return fail(ConfigError::unsupported(format!(
                "{} ({}) exposes no config surface",
                d.vid_pid(),
                d.kind.label()
            )))
        }
    };
    if !schema::is_writable(sid) {
        return fail(ConfigError::unsupported(format!(
            "schema '{sid}' is not readable as desired state in this release \
             (only khub916-k1pro is live-verified)"
        )));
    }
    match state::read_current(&d) {
        // The bare desired-state document — no ok/kind envelope fields —
        // so `config get > base.json && config validate base.json`
        // round-trips (the validator is additionalProperties:false).
        Ok(doc) => {
            print_json(&doc)?;
            Ok(std::process::ExitCode::SUCCESS)
        }
        Err(e) => fail(e),
    }
}

/// `config validate <file>` — strict validation; prints the normalized
/// document plus warnings on success.
fn cmd_validate(cli: &Cli, file: &str) -> anyhow::Result<std::process::ExitCode> {
    let doc = match document::read_document(file) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let ctx = match resolve_ctx(cli) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    match document::validate(&doc, &ctx) {
        Ok(v) => {
            print_json(&serde_json::json!({
                "ok": true,
                "kind": "omg.config.validation",
                "valid": true,
                "document": v.doc,
                "warnings": v.warnings,
            }))?;
            Ok(std::process::ExitCode::SUCCESS)
        }
        Err(e) => fail(e),
    }
}

/// `config verify <file>` — diff with a pass/fail verdict for agents.
fn cmd_verify(cli: &Cli, file: &str) -> anyhow::Result<std::process::ExitCode> {
    let doc = match document::read_document(file) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    if let Some(sel) = cli.device.as_deref() {
        if schema::selector_schema_id(sel).is_some() {
            return fail(ConfigError::unsupported(
                "config verify needs a physical device, not a family selector",
            ));
        }
    }
    let devs = match devices() {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let d = match pick_device(&devs, cli.device.as_deref()) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let ctx = match state::target_context(&d) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    if !schema::is_writable(&ctx.schema_id) {
        return fail(ConfigError::unsupported(format!(
            "schema '{}' has no verifiable writable surface in this release",
            ctx.schema_id
        )));
    }
    let desired = match document::validate(&doc, &ctx) {
        Ok(v) => v.doc,
        Err(e) => return fail(e),
    };
    let current = match state::read_current(&d) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let out = diff::diff_documents(&current, &desired);
    let equal = out["equal"] == serde_json::json!(true);
    print_json(&serde_json::json!({
        "ok": true,
        "kind": "omg.config.verify",
        "verified": equal,
        "diff": out,
    }))?;
    Ok(std::process::ExitCode::from(if equal { 0 } else { 1 }))
}

/// `config diff <file>` — desired vs current; physical device required.
fn cmd_diff(cli: &Cli, file: &str) -> anyhow::Result<std::process::ExitCode> {
    let doc = match document::read_document(file) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    // diff needs live state → a family selector is not enough.
    if let Some(sel) = cli.device.as_deref() {
        if schema::selector_schema_id(sel).is_some() {
            return fail(ConfigError::unsupported(format!(
                "config diff needs a physical device, not family selector '{sel}' — \
                 pass --device <path|vid:pid|kind> or connect exactly one device"
            )));
        }
    }
    let devs = devices()?;
    let d = match pick_device(&devs, cli.device.as_deref()) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let ctx = match state::target_context(&d) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    if !schema::is_writable(&ctx.schema_id) {
        return fail(ConfigError::unsupported(format!(
            "schema '{}' has no diffable writable surface in this release",
            ctx.schema_id
        )));
    }
    let desired = match document::validate(&doc, &ctx) {
        Ok(v) => v.doc,
        Err(e) => return fail(e),
    };
    let current = match state::read_current(&d) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let mut out = diff::diff_documents(&current, &desired);
    out["ok"] = serde_json::json!(true);
    out["kind"] = serde_json::json!("omg.config.diff");
    out["target"] = desired["target"].clone();
    print_json(&out)?;
    Ok(std::process::ExitCode::SUCCESS)
}

// ── error plumbing ─────────────────────────────────────────────────────

/// Print the §8 envelope and map to the process exit code.
fn fail(err: ConfigError) -> anyhow::Result<std::process::ExitCode> {
    print_json(&err.envelope())?;
    Ok(std::process::ExitCode::from(err.exit_code()))
}
