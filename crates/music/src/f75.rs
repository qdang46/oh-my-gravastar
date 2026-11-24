//! Vendor-faithful F75 music engine — Rust port of
//! `raghavt20/aula-f75-macos` (`Core.swift` + `Effects.swift`, MIT),
//! which itself mirrors the vendor `OemDrv.exe` behaviour.
//!
//! Differences from the legacy [`crate::render`] pipeline:
//!
//! - **Interleaved frames**: 378 bytes = 126 LED slots × `(R,G,B)` at
//!   `led*3`, only the 80 real keys are written (spec §3/§4,
//!   `led = column*6 + row`).
//! - **Vendor key geometry**: the F75 `KB.ini` table below gives every
//!   key an `x` (pixels, for ripples) and `u` (0…1, for spectrum/rain).
//! - **Vendor layers**: spectrum bars, beat ripple, bass pulse and
//!   falling rain — additive, per-layer level, no ambient base layer,
//!   so frames are genuinely dark between events.
//! - **Vendor beat rule**: bass energy above `max(0.12, bassAvg*1.35)`,
//!   rising, ≥160 ms refractory — recomputed here on top of our
//!   analyser's `bass` channel (OR'd with `Bands::beat` so flux-only
//!   onsets still count).
//!
//! Our [`crate::dsp::Bands`] supplies already-normalised 0..1 energies;
//! the vendor pipeline normalises raw dB bands itself. The mapping is
//! approximate (16 vendor bands ← 24 of ours, resampled) but keeps the
//! same roles: `spectrum`→bars, `bass`→pulse/rain/beat, `treble`→rain.

use crate::dsp::{Bands, SPECTRUM_BINS};

/// Vendor band count (`Engine.bandCount` in App.swift).
const VBANDS: usize = 16;

// ── Key geometry (F75 KB.ini: name, x-left, x-right, led index) ────────

/// One physical key: `x` in KB.ini pixels, `led = col*6+row`.
#[derive(Clone, Copy, Debug)]
pub struct F75Key {
    pub name: &'static str,
    pub x0: f32,
    pub x1: f32,
    pub led: u8,
}

impl F75Key {
    /// Horizontal centre in KB.ini pixels (ripple math).
    pub fn x(&self) -> f32 {
        (self.x0 + self.x1) * 0.5
    }
    /// Vertical centre in KB.ini pixels (`row = led % 6`, row 0 = F row).
    pub fn y(&self) -> f32 {
        43.5 + (self.led % 6) as f32 * 39.0
    }
    /// 0…1 across the board (spectrum band pick, rain column match).
    pub fn u(&self) -> f32 {
        (self.x() - 30.0) / 600.0
    }
    /// 0…5, F-key row = 0.
    pub fn row(&self) -> usize {
        (self.led % 6) as usize
    }
}

