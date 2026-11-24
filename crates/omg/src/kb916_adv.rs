//! `omg kb916 adv` — SOCD / MT (mod-tap) / TGL advanced keys for khub916
//! keyboards (wired cmd 146 read / cmd 18 + cmd-3 keymap write; codec in
//! `omg_proto_khub916::advkey`, spec `docs/advkeys-schema.md`).
//!
//! Mirrors the vendor AdvancedKey page: the device stores a 512-byte
//! history blob (SOCD 200 B + MT 200 B + TGL 112 B of fixed-size slots
//! holding the keys' original values) plus keymap bindings whose u32
//! values are `0x20/0x21/0x22 SS PP TT`-style references into it. Every
//! `set` performs the vendor's two writes — keymap first (cmd 3 with the
//! `sendKeyConfiguration` header), then the history blob (cmd 18) — each
//! read-back verified, and requires `--yes`.
//!
//! There is deliberately **no delete**: the vendor UI's delete only
//! edits a localStorage cache and never touches the device.

use std::process::ExitCode;

use anyhow::{bail, Result};
use clap::Subcommand;
use omg_proto_khub916::advkey::{self, AdvDetail, AdvKind};
use serde_json::{json, Value};

use crate::{kb916_session, parse_kb916_key_value, print_json, Cli, Yes};

#[derive(Subcommand)]
pub enum Kb916Adv {
    /// List the configured advanced keys: non-empty history slots with
    /// their stored key values, plus every keymap binding (tag 0x20/0x21/
    /// 0x22) resolved to its slot and payload. Read-only.
    List,
    /// Show the advanced-key binding at one keymap slot index (0-based,
    /// vendor `pos = 8 + index*4`): kind, slot, parameters and the history
    /// payload it points at. Read-only; errors when the slot is not an
    /// adv binding (see `omg kb916 keys`).
    Get {
        /// Keymap slot index to inspect.
        index: usize,
    },
    /// Bind an advanced key. `key`/`key-a`/`key-b`/`toggle` are keymap
    /// slot indices (0-based). Every variant requires `--yes`.
    Set {
        #[command(subcommand)]
        command: Kb916AdvSet,
    },
}

#[derive(Subcommand)]
pub enum Kb916AdvSet {
    /// Mod-tap key: short press emits `--tap`, long press `--hold`.
    /// `--time` is the hold threshold in 10 ms units (vendor slider
    /// value; UI range 0–100 = 0–1000 ms, default 50 = 500 ms).
    Mt {
        #[command(flatten)]
        yes: Yes,
        /// Keymap slot index of the physical bind key.
        key: usize,
        /// u32 key value emitted on short press (`0x` hex, decimal, or
        /// `none`) — see `omg kb916 keys` for the value encoding.
        #[arg(long)]
        tap: String,
        /// u32 key value emitted on long press.
        #[arg(long)]
        hold: String,
        /// Hold threshold in 10 ms units (vendor slider value).
        #[arg(long, default_value_t = 50)]
        time: u16,
    },
    /// SOCD (simultaneous-opposite-cardinal-direction) pair on two keys.
    /// `--direction`: 0/`last` (last input wins), 1/`key-a` (A priority),
    /// 2/`key-b` (B priority), 3/`cancel` (both cancel).
    Socd {
        #[command(flatten)]
        yes: Yes,
        /// Keymap slot index of the first key.
        key_a: usize,
        /// Keymap slot index of the second key.
        key_b: usize,
        /// SOCD direction (vendor socdList id).
        #[arg(long, default_value = "0")]
        direction: String,
    },
    /// Toggle key: pressing `key` toggles the output stored from the
    /// `toggle` slot's current value.
    Tgl {
        #[command(flatten)]
        yes: Yes,
        /// Keymap slot index of the physical bind key.
        key: usize,
        /// Keymap slot index whose current value is stored as the toggle
        /// target (vendor only allows picking a physical key).
        #[arg(long)]
        toggle: usize,
    },
}

