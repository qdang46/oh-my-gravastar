//! Audio capture backends producing mono f32 samples.
//!
//! - [`MicSource`]: default input device via `cpal` (cross-platform).
//!   Picks the first supported config with `SampleFormat::F32`.
//! - [`SystemSource`] (macOS only): system audio loopback via
//!   ScreenCaptureKit (`SCStream` with `captures_audio`). Requires the
//!   "Screen Recording" TCC permission — first run triggers the macOS
//!   prompt. Requests mono 48 kHz to keep PCM parsing trivial.
//!
//! Both feed an `Arc<Mutex<Vec<f32>>>`; [`AudioSource::drain`] takes
//! everything accumulated since the last call. The mutex is only ever
//! held for memcpy-scale work, so callback latency stays tiny.

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

/// Mono f32 samples accumulated since the last `drain`.
pub type SampleQueue = Arc<Mutex<Vec<f32>>>;

/// Upper bound on buffered samples (~4 s @ 48 kHz) so a stalled consumer
/// can't grow memory without limit; oldest samples are dropped.
const QUEUE_CAP: usize = 192_000;

fn push_capped(queue: &SampleQueue, samples: &[f32]) {
    let mut q = queue.lock().unwrap_or_else(|e| e.into_inner());
    q.extend_from_slice(samples);
    if q.len() > QUEUE_CAP {
        let drop = q.len() - QUEUE_CAP;
        q.drain(..drop);
    }
}

/// A running audio source. Samples are pulled, not pushed: call
/// [`AudioSource::drain`] at the render rate.
pub trait AudioSource {
    /// Native sample rate of the stream (Hz).
    fn sample_rate(&self) -> u32;
    /// Take all samples captured since the previous call.
    fn drain(&mut self) -> Vec<f32>;
    /// Human-readable description for logs/JSON.
    fn describe(&self) -> String;
}

// ── Microphone (cpal) ──────────────────────────────────────────────────

/// Default-input-device capture. Downmixes interleaved input to mono by
/// averaging channels.
pub struct MicSource {
    sample_rate: u32,
    channels: u16,
    queue: SampleQueue,
    _stream: cpal::Stream,
}

impl MicSource {
    pub fn start() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .context("no default audio input device")?;
        // F32 only — every modern platform exposes it; keeps the callback
        // conversion-free. `supported_input_configs` yields ranges, so pin
        // a concrete rate: 48 kHz when offered, else the lowest supported.
        let range = device
            .supported_input_configs()?
            .find(|c| c.sample_format() == cpal::SampleFormat::F32)
            .context("input device has no F32 config")?;
        let (min, max) = (range.min_sample_rate(), range.max_sample_rate());
        let rate = if (min..=max).contains(&48_000) {
            48_000
        } else {
            min
        };
        let config = range.with_sample_rate(rate);
        let channels = config.channels();
        let sample_rate = config.sample_rate();
        let queue = Arc::new(Mutex::new(Vec::new()));
        let q = queue.clone();
        let stream_config: cpal::StreamConfig = config.into();
        let stream = device.build_input_stream(
            stream_config,
            move |data: &[f32], _info: &cpal::InputCallbackInfo| {
                let mono: Vec<f32> = if channels <= 1 {
                    data.to_vec()
                } else {
                    data.chunks_exact(channels as usize)
                        .map(|f| f.iter().sum::<f32>() / channels as f32)
                        .collect()
                };
                push_capped(&q, &mono);
            },
            |err| eprintln!("omg-music: mic stream error: {err}"),
            None,
        )?;
        stream.play()?;
        Ok(Self {
            sample_rate,
            channels,
            queue,
            _stream: stream,
        })
    }
}

impl AudioSource for MicSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    fn drain(&mut self) -> Vec<f32> {
        std::mem::take(&mut *self.queue.lock().unwrap_or_else(|e| e.into_inner()))
    }
    fn describe(&self) -> String {
        format!("mic ({} Hz, {} ch)", self.sample_rate, self.channels)
    }
}

