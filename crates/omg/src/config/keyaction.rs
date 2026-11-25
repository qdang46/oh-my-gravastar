//! Semantic key actions for `keymap.layers[].keys[]` (bead 112).
//!
//! A key slot accepts either the canonical raw form — a `"0x........"`
//! u32 hex string — or a semantic object:
//!
//! ```json
//! {"key": "KeyA"}
//! {"key": "Enter", "modifiers": ["shift"]}
//! {"key": "LCtrl"}
//! {"modifiers": ["ctrl", "shift"]}
//! {"key": "None", "modifiers": ["alt"]}
//! {"key": "Fn1"}
//! ```
//!
//! Resolution happens here in the semantic layer (after JSON-Schema
//! structural validation) and produces the same u32 the firmware stores;
//! normalized output is always `0x%08X` hex, so `config get`/`diff` are
//! unchanged.
//!
//! # Encoding (docs/protocol-khub916.md §6, tag = bits 31..24)
//!
//! - tag `0x00` normal: `(modifier_bits << 16) | HID_usage` — bit16 Ctrl,
//!   bit17 Shift, bit18 Alt, bit19 GUI. Bare modifier keys are encoded as
//!   usage `0` with the modifier bit set (live-observed convention, see
//!   `decode_key_value`'s label path).
//! - tag `0x0D` Fn layer: `0x0D000000 | layer << 16` (`Fn`/`Fn1`..`Fn3`).
//!
//! # What the u32 encoding CANNOT express (write raw hex instead)
//!
//! - Macro references (tag `0x03`) — bind via `configuration.macros[].bindings`.
//! - Secondary-layer keys (tag `0x07`), SOCD/MT/TGL advanced keys
//!   (tags `0x20`–`0x22`), tag `0x08` firmware Fn-layer actions, and any
//!   other unknown tag — all opaque per AGENTS.md §Safety 7.
//! - Tap-hold / one-shot / layer-switch actions — no such tag exists.
//! - Two-key combos (`setKeyboardComboKey` special values) — vendor
//!   semantics only approximately documented.
//! - Sided modifiers in combos: the encoding has ONE bit per modifier
//!   class, so `LCtrl` and `RCtrl` encode identically. Likewise a modifier
//!   used as `key` cannot take additional `modifiers` (use `"key":"None"`
//!   plus the full modifier list for a bare chord).
//! - Media/consumer keys and mouse buttons — different usage pages; the
//!   keymap `usage` field is HID keyboard page 0 only.

use serde_json::{json, Map, Value};

use crate::config::error::ConfigError;

// ── Modifier bits (docs/protocol-khub916.md §6) ────────────────────────

const MOD_CTRL: u32 = 0x0001_0000;
const MOD_SHIFT: u32 = 0x0002_0000;
const MOD_ALT: u32 = 0x0004_0000;
const MOD_GUI: u32 = 0x0008_0000;

/// Canonical modifier names accepted in `modifiers` (and as `key`).
/// Sided `L*`/`R*` variants and `control`/`win`/`meta` aliases collapse to
/// the same bit — the encoding has no sidedness.
pub const MODIFIER_NAMES: &[&str] = &[
    "ctrl", "control", "lctrl", "rctrl",
    "shift", "lshift", "rshift",
    "alt", "lalt", "ralt",
    "gui", "win", "meta", "lgui", "rgui", "lwin", "rwin",
];

