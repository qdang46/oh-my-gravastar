//! `omg device` — machine-readable device discovery.
//!
//! `catalog()` enumerates every supported GravaStar identity straight from
//! the `omg-hid` tables (single source of truth — no drift). Capability
//! maps mirror `docs/CAPABILITY-MATRIX.md` §3: `verified` is the strongest
//! evidence level (`live-verified` > `code-verified` > `code-tested` >
//! `unverified`); `supported:false` always carries a `reason` from the
//! fixed enum `unsupported-hardware | unsupported-firmware |
//! protocol-unknown | experimental | unverified | not-implemented`.
//! Blacklisted operations are reported with `"blacklisted": true`.

use omg_hid::devices::*;
use omg_hid::DeviceKind;
use serde_json::{json, Value};

/// Transport hint for a device kind.
fn transport(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::HeKeyboardV2
        | DeviceKind::CompxMouse
        | DeviceKind::Khub916Wired
        | DeviceKind::Khub916Screen => "usb",
        DeviceKind::SparkPlayJoy => "usb",
        DeviceKind::Khub916Wireless => "2.4 GHz dongle",
    }
}

fn wired(kind: DeviceKind) -> bool {
    !matches!(kind, DeviceKind::Khub916Wireless)
}

/// HID match rule for one family, mirroring `classify()`.
fn match_rule(kind: DeviceKind) -> Value {
    match kind {
        DeviceKind::HeKeyboardV2 => json!({
            "vids": HE_VIDS,
            "pids": HE_PIDS,
            "usage_page": format!("0x{HE_USAGE_PAGE:04x}"),
        }),
        DeviceKind::SparkPlayJoy => json!({
            "vids": "any",
            "pids": "any",
            "usage_page": format!("0x{SPARKPLAYJOY_USAGE_PAGE:04x}"),
            "usage": SPARKPLAYJOY_USAGE,
        }),
        DeviceKind::CompxMouse => json!({
            "vids": [MOUSE_VID],
            "pids": MOUSE_PIDS,
            "usage_page": format!("0x{MOUSE_USAGE_PAGE:04x}"),
        }),
        DeviceKind::Khub916Wired => json!({
            "vid_pid_pairs": KHUB916_WIRED.iter().map(|(v, p)| format!("0x{v:04x}:0x{p:04x}")).collect::<Vec<_>>(),
            "usage_page_min": format!("0x{KHUB916_WIRED_USAGE_PAGE_MIN:04x}"),
        }),
        DeviceKind::Khub916Wireless => json!({
            "vid_pid_pairs": KHUB916_WIRELESS.iter().map(|(v, p)| format!("0x{v:04x}:0x{p:04x}")).collect::<Vec<_>>(),
        }),
        DeviceKind::Khub916Screen => json!({
            "vid_pid_pairs": KHUB916_SCREEN.iter().map(|(v, p)| format!("0x{v:04x}:0x{p:04x}")).collect::<Vec<_>>(),
            "usage_page_min": format!("0x{KHUB916_WIRED_USAGE_PAGE_MIN:04x}"),
            "note": "separate write-only screen interface; shares VID/PID family with wired keyboards",
        }),
    }
}

