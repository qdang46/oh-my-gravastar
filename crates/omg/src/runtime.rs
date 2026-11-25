//! `omg runtime` — live-session surface for real-time device behaviour
//! (docs/specs/rust-cli-config-migration-spec.md §3.2/§4.4, ADR §4/§8).
//!
//! Runtime sessions are **not** persistent config: they stream cmd-8
//! frames to a khub916 wired keyboard until stopped, and always restore
//! the pre-session lighting on exit (same contract as
//! `kb916 light music`/`light stream` — AGENTS.md incident log).
//!
//! Commands:
//!
//! - `omg runtime schema` — machine-readable session schema: kinds,
//!   fields, allowed values, capability gating, risk class, lifecycle.
//! - `omg runtime start <session.json|-> [--yes] [--duration N]` —
//!   without `--yes` prints the plan and sends nothing (§7.5 approval
//!   semantics); with `--yes` runs the session in the foreground.
//! - `omg runtime status` — `running`/`stopped` from the session marker.
//! - `omg runtime stop` — always allowed; drops a stop-request file the
//!   session polls each frame, then lighting is restored before exit.
//!
//! Session state lives in `<temp>/omg-runtime/` (marker + stop-request +
//! last-outcome files) so `status`/`stop` work across processes. A
//! session killed ungracefully leaves a stale marker; `status`/`stop`
//! detect the dead pid and clean it up rather than trusting it.

use anyhow::{bail, Result};
use omg_music::{pack_frame, ArtSource, MapMode, Motion, Palette, PixelArt, PixelArtSpec, Rgb};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::kb916_music::{self, MusicArgs, StreamOpen};
use crate::{print_json, Cli, Yes};

/// `omg runtime` subcommands.
#[derive(clap::Subcommand)]
pub enum RuntimeCommands {
    /// Emit the runtime session schema (JSON): session kinds, fields,
    /// allowed values, capability gating, risk class and lifecycle.
    Schema,
    /// Start a live session from a JSON document (`-` = stdin).
    /// Without `--yes` prints the plan and sends nothing; `--duration N`
    /// caps the session length (also settable per-session as
    /// `duration_s`; the shorter of the two wins).
    Start {
        /// Session JSON file, or `-` for stdin.
        file: String,
        /// Stop after this many seconds (optional upper bound).
        #[arg(long)]
        duration: Option<f64>,
        #[command(flatten)]
        yes: Yes,
    },
    /// Report the active runtime session: `running` (with session
    /// summary) or `stopped` (with the last session's outcome, if any).
    Status,
    /// Ask the active session to stop. Always allowed — it is the safe
    /// direction; the session restores lighting before exiting.
    Stop,
}

/// `omg runtime <sub>` dispatcher.
pub fn run(cli: &Cli, command: &RuntimeCommands) -> Result<ExitCode> {
    match command {
        RuntimeCommands::Schema => {
            print_json(&schema_doc())?;
            Ok(ExitCode::SUCCESS)
        }
        RuntimeCommands::Status => cmd_status(),
        RuntimeCommands::Stop => cmd_stop(),
        RuntimeCommands::Start {
            file,
            duration,
            yes,
        } => cmd_start(cli, file, *duration, yes),
    }
}

// ── session documents ──────────────────────────────────────────────────

/// A parsed, validated runtime session document.
enum Session {
    Music(MusicSession),
    PixelArt(PixelArtSession),
}

#[derive(Debug)]
struct MusicSession {
    args: MusicArgs,
    fps: f64,
}

struct PixelArtSession {
    spec: PixelArtSpec,
    /// Session-level `duration_s` (kept out of `spec` — PixelArtSpec has
    /// no duration field).
    spec_duration: Option<f64>,
    pixel_order: String,
    fps: f64,
}

impl Session {
    fn kind(&self) -> &'static str {
        match self {
            Session::Music(_) => "music",
            Session::PixelArt(_) => "pixel-art",
        }
    }
    /// Session-level duration cap (`duration_s`), before the CLI flag.
    fn duration_s(&self) -> Option<f64> {
        match self {
            Session::Music(m) => m.args.duration,
            Session::PixelArt(p) => p.spec_duration,
        }
    }
    /// Short plan summary for the approval preview.
    fn plan(&self) -> Value {
        match self {
            Session::Music(m) => json!({
                "kind": "music",
                "engine": m.args.engine,
                "effect": m.args.effect,
                "source": m.args.source,
                "palette": m.args.palette,
                "speed": m.args.speed,
                "brightness": m.args.brightness,
                "fps": m.fps,
                "duration_s": m.args.duration,
            }),
            Session::PixelArt(p) => json!({
                "kind": "pixel-art",
                "motion": motion_name(p.spec.motion),
                "speed": p.spec.speed,
                "canvas": { "cols": p.spec.cols, "rows": p.spec.rows },
                "map": map_name(p.spec.map),
                "fps": p.fps,
                "duration_s": p.spec_duration,
            }),
        }
    }
}

