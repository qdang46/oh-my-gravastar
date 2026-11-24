//! `omg kb916 light` — decoded lighting state and JSON-driven light
//! configuration (docs/lighting-schema.md, docs/protocol-khub916.md §6).
//!
//! `light get` merges three reads: the profile light state (cmd 132),
//! the per-mode light-data blob (cmd 138, 21-byte groups) and the custom
//! per-key colours (cmd 134). `light apply` takes a JSON config, resolves
//! every field against the current device state, then performs the
//! vendor-equivalent writes — cmd 6 custom colours, cmd 4 profile fields,
//! cmd 10 per-mode group colour — each fire-and-forget followed by a
//! read-back verify inside the proto crate.
//!
//! Wired transport only; the 916_wireLess session is refused by
//! [`crate::kb916_session`] like every other kb916 command.

use anyhow::{anyhow, bail, Result};
use omg_proto_khub916 as khub;
use omg_proto_khub916::light as khub_light;
use omg_proto_mouse as pm;
use serde::Deserialize;
use serde_json::{json, Value};
use std::process::ExitCode;

use crate::{kb916_session, print_json, Cli, Kb916Light};

// ── JSON schema (docs/lighting-schema.md) ──────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LightConfig {
    /// Schema version; must be 1 when present.
    schema: Option<u32>,
    /// Effect mode id (vendor table: 0=off, 1=always_on, …, 277=custom).
    /// Absent = keep the current mode.
    mode: Option<u16>,
    /// Effect speed 0-20 (vendor limit; only the low nibble is stored).
    speed: Option<u8>,
    /// Brightness 0-20 (raw wire byte, vendor limit).
    brightness: Option<u8>,
    /// Colour model: 1 = monochrome (single `color`, written into the
    /// cmd-138 group), 2 = colour mixing. Absent = the mode's vendor
    /// default, or the current model when no mode is given.
    color_model: Option<u8>,
    /// Single colour for `color_model` 1: `"#rrggbb"`, `"rrggbb"`,
    /// `"r,g,b"` or `{"r":n,"g":n,"b":n}`.
    color: Option<Value>,
    /// Per-key custom colours (cmd 6) — mainly for mode 277 "custom".
    keys: Option<KeysSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeysSpec {
    /// Client-side preset generating all 126 slot colours:
    /// `"solid"`, `"gradient"` or `"rainbow"`.
    preset: Option<String>,
    /// Base colour: solid fill, or gradient start when `to` is given.
    color: Option<Value>,
    /// Gradient end colour (with `preset:"gradient"`).
    to: Option<Value>,
    /// Explicit sparse overrides applied on top of the preset/current
    /// table: `[{"index":N,"color":…}]` or `[{"pos":N,"color":…}]`
    /// (vendor `pos = 8 + index*4`).
    entries: Option<Vec<KeyEntry>>,
    /// Explicit full table: exactly 126 colours in slot order.
    colors: Option<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyEntry {
    /// 0-based slot index (0..125).
    index: Option<usize>,
    /// Vendor position `8 + index*4`.
    pos: Option<u16>,
    /// `"#rrggbb"`, `"rrggbb"`, `"r,g,b"` or `{"r":n,"g":n,"b":n}`.
    color: Value,
}

// ── Colour helpers ─────────────────────────────────────────────────────

fn parse_color(v: &Value, what: &str) -> Result<pm::Rgb> {
    match v {
        Value::String(s) => pm::Rgb::parse(s).map_err(|e| anyhow!("{what}: {e:#}")),
        Value::Object(map) => {
            let get = |k: &str| -> Result<u8> {
                map.get(k)
                    .and_then(Value::as_u64)
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or_else(|| anyhow!("{what}: colour object needs integer '{k}' 0-255"))
            };
            Ok(pm::Rgb {
                r: get("r")?,
                g: get("g")?,
                b: get("b")?,
            })
        }
        _ => bail!("{what}: colour must be a string or {{\"r\":…}} object"),
    }
}

fn rgb_json(c: pm::Rgb) -> Value {
    json!({ "r": c.r, "g": c.g, "b": c.b, "hex": c.to_hex() })
}

fn hsv(hue: f32, sat: f32, val: f32) -> pm::Rgb {
    let h = (hue.rem_euclid(360.0)) / 60.0;
    let i = h.floor() as i32;
    let f = h - i as f32;
    let p = val * (1.0 - sat);
    let q = val * (1.0 - sat * f);
    let t = val * (1.0 - sat * (1.0 - f));
    let (r, g, b) = match i.rem_euclid(6) {
        0 => (val, t, p),
        1 => (q, val, p),
        2 => (p, val, t),
        3 => (p, q, val),
        4 => (t, p, val),
        _ => (val, p, q),
    };
    pm::Rgb {
        r: (r * 255.0).round().clamp(0.0, 255.0) as u8,
        g: (g * 255.0).round().clamp(0.0, 255.0) as u8,
        b: (b * 255.0).round().clamp(0.0, 255.0) as u8,
    }
}

fn lerp(a: pm::Rgb, b: pm::Rgb, t: f32) -> pm::Rgb {
    let ch = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t).round() as u8;
    pm::Rgb {
        r: ch(a.r, b.r),
        g: ch(a.g, b.g),
        b: ch(a.b, b.b),
    }
}

