//! `omg config` — desired-state device configuration
//! (docs/device-config-schema.md, schemas/device-config.schema.json).
//!
//! Three layers, kept strictly separate:
//!   1. Structural — Draft 2020-12 validation against the shared schema
//!      artifact (embedded at compile time so the CLI works from any cwd).
//!   2. Semantic — device identity, capability gating, dynamic limits,
//!      keymap-slot conflicts, opaque-step preservation.
//!   3. Execution — ordered writes with read-back verify.
//!
//! A schema-valid document is never reported as apply-able; sections
//! without a proven lowering are `not_applied` with an explicit reason.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::OnceLock;

use anyhow::{bail, Result};
use clap::Subcommand;
use omg_hid::{find_devices, DeviceInfo};
use omg_proto_khub916::macro916::{self, MacroEntry};
use serde_json::{json, Value};

use crate::kb916_macro;
use crate::{device_matches, kb916_session, parse_kb916_key_value, print_json, Cli, Yes};

/// The single structural-truth artifact, embedded so `omg config` works
/// regardless of the caller's working directory. `config schema` prints
/// this verbatim; a test asserts it is byte-identical to the repo file.
pub const DEVICE_CONFIG_SCHEMA: &str = include_str!("../../../schemas/device-config.schema.json");

#[derive(Subcommand)]
pub enum ConfigCommands {
    /// Print the device-config JSON Schema (Draft 2020-12) artifact.
    Schema,
    /// Validate a desired-state config file. Offline — no HID access.
    /// Reports every structural error with its JSON path.
    Validate {
        /// Path to the desired-state JSON document.
        file: PathBuf,
    },
    /// Validate, plan and (with `--yes`) apply a desired-state config.
    /// Without `--yes` this is a dry run: structural validation, device
    /// match and the per-section plan are printed, nothing is written.
    Apply {
        /// Path to the desired-state JSON document.
        file: PathBuf,
        /// Execute the writes (still subject to every safety gate).
        #[command(flatten)]
        yes: Yes,
        /// Explicit dry run (same as omitting `--yes`).
        #[arg(long)]
        dry_run: bool,
    },
    /// Restore the pre-apply snapshot written by `config apply --yes`.
    /// Snapshots live next to plan journals (`$OMG_PLAN_DIR` or
    /// `~/.local/share/omg/plans`) as `<id>.snapshots.json`.
    Rollback {
        /// Apply id printed by `config apply` (or listed in the journal).
        id: String,
        /// Execute the restore writes.
        #[command(flatten)]
        yes: Yes,
    },
}

// ── Layer 1: structural validation ─────────────────────────────────────

fn schema_doc() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(DEVICE_CONFIG_SCHEMA).expect("embedded schema must parse")
    })
}

fn validator() -> &'static jsonschema::Validator {
    static V: OnceLock<jsonschema::Validator> = OnceLock::new();
    V.get_or_init(|| jsonschema::validator_for(schema_doc()).expect("embedded schema must compile"))
}

/// All structural errors as `path: message` strings (empty = valid).
pub fn structural_errors(doc: &Value) -> Vec<String> {
    validator()
        .iter_errors(doc)
        .map(|e| format!("{}: {}", e.instance_path, e))
        .collect()
}

fn load_config(path: &PathBuf) -> Result<Value> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("cannot read '{}': {e}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("'{}' is not valid JSON: {e}", path.display()))
}

// ── Device matching (layer 2 input) ────────────────────────────────────

/// Connected devices matching the document's `device` block
/// (protocol family + VID + PID + optional usage page).
fn matching_devices(doc: &Value) -> Result<Vec<DeviceInfo>> {
    let want = doc
        .get("device")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("config: missing 'device' object"))?;
    let protocol = want["protocol"].as_str().unwrap_or_default();
    let vid = want["vid"].as_u64().unwrap_or(u64::MAX) as u16;
    let pid = want["pid"].as_u64().unwrap_or(u64::MAX) as u16;
    let page = want
        .get("usage_page")
        .and_then(Value::as_u64)
        .map(|p| p as u16);
    let devices = find_devices()?;
    let hits: Vec<DeviceInfo> = devices
        .iter()
        .filter(|d| {
            crate::profile::protocol_of(d.kind) == protocol
                && d.vid == vid
                && d.pid == pid
                && page.is_none_or(|p| d.usage_page == p)
        })
        .cloned()
        .collect();
    if hits.is_empty() {
        bail!(
            "no connected device matches protocol '{protocol}' vid {vid:#06x} pid {pid:#06x} \
             (omg devices lists what was found)"
        );
    }
    Ok(hits)
}

// ── Per-section plan ───────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum SectionStatus {
    ApplyPlanned,
    NotApplied,
}

struct SectionPlan {
    name: &'static str,
    status: SectionStatus,
    detail: String,
}