/// `(name, HID keyboard-page usage)` for named keys. Aliases are grouped;
/// generated families (a-z, 0-9, keyx, digitx, f1-f24, fn0-fn3) live in
/// [`base_usage`]/[`fn_layer`]. HID usage ids per USB HID Usage Tables
/// page 0x07 — cross-checked against `macro916::MACRO_KEY_TABLE`.
const NAMED_KEYS: &[(&[&str], u16)] = &[
    (&["esc", "escape"], 0x29),
    (&["enter", "return"], 0x28),
    (&["tab"], 0x2B),
    (&["space", "spacebar"], 0x2C),
    (&["backspace"], 0x2A),
    (&["delete", "del"], 0x4C),
    (&["insert", "ins"], 0x49),
    (&["home"], 0x4A),
    (&["end"], 0x4D),
    (&["pageup", "pgup"], 0x4B),
    (&["pagedown", "pgdn"], 0x4E),
    (&["capslock", "caps"], 0x39),
    (&["numlock"], 0x53),
    (&["scrolllock"], 0x47),
    (&["pause", "break"], 0x48),
    (&["printscreen", "prtsc", "print"], 0x46),
    (&["menu", "contextmenu", "app", "application"], 0x65),
    (&["arrowup", "up"], 0x52),
    (&["arrowdown", "down"], 0x51),
    (&["arrowleft", "left"], 0x50),
    (&["arrowright", "right"], 0x4F),
    // US-layout punctuation (HID usage ids; layouts differ on device).
    (&["backquote", "grave", "`"], 0x35),
    (&["minus", "-"], 0x2D),
    (&["equal", "equals", "="], 0x2E),
    (&["bracketleft", "["], 0x2F),
    (&["bracketright", "]"], 0x30),
    (&["backslash", "\\"], 0x31),
    (&["semicolon", ";"], 0x33),
    (&["quote", "'"], 0x34),
    (&["comma", ","], 0x36),
    (&["period", "."], 0x37),
    (&["slash", "/"], 0x38),
    // Numpad (HID 0x54..0x63).
    (&["numpaddivide"], 0x54),
    (&["numpadmultiply"], 0x55),
    (&["numpadsubtract"], 0x56),
    (&["numpadadd"], 0x57),
    (&["numpadenter"], 0x58),
    (&["numpad1"], 0x59),
    (&["numpad2"], 0x5A),
    (&["numpad3"], 0x5B),
    (&["numpad4"], 0x5C),
    (&["numpad5"], 0x5D),
    (&["numpad6"], 0x5E),
    (&["numpad7"], 0x5F),
    (&["numpad8"], 0x60),
    (&["numpad9"], 0x61),
    (&["numpad0"], 0x62),
    (&["numpaddecimal"], 0x63),
];

/// Flat list of every accepted `key`/`modifiers` name, for error details.
/// Generated families are represented by their range descriptors.
pub fn valid_names() -> Vec<String> {
    let mut v: Vec<String> = NAMED_KEYS
        .iter()
        .flat_map(|(names, _)| names.iter().map(|n| n.to_string()))
        .collect();
    v.extend([
        "a-z (or keya-keyz)",
        "0-9 (or digit0-digit9)",
        "f1-f24",
        "fn, fn0-fn3",
        "none",
    ]
    .iter()
    .map(|s| s.to_string()));
    v.extend(MODIFIER_NAMES.iter().map(|s| s.to_string()));
    v
}

/// Modifier name → pre-shifted u32 bit. `None` = not a modifier.
fn modifier_bit(name: &str) -> Option<u32> {
    Some(match name {
        "ctrl" | "control" | "lctrl" | "rctrl" => MOD_CTRL,
        "shift" | "lshift" | "rshift" => MOD_SHIFT,
        "alt" | "lalt" | "ralt" => MOD_ALT,
        "gui" | "win" | "meta" | "lgui" | "rgui" | "lwin" | "rwin" => MOD_GUI,
        _ => return None,
    })
}

/// Fn-layer tag-`0x0D` value: `fn`/`fn0`..`fn3` (the K1 Pro has 4 layers).
fn fn_layer(name: &str) -> Option<u32> {
    let layer = if name == "fn" {
        0u8
    } else {
        name.strip_prefix("fn")?.parse::<u8>().ok()?
    };
    if layer > 3 {
        return None;
    }
    Some(0x0D00_0000 | (u32::from(layer) << 16))
}