/// Capability map for one device kind — the machine-readable mirror of
/// docs/CAPABILITY-MATRIX.md §3.
pub(crate) fn capabilities(kind: DeviceKind) -> Value {
    match kind {
        DeviceKind::Khub916Wired => json!({
            "verification": "live-verified",
            "keymap": {"supported": true, "verified": "live-verified", "layers": 4, "keys": 126},
            "keymap_write": {"supported": true, "verified": "live-verified", "read_back": true},
            "macro": {"supported": true, "verified": "live-verified", "max_bytes": 512},
            "per_key_rgb": {"supported": true, "verified": "live-verified", "slots": 126},
            "lighting_modes": {"supported": true, "verified": "live-verified", "count": 18},
            "lighting_json_apply": {"supported": true, "verified": "live-verified"},
            "music_reactive": {"supported": true, "verified": "live-verified", "cli_only": true},
            "adv_keys": {"supported": true, "verified": "code-tested",
                "detail": "codec+UI shipped; cmd-18 history write does not persist on K1 Pro (docs/advkeys-schema.md)"},
            "screen": {"supported": false, "reason": "unsupported-hardware",
                "detail": "K98 topology only; not this device"},
            "rapid_trigger": {"supported": false, "reason": "unsupported-hardware",
                "detail": "hall-effect only"},
            "actuation": {"supported": false, "reason": "unsupported-hardware"},
            "calibration": {"supported": false, "reason": "unsupported-hardware"},
            "polling": {"supported": false, "reason": "protocol-unknown",
                "detail": "no polling command known for khub916"},
            "wireless": {"supported": false, "reason": "not-implemented",
                "detail": "wired interface only; 916_wireLess is a separate transport"},
            "sleep_timer": {"supported": true, "verified": "live-verified"},
            "profile_export": {"supported": true, "verified": "live-verified"},
            "profile_import": {"supported": false, "reason": "not-implemented",
                "detail": "export-only; no whole-profile mapping"},
            "factory_reset": {"supported": false, "blacklisted": true, "reason": "not-implemented",
                "detail": "cmd 17 exists (fire-and-forget, no read-back) but reset coverage is unverified — see docs/research/reset-coverage.md; L4-blocked pending reset_verified evidence"},
        }),
        DeviceKind::Khub916Screen => json!({
            "verification": "code-verified",
            "note": "write-only image target; no query path (docs/protocol-khub916-screen.md §1)",
            "screen_image_push": {"supported": false, "reason": "not-implemented",
                "detail": "GIF->RGB565 frame pipeline not implemented; fire-and-forget writes have no read-back verify"},
            "screen_info": {"supported": true, "verified": "code-verified",
                "detail": "capability report via the paired wired keyboard interface"},
        }),
        DeviceKind::Khub916Wireless => json!({
            "verification": "code-verified",
            "note": "916_wireLess transport is code-verified but not implemented in omg yet",
            "all_commands": {"supported": false, "reason": "not-implemented",
                "detail": "916_wireLess transport (19-byte output reports) is a separate bead — docs/protocol-khub916.md §3/§7"},
        }),
        DeviceKind::HeKeyboardV2 => json!({
            "verification": "code-tested",
            "device_info": {"supported": true, "verified": "code-tested"},
            "keymap": {"supported": true, "verified": "code-tested", "read_back": true},
            "keymap_write": {"supported": true, "verified": "code-tested", "read_back": true},
            "macro": {"supported": true, "verified": "code-tested", "paged": true},
            "advanced_keys": {"supported": true, "verified": "code-tested",
                "detail": "inferred from the vendor v2 web driver; hardware-unverified"},
            "per_key_rgb": {"supported": true, "verified": "code-tested",
                "detail": "palette + zones (no per-key matrix)"},
            "lighting": {"supported": true, "verified": "code-tested", "effects": 16, "zones": 3},
            "polling": {"supported": true, "verified": "code-tested",
                "detail": "keyboard restarts and drops off the bus; unverified read-back is expected"},
            "os_mode": {"supported": true, "verified": "code-tested"},
            "actuation": {"supported": true, "verified": "code-tested"},
            "rapid_trigger": {"supported": true, "verified": "code-tested"},
            "deadzones": {"supported": true, "verified": "code-tested"},
            "live_travel": {"supported": true, "verified": "code-tested"},
            "calibration": {"supported": true, "verified": "code-tested"},
            "analog_matrix": {"supported": false, "reason": "unsupported-hardware",
                "detail": "hall-effect keyboard; the 6x21 analog matrix is the separate SparkPlayJoy interface"},
            "profile_export": {"supported": true, "verified": "code-tested"},
            "profile_import": {"supported": true, "verified": "code-tested"},
            "factory_reset": {"supported": false, "blacklisted": true, "reason": "not-implemented",
                "detail": "protocol blacklist: 02 01, 08 xx, 0A 01 01 FF, 10 02, 02 0F 01, 02 09, categories 0x0C/0x0E/0x0F"},
        }),
        DeviceKind::SparkPlayJoy => json!({
            "verification": "code-verified",
            "note": "read-only analog protocol; transport code-verified, sustained runtime pending",
            "identity": {"supported": true, "verified": "code-verified"},
            "analog_matrix_6x21": {"supported": true, "verified": "code-verified", "unit": "um"},
            "travel": {"supported": true, "verified": "code-verified"},
            "writes": {"supported": false, "reason": "not-implemented",
                "detail": "read-only protocol — no write path exists"},
        }),
        DeviceKind::CompxMouse => json!({
            "verification": "code-tested",
            "device_info": {"supported": true, "verified": "code-tested"},
            "battery": {"supported": true, "verified": "code-tested"},
            "firmware": {"supported": true, "verified": "code-tested"},
            "config": {"supported": true, "verified": "code-tested", "read_back": true},
            "polling": {"supported": true, "verified": "code-tested", "read_back": true},
            "dpi_stages": {"supported": true, "verified": "code-tested", "max_stages": 8},
            "lighting": {"supported": true, "verified": "code-tested"},
            "macros": {"supported": true, "verified": "code-tested", "detail": "flash-backed"},
            "profile_export": {"supported": true, "verified": "code-tested"},
            "profile_import": {"supported": true, "verified": "code-tested"},
            "pairing": {"supported": false, "blacklisted": true, "reason": "not-implemented",
                "detail": "protocol blacklist: cmds 05/06"},
            "factory_reset": {"supported": false, "blacklisted": true, "reason": "not-implemented",
                "detail": "protocol blacklist: cmd 09"},
            "rf_channel": {"supported": false, "blacklisted": true, "reason": "not-implemented",
                "detail": "protocol blacklist: cmd 31"},
            "bootloader": {"supported": false, "blacklisted": true, "reason": "not-implemented",
                "detail": "protocol blacklist: B0-B7"},
        }),
    }
}

