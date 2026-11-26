//! `omg-music` — audio capture → DSP → 126-key RGB frame pipeline for
//! music-reactive lighting (bead oh-my-gravastar-bp6).
//!
//! Pipeline: [`capture::AudioSource`] (mic via cpal, system audio via
//! WASAPI loopback on Windows / ScreenCaptureKit on macOS) →
//! [`dsp::Analyzer`] (windowed FFT → log band energies + spectral-flux
//! onset events + tempo tracking) → renderers:
//!
//! - [`render`] — legacy visualisers (spectrum bars, beat impacts,
//!   whole-field pulse) → 378-byte planar frame.
//! - [`mixer`] — additive layer mixer (spectrum/ripple/pulse/rain/…)
//!   with named [`mixer::Preset`]s, driven by per-slot [`mixer::KeyPoint`]
//!   geometry → per-slot RGB packed by [`mixer::pack_frame`].
//!
//! Everything except the capture backends is pure and unit-tested with
//! synthetic signals; no device access happens in this crate.

pub mod capture;
pub mod dsp;
pub mod mixer;
pub mod pixelart;
pub mod render;

pub use dsp::{Analyzer, Bands, BeatEvent, BeatKind, SPECTRUM_BINS};
pub use mixer::{
    grid_geometry, pack_frame, parse_layers, preset, KeyPoint, LayerKind, LayerMixer, ModeKind,
    ModeRenderer, Palette, Preset, Rgb, PRESETS,
};
pub use pixelart::{ArtSource, MapMode, Motion, PixelArt, PixelArtSpec};
pub use render::{
    render_frame, to_interleaved, to_planar, BeatViz, FrameParams, KeyPos, PulseMode, PulseViz,
    SpectrumViz, RENDERER_VERSION,
};
