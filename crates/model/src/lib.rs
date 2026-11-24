//! Model data for GravaStar HE keyboards: key sizes, legends, lighting zones,
//! limits. Ported from `orbit-gravastar/src/protocol/models.rs` (MIT),
//! reduced to English-only names and without the egui preview types.

// ── Actuation limits ───────────────────────────────────────────────────

/// Switch id of GravaStar's UFO magnetic switch, which allows 3.5 mm instead of 3.4 mm.
const UFO_SWITCH: u16 = 13232;

/// Maximum actuation travel for a switch, in millimetres.
pub fn max_travel(axis_v2_id: u16) -> f32 {
    if axis_v2_id == UFO_SWITCH {
        3.5
    } else {
        3.4
    }
}

/// Largest allowed press/release deadzone, in millimetres.
pub const DEADZONE_MAX: f32 = 1.0;

/// Lighting sleep options in minutes (0 = never), as offered by the official driver.
pub const LIGHT_SLEEP_MINUTES: [u16; 13] = [0, 1, 2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 120];

// ── Layout ─────────────────────────────────────────────────────────────

/// Physical key geometry as reported by the keyboard (protocol `03 05`).
#[derive(Clone, Copy, Debug)]
pub struct KeySlot {
    pub row: u8,
    pub col: u8,
    /// Position in key units.
    pub x: f32,
    pub y: f32,
    /// Width code, see [`key_size`].
    pub size: u8,
}

#[derive(Clone, Debug)]
pub struct KeyDef {
    pub row: u8,
    pub col: u8,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// ISO enter: 1.5u wide on top, 1.25u below, two rows high.
    pub iso_enter: bool,
    pub label: String,
}

/// Width codes reported by GetKeyLayoutStyle (from the official driver).
/// Returns (width, height, is_iso_enter_lower).
pub fn key_size(code: u8) -> (f32, f32, bool) {
    match code {
        2 => (1.25, 1.0, false),
        3 => (1.5, 1.0, false),
        4 => (1.75, 1.0, false),
        5 => (2.0, 1.0, false),
        6 => (2.25, 1.0, false),
        7 => (2.5, 1.0, false),
        8 => (2.75, 1.0, false),
        9 => (6.25, 1.0, false),
        10 => (1.0, 2.0, false),
        11 => (1.5, 2.0, true),
        _ => (1.0, 1.0, false),
    }
}

/// Key legend for a HID-based keycode. German legends only apply to ISO boards.
pub fn key_label(code: u16, german: bool) -> String {
    let fixed = match code {
        0x28 => "Enter",
        0x29 => "Esc",
        0x2a if german => "Rück",
        0x2a => "Backspace",
        0x2b => "Tab",
        0x2c => "",
        0x39 => "Caps",
        0x46 => "PrtSc",
        0x47 => "ScrLk",
        0x48 => "Pause",
        0x49 => "Ins",
        0x4a => "Home",
        0x4b => "PgUp",
        0x4c if german => "Entf",
        0x4c => "Del",
        0x4d => "End",
        0x4e => "PgDn",
        0x4f => "→",
        0x50 => "←",
        0x51 => "↓",
        0x52 => "↑",
        0x65 => "Menu",
        0xe0 | 0xe4 if german => "Strg",
        0xe0 | 0xe4 => "Ctrl",
        0xe1 | 0xe5 => "Shift",
        0xe2 => "Alt",
        0xe6 if german => "AltGr",
        0xe6 => "Alt",
        0xe3 | 0xe7 => "Win",
        0xf101 => "Fn",
        _ => "",
    };
    if !fixed.is_empty() || code == 0x2c {
        return fixed.to_string();
    }
    let punct_us = [
        (0x2d, "-"),
        (0x2e, "="),
        (0x2f, "["),
        (0x30, "]"),
        (0x31, "\\"),
        (0x32, "#"),
        (0x33, ";"),
        (0x34, "'"),
        (0x35, "`"),
        (0x36, ","),
        (0x37, "."),
        (0x38, "/"),
        (0x64, "\\"),
    ];
    let punct_de = [
        (0x2d, "ß"),
        (0x2e, "´"),
        (0x2f, "Ü"),
        (0x30, "+"),
        (0x31, "#"),
        (0x32, "#"),
        (0x33, "Ö"),
        (0x34, "Ä"),
        (0x35, "^"),
        (0x36, ","),
        (0x37, "."),
        (0x38, "-"),
        (0x64, "<"),
    ];
    let table: &[(u16, &str)] = if german { &punct_de } else { &punct_us };
    if let Some((_, s)) = table.iter().find(|(c, _)| *c == code) {
        return s.to_string();
    }
    match code {
        0x1c if german => "Z".into(),
        0x1d if german => "Y".into(),
        0x04..=0x1d => ((b'A' + (code - 4) as u8) as char).to_string(),
        0x1e..=0x26 => (code - 0x1d).to_string(),
        0x27 => "0".into(),
        0x3a..=0x45 => format!("F{}", code - 0x39),
        0 => String::new(),
        _ => format!("{code:X}"),
    }
}

