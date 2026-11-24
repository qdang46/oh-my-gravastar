//! `omg-music` — audio capture → DSP → 126-key RGB frame pipeline for
//! music-reactive lighting (bead oh-my-gravastar-bp6).
//!
//! Pipeline: [`capture::AudioSource`] (mic via cpal, system audio via
//! ScreenCaptureKit on macOS) → [`dsp::Analyzer`] (windowed FFT → log
//! band energies + spectral-flux onset events) → [`render`] (bands →
//! 378-byte planar frame, `[R×126][G×126][B×126]` — the layout
//! `kb916 light stream --file` consumes and `write_gif_frame` sends).
//!
//! Everything except the capture backends is pure and unit-tested with
//! synthetic signals; no device access happens in this crate.

pub mod capture;
pub mod dsp;
pub mod f75;
pub mod render;

pub use dsp::{Analyzer, Bands, BeatEvent, BeatKind, SPECTRUM_BINS};
pub use f75::{F75Key, F75_KEYS, Palette, VendorEngine, VendorLayer};
pub use render::{
    render_frame, to_interleaved, to_planar, BeatViz, FrameParams, KeyPos, PulseMode,
    PulseViz, SpectrumViz, RENDERER_VERSION,
};
