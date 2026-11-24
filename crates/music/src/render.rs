//! Spectrum → 378-byte planar frame renderer.
//!
//! Output layout matches the cmd-6/cmd-8 convention used by
//! `kb916 light stream --file`: `[R×126][G×126][B×126]` — first 126 bytes
//! are all red values, next 126 green, last 126 blue.
//!
//! Mapping: the 24 log-spaced spectrum bins are stretched across all 126
//! keys (≈5 keys per bin, linearly interpolated). Key brightness =
//! band energy × sensitivity; hue drifts slowly with time; a detected
//! beat flashes the low-frequency (left) third white.

use crate::dsp::{Bands, BeatKind, SPECTRUM_BINS};

/// Keys per keyboard (cmd-6 slot count / cmd-8 frame size ÷ 3).
pub const KEY_SLOTS: usize = 126;
/// One cmd-8 frame payload: 126 keys × RGB planar.
pub const FRAME_BYTES: usize = KEY_SLOTS * 3;
/// Bumped when the visual mapping changes materially.
pub const RENDERER_VERSION: u32 = 2;

/// Tuning knobs for [`render_frame`]. All energies are 0..1.
#[derive(Clone, Copy, Debug)]
pub struct FrameParams {
    /// Input gain applied before mapping (0.5–4.0 typical).
    pub sensitivity: f32,
    /// Overall brightness scale 0..1.
    pub brightness: f32,
    /// Hue rotation speed (cycles per second, can be negative).
    pub hue_speed: f32,
    /// Saturation 0..1.
    pub saturation: f32,
    /// LED frame rate the motion constants are tuned for. BeatViz scales
    /// all per-frame ages by `30/fps` so effects keep the same wall-clock
    /// timing at any stream rate (default 30 = reference).
    pub fps: f32,
}

impl Default for FrameParams {
    fn default() -> Self {
        Self {
            sensitivity: 1.6,
            brightness: 0.9,
            hue_speed: 0.05,
            saturation: 1.0,
            fps: 30.0,
        }
    }
}