/// HID keyboard-page usage for a `key` name, or `None` when unknown.
/// Case-insensitive; callers pass an already-lowercased name.
fn base_usage(name: &str) -> Option<u16> {
    let b = name.as_bytes();
    if b.len() == 1 {
        match b[0] {
            c @ b'a'..=b'z' => return Some(0x04 + u16::from(c - b'a')),
            c @ b'0'..=b'9' => {
                return Some(if c == b'0' {
                    0x27
                } else {
                    // HID: '1'..='9' = 0x1E..=0x26, '0' = 0x27.
                    0x1D + u16::from(c - b'0')
                })
            }
            // single-char punctuation ("-", "=", …) falls through to NAMED_KEYS
            _ => {}
        }
    }
    // KeyboardEvent.code style: keya..keyz, digit0..digit9.
    if let Some(rest) = name.strip_prefix("key") {
        if rest.len() == 1 {
            let c = rest.as_bytes()[0];
            if c.is_ascii_lowercase() {
                return Some(0x04 + u16::from(c - b'a'));
            }
        }
        return None;
    }
    if let Some(rest) = name.strip_prefix("digit") {
        if rest.len() == 1 {
            let c = rest.as_bytes()[0];
            if c.is_ascii_digit() {
                return Some(if c == b'0' {
                    0x27
                } else {
                    0x1D + u16::from(c - b'0')
                });
            }
        }
        return None;
    }
    // f1..f12 = 0x3A..0x45; f13..f24 = 0x68..0x73 (not contiguous).
    if let Some(rest) = name.strip_prefix('f') {
        if let Ok(n) = rest.parse::<u16>() {
            return match n {
                1..=12 => Some(0x39 + n),
                13..=24 => Some(0x5B + n),
                _ => None,
            };
        }
    }
    NAMED_KEYS
        .iter()
        .find(|(names, _)| names.contains(&name))
        .map(|(_, usage)| *usage)
}

// ── Resolution ─────────────────────────────────────────────────────────

/// Raw `"0x........"` u32 keymap value (either `0x`/`0X` case) — the
/// canonical authored form. Returns the value.
fn parse_key_hex(s: &str, path: &str) -> Result<u32, ConfigError> {
    let hex = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .ok_or_else(|| {
            ConfigError::invalid_document(format!(
                "{path} must be a 0x-prefixed u32 hex string, got {s:?}"
            ))
            .at(path)
        })?;
    if hex.len() != 8 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ConfigError::invalid_document(format!(
            "{path} must be 0x + 8 hex digits, got {s:?}"
        ))
        .at(path));
    }
    u32::from_str_radix(hex, 16)
        .map_err(|_| ConfigError::invalid_document(format!("{path}: bad hex {s:?}")).at(path))
}

fn unknown_key(name: &str, path: &str) -> ConfigError {
    ConfigError::invalid_document(format!(
        "{path}: unknown key action '{name}' — accepted names: a-z/0-9, keya-keyz, \
         digit0-digit9, f1-f24, named keys (Enter, Esc, Tab, Space, Backspace, Delete, \
         arrows, …), numpad keys, fn/fn0-fn3, 'None', and modifiers \
         (ctrl/shift/alt/gui + L/R variants). Actions the u32 encoding cannot express \
         (macro refs, SOCD/MT/TGL, secondary-layer, tag-8 Fn actions, tap-hold, \
         two-key combos, media/mouse keys) must be written as raw 0x hex — \
         see `omg schema --device khub916-k1pro --section keymap`"
    ))
    .at(format!("{path}.key"))
    .with_details(json!({
        "valid_names": valid_names(),
        "valid_modifiers": MODIFIER_NAMES,
    }))
}

/// Resolve one `keys[]` item — `"0x........"` hex or a semantic object —
/// to the u32 keymap value.
pub fn resolve_key_item(v: &Value, path: &str) -> Result<u32, ConfigError> {
    match v {
        Value::String(s) => parse_key_hex(s, path),
        Value::Object(o) => resolve_action_object(o, path),
        _ => Err(ConfigError::invalid_document(format!(
            "{path} must be a 0x-prefixed u32 hex string or a key-action object \
             ({{\"key\": ..., \"modifiers\": [...]}})"
        ))
        .at(path)),
    }
}