// ── serde document shapes ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MusicDoc {
    #[serde(rename = "kind")]
    _kind: String,
    #[serde(default)]
    engine: Option<String>,
    #[serde(default)]
    effect: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    palette: Option<String>,
    #[serde(default)]
    speed: Option<f32>,
    #[serde(default)]
    brightness: Option<f32>,
    #[serde(default)]
    sensitivity: Option<f32>,
    #[serde(default)]
    background: Option<f32>,
    #[serde(default)]
    beat_intensity: Option<f32>,
    #[serde(default)]
    attack: Option<f32>,
    #[serde(default)]
    decay: Option<f32>,
    #[serde(default)]
    pixel_order: Option<String>,
    #[serde(default)]
    fps: Option<f64>,
    #[serde(default)]
    duration_s: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PixelArtDoc {
    #[serde(rename = "kind")]
    _kind: String,
    art: Value,
    #[serde(default)]
    motion: Option<String>,
    #[serde(default)]
    repeat: Option<bool>,
    #[serde(default)]
    speed: Option<f32>,
    #[serde(default)]
    color: Option<Value>,
    #[serde(default)]
    palette: Option<Value>,
    #[serde(default)]
    background: Option<Value>,
    #[serde(default)]
    brightness: Option<f32>,
    #[serde(default)]
    canvas: Option<CanvasDoc>,
    #[serde(default)]
    map: Option<String>,
    #[serde(default)]
    pixel_order: Option<String>,
    #[serde(default)]
    fps: Option<f64>,
    #[serde(default)]
    duration_s: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasDoc {
    #[serde(default)]
    cols: Option<usize>,
    #[serde(default)]
    rows: Option<usize>,
}

// ── parsing / validation ───────────────────────────────────────────────

fn opt<T>(v: Option<T>, default: T) -> T {
    v.unwrap_or(default)
}

fn req_f64(name: &str, v: Option<f64>, default: f64, min: f64, max: f64) -> Result<f64> {
    let v = opt(v, default);
    if !(min..=max).contains(&v) || !v.is_finite() {
        bail!("{name} must be in {min}..={max}, got {v}");
    }
    Ok(v)
}

fn req_f32(name: &str, v: Option<f32>, default: f32, min: f32, max: f32) -> Result<f32> {
    let v = opt(v, default);
    if !(min..=max).contains(&v) || !v.is_finite() {
        bail!("{name} must be in {min}..={max}, got {v}");
    }
    Ok(v)
}

fn one_of(name: &str, v: &str, allowed: &[&str]) -> Result<String> {
    if allowed.contains(&v) {
        Ok(v.to_string())
    } else {
        bail!("unknown {name} '{v}' (want {})", allowed.join("|"))
    }
}

/// `"#rrggbb"`, `"rrggbb"`, `"r,g,b"` or `{"r":n,"g":n,"b":n}` (0-255)
/// → linear 0..1 [`Rgb`].
fn parse_color(v: &Value, what: &str) -> Result<Rgb> {
    let c = match v {
        Value::String(s) => omg_proto_mouse::Rgb::parse(s)
            .map_err(|e| anyhow::anyhow!("{what}: {e:#}"))?,
        Value::Object(map) => {
            let get = |k: &str| -> Result<u8> {
                map.get(k)
                    .and_then(Value::as_u64)
                    .and_then(|n| u8::try_from(n).ok())
                    .ok_or_else(|| {
                        anyhow::anyhow!("{what}: colour object needs integer '{k}' 0-255")
                    })
            };
            omg_proto_mouse::Rgb {
                r: get("r")?,
                g: get("g")?,
                b: get("b")?,
            }
        }
        _ => bail!("{what}: colour must be a string or {{\"r\":…}} object"),
    };
    Ok(Rgb {
        r: c.r as f32 / 255.0,
        g: c.g as f32 / 255.0,
        b: c.b as f32 / 255.0,
    })
}

fn parse_art(v: &Value) -> Result<ArtSource> {
    let obj = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("art must be an object {{\"text\":…}} or {{\"bitmap\":…}}"))?;
    for k in obj.keys() {
        if k != "text" && k != "bitmap" {
            bail!("unknown art field '{k}' (want text|bitmap)");
        }
    }
    match (obj.contains_key("text"), obj.contains_key("bitmap")) {
        (true, false) => {
            let text = obj["text"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("art.text must be a string"))?;
            Ok(ArtSource::Text(text.to_string()))
        }
        (false, true) => {
            let b = &obj["bitmap"];
            let width = b["width"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .filter(|&n| n > 0)
                .ok_or_else(|| anyhow::anyhow!("art.bitmap.width must be a positive integer"))?;
            let height = b["height"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .filter(|&n| n > 0)
                .ok_or_else(|| anyhow::anyhow!("art.bitmap.height must be a positive integer"))?;
            let pixels = b["pixels"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("art.bitmap.pixels must be an array of 0-255"))?
                .iter()
                .map(|p| {
                    p.as_u64()
                        .and_then(|n| u8::try_from(n).ok())
                        .ok_or_else(|| {
                            anyhow::anyhow!("art.bitmap.pixels entries must be integers 0-255")
                        })
                })
                .collect::<Result<Vec<u8>>>()?;
            Ok(ArtSource::bitmap(width, height, pixels))
        }
        _ => bail!("art needs exactly one of \"text\" or \"bitmap\""),
    }
}

/// Parse + validate a session document. Pure — no device or file I/O
/// beyond the already-read JSON value, so bad sessions fail before any
/// bytes could be sent.
fn parse_session(v: &Value) -> Result<Session> {
    let kind = v
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("session document needs a string \"kind\""))?;
    match kind {
        "music" => {
            let d: MusicDoc = serde_json::from_value(v.clone())
                .map_err(|e| anyhow::anyhow!("invalid music session: {e}"))?;
            let engine = opt(d.engine, "mixer".to_string());
            one_of("engine", &engine, &["legacy", "mixer", "modes"])?;
            let source = opt(d.source, "system".to_string());
            one_of("source", &source, &["system", "mic"])?;
            let pixel_order = opt(d.pixel_order, "planar".to_string());
            one_of("pixel_order", &pixel_order, &["planar", "interleaved"])?;
            let palette = opt(d.palette, "auto".to_string());
            one_of(
                "palette",
                &palette,
                &["auto", "rainbow", "heat", "ocean", "sunset", "neon", "mono"],
            )?;
            let fps = req_f64("fps", d.fps, 10.0, 1.0, 30.0)?;
            let duration_s = match d.duration_s {
                Some(x) if x > 0.0 && x.is_finite() => Some(x),
                Some(x) => bail!("duration_s must be positive seconds, got {x}"),
                None => None,
            };
            let args = MusicArgs {
                source,
                fps,
                sensitivity: req_f32("sensitivity", d.sensitivity, 1.6, 0.1, 10.0)?,
                brightness: req_f32("brightness", d.brightness, 1.0, 0.0, 1.0)?,
                effect: opt(d.effect, "beat".to_string()),
                background: req_f32("background", d.background, 0.0, 0.0, 1.0)?,
                beat_intensity: req_f32("beat_intensity", d.beat_intensity, 1.0, 0.0, 2.0)?,
                attack: req_f32("attack", d.attack, 1.0, 0.25, 4.0)?,
                decay: req_f32("decay", d.decay, 1.0, 0.25, 4.0)?,
                pixel_order,
                engine,
                palette,
                speed: req_f32("speed", d.speed, 1.0, 0.05, 10.0)?,
                duration: duration_s,
            };
            Ok(Session::Music(MusicSession { args, fps }))
        }
        "pixel-art" => {
            let d: PixelArtDoc = serde_json::from_value(v.clone())
                .map_err(|e| anyhow::anyhow!("invalid pixel-art session: {e}"))?;
            let art = parse_art(&d.art)?;
            let motion = match opt(d.motion, "static".to_string()).as_str() {
                "static" => Motion::Static,
                "scroll_left" => Motion::ScrollLeft,
                "scroll_right" => Motion::ScrollRight,
                other => bail!("unknown motion '{other}' (want static|scroll_left|scroll_right)"),
            };
            let map = match opt(d.map, "keys".to_string()).as_str() {
                "keys" => MapMode::Keys,
                "cells" => MapMode::Cells,
                other => bail!("unknown map '{other}' (want keys|cells)"),
            };
            let palette = match &d.palette {
                None | Some(Value::Null) => None,
                Some(v) => {
                    let name = v
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("palette must be a string or null"))?;
                    Some(
                        Palette::parse(name).ok_or_else(|| {
                            anyhow::anyhow!(
                                "unknown palette '{name}' (want rainbow|heat|ocean|sunset|neon|mono)"
                            )
                        })?,
                    )
                }
            };
            let canvas = d.canvas.unwrap_or(CanvasDoc {
                cols: None,
                rows: None,
            });
            let cols = opt(canvas.cols, 21);
            let rows = opt(canvas.rows, 6);
            if !(1..=64).contains(&cols) || !(1..=16).contains(&rows) {
                bail!("canvas cols must be 1..=64 and rows 1..=16, got {cols}x{rows}");
            }
            let pixel_order = opt(d.pixel_order, "planar".to_string());
            one_of("pixel_order", &pixel_order, &["planar", "interleaved"])?;
            let fps = req_f64("fps", d.fps, 10.0, 1.0, 30.0)?;
            let duration_s = match d.duration_s {
                Some(x) if x > 0.0 && x.is_finite() => Some(x),
                Some(x) => bail!("duration_s must be positive seconds, got {x}"),
                None => None,
            };
            let spec = PixelArtSpec {
                art,
                cols,
                rows,
                motion,
                repeat: opt(d.repeat, true),
                speed: req_f32("speed", d.speed, 6.0, 0.1, 120.0)?,
                color: parse_color(&opt(d.color, json!("#ffffff")), "color")?,
                palette,
                background: parse_color(&opt(d.background, json!("#000000")), "background")?,
                brightness: req_f32("brightness", d.brightness, 1.0, 0.0, 1.0)?,
                map,
            };
            Ok(Session::PixelArt(PixelArtSession {
                spec,
                spec_duration: duration_s,
                pixel_order,
                fps,
            }))
        }
        other => bail!("unknown session kind '{other}' (want music|pixel-art)"),
    }
}

