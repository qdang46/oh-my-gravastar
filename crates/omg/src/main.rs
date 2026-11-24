//! `omg` — agent-first, offline CLI for GravaStar keyboards and mice.
//!
//! Every data command supports `--json`; writes require `--yes` (see
//! docs/plan.md §2 for the safety contract). Exit codes: 0 ok, 1 error,
//! 2 no device, 3 unsupported.

use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use clap::{Args, Parser, Subcommand};
use omg_hid::{find_devices, DeviceInfo, DeviceKind, NoAnswer};
use omg_proto_he as he;
use omg_proto_khub916 as khub;
use omg_proto_mouse as pm;
use omg_proto_sparkplayjoy as spj;
use serde_json::json;

mod profile;

#[derive(Parser)]
#[command(
    name = "omg",
    version,
    about = "Configure GravaStar keyboards and mice (offline, agent-first)"
)]
struct Cli {
    /// Emit machine-readable JSON instead of human text.
    #[arg(long, global = true)]
    json: bool,

    /// Device selector: HID path, `VID:PID` (hex with `0x` prefix, or bare
    /// hex like `f54b`; all-digit values are decimal), or a unique
    /// case-insensitive substring of the product/manufacturer string.
    /// Auto-picks when exactly one GravaStar device is connected.
    #[arg(long, global = true, value_name = "SELECTOR")]
    device: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List detected GravaStar devices.
    Devices,
    /// Diagnostic probe of a device: per-protocol read-only summary.
    /// Without `--device` every detected GravaStar device is probed.
    /// `--deep` adds the heavier SparkPlayJoy travel-matrix read.
    Probe {
        /// Include the SparkPlayJoy live travel matrix (heavier read).
        #[arg(long)]
        deep: bool,
    },
    /// GravaStar Mercury HE keyboards (v2 64-byte report protocol).
    /// Factory reset, firmware update, settings wipe, gamepad mode and
    /// restart commands are not implemented by design (docs/plan.md §2).
    Kb {
        #[command(subcommand)]
        command: KbCommands,
    },
    /// GravaStar K1/K98 series keyboards (khub916 wired feature-report
    /// protocol, docs/protocol-khub916.md). Screen reads/plans are wired;
    /// screen writes, the wireless 916_wireLess transport and all other
    /// writes are not.
    Kb916 {
        #[command(subcommand)]
        command: Kb916Commands,
    },
    /// GravaStar mice with a Compx chipset (Mercury M/X series).
    Mouse {
        #[command(subcommand)]
        command: MouseCommands,
    },
    /// Unified profile export/import (JSON schema v1).
    /// Export captures every readable setting of all connected GravaStar
    /// devices (or the one selected by `--device`); import validates the
    /// file, matches devices by protocol + VID/PID, backs up the current
    /// state, then applies writes. khub916 and sparkplayjoy are export-only.
    Profile {
        #[command(subcommand)]
        command: ProfileCommands,
    },
}

#[derive(Subcommand)]
enum ProfileCommands {
    /// Export readable device state to a JSON profile file.
    /// `--full` adds the large raw blobs (khub916 per-mode light data and
    /// macro region as hex).
    Export {
        /// Output JSON file.
        file: String,
        /// Include large raw blobs (khub916 light-data/macro hex).
        #[arg(long)]
        full: bool,
    },
    /// Import a profile file. `--dry-run` prints the planned changes
    /// without writing; real writes require `--yes` (same contract as
    /// every other write command, docs/plan.md §2).
    Import {
        /// Profile JSON file produced by `omg profile export`.
        file: String,
        /// Print planned changes only; nothing is sent to any device.
        #[arg(long, conflicts_with = "yes")]
        dry_run: bool,
        /// Confirm the writes. Without it (and without --dry-run) the
        /// command refuses before any bytes are sent.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum MouseCommands {
    /// Identify the mouse: model, link type, sensor, max polling rate.
    Info,
    /// Read battery level, charging state and cell voltage.
    Battery,
    /// Read mouse and receiver firmware versions.
    Fw,
    /// Dump the full decoded settings flash map.
    Config,
    /// Change one setting. Requires `--yes`; every write is read back and
    /// verified. Pairing, factory reset, RF channel and bootloader commands
    /// are not implemented by design.
    Set {
        #[command(subcommand)]
        field: MouseSet,
    },
}

/// `--yes` acknowledgement required by every write (docs/plan.md §2).
#[derive(Args)]
struct Yes {
    /// Confirm the write. Without it nothing is sent.
    #[arg(long)]
    yes: bool,
}

#[derive(Subcommand)]
enum MouseSet {
    /// Polling rate in Hz (125, 250, 500, 1000, 2000, 4000, 8000).
    Polling {
        #[command(flatten)]
        yes: Yes,
        hz: u32,
    },
    /// Set the DPI of one stage (0..7). DPI is clamped to the sensor range.
    Dpi {
        #[command(flatten)]
        yes: Yes,
        stage: usize,
        dpi: u32,
    },
    /// Set the LED colour of one DPI stage: #rrggbb or r,g,b.
    DpiColor {
        #[command(flatten)]
        yes: Yes,
        stage: usize,
        color: String,
    },
    /// Number of active DPI stages (1..8).
    Stages {
        #[command(flatten)]
        yes: Yes,
        n: usize,
    },
    /// Select the currently active DPI stage (0..7).
    Stage {
        #[command(flatten)]
        yes: Yes,
        i: usize,
    },
    /// Lift-off distance; valid values depend on the sensor (see `info`).
    Lod {
        #[command(flatten)]
        yes: Yes,
        v: u8,
    },
    /// Lighting: `on`, `off`, `mode <0-6>`, `color <#rrggbb|r,g,b>`,
    /// `speed <1-9>`, `brightness <1-9>`.
    Light {
        #[command(subcommand)]
        what: MouseLight,
    },
    /// Debounce time in ms (0..15).
    Debounce {
        #[command(flatten)]
        yes: Yes,
        ms: u8,
    },
    /// Motion Sync on|off.
    MotionSync {
        #[command(flatten)]
        yes: Yes,
        #[arg(value_parser = ["on", "off"])]
        on: String,
    },
    /// Angle snapping on|off.
    AngleSnap {
        #[command(flatten)]
        yes: Yes,
        #[arg(value_parser = ["on", "off"])]
        on: String,
    },
    /// Ripple control on|off.
    Ripple {
        #[command(flatten)]
        yes: Yes,
        #[arg(value_parser = ["on", "off"])]
        on: String,
    },
    /// Lights off while moving on|off.
    LightOffMoving {
        #[command(flatten)]
        yes: Yes,
        #[arg(value_parser = ["on", "off"])]
        on: String,
    },
    /// Sleep timeout in seconds: 10, 30, 60, 120, 180, 300, 600 or 900.
    Sleep {
        #[command(flatten)]
        yes: Yes,
        seconds: u16,
    },
    /// Sensor mode: `lp` or `hp`.
    SensorMode {
        #[command(flatten)]
        yes: Yes,
        #[arg(value_parser = ["lp", "hp"])]
        mode: String,
    },
    /// Assign a button slot (0..5): kind `disabled|mouse|dpi|shortcut|macro`,
    /// optional param (mouse: left|right|middle|back|forward or 0x0100…;
    /// dpi: stage index or 0x0100).
    Button {
        #[command(flatten)]
        yes: Yes,
        slot: usize,
        #[arg(value_parser = ["disabled", "mouse", "dpi", "shortcut", "macro"])]
        kind: String,
        param: Option<String>,
    },
}

#[derive(Subcommand)]
enum MouseLight {
    On {
        #[command(flatten)]
        yes: Yes,
    },
    Off {
        #[command(flatten)]
        yes: Yes,
    },
    /// Lighting mode 0..6 (0 off, 1 rainbow, 2 breathing, 3 static,
    /// 4 neon, 5 rainbow breathing, 6 static rainbow).
    Mode {
        #[command(flatten)]
        yes: Yes,
        mode: u8,
    },
    /// Light colour: #rrggbb or r,g,b.
    Color {
        #[command(flatten)]
        yes: Yes,
        color: String,
    },
    /// Effect speed 1..9.
    Speed {
        #[command(flatten)]
        yes: Yes,
        v: u8,
    },
    /// Brightness 1..9.
    Brightness {
        #[command(flatten)]
        yes: Yes,
        v: u8,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(1)
        }
    }
}

fn run(cli: &Cli) -> Result<ExitCode> {
    match &cli.command {
        Commands::Devices => cmd_devices(cli),
        Commands::Probe { deep } => cmd_probe(cli, *deep),
        Commands::Kb { command } => cmd_kb(cli, command),
        Commands::Kb916 { command } => cmd_kb916(cli, command),
        Commands::Mouse { command } => cmd_mouse(cli, command),
        Commands::Profile { command } => cmd_profile(cli, command),
    }
}

fn no_device() -> ExitCode {
    ExitCode::from(2)
}

// ── devices ────────────────────────────────────────────────────────────

fn cmd_devices(cli: &Cli) -> Result<ExitCode> {
    let devices = find_devices()?;
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&devices)?);
    } else if devices.is_empty() {
        println!("no GravaStar devices detected");
    } else {
        for d in &devices {
            println!(
                "{}  {:<34} {}",
                d.vid_pid(),
                d.kind.label(),
                d.product.as_deref().unwrap_or("")
            );
            println!("    path: {}", d.path);
            if let Some(m) = &d.manufacturer {
                println!("    manufacturer: {m}");
            }
            println!(
                "    usage_page: 0x{:04x} usage: 0x{:04x}",
                d.usage_page, d.usage
            );
        }
    }
    Ok(if devices.is_empty() {
        no_device()
    } else {
        ExitCode::SUCCESS
    })
}

// ── probe ──────────────────────────────────────────────────────────────

/// Wrap one probe read: `Ok` serialises the value, `Err` becomes an
/// `{"error": "…"}` object so one failed read does not hide the rest.
fn probe_read<T: serde::Serialize>(r: Result<T>) -> serde_json::Value {
    match r {
        Ok(v) => serde_json::to_value(v).unwrap_or(serde_json::Value::Null),
        Err(e) => json!({ "error": format!("{e:#}") }),
    }
}

