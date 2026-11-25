//! Device configuration schema registry (spec §4/§5, coverage doc §4/§5).
//!
//! Emits JSON Schema draft 2020-12 documents for the versioned desired-state
//! envelope `{format_version, schema_id, target, configuration}`. Runtime
//! metadata the JSON Schema vocabulary cannot express lives in `x-omg`
//! annotations on each property: `readable`, `writable`, `support_state`,
//! `verification`, `risk_class`, `persistent`, `reversible`, `readback`,
//! `limits`, `description`.
//!
//! Families:
//!
//! - `khub916-k1pro` — the only **writable** schema. Live-verified on the
//!   K1 Pro (wired khub916): keymap (4 layers × 2 systems × 126 keys),
//!   sleep timeout, lighting effect/mode-colors/per-key, macros.
//! - `he-v2-keyboard`, `compx-mouse` — declared from the coverage matrix
//!   but **not writable**: code-tested only, hardware-unverified, so
//!   `config validate`/`diff`/`apply` reject them (`unsupported`).
//! - `sparkplayjoy-6x21` — read-only observation document;
//!   `writable_configuration: null`.
//!
//! Deliberately excluded everywhere: advanced-key history (persistence
//! unproven), screen image state, wireless transport, reset, firmware,
//! power telemetry, and opaque profile/light-template bytes — per
//! AGENTS.md §Safety 7 they are never writable desired-state fields.

use omg_hid::DeviceKind;
use omg_proto_khub916::light::LIGHT_MODES;
use serde_json::{json, Map, Value};

use crate::device::kind_id;

/// Envelope constants shared by schema, documents and `config get`.
pub const FORMAT_VERSION: u64 = 1;
pub const KHUB916_K1PRO: &str = "khub916-k1pro";
pub const HE_V2_KEYBOARD: &str = "he-v2-keyboard";
pub const COMPX_MOUSE: &str = "compx-mouse";
pub const SPARKPLAYJOY: &str = "sparkplayjoy-6x21";

/// Physical key slots the K1 Pro reports (protocol wire capacity is 128;
/// the adapter owns padding — coverage doc §3.1).
pub const K1PRO_KEYS: usize = 126;
/// Keymap banks: 4 layers × 2 systems/layouts (cmd-131 args 0..7).
pub const K1PRO_KEYMAP_BANKS: usize = 8;
/// cmd-138 light-data blob groups on K1 Pro (483 B = 23 × 21 B).
pub const K1PRO_MODE_COLORS: usize = 23;
/// Vendor limits (spec §6 / kb916_light): speed/brightness ≤ 20.
pub const LIGHT_SPEED_MAX: u64 = 20;
pub const LIGHT_BRIGHTNESS_MAX: u64 = 20;
/// 20-bit macro step duration cap (macro916::MAX_STEP_DURATION).
pub const MACRO_STEP_DELAY_MAX: u64 = 0x000F_FFFF;
/// Macro name byte cap (u8 length prefix on the wire).
pub const MACRO_NAME_MAX_BYTES: usize = 255;

/// `true` only for the live-verified writable family.
pub fn is_writable(schema_id: &str) -> bool {
    schema_id == KHUB916_K1PRO
}

/// Schema id for a device kind, before model-level checks. `None` for
/// transports/interfaces with no config surface (wireless, screen).
pub fn schema_id_for_kind(kind: DeviceKind) -> Option<&'static str> {
    match kind {
        DeviceKind::Khub916Wired => Some(KHUB916_K1PRO),
        DeviceKind::HeKeyboardV2 => Some(HE_V2_KEYBOARD),
        DeviceKind::CompxMouse => Some(COMPX_MOUSE),
        DeviceKind::SparkPlayJoy => Some(SPARKPLAYJOY),
        DeviceKind::Khub916Wireless | DeviceKind::Khub916Screen => None,
    }
}

/// Resolve a `--device`-style selector that names a *family* rather than a
/// physical device: device-kind ids (`khub916_wired`, …) and schema ids
/// (`khub916-k1pro`, …) both work, so `omg schema --device khub916_wired`
/// works with nothing plugged in.
pub fn selector_schema_id(sel: &str) -> Option<&'static str> {
    match sel {
        "khub916_wired" | "khub916-k1pro" => Some(KHUB916_K1PRO),
        "he_keyboard_v2" | "he-v2-keyboard" => Some(HE_V2_KEYBOARD),
        "compx_mouse" | "compx-mouse" => Some(COMPX_MOUSE),
        "sparkplayjoy" | "sparkplayjoy_6x21" | "sparkplayjoy-6x21" => Some(SPARKPLAYJOY),
        _ => None,
    }
}