/// Build the 126-slot custom colour table for a [`KeysSpec`]. `current`
/// is the device's existing table, used as the base for sparse `entries`.
fn build_custom_colors(
    spec: &KeysSpec,
    current: &[pm::Rgb],
) -> Result<Vec<pm::Rgb>> {
    let mut out: Vec<pm::Rgb> = if let Some(list) = &spec.colors {
        if list.len() != khub_light::CUSTOM_LIGHT_SLOTS {
            bail!(
                "keys.colors must contain exactly {} colours, got {}",
                khub_light::CUSTOM_LIGHT_SLOTS,
                list.len()
            );
        }
        list.iter()
            .enumerate()
            .map(|(i, v)| parse_color(v, &format!("keys.colors[{i}]")))
            .collect::<Result<_>>()?
    } else {
        match spec.preset.as_deref() {
            Some("solid") => {
                let c = match &spec.color {
                    Some(v) => parse_color(v, "keys.color")?,
                    None => pm::Rgb {
                        r: 255,
                        g: 255,
                        b: 255,
                    },
                };
                vec![c; khub_light::CUSTOM_LIGHT_SLOTS]
            }
            Some("gradient") => {
                let from = match &spec.color {
                    Some(v) => parse_color(v, "keys.color")?,
                    None => pm::Rgb {
                        r: 255,
                        g: 0,
                        b: 0,
                    },
                };
                let to = match &spec.to {
                    Some(v) => parse_color(v, "keys.to")?,
                    None => pm::Rgb {
                        r: 0,
                        g: 0,
                        b: 255,
                    },
                };
                (0..khub_light::CUSTOM_LIGHT_SLOTS)
                    .map(|i| {
                        let t = i as f32 / (khub_light::CUSTOM_LIGHT_SLOTS - 1) as f32;
                        lerp(from, to, t)
                    })
                    .collect()
            }
            Some("rainbow") => (0..khub_light::CUSTOM_LIGHT_SLOTS)
                .map(|i| hsv(i as f32 * 360.0 / khub_light::CUSTOM_LIGHT_SLOTS as f32, 1.0, 1.0))
                .collect(),
            Some(other) => bail!(
                "unknown keys.preset '{other}' (want solid|gradient|rainbow)"
            ),
            None => current.to_vec(),
        }
    };
    if out.len() != khub_light::CUSTOM_LIGHT_SLOTS {
        bail!("internal: custom colour table has {} slots", out.len());
    }
    if let Some(entries) = &spec.entries {
        for (i, e) in entries.iter().enumerate() {
            let idx = match (e.index, e.pos) {
                (Some(i), None) => i,
                (None, Some(p)) => {
                    if p < 8 || (p - 8) % 4 != 0 {
                        bail!("keys.entries[{i}].pos {p} is not a key position (want 8+4n)");
                    }
                    ((p - 8) / 4) as usize
                }
                (Some(_), Some(_)) => {
                    bail!("keys.entries[{i}] sets both index and pos — pick one")
                }
                (None, None) => bail!("keys.entries[{i}] needs index or pos"),
            };
            if idx >= khub_light::CUSTOM_LIGHT_SLOTS {
                bail!(
                    "keys.entries[{i}] slot {idx} out of range 0..{}",
                    khub_light::CUSTOM_LIGHT_SLOTS - 1
                );
            }
            out[idx] = parse_color(&e.color, &format!("keys.entries[{i}].color"))?;
        }
    }
    Ok(out)
}

// ── Commands ───────────────────────────────────────────────────────────