// ── Output helpers ───────────────────────────────────────────────────────

fn value_json(v: u32) -> Value {
    json!({
        "value": format!("0x{v:08X}"),
        "label": advkey::value_label(v),
    })
}

fn detail_json(d: AdvDetail) -> Value {
    match d {
        AdvDetail::Socd { direction, key_b } => {
            json!({ "direction": direction, "key_b": key_b })
        }
        AdvDetail::Mt { time } => json!({ "time": time, "hold_ms_approx": time as u32 * 10 }),
        AdvDetail::Tgl => json!({}),
    }
}

fn binding_json(b: &advkey::AdvBinding, payload: Option<&[u32]>) -> Value {
    json!({
        "index": b.index,
        "pos": b.pos,
        "kind": b.kind.name(),
        "slot": b.slot,
        "value": format!("0x{:08X}", b.value),
        "detail": detail_json(b.detail),
        "payload": payload.map(|p| p.iter().map(|&v| value_json(v)).collect::<Vec<_>>()),
    })
}

/// Read blob + arg-0 keymap once; returns (raw blob, keymap values).
/// The keymap is the vendor `getKeyboardKeys({layer:0})` read (cmd 131
/// arg 0, tags 248/1) — exactly what the adv setters patch before
/// `sendKeyConfiguration`.
fn read_state(kb: &mut omg_proto_khub916::Khub916) -> Result<(Vec<u8>, Vec<u32>)> {
    let blob = kb.adv_key_config()?;
    let keymap = kb.key_values(0)?;
    Ok((blob, keymap))
}

fn list_json(device: &omg_hid::DeviceInfo, blob: &[u8], keymap: &[u32]) -> Value {
    let entries = advkey::history_entries(blob);
    let bindings = advkey::scan_adv_bindings(keymap);
    let mut out = json!({
        "device": device,
        "blob_bytes": advkey::normalize_blob(blob).len(),
        "history": {},
        "bindings": [],
    });
    let hist = out["history"].as_object_mut().unwrap();
    for kind in [AdvKind::Socd, AdvKind::Mt, AdvKind::Tgl] {
        let list: Vec<Value> = entries
            .iter()
            .filter(|e| e.kind == kind)
            .map(|e| {
                json!({
                    "slot": e.slot,
                    "values": e.values.iter().map(|&v| value_json(v)).collect::<Vec<_>>(),
                })
            })
            .collect();
        hist.insert(kind.name().to_string(), Value::Array(list));
    }
    out["bindings"] = Value::Array(
        bindings
            .iter()
            .map(|b| {
                let payload = advkey::binding_payload(blob, b);
                binding_json(b, payload.as_deref())
            })
            .collect(),
    );
    out
}

