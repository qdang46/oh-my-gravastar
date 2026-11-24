//! `omg kb916 light music` — music-reactive cmd-8 frame streaming.
//!
//! Pipeline (omg-music crate): audio source (`--source system|mic`) →
//! windowed FFT bands + beat → spectrum-frame renderer → 378-byte planar
//! frames → `write_gif_frame` at `--fps`. Same safety contract as
//! `light stream`: `--yes` gate before any device access, profile +
//! cmd-138 light-data snapshot, verified restore on exit/Ctrl-C/error.
//!
//! `--source system` uses ScreenCaptureKit display-audio capture on
//! macOS (needs Screen Recording permission). `--source mic` uses the
//! default cpal input — useful for testing, but only hears what the mic
//! hears (TWS earbuds leak almost nothing).

use anyhow::{anyhow, bail, Result};
use omg_music::capture::{open_source, SourceKind};
use omg_music::{Analyzer, Bands, FrameParams, SpectrumViz};
use serde_json::json;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::{kb916_session, print_json, Cli, Yes};

/// FFT window ≈ 46 ms at any rate (nearest power of two, clamped to
/// [512, 8192] — Analyzer requires a power of two ≥ 256).
fn fft_size_for(rate: u32) -> usize {
    let want = rate as f32 * 0.046;
    (2f32.powf(want.log2().round()) as usize).clamp(512, 8192)
}

pub fn cmd(
    cli: &Cli,
    source: &str,
    fps: f64,
    sensitivity: f32,
    brightness: f32,
    duration: Option<f64>,
    yes: &Yes,
) -> Result<ExitCode> {
    // --yes gate BEFORE any device or audio access (docs/plan.md §2).
    if !yes.yes {
        bail!("refusing to write without --yes (docs/plan.md §2: writes are opt-in)");
    }
    let kind = match source {
        "system" => SourceKind::System,
        "mic" => SourceKind::Mic,
        other => bail!("unknown --source '{other}' (want system|mic)"),
    };
    if !(1.0..=240.0).contains(&fps) || !fps.is_finite() {
        bail!("--fps must be in 1.0..=240.0, got {fps}");
    }
    if !(0.1..=10.0).contains(&sensitivity) {
        bail!("--sensitivity must be in 0.1..=10.0, got {sensitivity}");
    }
    if !(0.0..=1.0).contains(&brightness) {
        bail!("--brightness must be in 0.0..=1.0, got {brightness}");
    }
    if duration.is_some_and(|d| d <= 0.0) {
        bail!("--duration must be positive seconds");
    }

    // Open audio first: a permission/denied error should surface before we
    // touch the keyboard at all.
    let mut audio = open_source(kind)?;
    let rate = audio.sample_rate();
    let mut analyzer = Analyzer::new(rate, fft_size_for(rate))?;

    let (device, mut kb) = match kb916_session(cli)? {
        Ok(s) => s,
        Err(code) => return Ok(code),
    };

    // Snapshot lighting state for restore (same contract as `light stream`).
    let profile = kb.profile()?;
    let light_blob = kb.light_color_data()?;

    let stop = Arc::new(AtomicBool::new(false));
    {
        let flag = stop.clone();
        ctrlc::set_handler(move || flag.store(true, Ordering::SeqCst))
            .map_err(|e| anyhow!("failed to install Ctrl-C handler: {e}"))?;
    }

    if !cli.json {
        println!(
            "music-reactive: {} → FFT {} Hz/{} bins → cmd-8 @ {fps} fps (Ctrl-C to stop)",
            audio.describe(),
            rate,
            analyzer.window_samples(),
        );
    }

    let mut viz = SpectrumViz::new(FrameParams {
        sensitivity,
        brightness,
        ..FrameParams::default()
    });
    let period = Duration::from_secs_f64(1.0 / fps);
    let deadline = duration.map(|d| Instant::now() + Duration::from_secs_f64(d));
    let started = Instant::now();
    let mut bands = Bands::default();
    let mut sent: u64 = 0;
    let mut analyses: u64 = 0;
    let mut beats: u64 = 0;
    let mut stream_error: Option<String> = None;

    let mut next_tick = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            break;
        }
        // Drain whatever the callback queued; analyse when a window is full.
        let samples = audio.drain();
        if let Some(b) = analyzer.process(&samples) {
            bands = b;
            analyses += 1;
            if bands.beat {
                beats += 1;
            }
        }
        let frame = viz.frame(&bands, started.elapsed().as_secs_f32());
        if let Err(e) = kb.write_gif_frame(&frame) {
            stream_error = Some(format!("{e:#}"));
            break;
        }
        sent += 1;
        let now = Instant::now();
        if now < next_tick {
            std::thread::sleep(next_tick - now);
        }
        next_tick += period;
        if Instant::now() >= next_tick + period {
            next_tick = Instant::now() + period;
        }
    }

    // ── Restore pre-run lighting (verified writes) ─────────────────────
    let mut restore_steps: Vec<serde_json::Value> = Vec::new();
    let mut restore_failed = false;
    match kb.write_profile(&profile.raw) {
        Ok(o) => restore_steps.push(json!({
            "step": "restore_profile", "command": o.command, "verified": o.verified,
        })),
        Err(e) => {
            restore_failed = true;
            restore_steps.push(json!({ "step": "restore_profile", "error": format!("{e:#}") }));
        }
    }
    match kb.write_light_data(&light_blob) {
        Ok(o) => restore_steps.push(json!({
            "step": "restore_light_data", "command": o.command, "verified": o.verified,
        })),
        Err(e) => {
            restore_failed = true;
            restore_steps.push(json!({ "step": "restore_light_data", "error": format!("{e:#}") }));
        }
    }

    let elapsed = started.elapsed().as_secs_f64();
    let stopped_by = if stop.load(Ordering::SeqCst) {
        "ctrl-c"
    } else {
        "limit"
    };

    if cli.json {
        print_json(&json!({
            "device": device,
            "event": "music_done",
            "source": source,
            "audio": audio.describe(),
            "sample_rate": rate,
            "frames_sent": sent,
            "analyses": analyses,
            "beats": beats,
            "elapsed_s": elapsed,
            "stopped_by": stopped_by,
            "stream_error": stream_error,
            "restore": restore_steps,
            "restored": !restore_failed,
        }))?;
    } else {
        println!(
            "music-reactive: {sent} frames, {analyses} analyses, {beats} beats in {:.1}s ({stopped_by})",
            elapsed
        );
        for s in &restore_steps {
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

    if let Some(e) = stream_error {
        bail!("frame write failed: {e}");
    }
    if restore_failed {
        bail!("lighting restore failed — check `omg kb916 light get` and re-apply");
    }
    Ok(ExitCode::SUCCESS)
}