/// `omg kb916 light get` — full decoded lighting state.
pub fn cmd_get(cli: &Cli) -> Result<ExitCode> {
    let (device, mut kb) = match kb916_session(cli)? {
        Ok(s) => s,
        Err(code) => return Ok(code),
    };
    let profile = kb.profile()?;
    let light_blob = kb.light_color_data()?;
    let custom = kb.custom_light_colors()?;
    let state = khub_light::decode_light_state(&profile);
    let info = state.and_then(|s| khub_light::light_mode_info(s.mode));
    let data = khub_light::decode_light_data(&light_blob);
    let non_black = custom.iter().filter(|c| !(c.r == 0 && c.g == 0 && c.b == 0)).count();

    let state_json = state.map(|s| {
        json!({
            "mode": s.mode,
            "mode_name": info.map(|m| m.name),
            "color_support": info.map(|m| m.color_support),
            "speed": s.speed,
            "brightness": s.brightness,
            "color_model": s.color_model,
            "color_model_name": if s.color_model == khub_light::color_model::MONOCHROME { "monochrome" } else { "mixing" },
        })
    });
    let groups_json: Vec<Value> = data
        .groups
        .iter()
        .map(|g| {
            json!({
                "index": g.index,
                "offset": g.offset,
                "color": { "r": g.color.r, "g": g.color.g, "b": g.color.b, "hex": format!("#{:02x}{:02x}{:02x}", g.color.r, g.color.g, g.color.b) },
                "raw": g.raw.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            })
        })
        .collect();
    let colors_json: Vec<Value> = custom
        .iter()
        .map(|c| {
            json!({
                "index": c.index,
                "pos": c.pos,
                "r": c.r, "g": c.g, "b": c.b,
                "hex": format!("#{:02X}{:02X}{:02X}", c.r, c.g, c.b),
            })
        })
        .collect();

    if cli.json {
        print_json(&json!({
            "device": device,
            "light": state_json,
            "light_data": {
                "bytes": data.bytes,
                "group_stride": khub_light::LIGHT_GROUP_STRIDE,
                "group_count": data.groups.len(),
                "tail_len": data.tail_len,
                "groups": groups_json,
                "note": "per-mode 21-byte groups; bytes 0-2 are the mode RGB (vendor getGroupColor), the remaining 18 bytes are a constant firmware template",
            },
            "custom_colors": {
                "count": custom.len(),
                "non_black": non_black,
                "colors": colors_json,
            },
            "modes": khub_light::LIGHT_MODES,
        }))?;
    } else {
        match state {
            Some(s) => {
                let name = info.map(|m| m.name).unwrap_or("(unknown mode)");
                println!("light: mode {} ({name})", s.mode);
                println!(
                    "  speed {} · brightness {} · colour model {} ({})",
                    s.speed,
                    s.brightness,
                    s.color_model,
                    if s.color_model == khub_light::color_model::MONOCHROME {
                        "monochrome"
                    } else {
                        "mixing"
                    }
                );
            }
            None => println!("light: (profile too short to decode)"),
        }
        println!(
            "light data: {} bytes = {} × {}-byte groups (+{} tail)",
            data.bytes,
            data.groups.len(),
            khub_light::LIGHT_GROUP_STRIDE,
            data.tail_len
        );
        let distinct: std::collections::BTreeSet<(u8, u8, u8)> =
            data.groups.iter().map(|g| (g.color.r, g.color.g, g.color.b)).collect();
        if distinct.len() <= 4 {
            for c in &distinct {
                println!("  group colour #{:02X}{:02X}{:02X}", c.0, c.1, c.2);
            }
        } else {
            println!("  {} distinct group colours", distinct.len());
        }
        println!(
            "custom colours: {} entries, {} non-black",
            custom.len(),
            non_black
        );
    }
    Ok(ExitCode::SUCCESS)
}