/// `omg schema` with no device: the list of schema families an agent can
/// request by `--device <kind-or-schema-id>`.
pub fn schema_index() -> Value {
    json!({
        "ok": true,
        "kind": "omg.config.schema.index",
        "format_version": FORMAT_VERSION,
        "schemas": [
            {
                "schema_id": KHUB916_K1PRO,
                "device_kind": "khub916_wired",
                "writable": true,
                "verification": "live-verified",
                "label": family_label(KHUB916_K1PRO),
                "selector": "khub916_wired",
                "note": "K1 Pro only — other khub916 models have no verified schema yet",
            },
            {
                "schema_id": HE_V2_KEYBOARD,
                "device_kind": "he_keyboard_v2",
                "writable": false,
                "verification": "code-tested",
                "label": family_label(HE_V2_KEYBOARD),
                "selector": "he_keyboard_v2",
                "note": "declared surface only — writes rejected until hardware-verified",
            },
            {
                "schema_id": COMPX_MOUSE,
                "device_kind": "compx_mouse",
                "writable": false,
                "verification": "code-tested",
                "label": family_label(COMPX_MOUSE),
                "selector": "compx_mouse",
                "note": "declared surface only — writes rejected until hardware-verified",
            },
            {
                "schema_id": SPARKPLAYJOY,
                "device_kind": "sparkplayjoy_6x21",
                "writable": false,
                "verification": "code-verified",
                "label": family_label(SPARKPLAYJOY),
                "selector": "sparkplayjoy",
                "note": "read-only observation document; no writable configuration",
            },
        ],
        "guide": "omg guide --json",
    })
}

// ── x-omg annotation helpers ────────────────────────────────────────────

/// Capability/verification metadata for one schema node.
#[derive(Clone, Copy)]
pub struct Meta {
    pub readable: bool,
    pub writable: bool,
    /// supported / unsupported-hardware / unverified / code-tested …
    pub support_state: &'static str,
    /// live-verified / code-verified / code-tested / unverified
    pub verification: &'static str,
    /// L0 read / L1 preview / L2 reversible write / L3 disruptive / L4 forbidden
    pub risk_class: &'static str,
    /// persistent / volatile / session / unknown
    pub persistent: &'static str,
    /// reversible / conditional / not-reversible / unknown
    pub reversible: &'static str,
    /// read-back / reconnect-read-back / telemetry / none
    pub readback: &'static str,
}

const WRITABLE_LIVE: Meta = Meta {
    readable: true,
    writable: true,
    support_state: "supported",
    verification: "live-verified",
    risk_class: "L2",
    persistent: "persistent",
    reversible: "conditional",
    readback: "read-back",
};

/// Attach `x-omg` metadata + description to a JSON Schema node.
fn ann(mut schema: Value, meta: Option<Meta>, description: &str) -> Value {
    let obj = schema.as_object_mut().expect("schema node is an object");
    obj.insert("description".into(), json!(description));
    if let Some(m) = meta {
        obj.insert(
            "x-omg".into(),
            json!({
                "readable": m.readable,
                "writable": m.writable,
                "support_state": m.support_state,
                "verification": m.verification,
                "risk_class": m.risk_class,
                "persistent": m.persistent,
                "reversible": m.reversible,
                "readback": m.readback,
            }),
        );
    }
    schema
}

fn obj(props: Map<String, Value>, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": required,
        "properties": Value::Object(props),
    })
}

fn props(list: Vec<(&str, Value)>) -> Map<String, Value> {
    list.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn hex_color() -> Value {
    json!({
        "type": "string",
        "pattern": "^#[0-9A-Fa-f]{6}$",
        "description": "RGB colour as #rrggbb",
    })
}

// ── khub916-k1pro (the writable slice) ─────────────────────────────────

fn k1pro_keymap_schema() -> Value {
    let layer_entry = obj(
        props(vec![
            (
                "layer",
                ann(json!({"type":"integer","minimum":0,"maximum":3}), None, "keymap layer 0-3"),
            ),
            (
                "system",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":1}),
                    None,
                    "system/layout bank bit (<<2 of the cmd-131 arg)",
                ),
            ),
            (
                "keys",
                ann(
                    json!({
                        "type": "array",
                        "minItems": K1PRO_KEYS,
                        "maxItems": K1PRO_KEYS,
                        "items": {
                            "type": "string",
                            "pattern": "^0x[0-9A-Fa-f]{8}$",
                            "description": "raw u32 key value, big-endian hex (e.g. 0x00000029); opaque tags are preserved byte-identical",
                        },
                    }),
                    None,
                    &format!(
                        "exactly {K1PRO_KEYS} physical key slots; the 128-slot wire padding is adapter-owned"
                    ),
                ),
            ),
        ]),
        &["layer", "system", "keys"],
    );
    ann(
        obj(
            props(vec![(
                "layers",
                ann(
                    json!({
                        "type": "array",
                        "minItems": K1PRO_KEYMAP_BANKS,
                        "maxItems": K1PRO_KEYMAP_BANKS,
                        "items": layer_entry,
                        "description": "all 8 keymap banks: 4 layers × 2 systems; each (layer,system) pair exactly once",
                    }),
                    None,
                    "complete keymap: every layer/system bank and every key slot",
                ),
            )]),
            &["layers"],
        ),
        Some(WRITABLE_LIVE),
        "keymap: 4 layers × 2 systems, 126 keys per bank, raw u32 hex values",
    )
}

