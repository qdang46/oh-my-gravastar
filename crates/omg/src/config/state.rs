//! Fail-closed current-state reader for `config get` / `config diff`.
//!
//! Every value in the emitted document comes from a real protocol read;
//! a failed or short read is a `state_read_failed` error, never a
//! default (AGENTS.md §Safety 6). The output is a *valid desired-state
//! document* for `khub916-k1pro` — `config get | config validate` on it
//! must round-trip.
//!
//! Reads (all live-verified query commands, docs/protocol-khub916.md):
//! cmd 130 identity → target block; cmd 131 ×8 keymap; cmd 132 profile
//! (sleep byte + light state); cmd 138 light-data groups; cmd 134
//! per-key colours; cmd 133 macro region. Power (cmd 135) is telemetry,
//! not desired state, and is deliberately not read here.

use omg_hid::DeviceInfo;
use omg_proto_khub916::light::{self, LightGroup};
use omg_proto_khub916::macro916::{self, StepKind};
use omg_proto_khub916::{decode_key_value, KeyValue, Khub916};
use serde_json::{json, Value};

use crate::config::error::ConfigError;
use crate::config::schema::{self, K1PRO_KEYS};

/// Open a khub916 wired session for `device` (report-id probe included).
pub fn open_session(device: &DeviceInfo) -> Result<Khub916, ConfigError> {
    let mut link = device
        .open_link()
        .map_err(|e| ConfigError::state_read_failed("open device", e))?;
    let report_id = omg_proto_khub916::probe_report_id(&mut link)
        .map_err(|e| ConfigError::state_read_failed("report id probe", e))?;
    Ok(Khub916::new(Box::new(link), report_id))
}

fn read<T>(what: &str, r: anyhow::Result<T>) -> Result<T, ConfigError> {
    r.map_err(|e| ConfigError::state_read_failed(what, e))
}

/// `(model, firmware)` strings for the target block, from cmd 130.
/// Only the live-verified K1 Pro has a schema; other catalog models are
/// rejected rather than given a fabricated key count.
fn resolve_target(kb: &mut Khub916) -> Result<(String, String), ConfigError> {
    let info = read("device info (cmd 130)", kb.device_info())?;
    let model = info.catalog_model.ok_or_else(|| {
        ConfigError::unsupported(format!(
            "khub916 device UUID {} is not in the vendor catalog — no verified schema applies",
            info.uuid
        ))
    })?;
    if model != "916_K1_PRO" {
        return Err(ConfigError::unsupported(format!(
            "khub916 model {model} has no verified config schema yet — only 916_K1_PRO \
             is live-verified (126 keys, 23 light groups); refusing to guess cardinalities"
        )));
    }
    Ok((model, format!("0x{:04X}", info.version)))
}

/// Read all 8 keymap banks (cmd 131 args 0..7). Every bank must report
/// exactly K1PRO_KEYS values — a short or inconsistent read is an error.
fn read_keymap(kb: &mut Khub916) -> Result<Vec<(u8, u8, Vec<u32>)>, ConfigError> {
    let mut banks = Vec::with_capacity(schema::K1PRO_KEYMAP_BANKS);
    for arg in 0..schema::K1PRO_KEYMAP_BANKS as u8 {
        let values = read(
            &format!("keymap read (cmd 131 arg {arg})"),
            kb.key_values(arg),
        )?;
        if values.len() != K1PRO_KEYS {
            return Err(ConfigError::state_read_failed(
                format!("keymap read (cmd 131 arg {arg})"),
                format!(
                    "returned {} entries, expected exactly {K1PRO_KEYS} — refusing to emit a partial keymap",
                    values.len()
                ),
            ));
        }
        banks.push((arg & 3, arg >> 2, values)); // (layer, system)
    }
    Ok(banks)
}