fn hex32(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(32)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

/// Probe one device: transport identity plus a per-protocol read-only
/// summary. Every section is independent; failures are reported inline.
fn probe_device(d: &DeviceInfo, deep: bool) -> serde_json::Value {
    let protocol = match d.kind {
        DeviceKind::HeKeyboardV2 => probe_he(d),
        DeviceKind::CompxMouse => probe_mouse(d),
        DeviceKind::SparkPlayJoy => probe_spark(d, deep),
        DeviceKind::Khub916Wired | DeviceKind::Khub916Wireless => probe_khub916(d),
        // Write-only image target: opening it and sending the cmd-130
        // report-id probe could block on a feature-report read the
        // firmware may never answer (docs/protocol-khub916-screen.md §1).
        DeviceKind::Khub916Screen => json!({
            "kind": d.kind.label(),
            "note": "write-only screen interface — the vendor protocol has no query path on it and image pushes are not implemented yet",
        }),
    };
    json!({
        "device": d,
        "kind_label": d.kind.label(),
        "protocol": protocol,
    })
}

fn probe_he(d: &DeviceInfo) -> serde_json::Value {
    let mut kb = match d.open_link() {
        Ok(link) => he::HeKeyboard::new(Box::new(link)),
        Err(e) => return json!({ "error": format!("open: {e:#}") }),
    };
    let info = probe_read(kb.info().map(|i| {
        json!({
            "firmware": i.firmware,
            "pcb": i.pcb,
            "build_time": i.build_time,
            "protocol": i.protocol,
            "board_id": format!("0x{:08X}", i.board_id),
        })
    }));
    let profile = probe_read((|| {
        Ok(json!({
            "count": kb.profile_count()?,
            "active": kb.profile()?,
        }))
    })());
    let polling = probe_read((|| {
        let current = kb.report_rate()?;
        let supported = kb.report_rates()?;
        Ok(json!({
            "current": current,
            "current_name": rate_name(current),
            "supported": supported.iter().map(|&i| rate_name(i)).collect::<Vec<_>>(),
        }))
    })());
    let lighting_areas = probe_read(kb.lighting_areas().map(|areas| {
        areas
            .iter()
            .map(|a| json!({ "index": a.index, "effects": a.count }))
            .collect::<Vec<_>>()
    }));
    let keys = probe_read((|| {
        let slots = kb.key_slots()?;
        let first = slots.first().map(|s| {
            let perf = kb.key_perf(s.row, s.col).ok();
            json!({
                "row": s.row, "col": s.col,
                "perf": perf.as_ref().map(perf_json),
            })
        });
        Ok(json!({ "slot_count": slots.len(), "first_key": first }))
    })());
    let os = probe_read(
        kb.system()
            .map(|v| json!({ "os": if v == 0 { "windows" } else { "macos" }, "os_id": v })),
    );
    json!({
        "info": info,
        "profile": profile,
        "polling": polling,
        "lighting_areas": lighting_areas,
        "keys": keys,
        "os": os,
        "raw_hex": serde_json::Value::Null,
        "raw_note": "the HE proto API does not expose raw reply bytes",
    })
}

fn probe_mouse(d: &DeviceInfo) -> serde_json::Value {
    let mut m = match d.open_link() {
        Ok(link) => pm::CompxMouse::new(Box::new(link)),
        Err(e) => return json!({ "error": format!("open: {e:#}") }),
    };
    let identity = probe_read(m.identify());
    let online = probe_read(m.online());
    let battery = probe_read(m.battery());
    let firmware = probe_read(
        m.firmware()
            .map(|(mouse, dongle)| json!({ "mouse": mouse, "receiver": dongle })),
    );
    let config = probe_read(m.read_config());
    json!({
        "identity": identity,
        "online": online,
        "battery": battery,
        "firmware": firmware,
        "config": config,
        "raw_hex": serde_json::Value::Null,
        "raw_note": "the mouse proto API does not expose raw reply bytes",
    })
}

fn probe_spark(d: &DeviceInfo, deep: bool) -> serde_json::Value {
    let mut sp = match d.open_link() {
        Ok(link) => spj::SparkPlayJoy::new(Box::new(link)),
        Err(e) => return json!({ "error": format!("open: {e:#}") }),
    };
    // SyncInfo::serial is a device serial — redact it (privacy rule).
    // raw_payload is the only raw reply the proto API exposes.
    let sync = probe_read(sp.sync().map(|s| {
        json!({
            "board_id": format!("0x{:08X}", s.board_id),
            "platform": s.platform,
            "app_version": s.app_version,
            "build_label": s.build_label,
            "serial": "[redacted]",
            "raw_hex_32": hex32(&s.raw_payload),
        })
    }));
    let scale = probe_read(sp.scale());
    let maps = probe_read((|| {
        let map = sp.default_map()?;
        let populated = map.iter().flatten().filter(|&&k| k != 0).count();
        let active = sp.active_map(&map)?;
        let active_populated = active
            .functions
            .iter()
            .flatten()
            .filter(|&&f| f != 0)
            .count();
        Ok(json!({
            "default_map_populated": populated,
            "default_map": map,
            "active_map_populated": active_populated,
        }))
    })());
    let mut out = json!({
        "sync": sync,
        "scale": scale,
        "maps": maps,
        "raw_note": "only the sync reply exposes raw bytes (raw_hex_32); other replies are decoded-only",
    });
    if deep {
        out["travel"] = probe_read(sp.travel());
    }
    out
}

fn probe_khub916(d: &DeviceInfo) -> serde_json::Value {
    if d.kind == DeviceKind::Khub916Wireless {
        return json!({
            "kind": d.kind.label(),
            "note": "916_wireLess transport is not implemented yet (docs/protocol-khub916.md §3/§7)",
        });
    }
    let mut link = match d.open_link() {
        Ok(l) => l,
        Err(e) => return json!({ "error": format!("open: {e:#}") }),
    };
    let report_id = match khub::probe_report_id(&mut link) {
        Ok(id) => id,
        Err(e) => return json!({ "error": format!("report id probe: {e:#}") }),
    };
    let mut kb = khub::Khub916::new(Box::new(link), report_id);
    json!({
        "kind": d.kind.label(),
        "report_id": report_id,
        "device_info": probe_read(kb.device_info()),
        "power": probe_read(kb.power()),
        "keymap_entries": probe_read(kb.key_values(0).map(|v| v.len())),
        "profile_bytes": probe_read(kb.profile().map(|p| p.raw.len())),
        "custom_light_entries": probe_read(kb.custom_light_colors().map(|c| c.len())),
    })
}

fn print_probe_human(reports: &[serde_json::Value]) {
    for r in reports {
        let d = &r["device"];
        let vid_pid = format!(
            "{:04X}:{:04X}",
            d["vid"].as_u64().unwrap_or(0) as u16,
            d["pid"].as_u64().unwrap_or(0) as u16
        );
        println!("{}  {}", vid_pid, r["kind_label"].as_str().unwrap_or("?"));
        println!("    path: {}", d["path"].as_str().unwrap_or("?"));
        if let Some(p) = d["product"].as_str() {
            println!("    product: {p}");
        }
        if let Some(m) = d["manufacturer"].as_str() {
            println!("    manufacturer: {m}");
        }
        println!("    protocol:");
        let proto = serde_json::to_string_pretty(&r["protocol"]).unwrap_or_default();
        for line in proto.lines() {
            println!("      {line}");
        }
    }
}

fn cmd_probe(cli: &Cli, deep: bool) -> Result<ExitCode> {
    let devices = find_devices()?;
    let targets: Vec<DeviceInfo> = if let Some(sel) = cli.device.as_deref() {
        match select_device(&devices, Some(sel))? {
            Some(d) => vec![d.clone()],
            None => {
                if cli.json {
                    print_json(&json!({ "error": "no GravaStar device matched --device" }))?;
                } else {
                    println!("no GravaStar device matched --device");
                }
                return Ok(no_device());
            }
        }
    } else {
        devices
    };
    if targets.is_empty() {
        if cli.json {
            print_json(&json!({ "error": "no GravaStar device connected" }))?;
        } else {
            println!("no GravaStar device connected");
        }
        return Ok(no_device());
    }
    let reports: Vec<serde_json::Value> = targets.iter().map(|d| probe_device(d, deep)).collect();
    if cli.json {
        print_json(&json!({ "devices": reports }))?;
    } else {
        print_probe_human(&reports);
    }
    Ok(ExitCode::SUCCESS)
}

// ── mouse (Compx) ──────────────────────────────────────────────────────

/// Errors that usually mean a sleeping wireless link get a hint appended.
fn mouse_err(e: anyhow::Error) -> anyhow::Error {
    let msg = format!("{e:#}");
    if msg.contains("offline") || msg.contains("no answer") {
        anyhow!("{msg} — if the mouse is on the 2.4 GHz receiver, move it to wake the link")
    } else {
        e
    }
}

/// Select a Compx mouse device and open it. Identifies the mouse so sensor
/// limits are known for validation and clamping. `Ok(None)` = no mouse
/// matched (exit code 2).
fn open_mouse(cli: &Cli) -> Result<Option<(DeviceInfo, pm::CompxMouse)>> {
    let devices = find_devices()?;
    let mice: Vec<DeviceInfo> = devices
        .into_iter()
        .filter(|d| d.kind == DeviceKind::CompxMouse)
        .collect();
    let Some(device) = select_device(&mice, cli.device.as_deref())? else {
        return Ok(None);
    };
    let link = device.open_link()?;
    let mut mouse = pm::CompxMouse::new(Box::new(link));
    mouse.identify().map_err(mouse_err)?;
    Ok(Some((device.clone(), mouse)))
}

/// Uniform "no mouse" exit (code 2) with optional JSON error object.
fn mouse_absent(cli: &Cli) -> Result<ExitCode> {
    if cli.json {
        print_json(
            &json!({ "error": "no Compx mouse detected (omg devices lists what was found)" }),
        )?;
    } else {
        println!("no Compx mouse detected (omg devices lists what was found)");
    }
    Ok(no_device())
}

fn print_json(v: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}

fn cmd_mouse(cli: &Cli, command: &MouseCommands) -> Result<ExitCode> {
    match command {
        MouseCommands::Info => {
            let Some((device, mut m)) = open_mouse(cli)? else {
                return mouse_absent(cli);
            };
            let id = m.identity.expect("identify ran");
            let online = m.online().map_err(mouse_err).unwrap_or(false);
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "identity": id,
                    "online": online,
                }))?;
            } else {
                println!("{}", device.vid_pid());
                println!("model:   {}", id.model.unwrap_or("(unknown)"));
                println!("cid/mid: {} / {}", id.cid, id.mid);
                println!(
                    "link:    {}",
                    if id.wired {
                        "wired (cable)"
                    } else {
                        "2.4 GHz receiver"
                    }
                );
                println!(
                    "sensor:  {} (max {} DPI, base {} DPI)",
                    id.sensor.name, id.sensor.max_dpi, id.sensor.base_max
                );
                println!(
                    "lod:     {}",
                    id.sensor
                        .lod
                        .iter()
                        .map(|(v, l)| format!("{v}={l}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                println!("max polling on this link: {} Hz", id.max_rate);
                println!("online:  {online}");
            }
            Ok(ExitCode::SUCCESS)
        }
        MouseCommands::Battery => {
            let Some((device, mut m)) = open_mouse(cli)? else {
                return mouse_absent(cli);
            };
            let b = m.battery().map_err(mouse_err)?;
            if cli.json {
                print_json(&json!({ "device": device, "battery": b }))?;
            } else {
                println!(
                    "battery: {}%{}",
                    b.level,
                    if b.charging { " (charging)" } else { "" }
                );
                println!("voltage: {} mV", b.millivolts);
            }
            Ok(ExitCode::SUCCESS)
        }
        MouseCommands::Fw => {
            let Some((device, mut m)) = open_mouse(cli)? else {
                return mouse_absent(cli);
            };
            let (mouse_fw, dongle_fw) = m.firmware().map_err(mouse_err)?;
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "mouse_firmware": mouse_fw,
                    "receiver_firmware": dongle_fw,
                }))?;
            } else {
                println!("mouse firmware:     {mouse_fw}");
                match dongle_fw {
                    Some(fw) => println!("receiver firmware: {fw}"),
                    None => println!("receiver firmware: (wired link or receiver did not answer)"),
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        MouseCommands::Config => {
            let Some((device, mut m)) = open_mouse(cli)? else {
                return mouse_absent(cli);
            };
            let cfg = m.read_config().map_err(mouse_err)?;
            if cli.json {
                print_json(&json!({ "device": device, "config": cfg }))?;
            } else {
                print_config_human(&cfg);
            }
            Ok(ExitCode::SUCCESS)
        }
        MouseCommands::Set { field } => cmd_mouse_set(cli, field),
    }
}

fn print_config_human(c: &pm::MouseConfig) {
    println!("polling:        {} Hz", c.report_rate);
    println!(
        "dpi stages:     {} (active: {})",
        c.stage_count, c.current_stage
    );
    for i in 0..c.stage_count.min(pm::MAX_STAGES) {
        println!(
            "  stage {i}: {} DPI  {}",
            c.dpi[i],
            c.dpi_colors[i].to_hex()
        );
    }
    println!("lift-off dist:  {}", c.lod);
    println!(
        "light:          {} mode {} color {} speed {} brightness {}",
        if c.light.on { "on " } else { "off" },
        c.light.mode,
        c.light.color.to_hex(),
        c.light.speed,
        c.light.brightness
    );
    println!("debounce:       {} ms", c.debounce);
    println!(
        "motion sync:    {}   angle snap: {}   ripple: {}   lights off moving: {}",
        yn(c.motion_sync),
        yn(c.angle_snap),
        yn(c.ripple),
        yn(c.light_off_moving)
    );
    println!("sleep:          {} (×10 s)", c.sleep);
    println!(
        "sensor mode:    {}",
        if c.sensor_mode == 0 { "LP" } else { "HP" }
    );
    for (i, b) in c.buttons.iter().enumerate() {
        println!("button {i}:      kind {} param 0x{:04x}", b.kind, b.param);
    }
}

fn yn(b: bool) -> &'static str {
    if b {
        "on"
    } else {
        "off"
    }
}