fn k1pro_lighting_schema() -> Value {
    let mode_ids: Vec<u64> = LIGHT_MODES.iter().map(|m| m.id as u64).collect();
    let effect = ann(
        obj(
            props(vec![
                (
                    "mode",
                    ann(
                        json!({"type":"integer","enum": mode_ids}),
                        None,
                        "effect mode id (vendor table; special modes 19/275/277 carry no record)",
                    ),
                ),
                (
                    "speed",
                    ann(
                        json!({"type":"integer","minimum":0,"maximum":LIGHT_SPEED_MAX}),
                        None,
                        "effect speed 0-20 (vendor limit; low nibble stored)",
                    ),
                ),
                (
                    "brightness",
                    ann(
                        json!({"type":"integer","minimum":0,"maximum":LIGHT_BRIGHTNESS_MAX}),
                        None,
                        "brightness 0-20 (vendor limit)",
                    ),
                ),
                (
                    "color_model",
                    ann(
                        json!({"enum":["monochrome","mixing"]}),
                        None,
                        "1=monochrome single colour, 2=colour mixing (firmware palette)",
                    ),
                ),
            ]),
            &["mode", "speed", "brightness", "color_model"],
        ),
        Some(WRITABLE_LIVE),
        "current lighting effect: mode, speed, brightness, colour model",
    );

    let mode_color_entry = obj(
        props(vec![
            (
                "mode",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":(K1PRO_MODE_COLORS - 1) as u64}),
                    None,
                    "cmd-138 group index (= vendor group-color mode parameter)",
                ),
            ),
            ("color", ann(hex_color(), None, "group RGB triple")),
        ]),
        &["mode", "color"],
    );
    let mode_colors = ann(
        json!({
            "type": "array",
            "minItems": K1PRO_MODE_COLORS,
            "maxItems": K1PRO_MODE_COLORS,
            "items": mode_color_entry,
            "description": "per-mode group colours; the 18 template bytes per 21-byte group are opaque and preserved by read-modify-write",
        }),
        Some(WRITABLE_LIVE),
        &format!("exactly {K1PRO_MODE_COLORS} mode colour groups (K1 Pro cmd-138 blob)"),
    );

    let per_key = ann(
        obj(
            props(vec![
                (
                    "mode",
                    ann(
                        json!({"const":"explicit"}),
                        None,
                        "only explicit full tables are desired state",
                    ),
                ),
                (
                    "colors",
                    ann(
                        json!({
                            "type": "array",
                            "minItems": K1PRO_KEYS,
                            "maxItems": K1PRO_KEYS,
                            "items": hex_color(),
                        }),
                        None,
                        &format!("exactly {K1PRO_KEYS} custom per-key colours (cmd 134)"),
                    ),
                ),
            ]),
            &["mode", "colors"],
        ),
        Some(WRITABLE_LIVE),
        "custom per-key colours used by the 'custom' effect (mode 277)",
    );

    ann(
        obj(
            props(vec![
                ("effect", effect),
                ("mode_colors", mode_colors),
                ("per_key", per_key),
            ]),
            &["effect", "mode_colors", "per_key"],
        ),
        Some(WRITABLE_LIVE),
        "lighting: effect state, per-mode group colours, per-key custom colours",
    )
}

fn k1pro_macros_schema() -> Value {
    let step = obj(
        props(vec![
            (
                "action",
                ann(json!({"enum":["down","up"]}), None, "key down/press or up/release"),
            ),
            (
                "delay_ms",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":MACRO_STEP_DELAY_MAX}),
                    None,
                    "stored 20-bit duration in ms",
                ),
            ),
            (
                "key",
                ann(
                    json!({"type":["string","integer"]}),
                    None,
                    "vendor key name (KeyA, ShiftLeft, MouseLeft, …), decimal usage, or 0x-hex usage byte",
                ),
            ),
            (
                "kind",
                ann(
                    json!({"enum":["key","modifier","mouse","other"]}),
                    None,
                    "step key class; 'other' preserves an unrecognized wire nibble (requires 'nibble')",
                ),
            ),
            (
                "nibble",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":15}),
                    None,
                    "raw step nibble — only with kind 'other'",
                ),
            ),
        ]),
        &["action", "delay_ms", "key"],
    );
    let binding = obj(
        props(vec![
            (
                "layer",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":3}),
                    None,
                    "keymap layer",
                ),
            ),
            (
                "system",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":1}),
                    None,
                    "keymap system bank",
                ),
            ),
            (
                "key_index",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":(K1PRO_KEYS - 1) as u64}),
                    None,
                    "0-based physical key slot",
                ),
            ),
            (
                "macro_type",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":255}),
                    None,
                    "tag-3 type byte (bits 23..16)",
                ),
            ),
            (
                "loop_count",
                ann(
                    json!({"type":"integer","minimum":1,"maximum":255}),
                    None,
                    "tag-3 loop count (bits 15..8)",
                ),
            ),
        ]),
        &["layer", "system", "key_index", "macro_type", "loop_count"],
    );
    let macro_entry = obj(
        props(vec![
            (
                "id",
                ann(json!({"type":"integer","minimum":0}), None, "entry index in the macro region (0-based, contiguous)"),
            ),
            (
                "name",
                ann(
                    json!({"type":"string"}),
                    None,
                    "macro name, UTF-8, ≤255 bytes",
                ),
            ),
            ("steps", ann(json!({"type":"array","items": step}), None, "ordered macro steps")),
            (
                "bindings",
                ann(
                    json!({"type":"array","items": binding}),
                    None,
                    "keymap slots bound to this macro; must agree with the tag-3 values in keymap.layers",
                ),
            ),
        ]),
        &["id", "name", "steps", "bindings"],
    );
    ann(
        json!({
            "type": "array",
            "items": macro_entry,
            "description": "complete macro region (≤512 B on the wire); entry order defines id",
        }),
        Some(WRITABLE_LIVE),
        "macros: named entries with steps and key bindings (cmd 133/5)",
    )
}