/// `{"key": name?, "modifiers": [name…]?}` → `(mods << 16) | usage`, or a
/// tag-`0x0D` Fn value. At least one of `key`/`modifiers` is required
/// (enforced structurally by the schema's `anyOf` as well).
fn resolve_action_object(o: &Map<String, Value>, path: &str) -> Result<u32, ConfigError> {
    for k in o.keys() {
        if k != "key" && k != "modifiers" {
            return Err(ConfigError::unknown_property(path, k));
        }
    }
    if !o.contains_key("key") && !o.contains_key("modifiers") {
        return Err(ConfigError::invalid_document(format!(
            "{path} must contain 'key' and/or 'modifiers'"
        ))
        .at(path));
    }

    // modifiers → pre-shifted bits.
    let mut bits = 0u32;
    if let Some(mv) = o.get("modifiers") {
        let arr = mv.as_array().ok_or_else(|| {
            ConfigError::invalid_document(format!("{path}.modifiers must be an array")).at(path)
        })?;
        for (i, m) in arr.iter().enumerate() {
            let mp = format!("{path}.modifiers[{i}]");
            let s = m.as_str().ok_or_else(|| {
                ConfigError::invalid_document(format!("{mp} must be a string")).at(&mp)
            })?;
            let bit = modifier_bit(&s.to_ascii_lowercase()).ok_or_else(|| {
                ConfigError::invalid_document(format!(
                    "{mp}: unknown modifier '{s}' — valid: {}",
                    MODIFIER_NAMES.join(", ")
                ))
                .at(&mp)
            })?;
            bits |= bit;
        }
    }

    let Some(kv) = o.get("key") else {
        // Bare modifier chord, e.g. {"modifiers":["ctrl","shift"]}.
        if bits == 0 {
            return Err(ConfigError::invalid_document(format!(
                "{path}: 'modifiers' is empty and no 'key' given — nothing to encode"
            ))
            .at(path));
        }
        return Ok(bits);
    };

    let kp = format!("{path}.key");
    let name = kv.as_str().ok_or_else(|| {
        ConfigError::invalid_document(format!("{kp} must be a string")).at(&kp)
    })?;
    let lname = name.trim().to_ascii_lowercase();

    // A modifier used as the key itself → usage 0 + its bit (the
    // firmware's bare-modifier encoding). It cannot take extra modifiers.
    if let Some(bit) = modifier_bit(&lname) {
        if bits != 0 {
            return Err(ConfigError::invalid_document(format!(
                "{kp}: '{name}' is itself a modifier — for a modifier chord use \
                 {{\"key\": \"None\", \"modifiers\": [...]}}"
            ))
            .at(&kp));
        }
        return Ok(bit);
    }
    // "None"/"" = no base key: bare chord (or Empty when no modifiers).
    if lname == "none" || lname.is_empty() {
        return Ok(bits);
    }
    // Fn layer keys (tag 0x0D) — modifiers make no sense on them.
    if lname == "fn" || lname.starts_with("fn") && lname[2..].chars().all(|c| c.is_ascii_digit()) {
        if bits != 0 {
            return Err(ConfigError::invalid_document(format!(
                "{kp}: Fn layer keys cannot take modifiers"
            ))
            .at(&kp));
        }
        return fn_layer(&lname).ok_or_else(|| unknown_key(name, path));
    }
    let usage = base_usage(&lname).ok_or_else(|| unknown_key(name, path))?;
    Ok(bits | u32::from(usage))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolve(v: Value) -> Result<u32, ConfigError> {
        resolve_key_item(&v, "configuration.keymap.layers[0].keys[5]")
    }

    #[test]
    fn hex_strings_still_work() {
        assert_eq!(resolve(json!("0x00000004")).unwrap(), 0x0000_0004);
        assert_eq!(resolve(json!("0XDEADBEEF")).unwrap(), 0xDEAD_BEEF);
        assert_eq!(resolve(json!("0x08020000")).unwrap(), 0x0802_0000);
        assert!(resolve(json!("0xZZ")).is_err());
        assert!(resolve(json!("zz")).is_err());
        assert!(resolve(json!(123)).is_err());
    }

    #[test]
    fn plain_and_named_keys() {
        assert_eq!(resolve(json!({"key":"KeyA"})).unwrap(), 0x04);
        assert_eq!(resolve(json!({"key":"a"})).unwrap(), 0x04);
        assert_eq!(resolve(json!({"key":"KEYZ"})).unwrap(), 0x1D);
        assert_eq!(resolve(json!({"key":"digit1"})).unwrap(), 0x1E);
        assert_eq!(resolve(json!({"key":"1"})).unwrap(), 0x1E);
        assert_eq!(resolve(json!({"key":"0"})).unwrap(), 0x27);
        assert_eq!(resolve(json!({"key":"Enter"})).unwrap(), 0x28);
        assert_eq!(resolve(json!({"key":"Esc"})).unwrap(), 0x29);
        assert_eq!(resolve(json!({"key":"Space"})).unwrap(), 0x2C);
        assert_eq!(resolve(json!({"key":"Backspace"})).unwrap(), 0x2A);
        assert_eq!(resolve(json!({"key":"Delete"})).unwrap(), 0x4C);
        assert_eq!(resolve(json!({"key":"ArrowLeft"})).unwrap(), 0x50);
        assert_eq!(resolve(json!({"key":"ArrowRight"})).unwrap(), 0x4F);
        assert_eq!(resolve(json!({"key":"F1"})).unwrap(), 0x3A);
        assert_eq!(resolve(json!({"key":"F12"})).unwrap(), 0x45);
        assert_eq!(resolve(json!({"key":"F13"})).unwrap(), 0x68);
        assert_eq!(resolve(json!({"key":"F24"})).unwrap(), 0x73);
        assert_eq!(resolve(json!({"key":"-"})).unwrap(), 0x2D);
        assert_eq!(resolve(json!({"key":"NumpadEnter"})).unwrap(), 0x58);
    }

    #[test]
    fn modifiers_and_combos() {
        // Bare modifier → usage 0 + bit (firmware convention).
        assert_eq!(resolve(json!({"key":"LCtrl"})).unwrap(), MOD_CTRL);
        assert_eq!(resolve(json!({"key":"RShift"})).unwrap(), MOD_SHIFT);
        assert_eq!(resolve(json!({"key":"LGui"})).unwrap(), MOD_GUI);
        // Modifier combo on a key.
        assert_eq!(
            resolve(json!({"key":"Enter","modifiers":["shift"]})).unwrap(),
            MOD_SHIFT | 0x28
        );
        assert_eq!(
            resolve(json!({"key":"KeyA","modifiers":["ctrl","alt","gui"]})).unwrap(),
            MOD_CTRL | MOD_ALT | MOD_GUI | 0x04
        );
        // Bare chord without a base key.
        assert_eq!(
            resolve(json!({"modifiers":["ctrl","shift"]})).unwrap(),
            MOD_CTRL | MOD_SHIFT
        );
        assert_eq!(
            resolve(json!({"key":"None","modifiers":["alt"]})).unwrap(),
            MOD_ALT
        );
        assert_eq!(resolve(json!({"key":"None"})).unwrap(), 0);
    }

    #[test]
    fn fn_layers() {
        assert_eq!(resolve(json!({"key":"Fn"})).unwrap(), 0x0D00_0000);
        assert_eq!(resolve(json!({"key":"Fn1"})).unwrap(), 0x0D01_0000);
        assert_eq!(resolve(json!({"key":"fn3"})).unwrap(), 0x0D03_0000);
        assert!(resolve(json!({"key":"Fn4"})).is_err());
        assert!(resolve(json!({"key":"Fn","modifiers":["shift"]})).is_err());
    }

    #[test]
    fn rejections() {
        let c = ctx_path();
        // Unknown key name → invalid_document with path + valid list.
        let e = resolve(json!({"key":"HyperDrive"})).unwrap_err();
        assert_eq!(e.code, "invalid_document");
        assert_eq!(e.path.as_deref(), Some(c));
        assert!(e.details["valid_names"].is_array());
        // Unknown modifier.
        assert_eq!(
            resolve(json!({"key":"KeyA","modifiers":["hyper"]})).unwrap_err().code,
            "invalid_document"
        );
        // Modifier key + extra modifiers.
        assert!(resolve(json!({"key":"LCtrl","modifiers":["shift"]})).is_err());
        // Empty object / empty modifiers.
        assert!(resolve(json!({})).is_err());
        assert!(resolve(json!({"modifiers":[]})).is_err());
        // Non-string key / non-array modifiers / extra property.
        assert!(resolve(json!({"key":4})).is_err());
        assert!(resolve(json!({"key":"KeyA","modifiers":"shift"})).is_err());
        let e = resolve(json!({"key":"KeyA","bogus":1})).unwrap_err();
        assert_eq!(e.code, "unknown_property");
        // Things the encoding cannot express must not silently mis-encode:
        // they are simply unknown names (documented → raw hex).
        for bad in ["Macro1", "TapHold", "SOCD", "Layer2", "MouseLeft", "MediaPlay"] {
            assert!(resolve(json!({"key":bad})).is_err(), "{bad} should not encode");
        }
    }

    fn ctx_path() -> &'static str {
        "configuration.keymap.layers[0].keys[5].key"
    }
}