/// Require `--yes`, run the write, read the config back and verify the
/// affected field. Returns a JSON report with `"verified": true|false`.
fn cmd_mouse_set(cli: &Cli, field: &MouseSet) -> Result<ExitCode> {
    let (yes, action) = match field {
        MouseSet::Polling { yes, hz } => (yes, MouseAction::Polling(*hz)),
        MouseSet::Dpi { yes, stage, dpi } => (yes, MouseAction::Dpi(*stage, *dpi)),
        MouseSet::DpiColor { yes, stage, color } => {
            (yes, MouseAction::DpiColor(*stage, color.clone()))
        }
        MouseSet::Stages { yes, n } => (yes, MouseAction::Stages(*n)),
        MouseSet::Stage { yes, i } => (yes, MouseAction::Stage(*i)),
        MouseSet::Lod { yes, v } => (yes, MouseAction::Lod(*v)),
        MouseSet::Light { what } => {
            let (yes, a) = match what {
                MouseLight::On { yes } => (yes, MouseAction::LightOn),
                MouseLight::Off { yes } => (yes, MouseAction::LightOff),
                MouseLight::Mode { yes, mode } => (yes, MouseAction::LightMode(*mode)),
                MouseLight::Color { yes, color } => (yes, MouseAction::LightColor(color.clone())),
                MouseLight::Speed { yes, v } => (yes, MouseAction::LightSpeed(*v)),
                MouseLight::Brightness { yes, v } => (yes, MouseAction::LightBrightness(*v)),
            };
            (yes, a)
        }
        MouseSet::Debounce { yes, ms } => (yes, MouseAction::Debounce(*ms)),
        MouseSet::MotionSync { yes, on } => (
            yes,
            MouseAction::Flag("motion_sync", on == "on", pm::addr::MOTION_SYNC),
        ),
        MouseSet::AngleSnap { yes, on } => (
            yes,
            MouseAction::Flag("angle_snap", on == "on", pm::addr::ANGLE_SNAP),
        ),
        MouseSet::Ripple { yes, on } => (
            yes,
            MouseAction::Flag("ripple", on == "on", pm::addr::RIPPLE),
        ),
        MouseSet::LightOffMoving { yes, on } => (
            yes,
            MouseAction::Flag("light_off_moving", on == "on", pm::addr::LIGHT_OFF_MOVING),
        ),
        MouseSet::Sleep { yes, seconds } => (yes, MouseAction::Sleep(*seconds)),
        MouseSet::SensorMode { yes, mode } => (yes, MouseAction::SensorMode(mode.clone())),
        MouseSet::Button {
            yes,
            slot,
            kind,
            param,
        } => (yes, MouseAction::Button(*slot, kind.clone(), param.clone())),
    };
    if !yes.yes {
        bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
    }

    let Some((device, mut m)) = open_mouse(cli)? else {
        return mouse_absent(cli);
    };
    let id = m.identity.expect("identify ran");

    // Validate and describe the change before sending anything.
    let (description, expected) = plan_action(&mut m, &id, &action)?;

    // Apply.
    apply_action(&mut m, &action).map_err(mouse_err)?;

    // Read back and verify.
    let after = m.read_config().map_err(mouse_err)?;
    let actual = readback_field(&after, &action);
    let verified = actual == expected;

    if cli.json {
        print_json(&json!({
            "device": device,
            "change": description,
            "expected": expected,
            "actual": actual,
            "verified": verified,
        }))?;
    } else {
        println!("{description}");
        println!("verified: {verified}");
        if !verified {
            println!("expected: {expected}");
            println!("actual:   {actual}");
        }
    }
    Ok(if verified {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

/// A pending write, already parsed from the CLI.
enum MouseAction {
    Polling(u32),
    Dpi(usize, u32),
    DpiColor(usize, String),
    Stages(usize),
    Stage(usize),
    Lod(u8),
    LightOn,
    LightOff,
    LightMode(u8),
    LightColor(String),
    LightSpeed(u8),
    LightBrightness(u8),
    Debounce(u8),
    Flag(&'static str, bool, u16),
    Sleep(u16),
    SensorMode(String),
    Button(usize, String, Option<String>),
}

/// Validate ranges, compute the expected read-back value and a human
/// description. Runs before anything is sent.
fn plan_action(
    m: &mut pm::CompxMouse,
    id: &pm::Identity,
    a: &MouseAction,
) -> Result<(String, serde_json::Value)> {
    Ok(match a {
        MouseAction::Polling(hz) => {
            if !pm::REPORT_RATES.contains(hz) {
                bail!(
                    "invalid polling rate {hz} Hz (valid: {:?})",
                    pm::REPORT_RATES
                );
            }
            if *hz > id.max_rate {
                bail!(
                    "{hz} Hz exceeds what this link supports (max {} Hz)",
                    id.max_rate
                );
            }
            (format!("polling rate -> {hz} Hz"), json!(hz))
        }
        MouseAction::Dpi(stage, dpi) => {
            check_stage(*stage)?;
            if *dpi < 50 {
                bail!("DPI {dpi} below minimum 50");
            }
            let clamped = m.clamp_dpi(*dpi);
            (
                format!(
                    "DPI stage {stage} -> {clamped} DPI{}",
                    if clamped != *dpi { " (clamped)" } else { "" }
                ),
                json!(clamped),
            )
        }
        MouseAction::DpiColor(stage, color) => {
            check_stage(*stage)?;
            let c = pm::Rgb::parse(color)?;
            (
                format!("DPI stage {stage} colour -> {}", c.to_hex()),
                json!(c),
            )
        }
        MouseAction::Stages(n) => {
            if !(1..=pm::MAX_STAGES).contains(n) {
                bail!("stage count {n} out of range 1..={}", pm::MAX_STAGES);
            }
            (format!("DPI stages -> {n}"), json!(n))
        }
        MouseAction::Stage(i) => {
            check_stage(*i)?;
            (format!("active DPI stage -> {i}"), json!(i))
        }
        MouseAction::Lod(v) => {
            if !id.sensor.lod.iter().any(|(l, _)| l == v) {
                bail!(
                    "invalid lift-off distance {v} for {} (valid: {:?})",
                    id.sensor.name,
                    id.sensor.lod
                );
            }
            let label = id
                .sensor
                .lod
                .iter()
                .find(|(l, _)| l == v)
                .map(|(_, l)| *l)
                .unwrap_or("");
            (format!("lift-off distance -> {v} ({label})"), json!(v))
        }
        MouseAction::LightOn
        | MouseAction::LightOff
        | MouseAction::LightMode(_)
        | MouseAction::LightColor(_)
        | MouseAction::LightSpeed(_)
        | MouseAction::LightBrightness(_) => {
            let new = planned_light(m, a)?;
            (
                format!(
                    "light -> on={} mode={} colour={} speed={} brightness={}",
                    new.on,
                    new.mode,
                    new.color.to_hex(),
                    new.speed,
                    new.brightness
                ),
                json!(new),
            )
        }
        MouseAction::Debounce(ms) => {
            if *ms > 15 {
                bail!("debounce {ms} ms out of range 0..=15");
            }
            (format!("debounce -> {ms} ms"), json!(ms))
        }
        MouseAction::Flag(name, on, _) => (format!("{name} -> {}", yn(*on)), json!(on)),
        MouseAction::Sleep(seconds) => {
            let stored = (*seconds / 10) as u8;
            if !pm::SLEEP_TIMES.contains(&stored) || *seconds % 10 != 0 {
                bail!(
                    "invalid sleep timeout {seconds}s (valid: {:?} s)",
                    pm::SLEEP_TIMES
                        .iter()
                        .map(|t| *t as u16 * 10)
                        .collect::<Vec<_>>()
                );
            }
            (format!("sleep timeout -> {seconds} s"), json!(stored))
        }
        MouseAction::SensorMode(mode) => {
            let v = match mode.as_str() {
                "lp" => 0,
                "hp" => 1,
                _ => bail!("invalid sensor mode '{mode}' (want lp or hp)"),
            };
            (format!("sensor mode -> {}", mode.to_uppercase()), json!(v))
        }
        MouseAction::Button(slot, kind, param) => {
            if *slot >= pm::BUTTON_SLOTS {
                bail!("invalid button slot {slot} (0..{})", pm::BUTTON_SLOTS - 1);
            }
            let (k, p) = parse_button(kind, param.as_deref())?;
            (
                format!("button {slot} -> kind {k} param 0x{p:04x}"),
                json!({ "kind": k, "param": p }),
            )
        }
    })
}

fn check_stage(stage: usize) -> Result<()> {
    if stage >= pm::MAX_STAGES {
        bail!("invalid DPI stage {stage} (0..{})", pm::MAX_STAGES - 1);
    }
    Ok(())
}

/// Compute the `Light` record a light action would produce, so it can be
/// described and verified.
fn planned_light(m: &mut pm::CompxMouse, a: &MouseAction) -> Result<pm::Light> {
    let mut l = m.read_config().map_err(mouse_err)?.light;
    match a {
        MouseAction::LightOn => {
            l.on = true;
            if l.mode == 0 {
                l.mode = 1; // mode 0 is "off"; pick rainbow so `on` is meaningful
            }
        }
        MouseAction::LightOff => l.on = false,
        MouseAction::LightMode(mode) => {
            if *mode > 6 {
                bail!("invalid light mode {mode} (0..=6)");
            }
            l.mode = *mode;
            if *mode != 0 {
                l.on = true;
            }
        }
        MouseAction::LightColor(color) => {
            l.color = pm::Rgb::parse(color)?;
        }
        MouseAction::LightSpeed(v) => {
            check_light_level(*v, "speed")?;
            l.speed = *v;
        }
        MouseAction::LightBrightness(v) => {
            check_light_level(*v, "brightness")?;
            l.brightness = *v;
        }
        _ => unreachable!("not a light action"),
    }
    Ok(l)
}

fn check_light_level(v: u8, what: &str) -> Result<()> {
    if !(1..=9).contains(&v) {
        bail!("light {what} {v} out of range 1..=9");
    }
    Ok(())
}

fn parse_button(kind: &str, param: Option<&str>) -> Result<(u8, u16)> {
    let k = match kind {
        "disabled" => pm::BUTTON_DISABLED,
        "mouse" => pm::BUTTON_MOUSE,
        "dpi" => pm::BUTTON_DPI,
        "shortcut" => 5,
        "macro" => 6,
        _ => bail!("invalid button kind '{kind}' (disabled|mouse|dpi|shortcut|macro)"),
    };
    let p = match (k, param) {
        (pm::BUTTON_DISABLED, _) => 0,
        (pm::BUTTON_MOUSE, None) => 0x0100, // left
        (pm::BUTTON_DPI, None) => 0x0100,
        (_, None) => 0,
        (_, Some(s)) => {
            if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u16::from_str_radix(h, 16).map_err(|_| anyhow!("bad button param '{s}'"))?
            } else if k == pm::BUTTON_MOUSE {
                match s {
                    "left" => 0x0100,
                    "right" => 0x0200,
                    "middle" => 0x0400,
                    "back" => 0x0800,
                    "forward" => 0x1000,
                    _ => bail!(
                        "unknown mouse button '{s}' (left|right|middle|back|forward or 0x0100…)"
                    ),
                }
            } else {
                s.parse().map_err(|_| anyhow!("bad button param '{s}'"))?
            }
        }
    };
    Ok((k, p))
}

fn apply_action(m: &mut pm::CompxMouse, a: &MouseAction) -> Result<()> {
    match a {
        MouseAction::Polling(hz) => m.set_report_rate(*hz),
        MouseAction::Dpi(stage, dpi) => m.set_dpi(*stage, *dpi),
        MouseAction::DpiColor(stage, color) => m.set_dpi_color(*stage, pm::Rgb::parse(color)?),
        MouseAction::Stages(n) => m.set_stage_count(*n),
        MouseAction::Stage(i) => m.set_current_stage(*i),
        MouseAction::Lod(v) => m.set_lod(*v),
        MouseAction::LightOn
        | MouseAction::LightOff
        | MouseAction::LightMode(_)
        | MouseAction::LightColor(_)
        | MouseAction::LightSpeed(_)
        | MouseAction::LightBrightness(_) => {
            let l = planned_light(m, a)?;
            m.set_light(&l)
        }
        MouseAction::Debounce(ms) => m.set_debounce(*ms),
        MouseAction::Flag(_, on, addr) => m.set_flag(*addr, *on),
        MouseAction::Sleep(seconds) => m.set_sleep((*seconds / 10) as u8),
        MouseAction::SensorMode(mode) => {
            m.set_sensor_mode(if mode.as_str() == "lp" { 0 } else { 1 })
        }
        MouseAction::Button(slot, kind, param) => {
            let (k, p) = parse_button(kind, param.as_deref())?;
            m.set_button(*slot, pm::Button { kind: k, param: p })
        }
    }
}

/// Extract the field this action touched from a freshly read config, in the
/// same JSON shape `plan_action` produced as `expected`.
fn readback_field(c: &pm::MouseConfig, a: &MouseAction) -> serde_json::Value {
    match a {
        MouseAction::Polling(_) => json!(c.report_rate),
        MouseAction::Dpi(stage, _) => json!(c.dpi[*stage]),
        MouseAction::DpiColor(stage, _) => json!(c.dpi_colors[*stage]),
        MouseAction::Stages(_) => json!(c.stage_count),
        MouseAction::Stage(_) => json!(c.current_stage),
        MouseAction::Lod(_) => json!(c.lod),
        MouseAction::LightOn
        | MouseAction::LightOff
        | MouseAction::LightMode(_)
        | MouseAction::LightColor(_)
        | MouseAction::LightSpeed(_)
        | MouseAction::LightBrightness(_) => {
            // planned_light's output is the expected value; compare field-wise.
            json!(c.light)
        }
        MouseAction::Debounce(_) => json!(c.debounce),
        MouseAction::Flag(name, _, _) => match *name {
            "motion_sync" => json!(c.motion_sync),
            "angle_snap" => json!(c.angle_snap),
            "ripple" => json!(c.ripple),
            _ => json!(c.light_off_moving),
        },
        MouseAction::Sleep(_) => json!(c.sleep),
        MouseAction::SensorMode(mode) => json!(if mode.as_str() == "lp" { 0 } else { 1 }),
        MouseAction::Button(slot, _, _) => json!(c.buttons[*slot]),
    }
}

// ── HE keyboard (v2 protocol) ──────────────────────────────────────────

#[derive(Subcommand)]
enum KbCommands {
    /// Firmware version, protocol, board id and build time.
    Info,
    /// Physical key geometry plus layer-0 keycodes resolved to labels.
    Layout,
    /// Raw 21 keycodes of one matrix row on a layer.
    Keys { layer: u8, row: u8 },
    /// Live per-key travel (mm) and actuation state of one matrix row.
    Live { row: u8 },
    /// Profiles: count and active profile; switch the active profile.
    Profile {
        #[command(subcommand)]
        command: KbProfile,
    },
    /// Polling rate: list supported rates / switch rate (restarts keyboard).
    Polling {
        #[command(subcommand)]
        command: KbPolling,
    },
    /// OS mode: Windows or macOS key layout.
    Os {
        #[command(subcommand)]
        command: KbOs,
    },
    /// Per-key actuation / rapid-trigger settings.
    Perf {
        #[command(subcommand)]
        command: KbPerf,
    },
    /// Lighting zones: effect settings and the 8-colour palette.
    Light {
        #[command(subcommand)]
        command: KbLight,
    },
    /// List the keyboard's lighting zones and their effect counts.
    LightingAreas,
    /// Finest rapid-trigger step in millimetres.
    RtPrecision,
    /// Lighting sleep timeout in minutes (0 = never).
    LightSleep {
        #[command(subcommand)]
        command: KbLightSleep,
    },
    /// Travel calibration: `start` begins, `stop` finishes. A device
    /// operation — the keyboard recalibrates its hall sensors.
    Calibration {
        #[command(subcommand)]
        command: KbCalibration,
    },
    /// SparkPlayJoy keyboards only: prove device identity, then emit the
    /// live 6x21 travel matrix (µm). `--watch` streams a sample every
    /// ~100 ms until Ctrl-C.
    TravelMatrix {
        /// Stream travel samples every ~100 ms instead of one shot.
        #[arg(long)]
        watch: bool,
    },
}

#[derive(Subcommand)]
enum KbProfile {
    /// Show the profile count and the active profile.
    /// (Per-profile names are not exposed by the v2 protocol port.)
    Get,
    /// Switch the active profile. Requires `--yes`; read back and verified.
    Set {
        #[command(flatten)]
        yes: Yes,
        /// Profile index, 0-based, must be < profile count.
        index: u8,
    },
}

#[derive(Subcommand)]
enum KbPolling {
    /// Show the supported rates and the active one.
    Get,
    /// Set the polling rate (`8k|4k|2k|1k|500|250|125`). Requires `--yes`.
    /// The keyboard restarts afterwards and may drop off the bus, so a
    /// missing read-back answer is reported as unverified, not an error.
    Set {
        #[command(flatten)]
        yes: Yes,
        rate: String,
    },
}

#[derive(Subcommand)]
enum KbOs {
    /// Show the OS mode (0 = Windows, 1 = macOS).
    Get,
    /// Set the OS mode. Requires `--yes`; read back and verified.
    Set {
        #[command(flatten)]
        yes: Yes,
        #[arg(value_parser = ["windows", "macos"])]
        os: String,
    },
}

/// Shared arguments of `perf set` / `perf set-all`.
#[derive(Args, Clone)]
struct PerfWrite {
    /// `fixed` = actuation point, `rt` = rapid trigger.
    #[arg(long, value_parser = ["fixed", "rt"])]
    mode: String,
    /// Actuation depth in mm: `normal_press` for fixed mode,
    /// `rt_first_touch` for rapid trigger. Must be > 0 and ≤ the switch's
    /// maximum travel (3.5 mm for UFO switches, else 3.4 mm).
    #[arg(long)]
    actuation: f32,
    /// Rapid-trigger first-touch depth in mm (rt mode).
    #[arg(long)]
    rt_first: Option<f32>,
    /// Rapid-trigger press sensitivity in mm.
    #[arg(long)]
    rt_press: Option<f32>,
    /// Rapid-trigger release sensitivity in mm.
    #[arg(long)]
    rt_release: Option<f32>,
    /// Top (press) deadzone in mm, 0..=1.0.
    #[arg(long)]
    dz_press: Option<f32>,
    /// Bottom (release) deadzone in mm, 0..=1.0.
    #[arg(long)]
    dz_release: Option<f32>,
}

#[derive(Subcommand)]
enum KbPerf {
    /// Read one key's performance settings.
    Get { row: u8, col: u8 },
    /// Write one key's performance settings (read-modify-write: the
    /// switch echo fields are carried from the read, never invented).
    /// Requires `--yes`; read back and verified.
    Set {
        #[command(flatten)]
        yes: Yes,
        #[command(flatten)]
        write: PerfWrite,
        row: u8,
        col: u8,
    },
    /// Apply the same settings to every key slot (~5 ms between writes,
    /// like the official driver). Requires `--yes`; every key is read
    /// back and verified.
    SetAll {
        #[command(flatten)]
        yes: Yes,
        #[command(flatten)]
        write: PerfWrite,
    },
}

#[derive(Subcommand)]
enum KbLight {
    /// Read one lighting zone's settings and palette.
    Get { area: u8 },
    /// Change one lighting zone. Every flag is optional; at least one
    /// change is required. Requires `--yes`; read back and verified.
    Set {
        #[command(flatten)]
        yes: Yes,
        area: u8,
        /// Turn the zone on.
        #[arg(long, conflicts_with = "off")]
        on: bool,
        /// Turn the zone off.
        #[arg(long)]
        off: bool,
        /// Effect mode id (valid ids depend on the zone).
        #[arg(long)]
        mode: Option<u8>,
        /// Brightness 0-100 %.
        #[arg(long)]
        brightness: Option<u8>,
        /// Effect speed 0-100 %.
        #[arg(long)]
        speed: Option<u8>,
        /// Direction: `fwd` (0) or `back` (1).
        #[arg(long, value_parser = ["fwd", "back"])]
        direction: Option<String>,
        /// Palette colour index 0-7.
        #[arg(long)]
        color: Option<u8>,
    },
    /// The zone's 8-colour palette.
    Palette {
        #[command(subcommand)]
        command: KbPalette,
    },
}

#[derive(Subcommand)]
enum KbPalette {
    /// Show the 8 palette colours as #rrggbb.
    Get { area: u8 },
    /// Replace palette entries: the given colours overwrite entries
    /// 0..n and the remaining entries keep their current values.
    /// Requires `--yes`; read back and verified.
    Set {
        #[command(flatten)]
        yes: Yes,
        area: u8,
        /// 1-8 colours as #rrggbb.
        colors: Vec<String>,
    },
}

#[derive(Subcommand)]
enum KbLightSleep {
    /// Show the lighting sleep timeout in minutes (0 = never).
    Get,
    /// Set the lighting sleep timeout. Requires `--yes`; valid values are
    /// the official driver's options (0,1,2,3,5,10,15,20,25,30,45,60,120).
    /// Read back and verified.
    Set {
        #[command(flatten)]
        yes: Yes,
        minutes: u16,
    },
}

#[derive(Subcommand)]
enum KbCalibration {
    /// Begin travel calibration (device operation: the keyboard
    /// recalibrates its hall sensors). Requires `--yes`.
    Start {
        #[command(flatten)]
        yes: Yes,
    },
    /// Finish travel calibration. Requires `--yes`.
    Stop {
        #[command(flatten)]
        yes: Yes,
    },
}

/// Open the HE keyboard: explicit `--device` must resolve to an HE v2
/// interface (a K1 Pro / khub916 device is rejected clearly), otherwise
/// the single connected HE keyboard is auto-selected.
fn open_kb(cli: &Cli) -> Result<Option<(DeviceInfo, he::HeKeyboard)>> {
    let devices = find_devices()?;
    let device = if let Some(sel) = cli.device.as_deref() {
        let matches: Vec<&DeviceInfo> = devices.iter().filter(|d| device_matches(d, sel)).collect();
        match matches.len() {
            0 => return Ok(None),
            1 => {
                let d = matches[0];
                if d.kind != DeviceKind::HeKeyboardV2 {
                    bail!(
                        "{} ({}) is {}, not an HE keyboard — `omg kb` only drives the HE v2 protocol",
                        d.vid_pid(),
                        d.path,
                        d.kind.label()
                    );
                }
                d.clone()
            }
            n => bail!("selector '{sel}' matches {n} devices; be more specific"),
        }
    } else {
        let kbs: Vec<DeviceInfo> = devices
            .into_iter()
            .filter(|d| d.kind == DeviceKind::HeKeyboardV2)
            .collect();
        match select_device(&kbs, None)? {
            Some(d) => d.clone(),
            None => return Ok(None),
        }
    };
    let link = device.open_link()?;
    Ok(Some((device, he::HeKeyboard::new(Box::new(link)))))
}

fn kb_absent(cli: &Cli) -> Result<ExitCode> {
    if cli.json {
        print_json(
            &json!({ "error": "no HE keyboard (v2 protocol) detected (omg devices lists what was found)" }),
        )?;
    } else {
        println!("no HE keyboard (v2 protocol) detected (omg devices lists what was found)");
    }
    Ok(no_device())
}

fn cmd_kb(cli: &Cli, command: &KbCommands) -> Result<ExitCode> {
    match command {
        KbCommands::Info => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let info = kb.info()?;
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "info": {
                        "firmware": info.firmware,
                        "pcb": info.pcb,
                        "build_time": info.build_time,
                        "protocol": info.protocol,
                        "board_id": info.board_id,
                    },
                }))?;
            } else {
                println!("{}", device.vid_pid());
                println!("firmware:    {}", info.firmware);
                println!("pcb:         {}", info.pcb);
                println!("build time:  {}", info.build_time);
                println!("protocol:    {}", info.protocol);
                println!("board id:    0x{:08X}", info.board_id);
            }
            Ok(ExitCode::SUCCESS)
        }
        KbCommands::Layout => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let slots = kb.key_slots()?;
            // Layer-0 keycodes for every row that has keys.
            let mut rows: Vec<u8> = slots.iter().map(|s| s.row).collect();
            rows.sort_unstable();
            rows.dedup();
            let mut codes: std::collections::BTreeMap<u8, [u16; 21]> = Default::default();
            for &row in &rows {
                codes.insert(row, kb.key_codes(0, row)?);
            }
            struct Row {
                row: u8,
                col: u8,
                x: f32,
                y: f32,
                size: u8,
                w: f32,
                h: f32,
                code: u16,
                label: String,
            }
            let keys: Vec<Row> = slots
                .iter()
                .map(|s| {
                    let code = codes.get(&s.row).map(|c| c[s.col as usize]).unwrap_or(0);
                    let (w, h, _) = omg_model::key_size(s.size);
                    Row {
                        row: s.row,
                        col: s.col,
                        x: s.x,
                        y: s.y,
                        size: s.size,
                        w,
                        h,
                        code,
                        label: omg_model::key_label(code, false),
                    }
                })
                .collect();
            if cli.json {
                let v: Vec<serde_json::Value> = keys
                    .iter()
                    .map(|k| {
                        json!({
                            "row": k.row, "col": k.col,
                            "x": k.x, "y": k.y, "size": k.size,
                            "w": k.w, "h": k.h,
                            "keycode": format!("0x{:04X}", k.code),
                            "label": k.label,
                        })
                    })
                    .collect();
                print_json(&json!({ "device": device, "layer": 0, "keys": v }))?;
            } else {
                println!("{} keys (layer 0):", keys.len());
                for k in &keys {
                    println!(
                        "  r{} c{:<2} {:<10} {:.2}x{:.2}u @({:.2},{:.2}) 0x{:04X} size {}",
                        k.row, k.col, k.label, k.w, k.h, k.x, k.y, k.code, k.size
                    );
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        KbCommands::Keys { layer, row } => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let codes = kb.key_codes(*layer, *row)?;
            let entries: Vec<serde_json::Value> = codes
                .iter()
                .enumerate()
                .map(|(col, &c)| json!({ "col": col, "code": format!("0x{c:04X}"), "label": omg_model::key_label(c, false) }))
                .collect();
            if cli.json {
                print_json(
                    &json!({ "device": device, "layer": layer, "row": row, "keys": entries }),
                )?;
            } else {
                for (col, &c) in codes.iter().enumerate() {
                    if c != 0 {
                        println!("col {col:<2} 0x{c:04X}  {}", omg_model::key_label(c, false));
                    }
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        KbCommands::Live { row } => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let live = kb.live_row(*row)?;
            if cli.json {
                let cols: Vec<serde_json::Value> = live
                    .iter()
                    .enumerate()
                    .map(|(col, &(t, a))| json!({ "col": col, "travel_mm": t, "actuated": a }))
                    .collect();
                print_json(&json!({ "device": device, "row": row, "keys": cols }))?;
            } else {
                println!("row {row} (travel mm / actuated):");
                for (col, &(t, a)) in live.iter().enumerate() {
                    if t > 0.0005 || a {
                        println!(
                            "  col {col:<2} {t:>6.3}  {}",
                            if a { "ACTUATED" } else { "" }
                        );
                    }
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        KbCommands::Profile { command } => match command {
            KbProfile::Get => {
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                let count = kb.profile_count()?;
                let active = kb.profile()?;
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "count": count,
                        "active": active,
                        "name": serde_json::Value::Null,
                        "name_supported": false,
                    }))?;
                } else {
                    println!("profiles: {} (active: {})", count, active + 1);
                    println!("note: per-profile names are not exposed by the v2 protocol");
                }
                Ok(ExitCode::SUCCESS)
            }
            KbProfile::Set { yes, index } => {
                if !yes.yes {
                    bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
                }
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                let count = kb.profile_count()?;
                if *index >= count {
                    bail!(
                        "profile index {index} out of range (0..{})",
                        count.saturating_sub(1)
                    );
                }
                kb.set_profile(*index)?;
                let actual = kb.profile()?;
                let verified = actual == *index;
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "change": format!("active profile -> {}", index + 1),
                        "expected": index,
                        "actual": actual,
                        "verified": verified,
                    }))?;
                } else {
                    println!("active profile -> {}", index + 1);
                    println!("verified: {verified}");
                }
                Ok(if verified {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                })
            }
        },
        KbCommands::Polling { command } => match command {
            KbPolling::Get => {
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                let current = kb.report_rate()?;
                let supported = kb.report_rates()?;
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "current_id": current,
                        "current": rate_name(current),
                        "supported_ids": supported,
                        "supported": supported.iter().map(|&i| rate_name(i)).collect::<Vec<_>>(),
                    }))?;
                } else {
                    println!("polling: {} Hz ({})", rate_hz(current), rate_name(current));
                    println!(
                        "supported: {}",
                        supported
                            .iter()
                            .map(|&i| rate_name(i))
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                }
                Ok(ExitCode::SUCCESS)
            }
            KbPolling::Set { yes, rate } => {
                if !yes.yes {
                    bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
                }
                let id = parse_polling_rate(rate)?;
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                let supported = kb.report_rates()?;
                if !supported.contains(&id) {
                    bail!(
                        "{} Hz is not in this keyboard's supported list ({})",
                        rate_hz(id),
                        supported
                            .iter()
                            .map(|&i| rate_name(i))
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                }
                kb.set_report_rate(id)?; // NoAnswer tolerated: the keyboard restarts
                                         // Read back; a restarted keyboard may not answer in time.
                let (actual, verified) = match kb.report_rate() {
                    Ok(v) => (json!(v), json!(v == id)),
                    Err(e) if e.is::<NoAnswer>() => (
                        json!("no answer (keyboard restarted)"),
                        serde_json::Value::Null,
                    ),
                    Err(e) => return Err(e),
                };
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "change": format!("polling rate -> {} Hz", rate_hz(id)),
                        "expected": id,
                        "actual": actual,
                        "verified": verified,
                    }))?;
                } else {
                    println!("polling rate -> {} Hz", rate_hz(id));
                    println!("note: the keyboard restarts after this change");
                    println!("verified: {}", verified);
                }
                Ok(if verified == json!(false) {
                    ExitCode::from(1)
                } else {
                    ExitCode::SUCCESS
                })
            }
        },
        KbCommands::Os { command } => match command {
            KbOs::Get => {
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                let v = kb.system()?;
                let name = if v == 0 { "windows" } else { "macos" };
                if cli.json {
                    print_json(&json!({ "device": device, "os": name, "os_id": v }))?;
                } else {
                    println!("os mode: {name}");
                }
                Ok(ExitCode::SUCCESS)
            }
            KbOs::Set { yes, os } => {
                if !yes.yes {
                    bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
                }
                let v = if os == "windows" { 0 } else { 1 };
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                kb.set_system(v)?;
                let actual = kb.system()?;
                let verified = actual == v;
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "change": format!("os mode -> {os}"),
                        "expected": os,
                        "actual": actual,
                        "verified": verified,
                    }))?;
                } else {
                    println!("os mode -> {os}");
                    println!("verified: {verified}");
                }
                Ok(if verified {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                })
            }
        },
        KbCommands::Perf { command } => cmd_kb_perf(cli, command),
        KbCommands::Light { command } => cmd_kb_light(cli, command),
        KbCommands::LightingAreas => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let areas = kb.lighting_areas()?;
            if cli.json {
                let v: Vec<serde_json::Value> = areas
                    .iter()
                    .map(|a| json!({ "index": a.index, "effects": a.count }))
                    .collect();
                print_json(&json!({ "device": device, "areas": v }))?;
            } else if areas.is_empty() {
                println!("no lighting areas reported");
            } else {
                for a in &areas {
                    println!("area {}: {} effects", a.index, a.count);
                }
            }
            Ok(ExitCode::SUCCESS)
        }
        KbCommands::RtPrecision => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let mm = kb.rt_precision()?;
            if cli.json {
                print_json(&json!({ "device": device, "rt_precision_mm": mm }))?;
            } else {
                println!("rapid-trigger precision: {:.3} mm", mm);
            }
            Ok(ExitCode::SUCCESS)
        }
        KbCommands::LightSleep { command } => match command {
            KbLightSleep::Get => {
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                let minutes = kb.lighting_sleep()?;
                if cli.json {
                    print_json(&json!({ "device": device, "light_sleep_minutes": minutes }))?;
                } else {
                    println!(
                        "lighting sleep: {}",
                        if minutes == 0 {
                            "never".to_string()
                        } else {
                            format!("{minutes} min")
                        }
                    );
                }
                Ok(ExitCode::SUCCESS)
            }
            KbLightSleep::Set { yes, minutes } => {
                if !yes.yes {
                    bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
                }
                if !omg_model::LIGHT_SLEEP_MINUTES.contains(minutes) {
                    bail!(
                        "invalid sleep timeout {minutes} min (valid: {:?})",
                        omg_model::LIGHT_SLEEP_MINUTES
                    );
                }
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                kb.set_lighting_sleep(*minutes)?;
                let actual = kb.lighting_sleep()?;
                let verified = actual == *minutes;
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "change": format!("lighting sleep -> {minutes} min"),
                        "expected": minutes,
                        "actual": actual,
                        "verified": verified,
                    }))?;
                } else {
                    println!("lighting sleep -> {minutes} min");
                    println!("verified: {verified}");
                }
                Ok(if verified {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                })
            }
        },
        KbCommands::Calibration { command } => {
            let (yes, start) = match command {
                KbCalibration::Start { yes } => (yes, true),
                KbCalibration::Stop { yes } => (yes, false),
            };
            if !yes.yes {
                bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
            }
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            match kb.calibration(start) {
                Ok(()) => {
                    if cli.json {
                        print_json(&json!({
                            "device": device,
                            "change": if start { "calibration start" } else { "calibration stop" },
                            "sent": true,
                            "verified": serde_json::Value::Null,
                        }))?;
                    } else {
                        println!("calibration {} sent", if start { "start" } else { "stop" });
                    }
                    Ok(ExitCode::SUCCESS)
                }
                Err(e) if e.is::<NoAnswer>() => {
                    // The keyboard may be busy recalibrating; the command
                    // was sent, there is just no read-back path.
                    if cli.json {
                        print_json(&json!({
                            "device": device,
                            "change": if start { "calibration start" } else { "calibration stop" },
                            "sent": true,
                            "verified": serde_json::Value::Null,
                            "note": "no answer (keyboard busy recalibrating)",
                        }))?;
                    } else {
                        println!(
                            "calibration {} sent (no answer — keyboard busy recalibrating)",
                            if start { "start" } else { "stop" }
                        );
                    }
                    Ok(ExitCode::SUCCESS)
                }
                Err(e) => Err(e),
            }
        }
        KbCommands::TravelMatrix { watch } => cmd_kb_travel(cli, *watch),
    }
}

