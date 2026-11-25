/**
 * Music-reactive lighting for khub916 — TypeScript port of the
 * `omg-music` crate (`crates/music/src/{dsp,render}.rs`) and the cmd-8
 * GIF frame packet (`crates/proto-khub916/src/light.rs::gif_frame_packet`).
 *
 * DOM-free so `scripts/smoke.ts` can exercise it under plain Node; the
 * page glue (getUserMedia / AnalyserNode) lives in `../music.ts`.
 *
 * Wire format (live-verified, docs/research/music-reactive-feasibility.md
 * TEST-001): one feature report per frame — 7-byte prefix
 * `[8,0,0,1,0,122,1]` then up to 378 bytes of interleaved RGB
 * `[led0 R,G,B, led1 R,G,B, …]` (126 keys × 3), zero-padded to the
 * 519-byte payload, sent fire-and-forget at ~30 ms pacing.
 */

import { FEATURE_PAYLOAD_BYTES, HEADER_LEN } from './khub916.ts';

// ── cmd-8 GIF frame packet ─────────────────────────────────────────────

/** cmd 8 opcode (GIF light frames). */
export const CMD_GIF_LIGHT = 8;
/** RGB bytes per stream frame: 126 keys × 3 channels, interleaved (live-verified cmd-8 order). */
export const GIF_FRAME_BYTES = 378;
/** Key slots per frame (126 keys × RGB interleaved). */
export const KEY_SLOTS = 126;
/** Vendor command-queue pacing between feature reports. */
export const GIF_FRAME_PERIOD_MS = 30;

/**
 * The 7-byte packet prefix the vendor writes before each chunk
 * (`new Uint8Array([8,0,0,1,0,122,1])` — port of `GIF_FRAME_PREFIX`).
 */
export const GIF_FRAME_PREFIX: readonly number[] = [8, 0, 0, 0x01, 0, 0x7a, 0x01];

/**
 * Build one cmd-8 packet: [`GIF_FRAME_PREFIX`] at offset 0, up to
 * [`GIF_FRAME_BYTES`] data bytes at offset 7, zero-padded to the
 * 519-byte feature payload. Pure — no device access. Port of
 * `Khub916::gif_frame_packet`.
 */
export function gifFramePacket(data: Uint8Array): Uint8Array {
  if (data.length > GIF_FRAME_BYTES) {
    throw new Error(`khub916 gif frame needs ≤ ${GIF_FRAME_BYTES} bytes, got ${data.length}`);
  }
  const pkt = new Uint8Array(FEATURE_PAYLOAD_BYTES);
  pkt.set(GIF_FRAME_PREFIX, 0);
  pkt.set(data, HEADER_LEN);
  return pkt;
}

// ── Spectrum analysis (port of crates/music/src/dsp.rs) ────────────────
//
// The Rust analyser runs its own FFT over PCM samples; in the browser the
// Web Audio `AnalyserNode` already gives us `getByteFrequencyData`, so this
// port consumes **byte magnitudes** (0–255, one per FFT bin) instead of
// re-implementing an FFT. Band edges, log spacing, smoothing and the
// beat detector are unchanged; the magnitude→energy curve is a simplified
// perceptual curve (documented below) instead of the Rust dB normaliser.

/** Log-spaced spectrum bins mapped across the keyboard left→right. */
export const SPECTRUM_BINS = 24;
/** Band edges in Hz for the bass/mid/treble aggregates (dsp.rs). */
const BASS_MAX_HZ = 250;
const MID_MAX_HZ = 2_000;
const TREBLE_MAX_HZ = 20_000;
/** EMA smoothing factor per analysed frame (~30 fps → ~80 ms time constant). */
const SMOOTH_ALPHA = 0.35;
/** Beat: bass energy must exceed its trailing average by this ratio… */
const BEAT_RATIO = 1.35;
/** …with at least this much absolute energy, and not more often than
 *  every `BEAT_COOLDOWN` analyses. */
const BEAT_MIN_ENERGY = 0.02;
const BEAT_COOLDOWN = 8;
/** Trailing bass-energy window for the beat average (dsp.rs: 43). */
const BASS_HISTORY_LEN = 43;
/** Minimum bass history before a beat can fire (dsp.rs: 12). */
const BEAT_MIN_HISTORY = 12;