/// The 80 F75 keys, verbatim from the vendor layout table.
pub const F75_KEYS: [F75Key; 80] = [
    k("Esc", 30, 55, 0), k("F1", 107, 132, 12), k("F2", 144, 169, 18),
    k("F3", 183, 208, 24), k("F4", 222, 247, 30), k("F5", 269, 294, 36),
    k("F6", 305, 330, 42), k("F7", 343, 368, 48), k("F8", 388, 413, 54),
    k("F9", 439, 464, 60), k("F10", 477, 502, 66), k("F11", 516, 541, 72),
    k("F12", 555, 580, 78),
    k("`", 31, 56, 1), k("1", 70, 95, 7), k("2", 108, 133, 13),
    k("3", 147, 172, 19), k("4", 184, 209, 25), k("5", 223, 248, 31),
    k("6", 262, 287, 37), k("7", 300, 325, 43), k("8", 338, 363, 49),
    k("9", 377, 402, 55), k("0", 416, 441, 61), k("-", 453, 478, 67),
    k("=", 491, 516, 73), k("Backspace", 531, 591, 79), k("Delete", 604, 629, 85),
    k("Tab", 34, 78, 2), k("Q", 89, 114, 8), k("W", 127, 152, 14),
    k("E", 165, 190, 20), k("R", 204, 229, 26), k("T", 242, 267, 32),
    k("Y", 280, 305, 38), k("U", 318, 343, 44), k("I", 356, 381, 50),
    k("O", 395, 420, 56), k("P", 433, 458, 62), k("[", 471, 496, 68),
    k("]", 509, 534, 74), k("\\", 549, 593, 80), k("PgUp", 605, 630, 86),
    k("CapsLock", 33, 85, 3), k("A", 98, 123, 9), k("S", 136, 161, 15),
    k("D", 174, 199, 21), k("F", 213, 238, 27), k("G", 252, 277, 33),
    k("H", 290, 315, 39), k("J", 327, 352, 45), k("K", 366, 391, 51),
    k("L", 405, 430, 57), k(";", 443, 468, 63), k("'", 481, 506, 69),
    k("Enter", 521, 591, 81), k("PgDn", 604, 629, 87),
    k("LShift", 33, 105, 4), k("Z", 116, 141, 10), k("X", 155, 180, 16),
    k("C", 193, 218, 22), k("V", 232, 257, 28), k("B", 270, 295, 34),
    k("N", 309, 334, 40), k("M", 347, 372, 46), k(",", 384, 409, 52),
    k(".", 424, 449, 58), k("/", 463, 488, 64), k("RShift", 502, 558, 70),
    k("Up", 567, 592, 82), k("End", 605, 630, 88),
    k("LCtrl", 34, 69, 5), k("LWin", 79, 114, 11), k("LAlt", 122, 157, 17),
    k("Space", 174, 400, 35), k("FN", 414, 449, 53), k("RCtrl", 463, 497, 59),
    k("Left", 529, 554, 77), k("Down", 568, 593, 83), k("Right", 605, 630, 89),
];

const fn k(name: &'static str, x0: i32, x1: i32, led: u8) -> F75Key {
    F75Key { name, x0: x0 as f32, x1: x1 as f32, led }
}

// ── Colour ─────────────────────────────────────────────────────────────

/// Vendor `RGB` — linear 0..1 channels, additive blending.
#[derive(Clone, Copy, Debug, Default)]
pub struct Rgb {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl Rgb {
    pub const BLACK: Rgb = Rgb { r: 0.0, g: 0.0, b: 0.0 };
    fn add(self, o: Rgb) -> Rgb {
        Rgb { r: self.r + o.r, g: self.g + o.g, b: self.b + o.b }
    }
    fn scale(self, k: f32) -> Rgb {
        Rgb { r: self.r * k, g: self.g * k, b: self.b * k }
    }
    fn clamp(self) -> Rgb {
        Rgb {
            r: self.r.clamp(0.0, 1.0),
            g: self.g.clamp(0.0, 1.0),
            b: self.b.clamp(0.0, 1.0),
        }
    }
}

/// Vendor `hsv` — h wraps 0..1, s/v 0..1.
fn hsv(h: f32, s: f32, v: f32) -> Rgb {
    let hh = h.rem_euclid(1.0);
    let i = (hh * 6.0) as i32 % 6;
    let f = hh * 6.0 - (hh * 6.0).floor();
    let p = v * (1.0 - s);
    let q = v * (1.0 - f * s);
    let t = v * (1.0 - (1.0 - f) * s);
    match i {
        0 => Rgb { r: v, g: t, b: p },
        1 => Rgb { r: q, g: v, b: p },
        2 => Rgb { r: p, g: v, b: t },
        3 => Rgb { r: p, g: q, b: v },
        4 => Rgb { r: t, g: p, b: v },
        _ => Rgb { r: v, g: p, b: q },
    }
}

fn gradient(x: f32, stops: &[Rgb]) -> Rgb {
    let n = stops.len() as f32;
    let p = x * n;
    let i = (p.floor() as usize) % stops.len();
    let f = p - p.floor();
    let (a, b) = (stops[i], stops[(i + 1) % stops.len()]);
    Rgb {
        r: a.r + (b.r - a.r) * f,
        g: a.g + (b.g - a.g) * f,
        b: a.b + (b.b - a.b) * f,
    }
}

/// Vendor `Palette` — six presets + mono.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Palette {
    Rainbow,
    Heat,
    Ocean,
    Sunset,
    Neon,
    Mono,
}

