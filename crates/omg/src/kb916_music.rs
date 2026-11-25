//! `omg kb916 light music` — music-reactive cmd-8 frame streaming.
//!
//! Pipeline (omg-music crate): audio source (`--source system|mic`) →
//! windowed FFT bands + beat → spectrum-frame renderer → 378-byte planar
//! frames → `write_gif_frame` at `--fps`. Same safety contract as
//! `light stream`: `--yes` gate before any device access, profile +
//! cmd-138 light-data snapshot, verified restore on exit/Ctrl-C/error.
//!
//! `--source system` uses WASAPI loopback on Windows and
//! ScreenCaptureKit display-audio capture on macOS (needs Screen
//! Recording permission). `--source mic` uses the default cpal input —
//! useful for testing, but only hears what the mic hears (TWS earbuds
//! leak almost nothing).

use anyhow::{anyhow, bail, Result};
use omg_music::capture::{open_source, SourceKind};
use omg_music::{
    grid_geometry, pack_frame, parse_layers, preset, Analyzer, Bands, BeatViz, FrameParams,
    KeyPoint, KeyPos, LayerKind, LayerMixer, ModeKind, ModeRenderer, Palette, PulseMode,
    PulseViz, SpectrumViz,
};
use omg_proto_khub916::KeyValue;
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

// ── Slot → physical position mapping ───────────────────────────────────
//
// The 126 colour slots are NOT guaranteed to be in left→right key order.
// The keymap (cmd read, `keymap(0)`) carries a HID usage per slot; we map
// each usage to an approximate ANSI position and normalise to 0..1.
// Unknown usages (Fn, macros, mouse/media) fall back to the slot's linear
// position — good enough for ambient effects, imperfect for waves.
//
// Bare modifiers decode as `usage=0` + modifier bits, with no left/right
// distinction; candidates are consumed in slot order so the first Ctrl
// slot gets the left position, the next the right, etc.

/// (x_units, row) for a HID usage on an ANSI-ish layout. x in key units
/// (0 = left edge), row 0 = function row … 5 = bottom modifier row.
fn usage_cell(usage: u16) -> Option<(f32, u8)> {
    let cell = match usage {
        // Function row.
        0x29 => (0.5, 0),                    // Esc
        0x3A..=0x3D => (1.5 + (usage - 0x3A) as f32, 0), // F1–F4
        0x3E..=0x41 => (6.5 + (usage - 0x3E) as f32, 0), // F5–F8
        0x42..=0x45 => (11.5 + (usage - 0x42) as f32, 0), // F9–F12
        // Number row.
        0x35 => (0.5, 1),                    // `
        0x1E..=0x27 => (1.5 + (usage - 0x1E) as f32, 1), // 1..0
        0x2D => (11.5, 1),                   // -
        0x2E => (12.5, 1),                   // =
        0x2A => (14.3, 1),                   // Backspace
        0x46 => (12.8, 1),                   // PrtSc
        0x47 => (13.8, 1),                   // ScrLk
        0x48 => (14.8, 1),                   // Pause
        // QWERTY row.
        0x2B => (0.75, 2),                   // Tab
        0x14 => (2.0, 2),                    // q
        0x1A => (3.0, 2),                    // w
        0x08 => (4.0, 2),                    // e
        0x15 => (5.0, 2),                    // r
        0x17 => (6.0, 2),                    // t
        0x1C => (7.0, 2),                    // y
        0x18 => (8.0, 2),                    // u
        0x0C => (9.0, 2),                    // i
        0x12 => (10.0, 2),                   // o
        0x13 => (11.0, 2),                   // p
        0x2F => (12.0, 2),                   // [
        0x30 => (13.0, 2),                   // ]
        0x31 => (14.0, 2),                   // \
        0x28 => (14.6, 2),                   // Enter
        // Home row.
        0x39 => (0.9, 3),                    // Caps
        0x04 => (2.25, 3),                   // a
        0x16 => (3.25, 3),                   // s
        0x07 => (4.25, 3),                   // d
        0x09 => (5.25, 3),                   // f
        0x0A => (6.25, 3),                   // g
        0x0B => (7.25, 3),                   // h
        0x0D => (8.25, 3),                   // j
        0x0E => (9.25, 3),                   // k
        0x0F => (10.25, 3),                  // l
        0x33 => (11.25, 3),                  // ;
        0x34 => (12.25, 3),                  // '
        // Bottom letter row.
        0x1D => (2.75, 4),                   // z
        0x1B => (3.75, 4),                   // x
        0x06 => (4.75, 4),                   // c
        0x19 => (5.75, 4),                   // v
        0x05 => (6.75, 4),                   // b
        0x11 => (7.75, 4),                   // n
        0x10 => (8.75, 4),                   // m
        0x36 => (9.75, 4),                   // ,
        0x37 => (10.75, 4),                  // .
        0x38 => (11.75, 4),                  // /
        // Navigation cluster (right of main block, left of numpad).
        0x49 => (11.6, 1),                   // Ins
        0x4A => (12.6, 1),                   // Home
        0x4B => (13.6, 1),                   // PgUp
        0x4C => (11.6, 2),                   // Del
        0x4D => (12.6, 2),                   // End
        0x4E => (13.6, 2),                   // PgDn
        0x50 => (11.6, 4),                   // ←
        0x52 => (12.6, 4),                   // ↑
        0x4F => (13.6, 4),                   // →
        0x51 => (12.6, 5),                   // ↓
        // Bottom row.
        0x2C => (6.4, 5),                    // Space
        0x65 => (12.0, 5),                   // Menu
        // Numpad.
        0x53 => (14.5, 1),                   // NumLock
        0x57 => (14.0, 1),                   // KP 7
        0x58 => (15.0, 1),                   // KP 8
        0x59 => (16.0, 1),                   // KP 9
        0x54 => (16.4, 2),                   // KP /
        0x5A => (14.0, 2),                   // KP 4
        0x5B => (15.0, 2),                   // KP 5
        0x5C => (16.0, 2),                   // KP 6
        0x55 => (16.4, 3),                   // KP *
        0x5D => (14.0, 3),                   // KP 1
        0x5E => (15.0, 3),                   // KP 2
        0x5F => (16.0, 3),                   // KP 3
        0x56 => (16.4, 4),                   // KP -
        0x60 => (14.5, 4),                   // KP 0
        0x63 => (15.5, 4),                   // KP .
        _ => return None,
    };
    Some(cell)
}

