//! Layer-mixer music engine — additive per-key scenes driven by
//! [`crate::dsp::Bands`] features.
//!
//! The mixer holds a set of named [`LayerKind`]s (spectrum bars, beat
//! ripples, bass pulse, rain, wave, starfield, …), each rendering into a
//! per-slot colour buffer that is summed with per-layer level scaling.
//! Frames are dark between events by design — there is no ambient base
//! layer unless one is explicitly enabled.
//!
//! Geometry is data-driven: [`KeyPoint`] gives every colour slot a
//! position in key units (`x` 0…16.5 left→right, `y` 0…6 top→bottom,
//! ~square cells) so spectrum bars, ripples and rain land on the real
//! key positions rather than slot order. The CLI feeds it from the
//! device keymap; [`crate::render`] visualisers keep their own mapping.
//!
//! [`Preset`]s bundle layer sets + palette into named scenes
//! (`spectrum`, `party`, `lava`, …) so `--effect` can name a look
//! instead of listing layers.

use crate::dsp::{Bands, SPECTRUM_BINS};

// ── Geometry ───────────────────────────────────────────────────────────

/// Horizontal extent of the board in key units (≈16.5 keys wide).
pub const BOARD_W: f32 = 16.5;
/// Vertical extent in row units (6 rows, ~square cells).
pub const BOARD_H: f32 = 6.0;

/// One colour slot's position: `x` in key units left→right,
/// `y` in row units top→bottom (row 0 = function row).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeyPoint {
    pub x: f32,
    pub y: f32,
}

impl KeyPoint {
    /// 0…1 across the board (band pick, rain column match, colour t).
    fn u(&self) -> f32 {
        (self.x / BOARD_W).clamp(0.0, 1.0)
    }
    /// Row index 0…5 (top→bottom) for spectrum height / rain drops.
    fn row(&self) -> i32 {
        (self.y.round() as i32).clamp(0, 5)
    }
}

/// Fallback board coverage when no keymap is available: 21×6 grid so
/// every slot still gets a distinct, well-spread position inside
/// [`BOARD_W`]×[`BOARD_H`].
pub fn grid_geometry(n: usize) -> Vec<KeyPoint> {
    const COLS: usize = 21;
    (0..n)
        .map(|i| KeyPoint {
            x: (i % COLS) as f32 * (BOARD_W / COLS as f32) + BOARD_W / (COLS as f32 * 2.0),
            y: (i / COLS) as f32,
        })
        .collect()
}

// ── Colour ─────────────────────────────────────────────────────────────

/// Linear 0..1 RGB, additive blending.
#[derive(Clone, Copy, Debug, Default)]
pub struct Rgb {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl Rgb {
    pub const BLACK: Rgb = Rgb {
        r: 0.0,
        g: 0.0,
        b: 0.0,
    };
    fn add(self, o: Rgb) -> Rgb {
        Rgb {
            r: self.r + o.r,
            g: self.g + o.g,
            b: self.b + o.b,
        }
    }
    fn scale(self, k: f32) -> Rgb {
        Rgb {
            r: self.r * k,
            g: self.g * k,
            b: self.b * k,
        }
    }
    fn clamp(self) -> Rgb {
        Rgb {
            r: self.r.clamp(0.0, 1.0),
            g: self.g.clamp(0.0, 1.0),
            b: self.b.clamp(0.0, 1.0),
        }
    }
}

/// HSV → RGB (h wraps 0..1, s/v 0..1).
fn hsv(h: f32, s: f32, v: f32) -> Rgb {
    let hh = h.rem_euclid(1.0);
    let i = ((hh * 6.0) as i32).rem_euclid(6);
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

/// Named colour palettes; `t` wraps 0..1, `mono` is the single-colour
/// override for [`Palette::Mono`].
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
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "rainbow" => Self::Rainbow,
            "heat" => Self::Heat,
            "ocean" => Self::Ocean,
            "sunset" => Self::Sunset,
            "neon" => Self::Neon,
            "mono" => Self::Mono,
            _ => return None,
        })
    }

    /// Colour at position `t` (0…1, wraps), full brightness.
    pub fn color(&self, t: f32, mono: Rgb) -> Rgb {
        let x = t.rem_euclid(1.0);
        match self {
            Palette::Rainbow => hsv(x, 1.0, 1.0),
            Palette::Heat => gradient(
                x,
                &[
                    Rgb {
                        r: 0.0,
                        g: 1.0,
                        b: 0.0,
                    },
                    Rgb {
                        r: 1.0,
                        g: 1.0,
                        b: 0.0,
                    },
                    Rgb {
                        r: 1.0,
                        g: 0.3,
                        b: 0.0,
                    },
                    Rgb {
                        r: 1.0,
                        g: 0.0,
                        b: 0.0,
                    },
                ],
            ),
            Palette::Ocean => gradient(
                x,
                &[
                    Rgb {
                        r: 0.0,
                        g: 0.2,
                        b: 1.0,
                    },
                    Rgb {
                        r: 0.0,
                        g: 0.8,
                        b: 1.0,
                    },
                    Rgb {
                        r: 0.0,
                        g: 1.0,
                        b: 0.6,
                    },
                    Rgb {
                        r: 0.3,
                        g: 0.3,
                        b: 1.0,
                    },
                ],
            ),
            Palette::Sunset => gradient(
                x,
                &[
                    Rgb {
                        r: 1.0,
                        g: 0.1,
                        b: 0.3,
                    },
                    Rgb {
                        r: 1.0,
                        g: 0.5,
                        b: 0.0,
                    },
                    Rgb {
                        r: 1.0,
                        g: 0.85,
                        b: 0.2,
                    },
                    Rgb {
                        r: 0.6,
                        g: 0.0,
                        b: 1.0,
                    },
                ],
            ),
            Palette::Neon => gradient(
                x,
                &[
                    Rgb {
                        r: 1.0,
                        g: 0.0,
                        b: 1.0,
                    },
                    Rgb {
                        r: 0.0,
                        g: 1.0,
                        b: 1.0,
                    },
                    Rgb {
                        r: 0.5,
                        g: 1.0,
                        b: 0.0,
                    },
                    Rgb {
                        r: 1.0,
                        g: 0.0,
                        b: 0.5,
                    },
                ],
            ),
            Palette::Mono => mono,
        }
    }
}

