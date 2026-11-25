//! Strict desired-state document parser/validator (ADR §2, spec §4.2, §7).
//!
//! "Full" semantics: every managed writable field must be present; nested
//! objects must be complete; missing fields are errors, never "leave
//! unchanged". Unknown properties fail closed (`additionalProperties:
//! false` at every managed boundary). Values are explicit — nothing is
//! defaulted from schema metadata.
//!
//! Only `khub916-k1pro` has a writable surface in this slice; documents
//! for the gated families are rejected with `unsupported` before their
//! (declared, non-writable) configuration is inspected.

use std::collections::BTreeMap;

use omg_proto_khub916::light::LIGHT_MODES;
use omg_proto_khub916::macro916::{self, MacroStep, StepKind};
use omg_proto_khub916::{decode_key_value, KeyValue};
use serde_json::{json, Map, Value};

use crate::config::error::ConfigError;
use crate::config::keyaction;
use crate::config::schema::{
    self, K1PRO_KEYMAP_BANKS, K1PRO_KEYS, K1PRO_MODE_COLORS, MACRO_NAME_MAX_BYTES,
    MACRO_STEP_DELAY_MAX,
};

/// Device/firmware binding context the document is validated against.
/// `model`/`firmware` are `None` only for family-level (no-device) checks,
/// which the CLI does not currently expose for `validate`/`diff`.
pub struct TargetContext {
    pub schema_id: String,
    pub device_kind: String,
    pub model: Option<String>,
    pub firmware: Option<String>,
}

/// A validated, normalized document plus non-fatal observations.
#[derive(Debug)]
pub struct Validated {
    /// Canonical document (keymap banks sorted into cmd-131 arg order,
    /// normalized `0x%08X` key hex and `#rrggbb` colours). `config diff`
    /// compares this against the `config get` output.
    pub doc: Value,
    /// Opaque/unusual-but-legal content the agent should know about
    /// (unknown-tag key values, `other` macro steps, …).
    pub warnings: Vec<Value>,
}

// ── Small structural helpers ───────────────────────────────────────────

fn as_obj<'a>(v: &'a Value, path: &str) -> Result<&'a Map<String, Value>, ConfigError> {
    v.as_object()
        .ok_or_else(|| ConfigError::invalid_document(format!("{path} must be an object")).at(path))
}

fn as_arr<'a>(v: &'a Value, path: &str) -> Result<&'a Vec<Value>, ConfigError> {
    v.as_array()
        .ok_or_else(|| ConfigError::invalid_document(format!("{path} must be an array")).at(path))
}

/// Required field or `missing_required_field`.
fn req<'a>(o: &'a Map<String, Value>, path: &str, name: &str) -> Result<&'a Value, ConfigError> {
    o.get(name)
        .ok_or_else(|| ConfigError::missing_required_field(path, name))
}

/// Reject properties outside `allowed` (additionalProperties:false).
fn only_keys(o: &Map<String, Value>, path: &str, allowed: &[&str]) -> Result<(), ConfigError> {
    for k in o.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(ConfigError::unknown_property(path, k));
        }
    }
    Ok(())
}

fn as_int(v: &Value, path: &str) -> Result<u64, ConfigError> {
    v.as_u64().ok_or_else(|| {
        ConfigError::invalid_document(format!("{path} must be a non-negative integer")).at(path)
    })
}

fn as_int_range(v: &Value, path: &str, min: u64, max: u64) -> Result<u64, ConfigError> {
    let n = as_int(v, path)?;
    if n < min || n > max {
        return Err(ConfigError::invalid_document(format!(
            "{path} must be in {min}..={max}, got {n}"
        ))
        .at(path));
    }
    Ok(n)
}

fn as_str<'a>(v: &'a Value, path: &str) -> Result<&'a str, ConfigError> {
    v.as_str()
        .ok_or_else(|| ConfigError::invalid_document(format!("{path} must be a string")).at(path))
}

/// `#rrggbb` (case-insensitive); normalized to lowercase-with-`#` on output.
fn parse_color(v: &Value, path: &str) -> Result<String, ConfigError> {
    let s = as_str(v, path)?;
    let hex = s.strip_prefix('#').unwrap_or("");
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ConfigError::invalid_document(format!(
            "{path} must be a #rrggbb colour string"
        ))
        .at(path));
    }
    Ok(format!("#{}", hex.to_ascii_lowercase()))
}

// ── Macro step parsing ─────────────────────────────────────────────────
// Mirrors `kb916_macro`'s `macro set` key rules (vendor `fe` table,
// decimal usage, 0x-hex) plus `kind:"other"`+`nibble` for opaque steps.

fn parse_step_key(v: &Value, path: &str) -> Result<(u8, Option<StepKind>), ConfigError> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                let n = u32::from_str_radix(hex, 16).map_err(|_| {
                    ConfigError::invalid_document(format!("{path}: bad hex key '{s}'")).at(path)
                })?;
                if n > u8::MAX as u32 {
                    return Err(ConfigError::invalid_document(format!(
                        "{path}: key usage {n} does not fit the u8 code byte"
                    ))
                    .at(path));
                }
                return Ok((n as u8, None));
            }
            if let Ok(n) = t.parse::<u32>() {
                if n > u8::MAX as u32 {
                    return Err(ConfigError::invalid_document(format!(
                        "{path}: key usage {n} does not fit the u8 code byte"
                    ))
                    .at(path));
                }
                return Ok((n as u8, None));
            }
            // Vendor name: exact, then case-insensitive (kb916_macro rules).
            if let Some(u) = macro916::macro_usage_for_name(t) {
                if u > u32::from(u8::MAX) {
                    return Err(ConfigError::invalid_document(format!(
                        "{path}: key '{t}' (usage {u}) is not encodable in a macro step"
                    ))
                    .at(path));
                }
                return Ok((u as u8, Some(macro916::default_kind_for_name(t))));
            }
            let lower = t.to_ascii_lowercase();
            for &(name, u) in macro916::MACRO_KEY_TABLE {
                if name.to_ascii_lowercase() == lower {
                    if u > u32::from(u8::MAX) {
                        return Err(ConfigError::invalid_document(format!(
                            "{path}: key '{t}' (usage {u}) is not encodable in a macro step"
                        ))
                        .at(path));
                    }
                    return Ok((u as u8, Some(macro916::default_kind_for_name(name))));
                }
            }
            Err(ConfigError::invalid_document(format!(
                "{path}: unknown key '{t}' (want a vendor name, usage number, or 0x-hex)"
            ))
            .at(path))
        }
        Value::Number(n) => {
            let u = n.as_u64().ok_or_else(|| {
                ConfigError::invalid_document(format!("{path}: key must be a non-negative integer"))
                    .at(path)
            })?;
            if u > u8::MAX as u64 {
                return Err(ConfigError::invalid_document(format!(
                    "{path}: key usage {u} does not fit the u8 code byte"
                ))
                .at(path));
            }
            Ok((u as u8, None))
        }
        _ => Err(
            ConfigError::invalid_document(format!("{path}: key must be a string or number"))
                .at(path),
        ),
    }
}

