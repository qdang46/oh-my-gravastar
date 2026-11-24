//! Frequency-domain analysis: windowed FFT → log-spaced band energies →
//! smoothed [`Bands`] + simple energy-flux beat detection.
//!
//! Pure DSP, no I/O. Feed mono f32 samples (any rate; resampling is the
//! caller's problem — sources are asked for their native rate and the
//! CLI picks an FFT size that fits).

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

/// Log-spaced spectrum bins mapped across the keyboard left→right.
pub const SPECTRUM_BINS: usize = 24;
/// Band edges in Hz for the bass/mid/treble aggregates.
const BASS_MAX_HZ: f32 = 250.0;
const MID_MAX_HZ: f32 = 2_000.0;
const TREBLE_MAX_HZ: f32 = 20_000.0;
/// Magnitude floor/ceiling for dB normalisation (roughly -80…0 dBFS).
const FLOOR_DB: f32 = -80.0;
const CEIL_DB: f32 = -20.0;
/// EMA smoothing factor per analysed frame (~30 fps → ~80 ms time constant
/// at alpha 0.35).
const SMOOTH_ALPHA: f32 = 0.35;
/// Beat: bass energy must exceed its trailing average by this ratio…
const BEAT_RATIO: f32 = 1.35;
/// …with at least this much absolute energy, and not more often than
/// every `BEAT_COOLDOWN` analyses.
const BEAT_MIN_ENERGY: f32 = 0.02;
const BEAT_COOLDOWN: usize = 8;
/// Onset detection: spectral flux must exceed the trailing mean by this
/// factor, with at least `ONSET_MIN_FLUX` absolute flux, and events are
/// refractory for `EVENT_REFRACTORY` analyses (~130 ms @ 23 analyses/s).
const ONSET_FLUX_RATIO: f32 = 2.0;
const ONSET_MIN_FLUX: f32 = 0.02;
const EVENT_REFRACTORY: usize = 3;
const FLUX_HISTORY: usize = 32;
/// AGC: target normalised level, peak floor, gain clamp range.
const AGC_TARGET: f32 = 0.65;
const AGC_FLOOR: f32 = 0.05;
const AGC_MIN: f32 = 0.3;
const AGC_MAX: f32 = 6.0;
/// Spectrum-bin split for onset classification (24 log bins, 30 Hz–24 kHz):
/// bass ≈ bins 0–5, mid 6–15, treble 16–23.
const BASS_BINS: usize = 6;
const MID_BINS: usize = 16;

/// One analysis frame: smoothed band energies (0..1), overall level and a
/// beat flag that stays hot for one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Bands {
    /// Onset events detected on this frame (spectral flux vs history).
    pub events: Vec<BeatEvent>,
    /// Log-spaced spectrum energies, `SPECTRUM_BINS` entries, 0..1.
    pub spectrum: [f32; SPECTRUM_BINS],
    /// Reserved peak-cap channel (0 from the analyser; renderers may use
    /// it to pass per-band peak state through lookups).
    pub peak: [f32; SPECTRUM_BINS],
    /// Bass band (20 Hz–250 Hz) energy, 0..1.
    pub bass: f32,
    /// Low-mid band (250 Hz–2 kHz), 0..1.
    pub mid: f32,
    /// Treble band (2 kHz–20 kHz), 0..1.
    pub treble: f32,
    /// Broadband level (RMS → dBFS → 0..1), 0..1.
    pub level: f32,
    /// Automatic gain compensation (1.0 = unity). Normalises band
    /// energies against a slow-decaying running peak of `level` so quiet
    /// and loud material render with similar brightness.
    pub agc: f32,
    /// True on the frame a beat was detected.
    pub beat: bool,
}

/// Transient classification from per-region spectral flux.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BeatKind {
    /// Low-frequency onset (kick drum region, ~20–150 Hz).
    Kick,
    /// Mid-band onset (snare/body, ~150 Hz–2 kHz).
    Snare,
    /// High-band onset (hi-hat/cymbals, >4 kHz).
    HiHat,
    /// Broadband onset not clearly attributable to one region.
    Generic,
}

/// A detected musical event. `strength` is 0..1 (flux over adaptive
/// threshold); the renderer turns it into an animation impulse.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatEvent {
    pub kind: BeatKind,
    pub strength: f32,
}

impl Default for Bands {
    fn default() -> Self {
        Self {
            events: Vec::new(),
            spectrum: [0.0; SPECTRUM_BINS],
            peak: [0.0; SPECTRUM_BINS],
            bass: 0.0,
            mid: 0.0,
            treble: 0.0,
            level: 0.0,
            agc: 1.0,
            beat: false,
        }
    }
}

