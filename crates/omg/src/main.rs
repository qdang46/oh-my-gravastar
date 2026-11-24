//! `omg` — agent-first, offline CLI for GravaStar keyboards and mice.
//!
//! Every data command supports `--json`; writes require `--yes` (see
//! docs/plan.md §2 for the safety contract). Exit codes: 0 ok, 1 error,
//! 2 no device, 3 unsupported.

use std::process::ExitCode;

use anyhow::{anyhow, bail, Result};
use clap::{Args, Parser, Subcommand};
use omg_hid::{find_devices, DeviceInfo, DeviceKind};
use omg_proto_mouse as pm;
use serde_json::json;

#[derive(Parser)]
#[command(name = "omg", version, about = "Configure GravaStar keyboards and mice (offline, agent-first)")]
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
    /// Diagnostic probe of a device (read-only; stub until protocols land).
    Probe,
    /// GravaStar mice with a Compx chipset (Mercury M/X series).
    Mouse {
        #[command(subcommand)]
        command: MouseCommands,
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
        Commands::Probe => cmd_probe(cli),
        Commands::Mouse { command } => cmd_mouse(cli, command),
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
            println!("    usage_page: 0x{:04x} usage: 0x{:04x}", d.usage_page, d.usage);
        }
    }
    Ok(if devices.is_empty() { no_device() } else { ExitCode::SUCCESS })
}

// ── probe ──────────────────────────────────────────────────────────────