/// Canonical authored step shape: {action, delay_ms, key, kind?, nibble?}.
/// `kind` defaults from the key name (or "key"); `nibble` is required iff
/// `kind == "other"` and forbidden otherwise. Returns the wire step plus
/// its canonical JSON form.
pub(crate) fn parse_step(v: &Value, path: &str) -> Result<(MacroStep, Value), ConfigError> {
    let o = as_obj(v, path)?;
    only_keys(o, path, &["action", "delay_ms", "key", "kind", "nibble"])?;
    let action = match as_str(req(o, path, "action")?, &format!("{path}.action"))? {
        "down" | "press" | "0" => 0u8,
        "up" | "release" | "1" => 1u8,
        other => {
            return Err(ConfigError::invalid_document(format!(
                "{path}.action must be \"down\" or \"up\", got {other:?}"
            ))
            .at(format!("{path}.action")))
        }
    };
    let delay_ms = as_int_range(
        req(o, path, "delay_ms")?,
        &format!("{path}.delay_ms"),
        0,
        MACRO_STEP_DELAY_MAX,
    )? as u32;
    let (usage, name_kind) = parse_step_key(req(o, path, "key")?, &format!("{path}.key"))?;
    let kind = match o.get("kind") {
        None | Some(Value::Null) => name_kind.unwrap_or(StepKind::Key),
        Some(kv) => match as_str(kv, &format!("{path}.kind"))? {
            "key" => StepKind::Key,
            "modifier" | "mod" => StepKind::Modifier,
            "mouse" => StepKind::Mouse,
            "other" => {
                let nib = o.get("nibble").ok_or_else(|| {
                    ConfigError::missing_required_field(format!("{path}.nibble"), "nibble")
                })?;
                StepKind::Other(as_int_range(nib, &format!("{path}.nibble"), 0, 15)? as u8)
            }
            other => {
                return Err(ConfigError::invalid_document(format!(
                    "{path}.kind must be key|modifier|mouse|other, got {other:?}"
                ))
                .at(format!("{path}.kind")))
            }
        },
    };
    if !matches!(kind, StepKind::Other(_)) && o.contains_key("nibble") {
        return Err(
            ConfigError::unknown_property(format!("{path}.nibble"), "nibble")
                .with_details(json!({"reason": "nibble is only valid with kind \"other\""})),
        );
    }
    let step = MacroStep {
        action,
        delay_ms,
        usage,
        kind,
    };
    // Canonical step JSON (what `config get` emits and `diff` compares):
    // vendor name when one exists for (usage, kind), else the raw usage.
    let key_json = match kind {
        StepKind::Other(_) => json!(usage),
        _ => macro916::macro_name_for_usage(usage, kind)
            .map(|n| json!(n))
            .unwrap_or_else(|| json!(usage)),
    };
    let mut out = json!({
        "action": if action == 0 { "down" } else { "up" },
        "delay_ms": delay_ms,
        "key": key_json,
    });
    match kind {
        StepKind::Key => out["kind"] = json!("key"),
        StepKind::Modifier => out["kind"] = json!("modifier"),
        StepKind::Mouse => out["kind"] = json!("mouse"),
        StepKind::Other(n) => {
            out["kind"] = json!("other");
            out["nibble"] = json!(n);
        }
    }
    Ok((step, out))
}

// ── khub916-k1pro configuration ────────────────────────────────────────

/// One validated keymap bank; `values` has exactly K1PRO_KEYS entries.
struct KeymapBank {
    layer: u8,
    system: u8,
    values: Vec<u32>,
}

/// Validate `configuration.keymap` → banks sorted by (system, layer),
/// i.e. cmd-131 arg order 0..7.
fn validate_keymap(
    conf: &Map<String, Value>,
    warnings: &mut Vec<Value>,
) -> Result<Vec<KeymapBank>, ConfigError> {
    let path = "configuration.keymap";
    let km = as_obj(req(conf, path, "keymap")?, path)?;
    only_keys(km, path, &["layers"])?;
    let layers = as_arr(req(km, path, "layers")?, &format!("{path}.layers"))?;
    if layers.len() != K1PRO_KEYMAP_BANKS {
        return Err(ConfigError::invalid_document(format!(
            "{path}.layers must contain exactly {K1PRO_KEYMAP_BANKS} banks (4 layers × 2 systems), got {}",
            layers.len()
        ))
        .at(format!("{path}.layers")));
    }
    let mut banks: BTreeMap<(u8, u8), Vec<u32>> = BTreeMap::new();
    for (i, lv) in layers.iter().enumerate() {
        let p = format!("{path}.layers[{i}]");
        let o = as_obj(lv, &p)?;
        only_keys(o, &p, &["layer", "system", "keys"])?;
        let layer = as_int_range(req(o, &p, "layer")?, &format!("{p}.layer"), 0, 3)? as u8;
        let system = as_int_range(req(o, &p, "system")?, &format!("{p}.system"), 0, 1)? as u8;
        let keys = as_arr(req(o, &p, "keys")?, &format!("{p}.keys"))?;
        if keys.len() != K1PRO_KEYS {
            return Err(ConfigError::invalid_document(format!(
                "{p}.keys must contain exactly {K1PRO_KEYS} key values, got {}",
                keys.len()
            ))
            .at(format!("{p}.keys")));
        }
        let slot = banks.entry((system, layer)).or_default();
        if !slot.is_empty() {
            return Err(ConfigError::invalid_document(format!(
                "{p}: duplicate (layer={layer}, system={system}) bank"
            ))
            .at(p));
        }
        let mut opaque = 0usize;
        for (j, kv) in keys.iter().enumerate() {
            // `"0x…"` hex or a semantic {"key","modifiers"} object (bead
            // 112) — both resolve to the same u32; output stays hex.
            let n = keyaction::resolve_key_item(kv, &format!("{p}.keys[{j}]"))?;
            if matches!(
                decode_key_value(n),
                KeyValue::Unknown { .. }
                    | KeyValue::SecondaryLayer { .. }
                    | KeyValue::Socd { .. }
                    | KeyValue::Mt { .. }
                    | KeyValue::Tgl { .. }
            ) {
                opaque += 1;
            }
            slot.push(n);
        }
        if opaque > 0 {
            warnings.push(json!({
                "path": p,
                "kind": "opaque_key_values",
                "count": opaque,
                "note": "slots whose u32 tag the decoder cannot name — preserved byte-identical, never interpreted (AGENTS.md §Safety 7)",
            }));
        }
    }
    if banks.len() != K1PRO_KEYMAP_BANKS {
        return Err(ConfigError::invalid_document(format!(
            "{path}.layers must cover all {K1PRO_KEYMAP_BANKS} (layer,system) pairs, got {}",
            banks.len()
        ))
        .at(format!("{path}.layers")));
    }
    Ok(banks
        .into_iter()
        .map(|((system, layer), values)| KeymapBank {
            layer,
            system,
            values,
        })
        .collect())
}