fn k1pro_configuration() -> Value {
    let device = ann(
        obj(
            props(vec![(
                "sleep_timeout_seconds",
                ann(
                    json!({"type":"integer","minimum":0,"maximum":255}),
                    None,
                    "keyboard sleep timeout, profile byte 24",
                ),
            )]),
            &["sleep_timeout_seconds"],
        ),
        Some(WRITABLE_LIVE),
        "device settings",
    );
    ann(
        obj(
            props(vec![
                ("keymap", k1pro_keymap_schema()),
                ("device", device),
                ("lighting", k1pro_lighting_schema()),
                ("macros", k1pro_macros_schema()),
            ]),
            &["keymap", "device", "lighting", "macros"],
        ),
        Some(WRITABLE_LIVE),
        "managed writable configuration for the K1 Pro",
    )
}

/// Non-writable areas an agent must not expect in `configuration`.
fn k1pro_excluded() -> Value {
    json!([
        {"area": "advanced_keys", "reason": "SOCD/MT/TGL bindings are keymap tag values (opaque); the 512-byte history region does not persist on K1 Pro — read-only until re-proven", "support_state": "unverified"},
        {"area": "screen", "reason": "K98 screen is a separate write-only HID interface; image pipeline incomplete", "support_state": "unsupported-hardware"},
        {"area": "wireless", "reason": "916_wireLess transport not implemented", "support_state": "not-implemented"},
        {"area": "reset", "reason": "cmd 17 factory/keymap reset is L4, fire-and-forget, blocked from generic config", "support_state": "not-implemented", "risk_class": "L4"},
        {"area": "firmware", "reason": "no firmware update path exists in the protocol crate", "support_state": "not-implemented", "risk_class": "L4"},
        {"area": "device.power", "reason": "battery/charging telemetry (cmd 135) — read-only, not desired state", "support_state": "supported"},
        {"area": "opaque_bytes", "reason": "profile blob fields other than sleep/light state and the 18 template bytes of each light group are preserved byte-identical by read-modify-write, never authored", "support_state": "opaque"},
    ])
}

fn k1pro_schema_doc() -> Value {
    let mode_names: Vec<Value> = LIGHT_MODES
        .iter()
        .map(|m| json!({"id": m.id, "name": m.name, "color_support": m.color_support}))
        .collect();
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "urn:oh-my-gravastar:config:khub916-k1pro:v1",
        "title": "GravaStar K1 Pro desired configuration (khub916 wired)",
        "type": "object",
        "additionalProperties": false,
        "required": ["format_version", "schema_id", "target", "configuration"],
        "properties": {
            "format_version": {"const": FORMAT_VERSION, "description": "config document format version"},
            "schema_id": {"const": KHUB916_K1PRO},
            "target": {
                "type": "object",
                "additionalProperties": false,
                "required": ["device_kind", "model", "firmware"],
                "properties": {
                    "device_kind": {"const": "khub916_wired"},
                    "model": {"type": "string", "description": "catalog model id from cmd 130, e.g. 916_K1_PRO"},
                    "firmware": {"type": "string", "description": "firmware version word from cmd 130, e.g. 0x0100"},
                },
                "description": "device/firmware binding — a document authored for one target is rejected on another",
            },
            "configuration": k1pro_configuration(),
        },
        "x-omg": {
            "schema_id": KHUB916_K1PRO,
            "format_version": FORMAT_VERSION,
            "device_kind": "khub916_wired",
            "model": "916_K1_PRO",
            "writable": true,
            "verification": "live-verified",
            "managed_writable": ["keymap", "device.sleep_timeout_seconds", "lighting.effect", "lighting.mode_colors", "lighting.per_key", "macros"],
            "key_counts": {"physical_keys": K1PRO_KEYS, "keymap_banks": K1PRO_KEYMAP_BANKS, "mode_color_groups": K1PRO_MODE_COLORS, "macro_region_bytes": 512},
            "light_modes": mode_names,
            "excluded": k1pro_excluded(),
            "guide": "omg guide --json",
            "notes": [
                "full desired state: every managed writable field is required; missing fields are validation errors",
                "keymap keys are raw u32 hex strings preserved byte-identical — opaque/unknown tags are never interpreted or defaulted",
                "macro bindings must agree with the tag-3 keymap values they reference",
            ],
        },
    })
}