/**
 * One analysis frame: smoothed band energies (0..1), overall level and a
 * beat flag that stays hot for one frame. Same shape as `dsp::Bands`.
 */
export interface Bands {
  /** Log-spaced spectrum energies, `SPECTRUM_BINS` entries, 0..1. */
  spectrum: Float32Array;
  /** Reserved peak-cap channel (mirrors dsp.rs `peak`). */
  peak: Float32Array;
  /** Bass band (20 Hz–250 Hz) energy, 0..1. */
  bass: number;
  /** Low-mid band (250 Hz–2 kHz), 0..1. */
  mid: number;
  /** Treble band (2 kHz–20 kHz), 0..1. */
  treble: number;
  /** Broadband level, 0..1. */
  level: number;
  /** True on the frame a beat was detected. */
  beat: boolean;
}

export function silentBands(): Bands {
  return {
    spectrum: new Float32Array(SPECTRUM_BINS),
    peak: new Float32Array(SPECTRUM_BINS),
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    beat: false,
  };
}

/**
 * Byte magnitude (0–255) → energy 0..1. The Rust path normalises FFT
 * magnitudes through a −80…−20 dBFS window; `getByteFrequencyData`
 * already delivers a perceptual-ish 0–255 scale, so a gamma curve is the
 * browser equivalent: ~byte 200 → 0.7, 128 → 0.3, 64 → 0.11, ≤16 ≈ dark.
 */
function byteEnergy(byte: number): number {
  const x = Math.min(1, Math.max(0, byte / 255));
  return Math.min(1, Math.pow(x, 1.4) * 1.6);
}

function hzRange(binHz: ArrayLike<number>, loHz: number, hiHz: number): [number, number] {
  let lo = 0;
  while (lo < binHz.length && binHz[lo]! < loHz) lo++;
  let hi = lo;
  while (hi < binHz.length && binHz[hi]! < hiHz) hi++;
  if (hi <= lo) hi = Math.min(lo + 1, binHz.length);
  return [Math.min(lo, binHz.length - 1), Math.min(hi, binHz.length)];
}

/** Log-spaced band edges → bin ranges (port of `log_ranges`). */
function logRanges(binHz: ArrayLike<number>, fMin: number, fMax: number, n: number): [number, number][] {
  const ratio = Math.pow(fMax / fMin, 1 / n);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const lo = fMin * Math.pow(ratio, i);
    const hi = fMin * Math.pow(ratio, i + 1);
    out.push(hzRange(binHz, lo, hi));
  }
  return out;
}

/**
 * Stateful analyser fed with `AnalyserNode.getByteFrequencyData` output.
 * Construct with the AudioContext sample rate and the analyser's
 * `fftSize` (frequency-bin count = fftSize/2 + 1).
 */
export class MusicAnalyzer {
  private readonly spectrumRanges: [number, number][];
  private readonly bassRange: [number, number];
  private readonly midRange: [number, number];
  private readonly trebleRange: [number, number];
  private readonly spectrumSmooth = new Float32Array(SPECTRUM_BINS);
  private bassSmooth = 0;
  private midSmooth = 0;
  private trebleSmooth = 0;
  private levelSmooth = 0;
  private readonly bassHistory: number[] = [];
  private sinceBeat = BEAT_COOLDOWN;

  constructor(sampleRate: number, fftSize: number) {
    const bins = fftSize / 2 + 1;
    const binHz = new Float64Array(bins);
    for (let i = 0; i < bins; i++) binHz[i] = (i * sampleRate) / fftSize;
    this.spectrumRanges = logRanges(binHz, 30, sampleRate / 2, SPECTRUM_BINS);
    this.bassRange = hzRange(binHz, 20, BASS_MAX_HZ);
    this.midRange = hzRange(binHz, BASS_MAX_HZ, MID_MAX_HZ);
    this.trebleRange = hzRange(
      binHz,
      MID_MAX_HZ,
      Math.min(TREBLE_MAX_HZ, sampleRate / 2),
    );
  }