fn validate_device(conf: &Map<String, Value>) -> Result<Value, ConfigError> {
    let path = "configuration.device";
    let o = as_obj(req(conf, path, "device")?, path)?;
    only_keys(o, path, &["sleep_timeout_seconds"])?;
    let secs = as_int_range(
        req(o, path, "sleep_timeout_seconds")?,
        &format!("{path}.sleep_timeout_seconds"),
        0,
        255,
    )?;
    Ok(json!({"sleep_timeout_seconds": secs}))
}

fn validate_lighting(conf: &Map<String, Value>) -> Result<Value, ConfigError> {
    let path = "configuration.lighting";
    let o = as_obj(req(conf, path, "lighting")?, path)?;
    only_keys(o, path, &["effect", "mode_colors", "per_key"])?;

    // effect
    let ep = format!("{path}.effect");
    let e = as_obj(req(o, path, "effect")?, &ep)?;
    only_keys(e, &ep, &["mode", "speed", "brightness", "color_model"])?;
    let mode = as_int(req(e, &ep, "mode")?, &format!("{ep}.mode"))?;
    if !LIGHT_MODES.iter().any(|m| m.id as u64 == mode) {
        return Err(ConfigError::invalid_document(format!(
            "{ep}.mode {mode} is not a known khub916 effect mode"
        ))
        .at(format!("{ep}.mode")));
    }
    let speed = as_int_range(
        req(e, &ep, "speed")?,
        &format!("{ep}.speed"),
        0,
        schema::LIGHT_SPEED_MAX,
    )?;
    let bright = as_int_range(
        req(e, &ep, "brightness")?,
        &format!("{ep}.brightness"),
        0,
        schema::LIGHT_BRIGHTNESS_MAX,
    )?;
    let cm = as_str(req(e, &ep, "color_model")?, &format!("{ep}.color_model"))?;
    if cm != "monochrome" && cm != "mixing" {
        return Err(ConfigError::invalid_document(format!(
            "{ep}.color_model must be \"monochrome\" or \"mixing\", got {cm:?}"
        ))
        .at(format!("{ep}.color_model")));
    }
    let effect = json!({
        "mode": mode,
        "speed": speed,
        "brightness": bright,
        "color_model": cm,
    });

    // mode_colors: exactly K1PRO_MODE_COLORS groups, unique modes 0..N-1.
    let mp = format!("{path}.mode_colors");
    let mc = as_arr(req(o, path, "mode_colors")?, &mp)?;
    if mc.len() != K1PRO_MODE_COLORS {
        return Err(ConfigError::invalid_document(format!(
            "{mp} must contain exactly {K1PRO_MODE_COLORS} mode colour groups, got {}",
            mc.len()
        ))
        .at(&mp));
    }
    let mut seen = [false; K1PRO_MODE_COLORS];
    let mut mode_colors = Vec::with_capacity(mc.len());
    for (i, mv) in mc.iter().enumerate() {
        let p = format!("{mp}[{i}]");
        let mo = as_obj(mv, &p)?;
        only_keys(mo, &p, &["mode", "color"])?;
        let m = as_int_range(
            req(mo, &p, "mode")?,
            &format!("{p}.mode"),
            0,
            (K1PRO_MODE_COLORS - 1) as u64,
        )? as usize;
        if seen[m] {
            return Err(
                ConfigError::invalid_document(format!("{p}.mode {m} is duplicated"))
                    .at(format!("{p}.mode")),
            );
        }
        seen[m] = true;
        let color = parse_color(req(mo, &p, "color")?, &format!("{p}.color"))?;
        mode_colors.push(json!({"mode": m, "color": color}));
    }
    if seen.iter().any(|s| !s) {
        return Err(ConfigError::invalid_document(format!(
            "{mp} must cover every mode group 0..={}",
            K1PRO_MODE_COLORS - 1
        ))
        .at(&mp));
    }
    mode_colors.sort_by_key(|c| c["mode"].as_u64().unwrap());

    // per_key
    let pp = format!("{path}.per_key");
    let pk = as_obj(req(o, path, "per_key")?, &pp)?;
    only_keys(pk, &pp, &["mode", "colors"])?;
    if as_str(req(pk, &pp, "mode")?, &format!("{pp}.mode"))? != "explicit" {
        return Err(ConfigError::invalid_document(format!(
            "{pp}.mode must be \"explicit\" — presets are expanded client-side, not device state"
        ))
        .at(format!("{pp}.mode")));
    }
    let colors = as_arr(req(pk, &pp, "colors")?, &format!("{pp}.colors"))?;
    if colors.len() != K1PRO_KEYS {
        return Err(ConfigError::invalid_document(format!(
            "{pp}.colors must contain exactly {K1PRO_KEYS} colours, got {}",
            colors.len()
        ))
        .at(format!("{pp}.colors")));
    }
    let mut norm_colors = Vec::with_capacity(colors.len());
    for (i, c) in colors.iter().enumerate() {
        norm_colors.push(json!(parse_color(c, &format!("{pp}.colors[{i}]"))?));
    }

    Ok(json!({
        "effect": effect,
        "mode_colors": mode_colors,
        "per_key": {"mode": "explicit", "colors": norm_colors},
    }))
}