// ── Declared-but-not-writable families ─────────────────────────────────

/// Shared envelope for families whose surface is documented but gated
/// off (`writable: false`); `document::validate` rejects their documents.
fn gated_schema_doc(
    schema_id: &str,
    device_kind: &str,
    title: &str,
    configuration: Value,
    note: &str,
) -> Value {
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": format!("urn:oh-my-gravastar:config:{schema_id}:v1"),
        "title": title,
        "type": "object",
        "additionalProperties": false,
        "required": ["format_version", "schema_id", "target", "configuration"],
        "properties": {
            "format_version": {"const": FORMAT_VERSION},
            "schema_id": {"const": schema_id},
            "target": {
                "type": "object",
                "additionalProperties": false,
                "required": ["device_kind", "model", "firmware"],
                "properties": {
                    "device_kind": {"const": device_kind},
                    "model": {"type": "string"},
                    "firmware": {"type": "string"},
                },
            },
            "configuration": configuration,
        },
        "x-omg": {
            "schema_id": schema_id,
            "format_version": FORMAT_VERSION,
            "device_kind": device_kind,
            "writable": false,
            "managed_writable": [],
            "verification": "code-tested",
            "note": note,
            "guide": "omg guide --json",
        },
    })
}

/// Mark every leaf of a declared configuration schema non-writable.
fn gate_unwritable(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        let is_schema_node =
            o.contains_key("type") || o.contains_key("enum") || o.contains_key("const");
        if is_schema_node {
            let meta = o
                .get("x-omg")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut m = Map::new();
            for (k, val) in meta {
                m.insert(k, val);
            }
            m.insert("readable".into(), json!(true));
            m.insert("writable".into(), json!(false));
            m.insert("support_state".into(), json!("code-tested"));
            m.insert("verification".into(), json!("code-tested"));
            m.insert("risk_class".into(), json!("L1"));
            o.insert("x-omg".into(), Value::Object(m));
        }
        for val in o.values_mut() {
            gate_unwritable(val);
        }
    } else if let Some(a) = v.as_array_mut() {
        for val in a {
            gate_unwritable(val);
        }
    }
}

fn he_v2_configuration() -> Value {
    // Coverage doc §5.2 shape. Every node is annotated writable:false by
    // `gate_unwritable`; constraints reflect the ported protocol tables.
    let mut conf = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["profiles", "device", "keymap", "performance", "lighting", "advanced_keys", "macros"],
        "properties": {
            "profiles": {
                "type": "object", "additionalProperties": false,
                "required": ["active", "names"],
                "properties": {
                    "active": {"type": "integer", "minimum": 0},
                    "names": {"type": "array", "items": {"type": "string"}},
                },
            },
            "device": {
                "type": "object", "additionalProperties": false,
                "required": ["os_mode", "polling_rate_hz", "lighting_sleep_minutes"],
                "properties": {
                    "os_mode": {"enum": ["windows", "macos"]},
                    "polling_rate_hz": {"enum": [125, 250, 500, 1000, 2000, 4000, 8000]},
                    "lighting_sleep_minutes": {"type": "integer", "minimum": 0},
                },
            },
            "keymap": {
                "type": "object", "additionalProperties": false, "required": ["layers"],
                "properties": {
                    "layers": {"type": "array", "items": {
                        "type": "object", "additionalProperties": false,
                        "required": ["layer", "rows"],
                        "properties": {
                            "layer": {"type": "integer", "minimum": 0, "maximum": 3},
                            "rows": {"type": "array", "items": {
                                "type": "object", "additionalProperties": false,
                                "required": ["row", "codes"],
                                "properties": {
                                    "row": {"type": "integer"},
                                    "codes": {"type": "array", "minItems": 21, "maxItems": 21,
                                        "items": {"type": "integer"}},
                                },
                            }},
                        },
                    }},
                },
            },
            "performance": {
                "type": "object", "additionalProperties": false, "required": ["keys"],
                "properties": {
                    "keys": {"type": "array", "items": {
                        "type": "object", "additionalProperties": false,
                        "required": ["row", "col", "mode"],
                        "properties": {
                            "row": {"type": "integer"},
                            "col": {"type": "integer", "minimum": 0, "maximum": 20},
                            "mode": {"enum": ["fixed", "rapid_trigger"]},
                        },
                    }},
                },
            },
            "lighting": {
                "type": "object", "additionalProperties": false, "required": ["zones"],
                "properties": {
                    "zones": {"type": "array", "items": {
                        "type": "object", "additionalProperties": false,
                        "required": ["area", "on", "mode", "brightness", "speed", "direction", "color_index", "palette"],
                        "properties": {
                            "area": {"type": "integer"},
                            "on": {"type": "boolean"},
                            "mode": {"type": "integer"},
                            "brightness": {"type": "integer", "minimum": 0, "maximum": 100},
                            "speed": {"type": "integer", "minimum": 0, "maximum": 100},
                            "direction": {"enum": ["forward", "reverse", "backward"]},
                            "color_index": {"type": "integer", "minimum": 0, "maximum": 7},
                            "palette": {"type": "array", "minItems": 8, "maxItems": 8, "items": {
                                "type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"}},
                        },
                    }},
                },
            },
            "advanced_keys": {
                "type": "object", "additionalProperties": false, "required": ["keys"],
                "properties": {
                    "keys": {"type": "array", "items": {
                        "type": "object", "additionalProperties": false,
                        "required": ["row", "col", "mode"],
                        "properties": {
                            "row": {"type": "integer"},
                            "col": {"type": "integer", "minimum": 0, "maximum": 20},
                            "mode": {"enum": ["none", "dks", "mpt", "mt", "tgl", "end", "socd", "rs"]},
                        },
                    }},
                },
            },
            "macros": {
                "type": "array",
                "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["id", "valid", "repeat_count", "mode", "actions"],
                    "properties": {
                        "id": {"type": "integer", "minimum": 0},
                        "valid": {"type": "boolean"},
                        "repeat_count": {"type": "integer"},
                        "mode": {"type": "integer"},
                        "actions": {"type": "array", "items": {
                            "type": "object", "additionalProperties": false,
                            "required": ["key_code", "delay", "status"],
                            "properties": {
                                "key_code": {"type": "integer"},
                                "delay": {"type": "integer"},
                                "status": {"type": "boolean"},
                            },
                        }},
                    },
                },
            },
        },
        "description": "HE v2 declared configuration surface (coverage doc §5.2) — NOT writable",
    });
    gate_unwritable(&mut conf);
    conf
}

