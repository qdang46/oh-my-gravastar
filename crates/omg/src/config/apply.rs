//! `omg config apply` — write a validated desired-state document.
//!
//! Scope: `khub916-k1pro` only (the single live-verified writable
//! family). The document must pass the full [`document::validate`]
//! pipeline first — apply never sees an unvalidated shape.
//!
//! Safety contract (AGENTS.md §2): `--yes` is required before any byte
//! is sent; without it the computed change plan is printed and the
//! command refuses. Every section write goes through the protocol
//! layer's built-in read-back verify (`write_*` returns `WriteOutcome
//! { verified: true }` or an error). Writes run in dependency order —
//! macro region before keymap (bindings reference macro ids), profile
//! (sleep + light effect) before the light-data blob and per-key
//! colours — and stop on the first failure so a partial apply is
//! reported, never hidden.

use std::process::ExitCode;

use omg_proto_khub916::light::{self, RgbTrip};
use omg_proto_khub916::macro916::{self, MacroEntry};
use omg_proto_khub916::Rgb;
use serde_json::{json, Value};

use crate::config::commands::{devices, pick_device};
use crate::config::document;
use crate::config::{schema, state, ConfigError};
use crate::{print_json, Cli, Yes};

/// Sections the apply pipeline knows how to write, in write order.
const WRITE_ORDER: &[&str] = &["macros", "keymap", "profile", "lighting"];

/// `config apply <file>` entry point (dispatched from
/// [`crate::config::commands`]).
pub fn apply(cli: &Cli, file: &str, yes: &Yes) -> anyhow::Result<ExitCode> {
    let doc = match document::read_document(file) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    // diff/apply need live state → a family selector is not enough.
    if let Some(sel) = cli.device.as_deref() {
        if schema::selector_schema_id(sel).is_some() {
            return fail(ConfigError::unsupported(format!(
                "config apply needs a physical device, not family selector '{sel}'"
            )));
        }
    }
    let devs = match devices() {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let device = match pick_device(&devs, cli.device.as_deref()) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };
    let ctx = match state::target_context(&device) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    if !schema::is_writable(&ctx.schema_id) {
        return fail(ConfigError::unsupported(format!(
            "schema '{}' has no writable surface in this release",
            ctx.schema_id
        )));
    }
    let desired = match document::validate(&doc, &ctx) {
        Ok(v) => v.doc,
        Err(e) => return fail(e),
    };
    let current = match state::read_current(&device) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };

    let plan = change_plan(&current, &desired);
    if plan["changed"] == json!(false) {
        print_json(&json!({
            "ok": true,
            "kind": "omg.config.apply",
            "applied": false,
            "equal": true,
            "message": "device already matches the desired state — nothing written",
        }))?;
        return Ok(ExitCode::SUCCESS);
    }
    if !yes.yes {
        // Safety §2: print the exact change, then refuse before any bytes.
        print_json(&json!({
            "ok": true,
            "kind": "omg.config.apply",
            "dry_run": true,
            "plan": plan,
            "message": "re-run with --yes to apply these changes",
        }))?;
        return fail(ConfigError::new(
            "confirmation_required",
            "config apply is a write — re-run with --yes to send these changes",
        ));
    }

    let mut kb = match state::open_session(&device) {
        Ok(k) => k,
        Err(e) => return fail(e),
    };
    let desired_conf = &desired["configuration"];
    let current_conf = &current["configuration"];
    let mut steps: Vec<Value> = Vec::new();
    for section in WRITE_ORDER {
        let changed = plan["sections"][section]["changed"] == json!(true);
        if !changed {
            continue;
        }
        let r = match *section {
            "macros" => apply_macros(&mut kb, desired_conf),
            "keymap" => apply_keymap(&mut kb, desired_conf, current_conf),
            "profile" => apply_profile(&mut kb, desired_conf),
            "lighting" => apply_lighting(&mut kb, &desired_conf["lighting"]),
            _ => unreachable!(),
        };
        match r {
            Ok(detail) => steps.push(json!({
                "section": section,
                "verified": true,
                "detail": detail,
            })),
            Err(e) => {
                steps.push(json!({
                    "section": section,
                    "verified": false,
                    "error": format!("{e:#}"),
                }));
                // Stop on first failure: later sections may depend on
                // this one's state (e.g. macro ids referenced by keymap).
                print_json(&json!({
                    "ok": false,
                    "kind": "omg.config.apply",
                    "applied": steps.iter().any(|s| s["verified"] == json!(true)),
                    "failed_section": section,
                    "steps": steps,
                }))?;
                return Ok(ExitCode::from(1));
            }
        }
    }

    print_json(&json!({
        "ok": true,
        "kind": "omg.config.apply",
        "applied": true,
        "target": desired["target"],
        "steps": steps,
    }))?;
    Ok(ExitCode::SUCCESS)
}