fn motion_name(m: Motion) -> &'static str {
    match m {
        Motion::Static => "static",
        Motion::ScrollLeft => "scroll_left",
        Motion::ScrollRight => "scroll_right",
    }
}

fn map_name(m: MapMode) -> &'static str {
    match m {
        MapMode::Cells => "cells",
        MapMode::Keys => "keys",
    }
}

// ── session state files (cross-process status/stop) ────────────────────

fn state_dir() -> PathBuf {
    std::env::temp_dir().join("omg-runtime")
}
fn marker_path() -> PathBuf {
    state_dir().join("active.json")
}
fn stop_path() -> PathBuf {
    state_dir().join("active.stop")
}
fn last_path() -> PathBuf {
    state_dir().join("last.json")
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Is `pid` a live process? Best-effort, dep-free: `tasklist` on
/// Windows, `kill -0` on Unix. Unknown platforms assume alive (the safe
/// direction — a false "running" only means `stop` writes a harmless
/// stop-request file).
fn pid_alive(pid: u64) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .map(|o| {
                o.status.success()
                    && String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\""))
            })
            .unwrap_or(true)
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(true)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        true
    }
}

/// Read the active-session marker; returns `(pid, info)` only when the
/// recorded pid is still alive. A dead pid means the session died
/// ungracefully — the stale marker/stop files are removed and `None`
/// is returned (never trusted).
fn active_session() -> Option<(u64, Value)> {
    let text = std::fs::read_to_string(marker_path()).ok()?;
    let info: Value = serde_json::from_str(&text).ok()?;
    let pid = info["pid"].as_u64()?;
    if pid_alive(pid) {
        Some((pid, info))
    } else {
        let _ = std::fs::remove_file(marker_path());
        let _ = std::fs::remove_file(stop_path());
        None
    }
}