impl Palette {
    /// `t` wraps 0..1; `mono` is the single-colour override.
    pub fn color(&self, t: f32, mono: Rgb) -> Rgb {
        let x = t.rem_euclid(1.0);
        match self {
            Palette::Rainbow => hsv(x, 1.0, 1.0),
            Palette::Heat => gradient(x, &[
                Rgb { r: 0.0, g: 1.0, b: 0.0 },
                Rgb { r: 1.0, g: 1.0, b: 0.0 },
                Rgb { r: 1.0, g: 0.3, b: 0.0 },
                Rgb { r: 1.0, g: 0.0, b: 0.0 },
            ]),
            Palette::Ocean => gradient(x, &[
                Rgb { r: 0.0, g: 0.2, b: 1.0 },
                Rgb { r: 0.0, g: 0.8, b: 1.0 },
                Rgb { r: 0.0, g: 1.0, b: 0.6 },
                Rgb { r: 0.3, g: 0.3, b: 1.0 },
            ]),
            Palette::Sunset => gradient(x, &[
                Rgb { r: 1.0, g: 0.1, b: 0.3 },
                Rgb { r: 1.0, g: 0.5, b: 0.0 },
                Rgb { r: 1.0, g: 0.85, b: 0.2 },
                Rgb { r: 0.6, g: 0.0, b: 1.0 },
            ]),
            Palette::Neon => gradient(x, &[
                Rgb { r: 1.0, g: 0.0, b: 1.0 },
                Rgb { r: 0.0, g: 1.0, b: 1.0 },
                Rgb { r: 0.5, g: 1.0, b: 0.0 },
                Rgb { r: 1.0, g: 0.0, b: 0.5 },
            ]),
            Palette::Mono => mono,
        }
    }
}

// ── Layers ─────────────────────────────────────────────────────────────

/// Vendor `LayerKind` — all nine effects (typing ripple needs a key
/// watcher we don't have; skipped).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VendorLayer {
    Solid,
    Breathing,
    Wave,
    Starry,
    Spectrum,
    Ripple,
    Pulse,
    Rain,
}

impl VendorLayer {
    /// Vendor `defaultLevel`.
    pub fn default_level(&self) -> f32 {
        match self {
            VendorLayer::Solid => 0.35,
            VendorLayer::Breathing | VendorLayer::Wave => 0.45,
            VendorLayer::Starry => 0.6,
            _ => 1.0,
        }
    }
    pub fn musical(&self) -> bool {
        matches!(self, VendorLayer::Spectrum | VendorLayer::Ripple | VendorLayer::Pulse | VendorLayer::Rain)
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "solid" => Self::Solid,
            "breathing" => Self::Breathing,
            "wave" => Self::Wave,
            "starry" => Self::Starry,
            "spectrum" => Self::Spectrum,
            "ripple" => Self::Ripple,
            "pulse" => Self::Pulse,
            "rain" => Self::Rain,
            _ => return None,
        })
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Solid => "solid",
            Self::Breathing => "breathing",
            Self::Wave => "wave",
            Self::Starry => "starry",
            Self::Spectrum => "spectrum",
            Self::Ripple => "ripple",
            Self::Pulse => "pulse",
            Self::Rain => "rain",
        }
    }
}

/// Per-frame feature view — vendor `Features`, fed from our [`Bands`].
/// `mid`/`presses` mirror the vendor struct; no current layer reads them.
#[allow(dead_code)]
struct Feat<'a> {
    /// 16 log-ish bands resampled from our 24-bin spectrum (0..1).
    bands: [f32; VBANDS],
    bass: f32,
    mid: f32,
    treble: f32,
    level: f32,
    beat: bool,
    t: f32,
    dt: f32,
    presses: &'a [usize],
}

