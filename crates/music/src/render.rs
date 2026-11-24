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

use crate::dsp::{Bands, SPECTRUM_BINS};

/// Keys per keyboard (cmd-6 slot count / cmd-8 frame size ÷ 3).
pub const KEY_SLOTS: usize = 126;
/// One cmd-8 frame payload: 126 keys × RGB planar.
pub const FRAME_BYTES: usize = KEY_SLOTS * 3;
/// Bumped when the visual mapping changes materially.
pub const RENDERER_VERSION: u32 = 1;

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
}

impl Default for FrameParams {
    fn default() -> Self {
        Self {
            sensitivity: 1.6,
            brightness: 0.9,
            hue_speed: 0.05,
            saturation: 1.0,
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
    let pos = x * SPECTRUM_BINS as f32;
    let i = (pos as usize).min(SPECTRUM_BINS - 2);
    let f = pos - i as f32;
    bands.spectrum[i] * (1.0 - f) + bands.spectrum[i + 1] * f
}

/// Render one frame. `t` is seconds since stream start (drives hue drift).
pub fn render_frame(bands: &Bands, t: f32, params: &FrameParams) -> [u8; FRAME_BYTES] {
    let mut frame = [0u8; FRAME_BYTES];
    let gain = params.sensitivity;
    let beat_flash = if bands.beat { 0.6 } else { 0.0 };
    for k in 0..KEY_SLOTS {
        let x = k as f32 / KEY_SLOTS as f32;
        // Gentle falloff toward the edges keeps the frame centred.
        let envelope = 0.75 + 0.25 * (std::f32::consts::PI * x).sin();
        let mut energy = spectrum_at(bands, x) * gain * envelope;
        // Bass pulse lifts the whole field slightly.
        energy += bands.bass * 0.15;
        energy = energy.clamp(0.0, 1.0) * params.brightness;

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