fn ensure_no_active_session() -> Result<()> {
    if let Some((pid, info)) = active_session() {
        bail!(
            "a runtime session is already active (pid {pid}, kind {}) — \
             `omg runtime status` / `omg runtime stop`",
            info["kind"].as_str().unwrap_or("?")
        );
    }
    Ok(())
}

fn write_marker(session: &Session) -> Result<()> {
    std::fs::create_dir_all(state_dir())?;
    // A leftover stop-request must not kill the new session instantly.
    let _ = std::fs::remove_file(stop_path());
    std::fs::write(
        marker_path(),
        serde_json::to_string_pretty(&json!({
            "pid": std::process::id(),
            "kind": session.kind(),
            "started_at": now_unix(),
            "session": session.plan(),
        }))?,
    )?;
    Ok(())
}

fn clear_marker() {
    let _ = std::fs::remove_file(marker_path());
    let _ = std::fs::remove_file(stop_path());
}

fn write_last(session: &Session, outcome: &Result<(ExitCode, Value)>) {
    let ended = json!({
        "kind": session.kind(),
        "ended_at": now_unix(),
    });
    let doc = match outcome {
        Ok((_, report)) if report.is_object() => {
            let mut d = ended;
            d["stopped_by"] = report["stopped_by"].clone();
            d["restored"] = report["restored"].clone();
            d["frames_sent"] = report["frames_sent"].clone();
            d
        }
        Ok(_) => ended,
        Err(e) => {
            let mut d = ended;
            d["error"] = json!(format!("{e:#}"));
            d
        }
    };
    let _ = std::fs::create_dir_all(state_dir());
    let _ = std::fs::write(last_path(), serde_json::to_string_pretty(&doc).unwrap_or_default());
}

// ── commands ───────────────────────────────────────────────────────────

fn read_session_doc(file: &str) -> Result<Value> {
    let text = if file == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)
            .map_err(|e| anyhow::anyhow!("cannot read session JSON from stdin: {e}"))?;
        s
    } else {
        std::fs::read_to_string(file)
            .map_err(|e| anyhow::anyhow!("cannot read session file '{file}': {e}"))?
    };
    serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("invalid session JSON: {e}"))
}