// ── SparkPlayJoy travel matrix ─────────────────────────────────────────

/// Open a SparkPlayJoy device. An explicit `--device` must resolve to a
/// SparkPlayJoy interface; otherwise the single connected one is picked.
fn open_spark(cli: &Cli) -> Result<Option<(DeviceInfo, spj::SparkPlayJoy)>> {
    let devices = find_devices()?;
    let device = if let Some(sel) = cli.device.as_deref() {
        let matches: Vec<&DeviceInfo> = devices.iter().filter(|d| device_matches(d, sel)).collect();
        match matches.len() {
            0 => return Ok(None),
            1 => {
                let d = matches[0];
                if d.kind != DeviceKind::SparkPlayJoy {
                    bail!(
                        "{} ({}) is {}, not a SparkPlayJoy device — `kb travel-matrix` only drives the SparkPlayJoy protocol",
                        d.vid_pid(),
                        d.path,
                        d.kind.label()
                    );
                }
                d.clone()
            }
            n => bail!("selector '{sel}' matches {n} devices; be more specific"),
        }
    } else {
        let sps: Vec<DeviceInfo> = devices
            .into_iter()
            .filter(|d| d.kind == DeviceKind::SparkPlayJoy)
            .collect();
        match select_device(&sps, None)? {
            Some(d) => d.clone(),
            None => return Ok(None),
        }
    };
    let link = device.open_link()?;
    Ok(Some((device, spj::SparkPlayJoy::new(Box::new(link)))))
}

fn spark_absent(cli: &Cli) -> Result<ExitCode> {
    if cli.json {
        print_json(
            &json!({ "error": "no SparkPlayJoy device detected (omg devices lists what was found)" }),
        )?;
    } else {
        println!("no SparkPlayJoy device detected (omg devices lists what was found)");
    }
    Ok(no_device())
}

fn travel_json(device: &DeviceInfo, t: &spj::TravelMatrix) -> serde_json::Value {
    json!({
        "device": device.vid_pid(),
        "travel_matrix_um": t,
    })
}

fn travel_summary(t: &spj::TravelMatrix) -> (usize, u16) {
    let mut nonzero = 0usize;
    let mut max = 0u16;
    for row in &t.samples_um {
        for &v in row {
            if v != 0 {
                nonzero += 1;
                max = max.max(v);
            }
        }
    }
    (nonzero, max)
}