fn hsv(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let h = h.rem_euclid(1.0) * 6.0;
    let i = h.floor() as i32;
    let f = h - i as f32;
    let p = v * (1.0 - s);
    let q = v * (1.0 - f * s);
    let t = v * (1.0 - (1.0 - f) * s);
    match i.rem_euclid(6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

/// Interpolated spectrum energy at normalised key position `x` ∈ [0,1).
fn spectrum_at(bands: &Bands, x: f32) -> f32 {
    spectrum_pair(bands, x).0
}

/// Interpolated (energy, peak) at normalised key position `x` ∈ [0,1).
fn spectrum_pair(bands: &Bands, x: f32) -> (f32, f32) {
    let pos = x * SPECTRUM_BINS as f32;
    let i = (pos as usize).min(SPECTRUM_BINS - 2);
    let f = pos - i as f32;
    (
        bands.spectrum[i] * (1.0 - f) + bands.spectrum[i + 1] * f,
        bands.peak[i] * (1.0 - f) + bands.peak[i + 1] * f,
    )
}

// ── Stateful spectrum visualizer ───────────────────────────────────────
//
// Classic spectrum-analyzer motion: every band has an attack/decay
// envelope (fast attack, ~10-frame release) plus a peak cap that jumps
// instantly and falls slowly. Without this the LEDs just dim/brighten
// with the instantaneous FFT — no "jumping" bars.
//
// Colour is mapped by *frequency*, not key position: bass (left) runs
// warm (red→orange), treble (right) cool (blue→violet), so the keyboard
// reads as a real spectrum. A detected beat flashes the bass third.

/// Per-band envelope state.
#[derive(Clone)]
struct BandState {
    /// Attack/decay envelope, 0..1.
    env: f32,
    /// Peak cap, 0..1 (instant up, slow fall).
    peak: f32,
    /// Frames the peak has been falling.
    peak_age: u16,
}

const ATTACK: f32 = 0.55;
const DECAY: f32 = 0.86;
const PEAK_HOLD: u16 = 8;
const PEAK_FALL: f32 = 0.965;
/// Hue range across the spectrum: 0.00 (red) → 0.78 (violet).
const HUE_LOW: f32 = 0.00;
const HUE_HIGH: f32 = 0.78;

/// Stateful renderer — call [`SpectrumViz::frame`] once per LED frame.
pub struct SpectrumViz {
    bands: Vec<BandState>,
    params: FrameParams,
    /// Beat-flash decay (frames remaining of extra brightness).
    flash: f32,
    /// Normalised horizontal position per key slot (default: linear).
    pos_x: Vec<f32>,
}

impl SpectrumViz {
    pub fn new(params: FrameParams) -> Self {
        Self {
            bands: vec![
                BandState {
                    env: 0.0,
                    peak: 0.0,
                    peak_age: 0,
                };
                SPECTRUM_BINS
            ],
            params,
            flash: 0.0,
            pos_x: (0..KEY_SLOTS)
                .map(|k| k as f32 / KEY_SLOTS as f32)
                .collect(),
        }
    }

    /// Override the slot→horizontal-position map (e.g. from the device
    /// keymap). Shorter slices leave the tail linear.
    pub fn set_positions(&mut self, pos_x: &[f32]) {
        for (k, &x) in pos_x.iter().enumerate().take(KEY_SLOTS) {
            self.pos_x[k] = x.clamp(0.0, 1.0);
        }
    }

    /// Render one frame from the latest [`Bands`]. `t` = seconds since
    /// start (subtle hue drift only — motion comes from the envelopes).
    pub fn frame(&mut self, bands: &Bands, t: f32) -> [u8; FRAME_BYTES] {
        // Update per-band envelopes.
        for (i, st) in self.bands.iter_mut().enumerate() {
            let target =
                (bands.spectrum[i] * self.params.sensitivity * bands.agc).clamp(0.0, 1.0);
            st.env += if target > st.env { ATTACK } else { DECAY } * (target - st.env);
            if target > st.peak {
                st.peak = target;
                st.peak_age = 0;
            } else {
                st.peak_age += 1;
                if st.peak_age > PEAK_HOLD {
                    st.peak *= PEAK_FALL;
                }
            }
        }
        self.flash = if bands.beat {
            1.0
        } else {
            (self.flash - 0.12).max(0.0)
        };

        // Reuse the Bands struct's peak channel for interpolated lookup.
        let mut look = Bands {
            peak: [0.0; SPECTRUM_BINS],
            ..bands.clone()
        };
        for (i, st) in self.bands.iter().enumerate() {
            look.peak[i] = st.peak;
        }
        // spectrum channel carries the envelope now.
        for (i, st) in self.bands.iter().enumerate() {
            look.spectrum[i] = st.env;
        }

        let mut frame = [0u8; FRAME_BYTES];
        for k in 0..KEY_SLOTS {
            let x = self.pos_x[k];
            let (env, peak) = spectrum_pair(&look, x);
            let envelope = 0.72 + 0.28 * (std::f32::consts::PI * x).sin();
            // Bar body = envelope; peak cap adds a bright tip on top.
            let mut v = (env * 0.85 + peak * 0.45) * envelope;
            // Contrast curve: quiet bands drop toward black instead of
            // hovering at a uniform dim glow — this is what makes some
            // keys dark while others carry the spectrum.
            v = v.powf(1.6);
            v += bands.bass * 0.10; // bass pulse lifts everything slightly
            v = (v * self.params.brightness + self.flash * 0.25 * (1.0 - x)).clamp(0.0, 1.0);

            // Frequency-mapped hue + slow drift.
            let hue = HUE_LOW + (HUE_HIGH - HUE_LOW) * x + t * self.params.hue_speed * 0.15;
            let (mut r, mut g, mut b) = if v > 0.01 {
                hsv(hue, self.params.saturation, v)
            } else {
                (0.0, 0.0, 0.0)
            };
            // Beat flash tints the bass third toward white.
            if x < 1.0 / 3.0 && self.flash > 0.0 {
                let f = self.flash * bands.bass;
                r = r.max(f);
                g = g.max(f);
                b = b.max(f);
            }
            frame[k] = (r * 255.0).round().clamp(0.0, 255.0) as u8;
            frame[KEY_SLOTS + k] = (g * 255.0).round().clamp(0.0, 255.0) as u8;
            frame[2 * KEY_SLOTS + k] = (b * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        frame
    }
}

// ── Beat Motion Engine ─────────────────────────────────────────────────
//
// Event-driven animation: each detected onset spawns an `Impact` that
// evolves over ~0.5–1 s independently of the audio frame rate. Kick →
// radial ring from centre, snare → horizontal sweep (alternating
// direction), hi-hat → sparse key sparks, generic → small radial bloom.
// A dim spectrum visualiser runs underneath as ambient base light.
// Ages are in rendered frames (~30 fps); all motion is frame-count
// based so it does not depend on wall-clock jitter.

/// Normalised key position: x left→right, y top→bottom, both 0..1.
pub type KeyPos = (f32, f32);

struct Impact {
    kind: BeatKind,
    strength: f32,
    ox: f32,
    oy: f32,
    /// Snare sweep direction (+1 left→right, −1 right→left).
    dir: f32,
    /// Frame counter value when the impact was spawned.
    born: u32,
    /// Per-impact seed for spark hashing.
    seq: u32,
}

/// How long each impact kind stays alive, in frames.
fn impact_ttl(kind: BeatKind) -> u32 {
    match kind {
        BeatKind::Kick => 55,
        BeatKind::Snare => 40,
        BeatKind::HiHat => 8,
        BeatKind::Generic => 25,
    }
}

/// Hard cap on concurrent impacts (Hypercolor MAX_WAVES) — guards against
/// runaway onset detection stacking rings every refractory interval.
const MAX_IMPACTS: usize = 12;

/// Stateful beat-motion renderer — call [`BeatViz::frame`] per LED frame.
pub struct BeatViz {
    params: FrameParams,
    /// Dim ambient spectrum base.
    spec: SpectrumViz,
    /// Normalised position per key slot.
    pos: Vec<KeyPos>,
    impacts: Vec<Impact>,
    frame_no: u32,
    wave_dir: f32,
    seq: u32,
}

impl BeatViz {
    pub fn new(params: FrameParams) -> Self {
        // Keep the ambient spectrum very dim — the point of this
        // visualiser is that onsets/impacts are the bright signal.
        let ambient = FrameParams {
            brightness: params.brightness * 0.12,
            ..params
        };
        Self {
            params,
            spec: SpectrumViz::new(ambient),
            pos: (0..KEY_SLOTS)
                .map(|k| (k as f32 / KEY_SLOTS as f32, 0.5))
                .collect(),
            impacts: Vec::new(),
            frame_no: 0,
            wave_dir: 1.0,
            seq: 0,
        }
    }

    /// Set real key geometry (normalised). Shorter slices keep the
    /// linear default for the tail.
    pub fn set_positions(&mut self, pos: &[KeyPos]) {
        for (k, &p) in pos.iter().enumerate().take(KEY_SLOTS) {
            self.pos[k] = (p.0.clamp(0.0, 1.0), p.1.clamp(0.0, 1.0));
        }
        let xs: Vec<f32> = pos.iter().map(|p| p.0).collect();
        self.spec.set_positions(&xs);
    }

    /// Render one frame. `bands.events` are consumed into impacts.
    pub fn frame(&mut self, bands: &Bands, t: f32) -> [u8; FRAME_BYTES] {
        self.frame_no = self.frame_no.wrapping_add(1);
        for ev in &bands.events {
            self.seq = self.seq.wrapping_add(1);
            let (ox, oy, dir) = match ev.kind {
                BeatKind::Kick => (0.5, 0.45, 1.0),
                BeatKind::Snare => {
                    self.wave_dir = -self.wave_dir;
                    (
                        if self.wave_dir > 0.0 { -0.1 } else { 1.1 },
                        0.5,
                        self.wave_dir,
                    )
                }
                BeatKind::HiHat => (0.0, 0.0, 1.0),
                BeatKind::Generic => {
                    let h = hash01(self.seq);
                    (0.25 + 0.5 * h, 0.3 + 0.4 * hash01(self.seq ^ 0x9E37), 1.0)
                }
            };
            self.impacts.push(Impact {
                kind: ev.kind,
                strength: ev.strength,
                ox,
                oy,
                dir,
                born: self.frame_no,
                seq: self.seq,
            });
        }
        // Scale rendered-frame ages into 30 fps reference units so motion
        // speed and impact TTLs are wall-clock stable at any --fps.
        let age_scale = (30.0 / self.params.fps.clamp(1.0, 240.0)).clamp(0.125, 8.0);
        self.impacts
            .retain(|i| self.frame_no.wrapping_sub(i.born) as f32 * age_scale
                < impact_ttl(i.kind) as f32);
        if self.impacts.len() > MAX_IMPACTS {
            let excess = self.impacts.len() - MAX_IMPACTS;
            self.impacts.drain(..excess);
        }

        // Ambient base from the spectrum visualiser, gated by the
        // broadband level: quiet music → near-black keyboard so beats
        // and onsets read clearly instead of drowning in base light.
        let base = self.spec.frame(bands, t);
        let gate = (bands.level * 1.8).clamp(0.0, 1.0);
        let mut out = [0u8; FRAME_BYTES];
        for k in 0..KEY_SLOTS {
            let (x, y) = self.pos[k];
            let mut add = [0.0f32; 3];
            for im in &self.impacts {
                let age = self.frame_no.wrapping_sub(im.born) as f32 * age_scale;
                let s = (im.strength * self.params.brightness * 1.8).min(1.0);
                let (r, g, b) = match im.kind {
                    BeatKind::Kick => {
                        let d = ((x - im.ox).powi(2) + (y - im.oy).powi(2)).sqrt();
                        let radius = 0.035 * age;
                        // Stronger kicks throw a wider ring — beat energy
                        // drives ring *width*, not a flat brightness add
                        // (Hypercolor audio_pulse lesson: flat adds read
                        // as strobing on LED hardware).
                        let sigma = 0.07 * (1.0 + im.strength * 0.6);
                        let ring = (-((d - radius).powi(2)) / (2.0 * sigma * sigma)).exp();
                        // Bright core at the impact point on the first
                        // ~0.2 s — the ring alone leaves the centre dark.
                        let core = (-d / 0.10).exp() * (-age / 6.0).exp();
                        let env = (-age / 24.0).exp();
                        // Rings dim as they spread (Hypercolor age_fade).
                        let spread_fade = (1.0 - radius * 0.5).clamp(0.0, 1.0);
                        let i = (s * (ring * spread_fade + core * 0.8) * env).min(1.0);
                        (i, i * 0.72, i * 0.30)
                    }
                    BeatKind::Snare => {
                        let p = im.dir * (0.045 * age - 0.15);
                        let band = (-((x - p).powi(2)) / (2.0 * 0.05f32.powi(2))).exp();
                        let wake = ((p - x) * im.dir).max(0.0);
                        let trail = (-wake / 0.28).exp() * 0.35;
                        let env = (-age / 18.0).exp();
                        let i = (s * (band + trail) * env).min(1.0);
                        (i * 0.35, i * 0.75, i)
                    }
                    BeatKind::HiHat => {
                        // ~25% of keys spark per hat, brief and dim.
                        let h = hash01(k as u32 ^ im.seq.wrapping_mul(0x85EBCA6B));
                        if h > 0.25 {
                            continue;
                        }
                        let i = s * (-age / 4.0).exp() * (0.4 + 0.6 * h);
                        (i * 0.75, i * 0.45, i)
                    }
                    BeatKind::Generic => {
                        let d = ((x - im.ox).powi(2) + (y - im.oy).powi(2)).sqrt();
                        let i =
                            (s * (-d / 0.14).exp() * (-age / 12.0).exp()).min(1.0);
                        (i, i * 0.9, i * 0.7)
                    }
                };
                add[0] += r;
                add[1] += g;
                add[2] += b;
            }
            // Tempo-locked bounce: once the tracker locks a BPM, a warm
            // crest travels left→right once per beat interval — the
            // "keys bounce on the beat" layer under the onset impacts.
            // Per-key x-delay makes the crest sweep the board; gated by
            // level so silence stays dark.
            if bands.bpm > 1.0 {
                let phase_x = (bands.beat_phase - x * 0.15).rem_euclid(1.0);
                let env = (1.0 - phase_x) * (1.0 - phase_x);
                let bounce = env * gate * 0.22 * self.params.brightness;
                add[0] += bounce;
                add[1] += bounce * 0.72;
                add[2] += bounce * 0.40;
            }
            // Bass wash: continuous warm presence so the whole field
            // breathes with the low end between onset impacts.
            let wash = bands.bass * bands.agc.min(2.0) * 0.08 * self.params.brightness;
            add[0] += wash;
            add[1] += wash * 0.55;
            add[2] += wash * 0.25;
            for c in 0..3 {
                // Beat thump: the whole field lifts ~60% for ~200 ms on
                // each detected beat — the "keyboard punches" layer.
                let thump = 1.0 + bands.beat_pulse * 0.4;
                let base_v = base[c * KEY_SLOTS + k] as f32 / 255.0 * gate * thump;
                let v = (base_v + add[c]).clamp(0.0, 1.0);
                out[c * KEY_SLOTS + k] = (v * 255.0).round() as u8;
            }
        }
        out
    }
}

/// Deterministic 0..1 hash for spark selection / pseudo-random origins.
fn hash01(n: u32) -> f32 {
    let mut x = n.wrapping_mul(0x9E3779B1);
    x ^= x >> 16;
    x = x.wrapping_mul(0x85EBCA6B);
    x ^= x >> 13;
    (x & 0xFFFF) as f32 / 65535.0
}

/// Render one frame. `t` is seconds since stream start (drives hue drift).
pub fn render_frame(bands: &Bands, t: f32, params: &FrameParams) -> [u8; FRAME_BYTES] {
    let mut frame = [0u8; FRAME_BYTES];
    let gain = params.sensitivity * bands.agc;
    let beat_flash = if bands.beat { 0.6 } else { 0.0 };
    for k in 0..KEY_SLOTS {
        let x = k as f32 / KEY_SLOTS as f32;
        // Gentle falloff toward the edges keeps the frame centred.
        let envelope = 0.75 + 0.25 * (std::f32::consts::PI * x).sin();
        let mut energy = spectrum_at(bands, x) * gain * envelope;
        // Bass pulse lifts the whole field slightly.
        energy += bands.bass * 0.15;
        // Gamma < 1 lifts mid-level energy so the field reads "lit" not
        // just on transients (powf(0.75) ≈ +30% at e=0.3).
        energy = energy.clamp(0.0, 1.0).powf(0.75) * params.brightness;

        // Low third flashes on beat.
        let mut r = 0.0f32;
        let mut g = 0.0f32;
        let mut b = 0.0f32;
        if energy > 0.01 {
            let hue = x * 0.8 + t * params.hue_speed;
            (r, g, b) = hsv(hue, params.saturation, energy);
            if x < 1.0 / 3.0 {
                let flash = beat_flash * bands.bass;
                r = r.max(flash);
                g = g.max(flash);
                b = b.max(flash);
            }
        }
        frame[k] = (r * 255.0).round().clamp(0.0, 255.0) as u8;
        frame[KEY_SLOTS + k] = (g * 255.0).round().clamp(0.0, 255.0) as u8;
        frame[2 * KEY_SLOTS + k] = (b * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::Bands;

    fn loud_bands() -> Bands {
        Bands {
            spectrum: [0.8; SPECTRUM_BINS],
            bass: 0.9,
            mid: 0.7,
            treble: 0.5,
            level: 0.8,
            beat: true,
            ..Bands::default()
        }
    }

    #[test]
    fn frame_size_and_planar_layout() {
        let f = render_frame(&Bands::default(), 0.0, &FrameParams::default());
        assert_eq!(f.len(), FRAME_BYTES);
        assert!(f.iter().all(|&b| b == 0));
        let loud = render_frame(&loud_bands(), 0.0, &FrameParams::default());
        // Red plane (0..126) must differ from green plane — planar, not
        // interleaved: byte k and byte 126+k are different channels.
        assert_ne!(&loud[0..126], &loud[126..252]);
        assert_ne!(&loud[126..252], &loud[252..378]);
    }

    #[test]
    fn silence_renders_black() {
        let f = render_frame(&Bands::default(), 1.0, &FrameParams::default());
        assert!(f.iter().all(|&b| b == 0));
    }

    #[test]
    fn loud_signal_lights_keys() {
        let f = render_frame(&loud_bands(), 0.0, &FrameParams::default());
        assert!(f[..126].iter().any(|&b| b > 0));
        assert!(f[252..].iter().any(|&b| b > 0));
    }

    #[test]
    fn spectrum_position_maps_across_keys() {
        // Energy only in the lowest bin → leftmost keys bright, right dim.
        let mut b = Bands::default();
        b.spectrum[0] = 1.0;
        let f = render_frame(&b, 0.0, &FrameParams::default());
        let left: u32 = f[..20].iter().map(|&v| v as u32).sum();
        let right: u32 = f[226..246].iter().map(|&v| v as u32).sum();
        assert!(left > right, "left {left} should exceed right {right}");
    }

    #[test]
    fn viz_bars_attack_then_peak_falls() {
        let mut viz = SpectrumViz::new(FrameParams::default());
        let mut b = Bands::default();
        b.spectrum[0] = 1.0; // bass-only energy
        // First frame: envelope still ramping (attack < 1), but nonzero.
        let f1 = viz.frame(&b, 0.0);
        let f2 = viz.frame(&b, 0.03);
        let energy = |f: &[u8; FRAME_BYTES]| f[..30].iter().map(|&v| v as u32).sum::<u32>();
        assert!(energy(&f2) > energy(&f1), "attack should brighten");
        // Silence → envelope decays but peak cap holds briefly, so the
        // field stays lit longer than the raw signal would suggest.
        let quiet = Bands::default();
        let mut last = f2;
        for i in 0..12 {
            last = viz.frame(&quiet, 0.1 + i as f32 * 0.03);
        }
        assert!(energy(&last) > 0, "peak cap should hold after silence");
    }

    #[test]
    fn beat_kick_ignites_then_fades() {
        use crate::dsp::BeatEvent;
        let mut v = BeatViz::new(FrameParams::default());
        let mut b = Bands::default();
        b.events = vec![BeatEvent {
            kind: BeatKind::Kick,
            strength: 1.0,
        }];
        let lit = v.frame(&b, 0.0);
        assert!(lit.iter().any(|&x| x > 0), "kick should light keys");
        // After the impact TTL the field returns to black on silence.
        let quiet = Bands::default();
        let mut last = [0u8; FRAME_BYTES];
        for i in 0..70 {
            last = v.frame(&quiet, i as f32 * 0.03);
        }
        assert!(last.iter().all(|&x| x == 0), "impact should fully decay");
    }

    #[test]
    fn sensitivity_scales_output() {
        let quiet = Bands {
            spectrum: [0.1; SPECTRUM_BINS],
            ..Bands::default()
        };
        let dim = render_frame(&quiet, 0.0, &FrameParams { sensitivity: 0.5, ..Default::default() });
        let hot = render_frame(&quiet, 0.0, &FrameParams { sensitivity: 3.0, ..Default::default() });
        let sum = |f: &[u8; FRAME_BYTES]| f.iter().map(|&v| v as u32).sum::<u32>();
        assert!(sum(&hot) > sum(&dim));
    }
}
