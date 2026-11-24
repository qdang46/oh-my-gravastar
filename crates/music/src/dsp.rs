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
/// EMA smoothing factor per analysed frame.
const SMOOTH_ALPHA: f32 = 0.35;
/// Analysis hop = half the FFT window (~21 ms @ 48 kHz/2048) — transients
/// shorter than the window are still captured because analysis runs on
/// audio arrival, not on the LED frame rate.
const HOP_DIVISOR: usize = 2;
/// Energy-onset detectors (port of Hypercolor `beat.rs`): per-band fast
/// EMA vs slow EMA baseline.
const ONSET_FAST_ALPHA: f32 = 0.4;
const ONSET_SLOW_ALPHA: f32 = 0.02;
/// Slow-EMA multiplier + absolute floor for the onset threshold; the
/// per-band multipliers (bass/mid/treble) scale this base.
const ONSET_ENERGY_BASE: f32 = 1.2;
const ONSET_ENERGY_FLOOR: f32 = 0.02;
/// Minimum seconds between energy onsets in one band (~400 BPM cap).
const ONSET_MIN_INTERVAL_S: f32 = 0.15;
/// Spectral-flux adaptive threshold: mean + k·stddev of recent flux
/// (Hypercolor `SpectralFluxDetector`, threshold_multiplier = sensitivity).
const ONSET_SIGMA: f32 = 1.5;
const ONSET_MIN_FLUX: f32 = 0.02;
/// Minimum audio level before onset events are emitted — keeps silence
/// and dither noise from firing impacts.
const EVENT_MIN_LEVEL: f32 = 0.02;
/// Minimum seconds between emitted `BeatEvent`s.
const EVENT_MIN_INTERVAL_S: f32 = 0.13;
const FLUX_HISTORY: usize = 48;
/// AGC: target normalised level, peak floor, gain clamp range.
const AGC_TARGET: f32 = 0.65;
const AGC_FLOOR: f32 = 0.05;
const AGC_MIN: f32 = 0.3;
const AGC_MAX: f32 = 6.0;
/// Beat-pulse envelope decay (Hypercolor `PULSE_DECAY_RATE` = 5.0/s).
const PULSE_DECAY: f32 = 5.0;
/// Tempo tracker: BPM normalization range and minimum onset intervals.
const BPM_MIN: f32 = 60.0;
const BPM_MAX: f32 = 180.0;
const MIN_INTERVALS_FOR_BPM: usize = 4;
const ONSET_HISTORY_S: f64 = 10.0;
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
    /// True on the frame a beat was detected (bass onset, or flux onset
    /// with real bass energy).
    pub beat: bool,
    /// Estimated tempo in BPM (0 until the tracker locks on).
    pub bpm: f32,
    /// Beat phase: 0.0 = on the beat, →1.0 just before the next one.
    /// Renderers use it for tempo-locked pulsing between onsets.
    pub beat_phase: f32,
    /// Beat pulse envelope: 1.0 on a beat, decaying ~200 ms.
    pub beat_pulse: f32,
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
            bpm: 0.0,
            beat_phase: 0.0,
            beat_pulse: 0.0,
        }
    }
}

/// Per-band energy-onset detector: fast EMA vs slow EMA baseline with a
/// refractory interval (port of Hypercolor `EnergyOnsetDetector`).
struct BandOnset {
    short: f32,
    long: f32,
    cooldown: f32,
    /// Threshold multiplier on the slow EMA (higher bands need more).
    gain: f32,
}

impl BandOnset {
    fn new(gain: f32) -> Self {
        Self {
            short: 0.0,
            long: 0.0,
            cooldown: 0.0,
            gain,
        }
    }

    fn update(&mut self, energy: f32, dt: f32) -> bool {
        self.short += ONSET_FAST_ALPHA * (energy - self.short);
        self.long += ONSET_SLOW_ALPHA * (energy - self.long);
        self.cooldown -= dt;
        let thresh = self.long * ONSET_ENERGY_BASE * self.gain + ONSET_ENERGY_FLOOR;
        if self.short > thresh && self.cooldown <= 0.0 {
            self.cooldown = ONSET_MIN_INTERVAL_S;
            true
        } else {
            false
        }
    }
}