/// `omg kb916 light apply <file.json> --yes` — apply a JSON lighting
/// config. Every field is resolved against the current device state
/// first; writes run cmd 6 → cmd 4 → cmd 10, each read-back verified.
pub fn cmd_apply(cli: &Cli, file: &str) -> Result<ExitCode> {
    // --yes gate BEFORE any device access (docs/plan.md §2).
    // (yes.yes checked by caller in cmd dispatch)
    let text = if file == "-" {
        std::io::read_to_string(std::io::stdin())
            .map_err(|e| anyhow!("cannot read light config from stdin: {e}"))?
    } else {
        std::fs::read_to_string(file)
            .map_err(|e| anyhow!("cannot read light config '{file}': {e}"))?
    };
    let cfg: LightConfig =
        serde_json::from_str(&text).map_err(|e| anyhow!("invalid light config JSON: {e}"))?;
    if let Some(v) = cfg.schema {
        if v != 1 {
            bail!("unsupported light config schema {v} (want 1)");
        }
    }
    if cfg.mode.is_none()
        && cfg.speed.is_none()
        && cfg.brightness.is_none()
        && cfg.color_model.is_none()
        && cfg.color.is_none()
        && cfg.keys.is_none()
    {
        bail!("light config is empty — nothing to apply");
    }
    if cfg.color_model == Some(0) || cfg.color_model.map(|m| m > 2).unwrap_or(false) {
        bail!("color_model must be 1 (monochrome) or 2 (mixing)");
    }

    let (device, mut kb) = match kb916_session(cli)? {
        Ok(s) => s,
        Err(code) => return Ok(code),
    };

    // ── Read current state ────────────────────────────────────────────
    let profile = kb.profile()?;
    let light_blob = kb.light_color_data()?;
    let custom_now = kb.custom_light_colors()?;
    let current = khub_light::decode_light_state(&profile)
        .ok_or_else(|| anyhow!("khub916 profile too short to decode light state"))?;

    // ── Resolve effective values ──────────────────────────────────────
    let mode = cfg.mode.unwrap_or(current.mode);
    let mode_info = khub_light::light_mode_info(mode);
    if cfg.mode.is_some() && mode_info.is_none() {
        // Not fatal — the wire accepts any u16 bounded by the record table —
        // but warn so agents notice a likely typo.
        eprintln!("warning: mode {mode} is not in the vendor 916 effect table");
    }
    let speed = cfg.speed.unwrap_or(current.speed);
    let brightness = cfg.brightness.unwrap_or(current.brightness);
    let color_model = match (cfg.color_model, cfg.color.is_some(), cfg.mode) {
        (Some(m), _, _) => m,
        (None, true, _) => khub_light::color_model::MONOCHROME,
        (None, false, Some(_)) => mode_info
            .map(|i| i.default_color_model)
            .unwrap_or(current.color_model),
        (None, false, None) => current.color_model,
    };
    if cfg.color.is_some() && color_model != khub_light::color_model::MONOCHROME {
        bail!("'color' only applies with color_model 1 (monochrome)");
    }
    if speed > 20 || brightness > 20 {
        bail!("speed/brightness must be ≤ 20 (vendor limit)");
    }

    // Profile blob — built BEFORE any write so a bad mode/speed fails
    // without touching the device.
    let profile_blob = profile.with_light_mode(
        mode,
        speed,
        brightness,
        color_model, // 1 → packed type 0, anything else → 7 (vendor rule)
    )?;

    // Optional group colour (cmd 10): only for monochrome + explicit colour.
    let group_rgb = match &cfg.color {
        Some(v) if color_model == khub_light::color_model::MONOCHROME => {
            let c = parse_color(v, "color")?;
            let trip = khub_light::RgbTrip {
                r: c.r,
                g: c.g,
                b: c.b,
            };
            let new_blob = khub_light::with_group_color(&light_blob, mode, trip)
                .ok_or_else(|| {
                    anyhow!(
                        "mode {mode} has no colour group in the {}-byte light blob \
                         (vendor: modes 0/19/275/277 and ids ≥23 carry no group)",
                        light_blob.len()
                    )
                })?;
            Some((trip, new_blob))
        }
        _ => None,
    };

    // Optional custom per-key colours (cmd 6).
    let mut new_custom: Option<Vec<pm::Rgb>> = None;
    let mut custom_unchanged = false;
    if let Some(spec) = &cfg.keys {
        let current_rgb: Vec<pm::Rgb> = custom_now
            .iter()
            .map(|c| pm::Rgb {
                r: c.r,
                g: c.g,
                b: c.b,
            })
            .collect();
        let built = build_custom_colors(spec, &current_rgb)?;
        // Skip the 378-byte write when the resolved table already matches
        // the device (e.g. `keys: {}` or a preset equal to current state).
        custom_unchanged = built == current_rgb;
        new_custom = Some(built);
    }

    // ── Writes: cmd 6 colours → cmd 4 profile → cmd 10 group colour ────
    let mut steps: Vec<Value> = Vec::new();
    let mut failed = false;

    if let Some(colors) = &new_custom {
        if custom_unchanged {
            steps.push(json!({ "step": "custom_colors", "skipped": "unchanged" }));
        } else {
            let wire: Vec<khub::Rgb> = colors
                .iter()
                .map(|c| khub::Rgb {
                    r: c.r,
                    g: c.g,
                    b: c.b,
                })
                .collect();
            match kb.write_custom_light_colors(&wire) {
                Ok(o) => steps.push(json!({
                    "step": "custom_colors", "command": o.command, "verified": o.verified,
                })),
                Err(e) => {
                    failed = true;
                    steps.push(json!({
                        "step": "custom_colors", "error": format!("{e:#}"),
                    }));
                }
            }
        }
    }

    // Skip the profile write when every resolved field already matches the
    // device blob (e.g. `apply` touching only `keys` or `color`).
    if profile_blob == profile.raw {
        steps.push(json!({ "step": "profile", "skipped": "unchanged" }));
    } else {
        match kb.write_profile(&profile_blob) {
            Ok(o) => steps.push(json!({
                "step": "profile", "command": o.command, "verified": o.verified,
            })),
            Err(e) => {
                failed = true;
                steps.push(json!({
                    "step": "profile", "error": format!("{e:#}"),
                }));
            }
        }
    }

    if let Some((trip, blob)) = &group_rgb {
        match kb.write_light_data(blob) {
            Ok(o) => steps.push(json!({
                "step": "group_color",
                "command": o.command,
                "verified": o.verified,
                "mode": mode,
                "color": rgb_json(pm::Rgb { r: trip.r, g: trip.g, b: trip.b }),
            })),
            Err(e) => {
                failed = true;
                steps.push(json!({
                    "step": "group_color", "error": format!("{e:#}"),
                }));
            }
        }
    }

    let change = json!({
        "mode": { "from": current.mode, "to": mode },
        "speed": { "from": current.speed, "to": speed },
        "brightness": { "from": current.brightness, "to": brightness },
        "color_model": { "from": current.color_model, "to": color_model },
        "custom_colors": new_custom.is_some(),
        "group_color": group_rgb.as_ref().map(|(t, _)| rgb_json(pm::Rgb { r: t.r, g: t.g, b: t.b })),
    });

    if cli.json {
        print_json(&json!({
            "device": device,
            "change": change,
            "steps": steps,
            "verified": !failed,
        }))?;
    } else {
        println!(
            "light apply: mode {} -> {}, speed {} -> {}, brightness {} -> {}, colour model {} -> {}",
            current.mode, mode, current.speed, speed, current.brightness, brightness,
            current.color_model, color_model
        );
        if new_custom.is_some() {
            if custom_unchanged {
                println!("custom colours: unchanged ({} slots)", khub_light::CUSTOM_LIGHT_SLOTS);
            } else {
                println!("custom colours: {} slots written", khub_light::CUSTOM_LIGHT_SLOTS);
            }
        }
        for s in &steps {
            match (
                s["step"].as_str(),
                s["verified"].as_bool(),
                s["skipped"].as_str(),
                s["error"].as_str(),
            ) {
                (Some(step), Some(true), _, _) => println!("  {step}: verified (cmd {})", s["command"]),
                (Some(step), _, Some(why), _) => println!("  {step}: skipped ({why})"),
                (Some(step), _, _, Some(err)) => println!("  {step}: FAILED — {err}"),
                _ => {}
            }
        }
    }
    if failed {
        bail!("one or more light writes failed verification — see steps above");
    }
    Ok(ExitCode::SUCCESS)
}