fn cmd_kb_travel(cli: &Cli, watch: bool) -> Result<ExitCode> {
    let Some((device, mut sp)) = open_spark(cli)? else {
        return spark_absent(cli);
    };
    // Table board id when the VID:PID is known; structural-only proof
    // otherwise (Admission::exact_known_board reports which ran).
    let expected = spj::known_board_id(device.vid, device.pid);
    let admission = match sp.prove_identity(expected) {
        Ok(a) => a,
        Err(e) => {
            // The error message names the gate that failed.
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "admission": "failed",
                    "failed_gate": format!("{e:#}"),
                }))?;
            } else {
                println!("identity proof failed: {e:#}");
            }
            return Ok(ExitCode::from(1));
        }
    };
    if !watch {
        if cli.json {
            print_json(&json!({
                "device": device,
                "board_id": format!("0x{:08X}", admission.board_id),
                "exact_known_board": admission.exact_known_board,
                "scale": admission.scale,
                "travel_matrix_um": admission.travel,
            }))?;
        } else {
            println!("{} SparkPlayJoy", device.vid_pid());
            println!(
                "board id:   0x{:08X}{}",
                admission.board_id,
                if admission.exact_known_board {
                    " (known identity)"
                } else {
                    " (structural proof)"
                }
            );
            println!(
                "scale:      precision {} µm, travel {}..{} µm",
                admission.scale.precision_um,
                admission.scale.minimum_travel_um,
                admission.scale.maximum_travel_um
            );
            println!(
                "travel matrix (µm), {} samples:",
                admission
                    .travel
                    .samples_um
                    .iter()
                    .flatten()
                    .filter(|&&v| v != 0)
                    .count()
            );
            for (r, row) in admission.travel.samples_um.iter().enumerate() {
                let cells: Vec<String> = row
                    .iter()
                    .enumerate()
                    .filter(|&(_, &v)| v != 0)
                    .map(|(c, &v)| format!("c{c}={v}"))
                    .collect();
                if !cells.is_empty() {
                    println!("  row {r}: {}", cells.join(" "));
                }
            }
        }
        return Ok(ExitCode::SUCCESS);
    }

    // --watch: stream travel samples until Ctrl-C.
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    ctrlc::set_handler(move || flag.store(true, Ordering::SeqCst))
        .map_err(|e| anyhow!("failed to install Ctrl-C handler: {e}"))?;
    if cli.json {
        // One JSON object per line (JSONL) so consumers can stream-parse.
        println!(
            "{}",
            serde_json::to_string(&json!({
                "device": device.vid_pid(),
                "board_id": format!("0x{:08X}", admission.board_id),
                "event": "watch_start",
            }))?
        );
    } else {
        println!("watching travel (Ctrl-C to stop)…");
    }
    while !stop.load(Ordering::SeqCst) {
        match sp.travel() {
            Ok(t) => {
                if cli.json {
                    println!("{}", serde_json::to_string(&travel_json(&device, &t))?);
                } else {
                    let (nonzero, max) = travel_summary(&t);
                    println!("{nonzero} keys reporting, max {max} µm");
                }
            }
            Err(e) => {
                eprintln!("travel read failed: {e:#}");
                return Ok(ExitCode::from(1));
            }
        }
        // Sleep in 10 ms slices so Ctrl-C is noticed promptly.
        for _ in 0..10 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(ExitCode::SUCCESS)
}

// ── HE keyboard: performance ───────────────────────────────────────────

/// Parsed `perf set` / `perf set-all` arguments.
struct PerfSpec {
    mode: u8,
    actuation: f32,
    rt_first: Option<f32>,
    rt_press: Option<f32>,
    rt_release: Option<f32>,
    dz_press: Option<f32>,
    dz_release: Option<f32>,
}

fn perf_spec(w: &PerfWrite) -> Result<PerfSpec> {
    Ok(PerfSpec {
        mode: if w.mode == "rt" {
            he::MODE_RAPID
        } else {
            he::MODE_FIXED
        },
        actuation: w.actuation,
        rt_first: w.rt_first,
        rt_press: w.rt_press,
        rt_release: w.rt_release,
        dz_press: w.dz_press,
        dz_release: w.dz_release,
    })
}

/// Validate ranges and apply the spec on top of a read-modify-write base.
/// The switch echo fields (axis/calibrate/axis_v2_id/axis_range_max/
/// axis_coefficient) and untouched distances are carried from `base`.
fn apply_perf_spec(base: &he::KeyPerf, spec: &PerfSpec) -> Result<(he::KeyPerf, Vec<String>)> {
    let limit = omg_model::max_travel(base.axis_v2_id);
    let mut changes = Vec::new();
    let check_travel = |name: &str, v: f32| -> Result<()> {
        if !(v > 0.0 && v <= limit) {
            bail!("{name} {v} mm out of range for this switch (0 < v ≤ {limit} mm)");
        }
        Ok(())
    };
    let check_dz = |name: &str, v: f32| -> Result<()> {
        if !(0.0..=omg_model::DEADZONE_MAX).contains(&v) {
            bail!(
                "{name} {v} mm out of range 0..={:.1} mm",
                omg_model::DEADZONE_MAX
            );
        }
        Ok(())
    };
    check_travel("actuation", spec.actuation)?;
    for (name, v) in [
        ("rt-first", spec.rt_first),
        ("rt-press", spec.rt_press),
        ("rt-release", spec.rt_release),
    ]
    .into_iter()
    .filter_map(|(n, v)| v.map(|v| (n, v)))
    {
        check_travel(name, v)?;
    }
    for (name, v) in [("dz-press", spec.dz_press), ("dz-release", spec.dz_release)]
        .into_iter()
        .filter_map(|(n, v)| v.map(|v| (n, v)))
    {
        check_dz(name, v)?;
    }

    let mut p = *base;
    let mode_name = |m: u8| if m == he::MODE_RAPID { "rt" } else { "fixed" };
    if p.mode != spec.mode {
        changes.push(format!(
            "mode {} -> {}",
            mode_name(p.mode),
            mode_name(spec.mode)
        ));
        p.mode = spec.mode;
    }
    // --actuation drives the mode's primary depth.
    let (field, old) = if spec.mode == he::MODE_FIXED {
        ("normal_press", p.normal_press)
    } else {
        ("rt_first_touch", p.rt_first_touch)
    };
    let new = spec.actuation;
    if (old - new).abs() > 0.0005 {
        changes.push(format!("{field} {old:.3} -> {new:.3} mm"));
    }
    if spec.mode == he::MODE_FIXED {
        p.normal_press = new;
    } else {
        p.rt_first_touch = new;
    }
    let set_opt = |dst: &mut f32, name: &str, v: Option<f32>, changes: &mut Vec<String>| {
        if let Some(v) = v {
            if (*dst - v).abs() > 0.0005 {
                changes.push(format!("{name} {dst:.3} -> {v:.3} mm"));
            }
            *dst = v;
        }
    };
    set_opt(
        &mut p.rt_first_touch,
        "rt_first_touch",
        spec.rt_first,
        &mut changes,
    );
    set_opt(&mut p.rt_press, "rt_press", spec.rt_press, &mut changes);
    set_opt(
        &mut p.rt_release,
        "rt_release",
        spec.rt_release,
        &mut changes,
    );
    set_opt(
        &mut p.press_deadzone,
        "press_deadzone",
        spec.dz_press,
        &mut changes,
    );
    set_opt(
        &mut p.release_deadzone,
        "release_deadzone",
        spec.dz_release,
        &mut changes,
    );
    if changes.is_empty() {
        changes.push("no effective change".to_string());
    }
    Ok((p, changes))
}

fn perf_json(p: &he::KeyPerf) -> serde_json::Value {
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

fn cmd_kb_perf(cli: &Cli, command: &KbPerf) -> Result<ExitCode> {
    match command {
        KbPerf::Get { row, col } => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let p = kb.key_perf(*row, *col)?;
            if cli.json {
                print_json(
                    &json!({ "device": device, "row": row, "col": col, "perf": perf_json(&p) }),
                )?;
            } else {
                println!("key r{row} c{col}:");
                println!(
                    "  mode:            {}",
                    if p.mode == he::MODE_RAPID {
                        "rapid trigger"
                    } else {
                        "fixed actuation"
                    }
                );
                println!(
                    "  actuation:       {:.3} mm",
                    if p.mode == he::MODE_RAPID {
                        p.rt_first_touch
                    } else {
                        p.normal_press
                    }
                );
                println!("  normal press:    {:.3} mm", p.normal_press);
                println!("  normal release:  {:.3} mm", p.normal_release);
                println!("  rt first touch:  {:.3} mm", p.rt_first_touch);
                println!("  rt press:        {:.3} mm", p.rt_press);
                println!("  rt release:      {:.3} mm", p.rt_release);
                println!(
                    "  deadzone:        {:.3} / {:.3} mm",
                    p.press_deadzone, p.release_deadzone
                );
                println!(
                    "  switch:          id {} axis {} cal {} range {} coeff {} (max {:.1} mm)",
                    p.axis_v2_id,
                    p.axis,
                    p.calibrate,
                    p.axis_range_max,
                    p.axis_coefficient,
                    omg_model::max_travel(p.axis_v2_id)
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        KbPerf::Set {
            yes,
            write,
            row,
            col,
        } => {
            if !yes.yes {
                bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
            }
            let spec = perf_spec(write)?;
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let base = kb.key_perf(*row, *col)?;
            let (new, changes) = apply_perf_spec(&base, &spec)?;
            kb.set_key_perf(*row, *col, &new)?;
            let actual = kb.key_perf(*row, *col)?;
            let verified = actual == new;
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "row": row, "col": col,
                    "change": changes.join("; "),
                    "expected": perf_json(&new),
                    "actual": perf_json(&actual),
                    "verified": verified,
                }))?;
            } else {
                println!("key r{row} c{col}: {}", changes.join("; "));
                println!("verified: {verified}");
                if !verified {
                    println!("expected: {}", serde_json::to_string(&perf_json(&new))?);
                    println!("actual:   {}", serde_json::to_string(&perf_json(&actual))?);
                }
            }
            Ok(if verified {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        KbPerf::SetAll { yes, write } => {
            if !yes.yes {
                bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
            }
            let spec = perf_spec(write)?;
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            let slots = kb.key_slots()?;
            let mut expected: Vec<((u8, u8), he::KeyPerf)> = Vec::with_capacity(slots.len());
            let mut failures: Vec<serde_json::Value> = Vec::new();
            for s in &slots {
                // Read-modify-write per key, like the official driver.
                let written = kb.key_perf(s.row, s.col).and_then(|base| {
                    let (new, _) = apply_perf_spec(&base, &spec)?;
                    kb.set_key_perf(s.row, s.col, &new)?;
                    Ok(new)
                });
                match written {
                    Ok(new) => {
                        expected.push(((s.row, s.col), new));
                        // Rate-limit like the official driver (~5 ms/key).
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(e) => failures.push(json!({ "row": s.row, "col": s.col, "stage": "write", "error": format!("{e:#}") })),
                }
            }
            // Read-back verify pass over the keys that were written.
            let mut verified_count = 0usize;
            for ((row, col), want) in &expected {
                match kb.key_perf(*row, *col) {
                    Ok(actual) if actual == *want => verified_count += 1,
                    Ok(_) => failures.push(json!({ "row": row, "col": col, "stage": "verify", "error": "read-back mismatch" })),
                    Err(e) => failures.push(json!({ "row": row, "col": col, "stage": "verify", "error": format!("{e:#}") })),
                }
            }
            let total = slots.len();
            let written = expected.len();
            let ok = failures.is_empty() && verified_count == total;
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "keys": total,
                    "written": written,
                    "verified": verified_count,
                    "failures": failures,
                    "mode": if spec.mode == he::MODE_RAPID { "rt" } else { "fixed" },
                    "actuation": spec.actuation,
                }))?;
            } else {
                println!("perf set-all: {written}/{total} keys written, {verified_count} verified");
                for f in &failures {
                    println!(
                        "  r{} c{} [{}]: {}",
                        f["row"],
                        f["col"],
                        f["stage"].as_str().unwrap_or("?"),
                        f["error"].as_str().unwrap_or("?")
                    );
                }
            }
            Ok(if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
    }
}

// ── HE keyboard: lighting ──────────────────────────────────────────────

fn light_json(l: &he::LightingBase) -> serde_json::Value {
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

fn parse_rgb_hex(s: &str) -> Result<he::Rgb> {
    let t = s.trim().strip_prefix('#').unwrap_or(s.trim());
    if t.len() != 6 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("invalid colour '{s}' (want #rrggbb)");
    }
    let v = u32::from_str_radix(t, 16).map_err(|_| anyhow!("invalid colour '{s}'"))?;
    Ok(he::Rgb {
        r: ((v >> 16) & 0xff) as u8,
        g: ((v >> 8) & 0xff) as u8,
        b: (v & 0xff) as u8,
    })
}

/// Check that `area` is a zone the keyboard reported (when it reports any).
fn check_light_area(kb: &mut he::HeKeyboard, area: u8) -> Result<()> {
    let areas = kb.lighting_areas()?;
    if !areas.is_empty() && !areas.iter().any(|a| a.index == area) {
        bail!(
            "lighting area {area} not present (areas: {})",
            areas
                .iter()
                .map(|a| a.index.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}

fn cmd_kb_light(cli: &Cli, command: &KbLight) -> Result<ExitCode> {
    match command {
        KbLight::Get { area } => {
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            check_light_area(&mut kb, *area)?;
            let l = kb.lighting(*area)?;
            let palette = kb.palette(*area)?;
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "area": area,
                    "lighting": light_json(&l),
                    "palette": palette.iter().map(rgb_hex).collect::<Vec<_>>(),
                }))?;
            } else {
                let lj = light_json(&l);
                println!(
                    "area {area}: {} mode {} brightness {}% speed {}% dir {} color {}",
                    if l.on { "on " } else { "off" },
                    l.mode,
                    l.brightness,
                    l.speed,
                    lj["direction"].as_str().unwrap_or("?"),
                    l.color_index
                );
                println!(
                    "palette: {}",
                    palette.iter().map(rgb_hex).collect::<Vec<_>>().join(" ")
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        KbLight::Set {
            yes,
            area,
            on,
            off,
            mode,
            brightness,
            speed,
            direction,
            color,
        } => {
            if !yes.yes {
                bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
            }
            if !(*on
                || *off
                || mode.is_some()
                || brightness.is_some()
                || speed.is_some()
                || direction.is_some()
                || color.is_some())
            {
                bail!("nothing to change — pass at least one of --on/--off/--mode/--brightness/--speed/--direction/--color");
            }
            if let Some(b) = brightness {
                if *b > 100 {
                    bail!("brightness {b} out of range 0..=100");
                }
            }
            if let Some(s) = speed {
                if *s > 100 {
                    bail!("speed {s} out of range 0..=100");
                }
            }
            if let Some(c) = color {
                if *c > 7 {
                    bail!("color index {c} out of range 0..=7");
                }
            }
            let Some((device, mut kb)) = open_kb(cli)? else {
                return kb_absent(cli);
            };
            check_light_area(&mut kb, *area)?;
            let mut l = kb.lighting(*area)?;
            let before = light_json(&l);
            if *on {
                l.on = true;
            }
            if *off {
                l.on = false;
            }
            if let Some(m) = mode {
                // Validate against the zone's supported effect ids.
                let areas = kb.lighting_areas()?;
                let count = areas
                    .iter()
                    .find(|a| a.index == *area)
                    .map(|a| a.count)
                    .unwrap_or(0);
                let zone = omg_model::lighting_zone(*area, count);
                if !zone.modes.iter().any(|zm| zm.id == *m) {
                    bail!(
                        "mode {m} not valid for lighting area {area} (valid: {})",
                        zone.modes
                            .iter()
                            .map(|zm| zm.id.to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                }
                l.mode = *m;
            }
            if let Some(b) = brightness {
                l.brightness = *b;
            }
            if let Some(s) = speed {
                l.speed = *s;
            }
            if let Some(d) = direction {
                l.direction = if d == "fwd" { 0 } else { 1 };
            }
            if let Some(c) = color {
                l.color_index = *c;
            }
            kb.set_lighting(*area, &l)?;
            let actual = kb.lighting(*area)?;
            let verified = actual == l;
            let after = light_json(&actual);
            let describe = |v: &serde_json::Value| {
                format!(
                    "on={} mode={} bright={} speed={} dir={} color={}",
                    v["on"],
                    v["mode"],
                    v["brightness"],
                    v["speed"],
                    v["direction"],
                    v["color_index"]
                )
            };
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "area": area,
                    "before": before,
                    "expected": light_json(&l),
                    "actual": after,
                    "verified": verified,
                }))?;
            } else {
                println!(
                    "lighting area {area}: {} -> {}",
                    describe(&before),
                    describe(&after)
                );
                println!("verified: {verified}");
            }
            Ok(if verified {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        KbLight::Palette { command } => match command {
            KbPalette::Get { area } => {
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                check_light_area(&mut kb, *area)?;
                let palette = kb.palette(*area)?;
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "area": area,
                        "palette": palette.iter().map(|c| json!({
                            "hex": rgb_hex(c), "r": c.r, "g": c.g, "b": c.b,
                        })).collect::<Vec<_>>(),
                    }))?;
                } else {
                    for (i, c) in palette.iter().enumerate() {
                        println!("  {i}: {}", rgb_hex(c));
                    }
                }
                Ok(ExitCode::SUCCESS)
            }
            KbPalette::Set { yes, area, colors } => {
                if !yes.yes {
                    bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
                }
                if colors.is_empty() || colors.len() > 8 {
                    bail!("palette set needs 1-8 colours (got {})", colors.len());
                }
                let parsed: Vec<he::Rgb> = colors
                    .iter()
                    .map(|c| parse_rgb_hex(c))
                    .collect::<Result<_>>()?;
                let Some((device, mut kb)) = open_kb(cli)? else {
                    return kb_absent(cli);
                };
                check_light_area(&mut kb, *area)?;
                let mut palette = kb.palette(*area)?;
                for (i, c) in parsed.iter().enumerate() {
                    palette[i] = *c;
                }
                kb.set_palette(*area, &palette)?;
                let actual = kb.palette(*area)?;
                let verified = actual == palette;
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "area": area,
                        "change": format!("palette entries 0..{} -> {}", parsed.len() - 1, colors.join(" ")),
                        "expected": palette.iter().map(rgb_hex).collect::<Vec<_>>(),
                        "actual": actual.iter().map(rgb_hex).collect::<Vec<_>>(),
                        "verified": verified,
                    }))?;
                } else {
                    println!("palette area {area}: entries 0..{} set", parsed.len() - 1);
                    println!("verified: {verified}");
                }
                Ok(if verified {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                })
            }
        },
    }
}

