//! Audio capture backends producing mono f32 samples.
//!
//! - [`MicSource`]: default input device via `cpal` (cross-platform).
//!   Picks the first supported config with `SampleFormat::F32`.
//! - [`SystemSource`]: system-audio loopback — WASAPI render-endpoint
//!   loopback on Windows (via `wasapi`), ScreenCaptureKit display audio
//!   on macOS. No microphone involved: hears exactly what the speakers
//!   play, like the official music mode.
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

// ── System audio (Windows WASAPI loopback) ─────────────────────────────

#[cfg(target_os = "windows")]
pub mod system {
    use super::{push_capped, AudioSource, SampleQueue};
    use anyhow::{Context, Result};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use wasapi::{
        initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
    };

    const SAMPLE_RATE: usize = 48_000;
    const CHANNELS: usize = 2;
    /// How long the capture thread sleeps between buffer reads when no
    /// event arrives (also the stop-flag poll interval).
    const WAIT_MS: u32 = 200;

    /// Loopback capture of the default render endpoint. A dedicated
    /// thread owns the WASAPI stream (COM must live on one thread) and
    /// pushes mono f32 into the shared queue.
    pub struct SystemSource {
        sample_rate: u32,
        queue: SampleQueue,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl SystemSource {
        pub fn start() -> Result<Self> {
            let queue = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let q = queue.clone();
            let s = stop.clone();
            let thread = std::thread::Builder::new()
                .name("omg-music-loopback".into())
                .spawn(move || capture_loop(q, s))
                .context("failed to spawn WASAPI loopback thread")?;
            Ok(Self {
                sample_rate: SAMPLE_RATE as u32,
                queue,
                stop,
                thread: Some(thread),
            })
        }
    }

    impl AudioSource for SystemSource {
        fn sample_rate(&self) -> u32 {
            self.sample_rate
        }
        fn drain(&mut self) -> Vec<f32> {
            std::mem::take(&mut *self.queue.lock().unwrap_or_else(|e| e.into_inner()))
        }
        fn describe(&self) -> String {
            format!("system (WASAPI loopback, {} Hz mono)", self.sample_rate)
        }
    }

    impl Drop for SystemSource {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    fn capture_loop(queue: SampleQueue, stop: Arc<AtomicBool>) {
        // COM must be initialised on the thread that uses it; an
        // already-initialised apartment returns RPC_E_CHANGED_MODE,
        // which is fine — the objects work either way.
        let _ = initialize_mta();
        if let Err(e) = run(&queue, &stop) {
            eprintln!("omg-music: system audio capture ended: {e}");
        }
    }

    fn run(queue: &SampleQueue, stop: &AtomicBool) -> Result<()> {
        let enumerator = DeviceEnumerator::new()?;
        // Loopback = capture direction on the default *render* device.
        let device = enumerator.get_default_device(Direction::Render)?;
        let mut client = device.get_iaudioclient()?;
        // Ask for interleaved float32 stereo @ 48 kHz; autoconvert lets
        // WASAPI resample/mix whatever the endpoint actually runs.
        let format = WaveFormat::new(32, 32, SampleType::Float, SAMPLE_RATE, CHANNELS, None);
        let (_default, min_period) = client.get_device_period()?;
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: min_period,
        };
        client.initialize_client(&format, Direction::Capture, mode, None)?;
        let event = client.set_get_eventhandle()?;
        let capture = client.get_audiocaptureclient()?;
        client.start_stream()?;

        let mut pending: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
        while !stop.load(Ordering::Relaxed) {
            // Drain every queued packet (~10 ms frames each).
            while matches!(capture.get_next_packet_size()?, Some(n) if n > 0) {
                capture.read_from_device_to_deque(&mut pending)?;
            }
            // Convert everything queued so far: interleaved f32 stereo
            // → mono by averaging channels.
            if pending.len() >= CHANNELS * 4 {
                let bytes: Vec<u8> = pending.drain(..).collect();
                let mut mono = Vec::with_capacity(bytes.len() / (CHANNELS * 4));
                for frame in bytes.chunks_exact(CHANNELS * 4) {
                    let mut acc = 0.0f32;
                    for ch in 0..CHANNELS {
                        let o = ch * 4;
                        acc += f32::from_le_bytes([
                            frame[o],
                            frame[o + 1],
                            frame[o + 2],
                            frame[o + 3],
                        ]);
                    }
                    mono.push(acc / CHANNELS as f32);
                }
                push_capped(queue, &mono);
            }
            // Event-driven wait; a timeout just means "check stop flag".
            let _ = event.wait_for_event(WAIT_MS);
        }
        client.stop_stream()?;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub use system::SystemSource;

/// Construct the requested source. `system` is available on Windows
/// (WASAPI loopback) and macOS (ScreenCaptureKit); elsewhere it bails.
pub fn open_source(kind: SourceKind) -> Result<Box<dyn AudioSource>> {
    match kind {
        SourceKind::Mic => Ok(Box::new(MicSource::start()?)),
        SourceKind::System => {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                Ok(Box::new(SystemSource::start()?))
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                anyhow::bail!("system audio capture is only implemented on Windows and macOS")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Mic,
    System,
}