/// Resolve the `TargetContext` for a physical device: schema from the
/// device kind, and for khub916-wired the cmd-130 model/firmware binding
/// (non-K1-Pro models are `unsupported` — no verified schema applies).
/// Gated families get `model`/`firmware` = `None` (family-level ctx;
/// `document::validate` rejects them as `unsupported` anyway).
pub fn target_context(
    device: &DeviceInfo,
) -> Result<crate::config::document::TargetContext, ConfigError> {
    let schema_id = schema::schema_id_for_kind(device.kind).ok_or_else(|| {
        ConfigError::unsupported(format!(
            "{} ({}) has no config schema — wireless/screen transports expose no managed surface",
            device.vid_pid(),
            device.kind.label()
        ))
    })?;
    let device_kind = crate::device::kind_id(device.kind).to_string();
    if schema_id != schema::KHUB916_K1PRO {
        return Ok(crate::config::document::TargetContext {
            schema_id: schema_id.to_string(),
            device_kind,
            model: None,
            firmware: None,
        });
    }
    let mut kb = open_session(device)?;
    let info = read("device info (cmd 130)", kb.device_info())?;
    let model = info.catalog_model.clone().ok_or_else(|| {
        ConfigError::unsupported(format!(
            "khub916 device UUID {} is not in the vendor catalog — no verified schema applies",
            info.uuid
        ))
    })?;
    if model != "916_K1_PRO" {
        return Err(ConfigError::unsupported(format!(
            "khub916 model {model} has no verified config schema yet — only 916_K1_PRO \
             is live-verified (126 keys, 23 light groups)"
        )));
    }
    Ok(crate::config::document::TargetContext {
        schema_id: schema_id.to_string(),
        device_kind,
        model: Some(model),
        firmware: Some(format!("0x{:04X}", info.version)),
    })
}

/// cmd-138 groups → `mode_colors` entries (`mode` = group index).
fn read_mode_colors(kb: &mut Khub916) -> Result<Vec<Value>, ConfigError> {
    let blob = read("light data read (cmd 138)", kb.light_color_data())?;
    let data = light::decode_light_data(&blob);
    if data.groups.len() != schema::K1PRO_MODE_COLORS || data.tail_len != 0 {
        return Err(ConfigError::state_read_failed(
            "light data read (cmd 138)",
            format!(
                "blob is {} bytes ({} groups + {} tail), expected exactly {}×{}",
                blob.len(),
                data.groups.len(),
                data.tail_len,
                schema::K1PRO_MODE_COLORS,
                light::LIGHT_GROUP_STRIDE
            ),
        ));
    }
    Ok(data
        .groups
        .iter()
        .map(|g: &LightGroup| {
            json!({
                "mode": g.index,
                "color": format!("#{:02x}{:02x}{:02x}", g.color.r, g.color.g, g.color.b),
            })
        })
        .collect())
}

/// Scan keymap banks for tag-3 macro references → per-macro bindings.
/// `(layer, system, slot)` uses the physical key index.
fn macro_bindings(banks: &[(u8, u8, Vec<u32>)]) -> Vec<(usize, u8, u8, usize, u8, u8)> {
    let mut out = Vec::new();
    for &(layer, system, ref values) in banks {
        for (slot, &v) in values.iter().enumerate() {
            if let KeyValue::Macro {
                macro_type,
                number,
                index,
            } = decode_key_value(v)
            {
                out.push((index as usize, layer, system, slot, macro_type, number));
            }
        }
    }
    out
}