// ── Layers ─────────────────────────────────────────────────────────────

/// Scene layers. `solid`/`breathing`/`wave`/`starry` work without music;
/// `spectrum`/`ripple`/`pulse`/`rain` are audio-reactive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerKind {
    Solid,
    Breathing,
    Wave,
    Starry,
    Spectrum,
    Ripple,
    Pulse,
    Rain,
}

impl LayerKind {
    /// Starting brightness: background effects dimmer so reactive layers
    /// stand out on top.
    pub fn default_level(&self) -> f32 {
        match self {
            LayerKind::Solid => 0.35,
            LayerKind::Breathing | LayerKind::Wave => 0.45,
            LayerKind::Starry => 0.6,
            _ => 1.0,
        }
    }
    pub fn musical(&self) -> bool {
        matches!(
            self,
            LayerKind::Spectrum | LayerKind::Ripple | LayerKind::Pulse | LayerKind::Rain
        )
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

/// Per-frame feature view fed to every layer.
struct Feat {
    /// Spectrum energies, `SPECTRUM_BINS` entries, 0..1.
    bands: [f32; SPECTRUM_BINS],
    bass: f32,
    treble: f32,
    level: f32,
    beat: bool,
    t: f32,
    dt: f32,
}

fn make_feat(b: &Bands, t: f32, dt: f32, gain: f32) -> Feat {
    // Apply AGC + user gain once, up front, so every layer sees the same
    // normalised features (quiet and loud material fill the board alike).
    let g = (b.agc * gain).clamp(0.0, 8.0);
    let mut bands = [0.0f32; SPECTRUM_BINS];
    for (i, slot) in bands.iter_mut().enumerate() {
        *slot = (b.spectrum[i] * g).clamp(0.0, 1.0);
    }
    Feat {
        bands,
        bass: (b.bass * g).clamp(0.0, 1.0),
        treble: (b.treble * g).clamp(0.0, 1.0),
        level: (b.level * g).clamp(0.0, 1.0),
        beat: b.beat,
        t,
        dt,
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

/// Small deterministic RNG (xorshift64*) — seedable so tests and runs
/// are reproducible.
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

// ── Presets ────────────────────────────────────────────────────────────

/// A named scene: layer set + palette. `--effect <name>` accepts these.
pub struct Preset {
    pub name: &'static str,
    pub layers: &'static [LayerKind],
    pub palette: Palette,
}

/// Curated scenes — each pairs reactive layers with a palette so the
/// board always reads as one look instead of a random mix.
pub const PRESETS: &[Preset] = &[
    Preset {
        name: "spectrum",
        layers: &[LayerKind::Spectrum],
        palette: Palette::Rainbow,
    },
    Preset {
        name: "equalizer",
        layers: &[LayerKind::Spectrum, LayerKind::Ripple],
        palette: Palette::Heat,
    },
    Preset {
        name: "party",
        layers: &[
            LayerKind::Ripple,
            LayerKind::Rain,
            LayerKind::Starry,
            LayerKind::Pulse,
        ],
        palette: Palette::Rainbow,
    },
    Preset {
        name: "lava",
        layers: &[LayerKind::Wave, LayerKind::Pulse],
        palette: Palette::Heat,
    },
    Preset {
        name: "rainstorm",
        layers: &[LayerKind::Rain, LayerKind::Ripple],
        palette: Palette::Ocean,
    },
    Preset {
        name: "starry",
        layers: &[LayerKind::Starry, LayerKind::Wave],
        palette: Palette::Ocean,
    },
    Preset {
        name: "pulse",
        layers: &[LayerKind::Pulse, LayerKind::Ripple],
        palette: Palette::Sunset,
    },
    Preset {
        name: "breathing",
        layers: &[LayerKind::Breathing, LayerKind::Ripple],
        palette: Palette::Sunset,
    },
    Preset {
        name: "wave",
        layers: &[LayerKind::Wave, LayerKind::Ripple],
        palette: Palette::Rainbow,
    },
    Preset {
        name: "spectrum-stars",
        layers: &[LayerKind::Spectrum, LayerKind::Starry],
        palette: Palette::Rainbow,
    },
];

/// Look up a preset by name.
pub fn preset(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

/// Parse an `--effect` value for the mixer: either a preset name or a
/// comma-separated layer list with optional `=level` overrides
/// (`spectrum=0.7,ripple`). Returns the layer list; preset palette is
/// applied separately by the caller.
pub fn parse_layers(spec: &str) -> Result<Vec<(LayerKind, Option<f32>)>, String> {
    let mut out = Vec::new();
    for item in spec.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let (name, level) = match item.split_once('=') {
            Some((n, l)) => {
                let v: f32 = l.trim().parse().map_err(|_| format!("bad level '{l}'"))?;
                if !(0.0..=1.0).contains(&v) {
                    return Err(format!("level {v} out of range 0.0..=1.0"));
                }
                (n.trim(), Some(v))
            }
            None => (item, None),
        };
        let kind = LayerKind::parse(name).ok_or_else(|| format!("unknown layer '{name}'"))?;
        out.push((kind, level));
    }
    if out.is_empty() {
        return Err("empty layer list".to_string());
    }
    Ok(out)
}

// ── Mixer ──────────────────────────────────────────────────────────────

/// The scene mixer: layer set + shared state + palette/speed/brightness.
/// Call [`LayerMixer::set_geometry`] once with the slot positions, then
/// [`LayerMixer::frame`] per rendered frame.
pub struct LayerMixer {
    /// Enabled layers with optional per-layer brightness overrides
    /// (missing = [`LayerKind::default_level`]).
    pub layers: Vec<(LayerKind, Option<f32>)>,
    pub palette: Palette,
    /// 0.25…3, scene speed multiplier.
    pub speed: f32,
    /// Mono colour for [`Palette::Mono`].
    pub mono: Rgb,
    /// Master brightness 0..1 applied at pack time.
    pub brightness: f32,
    /// Input gain applied to band energies (CLI `--sensitivity`).
    pub gain: f32,

    geom: Vec<KeyPoint>,
    /// Slowly drifting palette offset (cycles/sec scaled by speed).
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
    // Beat detector state (bassNow/bassAvg/prevBass/lastBeat)
    bass_avg: f32,
    prev_bass: f32,
    last_beat_t: f32,
    rng: Rng,
}

impl Default for LayerMixer {
    fn default() -> Self {
        Self {
            layers: vec![(LayerKind::Pulse, None), (LayerKind::Ripple, None)],
            palette: Palette::Sunset,
            speed: 1.0,
            mono: Rgb {
                r: 1.0,
                g: 1.0,
                b: 1.0,
            },
            brightness: 1.0,
            gain: 1.0,
            geom: Vec::new(),
            hue: 0.0,
            t: 0.0,
            rings: Vec::new(),
            drops: Vec::new(),
            treble_avg: 0.0,
            stars: Vec::new(),
            star_colors: Vec::new(),
            pulse_env: 0.0,
            wave_phase: 0.0,
            bass_avg: 0.0,
            prev_bass: 0.0,
            last_beat_t: -1.0,
            rng: Rng(0x9E3779B97F4A7C15),
        }
    }
}

impl LayerMixer {
    /// Install per-slot positions (one per colour slot, indexed like the
    /// keymap). Resets per-slot layer state (starfield).
    pub fn set_geometry(&mut self, geom: Vec<KeyPoint>) {
        self.stars = vec![0.0; geom.len()];
        self.star_colors = vec![Rgb::BLACK; geom.len()];
        self.geom = geom;
    }

    /// Number of colour slots the mixer covers.
    pub fn slots(&self) -> usize {
        self.geom.len()
    }

    /// Render one frame → per-slot linear RGB (len = `slots()`).
    /// `dt` = seconds since the previous frame.
    pub fn frame(&mut self, bands: &Bands, dt: f32) -> Vec<Rgb> {
        self.t += dt;
        // Palette drift is a per-second rate (0.075 cycles/s at speed 1)
        // so it looks identical at any stream rate.
        self.hue = (self.hue + 0.075 * self.speed * dt).rem_euclid(1.0);
        let mut f = make_feat(bands, self.t, dt, self.gain);
        // Beat rule on the bass channel, OR'd with the analyser's beat
        // flag so flux onsets without a bass spike still trigger ripples.
        let bass_now = f.bass;
        self.bass_avg = self.bass_avg * 0.95 + bass_now * 0.05;
        let bass_beat = bass_now > (0.12f32).max(self.bass_avg * 1.35)
            && bass_now > self.prev_bass
            && self.t - self.last_beat_t > 0.16;
        self.prev_bass = bass_now;
        if bass_beat {
            self.last_beat_t = self.t;
        }
        f.beat = bass_beat || f.beat;

        // Mixer: each enabled layer renders into a scratch buffer,
        // clamped, scaled by its level, summed; final clamp per slot.
        let n = self.geom.len();
        let mut out = vec![Rgb::BLACK; n];
        for &(kind, level) in self.layers.clone().iter() {
            let mut layer = vec![Rgb::BLACK; n];
            self.render_layer(kind, &f, &mut layer);
            let k = level.unwrap_or_else(|| kind.default_level());
            for (o, l) in out.iter_mut().zip(layer.iter()) {
                *o = o.add(l.clamp().scale(k));
            }
        }
        out.iter()
            .map(|c| c.clamp().scale(self.brightness))
            .collect()
    }

    fn ctx(&self) -> (f32, Rgb) {
        (self.hue, self.mono)
    }

    fn render_layer(&mut self, kind: LayerKind, f: &Feat, out: &mut [Rgb]) {
        let (hue, mono) = self.ctx();
        let pal = self.palette;
        match kind {
            LayerKind::Solid => {
                for (i, k) in self.geom.iter().enumerate() {
                    out[i] = out[i].add(pal.color(k.u() * 0.35 + hue, mono).scale(0.55));
                }
            }
            LayerKind::Breathing => {
                // 4 s cycle at speed 1.
                let v = 0.5 - 0.5 * (f.t * self.speed * std::f32::consts::PI * 2.0 / 4.0).cos();
                let col = pal.color(f.t * self.speed / 24.0 + hue, mono);
                for o in out.iter_mut() {
                    *o = o.add(col.scale(v * 0.8));
                }
            }
            LayerKind::Wave => {
                self.wave_phase += f.dt * self.speed * (0.15 + f.level * 1.2);
                let bright = 0.25 + 0.75 * (f.level * 1.6).min(1.0);
                for (i, k) in self.geom.iter().enumerate() {
                    let u = k.u();
                    let v = 0.5
                        + 0.5 * ((u * 2.0 - self.wave_phase) * std::f32::consts::PI * 2.0).sin();
                    out[i] = out[i].add(
                        pal.color(u - self.wave_phase * 0.5, mono)
                            .scale(bright * (0.35 + 0.65 * v)),
                    );
                }
            }
            LayerKind::Starry => {
                let rate =
                    (0.6 + f.treble * 25.0 + if f.beat { 6.0 } else { 0.0 }) * self.speed * f.dt;
                let mut spawn = rate;
                while spawn > 0.0 {
                    if self.rng.f32() < spawn {
                        let i = self.rng.below(self.geom.len());
                        self.stars[i] = 1.0;
                        self.star_colors[i] = if self.rng.f32() < 0.35 {
                            Rgb {
                                r: 1.0,
                                g: 1.0,
                                b: 1.0,
                            }
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
            LayerKind::Spectrum => {
                // Group the board into BARS vertical columns (~1.4 key
                // units each — wider than the row stagger so a physical
                // column of keys shares one band). 24 spectrum bins / 12
                // bars = 2 bins averaged per column; without this each
                // key fell into its own bin and the field looked like
                // confetti instead of an equalizer.
                const BARS: usize = 12;
                const BINS_PER_BAR: usize = SPECTRUM_BINS / BARS;
                for (i, k) in self.geom.iter().enumerate() {
                    let bar = ((k.u() * BARS as f32) as usize).min(BARS - 1);
                    let lo = bar * BINS_PER_BAR;
                    let hi = (lo + BINS_PER_BAR).min(SPECTRUM_BINS);
                    let energy = f.bands[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
                    let height = 5 - k.row();
                    let fill = (energy * 6.0 - height as f32).clamp(0.0, 1.0);
                    if fill <= 0.0 {
                        continue;
                    }
                    let col = if pal == Palette::Heat {
                        pal.color(height as f32 / 6.0, mono)
                    } else {
                        pal.color(bar as f32 / BARS as f32 + hue, mono)
                    };
                    out[i] = out[i].add(col.scale(fill));
                }
            }
            LayerKind::Ripple => {
                if f.beat {
                    let i = self.rng.below(self.geom.len());
                    let k = self.geom[i];
                    let shade = self.rng.f32() + hue;
                    self.rings.push(Ring {
                        x: k.x,
                        y: k.y,
                        born: f.t,
                        color: pal.color(shade, mono),
                    });
                    if self.rings.len() > 12 {
                        self.rings.remove(0);
                    }
                }
                // Speeds in key units/sec (cells ≈ 38 px square): the
                // ring crosses the ~16.5-unit board in ~1.4 s.
                let v = 10.0 * self.speed;
                let reach = 13.7f32;
                let width = 1.37f32;
                let life = reach / v;
                self.rings.retain(|r| f.t - r.born <= life);
                for r in &self.rings {
                    let age = f.t - r.born;
                    let radius = age * v;
                    let p = age / life;
                    let fade = (1.0 - p) * (1.0 - p);
                    for (i, k) in self.geom.iter().enumerate() {
                        let dist = ((k.x - r.x).powi(2) + (k.y - r.y).powi(2)).sqrt();
                        let d = (dist - radius).abs();
                        let mut a = 0.0f32;
                        if d < width {
                            a = 0.5 + 0.5 * (d / width * std::f32::consts::PI).cos();
                        }
                        if dist < 0.15 && age < 0.15 {
                            a = a.max(1.0);
                        }
                        if a > 0.0 {
                            out[i] = out[i].add(r.color.scale(a * fade));
                        }
                    }
                }
            }
            LayerKind::Pulse => {
                let target = f.bass.powf(1.3);
                self.pulse_env = if target > self.pulse_env {
                    target
                } else {
                    self.pulse_env * 0.05f32.powf(f.dt * self.speed) + target * 0.02
                };
                if self.pulse_env <= 0.02 {
                    return;
                }
                for (i, k) in self.geom.iter().enumerate() {
                    out[i] = out[i].add(
                        pal.color(k.u() * 0.3 + hue, mono)
                            .scale(self.pulse_env * 0.9),
                    );
                }
            }
            LayerKind::Rain => {
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
                    for (i, k) in self.geom.iter().enumerate() {
                        if (k.u() - d.col).abs() >= 0.045 {
                            continue;
                        }
                        let dy = d.y - k.row() as f32;
                        if (-0.5..2.5).contains(&dy) {
                            let a = if dy < 0.5 {
                                1.0
                            } else {
                                (1.0 - (dy - 0.5) / 2.0).max(0.0)
                            };
                            out[i] = out[i].add(d.color.scale(a));
                        }
                    }
                }
            }
        }
    }
}

// ── Rhythm modes ──────────────────────────────────────────────────────
//
// Column/pattern shaders: vertical column fills driven by band
// energies, position-chasing column heads, scrolling palettes and a
// bouncing beam. Each mode keeps its own small state struct inside
// [`ModeRenderer`]; all timing is `dt`-scaled so motion is identical
// at any stream rate.

/// How the column-fill shader picks a colour for a lit key.
#[derive(Clone, Copy)]
enum ColumnColor {
    /// One colour per column (clouds-rise).
    PerColumn,
    /// Vertical rainbow: vendor palette index `j*2` per key (dance-soft).
    PerKey,
}

/// A named rhythm mode — one self-contained shader over the key grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeKind {
    /// Spectrum → per-column fill count; keys coloured by position
    /// (vertical rainbow gradient, vendor palette index `j*2`).
    DanceSoft,
    /// Chasing head lights whole columns; frontier column flashes white.
    DazzlingRock,
    /// Per-column spectrum fill with per-column palette colours.
    CloudsRise,
    /// Global brightness pulse over a soft gradient field.
    LightField,
    /// Whole board lit, palette scrolls; last key per column boosted.
    GurglingStream,
    /// Rock chase + periodic column reshuffle + tip boost.
    BloomingPassion,
    /// Bouncing beam sweeping a row, rainbow along the beam.
    Sine,
    /// Static diagonal gradient pattern; tempo follows the music level.
    DynamicSpectrum,
}

impl ModeKind {
    /// All modes in display order.
    pub const ALL: &'static [ModeKind] = &[
        Self::DanceSoft,
        Self::DazzlingRock,
        Self::CloudsRise,
        Self::LightField,
        Self::GurglingStream,
        Self::BloomingPassion,
        Self::Sine,
        Self::DynamicSpectrum,
    ];

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "dance-soft" | "dancesoft" | "dance" => Self::DanceSoft,
            "dazzling-rock" | "rock" | "dazzling" => Self::DazzlingRock,
            "clouds-rise" | "clouds" | "snow" => Self::CloudsRise,
            "light-field" | "field" => Self::LightField,
            "gurgling-stream" | "stream" | "gurgling" => Self::GurglingStream,
            "blooming-passion" | "blooming" | "passion" => Self::BloomingPassion,
            "sine" | "beam" => Self::Sine,
            "dynamic-spectrum" | "spectrum-pattern" | "pattern" => Self::DynamicSpectrum,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::DanceSoft => "dance-soft",
            Self::DazzlingRock => "dazzling-rock",
            Self::CloudsRise => "clouds-rise",
            Self::LightField => "light-field",
            Self::GurglingStream => "gurgling-stream",
            Self::BloomingPassion => "blooming-passion",
            Self::Sine => "sine",
            Self::DynamicSpectrum => "dynamic-spectrum",
        }
    }
}

/// One rhythm-mode renderer. Geometry is installed once via
/// [`ModeRenderer::set_geometry`]; [`ModeRenderer::frame`] returns
/// per-slot linear RGB each call.
pub struct ModeRenderer {
    pub kind: ModeKind,
    pub palette: Palette,
    pub mono: Rgb,
    /// Scene speed multiplier 0.25…3.
    pub speed: f32,
    /// Master brightness 0..1.
    pub brightness: f32,
    /// Input gain (`--sensitivity`).
    pub gain: f32,

    geom: Vec<KeyPoint>,
    /// `n_cols` vertical columns; each holds slot ids ordered top→bottom.
    cols: Vec<Vec<usize>>,
    /// Per-slot flag: bottom-most key of its column (gurgling boost).
    col_last: Vec<bool>,
    /// 6×22 cell grid (row → col → slot) for pattern modes.
    grid: Vec<Vec<Option<usize>>>,

    t: f32,
    hue: f32,
    /// Chase position in column units (rock/bloom).
    pos: f32,
    /// Per-column smoothed lit-key counts (dance/clouds).
    counts: Vec<f32>,
    /// Phase clock driving the non-spectrum modes.
    drive: f32,
    frame_cnt: u32,
}

/// Split slots into `n` vertical columns by x; each column ordered
/// top→bottom (row 0 first), matching the vendor column lists.
fn column_sets(geom: &[KeyPoint], n: usize) -> Vec<Vec<usize>> {
    let mut cols: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (i, k) in geom.iter().enumerate() {
        let c = ((k.u() * n as f32) as usize).min(n - 1);
        cols[c].push(i);
    }
    for col in cols.iter_mut() {
        col.sort_by(|&a, &b| {
            geom[a]
                .y
                .partial_cmp(&geom[b].y)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(
                    geom[a]
                        .x
                        .partial_cmp(&geom[b].x)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
        });
    }
    cols
}

/// Bucket slots into a `rows`×`cols` cell grid (row = y, col = x).
fn cell_grid(geom: &[KeyPoint], rows: usize, cols: usize) -> Vec<Vec<Option<usize>>> {
    let mut grid = vec![vec![None; cols]; rows];
    for (i, k) in geom.iter().enumerate() {
        let r = (k.y.round() as usize).min(rows - 1);
        let c = ((k.u() * cols as f32) as usize).min(cols - 1);
        // First slot wins a cell; extras are dropped (grid is approximate).
        if grid[r][c].is_none() {
            grid[r][c] = Some(i);
        }
    }
    grid
}

impl Default for ModeRenderer {
    fn default() -> Self {
        Self {
            kind: ModeKind::DanceSoft,
            palette: Palette::Sunset,
            mono: Rgb {
                r: 1.0,
                g: 1.0,
                b: 1.0,
            },
            speed: 1.0,
            brightness: 1.0,
            gain: 1.0,
            geom: Vec::new(),
            cols: Vec::new(),
            col_last: Vec::new(),
            grid: Vec::new(),
            t: 0.0,
            hue: 0.0,
            pos: 0.0,
            counts: Vec::new(),
            drive: 0.0,
            frame_cnt: 0,
        }
    }
}

impl ModeRenderer {
    /// Install per-slot positions; rebuilds column/grid buckets.
    pub fn set_geometry(&mut self, geom: Vec<KeyPoint>) {
        self.cols = column_sets(&geom, 6);
        self.col_last = vec![false; geom.len()];
        for col in &self.cols {
            if let Some(&last) = col.last() {
                self.col_last[last] = true;
            }
        }
        self.counts = vec![0.0; self.cols.len()];
        self.grid = cell_grid(&geom, 6, 22);
        self.geom = geom;
    }

    /// Number of colour slots covered.
    pub fn slots(&self) -> usize {
        self.geom.len()
    }

    /// Advance the shared phase clock. Non-spectrum modes are driven by
    /// `drive = t·speed·(1.0 + 2.5·level)` so louder music runs the
    /// animation faster — the role the vendor's external phase arg plays.
    fn drive_phase(&mut self, f: &Feat) {
        self.drive += f.dt * self.speed * (1.0 + f.level * 2.5);
    }

    /// Render one frame → per-slot linear RGB (len = `slots()`).
    pub fn frame(&mut self, bands: &Bands, dt: f32) -> Vec<Rgb> {
        self.t += dt;
        self.hue = (self.hue + 0.075 * self.speed * dt).rem_euclid(1.0);
        let f = make_feat(bands, self.t, dt, self.gain);
        self.drive_phase(&f);
        self.frame_cnt = self.frame_cnt.wrapping_add(1);
        let mut out = vec![Rgb::BLACK; self.geom.len()];
        match self.kind {
            ModeKind::DanceSoft | ModeKind::CloudsRise => self.column_spectrum(
                &f,
                &mut out,
                if self.kind == ModeKind::CloudsRise {
                    ColumnColor::PerColumn
                } else {
                    ColumnColor::PerKey
                },
            ),
            ModeKind::DazzlingRock | ModeKind::BloomingPassion => {
                self.column_chase(&f, &mut out, self.kind == ModeKind::BloomingPassion)
            }
            ModeKind::LightField => self.light_field(&f, &mut out),
            ModeKind::GurglingStream => self.gurgling(&f, &mut out),
            ModeKind::Sine => self.sine_beam(&f, &mut out),
            ModeKind::DynamicSpectrum => self.pattern(&f, &mut out),
        }
        out.iter()
            .map(|c| c.clamp().scale(self.brightness))
            .collect()
    }

    /// Shared column-fill shader (dance-soft / clouds-rise): per column
    /// a band energy becomes a lit-key count — instant attack, linear
    /// decay — and the first `count` keys (top→bottom) light up.
    /// `dance-soft` colors each key by its index in the column
    /// (vendor palette index `j*2` → vertical rainbow gradient);
    /// `clouds-rise` colors the whole column by column index.
    fn column_spectrum(&mut self, f: &Feat, out: &mut [Rgb], color: ColumnColor) {
        let n = self.cols.len();
        if n == 0 {
            return;
        }
        let bpc = (SPECTRUM_BINS / n).max(1);
        for (i, col) in self.cols.iter().enumerate() {
            // Vendor band pick: column i samples band i·bpc − 1.
            let band = (i * bpc).saturating_sub(1).min(SPECTRUM_BINS - 1);
            let raw = f.bands[band] * 10.0;
            // Wrap modulo the column length (vendor per-column divisor).
            let m = if col.is_empty() {
                0.0
            } else {
                (raw % col.len() as f32).clamp(0.0, col.len() as f32)
            };
            // Slew: instant attack, −1 key per frame decay (dt-scaled).
            let c = &mut self.counts[i];
            if m > *c {
                *c = m;
            } else {
                *c = (*c - f.dt * 33.0).max(m);
            }
            let lit = (*c).ceil() as usize;
            for (j, &slot) in col.iter().take(lit).enumerate() {
                // Vendor palette index is `j*2` (key position ×2) — a
                // ~36-entry wheel → normalize to a full hue sweep.
                let col_color = match color {
                    ColumnColor::PerKey => self
                        .palette
                        .color(j as f32 * 2.0 / 36.0 + self.hue, self.mono),
                    ColumnColor::PerColumn => self
                        .palette
                        .color(i as f32 / n as f32 + self.hue, self.mono),
                };
                out[slot] = out[slot].add(col_color);
            }
        }
    }

    /// Shared chase shader (dazzling-rock / blooming-passion): a head
    /// position slews ±1 column/frame toward `drive mod P`; the first
    /// `int(pos)` columns light fully, the frontier column flashes.
    fn column_chase(&mut self, f: &Feat, out: &mut [Rgb], reshuffle: bool) {
        let n = self.cols.len();
        if n == 0 {
            return;
        }
        // Blooming reshuffles the column order every ~31 frames.
        if reshuffle && self.frame_cnt % 31 == 0 && self.frame_cnt > 0 {
            self.cols.rotate_left(1);
        }
        let period = if reshuffle { 5.0 } else { 8.0 };
        let rem = self.drive.rem_euclid(period);
        // Chase at ~33 columns/sec (vendor: ±1.0 per 30 ms frame).
        let step = f.dt * 33.0 * self.speed;
        if rem > self.pos {
            self.pos = (self.pos + step).min(rem);
        } else {
            self.pos = (self.pos - step).max(rem);
        }
        if self.pos < 0.0 {
            self.pos = 0.0;
        }
        let count = (self.pos as usize).min(n);
        let frac = (self.pos - count as f32).max(0.0);
        for (i, col) in self.cols.iter().enumerate() {
            if i >= count {
                break;
            }
            let base = self
                .palette
                .color(i as f32 / n as f32 + self.hue, self.mono);
            let is_frontier = i + 1 == count;
            for &slot in col.iter() {
                let mut c = base;
                if is_frontier {
                    if reshuffle {
                        // Tip boost: colour·frac + ~90/255 lift.
                        c = Rgb {
                            r: (c.r * frac + 0.35).min(1.0),
                            g: (c.g * frac + 0.35).min(1.0),
                            b: (c.b * frac + 0.35).min(1.0),
                        };
                    } else {
                        // Frontier column goes white.
                        c = Rgb {
                            r: 1.0,
                            g: 1.0,
                            b: 1.0,
                        };
                    }
                }
                out[slot] = out[slot].add(c);
            }
        }
        // Single lit column blinks: alternate white / dim every frame.
        if count == 1 && !reshuffle {
            let bright = self.frame_cnt % 2 == 0;
            for col in self.cols.iter().take(1) {
                for &slot in col.iter() {
                    out[slot] = if bright {
                        Rgb {
                            r: 1.0,
                            g: 1.0,
                            b: 1.0,
                        }
                    } else {
                        out[slot].scale(0.3)
                    };
                }
            }
        }
    }

    /// Light-field: whole board pulses 0→full brightness on a soft
    /// palette gradient; `phase = drive mod 4` gives a ~4-unit cycle.
    fn light_field(&mut self, _f: &Feat, out: &mut [Rgb]) {
        let phase = self.drive.rem_euclid(4.0);
        let v = (phase * 0.25).clamp(0.0, 1.0);
        if v <= 0.01 {
            return;
        }
        let drift = self.t * self.speed / 24.0 + self.hue;
        for (i, k) in self.geom.iter().enumerate() {
            out[i] = out[i].add(self.palette.color(k.u() * 0.35 + drift, self.mono).scale(v));
        }
    }

    /// Gurgling stream: entire board one scrolling colour; the last
    /// key of each column gets a 1.3× boost.
    fn gurgling(&mut self, f: &Feat, out: &mut [Rgb]) {
        // Palette advances once per frame (~scroll).
        self.hue = (self.hue + f.dt * self.speed * 0.5).rem_euclid(1.0);
        let col = self.palette.color(self.hue, self.mono);
        for (i, o) in out.iter_mut().enumerate() {
            let boost = if self.col_last.get(i).copied().unwrap_or(false) {
                1.3
            } else {
                1.0
            };
            *o = o.add(col.scale(boost));
        }
    }

    /// Sine beam: a band sweeps row 0→5→0; colour runs rainbow along x.
    fn sine_beam(&mut self, f: &Feat, out: &mut [Rgb]) {
        // Triangle sweep 0..5 rows at ~0.5 cycles/sec·speed.
        let phase = (self.drive * 0.5).rem_euclid(10.0);
        let row = if phase < 5.0 { phase } else { 10.0 - phase }.round() as usize;
        self.hue = (self.hue + f.dt * self.speed * 0.8).rem_euclid(1.0);
        for (i, k) in self.geom.iter().enumerate() {
            if k.row() as usize != row.min(5) {
                continue;
            }
            out[i] = out[i].add(self.palette.color(k.u() * 0.6 + self.hue, self.mono));
        }
    }

    /// Dynamic spectrum: static diagonal gradient over a 6×22 cell
    /// grid; the pattern drifts slowly with the music level.
    fn pattern(&mut self, f: &Feat, out: &mut [Rgb]) {
        self.hue = (self.hue + f.dt * self.speed * (0.02 + f.level * 0.2)).rem_euclid(1.0);
        for (r, row) in self.grid.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let Some(slot) = cell else { continue };
                // Vendor colour index = rowPage·256 + shade → /256.
                let t = (((10 * r + 7 + 11 * c) % 256) as f32) / 256.0 + self.hue;
                out[*slot] = out[*slot].add(self.palette.color(t, self.mono));
            }
        }
    }
}

/// Pack per-slot linear RGB into the 378-byte cmd-8 frame payload.
/// `planar` = `[R×126][G×126][B×126]`; `interleaved` = slot×RGB.
pub fn pack_frame(colors: &[Rgb], slots: usize, planar: bool) -> Vec<u8> {
    let mut frame = vec![0u8; slots * 3];
    for (i, c) in colors.iter().take(slots).enumerate() {
        let (r, g, b) = (
            (c.r * 255.0) as u8,
            (c.g * 255.0) as u8,
            (c.b * 255.0) as u8,
        );
        if planar {
            frame[i] = r;
            frame[slots + i] = g;
            frame[2 * slots + i] = b;
        } else {
            frame[i * 3] = r;
            frame[i * 3 + 1] = g;
            frame[i * 3 + 2] = b;
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loud_bass() -> Bands {
        Bands {
            bass: 0.9,
            treble: 0.3,
            level: 0.6,
            spectrum: [0.5; SPECTRUM_BINS],
            ..Default::default()
        }
    }

    fn test_geom() -> Vec<KeyPoint> {
        grid_geometry(126)
    }

    #[test]
    fn silence_renders_black() {
        let mut eng = LayerMixer::default();
        eng.set_geometry(test_geom());
        let frame = eng.frame(&Bands::default(), 0.02);
        assert!(frame.iter().all(|c| c.r == 0.0 && c.g == 0.0 && c.b == 0.0));
    }

    #[test]
    fn loud_music_lights_keys() {
        let mut eng = LayerMixer::default();
        eng.set_geometry(test_geom());
        let mut lit = 0usize;
        for i in 0..50 {
            let mut b = loud_bass();
            b.beat = i % 20 == 0;
            let frame = eng.frame(&b, 0.02);
            lit = frame.iter().filter(|c| c.r + c.g + c.b > 0.1).count();
        }
        assert!(lit > 0, "loud input must light some slots");
    }

    #[test]
    fn beat_rings_spawn_and_expire() {
        let mut eng = LayerMixer {
            layers: vec![(LayerKind::Ripple, None)],
            ..Default::default()
        };
        eng.set_geometry(test_geom());
        let mut b = loud_bass();
        // Kick-like bass: spike every 30 frames (~0.6 s), quiet between.
        for i in 0..200 {
            b.bass = if i % 30 == 0 { 0.9 } else { 0.1 };
            eng.frame(&b, 0.02);
            if i == 45 {
                // ~0.3 s after a beat: ring should still be alive.
                assert!(!eng.rings.is_empty(), "beat must spawn a ring");
            }
        }
        for _ in 0..200 {
            b.bass = 0.0;
            b.level = 0.0;
            eng.frame(&b, 0.02);
        }
        assert!(eng.rings.is_empty(), "rings must expire");
    }

    #[test]
    fn spectrum_bars_rise_from_bottom() {
        // Only the lowest spectrum bin has energy → only bottom-row
        // keys (row 5, height 0) should light on the left side.
        let mut eng = LayerMixer {
            layers: vec![(LayerKind::Spectrum, None)],
            ..Default::default()
        };
        eng.set_geometry(test_geom());
        let mut b = Bands::default();
        b.spectrum[0] = 0.5;
        b.level = 0.5;
        let frame = eng.frame(&b, 0.02);
        // Grid geometry: slot i → x=(i%21)+0.5, y=i/21. Bottom row =
        // slots 105..125. Left columns (x<4) bottom row must be lit.
        let bottom_lit = (105..110)
            .filter(|&i| frame[i].r + frame[i].g + frame[i].b > 0.05)
            .count();
        assert!(bottom_lit > 0, "bottom-row keys must light on bass");
        // Top rows need much more energy — should stay dark.
        let top_lit = (0..21)
            .filter(|&i| frame[i].r + frame[i].g + frame[i].b > 0.05)
            .count();
        assert_eq!(top_lit, 0, "top row must stay dark at low band energy");
    }

    #[test]
    fn presets_parse_and_resolve() {
        assert!(preset("party").is_some());
        assert!(preset("nope").is_none());
        let layers = parse_layers("spectrum=0.7,ripple,pulse=1.0").unwrap();
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0], (LayerKind::Spectrum, Some(0.7)));
        assert_eq!(layers[1], (LayerKind::Ripple, None));
        assert!(parse_layers("bogus").is_err());
        assert!(parse_layers("spectrum=2.0").is_err());
    }

    #[test]
    fn mode_spectrum_modes_light_columns() {
        for kind in [ModeKind::DanceSoft, ModeKind::CloudsRise] {
            let mut m = ModeRenderer {
                kind,
                ..Default::default()
            };
            m.set_geometry(test_geom());
            let mut b = loud_bass();
            b.spectrum = [0.8; SPECTRUM_BINS];
            let mut lit = 0usize;
            for _ in 0..60 {
                let frame = m.frame(&b, 0.02);
                lit = frame.iter().filter(|c| c.r + c.g + c.b > 0.05).count();
            }
            assert!(lit > 10, "{kind:?} must light keys on loud input");
        }
    }

    #[test]
    fn mode_chase_and_pattern_always_render() {
        for kind in ModeKind::ALL {
            let mut m = ModeRenderer {
                kind: *kind,
                ..Default::default()
            };
            m.set_geometry(test_geom());
            let mut any = false;
            for i in 0..120 {
                let b = if i % 30 == 0 {
                    loud_bass()
                } else {
                    Bands::default()
                };
                let frame = m.frame(&b, 0.02);
                any |= frame.iter().any(|c| c.r + c.g + c.b > 0.02);
            }
            assert!(any, "{kind:?} must produce light at some point");
        }
    }

    #[test]
    fn mode_parse_roundtrip() {
        for kind in ModeKind::ALL {
            assert_eq!(ModeKind::parse(kind.name()), Some(*kind));
        }
        assert!(ModeKind::parse("bogus").is_none());
    }

    #[test]
    fn pack_frame_planar_and_interleaved() {
        let colors = vec![
            Rgb {
                r: 1.0,
                g: 0.0,
                b: 0.0
            };
            126
        ];
        let planar = pack_frame(&colors, 126, true);
        assert_eq!(planar[0], 255);
        assert_eq!(planar[126], 0);
        let inter = pack_frame(&colors, 126, false);
        assert_eq!(inter[0], 255);
        assert_eq!(inter[3], 255);
        assert_eq!(inter.len(), 378);
    }
}