fn cmd_probe(cli: &Cli) -> Result<ExitCode> {
    let devices = find_devices()?;
    let Some(device) = select_device(&devices, cli.device.as_deref())? else {
        let report = json!({ "error": "no GravaStar device connected or matched" });
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(no_device());
    };
    // TODO(F8): open the device and dump raw protocol info once the
    // proto-* crates land. For now report the transport-level identity.
    let report = json!({
        "device": device,
        "probe": "stub: protocol readers not yet implemented",
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
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
        print_json(&json!({ "error": "no Compx mouse detected (omg devices lists what was found)" }))?;
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
                println!("link:    {}", if id.wired { "wired (cable)" } else { "2.4 GHz receiver" });
                println!("sensor:  {} (max {} DPI, base {} DPI)", id.sensor.name, id.sensor.max_dpi, id.sensor.base_max);
                println!("lod:     {}", id.sensor.lod.iter().map(|(v, l)| format!("{v}={l}")).collect::<Vec<_>>().join(", "));
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
                println!("battery: {}%{}", b.level, if b.charging { " (charging)" } else { "" });
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
    println!("dpi stages:     {} (active: {})", c.stage_count, c.current_stage);
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
    println!("sensor mode:    {}", if c.sensor_mode == 0 { "LP" } else { "HP" });
    for (i, b) in c.buttons.iter().enumerate() {
        println!("button {i}:      kind {} param 0x{:04x}", b.kind, b.param);
    }
}

fn yn(b: bool) -> &'static str {
    if b { "on" } else { "off" }
}

/// Require `--yes`, run the write, read the config back and verify the
/// affected field. Returns a JSON report with `"verified": true|false`.
fn cmd_mouse_set(cli: &Cli, field: &MouseSet) -> Result<ExitCode> {
    let (yes, action) = match field {
        MouseSet::Polling { yes, hz } => (yes, MouseAction::Polling(*hz)),
        MouseSet::Dpi { yes, stage, dpi } => (yes, MouseAction::Dpi(*stage, *dpi)),
        MouseSet::DpiColor { yes, stage, color } => (yes, MouseAction::DpiColor(*stage, color.clone())),
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
        MouseSet::MotionSync { yes, on } => (yes, MouseAction::Flag("motion_sync", on == "on", pm::addr::MOTION_SYNC)),
        MouseSet::AngleSnap { yes, on } => (yes, MouseAction::Flag("angle_snap", on == "on", pm::addr::ANGLE_SNAP)),
        MouseSet::Ripple { yes, on } => (yes, MouseAction::Flag("ripple", on == "on", pm::addr::RIPPLE)),
        MouseSet::LightOffMoving { yes, on } => {
            (yes, MouseAction::Flag("light_off_moving", on == "on", pm::addr::LIGHT_OFF_MOVING))
        }
        MouseSet::Sleep { yes, seconds } => (yes, MouseAction::Sleep(*seconds)),
        MouseSet::SensorMode { yes, mode } => (yes, MouseAction::SensorMode(mode.clone())),
        MouseSet::Button { yes, slot, kind, param } => {
            (yes, MouseAction::Button(*slot, kind.clone(), param.clone()))
        }
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
    Ok(if verified { ExitCode::SUCCESS } else { ExitCode::from(1) })
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
                bail!("invalid polling rate {hz} Hz (valid: {:?})", pm::REPORT_RATES);
            }
            if *hz > id.max_rate {
                bail!("{hz} Hz exceeds what this link supports (max {} Hz)", id.max_rate);
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
                format!("DPI stage {stage} -> {clamped} DPI{}", if clamped != *dpi { " (clamped)" } else { "" }),
                json!(clamped),
            )
        }
        MouseAction::DpiColor(stage, color) => {
            check_stage(*stage)?;
            let c = pm::Rgb::parse(color)?;
            (format!("DPI stage {stage} colour -> {}", c.to_hex()), json!(c))
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
            let label = id.sensor.lod.iter().find(|(l, _)| l == v).map(|(_, l)| *l).unwrap_or("");
            (format!("lift-off distance -> {v} ({label})"), json!(v))
        }
        MouseAction::LightOn | MouseAction::LightOff | MouseAction::LightMode(_) | MouseAction::LightColor(_)
        | MouseAction::LightSpeed(_) | MouseAction::LightBrightness(_) => {
            let new = planned_light(m, a)?;
            (format!("light -> on={} mode={} colour={} speed={} brightness={}", new.on, new.mode, new.color.to_hex(), new.speed, new.brightness), json!(new))
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
                    pm::SLEEP_TIMES.iter().map(|t| *t as u16 * 10).collect::<Vec<_>>()
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
            (format!("button {slot} -> kind {k} param 0x{p:04x}"), json!({ "kind": k, "param": p }))
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
                    _ => bail!("unknown mouse button '{s}' (left|right|middle|back|forward or 0x0100…)"),
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
        MouseAction::LightOn | MouseAction::LightOff | MouseAction::LightMode(_)
        | MouseAction::LightColor(_) | MouseAction::LightSpeed(_) | MouseAction::LightBrightness(_) => {
            let l = planned_light(m, a)?;
            m.set_light(&l)
        }
        MouseAction::Debounce(ms) => m.set_debounce(*ms),
        MouseAction::Flag(_, on, addr) => m.set_flag(*addr, *on),
        MouseAction::Sleep(seconds) => m.set_sleep((*seconds / 10) as u8),
        MouseAction::SensorMode(mode) => m.set_sensor_mode(if mode.as_str() == "lp" { 0 } else { 1 }),
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
        MouseAction::LightOn | MouseAction::LightOff | MouseAction::LightMode(_)
        | MouseAction::LightColor(_) | MouseAction::LightSpeed(_) | MouseAction::LightBrightness(_) => {
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

// ── device selection ───────────────────────────────────────────────────

/// Pick one device: explicit selector, or the single connected device.
/// `Ok(None)` means nothing matched (exit code 2); ambiguity is an error.
fn select_device<'a>(
    devices: &'a [DeviceInfo],
    selector: Option<&str>,
) -> Result<Option<&'a DeviceInfo>> {
    match selector {
        Some(sel) => {
            let matches: Vec<&DeviceInfo> = devices.iter().filter(|d| device_matches(d, sel)).collect();
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
            if let (Ok(v), Ok(p), Ok(page)) =
                (parse_maybe_hex(v), parse_maybe_hex(p), parse_maybe_hex(page))
            {
                return d.vid == v && d.pid == p && d.usage_page == page;
            }
        } else if let Ok(p) = parse_maybe_hex(rest) {
            if let Ok(v) = parse_maybe_hex(v) {
                return d.vid == v && d.pid == p;
            }
        }
    }
    let sel = sel.to_lowercase();
    d.product.as_deref().is_some_and(|s| s.to_lowercase().contains(&sel))
        || d.manufacturer.as_deref().is_some_and(|s| s.to_lowercase().contains(&sel))
}

/// `0x`/`0X` prefix forces hex; a value containing a-f letters is hex;
/// all-digit values are decimal.
fn parse_maybe_hex(s: &str) -> std::result::Result<u16, std::num::ParseIntError> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16)
    } else if s.bytes().all(|b| b.is_ascii_hexdigit()) && s.bytes().any(|b| b.is_ascii_alphabetic()) {
        u16::from_str_radix(s, 16)
    } else {
        s.parse()
    }
}