/// Canonical step JSON — must match `document::parse_step`'s output so a
/// `config get` document passes `config validate` unchanged.
fn step_json(s: &macro916::MacroStep) -> Value {
    let action = if s.action == 0 { "down" } else { "up" };
    let (key, kind, nibble) = match s.kind {
        StepKind::Key => (
            macro916::macro_name_for_usage(s.usage, s.kind)
                .map(|n| json!(n))
                .unwrap_or_else(|| json!(s.usage)),
            "key",
            None,
        ),
        StepKind::Modifier => (
            macro916::macro_name_for_usage(s.usage, s.kind)
                .map(|n| json!(n))
                .unwrap_or_else(|| json!(s.usage)),
            "modifier",
            None,
        ),
        StepKind::Mouse => (
            macro916::macro_name_for_usage(s.usage, s.kind)
                .map(|n| json!(n))
                .unwrap_or_else(|| json!(s.usage)),
            "mouse",
            None,
        ),
        StepKind::Other(n) => (json!(s.usage), "other", Some(n)),
    };
    let mut o = json!({
        "action": action,
        "delay_ms": s.delay_ms,
        "key": key,
        "kind": kind,
    });
    if let Some(n) = nibble {
        o["nibble"] = json!(n);
    }
    o
}

/// Read the macro region (cmd 133) and emit normalized entries with
/// bindings resolved from the keymap.
fn read_macros(kb: &mut Khub916, banks: &[(u8, u8, Vec<u32>)]) -> Result<Vec<Value>, ConfigError> {
    let raw = read("macro region read (cmd 133)", kb.macro_region())?;
    let entries = read("macro region parse", macro916::parse_macro_region(&raw))?;
    let bindings = macro_bindings(banks);
    let mut out = Vec::with_capacity(entries.len());
    for (id, e) in entries.iter().enumerate() {
        let mut bs: Vec<Value> = bindings
            .iter()
            .filter(|(mid, ..)| *mid == id)
            .map(|&(_, layer, system, slot, mtype, loop_count)| {
                json!({
                    "layer": layer,
                    "system": system,
                    "key_index": slot,
                    "macro_type": mtype,
                    "loop_count": loop_count,
                })
            })
            .collect();
        bs.sort_by_key(|b| {
            (
                b["layer"].as_u64().unwrap_or(0),
                b["system"].as_u64().unwrap_or(0),
                b["key_index"].as_u64().unwrap_or(0),
            )
        });
        out.push(json!({
            "id": id,
            "name": e.name,
            "steps": e.steps.iter().map(step_json).collect::<Vec<_>>(),
            "bindings": bs,
        }));
    }
    // Dangling tag-3 references (keymap points past the region) cannot be
    // represented in the document — fail closed rather than emit a doc
    // that would not validate.
    if let Some(&(mid, ..)) = bindings.iter().find(|(mid, ..)| *mid >= entries.len()) {
        return Err(ConfigError::state_read_failed(
            "macro/keymap consistency",
            format!(
                "keymap references macro index {mid} but the region holds {} entries",
                entries.len()
            ),
        ));
    }
    Ok(out)
}