fn rate_name(id: u8) -> String {
    he::REPORT_RATES
        .get(id as usize)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("id {id}"))
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

fn parse_polling_rate(s: &str) -> Result<u8> {
    let t = s.trim().to_lowercase();
    let id = match t.as_str() {
        "8k" | "8000" => 0,
        "4k" | "4000" => 1,
        "2k" | "2000" => 2,
        "1k" | "1000" => 3,
        "500" => 4,
        "250" => 5,
        "125" => 6,
        _ => bail!("invalid polling rate '{s}' (want 8k|4k|2k|1k|500|250|125)"),
    };
    Ok(id)
}

// ── khub916 keyboards (K1 / K1 Pro / K98 Pro, wired "916") ─────────────
//
// Read commands plus `screen info`/`screen plan`. The proto crate also
// exposes write_keymap / write_profile / write_custom_light_colors and
// the fire-and-forget screen writers (screen_begin/screen_frame/
// screen_push/screen_end/set_screen_clock), but they are deliberately NOT
// wired into the CLI: the keymap write needs a full 128-entry table while
// the device only returns 126 entries on read (length mismatch —
// docs/protocol-khub916.md §8), the profile field semantics are only
// partially proven, no write has been live-verified, and screen writes
// have no read-back path at all (docs/protocol-khub916-screen.md §2).
// The 916_wireLess transport is a separate bead.

#[derive(Subcommand)]
enum Kb916Commands {
    /// Device identity: UUID, catalog model name, firmware version, screen.
    Info,
    /// Full keymap decoded to labels (one u32 per position). `--layer`
    /// (0-3) and `--system` (0-1) select the read argument; the default
    /// `arg = layer | system<<2 = 0` is what the vendor driver reads.
    Keys {
        /// Layer bits 0-1 of the keymap argument.
        #[arg(long, default_value_t = 0)]
        layer: u8,
        /// System/layout bit (<<2) of the keymap argument.
        #[arg(long, default_value_t = 0)]
        system: u8,
    },
    /// Device profile/config blob (~128 B, cmd 132): current light mode,
    /// sleep timeout and the raw bytes.
    Profile {
        #[command(subcommand)]
        command: Kb916Profile,
    },
    /// Battery percent and raw status flags (cmd 135).
    Power,
    /// Per-key custom RGB colours (126 entries, cmd 134).
    LightColors {
        #[command(subcommand)]
        command: Kb916LightColors,
    },
    /// Per-mode light colour/effect blob (~480 B, cmd 138) as a hex dump.
    LightData,
    /// Macro region (≤512 B, cmd 133) as a hex dump.
    Macro,
    /// Screen display: capability report and image-push planning
    /// (docs/protocol-khub916-screen.md). Actual image/time writes are
    /// refused — see `omg kb916 screen --help`.
    Screen {
        #[command(subcommand)]
        command: Kb916Screen,
    },
    /// The 916_wireLess 2.4 GHz transport is a separate bead — always
    /// "not implemented".
    Wireless,
    /// Writes (keymap / profile / custom light colours) are not wired
    /// into the CLI yet — always "not implemented" (see module comment).
    Set {
        #[command(subcommand)]
        command: Kb916Set,
    },
}

#[derive(Subcommand)]
enum Kb916Screen {
    /// Screen capability report: keyboard-interface geometry (cmd 130),
    /// catalog topology, detected separate screen interfaces, wire-format
    /// limits and honesty notes. Read-only.
    Info,
    /// Dry-run plan for an image push: packet/chunk counts, wire size and
    /// the vendor pacing time estimate. Sends nothing to any device.
    Plan {
        /// Frame width in pixels (default 160 — the evidenced size).
        #[arg(long, default_value_t = khub::SCREEN_DEFAULT_WIDTH)]
        width: u16,
        /// Frame height in pixels (default 80).
        #[arg(long, default_value_t = khub::SCREEN_DEFAULT_HEIGHT)]
        height: u16,
        /// Number of frames, 1-255 (vendor UI caps at 150).
        #[arg(long, default_value_t = 1)]
        frames: usize,
        /// Frames per second; interval = round(1000/fps) ms. Mutually
        /// exclusive with --interval-ms.
        #[arg(long, conflicts_with = "interval_ms")]
        fps: Option<f64>,
        /// Frame interval in milliseconds directly (u16, ≤65535; the
        /// device-side unit is unverified — spec §8).
        #[arg(long)]
        interval_ms: Option<u16>,
    },
    /// Push an image/GIF to the screen — refused: the GIF→RGB565 frame
    /// pipeline is client-side and not implemented, and screen writes are
    /// fire-and-forget feature reports with no read-back verify.
    Push {
        /// Image or GIF file (unsupported today — see the error message).
        file: String,
    },
    /// Sync the screen RTC (cmd 11, wired keyboard interface) — refused:
    /// fire-and-forget write with no read-back, hardware-unverified.
    Clock,
}

#[derive(Subcommand)]
enum Kb916Profile {
    /// Show the decoded profile blob.
    Get,
}

#[derive(Subcommand)]
enum Kb916LightColors {
    /// Show all 126 per-key RGB colours.
    Get,
}

#[derive(Subcommand)]
enum Kb916Set {
    /// `omg kb916 set key <index> <keyvalue>` — pending.
    Key { index: usize, value: String },
    /// Full keymap write — pending.
    Keymap,
    /// Profile write — pending.
    Profile,
    /// Custom light colour write — pending.
    LightColors,
}

/// What `open_khub916` resolved to.
enum Kb916Session {
    Wired(DeviceInfo, khub::Khub916),
    /// A 916_wireLess device was selected — different transport.
    Wireless,
}

/// Select a khub916 wired device and open a session. Explicit `--device`
/// must resolve to a Khub916Wired interface (a wireless dongle or another
/// protocol's device is rejected); otherwise the single connected wired
/// khub916 device is auto-selected.
fn open_khub916(cli: &Cli) -> Result<Option<Kb916Session>> {
    let devices = find_devices()?;
    let candidates: Vec<DeviceInfo> = devices
        .iter()
        .filter(|d| d.kind == DeviceKind::Khub916Wired || d.kind == DeviceKind::Khub916Wireless)
        .cloned()
        .collect();
    let device = if let Some(sel) = cli.device.as_deref() {
        // Explicit selector may match any GravaStar device so the error
        // can say what it actually is.
        let matches: Vec<&DeviceInfo> = devices.iter().filter(|d| device_matches(d, sel)).collect();
        match matches.len() {
            0 => return Ok(None),
            1 => matches[0].clone(),
            n => bail!("selector '{sel}' matches {n} devices; be more specific"),
        }
    } else {
        let wired: Vec<DeviceInfo> = candidates
            .iter()
            .filter(|d| d.kind == DeviceKind::Khub916Wired)
            .cloned()
            .collect();
        match select_device(&wired, None)? {
            Some(d) => d.clone(),
            None => return Ok(None),
        }
    };
    if device.kind == DeviceKind::Khub916Wireless {
        return Ok(Some(Kb916Session::Wireless));
    }
    if device.kind != DeviceKind::Khub916Wired {
        bail!(
            "{} ({}) is {}, not a khub916 keyboard — `omg kb916` only drives the wired 916 protocol",
            device.vid_pid(),
            device.path,
            device.kind.label()
        );
    }
    let mut link = device.open_link()?;
    let report_id = khub::probe_report_id(&mut link)?;
    Ok(Some(Kb916Session::Wired(
        device,
        khub::Khub916::new(Box::new(link), report_id),
    )))
}

fn kb916_absent(cli: &Cli) -> Result<ExitCode> {
    if cli.json {
        print_json(
            &json!({ "error": "no khub916 wired keyboard detected (omg devices lists what was found)" }),
        )?;
    } else {
        println!("no khub916 wired keyboard detected (omg devices lists what was found)");
    }
    Ok(no_device())
}

/// Exit-code-3 "not implemented" path shared by screen / wireless / set.
fn kb916_unsupported(cli: &Cli, what: &str, pending: &str) -> Result<ExitCode> {
    let msg = format!("{what}: not implemented yet — {pending}");
    if cli.json {
        print_json(&json!({ "error": msg, "unsupported": true }))?;
    } else {
        eprintln!("error: {msg}");
    }
    Ok(ExitCode::from(3))
}

fn kb916_wireless_pending() -> &'static str {
    "the 916_wireLess transport (19-byte output reports, chunked writes, additive checksum) is a separate bead — docs/protocol-khub916.md §3/§7"
}

fn kb916_write_pending() -> &'static str {
    "writes are not wired into the CLI yet: the keymap write needs a full 128-entry table but the device returns 126 entries on read (length mismatch, docs/protocol-khub916.md §8), profile field semantics are only partially proven, and no khub916 write has been live-verified. Pending: `set key <index> <keyvalue>` via read-modify-write of the full keymap, `set profile`, `set light-colors`"
}

/// Resolve the session for a read command, mapping the wireless selection
/// to the unsupported exit.
fn kb916_session(cli: &Cli) -> Result<Result<(DeviceInfo, khub::Khub916), ExitCode>> {
    match open_khub916(cli)? {
        None => Ok(Err(kb916_absent(cli)?)),
        Some(Kb916Session::Wireless) => Ok(Err(kb916_unsupported(
            cli,
            "916_wireLess transport",
            kb916_wireless_pending(),
        )?)),
        Some(Kb916Session::Wired(d, k)) => Ok(Ok((d, k))),
    }
}

