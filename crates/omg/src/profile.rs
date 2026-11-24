//! Unified profile export/import (F7, docs/plan.md §3).
//!
//! Schema v1:
//!
//! ```json
//! {
//!   "schema": 1,
//!   "exported_at": "2026-11-24T12:00:00Z",
//!   "host": "…",
//!   "devices": [
//!     {
//!       "protocol": "khub916" | "he-v2" | "compx" | "sparkplayjoy",
//!       "vid": 9610, "pid": 268, "usage_page": 65280, "usage": 0,
//!       "model": "…",
//!       "profiles": [{ "name": "current", "state": { … } }],
//!       "note" | "error": "…"   // optional
//!     }
//!   ]
//! }
//! ```
//!
//! Per-device `state` is protocol-specific and captures every readable
//! setting (see the `*_state` functions). Writes on import go through each
//! proto crate's setters with read-back verification; khub916 and
//! sparkplayjoy are never written (khub916 proto writes are
//! hardware-unverified, sparkplayjoy is read-only).

use std::path::Path;

use anyhow::{anyhow, bail, Result};
use omg_hid::DeviceKind;
use omg_proto_he as he;
use omg_proto_khub916 as khub;
use omg_proto_mouse as pm;
use omg_proto_sparkplayjoy as spj;
use serde_json::{json, Map, Value};

pub const SCHEMA_VERSION: u32 = 1;

/// Human-readable reason khub916 entries are never written on import.
pub const KHUB916_WRITE_SKIP: &str =
    "khub916 writes not yet safe: proto writes are hardware-unverified (docs/protocol-khub916.md §8); this protocol is export-only for now";

/// SparkPlayJoy has no write path at all (read-only protocol).
pub const SPARK_WRITE_SKIP: &str = "sparkplayjoy protocol is read-only; nothing to apply";

// ── Protocol naming / matching ─────────────────────────────────────────

/// Stable protocol id used in profile files.
pub fn protocol_of(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::HeKeyboardV2 => "he-v2",
        DeviceKind::SparkPlayJoy => "sparkplayjoy",
        DeviceKind::CompxMouse => "compx",
        DeviceKind::Khub916Wired | DeviceKind::Khub916Wireless => "khub916",
        DeviceKind::Khub916Screen => "khub916-screen",
    }
}

/// Device kinds a profile-file `protocol` string may match.
pub fn kinds_for_protocol(protocol: &str) -> Vec<DeviceKind> {
    match protocol {
        "he-v2" => vec![DeviceKind::HeKeyboardV2],
        "compx" => vec![DeviceKind::CompxMouse],
        "sparkplayjoy" => vec![DeviceKind::SparkPlayJoy],
        "khub916" => vec![DeviceKind::Khub916Wired, DeviceKind::Khub916Wireless],
        "khub916-screen" => vec![DeviceKind::Khub916Screen],
        _ => vec![],
    }
}

/// Does a connected device match a profile-file device entry?
/// Matches protocol family + VID + PID + usage page (when the file has one).
pub fn device_matches_entry(
    kind: DeviceKind,
    vid: u16,
    pid: u16,
    usage_page: u16,
    entry: &Value,
) -> bool {
    let Some(kinds) = entry
        .get("protocol")
        .and_then(Value::as_str)
        .map(kinds_for_protocol)
    else {
        return false;
    };
    if !kinds.contains(&kind) {
        return false;
    }
    let eq = |key: &str, v: u64| entry.get(key).and_then(Value::as_u64) == Some(v);
    if !eq("vid", vid as u64) || !eq("pid", pid as u64) {
        return false;
    }
    match entry.get("usage_page").and_then(Value::as_u64) {
        Some(page) => page == usage_page as u64,
        None => true,
    }
}

// ── File load / validate ───────────────────────────────────────────────

/// Read and validate a profile file. `schema` must be exactly 1.
pub fn load_profile(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow!("cannot read {}: {e}", path.display()))?;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| anyhow!("{}: invalid JSON: {e}", path.display()))?;
    validate_profile(&v)?;
    Ok(v)
}

/// Schema checks shared by load and tests.
pub fn validate_profile(v: &Value) -> Result<()> {
    let schema = v
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("profile file: missing integer \"schema\""))?;
    if schema != SCHEMA_VERSION as u64 {
        bail!(
            "profile file: unsupported schema {schema} (this omg understands schema {SCHEMA_VERSION})"
        );
    }
    let devices = v
        .get("devices")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("profile file: missing \"devices\" array"))?;
    if devices.is_empty() {
        bail!("profile file: \"devices\" is empty");
    }
    for (i, d) in devices.iter().enumerate() {
        let protocol = d
            .get("protocol")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("devices[{i}]: missing \"protocol\" string"))?;
        if kinds_for_protocol(protocol).is_empty() {
            bail!("devices[{i}]: unknown protocol '{protocol}'");
        }
        for key in ["vid", "pid"] {
            let n = d
                .get(key)
                .and_then(Value::as_u64)
                .ok_or_else(|| anyhow!("devices[{i}]: missing integer '{key}'"))?;
            if n > 0xFFFF {
                bail!("devices[{i}]: '{key}' {n} out of range");
            }
        }
        if let Some(page) = d.get("usage_page") {
            let n = page
                .as_u64()
                .ok_or_else(|| anyhow!("devices[{i}]: 'usage_page' must be an integer"))?;
            if n > 0xFFFF {
                bail!("devices[{i}]: 'usage_page' {n} out of range");
            }
        }
        match d.get("profiles") {
            None | Some(Value::Null) => {}
            Some(Value::Array(ps)) => {
                for (j, p) in ps.iter().enumerate() {
                    if p.get("state").map(|s| s.is_object()) != Some(true) {
                        bail!("devices[{i}].profiles[{j}]: missing object \"state\"");
                    }
                }
            }
            _ => bail!("devices[{i}]: 'profiles' must be an array"),
        }
    }
    Ok(())
}

// ── Small JSON helpers ─────────────────────────────────────────────────

fn u64_at(v: &Value, key: &str) -> Result<u64> {
    v.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("missing or non-integer field '{key}'"))
}

fn f64_at(v: &Value, key: &str) -> Result<f64> {
    v.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| anyhow!("missing or non-number field '{key}'"))
}

fn bool_at(v: &Value, key: &str) -> Result<bool> {
    v.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| anyhow!("missing or non-bool field '{key}'"))
}

fn arr_at<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    v.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("missing or non-array field '{key}'"))
}