/// Result of validating `configuration.macros`.
struct MacrosValidated {
    /// Normalized entries in region order.
    entries: Vec<Value>,
    /// Flat binding tuples `(macro_id, layer, system, key_index,
    /// macro_type, loop_count)` for the keymap cross-check.
    bindings: Vec<(usize, u8, u8, u8, u8, u8)>,
}

/// Validate `configuration.macros`: per-entry shape, step parsing and
/// binding fields. Cross-entry consistency vs the keymap is checked by
/// [`check_macro_bindings`].
fn validate_macros(
    conf: &Map<String, Value>,
    warnings: &mut Vec<Value>,
) -> Result<MacrosValidated, ConfigError> {
    let path = "configuration.macros";
    let arr = as_arr(req(conf, path, "macros")?, path)?;
    let mut entries = Vec::with_capacity(arr.len());
    let mut bindings = Vec::new();
    for (i, mv) in arr.iter().enumerate() {
        let p = format!("{path}[{i}]");
        let o = as_obj(mv, &p)?;
        only_keys(o, &p, &["id", "name", "steps", "bindings"])?;
        let id = as_int_range(req(o, &p, "id")?, &format!("{p}.id"), 0, u8::MAX as u64)? as usize;
        if id != i {
            return Err(ConfigError::invalid_document(format!(
                "{p}.id must equal the entry's position ({i}) — macro ids are contiguous region indices"
            ))
            .at(format!("{p}.id")));
        }
        let name = as_str(req(o, &p, "name")?, &format!("{p}.name"))?;
        if name.len() > MACRO_NAME_MAX_BYTES {
            return Err(ConfigError::invalid_document(format!(
                "{p}.name exceeds {MACRO_NAME_MAX_BYTES} bytes"
            ))
            .at(format!("{p}.name")));
        }
        // steps (validated for shape; wire encoding happens at apply time)
        let steps = as_arr(req(o, &p, "steps")?, &format!("{p}.steps"))?;
        let mut norm_steps = Vec::with_capacity(steps.len());
        for (j, sv) in steps.iter().enumerate() {
            let (_, canon) = parse_step(sv, &format!("{p}.steps[{j}]"))?;
            if canon["kind"] == "other" {
                warnings.push(json!({
                    "path": format!("{p}.steps[{j}]"),
                    "kind": "opaque_macro_step",
                    "note": "unrecognized step nibble preserved verbatim",
                }));
            }
            norm_steps.push(canon);
        }
        // bindings
        let bs = as_arr(req(o, &p, "bindings")?, &format!("{p}.bindings"))?;
        let mut norm_bindings = Vec::with_capacity(bs.len());
        for (j, bv) in bs.iter().enumerate() {
            let bp = format!("{p}.bindings[{j}]");
            let bo = as_obj(bv, &bp)?;
            only_keys(
                bo,
                &bp,
                &["layer", "system", "key_index", "macro_type", "loop_count"],
            )?;
            let layer = as_int_range(req(bo, &bp, "layer")?, &format!("{bp}.layer"), 0, 3)? as u8;
            let system =
                as_int_range(req(bo, &bp, "system")?, &format!("{bp}.system"), 0, 1)? as u8;
            let key_index = as_int_range(
                req(bo, &bp, "key_index")?,
                &format!("{bp}.key_index"),
                0,
                (K1PRO_KEYS - 1) as u64,
            )? as u8;
            let macro_type = as_int_range(
                req(bo, &bp, "macro_type")?,
                &format!("{bp}.macro_type"),
                0,
                255,
            )? as u8;
            let loop_count = as_int_range(
                req(bo, &bp, "loop_count")?,
                &format!("{bp}.loop_count"),
                1,
                255,
            )? as u8;
            bindings.push((id, layer, system, key_index, macro_type, loop_count));
            norm_bindings.push(json!({
                "layer": layer,
                "system": system,
                "key_index": key_index,
                "macro_type": macro_type,
                "loop_count": loop_count,
            }));
        }
        // Canonical order so `config diff` is insensitive to authored
        // binding order (state::read_current emits sorted bindings).
        norm_bindings.sort_by(|a, b| {
            (
                a["layer"].as_u64(),
                a["system"].as_u64(),
                a["key_index"].as_u64(),
                a["macro_type"].as_u64(),
                a["loop_count"].as_u64(),
            )
                .cmp(&(
                    b["layer"].as_u64(),
                    b["system"].as_u64(),
                    b["key_index"].as_u64(),
                    b["macro_type"].as_u64(),
                    b["loop_count"].as_u64(),
                ))
        });
        entries.push(json!({
            "id": id,
            "name": name,
            "steps": norm_steps,
            "bindings": norm_bindings,
        }));
    }
    Ok(MacrosValidated { entries, bindings })
}