/// Stable snake_case id for a device kind (JSON `kind` field).
pub(crate) fn kind_id(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::HeKeyboardV2 => "he_keyboard_v2",
        DeviceKind::SparkPlayJoy => "sparkplayjoy_6x21",
        DeviceKind::CompxMouse => "compx_mouse",
        DeviceKind::Khub916Wired => "khub916_wired",
        DeviceKind::Khub916Wireless => "khub916_wireless",
        DeviceKind::Khub916Screen => "khub916_screen",
    }
}

/// Protocol family string for a kind (matches docs/protocol-*.md names).
pub(crate) fn protocol(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::HeKeyboardV2 => "he_v2",
        DeviceKind::SparkPlayJoy => "sparkplayjoy_6x21",
        DeviceKind::CompxMouse => "compx_mouse",
        DeviceKind::Khub916Wired | DeviceKind::Khub916Screen => "khub916",
        DeviceKind::Khub916Wireless => "khub916_wireless",
    }
}

/// `omg device list` document: every supported family with its HID match
/// rule, transport hints and capability summary.
pub(crate) fn catalog_doc() -> Value {
    let kinds = [
        DeviceKind::Khub916Wired,
        DeviceKind::Khub916Screen,
        DeviceKind::Khub916Wireless,
        DeviceKind::HeKeyboardV2,
        DeviceKind::SparkPlayJoy,
        DeviceKind::CompxMouse,
    ];
    let families: Vec<Value> = kinds
        .iter()
        .map(|&k| {
            json!({
                "kind": kind_id(k),
                "kind_label": k.label(),
                "protocol": protocol(k),
                "transport": transport(k),
                "wired": wired(k),
                "wireless": !wired(k),
                "match": match_rule(k),
                "capabilities": capabilities(k),
            })
        })
        .collect();
    json!({
        "schema_version": 1,
        "kind": "omg.device.catalog",
        "source": "omg-hid identity tables (crates/hid/src/devices.rs)",
        "families": families,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_covers_every_kind() {
        let doc = catalog_doc();
        let families = doc["families"].as_array().unwrap();
        assert_eq!(families.len(), 6);
        for f in families {
            for key in [
                "kind",
                "kind_label",
                "protocol",
                "transport",
                "wired",
                "match",
                "capabilities",
            ] {
                assert!(f.get(key).is_some(), "family missing {key}: {f}");
            }
            assert!(f["capabilities"].is_object());
        }
    }

    #[test]
    fn khub916_wired_is_live_verified() {
        let caps = capabilities(DeviceKind::Khub916Wired);
        assert_eq!(caps["verification"], "live-verified");
        assert_eq!(caps["keymap_write"]["verified"], "live-verified");
        assert_eq!(caps["screen"]["supported"], false);
        assert_eq!(caps["screen"]["reason"], "unsupported-hardware");
        assert_eq!(caps["factory_reset"]["blacklisted"], true);
    }

    #[test]
    fn honesty_levels_never_overclaim() {
        // Only wired khub916 may claim live-verified (CAPABILITY-MATRIX.md).
        for kind in [
            DeviceKind::HeKeyboardV2,
            DeviceKind::SparkPlayJoy,
            DeviceKind::CompxMouse,
            DeviceKind::Khub916Wireless,
            DeviceKind::Khub916Screen,
        ] {
            let caps = capabilities(kind);
            assert_ne!(caps["verification"], "live-verified", "{kind:?}");
            let s = caps.to_string();
            assert!(
                !s.contains("\"verified\":\"live-verified\""),
                "{kind:?}: {s}"
            );
        }
        // Every supported:false entry must carry a reason.
        for kind in [
            DeviceKind::Khub916Wired,
            DeviceKind::Khub916Screen,
            DeviceKind::Khub916Wireless,
            DeviceKind::HeKeyboardV2,
            DeviceKind::SparkPlayJoy,
            DeviceKind::CompxMouse,
        ] {
            for (name, cap) in capabilities(kind).as_object().unwrap() {
                if name == "verification" || name == "note" {
                    continue;
                }
                let cap = cap.as_object().unwrap();
                if cap.get("supported") == Some(&json!(false)) {
                    assert!(
                        cap.get("reason").is_some() || cap.get("blacklisted") == Some(&json!(true)),
                        "{kind:?}.{name} unsupported without reason"
                    );
                }
            }
        }
    }
}