fn make_feat<'a>(b: &'a Bands, t: f32, dt: f32, presses: &'a [usize]) -> Feat<'a> {
    // Resample 24 → 16 by averaging proportional ranges.
    let mut bands = [0.0f32; VBANDS];
    for (i, slot) in bands.iter_mut().enumerate() {
        let lo = i * SPECTRUM_BINS / VBANDS;
        let hi = ((i + 1) * SPECTRUM_BINS / VBANDS).max(lo + 1).min(SPECTRUM_BINS);
        *slot = b.spectrum[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
    }
    Feat {
        bands,
        bass: b.bass,
        mid: b.mid,
        treble: b.treble,
        level: b.level,
        beat: b.beat,
        t,
        dt,
        presses,
    }
}

// ── Layer states ──────────────────────────────────────────────────────

struct Ring {
    x: f32,
    y: f32,
    born: f32,
    color: Rgb,
}

struct Drop {
    col: f32,
    y: f32,
    color: Rgb,
}

/// Small deterministic RNG (xorshift64*) — vendor uses `Double.random`;
/// we keep a seedable stream so tests are reproducible.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }
}

/// The vendor mixer: layer set + shared state + palette/speed/hue.
pub struct VendorEngine {
    /// Enabled layers with per-layer brightness overrides.
    pub layers: Vec<(VendorLayer, Option<f32>)>,
    pub palette: Palette,
    /// 0.25…3, vendor `speed`.
    pub speed: f32,
    /// Mono colour for `Palette::Mono`.
    pub mono: Rgb,
    /// Master brightness 0..1 (vendor `brightness`).
    pub brightness: f32,
    /// Slowly drifting palette offset (`hue += 0.0015*speed` per frame).
    hue: f32,
    t: f32,
    // RippleLayer state
    rings: Vec<Ring>,
    // RainLayer state
    drops: Vec<Drop>,
    treble_avg: f32,
    // StarryLayer state
    stars: Vec<f32>,
    star_colors: Vec<Rgb>,
    // PulseLayer state
    pulse_env: f32,
    // WaveLayer phase accumulator
    wave_phase: f32,
    // Vendor beat detector state (bassNow/bassAvg/prevBass/lastBeat)
    bass_avg: f32,
    prev_bass: f32,
    last_beat_t: f32,
    rng: Rng,
}

impl Default for VendorEngine {
    fn default() -> Self {
        Self {
            layers: vec![(VendorLayer::Pulse, None), (VendorLayer::Ripple, None)],
            palette: Palette::Sunset,
            speed: 1.0,
            mono: Rgb { r: 1.0, g: 1.0, b: 1.0 },
            brightness: 1.0,
            hue: 0.0,
            t: 0.0,
            rings: Vec::new(),
            drops: Vec::new(),
            treble_avg: 0.0,
            stars: vec![0.0; F75_KEYS.len()],
            star_colors: vec![Rgb::BLACK; F75_KEYS.len()],
            pulse_env: 0.0,
            wave_phase: 0.0,
            bass_avg: 0.0,
            prev_bass: 0.0,
            last_beat_t: -1.0,
            rng: Rng(0x9E3779B97F4A7C15),
        }
    }
}