/// Stateful analyser: owns the FFT plan, Hann window and smoothing state.
/// Call [`Analyzer::process`] with any chunk of mono f32 samples; it
/// analyses the newest complete `fft_size` window whenever enough samples
/// have accumulated, otherwise returns `None`.
pub struct Analyzer {
    fft_size: usize,
    window: Vec<f32>,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    /// Bin ranges for the SPECTRUM_BINS log bands.
    spectrum_ranges: Vec<(usize, usize)>,
    bass_range: (usize, usize),
    mid_range: (usize, usize),
    treble_range: (usize, usize),
    buf: Vec<f32>,
    scratch: Vec<Complex<f32>>,
    spectrum_smooth: [f32; SPECTRUM_BINS],
    bass_smooth: f32,
    mid_smooth: f32,
    treble_smooth: f32,
    level_smooth: f32,
    bass_history: Vec<f32>,
    analyses: usize,
    since_beat: usize,
    /// Raw (unsmoothed) spectrum of the previous analysis, for spectral
    /// flux onset detection.
    prev_spectrum: [f32; SPECTRUM_BINS],
    /// Recent total-flux samples for the adaptive onset threshold.
    flux_history: Vec<f32>,
    /// Analyses since the last emitted onset event (refractory period).
    since_event: usize,
    /// Slow-decaying peak of `level_smooth` for AGC.
    level_peak: f32,
}

impl Analyzer {
    /// `fft_size` must be a power of two (typical: 2048 @ 48 kHz ≈ 43 ms).
    pub fn new(sample_rate: u32, fft_size: usize) -> anyhow::Result<Self> {
        anyhow::ensure!(
            fft_size.is_power_of_two() && fft_size >= 256,
            "fft_size must be a power of two ≥ 256, got {fft_size}"
        );
        anyhow::ensure!(sample_rate >= 8_000, "sample_rate too low: {sample_rate}");
        let window: Vec<f32> = (0..fft_size)
            .map(|i| {
                0.5 - 0.5
                    * (2.0 * std::f32::consts::PI * i as f32 / (fft_size - 1) as f32).cos()
            })
            .collect();
        let bin_hz: Vec<f32> = (0..=fft_size / 2)
            .map(|i| i as f32 * sample_rate as f32 / fft_size as f32)
            .collect();
        let spectrum_ranges = log_ranges(&bin_hz, 30.0, (sample_rate / 2) as f32, SPECTRUM_BINS);
        let bass_range = hz_range(&bin_hz, 20.0, BASS_MAX_HZ);
        let mid_range = hz_range(&bin_hz, BASS_MAX_HZ, MID_MAX_HZ);
        let treble_range = hz_range(&bin_hz, MID_MAX_HZ, TREBLE_MAX_HZ.min(sample_rate as f32 / 2.0));
        let mut planner = FftPlanner::<f32>::new();
        Ok(Self {
            fft_size,
            window,
            fft: planner.plan_fft_forward(fft_size),
            spectrum_ranges,
            bass_range,
            mid_range,
            treble_range,
            buf: Vec::with_capacity(fft_size * 2),
            scratch: vec![Complex::new(0.0, 0.0); fft_size],
            spectrum_smooth: [0.0; SPECTRUM_BINS],
            bass_smooth: 0.0,
            mid_smooth: 0.0,
            treble_smooth: 0.0,
            level_smooth: 0.0,
            bass_history: Vec::with_capacity(64),
            analyses: 0,
            since_beat: BEAT_COOLDOWN,
            prev_spectrum: [0.0; SPECTRUM_BINS],
            flux_history: Vec::with_capacity(64),
            since_event: EVENT_REFRACTORY,
            level_peak: 0.0,
        })
    }

    /// Samples needed for the next analysis (what `drain` should ideally
    /// accumulate between frames).
    pub fn window_samples(&self) -> usize {
        self.fft_size
    }