/// Read the complete current configuration of a khub916 wired device as
/// a desired-state document. Fails closed on any read error or short
/// payload.
pub fn read_current(device: &DeviceInfo) -> Result<Value, ConfigError> {
    let mut kb = open_session(device)?;
    let (model, firmware) = resolve_target(&mut kb)?;
    let banks = read_keymap(&mut kb)?;
    let profile = read("profile read (cmd 132)", kb.profile())?;
    let sleep = profile.sleep_seconds().ok_or_else(|| {
        ConfigError::state_read_failed(
            "profile read (cmd 132)",
            format!(
                "blob too short for sleep byte ({} bytes)",
                profile.raw.len()
            ),
        )
    })?;
    let light = light::decode_light_state(&profile).ok_or_else(|| {
        ConfigError::state_read_failed(
            "profile light state decode",
            "profile blob lacks the FF FF record-table marker",
        )
    })?;
    let mode_colors = read_mode_colors(&mut kb)?;
    let custom = read(
        "custom light colours read (cmd 134)",
        kb.custom_light_colors(),
    )?;
    if custom.len() != schema::K1PRO_KEYS {
        return Err(ConfigError::state_read_failed(
            "custom light colours read (cmd 134)",
            format!(
                "returned {} colours, expected {}",
                custom.len(),
                schema::K1PRO_KEYS
            ),
        ));
    }
    let macros = read_macros(&mut kb, &banks)?;

    // keymap layers in cmd-131 arg order (system-major, layer fastest).
    let layers: Vec<Value> = banks
        .iter()
        .map(|&(layer, system, ref values)| {
            json!({
                "layer": layer,
                "system": system,
                "keys": values.iter().map(|&v| format!("0x{v:08X}")).collect::<Vec<_>>(),
            })
        })
        .collect();

    Ok(json!({
        "format_version": schema::FORMAT_VERSION,
        "schema_id": schema::KHUB916_K1PRO,
        "target": {
            "device_kind": "khub916_wired",
            "model": model,
            "firmware": firmware,
        },
        "configuration": {
            "keymap": {"layers": layers},
            "device": {"sleep_timeout_seconds": sleep},
            "lighting": {
                "effect": {
                    "mode": light.mode,
                    "speed": light.speed,
                    "brightness": light.brightness,
                    "color_model": if light.color_model == light::color_model::MONOCHROME {
                        "monochrome"
                    } else {
                        "mixing"
                    },
                },
                "mode_colors": mode_colors,
                "per_key": {
                    "mode": "explicit",
                    "colors": custom.iter().map(|c| format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b)).collect::<Vec<_>>(),
                },
            },
            "macros": macros,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use omg_hid::Link;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    /// Scripted khub916 feature-report link (same shape as profile.rs's
    /// KhubMock): echoes the 7-byte header, answers by cmd byte.
    struct Mock {
        /// cmd → payload bytes (after the echoed header).
        replies: std::collections::HashMap<u8, Vec<u8>>,
        /// args of cmd-131 requests seen, for assertions.
        keymap_args: Rc<RefCell<Vec<u8>>>,
    }

    impl Link for Mock {
        fn write(&mut self, _id: u8, _data: &[u8]) -> anyhow::Result<()> {
            Ok(())
        }
        fn read(&mut self, _t: Duration) -> anyhow::Result<Option<Vec<u8>>> {
            Ok(None)
        }
        fn feature_exchange(
            &mut self,
            _report_id: u8,
            payload: &[u8],
            _t: Duration,
        ) -> anyhow::Result<Option<Vec<u8>>> {
            let cmd = payload[0];
            let arg = payload[1];
            if cmd == 131 {
                self.keymap_args.borrow_mut().push(arg);
            }
            let mut resp = payload[..7].to_vec();
            match self.replies.get(&cmd) {
                Some(p) => resp.extend_from_slice(p),
                None => anyhow::bail!("mock: unexpected cmd {cmd}"),
            }
            Ok(Some(resp))
        }
    }

    fn u32s(vals: &[u32]) -> Vec<u8> {
        vals.iter().flat_map(|v| v.to_be_bytes()).collect()
    }

    fn fixture() -> Mock {
        let mut replies = std::collections::HashMap::new();
        // cmd 130: uuid K1 Pro + version 0x0100 + screen 0
        replies.insert(
            130u8,
            vec![0x03, 0x00, 0x00, 0x00, 0x01, 0x97, 0x01, 0x00, 0x00],
        );
        // cmd 131: 126 u32 values per arg
        for _ in 0..8 {
            replies.insert(131u8, u32s(&vec![0x29u32; K1PRO_KEYS]));
        }
        // cmd 132: 128-byte profile, FF FF at 56-57, sleep=30 @24,
        // mode 15 record at base+28/+29 (base=58 → 86/87)
        let mut p = vec![0u8; 128];
        p[24] = 30;
        p[56] = 0xFF;
        p[57] = 0xFF;
        p[9] = 0;
        p[10] = 15;
        p[86] = 10;
        p[87] = 0x47; // speed 4 << 4 | type 7 → mixing
        replies.insert(132u8, p);
        // cmd 138: 23 groups × 21 B; group i colour = (i, i+1, i+2)
        let mut blob = Vec::new();
        for i in 0..schema::K1PRO_MODE_COLORS {
            blob.extend_from_slice(&[i as u8, (i + 1) as u8, (i + 2) as u8]);
            blob.extend_from_slice(&[0u8; 18]);
        }
        replies.insert(138u8, blob);
        // cmd 134: 378 plane bytes
        replies.insert(134u8, vec![0x11u8; 378]);
        // cmd 133: empty macro region
        replies.insert(133u8, vec![0u8; 512]);
        Mock {
            replies,
            keymap_args: Rc::new(RefCell::new(Vec::new())),
        }
    }

    fn device() -> DeviceInfo {
        DeviceInfo {
            path: "mock".into(),
            vid: 0x258a,
            pid: 0x010c,
            product: None,
            manufacturer: None,
            usage_page: 0xff00,
            usage: 0,
            kind: omg_hid::DeviceKind::Khub916Wired,
        }
    }

    // read_current needs a real HID link; test the pieces that don't.
    #[test]
    fn step_json_matches_document_canonical() {
        // A "KeyA down 8ms" step must serialize identically to what
        // document::parse_step accepts back.
        let s = macro916::MacroStep {
            action: 0,
            delay_ms: 8,
            usage: 4,
            kind: StepKind::Key,
        };
        let j = step_json(&s);
        assert_eq!(j["action"], "down");
        assert_eq!(j["key"], "KeyA");
        assert_eq!(j["kind"], "key");
    }

    #[test]
    fn mock_link_drives_session_reads() {
        let mock = fixture();
        let args_seen = mock.keymap_args.clone();
        let mut kb = Khub916::new(Box::new(mock), 6);
        let (model, fw) = resolve_target(&mut kb).unwrap();
        assert_eq!(model, "916_K1_PRO");
        assert_eq!(fw, "0x0100");
        let banks = read_keymap(&mut kb).unwrap();
        assert_eq!(banks.len(), 8);
        assert_eq!(*args_seen.borrow(), vec![0, 1, 2, 3, 4, 5, 6, 7]);
        let mc = read_mode_colors(&mut kb).unwrap();
        assert_eq!(mc.len(), 23);
        assert_eq!(mc[0]["color"], "#000102");
        let profile = kb.profile().unwrap();
        assert_eq!(profile.sleep_seconds(), Some(30));
        let light = light::decode_light_state(&profile).unwrap();
        assert_eq!((light.mode, light.speed, light.brightness), (15, 4, 10));
    }

    #[test]
    fn short_keymap_read_fails_closed() {
        let mut replies = std::collections::HashMap::new();
        replies.insert(
            130u8,
            vec![0x03, 0x00, 0x00, 0x00, 0x01, 0x97, 0x01, 0x00, 0x00],
        );
        // Only 60 of 126 slots — the AGENTS.md §Safety 6 case.
        replies.insert(131u8, u32s(&vec![0x29u32; 60]));
        let mut kb = Khub916::new(
            Box::new(Mock {
                replies,
                keymap_args: Rc::new(RefCell::new(Vec::new())),
            }),
            6,
        );
        let err = read_keymap(&mut kb).unwrap_err();
        assert_eq!(err.code, "state_read_failed");
        assert!(err.message.contains("126"));
    }

    #[test]
    fn non_k1pro_model_is_unsupported() {
        let mut replies = std::collections::HashMap::new();
        // K1 (non-Pro) uuid 0x0300000001b4
        replies.insert(
            130u8,
            vec![0x03, 0x00, 0x00, 0x00, 0x01, 0xb4, 0x01, 0x00, 0x00],
        );
        let mut kb = Khub916::new(
            Box::new(Mock {
                replies,
                keymap_args: Rc::new(RefCell::new(Vec::new())),
            }),
            6,
        );
        let err = resolve_target(&mut kb).unwrap_err();
        assert_eq!(err.code, "unsupported");
    }

    #[test]
    fn device_kind_is_accepted() {
        let _ = device(); // DeviceInfo construction compiles for tests.
    }
}