impl VendorEngine {
    /// Render one frame → 378-byte **interleaved** LED frame
    /// (`led*3` RGB; unused slots stay 0). `dt` = seconds since the
    /// previous frame (vendor ticks at 20 ms).
    pub fn frame(&mut self, bands: &Bands, dt: f32, presses: &[usize]) -> [u8; 378] {
        self.t += dt;
        self.hue = (self.hue + 0.0015 * self.speed).rem_euclid(1.0);
        let mut f = make_feat(bands, self.t, dt, presses);
        // Vendor beat rule on our bass channel, OR'd with the dsp beat
        // flag so flux onsets without a bass spike still trigger ripples.
        let bass_now = f.bass;
        self.bass_avg = self.bass_avg * 0.95 + bass_now * 0.05;
        let vendor_beat = bass_now > (0.12f32).max(self.bass_avg * 1.35)
            && bass_now > self.prev_bass
            && self.t - self.last_beat_t > 0.16;
        self.prev_bass = bass_now;
        if vendor_beat {
            self.last_beat_t = self.t;
        }
        f.beat = vendor_beat || f.beat;

        // Mixer: each layer renders into a scratch buffer, scaled by
        // its level (default = vendor defaultLevel), summed, clamped.
        let mut out = [Rgb::BLACK; F75_KEYS.len()];
        for &(kind, level) in self.layers.clone().iter() {
            let mut layer = [Rgb::BLACK; F75_KEYS.len()];
            self.render_layer(kind, &f, &mut layer);
            let k = level.unwrap_or_else(|| kind.default_level());
            for (o, l) in out.iter_mut().zip(layer.iter()) {
                *o = o.add(l.clamp().scale(k));
            }
        }

        let mut frame = [0u8; 378];
        for (i, key) in F75_KEYS.iter().enumerate() {
            let c = out[i].clamp().scale(self.brightness);
            let base = key.led as usize * 3;
            frame[base] = (c.r * 255.0) as u8;
            frame[base + 1] = (c.g * 255.0) as u8;
            frame[base + 2] = (c.b * 255.0) as u8;
        }
        frame
    }

    fn ctx(&self) -> (f32, Rgb) {
        (self.hue, self.mono)
    }