fn cmd_start(
    cli: &Cli,
    file: &str,
    duration_flag: Option<f64>,
    yes: &Yes,
) -> Result<ExitCode> {
    let doc = read_session_doc(file)?;
    let session = parse_session(&doc)?;
    if let Some(d) = duration_flag {
        if d.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) || !d.is_finite() {
            bail!("--duration must be positive seconds, got {d}");
        }
    }
    // Effective cap: the shorter of the session's `duration_s` and the
    // CLI `--duration` flag.
    let duration = match (session.duration_s(), duration_flag) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };

    // A second `runtime start` must not double-stream the device.
    ensure_no_active_session()?;

    let plan = json!({
        "kind": "omg.runtime.plan",
        "started": false,
        "approval_required": true,
        "writes": true,
        "target": "khub916 wired keyboard (K1 Pro family), cmd-8 frame stream",
        "risk": "L2 runtime — restores lighting on exit/Ctrl-C/stop",
        "duration_s": duration,
        "session": session.plan(),
    });
    if !yes.yes {
        // §7.5: return the plan, send nothing, exit ok.
        if cli.json {
            print_json(&plan)?;
        } else {
            println!("runtime plan (nothing sent — re-run with --yes to start):");
            println!("  {}", serde_json::to_string_pretty(&plan["session"]).unwrap_or_default());
            println!("  target: {}", plan["target"].as_str().unwrap_or(""));
            if let Some(d) = duration {
                println!("  duration cap: {d}s");
            }
        }
        return Ok(ExitCode::SUCCESS);
    }

    write_marker(&session)?;
    let stop_file = stop_path();
    let outcome = match &session {
        Session::Music(m) => run_music_session(cli, m, duration, &stop_file, yes),
        Session::PixelArt(p) => run_pixelart_session(cli, p, duration, &stop_file),
    };
    write_last(&session, &outcome);
    clear_marker();
    outcome.map(|(code, _)| code)
}

fn run_music_session(
    cli: &Cli,
    m: &MusicSession,
    duration: Option<f64>,
    stop_file: &Path,
    yes: &Yes,
) -> Result<(ExitCode, Value)> {
    let mut args = m.args.clone();
    args.duration = duration;
    let run = kb916_music::run_music(cli, &args, yes, Some(stop_file))?;
    Ok((run.code, run.report))
}

fn cmd_status() -> Result<ExitCode> {
    if let Some((pid, info)) = active_session() {
        print_json(&json!({
            "kind": "omg.runtime.status",
            "status": "running",
            "pid": pid,
            "session": info.get("session").cloned().unwrap_or(Value::Null),
            "started_at": info.get("started_at").cloned().unwrap_or(Value::Null),
        }))?;
    } else {
        let last = std::fs::read_to_string(last_path())
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
        print_json(&json!({
            "kind": "omg.runtime.status",
            "status": "stopped",
            "last": last.unwrap_or(Value::Null),
        }))?;
    }
    Ok(ExitCode::SUCCESS)
}

fn cmd_stop() -> Result<ExitCode> {
    if let Some((pid, info)) = active_session() {
        std::fs::create_dir_all(state_dir())?;
        std::fs::write(stop_path(), b"stop")?;
        print_json(&json!({
            "kind": "omg.runtime.stop",
            "status": "stopping",
            "pid": pid,
            "session": info.get("session").cloned().unwrap_or(Value::Null),
            "note": "the session polls this file each frame, restores lighting, then exits",
        }))?;
    } else {
        // No live session: drop any stale files and report stopped.
        let _ = std::fs::remove_file(marker_path());
        let _ = std::fs::remove_file(stop_path());
        print_json(&json!({
            "kind": "omg.runtime.stop",
            "status": "stopped",
            "note": "no active runtime session",
        }))?;
    }
    Ok(ExitCode::SUCCESS)
}

// ── schema ─────────────────────────────────────────────────────────────

fn field(
    name: &str,
    ty: &str,
    required: bool,
    default: Value,
    notes: &str,
) -> Value {
    json!({
        "name": name,
        "type": ty,
        "required": required,
        "default": default,
        "notes": notes,
    })
}