fn print_list_human(blob: &[u8], keymap: &[u32]) {
    let entries = advkey::history_entries(blob);
    let bindings = advkey::scan_adv_bindings(keymap);
    println!("adv-key history blob: {} bytes", advkey::normalize_blob(blob).len());
    for kind in [AdvKind::Socd, AdvKind::Mt, AdvKind::Tgl] {
        let ks = entries.iter().filter(|e| e.kind == kind).count();
        println!("  {}: {} entr{}", kind.name().to_uppercase(), ks, if ks == 1 { "y" } else { "ies" });
        for e in entries.iter().filter(|e| e.kind == kind) {
            let vals: Vec<String> = e
                .values
                .iter()
                .map(|&v| {
                    let l = advkey::value_label(v);
                    if l.is_empty() {
                        format!("0x{v:08X}")
                    } else {
                        format!("0x{v:08X} ({l})")
                    }
                })
                .collect();
            println!("    slot {:2}: {}", e.slot, vals.join(", "));
        }
    }
    println!("keymap bindings:");
    if bindings.is_empty() {
        println!("  (none)");
    }
    for b in &bindings {
        let payload = advkey::binding_payload(blob, b);
        let p = payload
            .map(|p| {
                p.iter()
                    .map(|&v| {
                        let l = advkey::value_label(v);
                        if l.is_empty() {
                            format!("0x{v:08X}")
                        } else {
                            format!("0x{v:08X} {l}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_else(|| "(empty slot)".to_string());
        println!(
            "  [{}] pos {} {} slot {} -> {}",
            b.index,
            b.pos,
            b.kind.name().to_uppercase(),
            b.slot,
            p
        );
    }
}

// ── Direction parsing ────────────────────────────────────────────────────

fn parse_direction(s: &str) -> Result<u8> {
    let t = s.trim().to_ascii_lowercase();
    match t.as_str() {
        "0" | "last" | "last-input" | "lastinputpriority" => Ok(0),
        "1" | "a" | "key-a" | "keya" | "priority-a" | "absoluteprioritykeyone" => Ok(1),
        "2" | "b" | "key-b" | "keyb" | "priority-b" | "absoluteprioritykeytwo" => Ok(2),
        "3" | "cancel" | "all-cancel" | "allcancel" => Ok(3),
        _ => bail!(
            "bad SOCD direction '{s}' (want 0-3, last, key-a, key-b or cancel)"
        ),
    }
}

// ── Command entry ────────────────────────────────────────────────────────

pub fn cmd(cli: &Cli, command: &Kb916Adv) -> Result<ExitCode> {
    // --yes gate for `adv set`, before any device access (plan.md §2).
    if let Kb916Adv::Set { command } = command {
        let yes = match command {
            Kb916AdvSet::Mt { yes, .. }
            | Kb916AdvSet::Socd { yes, .. }
            | Kb916AdvSet::Tgl { yes, .. } => yes.yes,
        };
        if !yes {
            bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
        }
    }

    let (device, mut kb) = match kb916_session(cli)? {
        Ok(s) => s,
        Err(code) => return Ok(code),
    };

    match command {
        Kb916Adv::List => {
            let (blob, keymap) = read_state(&mut kb)?;
            if cli.json {
                print_json(&list_json(&device, &blob, &keymap))?;
            } else {
                print_list_human(&blob, &keymap);
            }
            Ok(ExitCode::SUCCESS)
        }
        Kb916Adv::Get { index } => {
            let keymap = kb.key_values(0)?;
            if *index >= keymap.len() {
                bail!(
                    "key index {index} out of range: keymap has {} entries",
                    keymap.len()
                );
            }
            let value = keymap[*index];
            let Some((kind, slot, detail)) = advkey::decode_adv_binding(value) else {
                bail!(
                    "key[{index}] (pos {}) is not an adv-key binding (0x{value:08X}) — see `omg kb916 adv list`",
                    8 + index * 4
                );
            };
            let blob = kb.adv_key_config()?;
            let binding = advkey::AdvBinding {
                index: *index,
                pos: (8 + index * 4) as u32,
                value,
                kind,
                slot,
                detail,
            };
            let payload = advkey::binding_payload(&blob, &binding);
            if cli.json {
                print_json(&binding_json(&binding, payload.as_deref()))?;
            } else {
                println!(
                    "key[{index}] (pos {}) {} slot {slot} value 0x{value:08X}",
                    8 + index * 4,
                    kind.name().to_uppercase()
                );
                match detail {
                    AdvDetail::Socd { direction, key_b } => {
                        println!("  direction: {direction}{}", if key_b { " (key B)" } else { " (key A)" });
                    }
                    AdvDetail::Mt { time } => {
                        println!("  hold time: {time} ({} ms approx)", time as u32 * 10);
                    }
                    AdvDetail::Tgl => {}
                }
                match &payload {
                    Some(p) => {
                        for &v in p {
                            let l = advkey::value_label(v);
                            println!(
                                "  payload 0x{v:08X}{}",
                                if l.is_empty() { String::new() } else { format!("  {l}") }
                            );
                        }
                    }
                    None => println!("  payload: (empty history slot)"),
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        Kb916Adv::Set { command } => {
            // Read state, plan purely, then perform the vendor's two
            // writes in order: keymap (cmd 3, sendKeyConfiguration
            // header) then history blob (cmd 18). Each is read-back
            // verified inside the proto crate.
            let (blob, keymap) = read_state(&mut kb)?;
            let plan = match command {
                Kb916AdvSet::Mt {
                    key,
                    tap,
                    hold,
                    time,
                    ..
                } => {
                    let tap_v = parse_kb916_key_value(tap)?;
                    let hold_v = parse_kb916_key_value(hold)?;
                    advkey::plan_mt(&blob, &keymap, *key, tap_v, hold_v, *time)?
                }
                Kb916AdvSet::Socd {
                    key_a,
                    key_b,
                    direction,
                    ..
                } => {
                    let dir = parse_direction(direction)?;
                    advkey::plan_socd(&blob, &keymap, *key_a, *key_b, dir)?
                }
                Kb916AdvSet::Tgl { key, toggle, .. } => {
                    advkey::plan_tgl(&blob, &keymap, *key, *toggle)?
                }
            };
            let keymap_outcome = kb.write_key_configuration(&plan.keymap)?;
            let history_outcome = kb.write_adv_key_config(&plan.blob)?;
            // cmd-18 read-back is unreliable within the same HID session
            // on K1 Pro (cmd 146 returns unrelated pages for ~60 s after
            // the write — live-tested). When the in-session verify came
            // back inconclusive, reopen the device and confirm there.
            let mut history_verified = history_outcome.verified;
            let history_note = if !history_verified {
                drop(kb);
                std::thread::sleep(std::time::Duration::from_millis(500));
                match kb916_session(cli)? {
                    Ok((_d2, mut kb2)) => match kb2.adv_key_config() {
                        Ok(back)
                            if advkey::normalize_blob(&back) == plan.blob =>
                        {
                            history_verified = true;
                            " (verified by read-back on a fresh session)".to_string()
                        }
                        _ => " — sent, but read-back did not confirm the \
                              blob (device cmd-146 read-back is unstable \
                              after cmd 18; re-run `omg kb916 adv list`)"
                            .to_string(),
                    },
                    Err(code) => return Ok(code),
                }
            } else {
                " (verified by read-back)".to_string()
            };
            let change = match command {
                Kb916AdvSet::Mt { key, tap, hold, time, .. } => format!(
                    "mt key[{key}] (pos {}): tap {} hold {} time {time}",
                    8 + key * 4,
                    parse_kb916_key_value(tap).map(|v| format!("0x{v:08X}")).unwrap_or_default(),
                    parse_kb916_key_value(hold).map(|v| format!("0x{v:08X}")).unwrap_or_default(),
                ),
                Kb916AdvSet::Socd { key_a, key_b, direction, .. } => format!(
                    "socd key[{key_a}]+key[{key_b}] (pos {}+{}): direction {}",
                    8 + key_a * 4,
                    8 + key_b * 4,
                    direction
                ),
                Kb916AdvSet::Tgl { key, toggle, .. } => format!(
                    "tgl key[{key}] (pos {}) toggle key[{toggle}] (pos {})",
                    8 + key * 4,
                    8 + toggle * 4
                ),
            };
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "change": change,
                    "writes": [
                        { "command": keymap_outcome.command, "verified": keymap_outcome.verified },
                        { "command": history_outcome.command, "verified": history_verified },
                    ],
                }))?;
            } else {
                println!("{change}");
                println!(
                    "  keymap write cmd {} verified by read-back",
                    keymap_outcome.command
                );
                println!(
                    "  adv-key history write cmd {}{}",
                    history_outcome.command, history_note
                );
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}