/// Wrap one export read: `Ok` serialises, `Err` becomes `{"error": "…"}`
/// so one failed section does not hide the rest of the backup.
fn sec<T: serde::Serialize>(r: Result<T>) -> Value {
    match r {
        Ok(v) => serde_json::to_value(v).unwrap_or(Value::Null),
        Err(e) => json!({ "error": format!("{e:#}") }),
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_u32(v: u32) -> String {
    format!("0x{v:08X}")
}

// ── UTC timestamp / host ───────────────────────────────────────────────

/// `YYYY-MM-DDTHH:MM:SSZ` in UTC, computed without extra dependencies.
pub fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Compact timestamp for backup directory names: `YYYYMMDDTHHMMSSZ`.
pub fn utc_stamp() -> String {
    utc_now().replace(['-', ':'], "")
}

/// Best-effort host name for the export header. HOSTNAME is often a
/// non-exported shell variable, so fall back to the `hostname` command.
pub fn host_name() -> String {
    if let Ok(h) = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")) {
        if !h.is_empty() {
            return h;
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

// ── Export: per-protocol state capture ─────────────────────────────────

/// HE keyboard v2: identity, profiles, polling, OS, lighting (all zones +
/// palettes), geometry, keymap (layers 0-3) and per-key performance for
/// every physical slot.
pub fn he_state(kb: &mut he::HeKeyboard) -> Result<Value> {
    let mut st = Map::new();

    st.insert(
        "info".into(),
        sec(kb.info().map(|i| {
            json!({
                "firmware": i.firmware,
                "pcb": i.pcb,
                "build_time": i.build_time,
                "protocol": i.protocol,
                "board_id": format!("0x{:08X}", i.board_id),
            })
        })),
    );
    st.insert(
        "profile".into(),
        sec((|| {
            Ok(json!({
                "count": kb.profile_count()?,
                "active": kb.profile()?,
            }))
        })()),
    );
    st.insert(
        "polling".into(),
        sec((|| {
            let current = kb.report_rate()?;
            let supported = kb.report_rates()?;
            Ok(json!({
                "current": current,
                "current_hz": rate_hz(current),
                "supported_ids": supported,
                "supported_hz": supported.iter().map(|&i| rate_hz(i)).collect::<Vec<_>>(),
            }))
        })()),
    );
    st.insert(
        "os".into(),
        sec(kb
            .system()
            .map(|v| json!({ "os": if v == 0 { "windows" } else { "macos" }, "os_id": v }))),
    );
    st.insert("rt_precision_mm".into(), sec(kb.rt_precision()));
    st.insert("lighting_sleep_minutes".into(), sec(kb.lighting_sleep()));

    let areas = match kb.lighting_areas() {
        Ok(a) => a,
        Err(e) => {
            st.insert(
                "lighting_areas".into(),
                json!({ "error": format!("{e:#}") }),
            );
            st.insert("lighting".into(), Value::Null);
            // Geometry/perf still work without the zone list.
            let slots = match kb.key_slots() {
                Ok(s) => s,
                Err(e2) => {
                    st.insert("key_slots".into(), json!({ "error": format!("{e2:#}") }));
                    st.insert("keymap".into(), Value::Null);
                    st.insert("perf".into(), Value::Null);
                    return Ok(Value::Object(st));
                }
            };
            return he_geometry_state(kb, &mut st, &slots);
        }
    };
    let mut lighting = Vec::new();
    for a in &areas {
        let base = sec(kb.lighting(a.index).map(|l| light_json(&l)));
        let palette = sec(kb
            .palette(a.index)
            .map(|p| p.iter().map(rgb_hex).collect::<Vec<_>>()));
        lighting.push(
            json!({ "area": a.index, "effects": a.count, "lighting": base, "palette": palette }),
        );
    }
    st.insert(
        "lighting_areas".into(),
        json!(areas
            .iter()
            .map(|a| json!({"index": a.index, "effects": a.count}))
            .collect::<Vec<_>>()),
    );
    st.insert("lighting".into(), Value::Array(lighting));

    // Geometry + keymap. Rows come from the slot table; layers 0-3 are read
    // (the vendor layout has four layers; out-of-range layers error inline).
    let slots = match kb.key_slots() {
        Ok(s) => s,
        Err(e) => {
            st.insert("key_slots".into(), json!({ "error": format!("{e:#}") }));
            st.insert("keymap".into(), Value::Null);
            st.insert("perf".into(), Value::Null);
            return Ok(Value::Object(st));
        }
    };
    he_geometry_state(kb, &mut st, &slots)
}

/// Shared tail of [`he_state`]: key slots, keymap layers and per-key perf.
fn he_geometry_state(
    kb: &mut he::HeKeyboard,
    st: &mut Map<String, Value>,
    slots: &[he::KeySlot],
) -> Result<Value> {
    st.insert(
        "key_slots".into(),
        json!(slots
            .iter()
            .map(|s| {
                let (w, h, _) = omg_model::key_size(s.size);
                json!({
                    "row": s.row, "col": s.col, "x": s.x, "y": s.y,
                    "size": s.size, "w": w, "h": h,
                })
            })
            .collect::<Vec<_>>()),
    );

    let mut rows: Vec<u8> = slots.iter().map(|s| s.row).collect();
    rows.sort_unstable();
    rows.dedup();
    let mut keymap = Vec::new();
    for layer in 0..4u8 {
        for &row in &rows {
            match kb.key_codes(layer, row) {
                Ok(codes) => keymap.push(json!({
                    "layer": layer, "row": row,
                    "codes": codes.iter().map(|&c| json!(c)).collect::<Vec<_>>(),
                })),
                Err(e) => keymap.push(json!({
                    "layer": layer, "row": row, "error": format!("{e:#}"),
                })),
            }
        }
    }
    st.insert("keymap".into(), Value::Array(keymap));

    // Per-key performance for every physical slot — the point of a backup.
    let mut perf = Vec::with_capacity(slots.len());
    for s in slots {
        match kb.key_perf(s.row, s.col) {
            Ok(p) => perf.push(json!({
                "row": s.row, "col": s.col,
                "perf": perf_json(&p),
            })),
            Err(e) => perf.push(json!({
                "row": s.row, "col": s.col, "error": format!("{e:#}"),
            })),
        }
    }
    st.insert("perf".into(), Value::Array(perf));
    Ok(Value::Object(std::mem::take(st)))
}

fn rate_hz(id: u8) -> u32 {
    match id {
        0 => 8000,
        1 => 4000,
        2 => 2000,
        3 => 1000,
        4 => 500,
        5 => 250,
        6 => 125,
        _ => 0,
    }
}

fn perf_json(p: &he::KeyPerf) -> Value {
    json!({
        "mode": if p.mode == he::MODE_RAPID { "rt" } else { "fixed" },
        "mode_id": p.mode,
        "normal_press": p.normal_press,
        "normal_release": p.normal_release,
        "rt_first_touch": p.rt_first_touch,
        "rt_press": p.rt_press,
        "rt_release": p.rt_release,
        "press_deadzone": p.press_deadzone,
        "release_deadzone": p.release_deadzone,
        "axis": p.axis,
        "calibrate": p.calibrate,
        "axis_v2_id": p.axis_v2_id,
        "axis_range_max": p.axis_range_max,
        "axis_coefficient": p.axis_coefficient,
        "max_travel_mm": omg_model::max_travel(p.axis_v2_id),
    })
}

fn light_json(l: &he::LightingBase) -> Value {
    json!({
        "on": l.on,
        "mode": l.mode,
        "brightness": l.brightness,
        "speed": l.speed,
        "direction": if l.direction == 0 { "fwd" } else { "back" },
        "direction_id": l.direction,
        "color_index": l.color_index,
    })
}

fn rgb_hex(c: &he::Rgb) -> String {
    format!("#{:02X}{:02X}{:02X}", c.r, c.g, c.b)
}

/// Compx mouse: identity, full decoded flash config, battery, firmware.
pub fn mouse_state(m: &mut pm::CompxMouse) -> Result<Value> {
    let identity = sec(m.identify());
    // identify() also caches the sensor for clamping; config does not need it.
    let config = m.read_config()?;
    let battery = sec(m.battery());
    let firmware = sec(m
        .firmware()
        .map(|(mouse, dongle)| json!({ "mouse": mouse, "receiver": dongle })));
    Ok(json!({
        "identity": identity,
        "config": serde_json::to_value(&config)?,
        "battery": battery,
        "firmware": firmware,
    }))
}

/// khub916 wired: device info, all 8 keymap args, profile blob, power,
/// per-key light colours; `--full` adds the light-data and macro blobs.
pub fn khub916_state(kb: &mut khub::Khub916, full: bool) -> Result<Value> {
    let mut st = Map::new();
    st.insert("device_info".into(), sec(kb.device_info()));

    let mut keymap = Map::new();
    for arg in 0..8u8 {
        keymap.insert(
            arg.to_string(),
            sec(kb
                .key_values(arg)
                .map(|vs| vs.iter().map(|&v| hex_u32(v)).collect::<Vec<_>>())),
        );
    }
    st.insert("keymap".into(), Value::Object(keymap));

    st.insert(
        "profile".into(),
        sec(kb.profile().map(|p| {
            json!({
                "bytes": p.raw.len(),
                "light_mode": p.light_mode(),
                "sleep_seconds": p.sleep_seconds(),
                "hex": hex_bytes(&p.raw),
            })
        })),
    );
    st.insert("power".into(), sec(kb.power()));
    st.insert("light_colors".into(), sec(kb.custom_light_colors()));
    if full {
        st.insert(
            "light_data_hex".into(),
            sec(kb.light_color_data().map(|b| hex_bytes(&b))),
        );
        st.insert(
            "macro_hex".into(),
            sec(kb.macro_region().map(|b| hex_bytes(&b))),
        );
    }
    Ok(Value::Object(st))
}

/// SparkPlayJoy 6x21: sync (serial redacted — privacy rule), scale,
/// default map and the active Fn0 map. Read-only protocol; live travel is
/// deliberately not part of a profile.
pub fn spark_state(sp: &mut spj::SparkPlayJoy) -> Result<Value> {
    let sync = sec(sp.sync().map(|s| {
        json!({
            "board_id": format!("0x{:08X}", s.board_id),
            "platform": s.platform,
            "app_version": s.app_version,
            "build_label": s.build_label,
            "serial": "[redacted]",
        })
    }));
    let scale = sec(sp.scale());
    let maps = sec((|| {
        let map = sp.default_map()?;
        let active = sp.active_map(&map)?;
        Ok(json!({
            "default_map": map,
            "active_map": active,
        }))
    })());
    Ok(json!({ "sync": sync, "scale": scale, "maps": maps }))
}

// ── Import: Compx mouse ────────────────────────────────────────────────

/// Parse the `config` object of a mouse device state into a MouseConfig.
pub fn mouse_config_from_json(v: &Value) -> Result<pm::MouseConfig> {
    let c = v
        .get("config")
        .ok_or_else(|| anyhow!("mouse state: missing 'config' object"))?;
    let u32s = |key: &str| -> Result<Vec<u32>> {
        arr_at(c, key)?
            .iter()
            .map(|x| {
                x.as_u64()
                    .map(|n| n as u32)
                    .ok_or_else(|| anyhow!("mouse config: '{key}' entries must be integers"))
            })
            .collect()
    };
    let rgbs = |key: &str| -> Result<Vec<pm::Rgb>> {
        arr_at(c, key)?
            .iter()
            .enumerate()
            .map(|(i, x)| {
                let get = |k: &str| -> Result<u8> {
                    x.get(k)
                        .and_then(Value::as_u64)
                        .map(|n| n as u8)
                        .ok_or_else(|| anyhow!("mouse config: '{key}[{i}].{k}' missing"))
                };
                Ok(pm::Rgb {
                    r: get("r")?,
                    g: get("g")?,
                    b: get("b")?,
                })
            })
            .collect()
    };
    let dpi = u32s("dpi")?;
    let dpi_colors = rgbs("dpi_colors")?;
    if dpi.len() != pm::MAX_STAGES || dpi_colors.len() != pm::MAX_STAGES {
        bail!(
            "mouse config: dpi/dpi_colors must have {} entries (got {}/{})",
            pm::MAX_STAGES,
            dpi.len(),
            dpi_colors.len()
        );
    }
    let buttons_v = arr_at(c, "buttons")?;
    if buttons_v.len() != pm::BUTTON_SLOTS {
        bail!(
            "mouse config: buttons must have {} entries (got {})",
            pm::BUTTON_SLOTS,
            buttons_v.len()
        );
    }
    let mut buttons = [pm::Button::default(); pm::BUTTON_SLOTS];
    for (i, b) in buttons_v.iter().enumerate() {
        buttons[i] = pm::Button {
            kind: u64_at(b, "kind")? as u8,
            param: u64_at(b, "param")? as u16,
        };
    }
    let light_v = c
        .get("light")
        .ok_or_else(|| anyhow!("mouse config: missing 'light'"))?;
    let light_color = {
        let o = light_v
            .get("color")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("mouse config: 'light.color' missing"))?;
        let comp = |k: &str| -> Result<u8> {
            o.get(k)
                .and_then(Value::as_u64)
                .map(|n| n as u8)
                .ok_or_else(|| anyhow!("mouse config: 'light.color.{k}' missing"))
        };
        pm::Rgb {
            r: comp("r")?,
            g: comp("g")?,
            b: comp("b")?,
        }
    };
    Ok(pm::MouseConfig {
        report_rate: u64_at(c, "report_rate")? as u32,
        stage_count: u64_at(c, "stage_count")? as usize,
        current_stage: u64_at(c, "current_stage")? as usize,
        dpi: dpi.try_into().expect("length checked"),
        dpi_colors: dpi_colors.try_into().expect("length checked"),
        lod: u64_at(c, "lod")? as u8,
        light: pm::Light {
            on: bool_at(light_v, "on")?,
            mode: u64_at(light_v, "mode")? as u8,
            color: light_color,
            speed: u64_at(light_v, "speed")? as u8,
            brightness: u64_at(light_v, "brightness")? as u8,
        },
        debounce: u64_at(c, "debounce")? as u8,
        motion_sync: bool_at(c, "motion_sync")?,
        sleep: u64_at(c, "sleep")? as u8,
        angle_snap: bool_at(c, "angle_snap")?,
        ripple: bool_at(c, "ripple")?,
        light_off_moving: bool_at(c, "light_off_moving")?,
        sensor_mode: u64_at(c, "sensor_mode")? as u8,
        buttons,
    })
}

/// Field-by-field diff between current and wanted config (human strings).
pub fn mouse_changes(current: &pm::MouseConfig, want: &pm::MouseConfig) -> Vec<String> {
    let mut out = Vec::new();
    let mut diff = |name: &str, a: String, b: String| {
        if a != b {
            out.push(format!("{name}: {a} -> {b}"));
        }
    };
    diff(
        "report_rate",
        format!("{}", current.report_rate),
        format!("{}", want.report_rate),
    );
    diff(
        "stage_count",
        format!("{}", current.stage_count),
        format!("{}", want.stage_count),
    );
    diff(
        "current_stage",
        format!("{}", current.current_stage),
        format!("{}", want.current_stage),
    );
    diff("lod", format!("{}", current.lod), format!("{}", want.lod));
    diff(
        "debounce",
        format!("{}", current.debounce),
        format!("{}", want.debounce),
    );
    diff(
        "sleep",
        format!("{}", current.sleep),
        format!("{}", want.sleep),
    );
    diff(
        "sensor_mode",
        format!("{}", current.sensor_mode),
        format!("{}", want.sensor_mode),
    );
    for name in ["motion_sync", "angle_snap", "ripple", "light_off_moving"] {
        let (a, b) = match name {
            "motion_sync" => (current.motion_sync, want.motion_sync),
            "angle_snap" => (current.angle_snap, want.angle_snap),
            "ripple" => (current.ripple, want.ripple),
            _ => (current.light_off_moving, want.light_off_moving),
        };
        if a != b {
            out.push(format!("{name}: {} -> {}", yn(a), yn(b)));
        }
    }
    for i in 0..pm::MAX_STAGES {
        if current.dpi[i] != want.dpi[i] {
            out.push(format!("dpi[{i}]: {} -> {}", current.dpi[i], want.dpi[i]));
        }
        if current.dpi_colors[i] != want.dpi_colors[i] {
            out.push(format!(
                "dpi_color[{i}]: {} -> {}",
                current.dpi_colors[i].to_hex(),
                want.dpi_colors[i].to_hex()
            ));
        }
    }
    let cl = &current.light;
    let wl = &want.light;
    if cl != wl {
        out.push(format!(
            "light: on={} mode={} color={} speed={} brightness={} -> on={} mode={} color={} speed={} brightness={}",
            cl.on, cl.mode, cl.color.to_hex(), cl.speed, cl.brightness,
            wl.on, wl.mode, wl.color.to_hex(), wl.speed, wl.brightness,
        ));
    }
    for i in 0..pm::BUTTON_SLOTS {
        if current.buttons[i] != want.buttons[i] {
            out.push(format!(
                "button[{i}]: kind={} param=0x{:04x} -> kind={} param=0x{:04x}",
                current.buttons[i].kind,
                current.buttons[i].param,
                want.buttons[i].kind,
                want.buttons[i].param,
            ));
        }
    }
    out
}

fn yn(b: bool) -> &'static str {
    if b {
        "on"
    } else {
        "off"
    }
}

/// Validate a wanted config against the mouse identity (sensor limits,
/// link rate) before anything is sent. Returns human-readable problems.
pub fn mouse_validate(want: &pm::MouseConfig, id: &pm::Identity) -> Vec<String> {
    let mut problems = Vec::new();
    if !pm::REPORT_RATES.contains(&want.report_rate) {
        problems.push(format!(
            "report_rate {} Hz is not a valid rate ({:?})",
            want.report_rate,
            pm::REPORT_RATES
        ));
    } else if want.report_rate > id.max_rate {
        problems.push(format!(
            "report_rate {} Hz exceeds this link's max {} Hz",
            want.report_rate, id.max_rate
        ));
    }
    if !(1..=pm::MAX_STAGES).contains(&want.stage_count) {
        problems.push(format!(
            "stage_count {} out of range 1..={}",
            want.stage_count,
            pm::MAX_STAGES
        ));
    }
    if want.current_stage >= pm::MAX_STAGES {
        problems.push(format!(
            "current_stage {} out of range 0..{}",
            want.current_stage,
            pm::MAX_STAGES - 1
        ));
    }
    if !id.sensor.lod.iter().any(|(v, _)| *v == want.lod) {
        problems.push(format!(
            "lod {} is not valid for {} (valid: {:?})",
            want.lod, id.sensor.name, id.sensor.lod
        ));
    }
    if want.debounce > 15 {
        problems.push(format!("debounce {} out of range 0..=15", want.debounce));
    }
    if !pm::SLEEP_TIMES.contains(&want.sleep) {
        problems.push(format!(
            "sleep {} is not a valid timeout (valid raw values: {:?})",
            want.sleep,
            pm::SLEEP_TIMES
        ));
    }
    if want.sensor_mode > 1 {
        problems.push(format!(
            "sensor_mode {} out of range 0..=1",
            want.sensor_mode
        ));
    }
    if want.light.speed > 9 || want.light.brightness > 9 {
        problems.push("light speed/brightness must be 0..=9".to_string());
    }
    problems
}

/// Apply a full mouse config through the proto setters, safest order first.
pub fn mouse_apply(m: &mut pm::CompxMouse, want: &pm::MouseConfig) -> Result<()> {
    m.set_report_rate(want.report_rate)?;
    m.set_stage_count(want.stage_count)?;
    for i in 0..pm::MAX_STAGES {
        m.set_dpi(i, want.dpi[i])?;
        m.set_dpi_color(i, want.dpi_colors[i])?;
    }
    m.set_current_stage(want.current_stage)?;
    m.set_lod(want.lod)?;
    m.set_light(&want.light)?;
    m.set_debounce(want.debounce)?;
    m.set_flag(pm::addr::MOTION_SYNC, want.motion_sync)?;
    m.set_flag(pm::addr::ANGLE_SNAP, want.angle_snap)?;
    m.set_flag(pm::addr::RIPPLE, want.ripple)?;
    m.set_flag(pm::addr::LIGHT_OFF_MOVING, want.light_off_moving)?;
    m.set_sleep(want.sleep)?;
    m.set_sensor_mode(want.sensor_mode)?;
    for (i, b) in want.buttons.iter().enumerate() {
        m.set_button(i, *b)?;
    }
    Ok(())
}

/// Read the config back and list fields that differ from `want`.
/// Empty vec = verified.
pub fn mouse_verify(m: &mut pm::CompxMouse, want: &pm::MouseConfig) -> Result<Vec<String>> {
    let after = m.read_config()?;
    Ok(mouse_changes(&after, want))
}

// ── Import: HE keyboard ────────────────────────────────────────────────

/// One pending HE write, already validated and diffed against the device.
#[derive(Clone, Debug)]
pub enum HeWrite {
    /// Switch the active profile.
    Profile(u8),
    /// Change the polling rate id (0=8K … 6=125). The keyboard restarts.
    Polling(u8),
    /// OS mode: 0 = Windows, 1 = macOS.
    Os(u8),
    /// Lighting sleep timeout in minutes.
    LightSleep(u16),
    /// One lighting zone (+ optional palette replacement).
    Lighting {
        area: u8,
        base: he::LightingBase,
        palette: Option<Vec<he::Rgb>>,
    },
    /// One key's performance settings (full record incl. switch echoes).
    Perf { row: u8, col: u8, perf: he::KeyPerf },
}

impl HeWrite {
    pub fn describe(&self) -> String {
        match self {
            HeWrite::Profile(i) => format!("profile -> {}", i + 1),
            HeWrite::Polling(id) => format!("polling -> {} Hz", rate_hz(*id)),
            HeWrite::Os(v) => format!("os -> {}", if *v == 0 { "windows" } else { "macos" }),
            HeWrite::LightSleep(m) => format!("lighting sleep -> {m} min"),
            HeWrite::Lighting {
                area,
                base,
                palette,
            } => format!(
                "lighting area {area}: on={} mode={} brightness={} speed={} dir={} color={}{}",
                base.on,
                base.mode,
                base.brightness,
                base.speed,
                if base.direction == 0 { "fwd" } else { "back" },
                base.color_index,
                if palette.is_some() { " +palette" } else { "" }
            ),
            HeWrite::Perf { row, col, perf } => format!(
                "perf r{row} c{col}: mode={} actuation={:.3}mm",
                if perf.mode == he::MODE_RAPID {
                    "rt"
                } else {
                    "fixed"
                },
                if perf.mode == he::MODE_RAPID {
                    perf.rt_first_touch
                } else {
                    perf.normal_press
                }
            ),
        }
    }
}

/// Diff an exported HE `state` object against the live keyboard.
/// Returns the writes to perform plus human-readable notes (skipped or
/// unreadable sections). Read-only by itself — sends nothing.
pub fn he_plan(kb: &mut he::HeKeyboard, state: &Value) -> Result<(Vec<HeWrite>, Vec<String>)> {
    let mut writes = Vec::new();
    let mut notes = Vec::new();

    if let Some(p) = state.get("profile") {
        if p.get("error").is_some() {
            notes.push("profile section unreadable at export; skipped".into());
        } else if let Ok(active) = u64_at(p, "active") {
            let current = kb.profile()?;
            if current as u64 != active {
                writes.push(HeWrite::Profile(active as u8));
            }
        }
    }
    if let Some(p) = state.get("polling") {
        if p.get("error").is_some() {
            notes.push("polling section unreadable at export; skipped".into());
        } else if let Ok(current) = u64_at(p, "current") {
            let supported = kb.report_rates()?;
            if supported.contains(&(current as u8)) {
                if kb.report_rate()? != current as u8 {
                    writes.push(HeWrite::Polling(current as u8));
                }
            } else {
                notes.push(format!(
                    "polling id {current} is not in this keyboard's supported list; skipped"
                ));
            }
        }
    }
    if let Some(o) = state.get("os") {
        if o.get("error").is_some() {
            notes.push("os section unreadable at export; skipped".into());
        } else if let Ok(v) = u64_at(o, "os_id") {
            if kb.system()? != v as u8 {
                writes.push(HeWrite::Os(v as u8));
            }
        }
    }
    if let Some(v) = state.get("lighting_sleep_minutes") {
        if v.get("error").is_some() {
            notes.push("lighting_sleep_minutes unreadable at export; skipped".into());
        } else if let Some(minutes) = v.as_u64() {
            if !omg_model::LIGHT_SLEEP_MINUTES.contains(&(minutes as u16)) {
                notes.push(format!(
                    "lighting sleep {minutes} min is not a valid option; skipped"
                ));
            } else if kb.lighting_sleep()? != minutes as u16 {
                writes.push(HeWrite::LightSleep(minutes as u16));
            }
        }
    }

    // Lighting zones: compare base settings and palette per area.
    if let Some(areas) = state.get("lighting").and_then(Value::as_array) {
        for entry in areas {
            let area = match entry.get("area").and_then(Value::as_u64) {
                Some(a) => a as u8,
                None => continue,
            };
            if entry.get("lighting").and_then(|l| l.get("error")).is_some() {
                notes.push(format!(
                    "lighting area {area} unreadable at export; skipped"
                ));
                continue;
            }
            let l = match entry.get("lighting") {
                Some(l) if l.is_object() => l,
                _ => continue,
            };
            let want_base = match lighting_base_from_json(l) {
                Ok(b) => b,
                Err(e) => {
                    notes.push(format!("lighting area {area}: {e:#}; skipped"));
                    continue;
                }
            };
            let want_palette = match entry.get("palette") {
                Some(Value::Array(cols)) => {
                    let mut p = Vec::with_capacity(cols.len());
                    let mut ok = true;
                    for c in cols {
                        match c.as_str().and_then(parse_hex_color) {
                            Some(rgb) => p.push(rgb),
                            None => {
                                notes.push(format!(
                                    "lighting area {area}: bad palette colour; palette skipped"
                                ));
                                ok = false;
                                break;
                            }
                        }
                    }
                    if ok && p.len() == 8 {
                        Some(p)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            let current = kb.lighting(area)?;
            let palette_changed = match &want_palette {
                Some(want) => kb.palette(area).map(|cur| cur != *want).unwrap_or(true),
                None => false,
            };
            if current != want_base || palette_changed {
                writes.push(HeWrite::Lighting {
                    area,
                    base: want_base,
                    palette: if palette_changed { want_palette } else { None },
                });
            }
        }
    }

    // Per-key performance for every exported slot.
    if let Some(perf) = state.get("perf").and_then(Value::as_array) {
        for entry in perf {
            if entry.get("error").is_some() {
                continue;
            }
            let (row, col) = match (
                entry.get("row").and_then(Value::as_u64),
                entry.get("col").and_then(Value::as_u64),
            ) {
                (Some(r), Some(c)) => (r as u8, c as u8),
                _ => continue,
            };
            let want = match entry
                .get("perf")
                .ok_or_else(|| anyhow!("missing perf"))
                .and_then(perf_from_json)
            {
                Ok(p) => p,
                Err(e) => {
                    notes.push(format!("perf r{row} c{col}: {e:#}; skipped"));
                    continue;
                }
            };
            match kb.key_perf(row, col) {
                Ok(current) if current == want => {}
                Ok(_) => writes.push(HeWrite::Perf {
                    row,
                    col,
                    perf: want,
                }),
                Err(e) => notes.push(format!("perf r{row} c{col}: read failed: {e:#}; skipped")),
            }
        }
    }

    // Sections the v2 proto API cannot write back.
    if state
        .get("keymap")
        .and_then(Value::as_array)
        .is_some_and(|k| !k.is_empty())
    {
        notes.push(
            "keymap captured but not applied: the proto has no keymap write API (03 02/03 04 are documented but unimplemented)"
                .into(),
        );
    }
    if state.get("key_slots").is_some() {
        notes.push("key geometry is firmware-owned; not applied".into());
    }
    Ok((writes, notes))
}

/// Parse one exported perf record back into a KeyPerf with range checks.
fn perf_from_json(v: &Value) -> Result<he::KeyPerf> {
    let mode = match v.get("mode_id").and_then(Value::as_u64) {
        Some(m) => m as u8,
        None => match v.get("mode").and_then(Value::as_str) {
            Some("rt") => he::MODE_RAPID,
            Some("fixed") => he::MODE_FIXED,
            _ => bail!("perf: missing 'mode_id'"),
        },
    };
    if mode > he::MODE_RAPID {
        bail!("perf: invalid mode {mode}");
    }
    let axis_v2_id = u64_at(v, "axis_v2_id")? as u16;
    let limit = omg_model::max_travel(axis_v2_id);
    let dist = |key: &str| -> Result<f32> {
        let x = f64_at(v, key)? as f32;
        if !(0.0..=limit).contains(&x) {
            bail!("perf.{key} {x} out of range 0..={limit} mm for this switch");
        }
        Ok(x)
    };
    let dz = |key: &str| -> Result<f32> {
        let x = f64_at(v, key)? as f32;
        if !(0.0..=omg_model::DEADZONE_MAX).contains(&x) {
            bail!(
                "perf.{key} {x} out of range 0..={:.1} mm",
                omg_model::DEADZONE_MAX
            );
        }
        Ok(x)
    };
    Ok(he::KeyPerf {
        mode,
        normal_press: dist("normal_press")?,
        normal_release: dist("normal_release")?,
        rt_first_touch: dist("rt_first_touch")?,
        rt_press: dist("rt_press")?,
        rt_release: dist("rt_release")?,
        press_deadzone: dz("press_deadzone")?,
        release_deadzone: dz("release_deadzone")?,
        axis: u64_at(v, "axis")? as u8,
        calibrate: u64_at(v, "calibrate")? as u8,
        axis_v2_id,
        axis_range_max: u64_at(v, "axis_range_max")? as u16,
        axis_coefficient: u64_at(v, "axis_coefficient")? as u16,
    })
}

/// Parse one exported lighting record into a LightingBase with range checks.
fn lighting_base_from_json(v: &Value) -> Result<he::LightingBase> {
    let on = bool_at(v, "on")?;
    let mode = u64_at(v, "mode")? as u8;
    let brightness = u64_at(v, "brightness")? as u8;
    let speed = u64_at(v, "speed")? as u8;
    let color_index = u64_at(v, "color_index")? as u8;
    if brightness > 100 {
        bail!("lighting brightness {brightness} out of range 0..=100");
    }
    if speed > 100 {
        bail!("lighting speed {speed} out of range 0..=100");
    }
    if color_index > 7 {
        bail!("lighting color_index {color_index} out of range 0..=7");
    }
    let direction = match v.get("direction_id").and_then(Value::as_u64) {
        Some(d) => d as u8,
        None => match v.get("direction").and_then(Value::as_str) {
            Some("fwd") => 0,
            Some("back") => 1,
            _ => bail!("lighting: missing 'direction'/'direction_id'"),
        },
    };
    if direction > 1 {
        bail!("lighting direction {direction} out of range 0..=1");
    }
    Ok(he::LightingBase {
        on,
        mode,
        brightness,
        speed,
        direction,
        color_index,
    })
}

/// `#rrggbb` → he::Rgb.
fn parse_hex_color(s: &str) -> Option<he::Rgb> {
    let t = s.trim().strip_prefix('#')?;
    if t.len() != 6 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(t, 16).ok()?;
    Some(he::Rgb {
        r: ((v >> 16) & 0xff) as u8,
        g: ((v >> 8) & 0xff) as u8,
        b: (v & 0xff) as u8,
    })
}

/// Execute planned HE writes. Each write is followed by a read-back
/// verify; polling is applied last because the keyboard restarts.
/// Returns one result line per write.
pub fn he_apply(kb: &mut he::HeKeyboard, writes: &[HeWrite]) -> Result<Vec<String>> {
    // Order: everything except polling first, polling last (restart drops
    // the keyboard off the bus).
    let mut ordered: Vec<&HeWrite> = writes
        .iter()
        .filter(|w| !matches!(w, HeWrite::Polling(_)))
        .collect();
    for w in writes.iter().filter(|w| matches!(w, HeWrite::Polling(_))) {
        ordered.push(w);
    }
    let mut results = Vec::with_capacity(ordered.len());
    for w in ordered {
        let line = match w {
            HeWrite::Profile(index) => {
                kb.set_profile(*index)?;
                let actual = kb.profile()?;
                if actual == *index {
                    format!("{}: verified", w.describe())
                } else {
                    format!("{}: FAILED (read back {})", w.describe(), actual)
                }
            }
            HeWrite::Os(v) => {
                kb.set_system(*v)?;
                let actual = kb.system()?;
                if actual == *v {
                    format!("{}: verified", w.describe())
                } else {
                    format!("{}: FAILED (read back {actual})", w.describe())
                }
            }
            HeWrite::LightSleep(minutes) => {
                kb.set_lighting_sleep(*minutes)?;
                let actual = kb.lighting_sleep()?;
                if actual == *minutes {
                    format!("{}: verified", w.describe())
                } else {
                    format!("{}: FAILED (read back {actual})", w.describe())
                }
            }
            HeWrite::Lighting {
                area,
                base,
                palette,
            } => {
                kb.set_lighting(*area, base)?;
                let mut ok = kb.lighting(*area).map(|l| l == *base).unwrap_or(false);
                if let Some(p) = palette {
                    kb.set_palette(*area, p)?;
                    ok = ok && kb.palette(*area).map(|cur| cur == *p).unwrap_or(false);
                }
                if ok {
                    format!("{}: verified", w.describe())
                } else {
                    format!("{}: FAILED (read-back mismatch)", w.describe())
                }
            }
            HeWrite::Perf { row, col, perf } => {
                kb.set_key_perf(*row, *col, perf)?;
                // Rate-limit like the official driver (~5 ms/key).
                std::thread::sleep(std::time::Duration::from_millis(5));
                match kb.key_perf(*row, *col) {
                    Ok(actual) if actual == *perf => format!("{}: verified", w.describe()),
                    Ok(_) => format!("{}: FAILED (read-back mismatch)", w.describe()),
                    Err(e) => format!("{}: FAILED (verify read: {e:#})", w.describe()),
                }
            }
            HeWrite::Polling(id) => {
                kb.set_report_rate(*id)?; // NoAnswer tolerated inside proto
                match kb.report_rate() {
                    Ok(actual) if actual == *id => format!("{}: verified", w.describe()),
                    Ok(actual) => format!("{}: FAILED (read back {actual})", w.describe()),
                    Err(e) if e.is::<omg_hid::NoAnswer>() => {
                        format!("{}: sent, unverified (keyboard restarted)", w.describe())
                    }
                    Err(e) => return Err(e),
                }
            }
        };
        results.push(line);
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use omg_hid::Link;
    use std::time::Duration;

    // ── Schema validation ─────────────────────────────────────────────

    fn valid_doc() -> Value {
        json!({
            "schema": 1,
            "exported_at": "2026-11-24T00:00:00Z",
            "host": "test",
            "devices": [{
                "protocol": "khub916",
                "vid": 0x258a, "pid": 0x010c,
                "usage_page": 0xff00, "usage": 0,
                "model": "Gaming Keyboard",
                "profiles": [{ "name": "current", "state": { "power": { "percent": 100, "flags": 17 } } }],
            }],
        })
    }

    #[test]
    fn schema_accepts_valid_doc() {
        validate_profile(&valid_doc()).unwrap();
    }

    #[test]
    fn schema_rejects_wrong_version() {
        let mut d = valid_doc();
        d["schema"] = json!(2);
        assert!(validate_profile(&d)
            .unwrap_err()
            .to_string()
            .contains("schema 2"));
        d["schema"] = json!("1");
        assert!(validate_profile(&d).is_err());
    }

    #[test]
    fn schema_rejects_bad_protocol_and_shape() {
        let mut d = valid_doc();
        d["devices"][0]["protocol"] = json!("nope");
        assert!(validate_profile(&d).is_err());

        let mut d = valid_doc();
        d["devices"][0]["vid"] = json!(0x1_0000);
        assert!(validate_profile(&d).is_err());

        let mut d = valid_doc();
        d["devices"][0]["profiles"] = json!([{ "name": "x" }]); // no state
        assert!(validate_profile(&d).is_err());

        let mut d = valid_doc();
        d["devices"] = json!([]);
        assert!(validate_profile(&d).is_err());
        d = valid_doc();
        d.as_object_mut().unwrap().remove("devices");
        assert!(validate_profile(&d).is_err());
    }

    #[test]
    fn protocol_mapping_roundtrip() {
        assert_eq!(protocol_of(DeviceKind::HeKeyboardV2), "he-v2");
        assert_eq!(protocol_of(DeviceKind::CompxMouse), "compx");
        assert_eq!(protocol_of(DeviceKind::SparkPlayJoy), "sparkplayjoy");
        assert_eq!(protocol_of(DeviceKind::Khub916Wired), "khub916");
        assert_eq!(protocol_of(DeviceKind::Khub916Wireless), "khub916");
        assert!(kinds_for_protocol("he-v2").contains(&DeviceKind::HeKeyboardV2));
        assert!(kinds_for_protocol("khub916").contains(&DeviceKind::Khub916Wireless));
        assert!(kinds_for_protocol("bogus").is_empty());
    }

    #[test]
    fn device_entry_matching() {
        let d = valid_doc();
        let e = &d["devices"][0];
        assert!(device_matches_entry(
            DeviceKind::Khub916Wired,
            0x258a,
            0x010c,
            0xff00,
            e
        ));
        assert!(!device_matches_entry(
            DeviceKind::Khub916Wired,
            0x258a,
            0x010c,
            0x0001, // wrong usage page
            e
        ));
        assert!(!device_matches_entry(
            DeviceKind::HeKeyboardV2,
            0x258a,
            0x010c,
            0xff00,
            e
        ));
        // usage_page absent in file → matches on vid/pid/kind alone.
        let mut e2 = e.clone();
        e2.as_object_mut().unwrap().remove("usage_page");
        assert!(device_matches_entry(
            DeviceKind::Khub916Wireless,
            0x258a,
            0x010c,
            0x1234,
            &e2
        ));
    }

    // ── Mouse config JSON roundtrip ───────────────────────────────────

    #[test]
    fn mouse_config_json_roundtrip() {
        let want = pm::MouseConfig {
            report_rate: 2000,
            stage_count: 3,
            current_stage: 1,
            dpi: [800, 1600, 3200, 6400, 12800, 0, 0, 0],
            dpi_colors: [
                pm::Rgb { r: 255, g: 0, b: 0 },
                pm::Rgb { r: 0, g: 255, b: 0 },
                pm::Rgb::default(),
                pm::Rgb::default(),
                pm::Rgb::default(),
                pm::Rgb::default(),
                pm::Rgb::default(),
                pm::Rgb::default(),
            ],
            lod: 1,
            light: pm::Light {
                on: true,
                mode: 3,
                color: pm::Rgb { r: 1, g: 2, b: 3 },
                speed: 5,
                brightness: 7,
            },
            debounce: 4,
            motion_sync: true,
            sleep: 6,
            angle_snap: false,
            ripple: true,
            light_off_moving: false,
            sensor_mode: 1,
            buttons: [
                pm::Button {
                    kind: 1,
                    param: 0x0100,
                },
                pm::Button::default(),
                pm::Button {
                    kind: 2,
                    param: 0x0100,
                },
                pm::Button::default(),
                pm::Button::default(),
                pm::Button::default(),
            ],
        };
        let v = json!({ "config": serde_json::to_value(&want).unwrap() });
        let got = mouse_config_from_json(&v).unwrap();
        // No PartialEq on MouseConfig; compare via re-serialization.
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            serde_json::to_value(&want).unwrap()
        );
    }

    #[test]
    fn mouse_config_json_rejects_bad_shape() {
        assert!(mouse_config_from_json(&json!({})).is_err());
        let v = json!({ "config": { "dpi": [1,2,3] } });
        assert!(mouse_config_from_json(&v).is_err());
    }

    // ── HE perf / lighting JSON roundtrip ─────────────────────────────

    #[test]
    fn he_perf_json_roundtrip() {
        let p = he::KeyPerf {
            mode: he::MODE_RAPID,
            normal_press: 1.5,
            normal_release: 0.0,
            rt_first_touch: 0.8,
            rt_press: 0.2,
            rt_release: 1.0,
            press_deadzone: 0.1,
            release_deadzone: 0.05,
            axis: 3,
            calibrate: 1,
            axis_v2_id: 13232, // UFO switch → 3.5 mm limit
            axis_range_max: 3400,
            axis_coefficient: 42,
        };
        let j = perf_json(&p);
        let back = perf_from_json(&j).unwrap();
        assert_eq!(back, p);
        // Out-of-range actuation is rejected.
        let mut bad = j.clone();
        bad["normal_press"] = json!(9.9);
        assert!(perf_from_json(&bad).is_err());
        // Deadzone above 1 mm rejected.
        let mut bad = j.clone();
        bad["press_deadzone"] = json!(1.5);
        assert!(perf_from_json(&bad).is_err());
    }

    #[test]
    fn he_lighting_json_roundtrip() {
        let l = he::LightingBase {
            on: true,
            mode: 4,
            brightness: 80,
            speed: 30,
            direction: 1,
            color_index: 5,
        };
        let j = light_json(&l);
        assert_eq!(lighting_base_from_json(&j).unwrap(), l);
        let mut bad = j.clone();
        bad["color_index"] = json!(9);
        assert!(lighting_base_from_json(&bad).is_err());
        let mut bad = j.clone();
        bad["direction"] = json!("sideways");
        bad.as_object_mut().unwrap().remove("direction_id");
        assert!(lighting_base_from_json(&bad).is_err());
    }

    // ── khub916 export through a scripted feature-report link ─────────

    /// Scripted khub916 link: answers feature exchanges by request header.
    struct KhubMock {
        sent: Vec<(u8, Vec<u8>)>,
    }

    impl Link for KhubMock {
        fn write(&mut self, _id: u8, _data: &[u8]) -> Result<()> {
            Ok(())
        }
        fn read(&mut self, _t: Duration) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        fn feature_exchange(
            &mut self,
            report_id: u8,
            payload: &[u8],
            _t: Duration,
        ) -> Result<Option<Vec<u8>>> {
            self.sent.push((report_id, payload.to_vec()));
            let cmd = payload[0];
            let arg = payload[1];
            // Echo the 7-byte header, then the payload.
            let mut resp = payload[..7].to_vec();
            match cmd {
                // device info (130): uuid K1 Pro + version + screen 0
                130 => {
                    resp.extend_from_slice(&[0x03, 0x00, 0x00, 0x00, 0x01, 0x97, 0x01, 0x00, 0x00])
                }
                // keymap read (131): 8 u32 BE values
                131 => {
                    for v in [
                        0x29u32,
                        0x35,
                        0x2B,
                        0x39,
                        0x0001_0004,
                        0x0D00_0000,
                        0,
                        0xDEAD_BEEF,
                    ] {
                        resp.extend_from_slice(&v.to_be_bytes());
                    }
                }
                // profile read (132): 128 bytes, sleep=30 at offset 24
                132 => {
                    let mut p = vec![0u8; 128];
                    p[24] = 30;
                    resp.extend_from_slice(&p);
                }
                // power read (135)
                135 => resp.extend_from_slice(&[0x64, 0x11]),
                // custom light read (134): 378 plane bytes
                134 => resp.extend_from_slice(&[0x5Au8; 378]),
                // light data read (138)
                138 => resp.extend_from_slice(&[0xA5u8; 480]),
                // macro read (133)
                133 => resp.extend_from_slice(&[0x3Cu8; 512]),
                _ => bail!("mock: unexpected cmd {cmd}"),
            }
            let _ = arg;
            Ok(Some(resp))
        }
    }

    #[test]
    fn khub916_state_captures_all_sections() {
        let link = Box::new(KhubMock { sent: Vec::new() });
        let mut kb = khub::Khub916::new(link, 6);
        let st = khub916_state(&mut kb, false).unwrap();

        let info = &st["device_info"];
        assert_eq!(info["catalog_model"], "916_K1_PRO");
        assert_eq!(info["uuid"], "0x030000000197");

        // All 8 keymap args captured.
        let km = st["keymap"].as_object().unwrap();
        assert_eq!(km.len(), 8);
        assert_eq!(km["0"].as_array().unwrap().len(), 8);
        assert_eq!(km["0"][0], "0x00000029");
        assert_eq!(km["7"][7], "0xDEADBEEF");

        assert_eq!(st["profile"]["bytes"], 128);
        assert_eq!(st["profile"]["sleep_seconds"], 30);
        assert_eq!(st["profile"]["hex"].as_str().unwrap().len(), 256);

        assert_eq!(st["power"]["percent"], 100);
        assert_eq!(st["light_colors"].as_array().unwrap().len(), 126);

        // --full blobs are absent without the flag.
        assert!(st.get("light_data_hex").is_none());
        assert!(st.get("macro_hex").is_none());
    }

    #[test]
    fn khub916_state_full_adds_blobs() {
        let link = Box::new(KhubMock { sent: Vec::new() });
        let mut kb = khub::Khub916::new(link, 6);
        let st = khub916_state(&mut kb, true).unwrap();
        assert_eq!(st["light_data_hex"].as_str().unwrap().len(), 960);
        assert_eq!(st["macro_hex"].as_str().unwrap().len(), 1024);
    }

    #[test]
    fn utc_timestamp_format() {
        let ts = utc_now();
        // YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert_eq!(utc_stamp().len(), 16);
    }
}