  /** Analyse one `getByteFrequencyData` snapshot → smoothed [`Bands`]. */
  analyze(data: Uint8Array): Bands {
    const bandEnergy = (range: [number, number]): number => {
      const [lo, hi] = range;
      if (hi <= lo) return 0;
      let sum = 0;
      for (let i = lo; i < hi && i < data.length; i++) sum += data[i] ?? 0;
      const mean = sum / Math.max(1, Math.min(hi, data.length) - lo);
      return byteEnergy(mean);
    };

    const spectrum = new Float32Array(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      spectrum[i] = bandEnergy(this.spectrumRanges[i]!);
    }
    const bass = bandEnergy(this.bassRange);
    const mid = bandEnergy(this.midRange);
    const treble = bandEnergy(this.trebleRange);

    // Broadband level: mean magnitude across all bins.
    let total = 0;
    let count = 0;
    for (let i = 0; i < data.length; i++) {
      total += data[i] ?? 0;
      count++;
    }
    const level = count ? byteEnergy(total / count) : 0;

    // Smoothing (dsp.rs SMOOTH_ALPHA).
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      this.spectrumSmooth[i] += SMOOTH_ALPHA * ((spectrum[i] ?? 0) - this.spectrumSmooth[i]!);
    }
    this.bassSmooth += SMOOTH_ALPHA * (bass - this.bassSmooth);
    this.midSmooth += SMOOTH_ALPHA * (mid - this.midSmooth);
    this.trebleSmooth += SMOOTH_ALPHA * (treble - this.trebleSmooth);
    this.levelSmooth += SMOOTH_ALPHA * (level - this.levelSmooth);

    // Beat: bass flux vs trailing average (dsp.rs).
    this.bassHistory.push(this.bassSmooth);
    if (this.bassHistory.length > BASS_HISTORY_LEN) this.bassHistory.shift();
    this.sinceBeat++;
    let beat = false;
    if (this.bassHistory.length >= BEAT_MIN_HISTORY && this.sinceBeat >= BEAT_COOLDOWN) {
      const prev = this.bassHistory.slice(0, -1);
      const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
      beat =
        this.bassSmooth > BEAT_MIN_ENERGY && avg > 1e-4 && this.bassSmooth > avg * BEAT_RATIO;
    }
    if (beat) this.sinceBeat = 0;

    return {
      spectrum: this.spectrumSmooth.slice(),
      peak: new Float32Array(SPECTRUM_BINS),
      bass: this.bassSmooth,
      mid: this.midSmooth,
      treble: this.trebleSmooth,
      level: this.levelSmooth,
      beat,
    };
  }
}

// ── Frame renderer (port of crates/music/src/render.rs SpectrumViz) ────

/** Tuning knobs for [`SpectrumViz.frame`]. All energies are 0..1. */
export interface FrameParams {
  /** Input gain applied before mapping (0.5–4.0 typical; CLI default 1.6). */
  sensitivity: number;
  /** Overall brightness scale 0..1 (CLI default 0.9). */
  brightness: number;
  /** Hue rotation speed (cycles per second, can be negative; 0.05). */
  hueSpeed: number;
  /** Saturation 0..1 (1.0). */
  saturation: number;
}

export const DEFAULT_FRAME_PARAMS: FrameParams = {
  sensitivity: 1.6,
  brightness: 0.9,
  hueSpeed: 0.05,
  saturation: 1.0,
};