/// Tempo tracker: inter-onset interval median → BPM (normalized to
/// 60–180) + beat phase. Port of Hypercolor `TempoTracker`.
struct TempoTracker {
    onset_times: std::collections::VecDeque<f64>,
    bpm: f32,
    phase: f32,
    last_beat_time: f64,
    beat_interval: f64,
}

impl TempoTracker {
    fn new() -> Self {
        Self {
            onset_times: std::collections::VecDeque::with_capacity(128),
            bpm: 0.0,
            phase: 0.0,
            last_beat_time: 0.0,
            beat_interval: 0.0,
        }
    }

    fn record_onset(&mut self, time: f64) {
        self.onset_times.push_back(time);
        while let Some(&front) = self.onset_times.front() {
            if time - front > ONSET_HISTORY_S {
                self.onset_times.pop_front();
            } else {
                break;
            }
        }
        self.last_beat_time = time;
        self.estimate();
    }

    fn update_phase(&mut self, time: f64) {
        if self.beat_interval <= 0.0 {
            self.phase = 0.0;
            return;
        }
        self.phase = ((time - self.last_beat_time) / self.beat_interval).rem_euclid(1.0) as f32;
    }

    fn estimate(&mut self) {
        if self.onset_times.len() < 2 {
            self.bpm = 0.0;
            self.beat_interval = 0.0;
            return;
        }
        let mut intervals: Vec<f64> = self
            .onset_times
            .iter()
            .zip(self.onset_times.iter().skip(1))
            .map(|(&a, &b)| b - a)
            .filter(|&i| i > 0.05 && i < 2.0)
            .collect();
        if intervals.len() < MIN_INTERVALS_FOR_BPM {
            self.bpm = 0.0;
            self.beat_interval = 0.0;
            return;
        }
        intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = intervals[intervals.len() / 2];
        if median <= f64::EPSILON {
            self.bpm = 0.0;
            self.beat_interval = 0.0;
            return;
        }
        // Normalize octave errors into 60–180 BPM.
        let mut bpm = 60.0 / median;
        while bpm < f64::from(BPM_MIN) {
            bpm *= 2.0;
        }
        while bpm > f64::from(BPM_MAX) {
            bpm /= 2.0;
        }
        self.bpm = bpm as f32;
        self.beat_interval = 60.0 / f64::from(self.bpm);
    }
}