fn compx_configuration() -> Value {
    let mut conf = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["report_rate_hz", "dpi", "sensor", "lighting", "power", "buttons"],
        "properties": {
            "report_rate_hz": {"enum": [125, 250, 500, 1000, 2000, 4000, 8000]},
            "dpi": {
                "type": "object", "additionalProperties": false,
                "required": ["stage_count", "current_stage", "stages"],
                "properties": {
                    "stage_count": {"type": "integer", "minimum": 1, "maximum": 8},
                    "current_stage": {"type": "integer", "minimum": 0, "maximum": 7},
                    "stages": {"type": "array", "minItems": 8, "maxItems": 8, "items": {
                        "type": "object", "additionalProperties": false,
                        "required": ["dpi", "color"],
                        "properties": {
                            "dpi": {"type": "integer", "minimum": 1},
                            "color": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"},
                        },
                    }},
                },
            },
            "sensor": {
                "type": "object", "additionalProperties": false,
                "required": ["lod", "mode", "debounce_ms", "motion_sync", "angle_snap", "ripple"],
                "properties": {
                    "lod": {"type": "integer"},
                    "mode": {"enum": ["low_power", "high_performance"]},
                    "debounce_ms": {"type": "integer", "minimum": 0, "maximum": 15},
                    "motion_sync": {"type": "boolean"},
                    "angle_snap": {"type": "boolean"},
                    "ripple": {"type": "boolean"},
                },
            },
            "lighting": {
                "type": "object", "additionalProperties": false,
                "required": ["on", "mode", "color", "speed", "brightness", "off_while_moving"],
                "properties": {
                    "on": {"type": "boolean"},
                    "mode": {"type": "integer", "minimum": 0, "maximum": 6},
                    "color": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$"},
                    "speed": {"type": "integer", "minimum": 1, "maximum": 9},
                    "brightness": {"type": "integer", "minimum": 1, "maximum": 9},
                    "off_while_moving": {"type": "boolean"},
                },
            },
            "power": {
                "type": "object", "additionalProperties": false, "required": ["sleep_seconds"],
                "properties": {
                    "sleep_seconds": {"enum": [10, 30, 60, 120, 180, 300, 600, 900]},
                },
            },
            "buttons": {
                "type": "array", "minItems": 6, "maxItems": 6,
                "items": {
                    "type": "object", "additionalProperties": false,
                    "required": ["slot", "kind", "param"],
                    "properties": {
                        "slot": {"type": "integer", "minimum": 0, "maximum": 5},
                        "kind": {"enum": ["disabled", "mouse", "dpi", "shortcut", "macro"]},
                        "param": {"type": "integer"},
                    },
                },
            },
        },
        "description": "Compx mouse declared configuration surface (coverage doc §5.3) — NOT writable",
    });
    gate_unwritable(&mut conf);
    conf
}