// ── change plan ────────────────────────────────────────────────────────

/// Per-section changed flags derived from canonical-doc comparison.
/// `profile` covers `device.sleep_timeout_seconds` + `lighting.effect`
/// (one cmd-4 blob); `lighting` covers `mode_colors` + `per_key`.
fn change_plan(current: &Value, desired: &Value) -> Value {
    let c = &current["configuration"];
    let d = &desired["configuration"];
    let macros_changed = c["macros"] != d["macros"];
    let keymap_changed = c["keymap"] != d["keymap"];
    let profile_changed =
        c["device"] != d["device"] || c["lighting"]["effect"] != d["lighting"]["effect"];
    let lighting_changed = c["lighting"]["mode_colors"] != d["lighting"]["mode_colors"]
        || c["lighting"]["per_key"] != d["lighting"]["per_key"];
    let changed = macros_changed || keymap_changed || profile_changed || lighting_changed;
    json!({
        "changed": changed,
        "sections": {
            "macros": {"changed": macros_changed},
            "keymap": {"changed": keymap_changed},
            "profile": {"changed": profile_changed,
                        "fields": profile_fields_changed(c, d)},
            "lighting": {"changed": lighting_changed},
        },
    })
}

fn profile_fields_changed(c: &Value, d: &Value) -> Vec<&'static str> {
    let mut out = Vec::new();
    if c["device"] != d["device"] {
        out.push("device.sleep_timeout_seconds");
    }
    if c["lighting"]["effect"] != d["lighting"]["effect"] {
        out.push("lighting.effect");
    }
    out
}

// ── section writers ────────────────────────────────────────────────────

/// `configuration.macros` → cmd-5 region write. Entries are rebuilt in
/// document order (ids are contiguous positions, enforced by validate).
fn apply_macros(
    kb: &mut omg_proto_khub916::Khub916,
    desired_conf: &Value,
) -> anyhow::Result<Value> {
    let macros = &desired_conf["macros"];
    let arr = macros
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("configuration.macros must be an array (validator gap)"))?;
    let mut entries = Vec::with_capacity(arr.len());
    for (i, mv) in arr.iter().enumerate() {
        let name = mv["name"].as_str().unwrap_or_default().to_string();
        let steps_json = mv["steps"].as_array().cloned().unwrap_or_default();
        let mut steps = Vec::with_capacity(steps_json.len());
        for (j, sv) in steps_json.iter().enumerate() {
            // Canon steps are a fixed point of parse_step — re-parsing
            // yields the wire MacroStep (usage + kind + nibble).
            let (step, _) = document::parse_step(sv, &format!("macros[{i}].steps[{j}]"))
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            steps.push(step);
        }
        entries.push(MacroEntry { name, steps });
    }
    // An empty list assembles to 0 bytes; the wire write needs ≥1 byte —
    // same minimal all-zero region kb916_macro sends for delete-all.
    let region = if entries.is_empty() {
        vec![0u8; 4]
    } else {
        macro916::build_macro_region(&entries)?
    };
    // Skip the 512-byte write when the assembled region already matches
    // the device (canonical docs can differ in warnings-only fields).
    let live = kb.macro_region()?;
    let mut live_pad = live;
    live_pad.resize(macro916::MACRO_REGION_BYTES, 0);
    let mut want_pad = region.clone();
    want_pad.resize(macro916::MACRO_REGION_BYTES, 0);
    if live_pad == want_pad {
        return Ok(json!({"entries": entries.len(), "skipped": "region unchanged"}));
    }
    let outcome = kb.write_macro_region(&region)?;
    if !outcome.verified {
        anyhow::bail!("macro region write not verified");
    }
    Ok(json!({"entries": entries.len()}))
}