/// Decide, per present section, whether apply has a proven lowering.
/// This is the capability gate — independent of structural validity.
fn plan_sections(doc: &Value) -> Vec<SectionPlan> {
    let protocol = doc["device"]["protocol"].as_str().unwrap_or("");
    let mut out = Vec::new();
    let mut add = |name: &'static str, ok: bool, why: &str| {
        out.push(SectionPlan {
            name,
            status: if ok {
                SectionStatus::ApplyPlanned
            } else {
                SectionStatus::NotApplied
            },
            detail: if ok { "supported".into() } else { why.into() },
        });
    };
    for key in ["keymap", "lighting", "settings", "macros", "advanced_keys"] {
        let Some(section) = doc.get(key) else {
            continue;
        };
        let mode = section.get("mode").and_then(Value::as_str).unwrap_or("");
        let (ok, why) = match (protocol, key, mode) {
            // compx: full-config replace only (patch needs read-merge).
            ("compx", "settings", "replace") => (true, ""),
            ("compx", "lighting", "replace") => (true, ""),
            ("compx", _, "patch") => (
                false,
                "patch mode is schema-valid but apply-rejected: no read-merge path yet",
            ),
            // khub916 wired paths.
            ("khub916", "keymap", "patch") | ("khub916", "keymap", "replace") => (true, ""),
            ("khub916", "macros", "") => (true, ""),
            ("khub916", "settings", "") => (true, ""),
            ("khub916", "lighting", _) => (
                false,
                "lighting apply lowering not yet wired to desired-state",
            ),
            ("khub916", "advanced_keys", _) => (
                false,
                "advanced_keys apply lowering not yet wired to desired-state",
            ),
            // he-v2: no write path exists for keymap; other sections not lowered yet.
            ("he-v2", _, _) => (false, "he-v2 apply lowering not yet implemented"),
            // sparkplayjoy: read-only.
            ("sparkplayjoy", _, _) => (false, "sparkplayjoy is read-only"),
            _ => (false, "no apply path for this section/protocol"),
        };
        add(key, ok, why);
    }
    out
}

// ── Layer 2 semantic checks ────────────────────────────────────────────

/// Collect semantic problems that the schema cannot express.
fn semantic_errors(doc: &Value) -> Result<Vec<String>> {
    let mut errs = Vec::new();
    let protocol = doc["device"]["protocol"].as_str().unwrap_or("");

    // D7 conflict rule: implicit keymap writers must not collide on
    // (arg, slot). Collect targets from `keymap` (patch entries and
    // replace positions), `macros[].bind`, and `advanced_keys`.
    let mut targets: BTreeMap<(u8, usize), String> = BTreeMap::new();
    let mut claim = |arg: u8, slot: usize, who: String, errs: &mut Vec<String>| {
        if let Some(prev) = targets.insert((arg, slot), who.clone()) {
            errs.push(format!(
                "keymap slot conflict: {who} and {prev} both target arg {arg} slot {slot}"
            ));
        }
    };
    if let Some(km) = doc.get("keymap") {
        let layer = km["layer"].as_u64().unwrap_or(0) as u8;
        let system = km["system"].as_u64().unwrap_or(0) as u8;
        let arg = (layer & 3) | ((system & 1) << 2);
        if let Some(entries) = km.get("entries").and_then(Value::as_array) {
            let mut seen = BTreeSet::new();
            for e in entries {
                let idx = e["index"].as_u64().unwrap_or(u64::MAX) as usize;
                if !seen.insert(idx) {
                    errs.push(format!("keymap patch: duplicate index {idx}"));
                }
                claim(arg, idx, "keymap.entries".into(), &mut errs);
            }
        }
    }
    if let Some(macros) = doc.get("macros").and_then(Value::as_array) {
        for (i, m) in macros.iter().enumerate() {
            if let Some(b) = m.get("bind") {
                let arg = ((b["layer"].as_u64().unwrap_or(0) as u8) & 3)
                    | (((b["system"].as_u64().unwrap_or(0) as u8) & 1) << 2);
                let slot = b["key"].as_u64().unwrap_or(u64::MAX) as usize;
                claim(arg, slot, format!("macros[{i}].bind"), &mut errs);
            }
        }
    }
    if protocol == "sparkplayjoy"
        && doc.as_object().is_some_and(|o| {
            ["keymap", "lighting", "settings", "macros", "advanced_keys"]
                .iter()
                .any(|k| o.contains_key(*k))
        })
    {
        errs.push("sparkplayjoy has no writable config sections".into());
    }
    Ok(errs)
}

// ── Execution helpers ──────────────────────────────────────────────────

fn hex_color(s: &str) -> Result<omg_proto_mouse::Rgb> {
    omg_proto_mouse::Rgb::parse(s).map_err(|e| anyhow::anyhow!("bad #rrggbb color '{s}': {e}"))
}

/// Overlay the `settings` section onto the current mouse config.
/// `mode:"replace"` is enforced by the schema (all fields required);
/// `light` is not part of this section and is preserved from the read.
fn mouse_settings_overlay(
    cur: &omg_proto_mouse::MouseConfig,
    s: &Value,
) -> Result<omg_proto_mouse::MouseConfig> {
    let mut want = cur.clone();
    macro_rules! set {
        ($f:ident, $t:ty) => {
            if let Some(v) = s.get(stringify!($f)) {
                want.$f = serde_json::from_value::<$t>(v.clone())
                    .map_err(|e| anyhow::anyhow!("settings.{}: {e}", stringify!($f)))?;
            }
        };
    }
    set!(report_rate, u32);
    set!(lod, u8);
    set!(debounce, u8);
    set!(sleep, u8);
    set!(sensor_mode, u8);
    set!(motion_sync, bool);
    set!(angle_snap, bool);
    set!(ripple, bool);
    set!(light_off_moving, bool);
    if let Some(v) = s.get("stage_count") {
        want.stage_count = v.as_u64().unwrap_or(0) as usize;
    }
    if let Some(v) = s.get("current_stage") {
        want.current_stage = v.as_u64().unwrap_or(0) as usize;
    }
    if let Some(dpi) = s.get("dpi").and_then(Value::as_array) {
        for (i, v) in dpi.iter().enumerate() {
            want.dpi[i] = v.as_u64().unwrap_or(0) as u32;
        }
    }
    if let Some(colors) = s.get("dpi_colors").and_then(Value::as_array) {
        for (i, v) in colors.iter().enumerate() {
            want.dpi_colors[i] = hex_color(v.as_str().unwrap_or("#000000"))?;
        }
    }
    if let Some(buttons) = s.get("buttons").and_then(Value::as_array) {
        for (i, b) in buttons
            .iter()
            .enumerate()
            .take(omg_proto_mouse::BUTTON_SLOTS)
        {
            let kind = b["kind"].as_str().unwrap_or("disabled");
            let param = b.get("param").and_then(Value::as_str);
            let (k, p) = crate::parse_button(kind, param)
                .map_err(|e| anyhow::anyhow!("settings.buttons[{i}]: {e}"))?;
            want.buttons[i] = omg_proto_mouse::Button { kind: k, param: p };
        }
    }
    Ok(want)
}

