//! `omg-music` — audio capture → DSP → 126-key RGB frame pipeline for
//! music-reactive lighting (bead oh-my-gravastar-bp6).
//!
//! Pipeline: [`capture::AudioSource`] (mic via cpal, system audio via
//! ScreenCaptureKit on macOS) → [`dsp::Analyzer`] (windowed FFT → log
//! band energies + beat) → [`render`] (bands → 378-byte planar frame,
//! `[R×126][G×126][B×126]` — the layout `kb916 light stream --file`
//! consumes and `write_gif_frame` sends).
//!
//! Everything except the capture backends is pure and unit-tested with
//! synthetic signals; no device access happens in this crate.

pub mod capture;
pub mod dsp;
pub mod render;

pub use dsp::{Analyzer, Bands, SPECTRUM_BINS};
pub use render::{render_frame, FrameParams, RENDERER_VERSION};