/// Modifier-key candidate cells (left, right) consumed in slot order,
/// indexed by ctrl/shift/alt/gui flag position.
const MOD_CELLS: [[(f32, u8); 2]; 4] = [
    [(0.6, 5), (13.2, 5)],  // Ctrl
    [(1.1, 4), (13.6, 4)],  // Shift
    [(2.75, 5), (9.7, 5)],  // Alt
    [(1.75, 5), (10.6, 5)], // GUI/Win
];

/// Build per-slot positions in **key units** for the layer mixer:
/// `(x, row)` where x is 0…16.5 left→right and row 0…5 top→bottom.
/// Falls back to a linear spread for values we cannot place (Fn,
/// macros, empty).
fn key_cells(keymap: &[KeyValue]) -> Vec<(f32, f32)> {
    let n = keymap.len().max(1);
    let mut mod_used = [0usize; MOD_CELLS.len()];
    keymap
        .iter()
        .enumerate()
        .map(|(i, kv)| {
            let cell = match kv {
                KeyValue::Normal {
                    usage,
                    ctrl,
                    shift,
                    alt,
                    gui,
                } => {
                    if *usage != 0 {
                        usage_cell(*usage)
                    } else {
                        // Bare modifier: pick the first set mod's next
                        // unused left/right candidate.
                        let flags = [*ctrl, *shift, *alt, *gui];
                        flags.iter().position(|f| *f).map(|m| {
                            let cells = MOD_CELLS[m];
                            let idx = mod_used[m].min(1);
                            mod_used[m] += 1;
                            cells[idx]
                        })
                    }
                }
                _ => None,
            };
            match cell {
                Some((x, row)) => (x, row as f32),
                None => (i as f32 / (n - 1).max(1) as f32 * 16.5, 3.0),
            }
        })
        .collect()
}

/// Normalised [`KeyPos`] for the legacy visualisers (0..1 both axes).
fn key_positions(keymap: &[KeyValue]) -> Vec<KeyPos> {
    key_cells(keymap)
        .iter()
        .map(|&(x, row)| ((x / 16.5).clamp(0.0, 1.0), (row / 6.0).clamp(0.0, 1.0)))
        .collect()
}