/// Combines the keyboard's geometry with its live keymap into drawable keys.
pub fn build_layout(slots: &[KeySlot], codes: &dyn Fn(u8, u8) -> u16, german: bool) -> Vec<KeyDef> {
    let top = slots.iter().map(|s| s.y).fold(f32::MAX, f32::min);
    slots
        .iter()
        .map(|s| {
            let (w, h, iso_enter) = key_size(s.size);
            KeyDef {
                row: s.row,
                col: s.col,
                x: s.x,
                y: s.y - top,
                w,
                h,
                iso_enter,
                label: key_label(codes(s.row, s.col), german),
            }
        })
        .collect()
}

// ── Lighting ───────────────────────────────────────────────────────────

/// One lighting effect. `palette` means the effect picks one of the 8
/// palette colours; otherwise it is a multicolour effect.
#[derive(Clone, Copy, Debug)]
pub struct LightingMode {
    pub id: u8,
    pub en: &'static str,
    pub palette: bool,
    pub preview: Preview,
}

/// How an effect could be previewed (used by future TUI/web UI).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preview {
    Solid,
    Pulse,
    Rainbow,
    Stripes,
    Dots,
    Sweep,
}

pub struct LightingZone {
    pub en: &'static str,
    pub modes: Vec<LightingMode>,
    pub speed: bool,
    pub direction: bool,
    /// Palette index 0 means "multicolour" in this zone.
    pub multicolor_index0: bool,
}

const fn m(id: u8, en: &'static str, palette: bool, preview: Preview) -> LightingMode {
    LightingMode {
        id,
        en,
        palette,
        preview,
    }
}

const KEY_MODES: [LightingMode; 15] = [
    m(12, "Static", true, Preview::Solid),
    m(0, "Drift", true, Preview::Sweep),
    m(1, "Snow", true, Preview::Dots),
    m(2, "Blossom", true, Preview::Pulse),
    m(3, "Sine", true, Preview::Stripes),
    m(4, "Clouds", false, Preview::Rainbow),
    m(5, "Shadow", false, Preview::Rainbow),
    m(6, "Shine", false, Preview::Rainbow),
    m(7, "Pane", false, Preview::Rainbow),
    m(8, "Ripple", false, Preview::Rainbow),
    m(9, "Flowers", false, Preview::Rainbow),
    m(10, "Rain", true, Preview::Stripes),
    m(13, "Rainbow", false, Preview::Rainbow),
    m(14, "Laser", true, Preview::Sweep),
    m(15, "Waves", true, Preview::Pulse),
];

const BAR_MODES: [LightingMode; 8] = [
    m(0, "Static", true, Preview::Solid),
    m(1, "Breathing", true, Preview::Pulse),
    m(2, "Marquee", false, Preview::Stripes),
    m(3, "Rainbow", false, Preview::Rainbow),
    m(4, "Colour cycle", false, Preview::Rainbow),
    m(5, "Laser", false, Preview::Sweep),
    m(6, "Reacts to keys", true, Preview::Pulse),
    m(7, "Follow keys", false, Preview::Rainbow),
];