/// Dispatch from `cmd_kb916`.
pub fn cmd(cli: &Cli, command: &Kb916Light) -> Result<ExitCode> {
    match command {
        Kb916Light::Get => cmd_get(cli),
        Kb916Light::Apply { file, yes } => {
            if !yes.yes {
                bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
            }
            cmd_apply(cli, file)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_from(v: Value) -> KeysSpec {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn parse_color_formats() {
        let want = pm::Rgb { r: 0x12, g: 0x34, b: 0xab };
        assert_eq!(parse_color(&json!("#1234ab"), "c").unwrap(), want);
        assert_eq!(parse_color(&json!("1234AB"), "c").unwrap(), want);
        assert_eq!(parse_color(&json!("18,52,171"), "c").unwrap(), want);
        assert_eq!(parse_color(&json!({"r":18,"g":52,"b":171}), "c").unwrap(), want);
        assert!(parse_color(&json!("#12345"), "c").is_err());
        assert!(parse_color(&json!("#gg0000"), "c").is_err());
        assert!(parse_color(&json!("1,2"), "c").is_err());
        assert!(parse_color(&json!({"r":18,"g":52}), "c").is_err());
        assert!(parse_color(&json!(42), "c").is_err());
    }

    #[test]
    fn custom_colors_solid_default_and_fill() {
        let current = vec![pm::Rgb::default(); khub_light::CUSTOM_LIGHT_SLOTS];
        // No preset → current table unchanged.
        let out = build_custom_colors(&spec_from(json!({})), &current).unwrap();
        assert_eq!(out, current);
        // Solid with no colour → white fill.
        let out = build_custom_colors(&spec_from(json!({"preset":"solid"})), &current).unwrap();
        assert!(out.iter().all(|c| *c == pm::Rgb { r: 255, g: 255, b: 255 }));
        // Solid with explicit colour.
        let out = build_custom_colors(
            &spec_from(json!({"preset":"solid","color":"#ff0000"})),
            &current,
        )
        .unwrap();
        assert!(out.iter().all(|c| *c == pm::Rgb { r: 255, g: 0, b: 0 }));
    }

    #[test]
    fn custom_colors_gradient_and_rainbow_sizes() {
        let current = vec![pm::Rgb::default(); khub_light::CUSTOM_LIGHT_SLOTS];
        let g = build_custom_colors(
            &spec_from(json!({"preset":"gradient","color":"#ff0000","to":"#0000ff"})),
            &current,
        )
        .unwrap();
        assert_eq!(g.len(), 126);
        assert_eq!(g[0], pm::Rgb { r: 255, g: 0, b: 0 });
        assert_eq!(g[125], pm::Rgb { r: 0, g: 0, b: 255 });
        let r = build_custom_colors(&spec_from(json!({"preset":"rainbow"})), &current).unwrap();
        assert_eq!(r.len(), 126);
        assert_ne!(r[0], r[63]);
        assert!(build_custom_colors(&spec_from(json!({"preset":"nope"})), &current).is_err());
    }

    #[test]
    fn custom_colors_explicit_list_length() {
        let current = vec![pm::Rgb::default(); khub_light::CUSTOM_LIGHT_SLOTS];
        let list: Vec<Value> = (0..126).map(|_| json!("#010203")).collect();
        let spec = spec_from(json!({"colors": list}));
        let out = build_custom_colors(&spec, &current).unwrap();
        assert!(out.iter().all(|c| *c == pm::Rgb { r: 1, g: 2, b: 3 }));
        let short = spec_from(json!({"colors": ["#000000"]}));
        assert!(build_custom_colors(&short, &current).is_err());
    }

    #[test]
    fn custom_colors_entries_index_pos_and_bounds() {
        let current = vec![pm::Rgb::default(); khub_light::CUSTOM_LIGHT_SLOTS];
        let spec = spec_from(json!({
            "entries": [
                {"index": 0, "color": "#ff0000"},
                {"pos": 12, "color": {"r":0,"g":255,"b":0}},
            ]
        }));
        let out = build_custom_colors(&spec, &current).unwrap();
        assert_eq!(out[0], pm::Rgb { r: 255, g: 0, b: 0 });
        assert_eq!(out[1], pm::Rgb { r: 0, g: 255, b: 0 }); // pos 12 → (12-8)/4
        assert_eq!(out[2], pm::Rgb::default());
        // Bad pos (not 8+4n), out-of-range index, both fields, neither.
        for bad in [
            json!({"entries":[{"pos":9,"color":"#000000"}]}),
            json!({"entries":[{"index":126,"color":"#000000"}]}),
            json!({"entries":[{"index":1,"pos":12,"color":"#000000"}]}),
            json!({"entries":[{"color":"#000000"}]}),
        ] {
            assert!(build_custom_colors(&spec_from(bad), &current).is_err());
        }
    }

    #[test]
    fn light_config_rejects_empty_and_bad_model() {
        // Schema-level checks live in cmd_apply; exercise the serde shape
        // here: unknown fields are denied, schema is optional.
        assert!(serde_json::from_str::<LightConfig>("{\"bogus\":1}").is_err());
        let cfg: LightConfig = serde_json::from_str("{\"mode\":15}").unwrap();
        assert_eq!(cfg.mode, Some(15));
        assert!(cfg.keys.is_none());
    }
}