// ── SparkPlayJoy observation document ──────────────────────────────────

fn spark_doc() -> Value {
    json!({
        "kind": "omg.config.schema",
        "schema_id": SPARKPLAYJOY,
        "format_version": FORMAT_VERSION,
        "read_only": true,
        "writable": false,
        "writable_configuration": null,
        "observed": {
            "identity": {"description": "board id, platform, app/build versions (cmd sync)"},
            "travel_scale": {"description": "precision, min/max travel in µm"},
            "default_map": {"description": "physical 6×21 default key map"},
            "active_map": {"description": "Fn0 active key functions"},
            "travel": {"description": "6×21 analog travel samples — runtime telemetry"},
            "status": {"description": "6×21 status matrix"},
        },
        "reset": {"supported": false, "reason": "read-only-protocol"},
        "x-omg": {
            "verification": "code-verified",
            "note": "read-only analog protocol; no write path exists — config get/validate/diff are unsupported",
            "guide": "omg guide --json",
        },
    })
}

// ── Public entry points ────────────────────────────────────────────────

/// Build the schema/observation document for `schema_id`, optionally
/// filtered to one top-level `configuration` section (or `observed`
/// section for the SparkPlayJoy document).
pub fn schema_doc(
    schema_id: &str,
    section: Option<&str>,
) -> Result<Value, crate::config::error::ConfigError> {
    use crate::config::error::ConfigError;
    let mut doc = match schema_id {
        KHUB916_K1PRO => k1pro_schema_doc(),
        HE_V2_KEYBOARD => gated_schema_doc(
            HE_V2_KEYBOARD,
            "he_keyboard_v2",
            "GravaStar HE v2 keyboard declared configuration (NOT writable)",
            he_v2_configuration(),
            "code-tested only — no HE hardware attached; writable surface disabled until live-verified",
        ),
        COMPX_MOUSE => gated_schema_doc(
            COMPX_MOUSE,
            "compx_mouse",
            "GravaStar Compx mouse declared configuration (NOT writable)",
            compx_configuration(),
            "code-tested only — no Compx hardware attached; writable surface disabled until live-verified",
        ),
        SPARKPLAYJOY => spark_doc(),
        other => {
            return Err(ConfigError::unsupported(format!(
                "unknown config schema '{other}' — see `omg schema` for the family index"
            )))
        }
    };
    if let Some(sec) = section {
        filter_section(&mut doc, sec)?;
    }
    Ok(doc)
}

/// Restrict a schema doc to one `configuration` section (JSON-Schema docs)
/// or one `observed` section (SparkPlayJoy). Unknown sections are an error.
fn filter_section(doc: &mut Value, section: &str) -> Result<(), crate::config::error::ConfigError> {
    use crate::config::error::ConfigError;
    if doc.get("writable_configuration").is_some() || doc.get("observed").is_some() {
        let observed = doc
            .get_mut("observed")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                ConfigError::invalid_document("observation doc has no 'observed' object")
            })?;
        if !observed.contains_key(section) {
            return Err(ConfigError::invalid_document(format!(
                "unknown section '{section}' — valid: {}",
                observed.keys().cloned().collect::<Vec<_>>().join(", ")
            )));
        }
        let keep = observed.remove(section).unwrap();
        *observed = Map::from_iter([(section.to_string(), keep)]);
        return Ok(());
    }
    let conf = doc
        .get_mut("properties")
        .and_then(|p| p.get_mut("configuration"))
        .and_then(|c| c.get_mut("properties"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            ConfigError::invalid_document("schema doc has no configuration properties")
        })?;
    if !conf.contains_key(section) {
        return Err(ConfigError::invalid_document(format!(
            "unknown section '{section}' for this schema"
        )));
    }
    let keep = conf.remove(section).unwrap();
    let names: Vec<String> = conf.keys().cloned().collect();
    *conf = Map::from_iter([(section.to_string(), keep)]);
    // required must only name surviving sections.
    if let Some(req) = doc
        .get_mut("properties")
        .and_then(|p| p.get_mut("configuration"))
        .and_then(|c| c.get_mut("required"))
        .and_then(Value::as_array_mut)
    {
        req.retain(|r| {
            r.as_str() == Some(section)
                || names.contains(&r.as_str().unwrap_or_default().to_string())
        });
        req.retain(|r| r.as_str() == Some(section));
    }
    if let Some(x) = doc.get_mut("x-omg").and_then(Value::as_object_mut) {
        x.insert("section".into(), json!(section));
    }
    Ok(())
}

/// Human-readable one-line summary of a schema family (for `omg schema`
/// non-JSON output and the guide).
pub fn family_label(schema_id: &str) -> &'static str {
    match schema_id {
        KHUB916_K1PRO => "khub916-k1pro (K1 Pro, writable, live-verified)",
        HE_V2_KEYBOARD => "he-v2-keyboard (declared, not writable — code-tested)",
        COMPX_MOUSE => "compx-mouse (declared, not writable — code-tested)",
        SPARKPLAYJOY => "sparkplayjoy-6x21 (read-only observation)",
        _ => "unknown",
    }
}