const INDICATOR_MODES: [LightingMode; 2] = [
    m(0, "Static", true, Preview::Solid),
    m(1, "Follow keys", false, Preview::Rainbow),
];

/// Zones and their effects. `count` from the lighting-area query is the number
/// of effects the zone supports, which hides the optional modes.
pub fn lighting_zone(area: u8, count: u8) -> LightingZone {
    match area {
        0 => LightingZone {
            en: "Keys",
            modes: KEY_MODES.to_vec(),
            speed: true,
            direction: true,
            multicolor_index0: true,
        },
        1 => LightingZone {
            en: "Side light bar",
            modes: BAR_MODES
                .iter()
                .copied()
                .filter(|x| x.id < 6 || (x.id == 6 && count > 8) || (x.id == 7 && count > 7))
                .collect(),
            speed: true,
            direction: false,
            multicolor_index0: false,
        },
        _ => LightingZone {
            en: "Indicator",
            modes: INDICATOR_MODES
                .iter()
                .copied()
                .filter(|x| x.id == 0 || count > 2)
                .collect(),
            speed: false,
            direction: false,
            multicolor_index0: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn german_legends() {
        assert_eq!(key_label(0x1c, true), "Z");
        assert_eq!(key_label(0x1c, false), "Y");
        assert_eq!(key_label(0x2f, true), "Ü");
        assert_eq!(key_label(0x1e, false), "1");
        assert_eq!(key_label(0x3a, false), "F1");
        assert_eq!(key_label(0xf101, false), "Fn");
    }

    #[test]
    fn key_sizes() {
        assert_eq!(key_size(1), (1.0, 1.0, false));
        assert_eq!(key_size(11), (1.5, 2.0, true));
        assert_eq!(key_size(9), (6.25, 1.0, false));
    }
}

#[cfg(test)]
mod prop_tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// `key_label` is total: every u16 code and both legend tables
        /// produce a string without panicking.
        #[test]
        fn key_label_total(code in any::<u16>(), german in any::<bool>()) {
            let label = key_label(code, german);
            prop_assert!(label.len() <= 16);
        }

        /// Letters/digits decode to themselves; unknown codes never panic.
        #[test]
        fn key_label_letters(code in 0x04u16..=0x1d, german in any::<bool>()) {
            let label = key_label(code, german);
            if german && (code == 0x1c || code == 0x1d) {
                prop_assert!(label == "Z" || label == "Y");
            } else {
                prop_assert_eq!(label, ((b'A' + (code - 4) as u8) as char).to_string());
            }
        }

        /// `key_size` is total and only ever returns documented geometry.
        #[test]
        fn key_size_bounds(code in any::<u8>()) {
            let (w, h, iso) = key_size(code);
            prop_assert!([1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 6.25].contains(&w));
            prop_assert!(h == 1.0 || h == 2.0);
            prop_assert_eq!(iso, code == 11);
        }

        /// `max_travel` only ever returns the two documented limits.
        #[test]
        fn max_travel_values(id in any::<u16>()) {
            let t = max_travel(id);
            prop_assert!(t == 3.4 || t == 3.5);
            prop_assert_eq!(t == 3.5, id == UFO_SWITCH);
        }

        /// `build_layout` preserves slot count and applies `key_size`.
        #[test]
        fn build_layout_shape(
            slots in prop::collection::vec(
                (any::<u8>(), any::<u8>(), 0.0f32..=40.0, 0.0f32..=20.0, any::<u8>()),
                0..=32,
            ),
            code in any::<u16>(),
            german in any::<bool>(),
        ) {
            let slots: Vec<KeySlot> = slots
                .into_iter()
                .map(|(row, col, x, y, size)| KeySlot { row, col, x, y, size })
                .collect();
            let keys = build_layout(&slots, &|_, _| code, german);
            prop_assert_eq!(keys.len(), slots.len());
            for (k, s) in keys.iter().zip(slots.iter()) {
                let (w, h, iso) = key_size(s.size);
                prop_assert_eq!((k.w, k.h, k.iso_enter), (w, h, iso));
                prop_assert_eq!(&k.label, &key_label(code, german));
            }
        }
    }
}