/// Mixer geometry for all 126 colour slots: real positions where the
/// keymap decodes them, grid fallback for the rest.
fn mixer_geometry(keymap: Option<&[KeyValue]>) -> Vec<KeyPoint> {
    let fallback = grid_geometry(126);
    let cells = keymap.map(key_cells).unwrap_or_default();
    (0..126)
        .map(|i| match cells.get(i) {
            Some(&(x, y)) => KeyPoint { x, y },
            None => fallback[i],
        })
        .collect()
}

/// Unified frame renderer over the visualisers. All variants emit the
/// 378-byte cmd-8 payload; the mixer packs per-slot RGB directly.
enum Viz {
    Spectrum(SpectrumViz),
    Beat(BeatViz),
    Pulse(PulseViz),
    /// Additive layer mixer — `planar` selects the byte order
    /// `pack_frame` writes.
    Mixer { mixer: LayerMixer, planar: bool },
    /// Single-shader rhythm mode (column fills, chase heads, beam,
    /// pattern) — `planar` selects the byte order `pack_frame` writes.
    Mode { mode: ModeRenderer, planar: bool },
}

impl Viz {
    fn frame(&mut self, bands: &Bands, t: f32, dt: f32) -> [u8; omg_music::render::FRAME_BYTES] {
        match self {
            Viz::Spectrum(v) => v.frame(bands, t),
            Viz::Beat(v) => v.frame(bands, t),
            Viz::Pulse(v) => v.frame(bands, t),
            Viz::Mixer { mixer, planar } => {
                let colors = mixer.frame(bands, dt);
                let bytes = pack_frame(&colors, 126, *planar);
                let mut out = [0u8; omg_music::render::FRAME_BYTES];
                out.copy_from_slice(&bytes[..omg_music::render::FRAME_BYTES]);
                out
            }
            Viz::Mode { mode, planar } => {
                let colors = mode.frame(bands, dt);
                let bytes = pack_frame(&colors, 126, *planar);
                let mut out = [0u8; omg_music::render::FRAME_BYTES];
                out.copy_from_slice(&bytes[..omg_music::render::FRAME_BYTES]);
                out
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn cmd(
    cli: &Cli,
    source: &str,
    fps: f64,
    sensitivity: f32,
    brightness: f32,
    effect: &str,
    background: f32,
    beat_intensity: f32,
    attack: f32,
    decay: f32,
    pixel_order: &str,
    engine: &str,
    palette: &str,
    speed: f32,
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
    // Same hardware caution as `light stream`: the vendor paces khub916
    // reports ~200 ms apart; sustained rates far above that are unverified
    // and correlated with a firmware wedge (AGENTS.md incident log).
    if fps > 10.0 {
        eprintln!(
            "warning: --fps {fps} is well above the vendor's ~5 pkt/s report \
             cadence; sustained streaming at this rate may wedge the keyboard \
             (AGENTS.md incident log). Consider --fps 10 or lower."
        );
    }
    if !(0.1..=10.0).contains(&sensitivity) {
        bail!("--sensitivity must be in 0.1..=10.0, got {sensitivity}");
    }
    if !(0.0..=1.0).contains(&brightness) {
        bail!("--brightness must be in 0.0..=1.0, got {brightness}");
    }
    if !(0.0..=1.0).contains(&background) {
        bail!("--background must be in 0.0..=1.0, got {background}");
    }
    if !(0.0..=2.0).contains(&beat_intensity) {
        bail!("--beat-intensity must be in 0.0..=2.0, got {beat_intensity}");
    }
    if !(0.25..=4.0).contains(&attack) || !(0.25..=4.0).contains(&decay) {
        bail!("--attack/--decay must be in 0.25..=4.0, got {attack}/{decay}");
    }
    if !matches!(pixel_order, "planar" | "interleaved") {
        bail!("unknown --pixel-order '{pixel_order}' (want planar|interleaved)");
    }
    if !matches!(engine, "legacy" | "mixer" | "modes") {
        bail!("unknown --engine '{engine}' (want legacy|mixer|modes)");
    }
    // --effect means different things per engine: legacy visualiser
    // names for `legacy`; for `mixer` a preset name or a comma-separated
    // layer list with optional `=level` overrides; for `modes` a rhythm
    // mode name. The clap default "beat" is a legacy name — for the
    // layer engines it selects their default scene/mode.
    let mut mixer_spec = String::new();
    let mut mode_kind = ModeKind::DynamicSpectrum;
    if engine == "mixer" {
        mixer_spec = if effect == "beat" {
            "spectrum".to_string()
        } else {
            effect.to_string()
        };
    } else if engine == "modes" {
        mode_kind = if effect == "beat" {
            ModeKind::DynamicSpectrum
        } else {
            match ModeKind::parse(effect) {
                Some(m) => m,
                None => bail!(
                    "unknown --effect '{effect}' for --engine modes \
                     (want {})",
                    ModeKind::ALL
                        .iter()
                        .map(|m| m.name())
                        .collect::<Vec<_>>()
                        .join("|")
                ),
            }
        };
    } else if !matches!(effect, "spectrum" | "beat" | "pulse" | "bass" | "ambient") {
        bail!("unknown --effect '{effect}' (want spectrum|beat|pulse|bass|ambient)");
    }
    // Resolve the mixer scene: a preset name wins over a bare layer
    // name; anything with ','/'=' is a layer list.
    let (mixer_layers, preset_palette) = if engine == "mixer" {
        if let Some(p) = preset(&mixer_spec) {
            (
                p.layers.iter().map(|&l| (l, None)).collect::<Vec<_>>(),
                Some(p.palette),
            )
        } else {
            match parse_layers(&mixer_spec) {
                Ok(v) => (v, None),
                Err(e) => bail!(
                    "unknown --effect '{mixer_spec}' for --engine mixer: {e} \
                     (presets: {}; layers: {}; `name=0.5` sets a level)",
                    omg_music::PRESETS
                        .iter()
                        .map(|p| p.name)
                        .collect::<Vec<_>>()
                        .join(", "),
                    (LayerKind::Solid.name().to_string()
                        + ",breathing,wave,starry,spectrum,ripple,pulse,rain"),
                ),
            }
        }
    } else {
        (Vec::new(), None)
    };
    // --palette: "auto" keeps the preset's palette (Sunset for raw
    // layer lists, Rainbow for rhythm modes); an explicit name
    // overrides it. Only the layer engines consume a palette —
    // legacy ignores the flag entirely.
    let mixer_palette = if engine == "legacy" {
        Palette::Sunset
    } else {
        match palette {
            "auto" => preset_palette.unwrap_or(if engine == "modes" {
                Palette::Rainbow
            } else {
                Palette::Sunset
            }),
            other => match Palette::parse(other) {
                Some(p) => p,
                None => bail!(
                    "unknown --palette '{other}' \
                     (want auto|rainbow|heat|ocean|sunset|neon|mono)"
                ),
            },
        }
    };
    if engine != "legacy" && !(0.25..=3.0).contains(&speed) {
        bail!("--speed must be in 0.25..=3.0 for --engine {engine}, got {speed}");
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
    if let Some(w) = crate::kb916_light::snapshot_sanity_warning(&profile) {
        eprintln!("warning: {w}");
    }

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
            analyzer.fft_len(),
        );
    }

    // Map colour slots to physical key positions via the keymap so
    // effects follow the real keyboard geometry, not slot order.
    let keymap = kb.keymap(0).ok();
    let positions = keymap
        .as_deref()
        .map(key_positions)
        .unwrap_or_default();
    let params = FrameParams {
        sensitivity,
        brightness,
        fps: fps as f32,
        background,
        beat_intensity,
        attack,
        decay,
        ..FrameParams::default()
    };
    let mut viz = if engine == "mixer" {
        let mut mixer = LayerMixer::default();
        mixer.layers = mixer_layers;
        mixer.palette = mixer_palette;
        mixer.speed = speed;
        mixer.brightness = brightness;
        mixer.gain = sensitivity;
        mixer.set_geometry(mixer_geometry(keymap.as_deref()));
        Viz::Mixer {
            mixer,
            planar: pixel_order == "planar",
        }
    } else if engine == "modes" {
        let mut mode = ModeRenderer::default();
        mode.kind = mode_kind;
        mode.palette = mixer_palette;
        mode.speed = speed;
        mode.brightness = brightness;
        mode.gain = sensitivity;
        mode.set_geometry(mixer_geometry(keymap.as_deref()));
        Viz::Mode {
            mode,
            planar: pixel_order == "planar",
        }
    } else {
        match effect {
        "beat" => {
            let mut v = BeatViz::new(params);
            if !positions.is_empty() {
                v.set_positions(&positions);
            }
            Viz::Beat(v)
        }
        "pulse" | "bass" | "ambient" => {
            let mode = match effect {
                "bass" => PulseMode::Bass,
                "ambient" => PulseMode::Ambient,
                _ => PulseMode::Beat,
            };
            Viz::Pulse(PulseViz::new(params, mode))
        }
        _ => {
            let mut v = SpectrumViz::new(params);
            if !positions.is_empty() {
                v.set_positions(&positions.iter().map(|p| p.0).collect::<Vec<_>>());
            }
            Viz::Spectrum(v)
        }
        }
    };
    let period = Duration::from_secs_f64(1.0 / fps);
    let deadline = duration.map(|d| Instant::now() + Duration::from_secs_f64(d));
    let started = Instant::now();
    let mut bands = Bands::default();
    let mut sent: u64 = 0;
    let mut analyses: u64 = 0;
    let mut beats: u64 = 0;
    let mut last_bpm: f32 = 0.0;
    let mut stream_error: Option<String> = None;

    let mut next_tick = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            break;
        }
        // Drain whatever the callback queued; analyse every completed
        // hop (analysis runs ahead of the LED frame rate). Events from
        // all hops in this drain merge into the latest Bands so no
        // transient is dropped between rendered frames.
        let samples = audio.drain();
        let analysed = analyzer.process(&samples);
        analyses += analysed.len() as u64;
        let mut events = Vec::new();
        let mut latest = None;
        for mut b in analysed {
            events.append(&mut b.events);
            latest = Some(b);
        }
        if let Some(mut b) = latest {
            beats += events.len() as u64;
            b.events = events;
            last_bpm = b.bpm;
            bands = b;
        }
        let t = started.elapsed().as_secs_f32();
        let mut frame = viz.frame(&bands, t, period.as_secs_f32());
        match &viz {
            // The layer engines pack their byte order via `pack_frame`;
            // only the legacy visualisers emit planar and may need
            // conversion.
            Viz::Mixer { .. } | Viz::Mode { .. } => {}
            _ => {
                if pixel_order == "interleaved" {
                    frame = omg_music::to_interleaved(&frame);
                }
            }
        }
        if std::env::var("OMG_DEBUG_FRAMES").is_ok() && sent % 20 == 0 {
            let mean = frame.iter().map(|&b| b as u32).sum::<u32>() as f32
                / (frame.len() as f32 * 255.0);
            let lit = frame.iter().filter(|&&b| b > 24).count();
            eprintln!(
                "  [frame {sent}] mean={mean:.3} lit_bytes={lit} level={:.2} bass={:.2} beat_pulse={:.2} bpm={:.0}",
                bands.level, bands.bass, bands.beat_pulse, bands.bpm
            );
        }
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
            "bpm": last_bpm,
            "elapsed_s": elapsed,
            "stopped_by": stopped_by,
            "stream_error": stream_error,
            "restore": restore_steps,
            "restored": !restore_failed,
        }))?;
    } else {
        println!(
            "music-reactive: {sent} frames, {analyses} analyses, {beats} beats in {:.1}s ({stopped_by}), bpm {:.0}",
            elapsed, last_bpm
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qwerty_positions_follow_geometry() {
        let kv = |usage: u16| KeyValue::Normal {
            usage,
            ctrl: false,
            shift: false,
            alt: false,
            gui: false,
        };
        // q (row 2) is above-left of z (row 4).
        let pos = key_positions(&[kv(0x14), kv(0x1D)]);
        assert!(pos[0].0 < pos[1].0, "q x {} should be left of z x {}", pos[0].0, pos[1].0);
        assert!(pos[0].1 < pos[1].1, "q y {} should be above z y {}", pos[0].1, pos[1].1);
        // Esc sits top-left; space sits bottom-centre.
        let pos = key_positions(&[kv(0x29), kv(0x2C)]);
        assert!(pos[0].1 < pos[1].1);
        assert!(pos[1].0 > 0.3 && pos[1].0 < 0.7);
    }

    #[test]
    fn unknown_values_fall_back_to_linear() {
        let pos = key_positions(&[KeyValue::Empty, KeyValue::Fn { layer: 0 }]);
        assert_eq!(pos[0], (0.0, 0.5));
        assert_eq!(pos[1], (1.0, 0.5));
    }
}