/// The runtime session schema — the agent-discovery document for
/// `omg runtime start`. Classification `runtime` per spec §4.4: these
/// are live sessions, never persistent config.
fn schema_doc() -> Value {
    json!({
        "kind": "omg.runtime.schema",
        "version": 1,
        "classification": "runtime",
        "spec": "docs/specs/rust-cli-config-migration-spec.md §3.2/§4.4; docs/specs/ADR-full-desired-state-config.md §4/§8",
        "capability": {
            "device": "khub916 wired keyboard (K1 Pro family) — the only live-verified cmd-8 target",
            "transport": "cmd-8 GIF frames, 378-byte reports (planar by default)",
            "max_fps": 30,
            "default_fps": 10,
            "risk": "L2 runtime write — requires --yes; lighting snapshot restored on exit/Ctrl-C/stop-request",
            "verification": "code-verified; the underlying stream path is live-verified via `omg kb916 light music`/`light stream`",
        },
        "lifecycle": {
            "commands": [
                "omg runtime schema",
                "omg runtime start <session.json|-> [--yes] [--duration N]",
                "omg runtime status",
                "omg runtime stop",
            ],
            "start_requires_yes": true,
            "start_without_yes": "prints the plan and sends nothing (approval semantics, spec §7.5)",
            "duration": "optional cap in seconds — session `duration_s` and `--duration N`, the shorter wins; absent = until stopped",
            "stop": "always allowed; writes a stop-request the session polls each frame — the safe direction",
            "interrupts": "Ctrl-C (and SIGTERM where delivered) stops the pump and still restores lighting; SIGKILL/SIGSTOP may leave the device streamed — recover with `omg kb916 light apply <json> --yes`",
            "session_state": "marker file in the OS temp dir (`omg-runtime/active.json`) lets status/stop work across processes; a dead pid's marker is treated as stale and removed, never trusted",
            "restore": "profile + cmd-138 light-data snapshot written back with per-step verified read-back; reported as `restored` in the session report and `omg runtime status`",
            "concurrency": "one runtime session at a time — a second `start` fails while a live marker exists; the device is never double-streamed",
        },
        "sessions": [
            {
                "kind": "music",
                "description": "Music-reactive lighting: audio capture (system loopback or mic) → FFT bands/beat → renderer → cmd-8 frames. Same pipeline as `omg kb916 light music`.",
                "fields": [
                    field("kind", "string", true, json!("music"), "must be \"music\""),
                    field("engine", "string", false, json!("mixer"), "legacy|mixer|modes — see `omg kb916 light music --help`"),
                    field("effect", "string", false, json!("beat"), "engine-dependent: legacy visualiser name, mixer preset/layer list, or modes shader name"),
                    field("source", "string", false, json!("system"), "system|mic"),
                    field("palette", "string", false, json!("auto"), "auto|rainbow|heat|ocean|sunset|neon|mono (mixer/modes engines)"),
                    field("speed", "number", false, json!(1.0), "0.25..=3.0 for mixer/modes engines"),
                    field("brightness", "number", false, json!(1.0), "0.0..=1.0"),
                    field("sensitivity", "number", false, json!(1.6), "0.1..=10.0 input gain"),
                    field("background", "number", false, json!(0.0), "0.0..=1.0 dim base between beats"),
                    field("beat_intensity", "number", false, json!(1.0), "0.0..=2.0"),
                    field("attack", "number", false, json!(1.0), "0.25..=4.0"),
                    field("decay", "number", false, json!(1.0), "0.25..=4.0"),
                    field("pixel_order", "string", false, json!("planar"), "planar|interleaved 378-byte layout"),
                    field("fps", "number", false, json!(10.0), "1.0..=30.0 (runtime cap; vendor cadence ~5 pkt/s — higher is unverified)"),
                    field("duration_s", "number|null", false, Value::Null, "positive seconds; null = until stopped"),
                ],
                "example": {
                    "kind": "music",
                    "engine": "mixer",
                    "effect": "party",
                    "source": "system",
                    "palette": "auto",
                    "speed": 1.0,
                    "brightness": 0.8,
                    "duration_s": null,
                },
            },
            {
                "kind": "pixel-art",
                "description": "LED pixel-art: text (5x7 font) or a raw bitmap rendered onto the real key geometry (omg-music `PixelArt`) and streamed as cmd-8 frames. No audio capture.",
                "fields": [
                    field("kind", "string", true, json!("pixel-art"), "must be \"pixel-art\""),
                    field("art", "object", true, Value::Null, "exactly one of {\"text\":\"…\"} or {\"bitmap\":{\"width\":N,\"height\":N,\"pixels\":[0-255]}}"),
                    field("motion", "string", false, json!("static"), "static|scroll_left|scroll_right"),
                    field("repeat", "boolean", false, json!(true), "scroll loops forever when true; false parks off-screen"),
                    field("speed", "number", false, json!(6.0), "strip cells/sec, 0.1..=120.0"),
                    field("color", "color", false, json!("#ffffff"), "lit/mono colour: #rrggbb, rrggbb, r,g,b or {r,g,b} 0-255"),
                    field("palette", "string|null", false, Value::Null, "rainbow|heat|ocean|sunset|neon|mono colour cycling, or null for solid `color`"),
                    field("background", "color", false, json!("#000000"), "unlit-cell colour"),
                    field("brightness", "number", false, json!(1.0), "0.0..=1.0 master brightness"),
                    field("canvas", "object", false, json!({"cols": 21, "rows": 6}), "{cols:1..=64, rows:1..=16}; 21x6 = one cell per K1 Pro slot"),
                    field("map", "string", false, json!("keys"), "keys (real keymap geometry) | cells (slot-order raster)"),
                    field("pixel_order", "string", false, json!("planar"), "planar|interleaved 378-byte layout"),
                    field("fps", "number", false, json!(10.0), "1.0..=30.0 (runtime cap)"),
                    field("duration_s", "number|null", false, Value::Null, "positive seconds; null = until stopped"),
                ],
                "example": {
                    "kind": "pixel-art",
                    "art": { "text": "HELLO" },
                    "motion": "scroll_left",
                    "speed": 6,
                    "color": "#00ff88",
                    "palette": "rainbow",
                    "background": "#000000",
                    "brightness": 0.8,
                    "canvas": { "cols": 21, "rows": 6 },
                    "duration_s": null,
                },
            },
        ],
        "notes": [
            "Sessions are per-invocation: `runtime start` blocks until the session ends; there is no daemon.",
            "Both kinds share the `kb916 light music` streaming path: snapshot → paced cmd-8 pump → verified lighting restore.",
            "pixel-art `map:\"keys\"` uses the layer-0 keymap for geometry; unreadable/absent keymap falls back to grid geometry.",
        ],
    })
}

// ── pixel-art runner ───────────────────────────────────────────────────

