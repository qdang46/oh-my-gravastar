//! `omg` — agent-first, offline CLI for GravaStar keyboards and mice.
//!
//! Every data command supports `--json`; writes require `--yes` (see
//! docs/plan.md §2 for the safety contract). Exit codes: 0 ok, 1 error,
//! 2 no device, 3 unsupported.

use std::process::ExitCode;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use omg_hid::{find_devices, DeviceInfo};
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