    /// Feed mono f32 samples; returns `Some(Bands)` each time a full
    /// window is available (roughly every `fft_size/sample_rate` seconds).
    pub fn process(&mut self, samples: &[f32]) -> Option<Bands> {
        self.buf.extend_from_slice(samples);
        // Keep at most one window + a bit; drop oldest.
        let keep = self.fft_size * 2;
        if self.buf.len() > keep {
            let drop = self.buf.len() - keep;
            self.buf.drain(..drop);
        }
        if self.buf.len() < self.fft_size {
            return None;
        }
        let win: Vec<f32> = self.buf[self.buf.len() - self.fft_size..]
            .iter()
            .zip(&self.window)
            .map(|(s, w)| s * w)
            .collect();
        for (i, s) in self.scratch.iter_mut().enumerate() {
            *s = Complex::new(win[i], 0.0);
        }
        self.fft.process(&mut self.scratch);

        let mags: Vec<f32> = self.scratch[..=self.fft_size / 2]
            .iter()
            .map(|c| (c.re * c.re + c.im * c.im).sqrt() / self.fft_size as f32)
            .collect();

        let band_energy = |range: (usize, usize)| -> f32 {
            if range.1 <= range.0 {
                return 0.0;
            }
            let sum: f32 = mags[range.0..range.1].iter().sum();
            // Mean magnitude in band → dBFS-ish → 0..1.
            let mean = sum / (range.1 - range.0) as f32;
            db_norm(mean * 4.0) // empirical gain: FFT magnitudes run low
        };

        let mut spectrum = [0.0f32; SPECTRUM_BINS];
        for (i, &range) in self.spectrum_ranges.iter().enumerate() {
            spectrum[i] = band_energy(range);
        }
        let bass = band_energy(self.bass_range);
        let mid = band_energy(self.mid_range);
        let treble = band_energy(self.treble_range);

        // Broadband level: RMS of the window → dBFS.
        let rms = (win.iter().map(|s| s * s).sum::<f32>() / win.len() as f32).sqrt();
        let level = db_norm(rms);

        // Smoothing.
        for i in 0..SPECTRUM_BINS {
            self.spectrum_smooth[i] += SMOOTH_ALPHA * (spectrum[i] - self.spectrum_smooth[i]);
        }
        self.bass_smooth += SMOOTH_ALPHA * (bass - self.bass_smooth);
        self.mid_smooth += SMOOTH_ALPHA * (mid - self.mid_smooth);
        self.treble_smooth += SMOOTH_ALPHA * (treble - self.treble_smooth);
        self.level_smooth += SMOOTH_ALPHA * (level - self.level_smooth);
        // AGC: track a decaying peak of the smoothed level and derive a
        // gain that maps it toward AGC_TARGET. Rises instantly, decays
        // slowly (~2000 analyses ≈ 90 s) so gain does not pump per beat.
        self.level_peak = self.level_peak.max(self.level_smooth);
        self.level_peak *= 0.9995;

        // Spectral flux onset detection on the raw (unsmoothed) bands:
        // only positive magnitude changes count, so sustained bass does
        // not retrigger. Classify the dominant rising region.
        let mut flux = [0.0f32; 3]; // bass, mid, treble regions
        let mut total_flux = 0.0f32;
        for i in 0..SPECTRUM_BINS {
            let d = spectrum[i] - self.prev_spectrum[i];
            if d > 0.0 {
                let region = if i < BASS_BINS {
                    0
                } else if i < MID_BINS {
                    1
                } else {
                    2
                };
                flux[region] += d;
                total_flux += d;
            }
        }
        self.prev_spectrum = spectrum;

        self.flux_history.push(total_flux);
        if self.flux_history.len() > FLUX_HISTORY {
            self.flux_history.remove(0);
        }
        self.since_event += 1;
        let events = if self.flux_history.len() >= 8 && self.since_event >= EVENT_REFRACTORY {
            let mean = self.flux_history[..self.flux_history.len() - 1]
                .iter()
                .sum::<f32>()
                / (self.flux_history.len() - 1) as f32;
            let thresh = (mean * ONSET_FLUX_RATIO).max(ONSET_MIN_FLUX);
            if total_flux > thresh {
                self.since_event = 0;
                let (bi, _) = flux
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                    .unwrap();
                let runner_up = flux
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i != bi)
                    .map(|(_, v)| *v)
                    .fold(0.0f32, f32::max);
                let dominance = flux[bi] / (flux[bi] + runner_up + 1e-6);
                let strength = ((total_flux - thresh) / thresh).min(2.0) / 2.0;
                let kind = if dominance < 0.6 {
                    BeatKind::Generic
                } else {
                    match bi {
                        0 => BeatKind::Kick,
                        1 => BeatKind::Snare,
                        _ => BeatKind::HiHat,
                    }
                };
                vec![BeatEvent { kind, strength }]
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        // Beat: bass flux vs trailing average.
        self.bass_history.push(self.bass_smooth);
        if self.bass_history.len() > 43 {
            self.bass_history.remove(0);
        }
        self.analyses += 1;
        self.since_beat += 1;
        let beat = if self.bass_history.len() >= 12 && self.since_beat >= BEAT_COOLDOWN {
            let avg: f32 =
                self.bass_history[..self.bass_history.len() - 1].iter().sum::<f32>()
                    / (self.bass_history.len() - 1) as f32;
            self.bass_smooth > BEAT_MIN_ENERGY
                && avg > 1e-4
                && self.bass_smooth > avg * BEAT_RATIO
        } else {
            false
        };
        if beat {
            self.since_beat = 0;
        }

        let agc = (AGC_TARGET / self.level_peak.max(AGC_FLOOR)).clamp(AGC_MIN, AGC_MAX);
        Some(Bands {
            events,
            agc,
            spectrum: self.spectrum_smooth,
            peak: [0.0; SPECTRUM_BINS],
            bass: self.bass_smooth,
            mid: self.mid_smooth,
            treble: self.treble_smooth,
            level: self.level_smooth,
            beat,
        })
    }
}

fn db_norm(linear: f32) -> f32 {
    if linear <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * linear.log10();
    ((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)).clamp(0.0, 1.0)
}

/// Inclusive bin range covering [lo_hz, hi_hz).
fn hz_range(bin_hz: &[f32], lo_hz: f32, hi_hz: f32) -> (usize, usize) {
    let lo = bin_hz.partition_point(|&f| f < lo_hz);
    let hi = bin_hz.partition_point(|&f| f < hi_hz).max(lo + 1);
    (lo.min(bin_hz.len() - 1), hi.min(bin_hz.len()))
}

/// Log-spaced band edges → bin ranges. Bands are [lo,hi) in Hz, log
/// spaced between f_min and f_max.
fn log_ranges(bin_hz: &[f32], f_min: f32, f_max: f32, n: usize) -> Vec<(usize, usize)> {
    let ratio = (f_max / f_min).powf(1.0 / n as f32);
    (0..n)
        .map(|i| {
            let lo = f_min * ratio.powi(i as i32);
            let hi = f_min * ratio.powi(i as i32 + 1);
            hz_range(bin_hz, lo, hi)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    #[test]
    fn analyzer_needs_full_window() {
        let mut a = Analyzer::new(48_000, 2048).unwrap();
        assert!(a.process(&sine(440.0, 48_000, 1000)).is_none());
        // Feed enough for one window.
        let out = a.process(&sine(440.0, 48_000, 2048));
        assert!(out.is_some());
        let b = out.unwrap();
        assert!(b.level > 0.0);
        assert!(b.spectrum.iter().any(|&e| e > 0.0));
    }

    #[test]
    fn bass_bands_dominate_low_sine() {
        let mut a = Analyzer::new(48_000, 2048).unwrap();
        // Feed several windows of a 100 Hz tone; bands should settle with
        // bass > treble.
        let chunk = sine(100.0, 48_000, 4096);
        let mut last = None;
        for _ in 0..6 {
            last = a.process(&chunk).or(last);
        }
        let b = last.unwrap();
        assert!(b.bass > b.treble, "bass {} treble {}", b.bass, b.treble);
        // 100 Hz lands in the low spectrum bins.
        assert!(b.spectrum[..4].iter().any(|&e| e > 0.05));
    }

    #[test]
    fn silence_stays_silent() {
        let mut a = Analyzer::new(48_000, 2048).unwrap();
        let mut last = None;
        for _ in 0..4 {
            last = a.process(&vec![0.0f32; 2048]).or(last);
        }
        let b = last.unwrap();
        assert_eq!(b.level, 0.0);
        assert!(!b.beat);
    }

    #[test]
    fn onset_fires_on_burst_after_silence() {
        let mut a = Analyzer::new(48_000, 2048).unwrap();
        for _ in 0..10 {
            a.process(&vec![0.0f32; 2048]);
        }
        let burst = sine(100.0, 48_000, 2048);
        let mut found = false;
        for _ in 0..4 {
            if let Some(b) = a.process(&burst) {
                if !b.events.is_empty() {
                    found = true;
                    break;
                }
            }
        }
        assert!(found, "burst after silence should produce an onset event");
    }

    #[test]
    fn fft_size_validated() {
        assert!(Analyzer::new(48_000, 1000).is_err());
        assert!(Analyzer::new(48_000, 256).is_ok());
    }
}