fn cmd_kb916(cli: &Cli, command: &Kb916Commands) -> Result<ExitCode> {
    // Commands that never touch the device (or handle their own session).
    match command {
        Kb916Commands::Screen { command } => return cmd_kb916_screen(cli, command),
        Kb916Commands::Wireless => {
            return kb916_unsupported(cli, "916_wireLess transport", kb916_wireless_pending());
        }
        Kb916Commands::Set { .. } => {
            return kb916_unsupported(cli, "khub916 writes", kb916_write_pending());
        }
        _ => {}
    }

    let (device, mut kb) = match kb916_session(cli)? {
        Ok(s) => s,
        Err(code) => return Ok(code),
    };

    match command {
        Kb916Commands::Info => {
            let info = kb.device_info()?;
            if cli.json {
                print_json(&json!({ "device": device, "info": info }))?;
            } else {
                println!("{}", device.vid_pid());
                println!("uuid:          {}", info.uuid);
                match (&info.catalog_model, &info.catalog_name) {
                    (Some(m), Some(n)) => println!("model:         {n} ({m})"),
                    (Some(m), None) => println!("model:         {m}"),
                    _ => println!("model:         (UUID not in the vendor catalog)"),
                }
                println!("version:       0x{:04X}", info.version);
                match info.screen {
                    Some((w, h)) => println!("screen:        {w}x{h} (code {})", info.screen_size),
                    None => println!("screen:        none (code {})", info.screen_size),
                }
            }
        }
        Kb916Commands::Keys { layer, system } => {
            if *layer > 3 || *system > 1 {
                bail!("invalid keymap argument: --layer must be 0-3, --system 0-1");
            }
            let arg = (*layer & 3) | ((*system & 1) << 2);
            let values = kb.key_values(arg)?;
            let keys: Vec<khub::KeyValue> =
                values.iter().map(|&v| khub::decode_key_value(v)).collect();
            if cli.json {
                let entries: Vec<serde_json::Value> = values
                    .iter()
                    .zip(&keys)
                    .enumerate()
                    .map(|(i, (&v, k))| {
                        json!({
                            "index": i,
                            "value": format!("0x{v:08X}"),
                            "label": k.label(),
                            "decoded": serde_json::to_value(k).unwrap_or(serde_json::Value::Null),
                        })
                    })
                    .collect();
                print_json(&json!({
                    "device": device,
                    "arg": format!("0x{arg:02X}"),
                    "layer": layer,
                    "system": system,
                    "count": values.len(),
                    "keys": entries,
                }))?;
            } else {
                println!(
                    "keymap: {} entries (arg 0x{arg:02X}, layer {layer}, system {system})",
                    values.len()
                );
                for (i, (v, k)) in values.iter().zip(&keys).enumerate() {
                    let label = k.label();
                    println!(
                        "  [{i:3}] 0x{v:08X}  {}",
                        if label.is_empty() {
                            "—".to_string()
                        } else {
                            label
                        }
                    );
                }
            }
        }
        Kb916Commands::Profile { command } => match command {
            Kb916Profile::Get => {
                let profile = kb.profile()?;
                let light_mode = profile.light_mode();
                let sleep = profile.sleep_seconds();
                if cli.json {
                    print_json(&json!({
                        "device": device,
                        "profile": {
                            "bytes": profile.raw.len(),
                            "light_mode": light_mode,
                            "sleep_seconds": sleep,
                            "hex": profile.raw.iter().map(|b| format!("{b:02x}")).collect::<String>(),
                        },
                    }))?;
                } else {
                    println!("profile: {} bytes", profile.raw.len());
                    println!(
                        "light mode: {}",
                        light_mode
                            .map(|m| m.to_string())
                            .unwrap_or_else(|| "(unparsed)".into())
                    );
                    println!(
                        "sleep:      {}",
                        sleep
                            .map(|s| format!("{s} s"))
                            .unwrap_or_else(|| "(unparsed)".into())
                    );
                    println!("hex:        {}", hex32_full(&profile.raw));
                }
            }
        },
        Kb916Commands::Power => {
            let p = kb.power()?;
            if cli.json {
                print_json(&json!({ "device": device, "power": p }))?;
            } else {
                println!("battery: {}%", p.percent);
                println!(
                    "flags:   0x{:02X} (raw — individual bits unconfirmed, spec §8)",
                    p.flags
                );
            }
        }
        Kb916Commands::LightColors { command } => match command {
            Kb916LightColors::Get => {
                let colors = kb.custom_light_colors()?;
                if cli.json {
                    let entries: Vec<serde_json::Value> = colors
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
                    print_json(&json!({
                        "device": device,
                        "count": colors.len(),
                        "colors": entries,
                    }))?;
                } else {
                    println!("custom light colours: {} entries", colors.len());
                    for c in &colors {
                        println!(
                            "  [{:3}] pos {:<3} #{:02X}{:02X}{:02X}",
                            c.index, c.pos, c.r, c.g, c.b
                        );
                    }
                }
            }
        },
        Kb916Commands::LightData => {
            let data = kb.light_color_data()?;
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "bytes": data.len(),
                    "hex": data.iter().map(|b| format!("{b:02x}")).collect::<String>(),
                }))?;
            } else {
                println!("light colour data: {} bytes", data.len());
                print_hex_dump(&data);
            }
        }
        Kb916Commands::Macro => {
            let data = kb.macro_region()?;
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "bytes": data.len(),
                    "hex": data.iter().map(|b| format!("{b:02x}")).collect::<String>(),
                }))?;
            } else {
                println!(
                    "macro region: {} bytes (raw — entry parsing not yet implemented)",
                    data.len()
                );
                print_hex_dump(&data);
            }
        }
        Kb916Commands::Screen { .. } | Kb916Commands::Wireless | Kb916Commands::Set { .. } => {
            unreachable!("handled before the session is opened")
        }
    }
    Ok(ExitCode::SUCCESS)
}

// ── khub916 screen (docs/protocol-khub916-screen.md) ──────────────────
//
// There is NO screen query command in the spec: cmd 130's `screen_size`
// byte on the keyboard interface is the only capability read, and the
// separate screen interface (VID 0x258A PID 0x01B4) is write-only in the
// vendor JS. `screen info` merges both views; `screen plan` is a pure
// dry-run; `push`/`clock` refuse because screen writes are
// fire-and-forget feature reports with no read-back verify.

/// Static wire-format facts shared by `screen info` and `screen plan`.
fn screen_wire_format_json() -> serde_json::Value {
    json!({
        "pixel_format": "rgb565_be",
        "color_depth_bpp": 16,
        "default_geometry": [khub::SCREEN_DEFAULT_WIDTH, khub::SCREEN_DEFAULT_HEIGHT],
        "max_frames_wire": khub::SCREEN_MAX_FRAMES,
        "max_frames_ui": khub::SCREEN_UI_MAX_FRAMES,
        "max_chunks_per_frame": khub::SCREEN_MAX_CHUNKS_PER_FRAME,
        "chunk_payload_bytes": khub::SCREEN_CHUNK_BYTES,
        "feature_payload_bytes": khub::FEATURE_PAYLOAD_BYTES,
        "separate_interface": format!(
            "VID {:04X} PID {:04X}",
            khub::SCREEN_INTERFACE_VID, khub::SCREEN_INTERFACE_PID
        ),
        "frame_interval": "u16 ms at packet bytes 10-11 (Math.round(1000/fps) in the vendor JS; device-side unit unverified)",
    })
}

/// Validate a hypothetical push and return the plan as JSON. Sends
/// nothing; used by `screen plan` for both output modes.
fn screen_push_plan(
    width: u16,
    height: u16,
    frames: usize,
    fps: Option<f64>,
    interval_ms: Option<u16>,
) -> Result<serde_json::Value> {
    if width == 0 || height == 0 {
        bail!("screen plan: width and height must be > 0");
    }
    let interval_ms = match (fps, interval_ms) {
        (Some(f), None) => {
            if !f.is_finite() || f <= 0.0 {
                bail!("screen plan: --fps must be a positive number");
            }
            let ms = (1000.0 / f).round();
            if ms > f64::from(u16::MAX) {
                bail!("screen plan: --fps {f} gives interval {ms} ms > 65535");
            }
            ms as u16
        }
        // Vendor JS default when fps is invalid/absent (spec §3).
        (None, None) => 0,
        (None, Some(ms)) => ms,
        (Some(_), Some(_)) => unreachable!("clap conflicts_with"),
    };
    if frames == 0 || frames > khub::SCREEN_MAX_FRAMES {
        bail!(
            "screen plan: frames must be 1..={}, got {frames}",
            khub::SCREEN_MAX_FRAMES
        );
    }
    let frame_bytes = width as usize * height as usize * 2;
    let chunks_per_frame = frame_bytes.div_ceil(khub::SCREEN_CHUNK_BYTES);
    if chunks_per_frame > khub::SCREEN_MAX_CHUNKS_PER_FRAME {
        bail!(
            "screen plan: {width}x{height} needs {chunks_per_frame} chunks/frame > {}",
            khub::SCREEN_MAX_CHUNKS_PER_FRAME
        );
    }
    let total_chunks = frames * chunks_per_frame;
    // cmd-13 begin + all cmd-12 chunks + cmd-13 end.
    let packets = total_chunks + 2;
    let wire_bytes = total_chunks * khub::FEATURE_PAYLOAD_BYTES;
    // Vendor pacing estimate (spec §5): chunk_delay per packet plus one
    // frame_delay after each frame.
    let est_secs = |p: khub::ScreenPacing| -> f64 {
        frames as f64
            * (chunks_per_frame as f64 * p.chunk_delay.as_secs_f64()
                + p.frame_delay.as_secs_f64())
    };
    Ok(json!({
        "width": width,
        "height": height,
        "color_depth_bpp": 16,
        "pixel_format": "rgb565_be",
        "frames": frames,
        "interval_ms": interval_ms,
        "frame_bytes": frame_bytes,
        "chunks_per_frame": chunks_per_frame,
        "total_chunks": total_chunks,
        "packets": packets,
        "wire_bytes_approx": wire_bytes,
        "estimated_seconds_keyboard_interface": est_secs(khub::ScreenPacing::keyboard_interface()),
        "estimated_seconds_screen_interface": est_secs(khub::ScreenPacing::screen_interface()),
        "limits": {
            "max_frames_wire": khub::SCREEN_MAX_FRAMES,
            "max_frames_ui": khub::SCREEN_UI_MAX_FRAMES,
            "max_chunks_per_frame": khub::SCREEN_MAX_CHUNKS_PER_FRAME,
            "over_ui_cap": frames > khub::SCREEN_UI_MAX_FRAMES,
        },
        "hardware_verified": false,
    }))
}

fn cmd_kb916_screen(cli: &Cli, command: &Kb916Screen) -> Result<ExitCode> {
    match command {
        Kb916Screen::Plan {
            width,
            height,
            frames,
            fps,
            interval_ms,
        } => {
            let plan = screen_push_plan(*width, *height, *frames, *fps, *interval_ms)?;
            // Name the would-be target: detected separate screen interfaces.
            let devices = find_devices()?;
            let screens: Vec<&DeviceInfo> = devices
                .iter()
                .filter(|d| d.kind == DeviceKind::Khub916Screen)
                .collect();
            if cli.json {
                print_json(&json!({ "plan": plan, "screen_interfaces": screens }))?;
            } else {
                println!("screen push plan (dry run — nothing was sent)");
                println!(
                    "  geometry: {}x{}, RGB565 big-endian (16 bpp)",
                    plan["width"], plan["height"]
                );
                println!(
                    "  frames: {} @ interval {} ms",
                    plan["frames"], plan["interval_ms"]
                );
                println!(
                    "  per frame: {} B → {} chunks",
                    plan["frame_bytes"], plan["chunks_per_frame"]
                );
                println!(
                    "  total: {} chunks + begin/end = {} packets (~{} B on the wire)",
                    plan["total_chunks"], plan["packets"], plan["wire_bytes_approx"]
                );
                println!(
                    "  estimated transfer at vendor pacing: {:.1} s (keyboard interface) / {:.1} s (screen interface)",
                    plan["estimated_seconds_keyboard_interface"].as_f64().unwrap_or(0.0),
                    plan["estimated_seconds_screen_interface"].as_f64().unwrap_or(0.0)
                );
                if plan["limits"]["over_ui_cap"].as_bool().unwrap_or(false) {
                    println!(
                        "  note: {} frames exceeds the vendor UI cap of {} (wire allows 255)",
                        plan["frames"], khub::SCREEN_UI_MAX_FRAMES
                    );
                }
                match screens.len() {
                    0 => println!("  screen interfaces detected: none"),
                    n => {
                        println!("  screen interfaces detected: {n}");
                        for s in screens {
                            println!("    {}  {}", s.vid_pid(), s.path);
                        }
                    }
                }
                println!("  status: hardware-unverified — packet layout is code-verified only");
            }
            Ok(ExitCode::SUCCESS)
        }
        Kb916Screen::Info => {
            let devices = find_devices()?;
            let screens: Vec<&DeviceInfo> = devices
                .iter()
                .filter(|d| d.kind == DeviceKind::Khub916Screen)
                .collect();
            let (device, mut kb) = match kb916_session(cli)? {
                Ok(s) => s,
                Err(code) => return Ok(code),
            };
            let info = kb.device_info()?;
            let topology = info
                .catalog_model
                .as_deref()
                .and_then(khub::catalog_screen);
            let wire = screen_wire_format_json();
            if cli.json {
                print_json(&json!({
                    "device": device,
                    "info": info,
                    "catalog_topology": topology,
                    "screen_interfaces": screens,
                    "wire_format": wire,
                    "readback": "none — screen commands are fire-and-forget feature-report writes (docs/protocol-khub916-screen.md §2)",
                    "hardware_verified": false,
                }))?;
            } else {
                println!("{}", device.vid_pid());
                println!("path:          {}", device.path);
                match (&info.catalog_model, &info.catalog_name) {
                    (Some(m), Some(n)) => println!("model:         {n} ({m})"),
                    (Some(m), None) => println!("model:         {m}"),
                    _ => println!("model:         (UUID not in the vendor catalog)"),
                }
                println!("uuid:          {}", info.uuid);
                println!("version:       0x{:04X}", info.version);
                match info.screen {
                    Some((w, h)) => {
                        println!("screen:        {w}x{h} on the keyboard interface (code {})", info.screen_size)
                    }
                    None => println!("screen:        none on the keyboard interface (code {})", info.screen_size),
                }
                match topology {
                    Some(khub::ScreenTopology::SeparateInterface) => println!(
                        "catalog:       separate screen interface {}",
                        wire["separate_interface"]
                    ),
                    Some(khub::ScreenTopology::OnKeyboardInterface { width: w, height: h }) => {
                        println!("catalog:       screen on the keyboard interface, {w}x{h}")
                    }
                    None => println!("catalog:       no screen entry for this model"),
                }
                match screens.len() {
                    0 => println!("screen HID:    none detected"),
                    n => {
                        println!("screen HID:    {n} interface(s) detected");
                        for s in screens {
                            println!("    {}  {}", s.vid_pid(), s.path);
                        }
                    }
                }
                println!(
                    "format:        RGB565 big-endian, 16 bpp; frame = w*h*2 B in {} B chunks",
                    khub::SCREEN_CHUNK_BYTES
                );
                println!(
                    "limits:        ≤{} frames (vendor UI cap {}), ≤{} chunks/frame, interval u16 ms",
                    khub::SCREEN_MAX_FRAMES,
                    khub::SCREEN_UI_MAX_FRAMES,
                    khub::SCREEN_MAX_CHUNKS_PER_FRAME
                );
                println!("read-back:     none — screen writes are fire-and-forget");
                println!("status:        hardware-unverified (code-verified from vendor JS only)");
            }
            Ok(ExitCode::SUCCESS)
        }
        Kb916Screen::Push { .. } => kb916_unsupported(
            cli,
            "khub916 screen image push",
            "the GIF→RGB565 frame pipeline is client-side and not implemented, and screen writes (cmd 12/13) are fire-and-forget feature reports with no read-back verify — the CLI refuses blind writes (docs/protocol-khub916-screen.md §2/§4)",
        ),
        Kb916Screen::Clock => kb916_unsupported(
            cli,
            "khub916 screen clock sync (cmd 11)",
            "fire-and-forget feature write with no read-back verify, hardware-unverified — refused until a screen device confirms it (docs/protocol-khub916-screen.md §3/§8)",
        ),
    }
}