    fn render_layer(&mut self, kind: VendorLayer, f: &Feat, out: &mut [Rgb; F75_KEYS.len()]) {
        let (hue, mono) = self.ctx();
        let pal = self.palette;
        match kind {
            VendorLayer::Solid => {
                for (i, k) in F75_KEYS.iter().enumerate() {
                    out[i] = out[i].add(pal.color(k.u() * 0.35 + hue, mono).scale(0.55));
                }
            }
            VendorLayer::Breathing => {
                // 4 s cycle at speed 1.
                let v = 0.5 - 0.5 * (f.t * self.speed * std::f32::consts::PI * 2.0 / 4.0).cos();
                let col = pal.color(f.t * self.speed / 24.0 + hue, mono);
                for o in out.iter_mut() {
                    *o = o.add(col.scale(v * 0.8));
                }
            }
            VendorLayer::Wave => {
                self.wave_phase += f.dt * self.speed * (0.15 + f.level * 1.2);
                let bright = 0.25 + 0.75 * f.level.min(1.0) * 1.6;
                for (i, k) in F75_KEYS.iter().enumerate() {
                    let u = k.u();
                    let v = 0.5 + 0.5 * ((u * 2.0 - self.wave_phase) * std::f32::consts::PI * 2.0).sin();
                    out[i] = out[i].add(
                        pal.color(u - self.wave_phase * 0.5, mono).scale(bright * (0.35 + 0.65 * v)),
                    );
                }
            }
            VendorLayer::Starry => {
                let rate = (0.6 + f.treble * 25.0 + if f.beat { 6.0 } else { 0.0 })
                    * self.speed
                    * f.dt;
                let mut spawn = rate;
                while spawn > 0.0 {
                    if self.rng.f32() < spawn {
                        let i = self.rng.below(F75_KEYS.len());
                        self.stars[i] = 1.0;
                        self.star_colors[i] = if self.rng.f32() < 0.35 {
                            Rgb { r: 1.0, g: 1.0, b: 1.0 }
                        } else {
                            pal.color(self.rng.f32() + hue, mono)
                        };
                    }
                    spawn -= 1.0;
                }
                let decay = 0.12f32.powf(f.dt * self.speed);
                for (i, o) in out.iter_mut().enumerate() {
                    if self.stars[i] > 0.01 {
                        *o = o.add(self.star_colors[i].scale(self.stars[i]));
                        self.stars[i] *= decay;
                    }
                }
            }
            VendorLayer::Spectrum => {
                for (i, k) in F75_KEYS.iter().enumerate() {
                    let band = ((k.u() * VBANDS as f32) as usize).min(VBANDS - 1);
                    let height = 5 - k.row();
                    let fill = (f.bands[band] * 6.0 - height as f32).clamp(0.0, 1.0);
                    if fill <= 0.0 {
                        continue;
                    }
                    let col = if pal == Palette::Heat {
                        pal.color(height as f32 / 6.0, mono)
                    } else {
                        pal.color(band as f32 / VBANDS as f32 + hue, mono)
                    };
                    out[i] = out[i].add(col.scale(fill));
                }
            }
            VendorLayer::Ripple => {
                if f.beat {
                    let i = self.rng.below(F75_KEYS.len());
                    let k = F75_KEYS[i];
                    let shade = self.rng.f32() + hue;
                    self.rings.push(Ring {
                        x: k.x(),
                        y: k.y(),
                        born: f.t,
                        color: pal.color(shade, mono),
                    });
                    if self.rings.len() > 12 {
                        self.rings.remove(0);
                    }
                }
                let v = 380.0 * self.speed; // px/s (key ≈ 38 px)
                let reach = 520.0f32;
                let width = 52.0f32;
                let life = reach / v;
                self.rings.retain(|r| f.t - r.born <= life);
                for r in &self.rings {
                    let age = f.t - r.born;
                    let radius = age * v;
                    let p = age / life;
                    let fade = (1.0 - p) * (1.0 - p);
                    for (i, k) in F75_KEYS.iter().enumerate() {
                        let dist = ((k.x() - r.x).powi(2) + (k.y() - r.y).powi(2)).sqrt();
                        let d = (dist - radius).abs();
                        let mut a = 0.0f32;
                        if d < width {
                            a = 0.5 + 0.5 * (d / width * std::f32::consts::PI).cos();
                        }
                        if dist < 1.0 && age < 0.15 {
                            a = a.max(1.0);
                        }
                        if a > 0.0 {
                            out[i] = out[i].add(r.color.scale(a * fade));
                        }
                    }
                }
            }
            VendorLayer::Pulse => {
                let target = f.bass.clamp(0.0, 1.0).powf(1.3);
                self.pulse_env = if target > self.pulse_env {
                    target
                } else {
                    self.pulse_env * 0.05f32.powf(f.dt * self.speed) + target * 0.02
                };
                if self.pulse_env <= 0.02 {
                    return;
                }
                for (i, k) in F75_KEYS.iter().enumerate() {
                    out[i] = out[i].add(
                        pal.color(k.u() * 0.3 + hue, mono).scale(self.pulse_env * 0.9),
                    );
                }
            }
            VendorLayer::Rain => {
                self.treble_avg = self.treble_avg * 0.9 + f.treble * 0.1;
                let mut n = if f.beat { 3 } else { 0 };
                if f.treble > self.treble_avg * 1.25 && f.treble > 0.08 {
                    n += 1;
                }
                if self.rng.f32() < 0.4 * f.dt * self.speed {
                    n += 1;
                }
                for _ in 0..n {
                    self.drops.push(Drop {
                        col: self.rng.f32(),
                        y: -0.5,
                        color: pal.color(self.rng.f32() + hue, mono),
                    });
                }
                if self.drops.len() > 24 {
                    let excess = self.drops.len() - 24;
                    self.drops.drain(..excess);
                }
                for d in self.drops.iter_mut() {
                    d.y += f.dt * 9.0 * self.speed;
                }
                self.drops.retain(|d| d.y <= 8.0);
                for d in &self.drops {
                    for (i, k) in F75_KEYS.iter().enumerate() {
                        if (k.u() - d.col).abs() >= 0.045 {
                            continue;
                        }
                        let dy = d.y - k.row() as f32;
                        if (-0.5..2.5).contains(&dy) {
                            let a = if dy < 0.5 { 1.0 } else { (1.0 - (dy - 0.5) / 2.0).max(0.0) };
                            out[i] = out[i].add(d.color.scale(a));
                        }
                    }
                }
            }
        }
    }
}