/// `configuration.keymap.layers[]` → per-bank cmd-3 whole-table writes.
/// Only banks whose values differ from the live read are sent; each
/// write_keymap carries its own read-back verify.
fn apply_keymap(
    kb: &mut omg_proto_khub916::Khub916,
    desired_conf: &Value,
    current_conf: &Value,
) -> anyhow::Result<Value> {
    let layers = desired_conf["keymap"]["layers"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("configuration.keymap.layers must be an array"))?;
    // (layer, system) → current u32 key values, for per-bank skip.
    let mut current_keys: std::collections::HashMap<(u8, u8), Vec<u32>> =
        std::collections::HashMap::new();
    if let Some(ls) = current_conf["keymap"]["layers"].as_array() {
        for l in ls {
            let layer = l["layer"].as_u64().unwrap_or(0) as u8;
            let system = l["system"].as_u64().unwrap_or(0) as u8;
            let vals: Vec<u32> = l["keys"]
                .as_array()
                .map(|ks| {
                    ks.iter()
                        .filter_map(|k| {
                            k.as_str().and_then(|s| {
                                u32::from_str_radix(s.trim_start_matches("0x"), 16).ok()
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            current_keys.insert((layer, system), vals);
        }
    }
    let mut written = Vec::new();
    for lv in layers {
        let layer = lv["layer"].as_u64().unwrap_or(0) as u8;
        let system = lv["system"].as_u64().unwrap_or(0) as u8;
        let keys = lv["keys"].as_array().ok_or_else(|| {
            anyhow::anyhow!("keymap layer {layer}/{system} keys must be an array")
        })?;
        let mut values = Vec::with_capacity(keys.len());
        for (i, kv) in keys.iter().enumerate() {
            let s = kv.as_str().ok_or_else(|| {
                anyhow::anyhow!("keymap[{layer}][{system}].keys[{i}] must be a hex string")
            })?;
            let v = u32::from_str_radix(s.trim_start_matches("0x"), 16)
                .map_err(|_| anyhow::anyhow!("keymap keys[{i}] bad hex '{s}'"))?;
            values.push(v);
        }
        if values.len() != schema::K1PRO_KEYS {
            anyhow::bail!(
                "keymap layer {layer}/system {system} has {} keys, expected {}",
                values.len(),
                schema::K1PRO_KEYS
            );
        }
        // Skip banks already matching the live read.
        if current_keys.get(&(layer, system)) == Some(&values) {
            continue;
        }
        let outcome = kb.write_keymap(layer, system, &values)?;
        if !outcome.verified {
            anyhow::bail!("keymap layer {layer}/system {system} write not verified");
        }
        written.push(json!({"layer": layer, "system": system}));
    }
    Ok(json!({"banks_written": written.len(), "banks": written}))
}

/// `device.sleep_timeout_seconds` + `lighting.effect` → ONE cmd-4
/// profile write (both live in the same blob — two writes would race).
fn apply_profile(kb: &mut omg_proto_khub916::Khub916, conf: &Value) -> anyhow::Result<Value> {
    let mut blob = kb.profile()?.raw;
    let mut touched = Vec::new();

    let desired_sleep = conf["device"]["sleep_timeout_seconds"].as_u64();
    if let Some(secs) = desired_sleep {
        let profile = omg_proto_khub916::Profile { raw: blob.clone() };
        let new = profile.with_sleep_seconds(secs as u8)?;
        if new != blob {
            blob = new;
            touched.push("device.sleep_timeout_seconds");
        }
    }

    let eff = &conf["lighting"]["effect"];
    let mode = eff["mode"].as_u64().unwrap_or(0) as u16;
    let speed = eff["speed"].as_u64().unwrap_or(0) as u8;
    let bright = eff["brightness"].as_u64().unwrap_or(0) as u8;
    let cm = match eff["color_model"].as_str().unwrap_or("") {
        "monochrome" => light::color_model::MONOCHROME,
        "mixing" => light::color_model::MIXING,
        other => anyhow::bail!("lighting.effect.color_model '{other}' invalid"),
    };
    let profile = omg_proto_khub916::Profile { raw: blob.clone() };
    let new = profile.with_light_mode(mode, speed, bright, cm)?;
    if new != blob {
        blob = new;
        touched.push("lighting.effect");
    }

    if touched.is_empty() {
        return Ok(json!({"skipped": "profile blob already matches"}));
    }
    let outcome = kb.write_profile(&blob)?;
    if !outcome.verified {
        anyhow::bail!("profile write not verified");
    }
    Ok(json!({"fields": touched}))
}

/// `lighting.mode_colors` (cmd-138 blob groups) + `lighting.per_key`
/// (cmd-6 custom colours). Group colours go through `with_group_color`
/// RMW on the live blob; per-key colours are a full-table write.
fn apply_lighting(kb: &mut omg_proto_khub916::Khub916, lighting: &Value) -> anyhow::Result<Value> {
    let mut detail = json!({});

    // mode_colors → cmd 138 light-data blob
    let groups = lighting["mode_colors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !groups.is_empty() {
        let mut blob = kb.light_color_data()?;
        let orig = blob.clone();
        for g in &groups {
            let mode = g["mode"].as_u64().unwrap_or(0) as u16;
            let hex = g["color"].as_str().unwrap_or("");
            let trip = parse_hex_color(hex)
                .ok_or_else(|| anyhow::anyhow!("mode_colors color '{hex}' not #rrggbb"))?;
            blob = light::with_group_color(&blob, mode, trip).ok_or_else(|| {
                anyhow::anyhow!("mode {mode} has no colour group in the light blob")
            })?;
        }
        if blob != orig {
            let outcome = kb.write_light_data(&blob)?;
            if !outcome.verified {
                anyhow::bail!("light-data write not verified");
            }
            detail["mode_colors"] = json!({"groups": groups.len()});
        } else {
            detail["mode_colors"] = json!({"skipped": "unchanged"});
        }
    }

    // per_key → cmd 6 custom colours (full 126-slot table)
    let colors = lighting["per_key"]["colors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if colors.len() == schema::K1PRO_KEYS {
        let wire: Vec<Rgb> = colors
            .iter()
            .map(|c| {
                let hex = c.as_str().unwrap_or("");
                parse_hex_color(hex)
                    .map(|t| Rgb {
                        r: t.r,
                        g: t.g,
                        b: t.b,
                    })
                    .ok_or_else(|| anyhow::anyhow!("per_key color '{hex}' not #rrggbb"))
            })
            .collect::<anyhow::Result<_>>()?;
        // Skip the 378-byte write when the table already matches.
        let current = kb.custom_light_colors()?;
        let current_rgb: Vec<Rgb> = current
            .iter()
            .map(|c| Rgb {
                r: c.r,
                g: c.g,
                b: c.b,
            })
            .collect();
        if wire != current_rgb {
            let outcome = kb.write_custom_light_colors(&wire)?;
            if !outcome.verified {
                anyhow::bail!("custom colours write not verified");
            }
            detail["per_key"] = json!({"keys": wire.len()});
        } else {
            detail["per_key"] = json!({"skipped": "unchanged"});
        }
    }

    Ok(detail)
}

fn parse_hex_color(hex: &str) -> Option<RgbTrip> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some(RgbTrip {
        r: ((v >> 16) & 0xFF) as u8,
        g: ((v >> 8) & 0xFF) as u8,
        b: (v & 0xFF) as u8,
    })
}

// ── plumbing ───────────────────────────────────────────────────────────

fn fail(err: ConfigError) -> anyhow::Result<ExitCode> {
    print_json(&err.envelope())?;
    Ok(ExitCode::from(err.exit_code()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conf(sleep: u64, mode: u64, mc0: &str, key0: &str) -> Value {
        json!({
            "device": {"sleep_timeout_seconds": sleep},
            "keymap": {"layers": [{"layer": 0, "system": 0, "keys": [key0]}]},
            "lighting": {
                "effect": {"mode": mode, "speed": 4, "brightness": 8, "color_model": "mixing"},
                "mode_colors": [{"mode": 0, "color": mc0}],
                "per_key": {"mode": "explicit", "colors": []},
            },
            "macros": [],
        })
    }

    fn doc(conf: Value) -> Value {
        json!({"configuration": conf})
    }

    #[test]
    fn change_plan_equal_reports_no_change() {
        let c = conf(30, 15, "#112233", "0x00000029");
        let plan = change_plan(&doc(c.clone()), &doc(c));
        assert_eq!(plan["changed"], json!(false));
        assert_eq!(plan["sections"]["profile"]["changed"], json!(false));
        assert_eq!(plan["sections"]["lighting"]["changed"], json!(false));
    }

    #[test]
    fn change_plan_flags_each_section() {
        let c = conf(30, 15, "#112233", "0x00000029");
        let mut d = conf(60, 15, "#112233", "0x00000029");
        d["lighting"]["mode_colors"][0]["color"] = json!("#445566");
        let plan = change_plan(&doc(c.clone()), &doc(d));
        assert_eq!(plan["changed"], json!(true));
        assert_eq!(plan["sections"]["profile"]["changed"], json!(true)); // sleep changed
        assert_eq!(
            plan["sections"]["profile"]["fields"],
            json!(["device.sleep_timeout_seconds"])
        );
        assert_eq!(plan["sections"]["lighting"]["changed"], json!(true));
        assert_eq!(plan["sections"]["keymap"]["changed"], json!(false));
        assert_eq!(plan["sections"]["macros"]["changed"], json!(false));
    }

    #[test]
    fn change_plan_detects_effect_and_keymap() {
        let c = conf(30, 15, "#112233", "0x00000029");
        let mut d = conf(30, 16, "#112233", "0x00000029");
        d["keymap"]["layers"][0]["keys"][0] = json!("0x0000002A");
        let plan = change_plan(&doc(c), &doc(d));
        assert_eq!(plan["sections"]["keymap"]["changed"], json!(true));
        assert_eq!(
            plan["sections"]["profile"]["fields"],
            json!(["lighting.effect"])
        );
    }

    #[test]
    fn parse_hex_color_formats() {
        assert_eq!(
            parse_hex_color("#0aFf09"),
            Some(RgbTrip {
                r: 10,
                g: 255,
                b: 9
            })
        );
        assert_eq!(
            parse_hex_color("0a0b0c"),
            Some(RgbTrip {
                r: 10,
                g: 11,
                b: 12
            })
        );
        assert_eq!(parse_hex_color("#12345"), None);
        assert_eq!(parse_hex_color("red"), None);
    }
}