fn run_pixelart_session(
    cli: &Cli,
    p: &PixelArtSession,
    duration: Option<f64>,
    stop_file: &Path,
) -> Result<(ExitCode, Value)> {
    // Runtime sessions are capped at the verified cmd-8 ceiling.
    if !(1.0..=30.0).contains(&p.fps) || !p.fps.is_finite() {
        bail!("fps must be in 1.0..=30.0 for runtime sessions, got {}", p.fps);
    }
    if duration.is_some_and(|d| d <= 0.0) {
        bail!("duration must be positive seconds");
    }

    // Rebuild the spec (PixelArtSpec is not Clone; fields are cheap).
    let mut art = PixelArt::new(pixelart_spec_clone(&p.spec));

    let mut stream = match kb916_music::open_stream(cli)? {
        StreamOpen::Ready(s) => s,
        StreamOpen::Exit(code) => return Ok((code, Value::Null)),
    };

    // Real keymap geometry when available; grid fallback inside
    // mixer_geometry/set_slots covers absent reads.
    let keymap = stream.keymap();
    match p.spec.map {
        MapMode::Keys => art.set_geometry(&kb916_music::mixer_geometry(keymap.as_deref())),
        MapMode::Cells => art.set_slots(126),
    }
    if art.slots() == 0 {
        bail!("pixel-art session produced 0 colour slots");
    }
    let slots = art.slots();
    let planar = p.pixel_order == "planar";

    if !cli.json {
        println!(
            "pixel-art: {}×{} canvas, {} slots, {} fps (Ctrl-C to stop)",
            p.spec.cols, p.spec.rows, slots, p.fps
        );
    }

    let outcome = stream.pump(p.fps, duration, Some(stop_file), |_, dt| {
        let colors = art.frame(dt);
        let bytes = pack_frame(&colors, slots, planar);
        let mut f = [0u8; omg_music::render::FRAME_BYTES];
        f.copy_from_slice(&bytes[..omg_music::render::FRAME_BYTES]);
        f
    });

    let report = json!({
        "device": stream.device,
        "event": "pixelart_done",
        "frames_sent": outcome.sent,
        "elapsed_s": outcome.elapsed_s,
        "stopped_by": outcome.stopped_by,
        "stream_error": outcome.stream_error,
        "restore": outcome.restore_steps,
        "restored": outcome.restored,
    });
    if cli.json {
        print_json(&report)?;
    } else {
        println!(
            "pixel-art: {} frames in {:.1}s ({})",
            outcome.sent, outcome.elapsed_s, outcome.stopped_by
        );
        for s in &outcome.restore_steps {
            match (
                s["step"].as_str(),
                s["verified"].as_bool(),
                s["error"].as_str(),
            ) {
                (Some(step), Some(true), _) => println!("  {step}: verified (cmd {})", s["command"]),
                (Some(step), _, Some(err)) => println!("  {step}: FAILED — {err}"),
                _ => {}
            }
        }
    }
    if let Some(e) = &outcome.stream_error {
        return Err(anyhow::anyhow!("frame write failed: {e}"));
    }
    if !outcome.restored {
        return Err(anyhow::anyhow!(
            "lighting restore failed — check `omg kb916 light get` and re-apply"
        ));
    }
    Ok((ExitCode::SUCCESS, report))
}

/// PixelArtSpec isn't Clone; rebuild an equivalent spec for `PixelArt::new`.
/// `art` is consumed, so the session keeps enough to rebuild it — in
/// practice we stored the parsed `ArtSource` inside the spec already,
/// so this clones the non-art fields and reuses `spec.art` by cloning
/// the source (ArtSource is Clone).
fn pixelart_spec_clone(spec: &PixelArtSpec) -> PixelArtSpec {
    PixelArtSpec {
        art: spec.art.clone(),
        cols: spec.cols,
        rows: spec.rows,
        motion: spec.motion,
        repeat: spec.repeat,
        speed: spec.speed,
        color: spec.color,
        palette: spec.palette,
        background: spec.background,
        brightness: spec.brightness,
        map: spec.map,
    }
}

// ── tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Result<Session> {
        parse_session(&serde_json::from_str(s).unwrap())
    }

    #[test]
    fn music_session_parses_with_defaults() {
        let s = parse(r#"{"kind":"music"}"#).unwrap();
        let Session::Music(m) = &s else { panic!("want music") };
        assert_eq!(m.args.engine, "mixer");
        assert_eq!(m.args.source, "system");
        assert_eq!(m.args.effect, "beat");
        assert_eq!(m.args.palette, "auto");
        assert_eq!(m.args.pixel_order, "planar");
        assert_eq!(m.fps, 10.0);
        assert_eq!(m.args.duration, None);
        assert_eq!(s.kind(), "music");
    }

    #[test]
    fn music_session_full_example() {
        let s = parse(
            r#"{"kind":"music","engine":"modes","effect":"sine","source":"mic",
                "palette":"neon","speed":1.5,"brightness":0.8,"fps":15,
                "duration_s":30}"#,
        )
        .unwrap();
        let Session::Music(m) = &s else { panic!("want music") };
        assert_eq!(m.args.engine, "modes");
        assert_eq!(m.args.source, "mic");
        assert_eq!(m.args.palette, "neon");
        assert_eq!(m.args.duration, Some(30.0));
        assert_eq!(m.fps, 15.0);
    }

    #[test]
    fn pixelart_session_parses_example() {
        let s = parse(
            r##"{"kind":"pixel-art","art":{"text":"HELLO"},"motion":"scroll_left",
                "speed":6,"color":"#00ff88","palette":"rainbow",
                "background":"#000000","brightness":0.8,
                "canvas":{"cols":21,"rows":6},"duration_s":null}"##,
        )
        .unwrap();
        let Session::PixelArt(p) = &s else { panic!("want pixel-art") };
        assert_eq!(p.spec.motion, Motion::ScrollLeft);
        assert_eq!(p.spec.cols, 21);
        assert_eq!(p.spec.rows, 6);
        assert_eq!(p.spec.speed, 6.0);
        assert_eq!(p.spec.palette, Some(Palette::Rainbow));
        assert_eq!(p.spec.brightness, 0.8);
        assert_eq!(p.spec.map, MapMode::Keys);
        let Rgb { r, g, b } = p.spec.color;
        assert!((r - 0.0).abs() < 0.01 && (g - 1.0).abs() < 0.01 && (b - 0.53).abs() < 0.02);
    }

    #[test]
    fn pixelart_bitmap_art() {
        let s = parse(
            r#"{"kind":"pixel-art","art":{"bitmap":{"width":2,"height":1,"pixels":[255,0]}},"map":"cells"}"#,
        )
        .unwrap();
        let Session::PixelArt(p) = &s else { panic!("want pixel-art") };
        assert_eq!(p.spec.map, MapMode::Cells);
        assert!(matches!(p.spec.art, ArtSource::Bitmap { .. }));
    }

    #[test]
    fn bad_kind_rejected() {
        assert!(parse(r#"{"kind":"bogus"}"#).is_err());
        assert!(parse(r#"{"engine":"mixer"}"#).is_err());
        assert!(serde_json::from_str::<Value>("not json").is_err());
    }

    #[test]
    fn bad_enums_rejected() {
        assert!(parse(r#"{"kind":"music","engine":"bogus"}"#).is_err());
        assert!(parse(r#"{"kind":"music","source":"linein"}"#).is_err());
        assert!(parse(r#"{"kind":"music","palette":"bogus"}"#).is_err());
        assert!(parse(r#"{"kind":"music","pixel_order":"rgb"}"#).is_err());
        assert!(parse(r#"{"kind":"pixel-art","art":{"text":"X"},"motion":"spin"}"#).is_err());
        assert!(parse(r#"{"kind":"pixel-art","art":{"text":"X"},"map":"grid"}"#).is_err());
        assert!(parse(r#"{"kind":"pixel-art","art":{"text":"X"},"palette":"bogus"}"#).is_err());
    }

    #[test]
    fn missing_and_bad_fields_rejected() {
        // art is required for pixel-art
        assert!(parse(r#"{"kind":"pixel-art"}"#).is_err());
        // art needs exactly one of text/bitmap
        assert!(parse(r#"{"kind":"pixel-art","art":{}}"#).is_err());
        assert!(parse(r#"{"kind":"pixel-art","art":{"text":"A","bitmap":{"width":1,"height":1,"pixels":[1]}}}"#).is_err());
        assert!(parse(r#"{"kind":"pixel-art","art":{"text":42}}"#).is_err());
        // unknown fields rejected (deny_unknown_fields)
        assert!(parse(r#"{"kind":"music","bogus":1}"#).is_err());
        assert!(parse(r#"{"kind":"pixel-art","art":{"text":"A"},"bogus":1}"#).is_err());
        // range violations
        assert!(parse(r#"{"kind":"music","brightness":1.5}"#).is_err());
        assert!(parse(r#"{"kind":"music","fps":0}"#).is_err());
        assert!(parse(r#"{"kind":"music","fps":31}"#).is_err());
        assert!(parse(r#"{"kind":"music","duration_s":-5}"#).is_err());
        assert!(parse(r#"{"kind":"pixel-art","art":{"text":"A"},"canvas":{"cols":0,"rows":6}}"#).is_err());
        assert!(parse(r##"{"kind":"pixel-art","art":{"text":"A"},"color":"notacolor"}"##).is_err());
    }

    #[test]
    fn schema_doc_lists_both_kinds() {
        let doc = schema_doc();
        assert_eq!(doc["kind"], "omg.runtime.schema");
        let kinds: Vec<&str> = doc["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["music", "pixel-art"]);
        assert_eq!(doc["classification"], "runtime");
        assert_eq!(doc["capability"]["max_fps"], 30);
    }

    #[test]
    fn plan_summary_has_no_device_fields() {
        let s = parse(r#"{"kind":"pixel-art","art":{"text":"HI"}}"#).unwrap();
        let plan = s.plan();
        assert_eq!(plan["kind"], "pixel-art");
        assert!(plan.get("art").is_none()); // plan stays small
    }
}