/// Cross-check macro bindings against the keymap tag-3 values, both
/// directions (coverage doc §5.1: bindings and keymap must agree).
fn check_macro_bindings(
    banks: &[KeymapBank],
    bindings: &[(usize, u8, u8, u8, u8, u8)],
    macro_count: usize,
) -> Result<(), ConfigError> {
    // (layer, system, slot) -> u32
    let mut slots: BTreeMap<(u8, u8, usize), u32> = BTreeMap::new();
    for b in banks {
        for (i, &v) in b.values.iter().enumerate() {
            slots.insert((b.layer, b.system, i), v);
        }
    }
    // Every declared binding must match the keymap's tag-3 value.
    for &(id, layer, system, slot, mtype, loop_count) in bindings {
        let v = slots[&(layer, system, slot as usize)];
        match decode_key_value(v) {
            KeyValue::Macro {
                macro_type,
                number,
                index,
            } => {
                if macro_type != mtype || number != loop_count || index as usize != id {
                    return Err(ConfigError::invalid_document(format!(
                        "configuration.macros[{id}].bindings: keymap ({layer},{system},{slot}) holds \
                         macro({macro_type},{number},{index}) — binding declares ({mtype},{loop_count},{id})"
                    ))
                    .at(format!("configuration.macros[{id}].bindings")));
                }
            }
            other => {
                return Err(ConfigError::invalid_document(format!(
                    "configuration.macros[{id}].bindings: keymap ({layer},{system},{slot}) holds \
                     {other:?}, not a macro reference"
                ))
                .at(format!("configuration.macros[{id}].bindings")));
            }
        }
    }
    // Every tag-3 keymap value must be declared by exactly one binding.
    for (&(layer, system, slot), &v) in &slots {
        if let KeyValue::Macro {
            macro_type,
            number,
            index,
        } = decode_key_value(v)
        {
            let id = index as usize;
            if id >= macro_count {
                return Err(ConfigError::invalid_document(format!(
                    "keymap ({layer},{system},{slot}) references macro index {id} but only \
                     {macro_count} macros are declared"
                ))
                .at("configuration.keymap"));
            }
            let declared = bindings.iter().any(|&(bid, bl, bs, bk, bt, bn)| {
                bid == id
                    && bl == layer
                    && bs == system
                    && bk as usize == slot
                    && bt == macro_type
                    && bn == number
            });
            if !declared {
                return Err(ConfigError::invalid_document(format!(
                    "keymap ({layer},{system},{slot}) binds macro {id} ({macro_type},{number}) \
                     but no matching entry exists in configuration.macros[{id}].bindings"
                ))
                .at(format!("configuration.macros[{id}].bindings")));
            }
        }
    }
    Ok(())
}

/// Validate the `configuration` object of a khub916-k1pro document and
/// return its normalized form.
fn validate_k1pro_configuration(
    conf: &Map<String, Value>,
    warnings: &mut Vec<Value>,
) -> Result<Value, ConfigError> {
    let path = "configuration";
    only_keys(conf, path, &["keymap", "device", "lighting", "macros"])?;
    for section in ["keymap", "device", "lighting", "macros"] {
        if !conf.contains_key(section) {
            return Err(ConfigError::missing_required_field(path, section));
        }
    }
    let banks = validate_keymap(conf, warnings)?;
    let device = validate_device(conf)?;
    let lighting = validate_lighting(conf)?;

    // macros: validate entries + bindings, then cross-check vs keymap.
    let macros = validate_macros(conf, warnings)?;
    check_macro_bindings(&banks, &macros.bindings, macros.entries.len())?;

    // normalized keymap (banks already sorted by (system, layer))
    let layers_json: Vec<Value> = banks
        .iter()
        .map(|b| {
            json!({
                "layer": b.layer,
                "system": b.system,
                "keys": b.values.iter().map(|&v| format!("0x{v:08X}")).collect::<Vec<_>>(),
            })
        })
        .collect();

    Ok(json!({
        "keymap": {"layers": layers_json},
        "device": device,
        "lighting": lighting,
        "macros": macros.entries,
    }))
}

// ── Structural layer: the emitted JSON Schema is the source of truth ────
//
// `validate` runs in two layers (bead bda):
//
// 1. **Structural** — the raw document is validated against the JSON
//    Schema 2020-12 document emitted by [`schema::schema_doc`] for the
//    resolved `schema_id`, compiled with the `jsonschema` crate. This is
//    where shape/types/ranges/cardinalities/`additionalProperties:false`
//    live; the schema — not a parallel hand-rolled rule set — decides.
// 2. **Semantic** — the Rust checks below cover only what JSON Schema
//    cannot express: envelope target/firmware binding, macro↔keymap
//    tag-3 cross-checks, `(layer,system)` bank coverage/uniqueness,
//    mode-color group coverage, macro `id==position` contiguity, the
//    `kind:"other"`⇔`nibble` conditional, semantic key-action resolution,
//    and canonical normalization. A meta-test in `schema::tests` asserts
//    the constraints the validator relies on are present in the emitted
//    schema so the two layers cannot silently drift.

/// Convert a `jsonschema` location (`/a/b/0`) to our path style
/// (`a.b[0]`); the root maps to `(document)`.
fn schema_path(loc: &jsonschema::paths::Location) -> String {
    let s = loc.as_str();
    if s.is_empty() {
        return "(document)".to_string();
    }
    let mut out = String::new();
    for seg in s.split('/').filter(|p| !p.is_empty()) {
        if let Ok(idx) = seg.parse::<usize>() {
            out.push_str(&format!("[{idx}]"));
        } else {
            if !out.is_empty() {
                out.push('.');
            }
            out.push_str(seg);
        }
    }
    out
}