/// Stateful analyser: owns the FFT plan, Hann window and smoothing state.
/// Call [`Analyzer::process`] with any chunk of mono f32 samples; it
/// analyses every complete hop (`fft_size/2`) whenever enough samples
/// have accumulated and returns one [`Bands`] per analysed window.
pub struct Analyzer {
    fft_size: usize,
    /// Analysis hop in samples (fft_size / HOP_DIVISOR).
    hop: usize,
    /// Seconds per hop — the detector time base.
    hop_dt: f32,
    /// Absolute analysis time in seconds (tempo/onset bookkeeping).
    time_s: f64,
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
    /// Per-band energy-onset detectors (bass/mid/treble).
    band_onsets: [BandOnset; 3],
    /// Raw (unsmoothed) spectrum of the previous hop, for spectral
    /// flux onset detection.
    prev_spectrum: [f32; SPECTRUM_BINS],
    /// Recent total-flux samples for the mean+k·σ adaptive threshold.
    flux_history: Vec<f32>,
    /// Seconds since the last emitted `BeatEvent` (refractory).
    since_event_s: f32,
    /// Tempo tracker + beat pulse envelope.
    tempo: TempoTracker,
    beat_pulse: f32,
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
            hop: (fft_size / HOP_DIVISOR).max(256),
            hop_dt: ((fft_size / HOP_DIVISOR).max(256)) as f32 / sample_rate as f32,
            time_s: 0.0,
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
            band_onsets: [
                BandOnset::new(1.0),
                BandOnset::new(1.2),
                BandOnset::new(1.5),
            ],
            prev_spectrum: [0.0; SPECTRUM_BINS],
            flux_history: Vec::with_capacity(FLUX_HISTORY + 1),
            since_event_s: EVENT_MIN_INTERVAL_S,
            tempo: TempoTracker::new(),
            beat_pulse: 0.0,
            level_peak: 0.0,
        })
    }

    /// FFT window size in samples.
    pub fn fft_len(&self) -> usize {
        self.fft_size
    }

    /// Samples per analysis hop (~21 ms @ 48 kHz/2048) — analyses run on
    /// audio arrival, independent of the LED frame rate.
    pub fn window_samples(&self) -> usize {
        self.hop
    }

    /// Feed mono f32 samples; returns one [`Bands`] per analysed hop
    /// (roughly every `hop/sample_rate` seconds). Windows overlap by
    /// `fft_size - hop` so transients are not skipped between analyses.
    pub fn process(&mut self, samples: &[f32]) -> Vec<Bands> {
        self.buf.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.buf.len() >= self.fft_size {
            let win: Vec<f32> = self
                .buf[..self.fft_size]
                .iter()
                .zip(&self.window)
                .map(|(s, w)| s * w)
                .collect();
            out.push(self.analyse(win));
            self.buf.drain(..self.hop);
        }
        out
    }

    /// FFT + feature extraction + detection for one window.
    fn analyse(&mut self, win: Vec<f32>) -> Bands {
        let dt = self.hop_dt;
        self.time_s += f64::from(dt);
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
        // slowly so gain does not pump per beat.
        self.level_peak = self.level_peak.max(self.level_smooth);
        self.level_peak *= 0.9995;

        // ── Detection (Hypercolor-style composite) ────────────────────
        // 1. Per-band energy onsets: fast EMA vs slow EMA baseline.
        let bass_hit = self.band_onsets[0].update(bass, dt);
        let mid_hit = self.band_onsets[1].update(mid, dt);
        let treble_hit = self.band_onsets[2].update(treble, dt);

        // 2. Spectral flux with mean+k·σ adaptive threshold.
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
        self.since_event_s -= dt;
        let flux_onset = if self.flux_history.len() >= 8 {
            let hist = &self.flux_history[..self.flux_history.len() - 1];
            let n = hist.len() as f32;
            let mean = hist.iter().sum::<f32>() / n;
            let var = hist.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n;
            let thresh = (mean + ONSET_SIGMA * var.sqrt()).max(ONSET_MIN_FLUX);
            total_flux > thresh
        } else {
            false
        };

        let onset_detected = bass_hit || mid_hit || treble_hit || flux_onset;
        // Beat = bass carrier: bass energy onset, or flux onset with real
        // bass present (Hypercolor rule — keeps the tempo tracker fed by
        // the kick, not by hats).
        let beat = bass_hit || (flux_onset && bass > 0.1);
        if beat {
            self.tempo.record_onset(self.time_s);
            self.beat_pulse = 1.0;
        } else {
            self.beat_pulse = (self.beat_pulse - PULSE_DECAY * dt).max(0.0);
        }
        self.tempo.update_phase(self.time_s);

        // Emit at most one classified event per refractory interval.
        let events = if onset_detected
            && self.since_event_s <= 0.0
            && self.level_smooth > EVENT_MIN_LEVEL
        {
            self.since_event_s = EVENT_MIN_INTERVAL_S;
            let (kind, strength) = if flux_onset {
                let hist = &self.flux_history[..self.flux_history.len().saturating_sub(1)];
                let n = hist.len().max(1) as f32;
                let mean = hist.iter().sum::<f32>() / n;
                let var = hist.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n;
                let thresh = (mean + ONSET_SIGMA * var.sqrt()).max(ONSET_MIN_FLUX);
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
                let strength =
                    (((total_flux - thresh) / thresh).min(2.0) / 2.0).max(0.35);
                let kind = if dominance < 0.6 {
                    BeatKind::Generic
                } else {
                    match bi {
                        0 => BeatKind::Kick,
                        1 => BeatKind::Snare,
                        _ => BeatKind::HiHat,
                    }
                };
                (kind, strength)
            } else {
                // Energy-onset only: the band that fired decides the kind.
                let kind = if bass_hit {
                    BeatKind::Kick
                } else if mid_hit {
                    BeatKind::Snare
                } else {
                    BeatKind::HiHat
                };
                (kind, 0.8)
            };
            vec![BeatEvent { kind, strength }]
        } else {
            Vec::new()
        };

        let agc = (AGC_TARGET / self.level_peak.max(AGC_FLOOR)).clamp(AGC_MIN, AGC_MAX);
        Bands {
            events,
            agc,
            spectrum: self.spectrum_smooth,
            peak: [0.0; SPECTRUM_BINS],
            bass: self.bass_smooth,
            mid: self.mid_smooth,
            treble: self.treble_smooth,
            level: self.level_smooth,
            beat,
            bpm: self.tempo.bpm,
            beat_phase: self.tempo.phase,
            beat_pulse: self.beat_pulse,
        }
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
        assert!(a.process(&sine(440.0, 48_000, 1000)).is_empty());
        // Feed enough for one window.
        let out = a.process(&sine(440.0, 48_000, 2048));
        assert!(!out.is_empty());
        let b = out.into_iter().next().unwrap();
        assert!(b.level > 0.0);
        assert!(b.spectrum.iter().any(|&e| e > 0.0));
    }

    #[test]
    fn hop_analysis_covers_more_audio_than_one_window() {
        // Regression: analysis must keep up with audio arrival. Feeding
        // 4 windows' worth of samples in one call must yield multiple
        // analyses, not one — otherwise transients are skipped.
        let mut a = Analyzer::new(48_000, 2048).unwrap();
        let chunk = sine(440.0, 48_000, 2048 * 4);
        let out = a.process(&chunk);
        assert!(
            out.len() >= 4,
            "expected ≥4 hop analyses for {} samples, got {}",
            chunk.len(),
            out.len()
        );
    }

    #[test]
    fn bass_bands_dominate_low_sine() {
        let mut a = Analyzer::new(48_000, 2048).unwrap();
        // Feed several windows of a 100 Hz tone; bands should settle with
        // bass > treble.
        let chunk = sine(100.0, 48_000, 4096);
        let mut last = None;
        for _ in 0..6 {
            if let Some(b) = a.process(&chunk).into_iter().last() {
                last = Some(b);
            }
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
            if let Some(b) = a.process(&vec![0.0f32; 2048]).into_iter().last() {
                last = Some(b);
            }
        }
        let b = last.unwrap();
        assert_eq!(b.level, 0.0);
        assert!(!b.beat);
        assert!(b.events.is_empty());
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
            for b in a.process(&burst) {
                if !b.events.is_empty() {
                    found = true;
                    break;
                }
            }
            if found {
                break;
            }
        }
        assert!(found, "burst after silence should produce an onset event");
    }

    #[test]
    fn tempo_tracker_locks_on_periodic_beats() {
        // Feed a 120 BPM-ish impulse train: bass sine bursts every 0.5 s.
        // With ~21 ms hops, synthesize directly at the hop level.
        let mut a = Analyzer::new(48_000, 2048).unwrap();
        let hop = a.window_samples();
        let dt = hop as f32 / 48_000.0;
        let period = 0.5f32; // 120 BPM
        let mut t = 0.0f32;
        let mut last_bpm = 0.0;
        // ~12 s of audio.
        for _ in 0..(12.0 / dt) as usize {
            let chunk: Vec<f32> = (0..hop)
                .map(|i| {
                    let st = t + i as f32 / 48_000.0;
                    let amp = if st % period < 0.05 { 0.6 } else { 0.0 };
                    amp * (2.0 * std::f32::consts::PI * 100.0 * st).sin()
                })
                .collect();
            for b in a.process(&chunk) {
                if b.bpm > 0.0 {
                    last_bpm = b.bpm;
                }
            }
            t += dt;
        }
        assert!(
            (last_bpm - 120.0).abs() < 15.0,
            "expected ~120 BPM, got {last_bpm}"
        );
    }

    #[test]
    fn fft_size_validated() {
        assert!(Analyzer::new(48_000, 1000).is_err());
        assert!(Analyzer::new(48_000, 256).is_ok());
    }
}