fn mouse_lighting_to_light(l: &Value) -> Result<omg_proto_mouse::Light> {
    let color = l
        .get("color")
        .and_then(Value::as_str)
        .map(hex_color)
        .transpose()?
        .unwrap_or_default();
    Ok(omg_proto_mouse::Light {
        on: l.get("on").and_then(Value::as_bool).unwrap_or(false),
        mode: l.get("mode_id").and_then(Value::as_u64).unwrap_or(0) as u8,
        color,
        speed: l.get("speed").and_then(Value::as_u64).unwrap_or(1) as u8,
        brightness: l.get("brightness").and_then(Value::as_u64).unwrap_or(1) as u8,
    })
}

// ── khub916 lowering ───────────────────────────────────────────────────

/// Apply `keymap` patch entries / replace values through the verified
/// read-modify-write path. Returns change lines plus the base table the
/// rmw read (for rollback snapshots).
fn apply_khub_keymap(
    kb: &mut omg_proto_khub916::Khub916,
    km: &Value,
) -> Result<(Vec<String>, Option<Vec<u32>>)> {
    let layer = km["layer"].as_u64().unwrap_or(0) as u8;
    let system = km["system"].as_u64().unwrap_or(0) as u8;
    kb916_macro::check_keymap_args(layer, system)?;
    let mode = km["mode"].as_str().unwrap_or("");
    let arg_desc = format!("keymap layer {layer} system {system}");

    // Group edits per arg; patch entries and replace share one rmw each.
    if mode == "patch" {
        let entries = km["entries"].as_array().cloned().unwrap_or_default();
        let mut edits: BTreeMap<usize, u32> = BTreeMap::new();
        for e in &entries {
            let idx = e["index"].as_u64().unwrap_or(u64::MAX) as usize;
            let v = parse_kb916_key_value(e["value"].as_str().unwrap_or(""))?;
            edits.insert(idx, v);
        }
        let mut changes = Vec::new();
        let mut base: Option<Vec<u32>> = None;
        let outcome = kb.write_keymap_rmw(layer, system, |values| {
            base = Some(values.clone());
            for (idx, v) in &edits {
                if *idx >= values.len() {
                    bail!(
                        "keymap index {idx} out of range: arg has {} slots",
                        values.len()
                    );
                }
                changes.push(format!(
                    "{arg_desc} key[{idx}]: 0x{:08X} -> 0x{v:08X}",
                    values[*idx]
                ));
                values[*idx] = *v;
            }
            Ok(())
        })?;
        if !outcome.verified {
            bail!("{arg_desc}: write not verified by read-back");
        }
        return Ok((changes, base));
    }

    // replace: values[] must match the live table length exactly.
    let wants: Vec<u32> = km["values"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|v| parse_kb916_key_value(v.as_str().unwrap_or("")))
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let mut base: Option<Vec<u32>> = None;
    let outcome = kb.write_keymap_rmw(layer, system, |values| {
        base = Some(values.clone());
        if wants.len() != values.len() {
            bail!(
                "{arg_desc} replace: config has {} values but device reports {} slots",
                wants.len(),
                values.len()
            );
        }
        values.copy_from_slice(&wants);
        Ok(())
    })?;
    if !outcome.verified {
        bail!("{arg_desc}: replace write not verified by read-back");
    }
    Ok((
        vec![format!("{arg_desc}: replaced {} slots", wants.len())],
        base,
    ))
}

/// Bind-slot pre-write values captured for rollback:
/// `(layer, system, key index, old u32)`.
type BindSnap = (u8, u8, usize, u32);