/// `anyOf`/`oneOf` failures hide their leaf errors in `context`; find an
/// `additionalProperties` leaf (e.g. an extra key inside a key-action
/// object) so it can keep the precise `unknown_property` code. Required-
/// style leaves stay generic — inside an `anyOf` "missing" is ambiguous.
fn additional_properties_in<'e>(
    err: &'e jsonschema::ValidationError<'_>,
) -> Option<&'e jsonschema::ValidationError<'static>> {
    use jsonschema::error::ValidationErrorKind as K;
    let context = match err.kind() {
        K::AnyOf { context } | K::OneOfNotValid { context } | K::OneOfMultipleValid { context } => {
            context
        }
        _ => return None,
    };
    for group in context {
        for e in group {
            match e.kind() {
                K::AdditionalProperties { .. } => return Some(e),
                K::AnyOf { .. } | K::OneOfNotValid { .. } | K::OneOfMultipleValid { .. } => {
                    if let Some(found) = additional_properties_in(e) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Map the first `jsonschema` error onto the stable §8 codes:
/// `required` → `missing_required_field`, `additionalProperties` →
/// `unknown_property`, everything else → `invalid_document`.
fn map_schema_error(err: &jsonschema::ValidationError<'_>) -> ConfigError {
    use jsonschema::error::ValidationErrorKind as K;
    let path = schema_path(err.instance_path());
    match err.kind() {
        K::Required { property } => {
            ConfigError::missing_required_field(path, property.as_str().unwrap_or("?"))
        }
        K::AdditionalProperties { unexpected } => ConfigError::unknown_property(
            path,
            unexpected.first().map(String::as_str).unwrap_or("?"),
        ),
        K::AnyOf { .. } | K::OneOfNotValid { .. } | K::OneOfMultipleValid { .. } => {
            if let Some(leaf) = additional_properties_in(err) {
                return map_schema_error(leaf);
            }
            ConfigError::invalid_document(format!("schema violation at {path}: {err}")).at(path)
        }
        _ => ConfigError::invalid_document(format!("schema violation at {path}: {err}")).at(path),
    }
}

/// STRUCTURAL layer: validate the raw document against the emitted schema
/// for `schema_id`. The schema is compiled per call — `validate` is a
/// one-shot CLI path, so no cache is warranted.
fn validate_structural(doc: &Value, schema_id: &str) -> Result<(), ConfigError> {
    let schema_doc = schema::schema_doc(schema_id, None)?;
    let validator = jsonschema::validator_for(&schema_doc).map_err(|e| {
        ConfigError::invalid_document(format!("internal: emitted schema does not compile: {e}"))
    })?;
    if let Some(err) = validator.iter_errors(doc).next() {
        return Err(map_schema_error(&err));
    }
    Ok(())
}

// ── Public entry point ─────────────────────────────────────────────────

/// Read and JSON-parse a config document file (`-` = stdin).
pub fn read_document(file: &str) -> Result<Value, ConfigError> {
    let text = if file == "-" {
        std::io::read_to_string(std::io::stdin())
            .map_err(|e| ConfigError::invalid_document(format!("cannot read stdin: {e}")))?
    } else {
        std::fs::read_to_string(file)
            .map_err(|e| ConfigError::invalid_document(format!("cannot read '{file}': {e}")))?
    };
    serde_json::from_str(&text)
        .map_err(|e| ConfigError::invalid_document(format!("JSON parse error: {e}")))
}

/// Validate a parsed document against the resolved target context.
/// Two layers (see the "Structural layer" section above): envelope +
/// target binding checks first (they own the `schema_version_unsupported`/
/// `target_mismatch`/`unsupported` codes), then the emitted JSON Schema
/// as the structural source of truth, then the semantic checks JSON
/// Schema cannot express plus canonical normalization.
pub fn validate(doc: &Value, ctx: &TargetContext) -> Result<Validated, ConfigError> {
    const ROOT: &str = "(document)";
    let root = as_obj(doc, ROOT)?;
    only_keys(
        root,
        ROOT,
        &["format_version", "schema_id", "target", "configuration"],
    )?;

    // Envelope: all four fields required.
    for f in ["format_version", "schema_id", "target", "configuration"] {
        req(root, ROOT, f)?;
    }
    let fv = as_int(req(root, ROOT, "format_version")?, "format_version")?;
    if fv != schema::FORMAT_VERSION {
        return Err(ConfigError::schema_version_unsupported(format!(
            "format_version {fv} is not supported (want {})",
            schema::FORMAT_VERSION
        )));
    }
    let sid = as_str(req(root, ROOT, "schema_id")?, "schema_id")?;
    if sid != ctx.schema_id {
        return Err(ConfigError::schema_version_unsupported(format!(
            "schema_id {sid:?} does not match the resolved schema {:?}",
            ctx.schema_id
        )));
    }

    // Target binding.
    let tpath = "target";
    let t = as_obj(req(root, ROOT, "target")?, tpath)?;
    only_keys(t, tpath, &["device_kind", "model", "firmware"])?;
    for f in ["device_kind", "model", "firmware"] {
        req(t, tpath, f)?;
    }
    let dk = as_str(
        req(t, tpath, "device_kind")?,
        &format!("{tpath}.device_kind"),
    )?;
    if dk != ctx.device_kind {
        return Err(ConfigError::target_mismatch(
            "device_kind",
            &ctx.device_kind,
            dk,
        ));
    }
    let model = as_str(req(t, tpath, "model")?, &format!("{tpath}.model"))?;
    if let Some(expected) = &ctx.model {
        if model != expected {
            return Err(ConfigError::target_mismatch("model", expected, model));
        }
    }
    let fw = as_str(req(t, tpath, "firmware")?, &format!("{tpath}.firmware"))?;
    if let Some(expected) = &ctx.firmware {
        if fw != expected {
            return Err(ConfigError::target_mismatch("firmware", expected, fw));
        }
    }

    // Writable gate: gated families have no managed writable surface.
    if !schema::is_writable(&ctx.schema_id) {
        return Err(ConfigError::unsupported(format!(
            "schema '{}' has no writable configuration surface in this release \
             (declared fields are code-tested/read-only — see `omg schema --device {}`)",
            ctx.schema_id, ctx.device_kind
        )));
    }

    // STRUCTURAL layer: the emitted JSON Schema decides shape/types/
    // ranges/cardinalities/additionalProperties (see module docs). Runs
    // after the envelope checks above so `schema_version_unsupported` /
    // `target_mismatch` / `unsupported` keep their specific codes.
    validate_structural(doc, &ctx.schema_id)?;

    // SEMANTIC layer: deep validation of configuration — the checks JSON
    // Schema cannot express plus canonical normalization.
    let conf = as_obj(req(root, ROOT, "configuration")?, "configuration")?;
    let mut warnings = Vec::new();
    let configuration = if ctx.schema_id == schema::KHUB916_K1PRO {
        validate_k1pro_configuration(conf, &mut warnings)?
    } else {
        return Err(ConfigError::unsupported(format!(
            "no validator for schema '{}'",
            ctx.schema_id
        )));
    };

    let doc_out = json!({
        "format_version": schema::FORMAT_VERSION,
        "schema_id": ctx.schema_id,
        "target": {
            "device_kind": ctx.device_kind,
            "model": model,
            "firmware": fw,
        },
        "configuration": configuration,
    });
    Ok(Validated {
        doc: doc_out,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TargetContext {
        TargetContext {
            schema_id: schema::KHUB916_K1PRO.into(),
            device_kind: "khub916_wired".into(),
            model: Some("916_K1_PRO".into()),
            firmware: Some("0x0100".into()),
        }
    }

    /// Build a minimal *valid* full document programmatically.
    fn valid_doc() -> Value {
        let banks: Vec<Value> = (0..8u8)
            .map(|arg| {
                let layer = arg & 3;
                let system = arg >> 2;
                json!({
                    "layer": layer,
                    "system": system,
                    "keys": vec![json!("0x00000000"); K1PRO_KEYS],
                })
            })
            .collect();
        json!({
            "format_version": 1,
            "schema_id": schema::KHUB916_K1PRO,
            "target": {"device_kind": "khub916_wired", "model": "916_K1_PRO", "firmware": "0x0100"},
            "configuration": {
                "keymap": {"layers": banks},
                "device": {"sleep_timeout_seconds": 30},
                "lighting": {
                    "effect": {"mode": 15, "speed": 4, "brightness": 10, "color_model": "mixing"},
                    "mode_colors": (0..K1PRO_MODE_COLORS).map(|m| json!({"mode": m, "color": "#3366ff"})).collect::<Vec<_>>(),
                    "per_key": {"mode": "explicit", "colors": vec![json!("#ff0000"); K1PRO_KEYS]},
                },
                "macros": [],
            },
        })
    }

    #[test]
    fn valid_document_passes() {
        let v = validate(&valid_doc(), &ctx()).unwrap();
        assert_eq!(v.doc["schema_id"], schema::KHUB916_K1PRO);
        assert_eq!(
            v.doc["configuration"]["keymap"]["layers"]
                .as_array()
                .unwrap()
                .len(),
            8
        );
        assert!(v.warnings.is_empty());
    }

    #[test]
    fn rejects_every_bad_envelope() {
        let c = ctx();
        // unknown top-level prop
        let mut d = valid_doc();
        d["extra"] = json!(1);
        assert_eq!(validate(&d, &c).unwrap_err().code, "unknown_property");
        // missing field
        let mut d = valid_doc();
        d.as_object_mut().unwrap().remove("configuration");
        assert_eq!(validate(&d, &c).unwrap_err().code, "missing_required_field");
        // bad format_version
        let mut d = valid_doc();
        d["format_version"] = json!(2);
        assert_eq!(
            validate(&d, &c).unwrap_err().code,
            "schema_version_unsupported"
        );
        // wrong schema_id
        let mut d = valid_doc();
        d["schema_id"] = json!("khub916-k1");
        assert_eq!(
            validate(&d, &c).unwrap_err().code,
            "schema_version_unsupported"
        );
        // target mismatches
        let mut d = valid_doc();
        d["target"]["model"] = json!("916_K1");
        assert_eq!(validate(&d, &c).unwrap_err().code, "target_mismatch");
        let mut d = valid_doc();
        d["target"]["firmware"] = json!("0x0200");
        assert_eq!(validate(&d, &c).unwrap_err().code, "target_mismatch");
        let mut d = valid_doc();
        d["target"]["device_kind"] = json!("compx_mouse");
        assert_eq!(validate(&d, &c).unwrap_err().code, "target_mismatch");
        // gated family
        let gated = TargetContext {
            schema_id: schema::HE_V2_KEYBOARD.into(),
            device_kind: "he_keyboard_v2".into(),
            model: None,
            firmware: None,
        };
        let mut d = valid_doc();
        d["schema_id"] = json!(schema::HE_V2_KEYBOARD);
        d["target"]["device_kind"] = json!("he_keyboard_v2");
        d.as_object_mut().unwrap().remove("target");
        d["target"] = json!({"device_kind":"he_keyboard_v2","model":"x","firmware":"y"});
        assert_eq!(validate(&d, &gated).unwrap_err().code, "unsupported");
    }

    #[test]
    fn rejects_configuration_violations() {
        let c = ctx();
        // missing managed section
        let mut d = valid_doc();
        d["configuration"].as_object_mut().unwrap().remove("macros");
        assert_eq!(validate(&d, &c).unwrap_err().code, "missing_required_field");
        // unknown property inside configuration
        let mut d = valid_doc();
        d["configuration"]["bogus"] = json!(true);
        assert_eq!(validate(&d, &c).unwrap_err().code, "unknown_property");
        // short keys array
        let mut d = valid_doc();
        d["configuration"]["keymap"]["layers"][0]["keys"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // duplicate bank
        let mut d = valid_doc();
        let l1 = d["configuration"]["keymap"]["layers"][1].clone();
        d["configuration"]["keymap"]["layers"][1] =
            d["configuration"]["keymap"]["layers"][0].clone();
        let _ = l1;
        assert!(validate(&d, &c).is_err());
        // bad key hex
        let mut d = valid_doc();
        d["configuration"]["keymap"]["layers"][0]["keys"][0] = json!("0xZZ");
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // missing bank entirely (7 layers)
        let mut d = valid_doc();
        d["configuration"]["keymap"]["layers"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // sleep out of range
        let mut d = valid_doc();
        d["configuration"]["device"]["sleep_timeout_seconds"] = json!(300);
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // bad light mode
        let mut d = valid_doc();
        d["configuration"]["lighting"]["effect"]["mode"] = json!(99);
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // per_key wrong count
        let mut d = valid_doc();
        d["configuration"]["lighting"]["per_key"]["colors"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // bad colour
        let mut d = valid_doc();
        d["configuration"]["lighting"]["per_key"]["colors"][0] = json!("red");
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
    }

    #[test]
    fn macro_bindings_must_match_keymap() {
        let c = ctx();
        // Macro 0 bound at layer0/system0/slot10 via tag-3 value
        // 0x03 01 01 00 → type=1, num=1, index=0.
        let mut d = valid_doc();
        d["configuration"]["keymap"]["layers"][0]["keys"][10] = json!("0x03010100");
        d["configuration"]["macros"] = json!([{
            "id": 0,
            "name": "m",
            "steps": [{"action":"down","delay_ms":8,"key":"KeyA"},{"action":"up","delay_ms":0,"key":"KeyA"}],
            "bindings": [{"layer":0,"system":0,"key_index":10,"macro_type":1,"loop_count":1}],
        }]);
        let v = validate(&d, &c).unwrap();
        assert_eq!(
            v.doc["configuration"]["macros"][0]["steps"][0]["key"],
            "KeyA"
        );

        // Missing binding → error.
        let mut d2 = d.clone();
        d2["configuration"]["macros"][0]["bindings"] = json!([]);
        assert_eq!(validate(&d2, &c).unwrap_err().code, "invalid_document");

        // Wrong binding fields → error.
        let mut d3 = d.clone();
        d3["configuration"]["macros"][0]["bindings"][0]["loop_count"] = json!(2);
        assert_eq!(validate(&d3, &c).unwrap_err().code, "invalid_document");

        // Binding pointing at a non-macro key → error.
        let mut d4 = valid_doc();
        d4["configuration"]["macros"] = json!([{
            "id": 0, "name": "m", "steps": [],
            "bindings": [{"layer":0,"system":0,"key_index":10,"macro_type":1,"loop_count":1}],
        }]);
        assert_eq!(validate(&d4, &c).unwrap_err().code, "invalid_document");

        // Keymap references a macro index beyond declared count → error.
        let mut d5 = valid_doc();
        d5["configuration"]["keymap"]["layers"][0]["keys"][10] = json!("0x03010500");
        d5["configuration"]["macros"] = json!([{
            "id": 0, "name": "m", "steps": [], "bindings": [],
        }]);
        assert_eq!(validate(&d5, &c).unwrap_err().code, "invalid_document");
    }

    #[test]
    fn opaque_values_warn_not_fail() {
        let mut d = valid_doc();
        // tag 0x08-style unknown value and a Socd tag.
        d["configuration"]["keymap"]["layers"][0]["keys"][0] = json!("0x08020000");
        d["configuration"]["keymap"]["layers"][0]["keys"][1] = json!("0x20112233");
        let v = validate(&d, &ctx()).unwrap();
        assert_eq!(v.warnings.len(), 1);
        assert_eq!(v.warnings[0]["kind"], "opaque_key_values");
        assert_eq!(v.warnings[0]["count"], 2);
        // Normalized doc preserves the raw value byte-identical.
        assert_eq!(
            v.doc["configuration"]["keymap"]["layers"][0]["keys"][0],
            "0x08020000"
        );
    }

    // ── Semantic key actions (bead 112) ────────────────────────────────

    /// Slot helper: bank index → (layer, system) is arg order; banks[0] is
    /// (layer 0, system 0).
    fn key_at(doc: &mut Value, bank: usize, slot: usize) -> &mut Value {
        &mut doc["configuration"]["keymap"]["layers"][bank]["keys"][slot]
    }

    #[test]
    fn semantic_keys_resolve_to_hex() {
        let mut d = valid_doc();
        *key_at(&mut d, 0, 0) = json!({"key": "KeyA"});
        *key_at(&mut d, 0, 1) = json!({"key": "a"}); // alias
        *key_at(&mut d, 0, 2) = json!({"key": "Enter", "modifiers": ["shift"]});
        *key_at(&mut d, 0, 3) = json!({"key": "LCtrl"});
        *key_at(&mut d, 0, 4) = json!({"modifiers": ["ctrl", "shift"]});
        *key_at(&mut d, 0, 5) = json!({"key": "Fn1"});
        *key_at(&mut d, 0, 6) = json!("0x00000029"); // hex still fine
        let v = validate(&d, &ctx()).unwrap();
        let keys = &v.doc["configuration"]["keymap"]["layers"][0]["keys"];
        assert_eq!(keys[0], "0x00000004"); // KeyA
        assert_eq!(keys[1], "0x00000004"); // "a"
        assert_eq!(keys[2], "0x00020028"); // Shift+Enter
        assert_eq!(keys[3], "0x00010000"); // bare Ctrl (usage 0 + bit)
        assert_eq!(keys[4], "0x00030000"); // Ctrl+Shift chord
        assert_eq!(keys[5], "0x0D010000"); // Fn1
        assert_eq!(keys[6], "0x00000029"); // hex passthrough, normalized case
                                           // No opaque warnings for plain tag-0/Fn values.
        assert!(v.warnings.is_empty());
        // The normalized document re-validates (config get → validate
        // round-trip stability for diff).
        validate(&v.doc, &ctx()).unwrap();
    }

    #[test]
    fn semantic_key_rejections() {
        let c = ctx();
        // Unknown key name → invalid_document at the slot path.
        let mut d = valid_doc();
        *key_at(&mut d, 0, 5) = json!({"key": "HyperDrive"});
        let e = validate(&d, &c).unwrap_err();
        assert_eq!(e.code, "invalid_document");
        assert_eq!(
            e.path.as_deref(),
            Some("configuration.keymap.layers[0].keys[5].key")
        );
        assert!(e.details["valid_names"].is_array());
        // Unknown modifier.
        let mut d = valid_doc();
        *key_at(&mut d, 0, 5) = json!({"key": "KeyA", "modifiers": ["hyper"]});
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // Modifier key + extra modifiers.
        let mut d = valid_doc();
        *key_at(&mut d, 0, 5) = json!({"key": "LCtrl", "modifiers": ["shift"]});
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // Structural rejections via the schema (anyOf/object shape).
        let mut d = valid_doc();
        *key_at(&mut d, 0, 5) = json!({});
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        let mut d = valid_doc();
        *key_at(&mut d, 0, 5) = json!({"key": "KeyA", "bogus": 1});
        assert_eq!(validate(&d, &c).unwrap_err().code, "unknown_property");
        let mut d = valid_doc();
        *key_at(&mut d, 0, 5) = json!(42);
        assert_eq!(validate(&d, &c).unwrap_err().code, "invalid_document");
        // Unencodable actions are not silently mis-encoded.
        for bad in ["Macro1", "TapHold", "SOCD", "MouseLeft", "MediaPlay"] {
            let mut d = valid_doc();
            *key_at(&mut d, 0, 5) = json!({"key": bad});
            assert_eq!(
                validate(&d, &c).unwrap_err().code,
                "invalid_document",
                "{bad} must be rejected"
            );
        }
    }

    #[test]
    fn semantic_keys_in_other_banks() {
        // Every bank accepts the object form, not just bank 0.
        let mut d = valid_doc();
        for bank in 0..8usize {
            *key_at(&mut d, bank, bank) = json!({"key": "F5"});
        }
        let v = validate(&d, &ctx()).unwrap();
        for bank in 0..8usize {
            assert_eq!(
                v.doc["configuration"]["keymap"]["layers"][bank]["keys"][bank],
                "0x0000003E" // F5 = HID 0x3E
            );
        }
    }
}