// ── System audio (macOS ScreenCaptureKit) ──────────────────────────────

#[cfg(target_os = "macos")]
pub mod system {
    use super::{push_capped, AudioSource, SampleQueue};
    use anyhow::{Context, Result};
    use screencapturekit::prelude::*;
    use std::sync::{Arc, Mutex};

    const SAMPLE_RATE: u32 = 48_000;

    /// Handler receiving audio CMSampleBuffers; PCM is interleaved f32
    /// (we request mono, so one f32 per frame).
    struct AudioHandler {
        queue: SampleQueue,
    }

    impl SCStreamOutputTrait for AudioHandler {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
            if of_type != SCStreamOutputType::Audio {
                return;
            }
            let Ok(list) = sample.audio_buffer_list() else {
                return;
            };
            let Some(buf) = list.buffer(0) else {
                return;
            };
            let bytes = buf.data();
            // f32 LE mono; ignore any trailing partial frame.
            let n = bytes.len() / 4;
            if n == 0 {
                return;
            }
            let mut out = Vec::with_capacity(n);
            for chunk in bytes[..n * 4].chunks_exact(4) {
                out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
            }
            push_capped(&self.queue, &out);
        }
    }

    /// System-audio loopback via ScreenCaptureKit. Captures the first
    /// display's audio at 48 kHz mono. Video is configured minimal
    /// (2×2 @ 1 fps) — only audio buffers are consumed.
    ///
    /// Requires Screen Recording permission (TCC). `SCShareableContent::get`
    /// returns an error until the user grants it.
    pub struct SystemSource {
        queue: SampleQueue,
        _stream: SCStream,
        /// Kept alive so the stream isn't deallocated.
        _content: SCShareableContent,
    }

    impl SystemSource {
        pub fn start() -> Result<Self> {
            let content = SCShareableContent::get()
                .context("SCShareableContent::get failed — grant Screen Recording permission")?;
            let display = content
                .displays()
                .into_iter()
                .next()
                .context("no displays found")?;
            let filter = SCContentFilter::create()
                .with_display(&display)
                .with_excluding_windows(&[])
                .build()?;
            let config = SCStreamConfiguration::new()
                .with_width(2)
                .with_height(2)
                .with_fps(1)
                .with_captures_audio(true)
                .with_sample_rate(SAMPLE_RATE as i32)
                .with_channel_count(1);
            let mut stream = SCStream::new(&filter, &config)?;
            let queue = Arc::new(Mutex::new(Vec::new()));
            stream.add_output_handler(AudioHandler { queue: queue.clone() }, SCStreamOutputType::Audio)?;
            stream.start_capture()?;
            Ok(Self {
                queue,
                _stream: stream,
                _content: content,
            })
        }
    }

    impl AudioSource for SystemSource {
        fn sample_rate(&self) -> u32 {
            SAMPLE_RATE
        }
        fn drain(&mut self) -> Vec<f32> {
            std::mem::take(&mut *self.queue.lock().unwrap_or_else(|e| e.into_inner()))
        }
        fn describe(&self) -> String {
            format!("system (ScreenCaptureKit, {} Hz mono)", SAMPLE_RATE)
        }
    }

    impl Drop for SystemSource {
        fn drop(&mut self) {
            let _ = self._stream.stop_capture();
        }
    }
}

#[cfg(target_os = "macos")]
pub use system::SystemSource;

/// Construct the requested source. `system` is only available on macOS.
pub fn open_source(kind: SourceKind) -> Result<Box<dyn AudioSource>> {
    match kind {
        SourceKind::Mic => Ok(Box::new(MicSource::start()?)),
        SourceKind::System => {
            #[cfg(target_os = "macos")]
            {
                Ok(Box::new(SystemSource::start()?))
            }
            #[cfg(not(target_os = "macos"))]
            {
                anyhow::bail!("system audio capture is only implemented on macOS (ScreenCaptureKit)")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Mic,
    System,
}