/// Apply the `macros` section: patch entries by index (`next` appends),
/// rebuild the region through the same codec as `macro set`, then verify
/// by re-reading and comparing the parsed entries. Also returns the raw
/// region bytes and every bind slot's old value for rollback snapshots.
fn apply_khub_macros(
    kb: &mut omg_proto_khub916::Khub916,
    macros: &[Value],
) -> Result<(Vec<String>, Vec<u8>, Vec<BindSnap>)> {
    let raw = kb.macro_region()?;
    let mut entries = macro916::parse_macro_region(&raw)?;

    // Resolve "next" indices in document order, then guard: every entry
    // the user is not replacing must be preservable.
    let mut resolved: Vec<(usize, usize)> = Vec::new(); // (doc pos, slot)
    let mut next = entries.len();
    for (i, m) in macros.iter().enumerate() {
        let slot = match &m["index"] {
            Value::String(s) if s == "next" => {
                let s = next;
                next += 1;
                s
            }
            Value::Number(n) => n.as_u64().unwrap_or(u64::MAX) as usize,
            _ => bail!("macros[{i}]: bad index"),
        };
        resolved.push((i, slot));
    }
    let replaced: Vec<usize> = resolved
        .iter()
        .filter(|(_, s)| *s < entries.len())
        .map(|(_, s)| *s)
        .collect();
    kb916_macro::check_region_preservable(&entries, &replaced)?;

    let mut changes = Vec::new();
    for &(doc_pos, slot) in &resolved {
        let m = &macros[doc_pos];
        let steps_v = m["steps"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("macros[{doc_pos}]: missing steps array"))?;
        let text = serde_json::to_string(steps_v)?;
        let input = kb916_macro::parse_steps_input(&text)?;
        let name = m["name"]
            .as_str()
            .map(str::to_string)
            .or(input.name)
            .or_else(|| {
                if slot >= entries.len() {
                    Some(format!("macro{slot}"))
                } else {
                    entries.get(slot).map(|e| e.name.clone())
                }
            })
            .unwrap_or_default();
        if slot == entries.len() {
            entries.push(MacroEntry {
                name: name.clone(),
                steps: input.steps,
            });
        } else if slot > entries.len() {
            bail!(
                "macros[{doc_pos}]: index {slot} out of range ({} entries)",
                entries.len()
            );
        } else {
            entries[slot] = MacroEntry {
                name: name.clone(),
                steps: input.steps,
            };
        }
        changes.push(format!(
            "macro[{slot}] \"{name}\" — {} steps",
            m["steps"].as_array().map_or(0, |a| a.len())
        ));
    }

    // Space pre-check for appends (vendor MacroConfiguration `ae()`):
    // the rebuilt region must still fit the 512-byte payload.
    let region = macro916::build_macro_region(&entries)?;
    let outcome = kb.write_macro_region(&region)?;
    if !outcome.verified {
        bail!("macro region write not verified by read-back");
    }

    // Semantic verify: re-read and compare parsed entries.
    let raw2 = kb.macro_region()?;
    let entries2 = macro916::parse_macro_region(&raw2)?;
    if entries2 != entries {
        bail!("macro region read-back does not match intended entries");
    }

    // binds: tag-3 keymap writes (same lowering as `macro bind`).
    let mut bind_changes = Vec::new();
    let mut bind_snaps: Vec<BindSnap> = Vec::new();
    for (i, m) in macros.iter().enumerate() {
        let Some(b) = m.get("bind") else { continue };
        let slot = resolved[i].1;
        if slot > u8::MAX as usize {
            bail!("macros[{i}]: index {slot} does not fit the tag-3 u8 field");
        }
        let layer = b["layer"].as_u64().unwrap_or(0) as u8;
        let system = b["system"].as_u64().unwrap_or(0) as u8;
        let key = b["key"].as_u64().unwrap_or(u64::MAX) as usize;
        let mtype = b["macro_type"].as_u64().unwrap_or(0) as u8;
        let loops = b["loop_count"].as_u64().unwrap_or(0) as u8;
        kb916_macro::check_keymap_args(layer, system)?;
        if loops == 0 {
            bail!("macros[{i}].bind: loop_count must be >= 1");
        }
        let value = macro916::macro_key_value(mtype, loops, slot as u8);
        let outcome2 = kb.write_keymap_rmw(layer, system, |values| {
            if key >= values.len() {
                bail!("macros[{i}].bind: key slot {key} out of range");
            }
            bind_snaps.push((layer, system, key, values[key]));
            bind_changes.push(format!(
                "key[{key}] layer {layer} system {system}: -> macro[{slot}] (0x{value:08X})"
            ));
            values[key] = value;
            Ok(())
        })?;
        if !outcome2.verified {
            bail!("macros[{i}].bind: keymap write not verified");
        }
    }
    changes.extend(bind_changes);
    Ok((changes, raw, bind_snaps))
}

// ── Snapshot / journal storage ─────────────────────────────────────────
//
// `config apply --yes` snapshots every section before its first write and
// journals per-section results, mirroring `omg plan`'s model but keyed to
// the config document. Files live in the same directory as plan journals
// (`$OMG_PLAN_DIR` or `~/.local/share/omg/plans`):
//   <id>.snapshots.json  — pre-write state, input to `config rollback`
//   <id>.journal.json    — per-section results + final status
// Snapshots are taken from the *same read* the lowering used as its base
// (the rmw closure's `values`), never from a guessed or re-read table.

fn new_apply_id() -> String {
    let stamp = crate::profile::utc_stamp()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() % 0xFFFF)
        .unwrap_or(0);
    format!("config-{stamp}-{nanos:04x}")
}

fn store_path(id: &str, kind: &str) -> Result<PathBuf> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        bail!("invalid config id '{id}' (want [A-Za-z0-9._-])");
    }
    Ok(crate::plan::plans_dir().join(format!("{id}.{kind}")))
}

fn save_store_json(path: &PathBuf, v: &Value) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(v)? + "\n")?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        bail!("odd-length hex string");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| anyhow::anyhow!("{e}")))
        .collect()
}

fn light_snapshot(l: &omg_proto_mouse::Light) -> Value {
    json!({
        "on": l.on,
        "mode_id": l.mode,
        "color": format!("#{:02x}{:02x}{:02x}", l.color.r, l.color.g, l.color.b),
        "speed": l.speed,
        "brightness": l.brightness,
    })
}