/// Full hex string (no truncation) for profile/config blobs.
fn hex32_full(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Wrapped hex dump, 16 bytes per line with offsets.
fn print_hex_dump(bytes: &[u8]) {
    for (i, chunk) in bytes.chunks(16).enumerate() {
        let hex: Vec<String> = chunk.iter().map(|b| format!("{b:02x}")).collect();
        println!("  {:04x}: {}", i * 16, hex.join(" "));
    }
}

// ── profile export / import (F7) ──────────────────────────────────────

fn cmd_profile(cli: &Cli, command: &ProfileCommands) -> Result<ExitCode> {
    match command {
        ProfileCommands::Export { file, full } => cmd_profile_export(cli, file, *full),
        ProfileCommands::Import { file, dry_run, yes } => {
            cmd_profile_import(cli, file, *dry_run, *yes)
        }
    }
}

/// Capture the full readable state of one device as the `state` object of
/// a profile entry. Opens the protocol session itself; per-section read
/// failures are captured inside the state (`{"error": …}`), only a failure
/// to open the device or a protocol-level abort propagates.
fn capture_state(d: &DeviceInfo, full: bool) -> Result<serde_json::Value> {
    match d.kind {
        DeviceKind::HeKeyboardV2 => {
            let link = d.open_link()?;
            profile::he_state(&mut he::HeKeyboard::new(Box::new(link)))
        }
        DeviceKind::CompxMouse => {
            let link = d.open_link()?;
            profile::mouse_state(&mut pm::CompxMouse::new(Box::new(link)))
        }
        DeviceKind::Khub916Wired => {
            let mut link = d.open_link()?;
            let report_id = khub::probe_report_id(&mut link)?;
            profile::khub916_state(&mut khub::Khub916::new(Box::new(link), report_id), full)
        }
        DeviceKind::Khub916Wireless => {
            bail!("916_wireLess transport is not implemented (docs/protocol-khub916.md §3/§7)")
        }
        DeviceKind::Khub916Screen => {
            bail!("khub916 screen interface is write-only; there is no readable state to export")
        }
        DeviceKind::SparkPlayJoy => {
            let link = d.open_link()?;
            profile::spark_state(&mut spj::SparkPlayJoy::new(Box::new(link)))
        }
    }
}

/// One `devices[]` entry of an export document. Never fails: read errors
/// land in the entry's `"error"` field so one bad device does not lose the
/// rest of the backup.
fn export_device_entry(d: &DeviceInfo, full: bool) -> serde_json::Value {
    let mut e = json!({
        "protocol": profile::protocol_of(d.kind),
        "vid": d.vid,
        "pid": d.pid,
        "usage_page": d.usage_page,
        "usage": d.usage,
        "model": d.product,
        "profiles": [],
    });
    if d.kind == DeviceKind::Khub916Wireless {
        e["note"] = json!(
            "916_wireLess transport is not implemented yet (docs/protocol-khub916.md §3/§7); export skipped"
        );
        return e;
    }
    if d.kind == DeviceKind::Khub916Screen {
        e["note"] = json!(
            "khub916 screen interface is write-only (docs/protocol-khub916-screen.md §1); export skipped"
        );
        return e;
    }
    match capture_state(d, full) {
        Ok(state) => {
            e["profiles"] = json!([{ "name": "current", "state": state }]);
        }
        Err(err) => {
            e["error"] = json!(format!("{err:#}"));
        }
    }
    e
}

fn cmd_profile_export(cli: &Cli, file: &str, full: bool) -> Result<ExitCode> {
    let devices = find_devices()?;
    let targets: Vec<DeviceInfo> = if let Some(sel) = cli.device.as_deref() {
        match select_device(&devices, Some(sel))? {
            Some(d) => vec![d.clone()],
            None => {
                println!("no GravaStar device matched --device");
                return Ok(no_device());
            }
        }
    } else {
        devices
    };
    if targets.is_empty() {
        println!("no GravaStar device connected");
        return Ok(no_device());
    }
    let entries: Vec<serde_json::Value> = targets
        .iter()
        .map(|d| export_device_entry(d, full))
        .collect();
    let doc = json!({
        "schema": profile::SCHEMA_VERSION,
        "exported_at": profile::utc_now(),
        "host": profile::host_name(),
        "devices": entries,
    });
    let path = std::path::Path::new(file);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(path, serde_json::to_string_pretty(&doc)? + "\n")?;

    if cli.json {
        let summary: Vec<serde_json::Value> = entries
            .iter()
            .map(|e| {
                json!({
                    "protocol": e["protocol"],
                    "vid_pid": format!(
                        "{:04X}:{:04X}",
                        e["vid"].as_u64().unwrap_or(0) as u16,
                        e["pid"].as_u64().unwrap_or(0) as u16
                    ),
                    "profiles": e["profiles"].as_array().map(|p| p.len()).unwrap_or(0),
                    "error": e.get("error"),
                    "note": e.get("note"),
                })
            })
            .collect();
        print_json(&json!({ "file": file, "devices": summary }))?;
    } else {
        for e in &entries {
            let vid_pid = format!(
                "{:04X}:{:04X}",
                e["vid"].as_u64().unwrap_or(0) as u16,
                e["pid"].as_u64().unwrap_or(0) as u16
            );
            println!("{}  {}", vid_pid, e["protocol"].as_str().unwrap_or("?"));
            if let Some(err) = e.get("error").and_then(|x| x.as_str()) {
                println!("    error: {err}");
            } else if let Some(note) = e.get("note").and_then(|x| x.as_str()) {
                println!("    note: {note}");
            } else {
                println!(
                    "    {} profile(s) captured",
                    e["profiles"].as_array().map(|p| p.len()).unwrap_or(0)
                );
            }
        }
        println!("wrote {file}");
    }
    Ok(ExitCode::SUCCESS)
}

/// Directory for pre-import backups, created lazily on the first write:
/// `~/.local/share/oh-my-gravastar/backups/<utc-ts>/`.
fn backup_dir_slot() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    home.join(".local")
        .join("share")
        .join("oh-my-gravastar")
        .join("backups")
        .join(profile::utc_stamp())
}

/// Snapshot the device's current readable state into the backup directory
/// BEFORE any write. Reuses the export path so the backup is the same
/// schema v1 document.
fn backup_device(
    d: &DeviceInfo,
    backup_dir: &mut Option<std::path::PathBuf>,
) -> Result<std::path::PathBuf> {
    if backup_dir.is_none() {
        *backup_dir = Some(backup_dir_slot());
    }
    let dir = backup_dir.as_ref().expect("set above");
    std::fs::create_dir_all(dir)?;
    let entry = export_device_entry(d, false);
    let doc = json!({
        "schema": profile::SCHEMA_VERSION,
        "exported_at": profile::utc_now(),
        "host": profile::host_name(),
        "purpose": "pre-import backup",
        "devices": [entry],
    });
    let name = format!(
        "export-{:04x}-{:04x}-{:04x}.json",
        d.vid, d.pid, d.usage_page
    );
    let path = dir.join(name);
    std::fs::write(&path, serde_json::to_string_pretty(&doc)? + "\n")?;
    Ok(path)
}

/// Import one `devices[]` entry: match, plan, (optionally) back up and
/// apply. Returns the per-device report object.
fn import_entry(
    entry: &serde_json::Value,
    candidates: &[DeviceInfo],
    dry_run: bool,
    backup_dir: &mut Option<std::path::PathBuf>,
) -> Result<serde_json::Value> {
    let protocol = entry["protocol"].as_str().unwrap_or("?");
    let vid = entry["vid"].as_u64().unwrap_or(0) as u16;
    let pid = entry["pid"].as_u64().unwrap_or(0) as u16;
    let label = format!("{vid:04X}:{pid:04X} {protocol}");

    let Some(d) = candidates
        .iter()
        .find(|d| profile::device_matches_entry(d.kind, d.vid, d.pid, d.usage_page, entry))
    else {
        return Ok(json!({
            "device": label,
            "status": "error",
            "error": "no matching GravaStar device connected",
        }));
    };
    let device_label = format!("{} {}", d.vid_pid(), d.kind.label());

    // Pick the profile state: "current" if present, else the first entry.
    let profiles = entry.get("profiles").and_then(|p| p.as_array());
    let state = profiles.and_then(|ps| {
        ps.iter()
            .find(|p| p.get("name").and_then(|n| n.as_str()) == Some("current"))
            .or_else(|| ps.first())
    });
    let Some(state) = state.and_then(|p| p.get("state")) else {
        return Ok(json!({
            "device": device_label,
            "status": "skipped",
            "reason": "no profiles in file entry",
        }));
    };

    match d.kind {
        DeviceKind::Khub916Wired | DeviceKind::Khub916Wireless => Ok(json!({
            "device": device_label,
            "status": "skipped",
            "reason": profile::KHUB916_WRITE_SKIP,
        })),
        DeviceKind::SparkPlayJoy => Ok(json!({
            "device": device_label,
            "status": "skipped",
            "reason": profile::SPARK_WRITE_SKIP,
        })),
        DeviceKind::Khub916Screen => Ok(json!({
            "device": device_label,
            "status": "skipped",
            "reason": "khub916 screen interface is write-only; nothing to apply",
        })),
        DeviceKind::CompxMouse => import_mouse(d, state, dry_run, backup_dir, &device_label),
        DeviceKind::HeKeyboardV2 => import_he(d, state, dry_run, backup_dir, &device_label),
    }
}

fn import_mouse(
    d: &DeviceInfo,
    state: &serde_json::Value,
    dry_run: bool,
    backup_dir: &mut Option<std::path::PathBuf>,
    label: &str,
) -> Result<serde_json::Value> {
    let link = d.open_link()?;
    let mut m = pm::CompxMouse::new(Box::new(link));
    m.identify()?;
    let id = m.identity.expect("identify ran");
    let want = profile::mouse_config_from_json(state)?;
    let problems = profile::mouse_validate(&want, &id);
    if !problems.is_empty() {
        return Ok(json!({
            "device": label,
            "status": "error",
            "error": format!("profile rejected by validation: {}", problems.join("; ")),
        }));
    }
    let current = m.read_config()?;
    let changes = profile::mouse_changes(&current, &want);
    if dry_run {
        return Ok(json!({
            "device": label,
            "status": "dry-run",
            "changes": changes,
        }));
    }
    if changes.is_empty() {
        return Ok(json!({
            "device": label,
            "status": "unchanged",
            "verified": true,
        }));
    }
    let backup = backup_device(d, backup_dir)?;
    profile::mouse_apply(&mut m, &want)?;
    let mismatches = profile::mouse_verify(&mut m, &want)?;
    let verified = mismatches.is_empty();
    Ok(json!({
        "device": label,
        "status": "applied",
        "backup": backup,
        "changes": changes,
        "verified": verified,
        "mismatches": mismatches,
    }))
}

fn import_he(
    d: &DeviceInfo,
    state: &serde_json::Value,
    dry_run: bool,
    backup_dir: &mut Option<std::path::PathBuf>,
    label: &str,
) -> Result<serde_json::Value> {
    let link = d.open_link()?;
    let mut kb = he::HeKeyboard::new(Box::new(link));
    let (writes, notes) = profile::he_plan(&mut kb, state)?;
    if dry_run {
        return Ok(json!({
            "device": label,
            "status": "dry-run",
            "changes": writes.iter().map(|w| w.describe()).collect::<Vec<_>>(),
            "notes": notes,
        }));
    }
    if writes.is_empty() {
        return Ok(json!({
            "device": label,
            "status": "unchanged",
            "notes": notes,
            "verified": true,
        }));
    }
    let backup = backup_device(d, backup_dir)?;
    let results = profile::he_apply(&mut kb, &writes)?;
    let failed = results.iter().filter(|r| r.contains("FAILED")).count();
    Ok(json!({
        "device": label,
        "status": "applied",
        "backup": backup,
        "changes": results,
        "notes": notes,
        "verified": failed == 0,
    }))
}

fn cmd_profile_import(cli: &Cli, file: &str, dry_run: bool, yes: bool) -> Result<ExitCode> {
    if !dry_run && !yes {
        bail!(
            "refusing to write without --yes (docs/plan.md §2: writes are opt-in); \
             use --dry-run to preview the planned changes"
        );
    }
    let doc = profile::load_profile(std::path::Path::new(file))?;
    let connected = find_devices()?;
    let candidates: Vec<DeviceInfo> = if let Some(sel) = cli.device.as_deref() {
        connected
            .iter()
            .filter(|d| device_matches(d, sel))
            .cloned()
            .collect()
    } else {
        connected
    };
    let mut backup_dir: Option<std::path::PathBuf> = None;
    let mut reports = Vec::new();
    let mut any_error = false;
    for entry in doc["devices"].as_array().expect("validated") {
        let report = match import_entry(entry, &candidates, dry_run, &mut backup_dir) {
            Ok(r) => r,
            Err(e) => json!({
                "device": entry["protocol"].as_str().unwrap_or("?"),
                "status": "error",
                "error": format!("{e:#}"),
            }),
        };
        if report["status"].as_str() == Some("error") {
            any_error = true;
        }
        reports.push(report);
    }

    if cli.json {
        print_json(&json!({ "file": file, "dry_run": dry_run, "results": reports }))?;
    } else {
        for r in &reports {
            let device = r["device"].as_str().unwrap_or("?");
            let status = r["status"].as_str().unwrap_or("?");
            println!("{device}: {status}");
            if let Some(reason) = r["reason"].as_str() {
                println!("    {reason}");
            }
            if let Some(err) = r["error"].as_str() {
                println!("    error: {err}");
            }
            if let Some(backup) = r["backup"].as_str() {
                println!("    backup: {backup}");
            }
            if let Some(changes) = r["changes"].as_array() {
                if changes.is_empty() {
                    println!("    no changes");
                } else {
                    for c in changes {
                        println!("    {}", c.as_str().unwrap_or("?"));
                    }
                }
            }
            if let Some(notes) = r["notes"].as_array() {
                for n in notes {
                    println!("    note: {}", n.as_str().unwrap_or("?"));
                }
            }
            if let Some(v) = r["verified"].as_bool() {
                println!("    verified: {v}");
            }
            if let Some(mm) = r["mismatches"].as_array() {
                for m in mm {
                    println!("    mismatch: {}", m.as_str().unwrap_or("?"));
                }
            }
        }
    }
    Ok(if any_error {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    })
}

// ── device selection ───────────────────────────────────────────────────

/// Pick one device: explicit selector, or the single connected device.
/// `Ok(None)` means nothing matched (exit code 2); ambiguity is an error.
fn select_device<'a>(
    devices: &'a [DeviceInfo],
    selector: Option<&str>,
) -> Result<Option<&'a DeviceInfo>> {
    match selector {
        Some(sel) => {
            let matches: Vec<&DeviceInfo> =
                devices.iter().filter(|d| device_matches(d, sel)).collect();
            match matches.len() {
                0 => Ok(None),
                1 => Ok(Some(matches[0])),
                n => bail!("selector '{sel}' matches {n} devices; be more specific"),
            }
        }
        None => match devices {
            [] => Ok(None),
            [only] => Ok(Some(only)),
            many => bail!(
                "{} GravaStar devices connected; pass --device <path|vid:pid> to choose one",
                many.len()
            ),
        },
    }
}

/// A selector matches the HID path (exact or suffix), `VID:PID`, or a
/// case-insensitive substring of the product/manufacturer strings.
fn device_matches(d: &DeviceInfo, sel: &str) -> bool {
    if d.path == sel || d.path.ends_with(sel) {
        return true;
    }
    if let Some((v, rest)) = sel.split_once(':') {
        if let Some((p, page)) = rest.split_once(':') {
            // VID:PID:USAGE_PAGE — picks one interface of a multi-interface device.
            if let (Ok(v), Ok(p), Ok(page)) = (
                parse_maybe_hex(v),
                parse_maybe_hex(p),
                parse_maybe_hex(page),
            ) {
                return d.vid == v && d.pid == p && d.usage_page == page;
            }
        } else if let Ok(p) = parse_maybe_hex(rest) {
            if let Ok(v) = parse_maybe_hex(v) {
                return d.vid == v && d.pid == p;
            }
        }
    }
    let sel = sel.to_lowercase();
    d.product
        .as_deref()
        .is_some_and(|s| s.to_lowercase().contains(&sel))
        || d.manufacturer
            .as_deref()
            .is_some_and(|s| s.to_lowercase().contains(&sel))
}

/// `0x`/`0X` prefix forces hex; a value containing a-f letters is hex;
/// all-digit values are decimal.
fn parse_maybe_hex(s: &str) -> std::result::Result<u16, std::num::ParseIntError> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16)
    } else if s.bytes().all(|b| b.is_ascii_hexdigit()) && s.bytes().any(|b| b.is_ascii_alphabetic())
    {
        u16::from_str_radix(s, 16)
    } else {
        s.parse()
    }
}