/** Float HSV (h 0..1, s/v 0..1) → RGB 0..1 — port of render.rs `hsv`. */
function hsv(h: number, s: number, v: number): [number, number, number] {
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** Interpolated (energy, peak) at normalised key position `x` ∈ [0,1). */
function spectrumPair(
  spectrum: ArrayLike<number>,
  peak: ArrayLike<number>,
  x: number,
): [number, number] {
  const pos = x * SPECTRUM_BINS;
  const i = Math.min(Math.floor(pos), SPECTRUM_BINS - 2);
  const f = pos - i;
  return [
    (spectrum[i] ?? 0) * (1 - f) + (spectrum[i + 1] ?? 0) * f,
    (peak[i] ?? 0) * (1 - f) + (peak[i + 1] ?? 0) * f,
  ];
}

// ── Stateful spectrum visualizer (render.rs SpectrumViz) ───────────────
//
// Classic spectrum-analyzer motion: every band has an attack/decay
// envelope (fast attack, ~10-frame release) plus a peak cap that jumps
// instantly and falls slowly. Colour is mapped by *frequency*: bass
// (left) runs warm (red→orange), treble (right) cool (blue→violet); a
// detected beat flashes the bass third toward white.

const ATTACK = 0.55;
const DECAY = 0.86;
const PEAK_HOLD = 8;
const PEAK_FALL = 0.965;
/** Hue range across the spectrum: 0.00 (red) → 0.78 (violet). */
const HUE_LOW = 0.0;
const HUE_HIGH = 0.78;

interface BandState {
  /** Attack/decay envelope, 0..1. */
  env: number;
  /** Peak cap, 0..1 (instant up, slow fall). */
  peak: number;
  /** Frames the peak has been falling. */
  peakAge: number;
}

/**
 * Stateful renderer — call [`SpectrumViz.frame`] once per LED frame.
 * `t` = seconds since stream start (subtle hue drift only).
 */
export class SpectrumViz {
  private readonly bands: BandState[];
  private readonly params: FrameParams;
  /** Beat-flash decay (frames remaining of extra brightness). */
  private flash = 0;

  constructor(params: FrameParams = DEFAULT_FRAME_PARAMS) {
    this.params = params;
    this.bands = Array.from({ length: SPECTRUM_BINS }, () => ({
      env: 0,
      peak: 0,
      peakAge: 0,
    }));
  }

  /** Render one 378-byte interleaved frame from the latest [`Bands`]. */
  frame(bands: Bands, t: number): Uint8Array {
    // Update per-band envelopes.
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const st = this.bands[i]!;
      const target = Math.min(1, Math.max(0, (bands.spectrum[i] ?? 0) * this.params.sensitivity));
      st.env += (target > st.env ? ATTACK : DECAY) * (target - st.env);
      if (target > st.peak) {
        st.peak = target;
        st.peakAge = 0;
      } else {
        st.peakAge++;
        if (st.peakAge > PEAK_HOLD) st.peak *= PEAK_FALL;
      }
    }
    this.flash = bands.beat ? 1.0 : Math.max(0, this.flash - 0.12);

    // Build lookup channels: spectrum → envelope, peak → peak cap.
    const lookSpectrum = new Float32Array(SPECTRUM_BINS);
    const lookPeak = new Float32Array(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      lookSpectrum[i] = this.bands[i]!.env;
      lookPeak[i] = this.bands[i]!.peak;
    }

    const frame = new Uint8Array(GIF_FRAME_BYTES);
    for (let k = 0; k < KEY_SLOTS; k++) {
      const x = k / KEY_SLOTS;
      const [env, peak] = spectrumPair(lookSpectrum, lookPeak, x);
      const envelope = 0.72 + 0.28 * Math.sin(Math.PI * x);
      // Bar body = envelope; peak cap adds a bright tip on top.
      let v = (env * 0.85 + peak * 0.45) * envelope;
      v += bands.bass * 0.1; // bass pulse lifts everything slightly
      v = Math.min(1, Math.max(0, v * this.params.brightness + this.flash * 0.25 * (1 - x)));

      // Frequency-mapped hue + slow drift.
      const hue = HUE_LOW + (HUE_HIGH - HUE_LOW) * x + t * this.params.hueSpeed * 0.15;
      let [r, g, b] = v > 0.01 ? hsv(hue, this.params.saturation, v) : [0, 0, 0];
      // Beat flash tints the bass third toward white.
      if (x < 1 / 3 && this.flash > 0) {
        const f = this.flash * bands.bass;
        r = Math.max(r, f);
        g = Math.max(g, f);
        b = Math.max(b, f);
      }
      // Interleaved LED×(R,G,B) — the live-verified cmd-8 byte order
      // (planar scrambled every colour on the K1 Pro).
      frame[k * 3] = Math.min(255, Math.max(0, Math.round(r * 255)));
      frame[k * 3 + 1] = Math.min(255, Math.max(0, Math.round(g * 255)));
      frame[k * 3 + 2] = Math.min(255, Math.max(0, Math.round(b * 255)));
    }
    return frame;
  }
}