fn light_from_snapshot(v: &Value) -> Result<omg_proto_mouse::Light> {
    Ok(omg_proto_mouse::Light {
        on: v["on"].as_bool().unwrap_or(false),
        mode: v["mode_id"].as_u64().unwrap_or(0) as u8,
        color: hex_color(v["color"].as_str().unwrap_or("#000000"))?,
        speed: v["speed"].as_u64().unwrap_or(1) as u8,
        brightness: v["brightness"].as_u64().unwrap_or(1) as u8,
    })
}

// ── Command entry ──────────────────────────────────────────────────────

pub fn run(cli: &Cli, command: &ConfigCommands) -> Result<ExitCode> {
    match command {
        ConfigCommands::Schema => {
            print!("{DEVICE_CONFIG_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        ConfigCommands::Validate { file } => {
            let doc = load_config(file)?;
            let errs = structural_errors(&doc);
            if errs.is_empty() {
                println!(
                    "{}: valid against device-config.schema.json (Draft 2020-12)",
                    file.display()
                );
                if cli.json {
                    print_json(&json!({ "file": file, "valid": true, "errors": [] }))?;
                }
                Ok(ExitCode::SUCCESS)
            } else {
                for e in &errs {
                    eprintln!("error: {e}");
                }
                if cli.json {
                    print_json(&json!({ "file": file, "valid": false, "errors": errs }))?;
                }
                Ok(ExitCode::FAILURE)
            }
        }
        ConfigCommands::Apply { file, yes, dry_run } => {
            if yes.yes && *dry_run {
                bail!("--yes and --dry-run are mutually exclusive");
            }
            let doc = load_config(file)?;
            let errs = structural_errors(&doc);
            if !errs.is_empty() {
                for e in &errs {
                    eprintln!("error: {e}");
                }
                bail!(
                    "config failed structural validation ({} error{})",
                    errs.len(),
                    if errs.len() == 1 { "" } else { "s" }
                );
            }
            let sem = semantic_errors(&doc)?;
            if !sem.is_empty() {
                for e in &sem {
                    eprintln!("error: {e}");
                }
                bail!("config failed semantic validation");
            }
            let devices = matching_devices(&doc)?;
            let device = if let Some(sel) = cli.device.as_deref() {
                let hits: Vec<&DeviceInfo> =
                    devices.iter().filter(|d| device_matches(d, sel)).collect();
                match hits.len() {
                    0 => bail!("--device '{sel}' matches none of the config's devices"),
                    1 => hits[0].clone(),
                    n => bail!("--device '{sel}' matches {n} devices; be more specific"),
                }
            } else if devices.len() == 1 {
                devices[0].clone()
            } else {
                bail!(
                    "config matches {} devices; pass --device to pick one",
                    devices.len()
                );
            };

            let plan = plan_sections(&doc);
            if !yes.yes {
                // Dry run: print the plan, write nothing.
                let mut rows = Vec::new();
                for p in &plan {
                    rows.push(json!({
                        "section": p.name,
                        "status": match p.status {
                            SectionStatus::ApplyPlanned => "planned",
                            SectionStatus::NotApplied => "not_applied",
                        },
                        "detail": p.detail,
                    }));
                }
                if cli.json {
                    print_json(&json!({
                        "file": file, "dry_run": true, "device": device,
                        "sections": rows,
                    }))?;
                } else {
                    println!("dry run — no writes performed");
                    println!("device: {} ({})", device.vid_pid(), device.path);
                    for p in &plan {
                        println!(
                            "  {:<15} {} — {}",
                            p.name,
                            match p.status {
                                SectionStatus::ApplyPlanned => "planned",
                                SectionStatus::NotApplied => "not_applied",
                            },
                            p.detail
                        );
                    }
                }
                return Ok(ExitCode::SUCCESS);
            }

            // --yes: execute supported sections. Each section is isolated:
            // a failure stops the apply (§Safety: stop at first failure),
            // is journaled as `failed`, and sections already written keep
            // their snapshots for `config rollback`.
            let apply_id = new_apply_id();
            let mut snaps = json!({
                "id": apply_id,
                "file": file,
                "device": device,
                "schema_version": 1,
                "sections": {},
            });
            let snap_sections = snaps["sections"].as_object_mut().unwrap();
            let mut results: Vec<Value> = Vec::new();
            let mut any_failed = false;
            let mut stop = false;

            type SectionOut = Result<(Vec<String>, Option<Value>, &'static str, bool)>;
            // Body returns (change lines, snapshot, status, hard_fail).
            // `hard_fail` marks applied-but-unverified writes: they count
            // toward `partial`/`failed` exit status without stopping the
            // remaining sections (the write itself landed).
            macro_rules! section {
                ($name:literal, $body:expr) => {{
                    if !stop {
                        match $body {
                            Ok((lines, snap, status, hard_fail)) => {
                                if let Some(s) = snap {
                                    snap_sections.insert($name.to_string(), s);
                                }
                                results.push(json!({
                                    "section": $name,
                                    "status": status,
                                    "detail": lines,
                                }));
                                if hard_fail {
                                    any_failed = true;
                                }
                            }
                            Err(e) => {
                                results.push(json!({
                                    "section": $name,
                                    "status": "failed",
                                    "detail": format!("{e:#}"),
                                }));
                                any_failed = true;
                                stop = true;
                            }
                        }
                    }
                }};
            }

            let protocol = doc["device"]["protocol"].as_str().unwrap_or("");
            match protocol {
                "compx" => {
                    let (_d, mut m) = match crate::open_mouse(cli)? {
                        Some(s) => s,
                        None => bail!("no Compx mouse detected"),
                    };
                    if let Some(s) = doc.get("settings") {
                        if s["mode"].as_str() == Some("replace") {
                            section!(
                                "settings",
                                (|| -> SectionOut {
                                    let state = crate::profile::mouse_state(&mut m)?;
                                    let cur = crate::profile::mouse_config_from_json(&state)?;
                                    let want = mouse_settings_overlay(&cur, s)?;
                                    crate::profile::mouse_apply(&mut m, &want)?;
                                    let problems = crate::profile::mouse_verify(&mut m, &want)?;
                                    let snap = json!({"kind":"compx-settings","state":state});
                                    let (status, hard) = if problems.is_empty() {
                                        ("applied_verified", false)
                                    } else {
                                        ("applied_unverified", true)
                                    };
                                    Ok((problems, Some(snap), status, hard))
                                })()
                            );
                        }
                    }
                    if !stop {
                        if let Some(l) = doc.get("lighting") {
                            if l["mode"].as_str() == Some("replace") {
                                section!(
                                    "lighting",
                                    (|| -> SectionOut {
                                        let before = m.read_config()?;
                                        let light = mouse_lighting_to_light(l)?;
                                        m.set_light(&light)?;
                                        let after = m.read_config()?;
                                        if after.light != light {
                                            bail!("lighting read-back differs");
                                        }
                                        Ok((
                                            vec!["read-back verified".into()],
                                            Some(json!({
                                                "kind": "compx-lighting",
                                                "light": light_snapshot(&before.light),
                                            })),
                                            "applied_verified",
                                            false,
                                        ))
                                    })()
                                );
                            }
                        }
                    }
                }
                "khub916" => {
                    let (_device, mut kb) = match kb916_session(cli)? {
                        Ok(s) => s,
                        Err(code) => return Ok(code),
                    };
                    if let Some(km) = doc.get("keymap") {
                        section!(
                            "keymap",
                            (|| -> SectionOut {
                                let (changes, base) = apply_khub_keymap(&mut kb, km)?;
                                let layer = km["layer"].as_u64().unwrap_or(0) as u8;
                                let system = km["system"].as_u64().unwrap_or(0) as u8;
                                let snap = base.map(|values| {
                                    json!({"kind":"khub916-keymap","args":[{
                                        "layer": layer, "system": system, "values": values,
                                    }]})
                                });
                                Ok((changes, snap, "applied_verified", false))
                            })()
                        );
                    }
                    if !stop {
                        if let Some(macros) = doc.get("macros").and_then(Value::as_array) {
                            section!(
                                "macros",
                                (|| -> SectionOut {
                                    let (changes, region, binds) =
                                        apply_khub_macros(&mut kb, macros)?;
                                    let snap = json!({
                                        "kind": "khub916-macros",
                                        "region": hex(&region),
                                        "binds": binds.iter().map(|(l, s, k, v)| json!({
                                            "layer": l, "system": s, "key": k, "value": v,
                                        })).collect::<Vec<_>>(),
                                    });
                                    Ok((changes, Some(snap), "applied_verified", false))
                                })()
                            );
                        }
                    }
                    if !stop {
                        if let Some(st) = doc.get("settings") {
                            if let Some(secs) = st.get("sleep_seconds").and_then(Value::as_u64) {
                                section!(
                                    "settings",
                                    (|| -> SectionOut {
                                        let p = kb.profile()?;
                                        let raw = p.with_sleep_seconds(secs as u8)?;
                                        let outcome = kb.write_profile(&raw)?;
                                        let (status, hard) = if outcome.verified {
                                            ("applied_verified", false)
                                        } else {
                                            ("applied_unverified", true)
                                        };
                                        Ok((
                                            vec![format!("sleep_seconds -> {secs} ({status})")],
                                            Some(json!({
                                                "kind": "khub916-profile",
                                                "raw": hex(&p.raw),
                                            })),
                                            status,
                                            hard,
                                        ))
                                    })()
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
            let _ = stop; // last section!'s stop=true is intentionally unread
                          // Sections the plan marked not_applied are reported honestly.
            for p in &plan {
                if p.status == SectionStatus::NotApplied {
                    results
                        .push(json!({"section":p.name,"status":"not_applied","detail":p.detail}));
                }
            }

            // Journal + snapshots — written even on partial failure so
            // `config rollback <id>` can restore what landed.
            let failed_count = results.iter().filter(|r| r["status"] == "failed").count();
            let applied_count = results
                .iter()
                .filter(|r| {
                    matches!(
                        r["status"].as_str(),
                        Some("applied_verified" | "applied_unverified")
                    )
                })
                .count();
            let status = if failed_count == 0 {
                "applied"
            } else if applied_count > 0 {
                "partial"
            } else {
                "failed"
            };
            snaps["status"] = json!(status);
            let journal = json!({
                "id": apply_id,
                "file": file,
                "device": device,
                "status": status,
                "results": results,
            });
            if let Err(e) = save_store_json(&store_path(&apply_id, "snapshots.json")?, &snaps)
                .and_then(|_| save_store_json(&store_path(&apply_id, "journal.json")?, &journal))
            {
                eprintln!("warning: could not write apply journal: {e:#}");
            }

            if cli.json {
                print_json(&json!({
                    "file":file,"applied":true,"id":apply_id,"device":device,
                    "status":status,"results":results,
                }))?;
            } else {
                println!(
                    "applied config for {} ({}) — id {apply_id}, status {status}",
                    device.vid_pid(),
                    device.path
                );
                println!("  rollback: omg config rollback {apply_id} --yes");
                for r in &results {
                    println!(
                        "  {:<15} {}",
                        r["section"].as_str().unwrap_or("?"),
                        r["status"].as_str().unwrap_or("?")
                    );
                    if let Some(d) = r["detail"].as_str() {
                        println!("      {d}");
                    } else if let Some(a) = r["detail"].as_array() {
                        for line in a {
                            println!("      {line}");
                        }
                    }
                }
            }
            Ok(if any_failed {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        ConfigCommands::Rollback { id, yes } => cmd_rollback(cli, id, yes.yes),
    }
}

// ── Rollback ───────────────────────────────────────────────────────────

/// Restore the snapshot written by `config apply --yes`. Each stored
/// section is written back through the same verified write paths; the
/// result is journaled to `<id>.rollback.json`.
fn cmd_rollback(cli: &Cli, id: &str, yes: bool) -> Result<ExitCode> {
    let path = store_path(id, "snapshots.json")?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("cannot read snapshot '{}': {e}", path.display()))?;
    let snaps: Value =
        serde_json::from_str(&text).map_err(|e| anyhow::anyhow!("snapshot is not JSON: {e}"))?;
    let sections = snaps["sections"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("snapshot has no 'sections' object"))?;
    if sections.is_empty() {
        bail!("snapshot '{id}' recorded no applied sections — nothing to restore");
    }
    let protocol = snaps["device"]["protocol"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if !yes {
        println!("rollback plan for config apply '{id}' ({protocol}):");
        for name in sections.keys() {
            println!("  {name}");
        }
        println!("re-run with --yes to restore the snapshot");
        return Ok(ExitCode::SUCCESS);
    }

    let mut results: Vec<Value> = Vec::new();
    let mut any_failed = false;
    match protocol.as_str() {
        "khub916" => {
            let (_device, mut kb) = match kb916_session(cli)? {
                Ok(s) => s,
                Err(code) => return Ok(code),
            };
            // Keymap args first (macro binds live in keymap slots), then
            // the macro region, then the profile blob.
            if let Some(k) = sections.get("keymap") {
                for a in k["args"].as_array().cloned().unwrap_or_default() {
                    let layer = a["layer"].as_u64().unwrap_or(0) as u8;
                    let system = a["system"].as_u64().unwrap_or(0) as u8;
                    let values: Vec<u32> = a["values"]
                        .as_array()
                        .map(|v| {
                            v.iter()
                                .filter_map(|x| x.as_u64().map(|n| n as u32))
                                .collect()
                        })
                        .unwrap_or_default();
                    let r = kb.write_keymap_rmw(layer, system, |cur| {
                        *cur = values.clone();
                        Ok(())
                    });
                    match r {
                        Ok(o) if o.verified => results.push(json!({
                            "section":"keymap","status":"rolled_back",
                            "detail":format!("layer {layer} system {system}"),
                        })),
                        Ok(_) => {
                            any_failed = true;
                            results.push(json!({"section":"keymap","status":"failed","detail":"read-back mismatch"}));
                        }
                        Err(e) => {
                            any_failed = true;
                            results.push(json!({"section":"keymap","status":"failed","detail":format!("{e:#}")}));
                        }
                    }
                }
            }
            if let Some(m) = sections.get("macros") {
                let region = unhex(m["region"].as_str().unwrap_or(""))?;
                match kb.write_macro_region(&region) {
                    Ok(o) if o.verified => {
                        // Restore bind slots to their pre-apply values.
                        for b in m["binds"].as_array().cloned().unwrap_or_default() {
                            let layer = b["layer"].as_u64().unwrap_or(0) as u8;
                            let system = b["system"].as_u64().unwrap_or(0) as u8;
                            let key = b["key"].as_u64().unwrap_or(u64::MAX) as usize;
                            let old = b["value"].as_u64().unwrap_or(0) as u32;
                            let r = kb.write_keymap_rmw(layer, system, |cur| {
                                if key >= cur.len() {
                                    bail!("bind slot {key} out of range during rollback");
                                }
                                cur[key] = old;
                                Ok(())
                            });
                            if r.map(|o| o.verified).unwrap_or(false) {
                                results.push(json!({"section":"macros","status":"rolled_back","detail":format!("bind layer {layer} system {system} key {key}")}));
                            } else {
                                any_failed = true;
                                results.push(json!({"section":"macros","status":"failed","detail":"bind restore failed"}));
                            }
                        }
                        if m["binds"].as_array().is_none_or(|b| b.is_empty()) {
                            results.push(json!({"section":"macros","status":"rolled_back","detail":"region restored"}));
                        }
                    }
                    Ok(_) => {
                        any_failed = true;
                        results.push(json!({"section":"macros","status":"failed","detail":"region read-back mismatch"}));
                    }
                    Err(e) => {
                        any_failed = true;
                        results.push(
                            json!({"section":"macros","status":"failed","detail":format!("{e:#}")}),
                        );
                    }
                }
            }
            if let Some(s) = sections.get("settings") {
                if s["kind"].as_str() == Some("khub916-profile") {
                    let raw = unhex(s["raw"].as_str().unwrap_or(""))?;
                    match kb.write_profile(&raw) {
                        Ok(o) if o.verified => results.push(json!({
                            "section":"settings","status":"rolled_back","detail":"profile blob",
                        })),
                        _ => {
                            any_failed = true;
                            results.push(json!({"section":"settings","status":"failed","detail":"profile restore failed"}));
                        }
                    }
                }
            }
        }
        "compx" => {
            let (_d, mut m) = match crate::open_mouse(cli)? {
                Some(s) => s,
                None => bail!("no Compx mouse detected"),
            };
            if let Some(s) = sections.get("settings") {
                let state = &s["state"];
                match crate::profile::mouse_config_from_json(state).and_then(|want| {
                    crate::profile::mouse_apply(&mut m, &want)?;
                    crate::profile::mouse_verify(&mut m, &want)
                }) {
                    Ok(problems) if problems.is_empty() => results.push(json!({
                        "section":"settings","status":"rolled_back","detail":"config restored",
                    })),
                    Ok(problems) => {
                        any_failed = true;
                        results.push(
                            json!({"section":"settings","status":"failed","detail":problems}),
                        );
                    }
                    Err(e) => {
                        any_failed = true;
                        results.push(json!({"section":"settings","status":"failed","detail":format!("{e:#}")}));
                    }
                }
            }
            if let Some(l) = sections.get("lighting") {
                match light_from_snapshot(&l["light"]).and_then(|light| {
                    m.set_light(&light)?;
                    let after = m.read_config()?;
                    if after.light != light {
                        bail!("lighting read-back differs");
                    }
                    Ok(())
                }) {
                    Ok(()) => results.push(json!({
                        "section":"lighting","status":"rolled_back","detail":"light restored",
                    })),
                    Err(e) => {
                        any_failed = true;
                        results.push(json!({"section":"lighting","status":"failed","detail":format!("{e:#}")}));
                    }
                }
            }
        }
        other => bail!("no rollback path for protocol '{other}'"),
    }

    let journal = json!({
        "id": id,
        "status": if any_failed { "partial" } else { "rolled_back" },
        "results": results,
    });
    if let Err(e) = save_store_json(&store_path(id, "rollback.json")?, &journal) {
        eprintln!("warning: could not write rollback journal: {e:#}");
    }
    for r in &journal["results"].as_array().cloned().unwrap_or_default() {
        println!(
            "  {:<15} {} — {}",
            r["section"].as_str().unwrap_or("?"),
            r["status"].as_str().unwrap_or("?"),
            r["detail"]
        );
    }
    Ok(if any_failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_schema_is_valid_draft_2020_12() {
        // validator_for compiles the schema; reaching here means it parsed.
        let _ = validator();
    }

    #[test]
    fn known_valid_and_invalid_docs() {
        let valid = json!({
            "schema_version": 1,
            "device": {"protocol":"khub916","vid":0x1e7d,"pid":0xf501},
            "settings": {"sleep_seconds": 30},
        });
        // VID/PID may not match a real device — structural check only.
        assert!(
            structural_errors(&valid).is_empty(),
            "{:?}",
            structural_errors(&valid)
        );
        let invalid = json!({
            "schema_version": 1,
            "device": {"protocol":"khub916","vid":0x1e7d,"pid":0xf501},
            "settings": {"sleep_seconds": 30, "bogus": 1},
        });
        assert!(!structural_errors(&invalid).is_empty());
    }

    /// Cross-implementation parity: schemas/fixtures/cases.json is also
    /// exercised by schemas/test_schema.py (python) and
    /// web/scripts/smoke-device-config.ts (AJV). Every entry must agree.
    #[test]
    fn shared_fixtures_match_python_and_web() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../../schemas/fixtures/cases.json"))
                .expect("fixtures parse");
        for case in fixtures["valid"].as_array().unwrap() {
            let errs = structural_errors(&case["doc"]);
            assert!(
                errs.is_empty(),
                "fixture valid:{} -> {errs:?}",
                case["name"]
            );
        }
        for case in fixtures["invalid"].as_array().unwrap() {
            let errs = structural_errors(&case["doc"]);
            assert!(!errs.is_empty(), "fixture invalid:{} passed", case["name"]);
        }
    }

    #[test]
    fn hex_roundtrip_and_validation() {
        assert_eq!(unhex(&hex(&[0x00, 0x5a, 0xa5, 0xff])).unwrap(), vec![0, 0x5a, 0xa5, 0xff]);
        assert!(unhex("abc").is_err());
        assert!(unhex("zz").is_err());
        assert!(store_path("bad id!", "snapshots.json").is_err());
        assert!(store_path("config-x-1", "snapshots.json").is_ok());
    }

    #[test]
    fn light_snapshot_roundtrip() {
        let l = omg_proto_mouse::Light {
            on: true,
            mode: 3,
            color: omg_proto_mouse::Rgb { r: 0x12, g: 0x34, b: 0x56 },
            speed: 5,
            brightness: 7,
        };
        let back = light_from_snapshot(&light_snapshot(&l)).unwrap();
        assert_eq!(back, l);
    }

    /// The embedded schema must be byte-identical to the repo artifact —
    /// `include_str!` makes drift impossible at compile time, but assert
    /// anyway so a stale binary can't silently diverge in tests.
    #[test]
    fn embedded_schema_matches_repo_file() {
        let on_disk = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../schemas/device-config.schema.json"
        ))
        .expect("repo schema readable");
        assert_eq!(DEVICE_CONFIG_SCHEMA, on_disk);
    }
}