/// Kind id strings accepted as `--device` family selectors, for error
/// messages and the schema index.
pub fn family_selectors() -> Vec<&'static str> {
    vec![
        "khub916_wired",
        "he_keyboard_v2",
        "compx_mouse",
        "sparkplayjoy",
    ]
}

/// `omg device list` kind id for a schema id (inverse of
/// [`schema_id_for_kind`], used in resolution messages).
pub fn kind_for_schema(schema_id: &str) -> Option<&'static str> {
    match schema_id {
        KHUB916_K1PRO => Some(kind_id(DeviceKind::Khub916Wired)),
        HE_V2_KEYBOARD => Some(kind_id(DeviceKind::HeKeyboardV2)),
        COMPX_MOUSE => Some(kind_id(DeviceKind::CompxMouse)),
        SPARKPLAYJOY => Some(kind_id(DeviceKind::SparkPlayJoy)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn k1pro_schema_is_valid_shape() {
        let doc = schema_doc(KHUB916_K1PRO, None).unwrap();
        assert_eq!(
            doc["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
        assert_eq!(doc["properties"]["schema_id"]["const"], KHUB916_K1PRO);
        let conf = &doc["properties"]["configuration"];
        for section in ["keymap", "device", "lighting", "macros"] {
            assert!(
                conf["properties"].get(section).is_some(),
                "missing {section}"
            );
            assert!(conf["required"]
                .as_array()
                .unwrap()
                .contains(&json!(section)));
        }
        // Cardinalities.
        let layers = &conf["properties"]["keymap"]["properties"]["layers"];
        assert_eq!(layers["minItems"], 8);
        assert_eq!(layers["maxItems"], 8);
        let keys = &layers["items"]["properties"]["keys"];
        assert_eq!(keys["minItems"], 126);
        let mc = &conf["properties"]["lighting"]["properties"]["mode_colors"];
        assert_eq!(mc["minItems"], 23);
        let pk = &conf["properties"]["lighting"]["properties"]["per_key"]["properties"]["colors"];
        assert_eq!(pk["minItems"], 126);
        // x-omg metadata present on managed sections.
        for section in ["keymap", "device", "lighting", "macros"] {
            let x = &conf["properties"][section]["x-omg"];
            assert_eq!(x["writable"], true, "{section}");
            assert_eq!(x["verification"], "live-verified");
            assert_eq!(x["risk_class"], "L2");
        }
        // Excluded areas declared.
        let excl = doc["x-omg"]["excluded"].as_array().unwrap();
        for area in ["advanced_keys", "screen", "wireless", "reset", "firmware"] {
            assert!(
                excl.iter().any(|e| e["area"] == area),
                "excluded missing {area}"
            );
        }
    }

    #[test]
    fn gated_families_are_not_writable() {
        for id in [HE_V2_KEYBOARD, COMPX_MOUSE] {
            let doc = schema_doc(id, None).unwrap();
            assert_eq!(doc["x-omg"]["writable"], false);
            assert_eq!(doc["x-omg"]["managed_writable"], json!([]));
            // No writable leaf may leak through.
            let s = doc.to_string();
            assert!(
                !s.contains("\"writable\":true"),
                "{id} advertises a writable field"
            );
        }
    }

    #[test]
    fn sparkplayjoy_is_observation_only() {
        let doc = schema_doc(SPARKPLAYJOY, None).unwrap();
        assert_eq!(doc["writable_configuration"], Value::Null);
        assert_eq!(doc["read_only"], true);
        assert!(doc["observed"].get("identity").is_some());
    }

    #[test]
    fn section_filter_works_and_rejects_unknown() {
        let doc = schema_doc(KHUB916_K1PRO, Some("lighting")).unwrap();
        let props = doc["properties"]["configuration"]["properties"]
            .as_object()
            .unwrap();
        assert_eq!(props.len(), 1);
        assert!(props.contains_key("lighting"));
        assert!(schema_doc(KHUB916_K1PRO, Some("bogus")).is_err());
        let doc = schema_doc(SPARKPLAYJOY, Some("identity")).unwrap();
        let obs = doc["observed"].as_object().unwrap();
        assert_eq!(obs.len(), 1);
        assert!(obs.contains_key("identity"));
    }

    #[test]
    fn selectors_resolve() {
        assert_eq!(selector_schema_id("khub916_wired"), Some(KHUB916_K1PRO));
        assert_eq!(selector_schema_id("he_keyboard_v2"), Some(HE_V2_KEYBOARD));
        assert_eq!(selector_schema_id("sparkplayjoy"), Some(SPARKPLAYJOY));
        assert_eq!(selector_schema_id("916_K1_PRO"), None);
        assert!(schema_id_for_kind(DeviceKind::Khub916Wired).is_some());
        assert!(schema_id_for_kind(DeviceKind::Khub916Wireless).is_none());
    }
}
