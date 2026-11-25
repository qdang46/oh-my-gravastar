//! GravaStar Mercury HE keyboards ("v2" web-driver protocol).
//!
//! Every request is a 64-byte output report with report id 0:
//! `[category, command, args…]`. The keyboard answers with a 64-byte input
//! report that echoes category and command. Multi-byte values are little
//! endian; distances are transmitted in micrometres. There is no commit
//! command: the firmware persists every write by itself.
//! See `docs/protocol-keyboard.md`.
//!
//! Ported from `orbit-gravastar/src/protocol/keyboard.rs` (MIT).
//!
//! Categories 6 (HigherKey / advanced keys), 7 (Macro), the category-3
//! keycode write commands and `02 0E` (macro space info) were extracted
//! from the official v2 web-driver JavaScript
//! (`docs/research/he-macros-research.md`, mirror under
//! `docs/research/he-webapp/v2/`). **No HE keyboard was available for
//! hardware verification: every command added for them is inferred from
//! the vendor JS and is hardware-unverified.** Treat write paths as
//! code-complete but unproven until exercised on a board.
//!
//! # Safety blacklist (docs/plan.md §2 — never implemented, even later)
//!
//! - `02 01` factory reset (category 2, command 1)
//! - category `08` firmware update / bootloader
//! - `0A 01 01 FF` settings wipe at power-off
//! - `10 02` gamepad mode (category 16)
//! - `02 0F 01` keyboard restart
//! - `02 09` default switch
//! - categories `0x0C` (display), `0x0E` (voice), `0x0F` (haptic)
//! - category `0A` custom command passthrough remains unimplemented
//! - keycodes `0xF200` / `0xF203` are rejected on every write path
//!   (keymap row/single writes and macro actions) — see protocol doc

use std::thread::sleep;
use std::time::Duration;

use anyhow::{ensure, Result};
use omg_hid::{transfer, Link, NoAnswer};
use serde::{Deserialize, Serialize};

/// Vendor ids the official driver routes to this protocol.
pub const VIDS: [u16; 2] = [0x1ca6, 0x31e3];
pub const USAGE_PAGE: u16 = 0xffb0;

/// Product ids the official web driver routes to the v2 (HE) protocol.
pub const PIDS: [u16; 23] = [
    11272, 11273, 11282, 11275, 11276, 11288, 11289, 11296, 11297, 11290, 11291, 11292, 11293,
    11274, 11278, 11277, 4896, 11283, 11284, 11305, 11306, 11300, 11298,
];

const DEVICE: u8 = 1;
const GLOBAL: u8 = 2;
const LAYOUT: u8 = 3;
const PERFORMANCE: u8 = 4;
const LIGHTING: u8 = 5;
const HIGHER_KEY: u8 = 6;
const MACRO: u8 = 7;

const CONFIG: u8 = 3;
const SYSTEM: u8 = 4;
const REPORT_RATE: u8 = 5;
const CALIBRATION: u8 = 6;
const LIGHTING_AREAS: u8 = 8;
const RT_PRECISION: u8 = 12;
const LIGHTING_SLEEP: u8 = 13;
const MACRO_SPACE_INFO: u8 = 14;

const READ_LIST: u8 = 0;
const READ: u8 = 1;
const WRITE: u8 = 2;

// Category 3 (LayoutAndKey) sub-commands.
const KEY_ROW_READ: u8 = 1;
const KEY_ROW_WRITE: u8 = 2;
const KEY_CODE_READ: u8 = 3;
const KEY_CODE_WRITE: u8 = 4;
const KEY_LAYOUT_STYLE: u8 = 5;
const KEY_LAYOUT_DEFAULT: u8 = 6;

// Category 6 (HigherKey) operation byte.
const HK_READ: u8 = 1;
const HK_WRITE: u8 = 2;

// Category 7 (Macro) sub-commands.
const MACRO_MODE_READ: u8 = 1;
const MACRO_MODE_WRITE: u8 = 2;
const MACRO_DATA_READ: u8 = 3;
const MACRO_DATA_WRITE: u8 = 4;

pub const REPORT_RATES: [&str; 7] = ["8K", "4K", "2K", "1K", "500", "250", "125"];

/// RGB colour. The palette wire order is B, G, R, H (hue/unused byte).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Clone, Debug, Default)]
pub struct KeyboardInfo {
    pub firmware: String,
    pub pcb: String,
    pub build_time: String,
    pub protocol: String,
    pub board_id: u32,
}

/// Actuation settings of one key.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct KeyPerf {
    /// 0 = fixed actuation, 1 = rapid trigger.
    pub mode: u8,
    pub normal_press: f32,
    pub normal_release: f32,
    pub rt_first_touch: f32,
    pub rt_press: f32,
    pub rt_release: f32,
    pub press_deadzone: f32,
    pub release_deadzone: f32,
    // Switch characteristics — echoed back unchanged on write.
    pub axis: u8,
    pub calibrate: u8,
    pub axis_v2_id: u16,
    pub axis_range_max: u16,
    pub axis_coefficient: u16,
}

pub const MODE_FIXED: u8 = 0;
pub const MODE_RAPID: u8 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LightingBase {
    pub on: bool,
    pub mode: u8,
    pub brightness: u8,
    pub speed: u8,
    pub direction: u8,
    /// Index into the 8-entry palette.
    pub color_index: u8,
}

#[derive(Clone, Copy, Debug)]
pub struct LightingArea {
    pub index: u8,
    /// Number of effects the zone supports.
    pub count: u8,
}

/// Physical key geometry as reported by the keyboard.
#[derive(Clone, Copy, Debug)]
pub struct KeySlot {
    pub row: u8,
    pub col: u8,
    /// Position in key units.
    pub x: f32,
    pub y: f32,
    /// Width code, see `omg_model::key_size`.
    pub size: u8,
}

// ── Category 6: HigherKey (advanced keys) ─────────────────────────────
//
// All layouts below are inferred from the vendor v2 web-driver JS
// (`docs/research/he-macros-research.md`) and are hardware-unverified.
// Request header: `[6, op, row, col, mode]`; op 1 = read, 2 = write.
// Mode byte: 0 NONE, 1 DKS, 2 MPT, 3 MT, 4 TGL, 5 END, 6 SOCD, 7 RS.
// SOCD and RS are the only two-packet writes: each packet names the
// *other* key's coordinates and swaps the keycode order (cross-linked
// pair inside the firmware).

/// HigherKey mode byte values (vendor `kw` enum).
pub const HK_NONE: u8 = 0;
pub const HK_DKS: u8 = 1;
pub const HK_MPT: u8 = 2;
pub const HK_MT: u8 = 3;
pub const HK_TGL: u8 = 4;
pub const HK_END: u8 = 5;
pub const HK_SOCD: u8 = 6;
pub const HK_RS: u8 = 7;

/// DKS (dual-key / rolling?) parameters: 4 keycodes, 4 trigger points
/// (raw bytes) and 2 deadband distances in mm (wire: µm).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DksParams {
    pub kcs: [u16; 4],
    pub trps: [u8; 4],
    /// Deadband distances in mm (transmitted ×1000 as u16 µm).
    pub dbs: [f32; 2],
}

/// MPT parameters: 3 keycodes and 3 deadband distances in mm.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MptParams {
    pub kcs: [u16; 3],
    pub dbs: [f32; 3],
}

/// MT (multi-tap?) parameters: 2 keycodes and a raw u16 time
/// (units unverified — the driver passes the value through unchanged).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MtParams {
    pub kcs: [u16; 2],
    pub time: u16,
}

/// TGL (toggle) parameters: 1 keycode and a raw u16 time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TglParams {
    pub kcs: u16,
    pub time: u16,
}

/// END parameters: 2 keycodes and a raw u16 delay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EndParams {
    pub kcs: [u16; 2],
    pub delay: u16,
}

/// SOCD direction selection (vendor `xw` enum). The wire byte written is
/// the *pair* of direction nibbles: Cover=[0,0], PriorityA=[1,2],
/// PriorityB=[2,1], Neutral=[3,3] — first goes to the primary key's
/// packet, second to the partner key's packet.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SocdDirection {
    #[default]
    Cover,
    PriorityA,
    PriorityB,
    Neutral,
}

impl SocdDirection {
    /// `(dir for the key at row,col, dir for the key at row2,col2)`.
    fn pair(self) -> (u8, u8) {
        match self {
            Self::Cover => (0, 0),
            Self::PriorityA => (1, 2),
            Self::PriorityB => (2, 1),
            Self::Neutral => (3, 3),
        }
    }

    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Cover,
            1 => Self::PriorityA,
            2 => Self::PriorityB,
            3 => Self::Neutral,
            _ => return None,
        })
    }
}

/// SOCD parameters for the key at `(row, col)`; `row2`/`col2` name the
/// partner key the pair is cross-linked with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SocdParams {
    pub row2: u8,
    pub col2: u8,
    pub kcs: [u16; 2],
    pub delay: u16,
    pub direction: SocdDirection,
}

/// RS (rapid-swap?) parameters — same cross-linked two-packet shape as
/// SOCD but without the direction byte.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RsParams {
    pub row2: u8,
    pub col2: u8,
    pub kcs: [u16; 2],
    pub delay: u16,
}

/// Write-side HigherKey configuration for one key. `row`/`col` of the
/// primary key are method arguments, not part of the params.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HigherKeyParams {
    None,
    Dks(DksParams),
    Mpt(MptParams),
    Mt(MtParams),
    Tgl(TglParams),
    End(EndParams),
    Socd(SocdParams),
    Rs(RsParams),
}

impl HigherKeyParams {
    pub fn mode(&self) -> u8 {
        match self {
            Self::None => HK_NONE,
            Self::Dks(_) => HK_DKS,
            Self::Mpt(_) => HK_MPT,
            Self::Mt(_) => HK_MT,
            Self::Tgl(_) => HK_TGL,
            Self::End(_) => HK_END,
            Self::Socd(_) => HK_SOCD,
            Self::Rs(_) => HK_RS,
        }
    }

    /// Every keycode carried by this config (for blacklist checks).
    pub fn key_codes(&self) -> Vec<u16> {
        match self {
            Self::None => Vec::new(),
            Self::Dks(d) => d.kcs.to_vec(),
            Self::Mpt(m) => m.kcs.to_vec(),
            Self::Mt(m) => m.kcs.to_vec(),
            Self::Tgl(t) => vec![t.kcs],
            Self::End(e) => e.kcs.to_vec(),
            Self::Socd(s) => s.kcs.to_vec(),
            Self::Rs(r) => r.kcs.to_vec(),
        }
    }
}

/// Decoded HigherKey state of one key (read reply or write echo).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HigherKeyConfig {
    None {
        row: u8,
        col: u8,
    },
    Dks {
        row: u8,
        col: u8,
        params: DksParams,
    },
    Mpt {
        row: u8,
        col: u8,
        params: MptParams,
    },
    Mt {
        row: u8,
        col: u8,
        params: MtParams,
    },
    Tgl {
        row: u8,
        col: u8,
        params: TglParams,
    },
    End {
        row: u8,
        col: u8,
        params: EndParams,
    },
    Socd {
        row: u8,
        col: u8,
        params: SocdParams,
    },
    Rs {
        row: u8,
        col: u8,
        params: RsParams,
    },
}

// ── Category 7: Macro ─────────────────────────────────────────────────

/// One macro action, packed into a u32 LE word:
/// bit 31 = status flag (1 = key-up/release — semantics unverified),
/// bits 30..16 = delay (≤ 32767, units unverified), bits 15..0 = HID
/// keycode. Keycodes `0xF200`/`0xF203` are blacklisted everywhere.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroAction {
    pub status: bool,
    pub delay: u16,
    pub key_code: u16,
}

/// Keycodes that must never be written (long-press = factory reset /
/// calibration). Enforced on keymap, higher-key and macro write paths.
pub fn keycode_blacklisted(code: u16) -> bool {
    matches!(code, 0xF200 | 0xF203)
}

impl MacroAction {
    /// u32 LE action word, mirroring the vendor encoder's limits.
    pub fn encode(&self) -> Result<u32> {
        ensure!(
            self.delay <= 32767,
            "macro delay {} exceeds maximum 32767",
            self.delay
        );
        ensure!(
            !keycode_blacklisted(self.key_code),
            "macro keycode {:#06x} is blacklisted",
            self.key_code
        );
        Ok(((self.status as u32) << 31)
            | ((self.delay as u32) << 16)
            | (self.key_code as u32 & 0xFFFF))
    }

    /// Inverse of [`MacroAction::encode`]; accepts any u32.
    pub fn decode(word: u32) -> Self {
        Self {
            status: word & 0x8000_0000 != 0,
            delay: ((word >> 16) & 0x7FFF) as u16,
            key_code: (word & 0xFFFF) as u16,
        }
    }
}

/// Per-slot macro header (`07 01`/`07 02`). `mode` is the UI macro mode
/// byte (0–3 observed; wire semantics unverified).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroMode {
    pub macro_id: u8,
    pub valid: bool,
    pub act_num: u16,
    pub rep_num: u16,
    pub mode: u8,
}

/// One page of macro action data: up to 15 actions per 64-byte report.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroPage {
    pub macro_id: u8,
    pub offset: u8,
    pub actions: Vec<MacroAction>,
}

/// `02 0E 00` reply: macro storage capacity. Naming of `macro_number`
/// (total vs used slots) is ambiguous — verify on hardware.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroSpaceInfo {
    pub macro_count: u8,
    pub macro_number: u16,
}

/// `03 06` reply: factory-default keycodes of one row for a
/// system/function selector.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DefaultKeyLayout {
    pub system: u8,
    pub func: u8,
    pub row: u8,
    pub key_codes: [u16; 21],
}

pub struct HeKeyboard {
    link: Box<dyn Link>,
}

fn u16le(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

fn rd16(d: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([d[i], d[i + 1]])
}

fn um(mm: f32) -> [u8; 2] {
    u16le((mm * 1000.0).round().clamp(0.0, 65535.0) as u16)
}

fn mm(d: &[u8], i: usize) -> f32 {
    rd16(d, i) as f32 / 1000.0
}

/// Parses one `03 05` geometry reply row into slots.
fn parse_key_slots(row: u8, d: &[u8]) -> Vec<KeySlot> {
    let mut slots = Vec::new();
    for col in 0..21usize {
        let v = rd16(d, 3 + 2 * col);
        let size = (v & 15) as u8;
        if v == 0 || size == 0 {
            continue;
        }
        slots.push(KeySlot {
            row,
            col: col as u8,
            y: ((v >> 11) & 31) as f32 / 4.0,
            x: ((v >> 4) & 127) as f32 / 4.0,
            size,
        });
    }
    slots
}

/// Parses one `04 01` reply into per-key performance settings.
fn parse_key_perf(d: &[u8]) -> KeyPerf {
    KeyPerf {
        mode: d[4],
        normal_press: mm(d, 5),
        normal_release: mm(d, 7),
        rt_first_touch: mm(d, 9),
        rt_press: mm(d, 11),
        rt_release: mm(d, 13),
        press_deadzone: mm(d, 15),
        release_deadzone: mm(d, 17),
        axis: d[19],
        calibrate: d[20],
        axis_v2_id: rd16(d, 21),
        axis_range_max: rd16(d, 23),
        axis_coefficient: rd16(d, 25),
    }
}

/// Builds the `04 02` write packet for one key's performance settings.
fn key_perf_packet(row: u8, col: u8, p: &KeyPerf) -> Vec<u8> {
    let mut pkt = vec![PERFORMANCE, 2, row, col, p.mode];
    for v in [
        p.normal_press,
        p.normal_release,
        p.rt_first_touch,
        p.rt_press,
        p.rt_release,
        p.press_deadzone,
        p.release_deadzone,
    ] {
        pkt.extend_from_slice(&um(v));
    }
    pkt.extend_from_slice(&[p.axis, p.calibrate]);
    for v in [p.axis_v2_id, p.axis_range_max, p.axis_coefficient] {
        pkt.extend_from_slice(&u16le(v));
    }
    pkt
}

// ── Category 6: HigherKey packet builders / parsers ───────────────────

/// Builds the write packet(s) for one key's HigherKey config.
/// SOCD and RS produce two cross-linked packets (sent in order).
fn higher_key_packets(row: u8, col: u8, p: &HigherKeyParams) -> Vec<Vec<u8>> {
    let mode = p.mode();
    let header = |r: u8, c: u8| vec![HIGHER_KEY, HK_WRITE, r, c, mode];
    match p {
        HigherKeyParams::None => vec![header(row, col)],
        HigherKeyParams::Dks(d) => {
            let mut pkt = header(row, col);
            for kc in d.kcs {
                pkt.extend_from_slice(&u16le(kc));
            }
            pkt.extend_from_slice(&d.trps);
            for db in d.dbs {
                pkt.extend_from_slice(&um(db));
            }
            vec![pkt]
        }
        HigherKeyParams::Mpt(m) => {
            let mut pkt = header(row, col);
            for kc in m.kcs {
                pkt.extend_from_slice(&u16le(kc));
            }
            for db in m.dbs {
                pkt.extend_from_slice(&um(db));
            }
            vec![pkt]
        }
        HigherKeyParams::Mt(m) => {
            let mut pkt = header(row, col);
            for kc in m.kcs {
                pkt.extend_from_slice(&u16le(kc));
            }
            pkt.extend_from_slice(&u16le(m.time));
            vec![pkt]
        }
        HigherKeyParams::Tgl(t) => {
            let mut pkt = header(row, col);
            pkt.extend_from_slice(&u16le(t.kcs));
            pkt.extend_from_slice(&u16le(t.time));
            vec![pkt]
        }
        HigherKeyParams::End(e) => {
            let mut pkt = header(row, col);
            for kc in e.kcs {
                pkt.extend_from_slice(&u16le(kc));
            }
            pkt.extend_from_slice(&u16le(e.delay));
            vec![pkt]
        }
        HigherKeyParams::Socd(s) => {
            let (dir_a, dir_b) = s.direction.pair();
            let mut a = header(row, col);
            a.extend_from_slice(&[s.row2, s.col2]);
            for kc in s.kcs {
                a.extend_from_slice(&u16le(kc));
            }
            a.extend_from_slice(&u16le(s.delay));
            a.push(dir_a);
            // Partner packet names this key and swaps the keycode order.
            let mut b = header(s.row2, s.col2);
            b.extend_from_slice(&[row, col]);
            for kc in s.kcs.iter().rev() {
                b.extend_from_slice(&u16le(*kc));
            }
            b.extend_from_slice(&u16le(s.delay));
            b.push(dir_b);
            vec![a, b]
        }
        HigherKeyParams::Rs(r) => {
            let mut a = header(row, col);
            a.extend_from_slice(&[r.row2, r.col2]);
            for kc in r.kcs {
                a.extend_from_slice(&u16le(kc));
            }
            a.extend_from_slice(&u16le(r.delay));
            let mut b = header(r.row2, r.col2);
            b.extend_from_slice(&[row, col]);
            for kc in r.kcs.iter().rev() {
                b.extend_from_slice(&u16le(*kc));
            }
            b.extend_from_slice(&u16le(r.delay));
            vec![a, b]
        }
    }
}

/// Decodes a `[6, op, row, col, mode, …]` reply (read or write echo)
/// into the per-mode config. Returns `None` for unknown mode bytes or
/// undefined SOCD direction values.
fn parse_higher_key(d: &[u8]) -> Option<HigherKeyConfig> {
    let row = d[2];
    let col = d[3];
    Some(match d[4] {
        HK_NONE => HigherKeyConfig::None { row, col },
        HK_DKS => HigherKeyConfig::Dks {
            row,
            col,
            params: DksParams {
                kcs: [rd16(d, 5), rd16(d, 7), rd16(d, 9), rd16(d, 11)],
                trps: [d[13], d[14], d[15], d[16]],
                dbs: [mm(d, 17), mm(d, 19)],
            },
        },
        HK_MPT => HigherKeyConfig::Mpt {
            row,
            col,
            params: MptParams {
                kcs: [rd16(d, 5), rd16(d, 7), rd16(d, 9)],
                dbs: [mm(d, 11), mm(d, 13), mm(d, 15)],
            },
        },
        HK_MT => HigherKeyConfig::Mt {
            row,
            col,
            params: MtParams {
                kcs: [rd16(d, 5), rd16(d, 7)],
                time: rd16(d, 9),
            },
        },
        HK_TGL => HigherKeyConfig::Tgl {
            row,
            col,
            params: TglParams {
                kcs: rd16(d, 5),
                time: rd16(d, 7),
            },
        },
        HK_END => HigherKeyConfig::End {
            row,
            col,
            params: EndParams {
                kcs: [rd16(d, 5), rd16(d, 7)],
                delay: rd16(d, 9),
            },
        },
        HK_SOCD => HigherKeyConfig::Socd {
            row,
            col,
            params: SocdParams {
                row2: d[5],
                col2: d[6],
                kcs: [rd16(d, 7), rd16(d, 9)],
                delay: rd16(d, 11),
                direction: SocdDirection::from_u8(d[13])?,
            },
        },
        HK_RS => HigherKeyConfig::Rs {
            row,
            col,
            params: RsParams {
                row2: d[5],
                col2: d[6],
                kcs: [rd16(d, 7), rd16(d, 9)],
                delay: rd16(d, 11),
            },
        },
        _ => return None,
    })
}

// ── Category 7: Macro packet helpers ──────────────────────────────────

/// Builds the `03 02` whole-row keymap write packet (21 × u16 LE).
fn key_row_write_packet(layer: u8, row: u8, codes: &[u16; 21]) -> Vec<u8> {
    let mut pkt = vec![LAYOUT, KEY_ROW_WRITE, layer, row];
    for &c in codes {
        pkt.extend_from_slice(&u16le(c));
    }
    pkt
}

/// Builds the `03 04` single-key write packet.
fn key_code_write_packet(layer: u8, row: u8, col: u8, code: u16) -> [u8; 7] {
    let [lo, hi] = u16le(code);
    [LAYOUT, KEY_CODE_WRITE, layer, row, col, lo, hi]
}

/// Builds the `03 06` default-layout query (`system << 4 | func`, row).
fn default_layout_packet(system: u8, func: u8, row: u8) -> [u8; 4] {
    [LAYOUT, KEY_LAYOUT_DEFAULT, (system << 4) | func, row]
}

/// Builds the `07 02` macro mode write packet.
fn macro_mode_packet(m: &MacroMode) -> Vec<u8> {
    let mut pkt = vec![MACRO, MACRO_MODE_WRITE, m.macro_id, m.valid as u8];
    pkt.extend_from_slice(&u16le(m.act_num));
    pkt.extend_from_slice(&u16le(m.rep_num));
    pkt.push(m.mode);
    pkt
}

/// Builds the `07 04` write packet for one page of macro actions.
/// The vendor sends up to 15 actions (60 bytes) per packet; `offset`
/// is the page index. Fewer actions simply produce a shorter packet.
fn macro_data_packet(id: u8, offset: u8, actions: &[MacroAction]) -> Result<Vec<u8>> {
    ensure!(
        actions.len() <= 15,
        "macro page holds at most 15 actions, got {}",
        actions.len()
    );
    let mut pkt = vec![MACRO, MACRO_DATA_WRITE, id, offset];
    for a in actions {
        pkt.extend_from_slice(&a.encode()?.to_le_bytes());
    }
    Ok(pkt)
}

/// Decodes a `07 03`/`07 04` reply: `macroId` at 2, `offset` at 3,
/// then up to 15 u32-LE action words from byte 4.
fn parse_macro_page(d: &[u8]) -> MacroPage {
    let actions = (0..15)
        .map(|i| {
            let o = 4 + 4 * i;
            MacroAction::decode(u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]))
        })
        .collect();
    MacroPage {
        macro_id: d[2],
        offset: d[3],
        actions,
    }
}

impl HeKeyboard {
    pub fn new(link: Box<dyn Link>) -> Self {
        Self { link }
    }

    pub fn matches(vid: u16, pid: u16, usage_page: u16) -> bool {
        VIDS.contains(&vid) && PIDS.contains(&pid) && usage_page == USAGE_PAGE
    }

    /// Sends a request and returns the answer whose first `match_len` bytes echo the request.
    fn request_matching(
        &mut self,
        payload: &[u8],
        timeout_ms: u64,
        match_len: usize,
    ) -> Result<[u8; 64]> {
        let mut pkt = [0u8; 64];
        let n = payload.len().min(64);
        pkt[..n].copy_from_slice(&payload[..n]);
        for _ in 0..3 {
            let answer = transfer(
                self.link.as_mut(),
                0,
                &pkt,
                Duration::from_millis(timeout_ms),
                |r| r.len() >= match_len && r[..match_len] == pkt[..match_len],
            )?;
            if let Some(r) = answer {
                let mut out = [0u8; 64];
                let m = r.len().min(64);
                out[..m].copy_from_slice(&r[..m]);
                return Ok(out);
            }
        }
        Err(NoAnswer(format!("{:02x} {:02x}", pkt[0], pkt[1])).into())
    }

    /// Request matched on category and command.
    fn request(&mut self, payload: &[u8], timeout_ms: u64) -> Result<[u8; 64]> {
        self.request_matching(payload, timeout_ms, 2)
    }

    fn req(&mut self, payload: &[u8]) -> Result<[u8; 64]> {
        self.request(payload, 600)
    }

    // ── Device ─────────────────────────────────────────────────────────

    pub fn info(&mut self) -> Result<KeyboardInfo> {
        let proto = self.req(&[DEVICE, 1])?;
        let d = self.req(&[DEVICE, 2])?;
        let ts: String = d[29..]
            .iter()
            .take_while(|&&b| b != 0)
            .map(|&b| b as char)
            .collect();
        let build_time = if ts.len() == 16 && ts.as_bytes()[10] == b':' {
            format!("{}-{}-{} {}", &ts[0..4], &ts[4..6], &ts[6..8], &ts[8..])
        } else {
            ts
        };
        let join = |b: &[u8], sep: &str| {
            b.iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(sep)
        };
        Ok(KeyboardInfo {
            firmware: join(&d[8..12], "."),
            pcb: join(&d[12..16], "-"),
            build_time,
            protocol: format!("{}.{}", proto[2], proto[3]),
            board_id: u32::from_be_bytes([d[4], d[5], d[6], d[7]]),
        })
    }

    // ── Layout ─────────────────────────────────────────────────────────

    /// Physical key geometry. Each matrix column of a row is a packed u16:
    /// y = bits 15-11, x = bits 10-4 (both in quarter keys), size = bits 3-0.
    /// A reply with byte 2 = `0xFF` ends the table.
    pub fn key_slots(&mut self) -> Result<Vec<KeySlot>> {
        let mut slots = Vec::new();
        for row in 0..8u8 {
            let d = self.req(&[LAYOUT, KEY_LAYOUT_STYLE, row])?;
            if d[2] == 0xff {
                break;
            }
            slots.extend(parse_key_slots(row, &d));
        }
        Ok(slots)
    }

    /// 16-bit keycodes of one matrix row (21 columns).
    pub fn key_codes(&mut self, layer: u8, row: u8) -> Result<[u16; 21]> {
        let d = self.req(&[LAYOUT, KEY_ROW_READ, layer, row])?;
        Ok(std::array::from_fn(|i| rd16(&d, 4 + 2 * i)))
    }

    /// Writes all 21 keycodes of one matrix row at once (`03 02`).
    /// Keycodes `0xF200`/`0xF203` are rejected (blacklist).
    /// Hardware-unverified: inferred from the vendor JS.
    pub fn set_key_codes(&mut self, layer: u8, row: u8, codes: &[u16; 21]) -> Result<()> {
        for &c in codes {
            ensure!(!keycode_blacklisted(c), "keycode {c:#06x} is blacklisted");
        }
        self.req(&key_row_write_packet(layer, row, codes))
            .map(|_| ())
    }

    /// Reads the keycode of a single key (`03 03`).
    /// Hardware-unverified: inferred from the vendor JS.
    pub fn key_code(&mut self, layer: u8, row: u8, col: u8) -> Result<u16> {
        let d = self.request_matching(&[LAYOUT, KEY_CODE_READ, layer, row, col], 600, 5)?;
        Ok(rd16(&d, 5))
    }

    /// Writes the keycode of a single key (`03 04`).
    /// Keycodes `0xF200`/`0xF203` are rejected (blacklist).
    /// Hardware-unverified: inferred from the vendor JS.
    pub fn set_key_code(&mut self, layer: u8, row: u8, col: u8, code: u16) -> Result<()> {
        ensure!(
            !keycode_blacklisted(code),
            "keycode {code:#06x} is blacklisted"
        );
        self.req(&key_code_write_packet(layer, row, col, code))
            .map(|_| ())
    }

    /// Factory-default keycodes of one row for a system/function
    /// selector (`03 06`, selector byte = `system << 4 | func`).
    /// Hardware-unverified: inferred from the vendor JS.
    pub fn default_key_layout(
        &mut self,
        system: u8,
        func: u8,
        row: u8,
    ) -> Result<DefaultKeyLayout> {
        ensure!(system < 16 && func < 16, "system/func must fit a nibble");
        let d = self.request_matching(&default_layout_packet(system, func, row), 600, 4)?;
        Ok(DefaultKeyLayout {
            system: d[2] >> 4,
            func: d[2] & 15,
            row: d[3],
            key_codes: std::array::from_fn(|i| rd16(&d, 4 + 2 * i)),
        })
    }

    // ── Global ─────────────────────────────────────────────────────────

    pub fn report_rates(&mut self) -> Result<Vec<u8>> {
        let d = self.req(&[GLOBAL, REPORT_RATE, READ_LIST])?;
        let n = (d[3] as usize).min(16);
        Ok(d[4..4 + n].to_vec())
    }

    pub fn report_rate(&mut self) -> Result<u8> {
        Ok(self.req(&[GLOBAL, REPORT_RATE, READ])?[3])
    }

    /// The keyboard restarts afterwards and may drop off the bus before answering.
    pub fn set_report_rate(&mut self, id: u8) -> Result<()> {
        match self.request(&[GLOBAL, REPORT_RATE, WRITE, id], 800) {
            Err(e) if e.is::<NoAnswer>() => Ok(()),
            other => other.map(|_| ()),
        }
    }

    pub fn profile_count(&mut self) -> Result<u8> {
        Ok(self.req(&[GLOBAL, CONFIG, READ_LIST])?[3])
    }

    pub fn profile(&mut self) -> Result<u8> {
        Ok(self.req(&[GLOBAL, CONFIG, READ])?[3])
    }

    pub fn set_profile(&mut self, index: u8) -> Result<()> {
        self.request(&[GLOBAL, CONFIG, WRITE, index], 1500)?;
        // The firmware reloads the profile; give it a moment before reading again.
        sleep(Duration::from_millis(1500));
        Ok(())
    }

    /// 0 = Windows, 1 = macOS.
    pub fn system(&mut self) -> Result<u8> {
        Ok(self.req(&[GLOBAL, SYSTEM, READ])?[3])
    }

    pub fn set_system(&mut self, value: u8) -> Result<()> {
        self.req(&[GLOBAL, SYSTEM, WRITE, value]).map(|_| ())
    }

    /// Finest rapid-trigger step in millimetres.
    pub fn rt_precision(&mut self) -> Result<f32> {
        Ok(self.req(&[GLOBAL, RT_PRECISION, 0])?[3] as f32 / 1000.0)
    }

    pub fn lighting_areas(&mut self) -> Result<Vec<LightingArea>> {
        let d = self.req(&[GLOBAL, LIGHTING_AREAS, 0])?;
        Ok((0..(d[3] as usize).min(14))
            .map(|i| LightingArea {
                index: d[4 + 4 * i],
                count: d[5 + 4 * i],
            })
            .collect())
    }

    /// Lighting sleep timeout in minutes (0 = never).
    pub fn lighting_sleep(&mut self) -> Result<u16> {
        Ok(rd16(&self.req(&[GLOBAL, LIGHTING_SLEEP, 1])?, 3))
    }

    pub fn set_lighting_sleep(&mut self, minutes: u16) -> Result<()> {
        let [lo, hi] = u16le(minutes);
        self.req(&[GLOBAL, LIGHTING_SLEEP, 0, lo, hi]).map(|_| ())
    }

    /// Start (true) or finish (false) travel calibration.
    pub fn calibration(&mut self, start: bool) -> Result<()> {
        self.request(&[GLOBAL, CALIBRATION, if start { 0 } else { 1 }], 2000)
            .map(|_| ())
    }

    /// Macro storage capacity (`02 0E 00`). Query this before allocating
    /// macro ids. Hardware-unverified: inferred from the vendor JS.
    pub fn macro_space_info(&mut self) -> Result<MacroSpaceInfo> {
        let d = self.req(&[GLOBAL, MACRO_SPACE_INFO, 0])?;
        Ok(MacroSpaceInfo {
            macro_count: d[3],
            macro_number: rd16(&d, 4),
        })
    }

    // ── Performance ────────────────────────────────────────────────────

    pub fn key_perf(&mut self, row: u8, col: u8) -> Result<KeyPerf> {
        let d = self.req(&[PERFORMANCE, 1, row, col])?;
        Ok(parse_key_perf(&d))
    }

    pub fn set_key_perf(&mut self, row: u8, col: u8, p: &KeyPerf) -> Result<()> {
        self.req(&key_perf_packet(row, col, p)).map(|_| ())
    }

    /// Live travel of every key in a matrix row (mm) and whether each key is
    /// currently actuated. Used for the travel display while keys are pressed.
    pub fn live_row(&mut self, row: u8) -> Result<[(f32, bool); 21]> {
        let travel = self.request_matching(&[PERFORMANCE, 3, 1, row], 300, 4)?;
        let status = self.request_matching(&[PERFORMANCE, 3, 3, row], 300, 4)?;
        Ok(std::array::from_fn(|i| {
            (mm(&travel, 4 + 2 * i), rd16(&status, 4 + 2 * i) != 0)
        }))
    }

    // ── HigherKey (category 6, advanced keys) ──────────────────────────
    //
    // All commands below are inferred from the vendor v2 web-driver JS
    // and are hardware-unverified (no HE keyboard was available).

    /// Reads the advanced-key configuration of one key for `mode`
    /// (`HK_NONE`…`HK_RS`). The reply's own mode byte selects the decode,
    /// matching the driver.
    pub fn higher_key(&mut self, row: u8, col: u8, mode: u8) -> Result<HigherKeyConfig> {
        let d = self.request_matching(&[HIGHER_KEY, HK_READ, row, col, mode], 600, 5)?;
        parse_higher_key(&d)
            .ok_or_else(|| anyhow::anyhow!("unknown higher-key reply mode {}", d[4]))
    }

    /// Writes the advanced-key configuration of one key. SOCD and RS
    /// are two-packet cross-linked writes sent sequentially; returns the
    /// decoded echo of each packet (one entry, or two for SOCD/RS).
    pub fn set_higher_key(
        &mut self,
        row: u8,
        col: u8,
        params: &HigherKeyParams,
    ) -> Result<Vec<HigherKeyConfig>> {
        for kc in params.key_codes() {
            ensure!(
                !keycode_blacklisted(kc),
                "higher-key keycode {kc:#06x} is blacklisted"
            );
        }
        let mut out = Vec::new();
        for pkt in higher_key_packets(row, col, params) {
            let d = self.req(&pkt)?;
            out.push(
                parse_higher_key(&d)
                    .ok_or_else(|| anyhow::anyhow!("unknown higher-key reply mode {}", d[4]))?,
            );
        }
        Ok(out)
    }

    // ── Macro (category 7) ─────────────────────────────────────────────
    //
    // Hardware-unverified: inferred from the vendor JS. Read paths are
    // straightforward; write paths are code-complete but unproven.

    /// Reads the mode header of macro slot `id` (`07 01`).
    pub fn macro_mode(&mut self, id: u8) -> Result<MacroMode> {
        let d = self.request_matching(&[MACRO, MACRO_MODE_READ, id], 600, 3)?;
        Ok(MacroMode {
            macro_id: d[2],
            valid: d[3] == 1,
            act_num: rd16(&d, 4),
            rep_num: rd16(&d, 6),
            mode: d[8],
        })
    }

    /// Writes the mode header of macro slot `id` (`07 02`).
    pub fn set_macro_mode(&mut self, m: &MacroMode) -> Result<()> {
        self.req(&macro_mode_packet(m)).map(|_| ())
    }

    /// Reads one page (up to 15 actions) of macro `id` at `offset`
    /// (`07 03`).
    pub fn macro_data(&mut self, id: u8, offset: u8) -> Result<MacroPage> {
        let d = self.request_matching(&[MACRO, MACRO_DATA_READ, id, offset], 600, 4)?;
        Ok(parse_macro_page(&d))
    }

    /// Writes one page of macro actions (`07 04`). At most 15 actions
    /// per call; `offset` is the page index. Blacklisted keycodes
    /// (`0xF200`/`0xF203`) and delays > 32767 are rejected.
    /// Hardware-unverified: inferred from the vendor JS.
    pub fn set_macro_data(&mut self, id: u8, offset: u8, actions: &[MacroAction]) -> Result<()> {
        let pkt = macro_data_packet(id, offset, actions)?;
        self.req(&pkt).map(|_| ())
    }

    // ── Lighting ───────────────────────────────────────────────────────

    pub fn lighting(&mut self, area: u8) -> Result<LightingBase> {
        let d = self.req(&[LIGHTING, READ, area, 0])?;
        Ok(LightingBase {
            on: d[4] != 0,
            mode: d[5],
            brightness: d[6],
            speed: d[7],
            direction: d[8],
            color_index: d[9],
        })
    }

    pub fn set_lighting(&mut self, area: u8, l: &LightingBase) -> Result<()> {
        self.req(&[
            LIGHTING,
            WRITE,
            area,
            0,
            l.on as u8,
            l.mode,
            l.brightness,
            l.speed,
            l.direction,
            l.color_index,
        ])
        .map(|_| ())
    }

    /// The 8 preset colours a lighting mode can pick from (wire order B, G, R, H).
    pub fn palette(&mut self, area: u8) -> Result<Vec<Rgb>> {
        let d = self.req(&[LIGHTING, READ, area, 1])?;
        Ok((0..8)
            .map(|i| Rgb {
                b: d[4 + 4 * i],
                g: d[5 + 4 * i],
                r: d[6 + 4 * i],
            })
            .collect())
    }

    pub fn set_palette(&mut self, area: u8, colors: &[Rgb]) -> Result<()> {
        let mut pkt = vec![LIGHTING, WRITE, area, 1];
        for c in colors.iter().take(8) {
            pkt.extend_from_slice(&[c.b, c.g, c.r, 0]);
        }
        self.req(&pkt).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn um_mm_roundtrip() {
        let pkt = key_perf_packet(
            1,
            2,
            &KeyPerf {
                mode: MODE_RAPID,
                normal_press: 1.2345,
                normal_release: 2.0,
                rt_first_touch: 0.5,
                rt_press: 3.4,
                rt_release: 1.0,
                press_deadzone: 0.25,
                release_deadzone: 0.1,
                axis: 3,
                calibrate: 1,
                axis_v2_id: 13232,
                axis_range_max: 65535,
                axis_coefficient: 100,
            },
        );
        // Header (4) + mode + 7 u16 distances + 2 echo bytes + 3 u16 echoes.
        assert_eq!(pkt.len(), 5 + 14 + 2 + 6);
        assert_eq!(pkt[0], PERFORMANCE);
        assert_eq!(pkt[1], 2);
        assert_eq!(pkt[2], 1);
        assert_eq!(pkt[3], 2);
        assert_eq!(pkt[4], MODE_RAPID);
        assert_eq!(&pkt[5..7], &um(1.2345));
        // Axis echo fields land at packet offsets 21..27.
        assert_eq!(&pkt[21..23], &u16le(13232));
        assert_eq!(&pkt[23..25], &u16le(65535));
        assert_eq!(&pkt[25..27], &u16le(100));
    }

    #[test]
    fn parse_key_perf_decodes_distances() {
        let mut d = [0u8; 64];
        d[0] = PERFORMANCE;
        d[1] = 1;
        d[2] = 3;
        d[3] = 4;
        d[4] = MODE_FIXED;
        for (i, v) in [1.0f32, 0.5, 2.5, 1.5, 0.75, 0.25, 0.125]
            .iter()
            .enumerate()
        {
            d[5 + 2 * i..7 + 2 * i].copy_from_slice(&um(*v));
        }
        d[19] = 7;
        d[20] = 1;
        d[21..23].copy_from_slice(&u16le(13232));
        d[23..25].copy_from_slice(&u16le(3400));
        d[25..27].copy_from_slice(&u16le(42));

        let p = parse_key_perf(&d);
        assert_eq!(p.mode, MODE_FIXED);
        assert!((p.normal_press - 1.0).abs() < 1e-6);
        assert!((p.rt_release - 0.75).abs() < 1e-6);
        assert!((p.press_deadzone - 0.25).abs() < 1e-6);
        assert_eq!(
            (
                p.axis,
                p.calibrate,
                p.axis_v2_id,
                p.axis_range_max,
                p.axis_coefficient
            ),
            (7, 1, 13232, 3400, 42)
        );
    }

    #[test]
    fn parse_key_slots_decodes_geometry() {
        // Packed u16: y = bits 15-11, x = bits 10-4 (quarter keys), size = bits 3-0.
        let mut d = [0u8; 64];
        d[0] = LAYOUT;
        d[1] = 5;
        d[2] = 0;
        // col 0: x=0.0, y=1.0 (y_raw=4), size 1.
        let v0 = (4u16 << 11) | 1;
        d[3..5].copy_from_slice(&v0.to_le_bytes());
        // col 1: x=1.25 (x_raw=5), y=2.5 (y_raw=10), size 3.
        let v1 = (10u16 << 11) | (5u16 << 4) | 3;
        d[5..7].copy_from_slice(&v1.to_le_bytes());
        // col 2: zero → skipped.
        let slots = parse_key_slots(2, &d);
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].row, 2);
        assert_eq!(slots[0].col, 0);
        assert!((slots[0].x - 0.0).abs() < 1e-6);
        assert!((slots[0].y - 1.0).abs() < 1e-6);
        assert_eq!(slots[0].size, 1);
        assert!((slots[1].x - 1.25).abs() < 1e-6);
        assert!((slots[1].y - 2.5).abs() < 1e-6);
        assert_eq!(slots[1].size, 3);
    }

    #[test]
    fn keymap_reply_shape() {
        let mut d = [0u8; 64];
        d[0] = LAYOUT;
        d[1] = 1;
        for i in 0..21usize {
            let code = match i {
                0 => 0x04u16,
                1 => 0x05,
                2 => 0x06,
                3 => 0xf101,
                _ => 0,
            };
            d[4 + 2 * i..6 + 2 * i].copy_from_slice(&code.to_le_bytes());
        }
        let codes: [u16; 21] = std::array::from_fn(|i| rd16(&d, 4 + 2 * i));
        assert_eq!(codes[0], 0x04);
        assert_eq!(codes[3], 0xf101);
        assert_eq!(codes[20], 0x00);
    }

    #[test]
    fn palette_wire_order_is_bgr() {
        let mut d = [0u8; 64];
        d[0] = LIGHTING;
        d[1] = READ;
        // Entry 0: wire B=10 G=20 R=30 H=0 → Rgb { r: 30, g: 20, b: 10 }.
        d[4] = 10;
        d[5] = 20;
        d[6] = 30;
        let c = Rgb {
            b: d[4],
            g: d[5],
            r: d[6],
        };
        assert_eq!(
            c,
            Rgb {
                r: 30,
                g: 20,
                b: 10
            }
        );
    }

    #[test]
    fn info_reply_parsing_fields() {
        // 01 02 reply: board id BE at 4..8, version bytes 8..12, PCB 12..16,
        // build time ASCII at 29…
        let mut d = [0u8; 64];
        d[4..8].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        d[8..12].copy_from_slice(&[1, 2, 3, 4]);
        d[12..16].copy_from_slice(&[10, 20, 30, 40]);
        d[29..45].copy_from_slice(b"20260102030405ab");
        let board_id = u32::from_be_bytes([d[4], d[5], d[6], d[7]]);
        assert_eq!(board_id, 0xdeadbeef);
        let collected: String = d[29..]
            .iter()
            .take_while(|&&b| b != 0)
            .map(|&b| b as char)
            .collect();
        assert_eq!(collected, "20260102030405ab");
        // The upstream build_time reformat triggers only on a 16-char string
        // with ':' at index 10; this payload stays verbatim.
        assert_ne!(collected.as_bytes()[10], b':');
    }

    #[test]
    fn matches_identity() {
        assert!(HeKeyboard::matches(0x1ca6, 11272, USAGE_PAGE));
        assert!(HeKeyboard::matches(0x31e3, 4896, USAGE_PAGE));
        assert!(!HeKeyboard::matches(0x258a, 0x010c, USAGE_PAGE)); // K1 Pro is khub916
        assert!(!HeKeyboard::matches(0x1ca6, 11272, 0xffa0));
        assert!(!HeKeyboard::matches(0x1ca6, 9999, USAGE_PAGE));
    }

    // ── Category 6: HigherKey ──────────────────────────────────────────

    #[test]
    fn higher_key_none_packet() {
        let pkts = higher_key_packets(2, 5, &HigherKeyParams::None);
        assert_eq!(pkts.len(), 1);
        assert_eq!(pkts[0], vec![HIGHER_KEY, HK_WRITE, 2, 5, HK_NONE]);
    }

    #[test]
    fn higher_key_dks_packet_layout() {
        let p = HigherKeyParams::Dks(DksParams {
            kcs: [0x0004, 0x0005, 0x0006, 0x0007],
            trps: [10, 20, 30, 40],
            dbs: [1.5, 2.25],
        });
        let pkt = &higher_key_packets(1, 3, &p)[0];
        // [6,2,row,col,1] + 4×u16 kcs + 4×u8 trps + 2×u16 dbs(µm).
        assert_eq!(pkt.len(), 5 + 8 + 4 + 4);
        assert_eq!(&pkt[..5], &[6, 2, 1, 3, 1]);
        for (i, kc) in [0x0004u16, 0x0005, 0x0006, 0x0007].iter().enumerate() {
            assert_eq!(&pkt[5 + 2 * i..7 + 2 * i], &kc.to_le_bytes());
        }
        assert_eq!(&pkt[13..17], &[10, 20, 30, 40]);
        assert_eq!(&pkt[17..19], &1500u16.to_le_bytes());
        assert_eq!(&pkt[19..21], &2250u16.to_le_bytes());
    }

    #[test]
    fn higher_key_mpt_mt_tgl_end_layouts() {
        // MPT: [6,2,r,c,2] + 3×u16 kcs + 3×u16 dbs.
        let pkt = &higher_key_packets(
            0,
            1,
            &HigherKeyParams::Mpt(MptParams {
                kcs: [4, 5, 6],
                dbs: [1.0, 2.0, 3.0],
            }),
        )[0];
        assert_eq!(pkt.len(), 5 + 6 + 6);
        assert_eq!(&pkt[..5], &[6, 2, 0, 1, 2]);
        assert_eq!(&pkt[11..13], &1000u16.to_le_bytes());

        // MT: [6,2,r,c,3] + 2×u16 kcs + u16 time.
        let pkt = &higher_key_packets(
            0,
            1,
            &HigherKeyParams::Mt(MtParams {
                kcs: [4, 5],
                time: 0x1234,
            }),
        )[0];
        assert_eq!(pkt.len(), 5 + 4 + 2);
        assert_eq!(&pkt[..5], &[6, 2, 0, 1, 3]);
        assert_eq!(&pkt[9..11], &0x1234u16.to_le_bytes());

        // TGL: [6,2,r,c,4] + u16 kc + u16 time.
        let pkt =
            &higher_key_packets(0, 1, &HigherKeyParams::Tgl(TglParams { kcs: 4, time: 9 }))[0];
        assert_eq!(pkt.len(), 5 + 2 + 2);
        assert_eq!(&pkt[..5], &[6, 2, 0, 1, 4]);
        assert_eq!(&pkt[5..7], &4u16.to_le_bytes());
        assert_eq!(&pkt[7..9], &9u16.to_le_bytes());

        // END: [6,2,r,c,5] + 2×u16 kcs + u16 delay.
        let pkt = &higher_key_packets(
            0,
            1,
            &HigherKeyParams::End(EndParams {
                kcs: [4, 5],
                delay: 77,
            }),
        )[0];
        assert_eq!(pkt.len(), 5 + 4 + 2);
        assert_eq!(&pkt[..5], &[6, 2, 0, 1, 5]);
        assert_eq!(&pkt[9..11], &77u16.to_le_bytes());
    }

    #[test]
    fn higher_key_socd_two_cross_linked_packets() {
        let p = HigherKeyParams::Socd(SocdParams {
            row2: 3,
            col2: 7,
            kcs: [0x001E, 0x001F],
            delay: 100,
            direction: SocdDirection::PriorityA, // pair [1,2]
        });
        let pkts = higher_key_packets(1, 2, &p);
        assert_eq!(pkts.len(), 2);
        // Packet A for (1,2): names partner (3,7), kc order preserved,
        // ends with dirA=1.
        assert_eq!(
            pkts[0],
            vec![6, 2, 1, 2, 6, 3, 7, 0x1E, 0x00, 0x1F, 0x00, 100, 0x00, 1]
        );
        // Packet B for (3,7): names (1,2), keycodes swapped, dirB=2.
        assert_eq!(
            pkts[1],
            vec![6, 2, 3, 7, 6, 1, 2, 0x1F, 0x00, 0x1E, 0x00, 100, 0x00, 2]
        );
    }

    #[test]
    fn higher_key_socd_direction_pairs() {
        for (dir, (a, b)) in [
            (SocdDirection::Cover, (0, 0)),
            (SocdDirection::PriorityA, (1, 2)),
            (SocdDirection::PriorityB, (2, 1)),
            (SocdDirection::Neutral, (3, 3)),
        ] {
            assert_eq!(dir.pair(), (a, b));
        }
    }

    #[test]
    fn higher_key_rs_two_cross_linked_packets() {
        let p = HigherKeyParams::Rs(RsParams {
            row2: 4,
            col2: 9,
            kcs: [0x0020, 0x0021],
            delay: 55,
        });
        let pkts = higher_key_packets(1, 2, &p);
        assert_eq!(pkts.len(), 2);
        // [6,2,r,c,7,row2,col2,kc0,kc1,delay] — no direction byte.
        assert_eq!(
            pkts[0],
            vec![6, 2, 1, 2, 7, 4, 9, 0x20, 0x00, 0x21, 0x00, 55, 0x00]
        );
        assert_eq!(
            pkts[1],
            vec![6, 2, 4, 9, 7, 1, 2, 0x21, 0x00, 0x20, 0x00, 55, 0x00]
        );
    }

    #[test]
    fn parse_higher_key_decodes_each_mode() {
        let mut d = [0u8; 64];
        // NONE
        d[2] = 1;
        d[3] = 2;
        d[4] = HK_NONE;
        assert_eq!(
            parse_higher_key(&d),
            Some(HigherKeyConfig::None { row: 1, col: 2 })
        );

        // MT: kcs @5-8, time @9-10.
        d = [0u8; 64];
        d[2] = 3;
        d[3] = 4;
        d[4] = HK_MT;
        d[5..7].copy_from_slice(&0x1234u16.to_le_bytes());
        d[7..9].copy_from_slice(&0x5678u16.to_le_bytes());
        d[9..11].copy_from_slice(&0x00ABu16.to_le_bytes());
        assert_eq!(
            parse_higher_key(&d),
            Some(HigherKeyConfig::Mt {
                row: 3,
                col: 4,
                params: MtParams {
                    kcs: [0x1234, 0x5678],
                    time: 0x00AB,
                },
            })
        );

        // DKS: kcs @5-12, trps @13-16, dbs @17-20 (µm → mm).
        d = [0u8; 64];
        d[2] = 0;
        d[3] = 0;
        d[4] = HK_DKS;
        for (i, kc) in [1u16, 2, 3, 4].iter().enumerate() {
            d[5 + 2 * i..7 + 2 * i].copy_from_slice(&kc.to_le_bytes());
        }
        d[13..17].copy_from_slice(&[5, 6, 7, 8]);
        d[17..19].copy_from_slice(&1500u16.to_le_bytes());
        d[19..21].copy_from_slice(&2500u16.to_le_bytes());
        match parse_higher_key(&d) {
            Some(HigherKeyConfig::Dks { params, .. }) => {
                assert_eq!(params.kcs, [1, 2, 3, 4]);
                assert_eq!(params.trps, [5, 6, 7, 8]);
                assert!((params.dbs[0] - 1.5).abs() < 1e-6);
                assert!((params.dbs[1] - 2.5).abs() < 1e-6);
            }
            other => panic!("expected Dks, got {other:?}"),
        }

        // SOCD: row2 @5, col2 @6, kcs @7-10, delay @11-12, dir @13.
        d = [0u8; 64];
        d[2] = 1;
        d[3] = 2;
        d[4] = HK_SOCD;
        d[5] = 3;
        d[6] = 7;
        d[7..9].copy_from_slice(&30u16.to_le_bytes());
        d[9..11].copy_from_slice(&31u16.to_le_bytes());
        d[11..13].copy_from_slice(&100u16.to_le_bytes());
        d[13] = 2;
        match parse_higher_key(&d) {
            Some(HigherKeyConfig::Socd { params, .. }) => {
                assert_eq!((params.row2, params.col2), (3, 7));
                assert_eq!(params.kcs, [30, 31]);
                assert_eq!(params.delay, 100);
                assert_eq!(params.direction, SocdDirection::PriorityB);
            }
            other => panic!("expected Socd, got {other:?}"),
        }
        // Undefined direction byte → decode fails.
        d[13] = 9;
        assert!(parse_higher_key(&d).is_none());

        // RS: same as SOCD minus direction.
        d = [0u8; 64];
        d[4] = HK_RS;
        d[5] = 4;
        d[6] = 9;
        d[7..9].copy_from_slice(&32u16.to_le_bytes());
        d[9..11].copy_from_slice(&33u16.to_le_bytes());
        d[11..13].copy_from_slice(&55u16.to_le_bytes());
        match parse_higher_key(&d) {
            Some(HigherKeyConfig::Rs { params, .. }) => {
                assert_eq!((params.row2, params.col2), (4, 9));
                assert_eq!(params.kcs, [32, 33]);
                assert_eq!(params.delay, 55);
            }
            other => panic!("expected Rs, got {other:?}"),
        }

        // Unknown mode → None.
        d[4] = 42;
        assert!(parse_higher_key(&d).is_none());
    }

    // ── Category 7: Macro ──────────────────────────────────────────────

    #[test]
    fn macro_action_encode_decode_roundtrip() {
        for a in [
            MacroAction {
                status: false,
                delay: 0,
                key_code: 0x04,
            },
            MacroAction {
                status: true,
                delay: 32767,
                key_code: 0xFFFF,
            },
            MacroAction {
                status: true,
                delay: 100,
                key_code: 0xF101,
            },
        ] {
            let w = a.encode().unwrap();
            assert_eq!(MacroAction::decode(w), a);
        }
        // Spot-check bit layout: status<<31 | delay<<16 | keycode.
        let w = MacroAction {
            status: true,
            delay: 0x1234,
            key_code: 0x5678,
        }
        .encode()
        .unwrap();
        assert_eq!(w, 0x8000_0000 | (0x1234 << 16) | 0x5678);
    }

    #[test]
    fn macro_action_rejects_bad_values() {
        assert!(MacroAction {
            delay: 32768,
            ..Default::default()
        }
        .encode()
        .is_err());
        for kc in [0xF200u16, 0xF203] {
            assert!(MacroAction {
                key_code: kc,
                ..Default::default()
            }
            .encode()
            .is_err());
        }
    }

    #[test]
    fn macro_mode_packet_layout() {
        let m = MacroMode {
            macro_id: 2,
            valid: true,
            act_num: 0x0304,
            rep_num: 0x0506,
            mode: 1,
        };
        // [7,2,id,valid,actNum u16,repNum u16,mode]
        assert_eq!(
            macro_mode_packet(&m),
            vec![7, 2, 2, 1, 0x04, 0x03, 0x06, 0x05, 1]
        );
    }

    #[test]
    fn macro_data_packet_layout_and_page_limit() {
        let actions = vec![
            MacroAction {
                status: false,
                delay: 10,
                key_code: 0x04,
            },
            MacroAction {
                status: true,
                delay: 20,
                key_code: 0x05,
            },
        ];
        let pkt = macro_data_packet(1, 0, &actions).unwrap();
        // [7,4,id,offset] + actions × u32 LE.
        assert_eq!(pkt.len(), 4 + 8);
        assert_eq!(&pkt[..4], &[7, 4, 1, 0]);
        assert_eq!(
            &pkt[4..8],
            &MacroAction {
                status: false,
                delay: 10,
                key_code: 0x04
            }
            .encode()
            .unwrap()
            .to_le_bytes()
        );

        let full = vec![MacroAction::default(); 15];
        assert_eq!(macro_data_packet(0, 3, &full).unwrap().len(), 4 + 60);
        let too_many = vec![MacroAction::default(); 16];
        assert!(macro_data_packet(0, 0, &too_many).is_err());
    }

    #[test]
    fn parse_macro_page_decodes_actions() {
        let mut d = [0u8; 64];
        d[0] = MACRO;
        d[1] = MACRO_DATA_READ;
        d[2] = 5;
        d[3] = 1;
        let a = MacroAction {
            status: true,
            delay: 42,
            key_code: 0x1E,
        };
        d[4..8].copy_from_slice(&a.encode().unwrap().to_le_bytes());
        let page = parse_macro_page(&d);
        assert_eq!(page.macro_id, 5);
        assert_eq!(page.offset, 1);
        assert_eq!(page.actions.len(), 15);
        assert_eq!(page.actions[0], a);
        // Remaining zero words decode to default actions.
        assert_eq!(page.actions[1], MacroAction::default());
    }

    // ── Category 3 / 2 additions ───────────────────────────────────────

    #[test]
    fn key_row_write_packet_layout() {
        let codes = [0x04u16; 21];
        let pkt = key_row_write_packet(0, 2, &codes);
        // [3,2,layer,row] + 21 × u16 LE = 46 bytes.
        assert_eq!(pkt.len(), 4 + 42);
        assert_eq!(&pkt[..4], &[3, 2, 0, 2]);
        for i in 0..21 {
            assert_eq!(&pkt[4 + 2 * i..6 + 2 * i], &[0x04, 0x00]);
        }
    }

    #[test]
    fn key_code_write_packet_layout() {
        assert_eq!(
            key_code_write_packet(1, 2, 3, 0xF101),
            [3, 4, 1, 2, 3, 0x01, 0xF1]
        );
    }

    #[test]
    fn default_layout_packet_layout() {
        // selector = system << 4 | func.
        assert_eq!(default_layout_packet(1, 2, 5), [3, 6, 0x12, 5]);
    }

    #[test]
    fn macro_space_info_parse_fields() {
        // Reply: [2,14,0,count, numLo,numHi] — mirrors JS macroCount=e[3],
        // macroNumber=u16(e[4..5]).
        let mut d = [0u8; 64];
        d[0] = GLOBAL;
        d[1] = MACRO_SPACE_INFO;
        d[3] = 7;
        d[4..6].copy_from_slice(&300u16.to_le_bytes());
        let info = MacroSpaceInfo {
            macro_count: d[3],
            macro_number: rd16(&d, 4),
        };
        assert_eq!(
            info,
            MacroSpaceInfo {
                macro_count: 7,
                macro_number: 300
            }
        );
    }

    // ── Link-level tests (mock transport) ──────────────────────────────

    /// Scripted link for `transfer()`-based commands: `write` captures the
    /// report, `read` pops queued replies. Zero-duration reads (the
    /// stale-report drain inside `transfer`) always answer `None` so the
    /// queue is only consumed by real waits.
    #[derive(Default)]
    struct MockShared {
        written: Vec<Vec<u8>>,
        reads: std::collections::VecDeque<std::result::Result<Option<Vec<u8>>, String>>,
    }

    /// Scripted link for `transfer()`-based commands: `write` captures the
    /// report, `read` pops queued replies. Zero-duration reads (the
    /// stale-report drain inside `transfer`) always answer `None` so the
    /// queue is only consumed by real waits.
    struct MockLink {
        shared: std::rc::Rc<std::cell::RefCell<MockShared>>,
    }

    impl MockLink {
        fn new(reads: Vec<std::result::Result<Vec<u8>, String>>) -> Self {
            Self {
                shared: std::rc::Rc::new(std::cell::RefCell::new(MockShared {
                    reads: reads.into_iter().map(|r| r.map(Some)).collect(),
                    ..Default::default()
                })),
            }
        }

        /// Clone of the shared state — call before boxing the link.
        fn shared(&self) -> std::rc::Rc<std::cell::RefCell<MockShared>> {
            self.shared.clone()
        }
    }

    impl Link for MockLink {
        fn write(&mut self, _report_id: u8, data: &[u8]) -> Result<()> {
            self.shared.borrow_mut().written.push(data.to_vec());
            Ok(())
        }
        fn read(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>> {
            if timeout.is_zero() {
                return Ok(None);
            }
            match self.shared.borrow_mut().reads.pop_front() {
                Some(Ok(r)) => Ok(r),
                Some(Err(e)) => Err(anyhow::anyhow!(e)),
                None => Ok(None),
            }
        }
    }

    /// Pads a request packet into a 64-byte echo reply.
    fn echo_reply(pkt: &[u8]) -> Vec<u8> {
        let mut r = vec![0u8; 64];
        r[..pkt.len()].copy_from_slice(pkt);
        r
    }

    #[test]
    fn higher_key_read_roundtrip() {
        let mut d = [0u8; 64];
        d[0] = HIGHER_KEY;
        d[1] = HK_READ;
        d[2] = 1;
        d[3] = 2;
        d[4] = HK_MT;
        d[5..7].copy_from_slice(&0x1234u16.to_le_bytes());
        d[7..9].copy_from_slice(&0x5678u16.to_le_bytes());
        d[9..11].copy_from_slice(&0x00ABu16.to_le_bytes());
        let link = MockLink::new(vec![Ok(d.to_vec())]);
        let shared = link.shared();
        let mut kb = HeKeyboard::new(Box::new(link));
        let cfg = kb.higher_key(1, 2, HK_MT).unwrap();
        assert_eq!(
            cfg,
            HigherKeyConfig::Mt {
                row: 1,
                col: 2,
                params: MtParams {
                    kcs: [0x1234, 0x5678],
                    time: 0x00AB,
                },
            }
        );
        assert_eq!(shared.borrow().written.len(), 1);
    }

    #[test]
    fn set_higher_key_socd_sends_two_packets_and_reads_echo() {
        let p = HigherKeyParams::Socd(SocdParams {
            row2: 3,
            col2: 7,
            kcs: [0x001E, 0x001F],
            delay: 100,
            direction: SocdDirection::PriorityA,
        });
        let pkts = higher_key_packets(1, 2, &p);
        let link = MockLink::new(vec![Ok(echo_reply(&pkts[0])), Ok(echo_reply(&pkts[1]))]);
        let shared = link.shared();
        let mut kb = HeKeyboard::new(Box::new(link));
        let echoes = kb.set_higher_key(1, 2, &p).unwrap();
        assert_eq!(echoes.len(), 2);
        assert!(matches!(echoes[0], HigherKeyConfig::Socd { .. }));
        assert!(matches!(echoes[1], HigherKeyConfig::Socd { .. }));
        // Exactly the two cross-linked write packets were sent (each
        // padded to a 64-byte report by `request_matching`).
        let w = shared.borrow();
        assert_eq!(w.written.len(), 2);
        for (i, pkt) in pkts.iter().enumerate() {
            assert_eq!(&w.written[i][..pkt.len()], &pkt[..]);
            assert!(w.written[i][pkt.len()..].iter().all(|&b| b == 0));
        }
    }

    #[test]
    fn set_higher_key_rejects_blacklisted_keycode() {
        for kc in [0xF200u16, 0xF203] {
            let p = HigherKeyParams::Tgl(TglParams { kcs: kc, time: 1 });
            let link = MockLink::new(vec![]);
            let shared = link.shared();
            let mut kb = HeKeyboard::new(Box::new(link));
            assert!(kb.set_higher_key(0, 0, &p).is_err());
            assert!(shared.borrow().written.is_empty());
        }
    }

    #[test]
    fn set_key_code_rejects_blacklisted_keycode() {
        let link = MockLink::new(vec![]);
        let shared = link.shared();
        let mut kb = HeKeyboard::new(Box::new(link));
        assert!(kb.set_key_code(0, 0, 0, 0xF200).is_err());
        assert!(shared.borrow().written.is_empty());
    }
}

#[cfg(test)]
mod prop_tests {
    use super::*;
    use proptest::prelude::*;

    /// Copy an arbitrary byte stream into a 64-byte reply (zero padded).
    fn reply(data: &[u8]) -> [u8; 64] {
        let mut d = [0u8; 64];
        let n = data.len().min(64);
        d[..n].copy_from_slice(&data[..n]);
        d
    }

    proptest! {
        /// `um`/`mm` are total over every f32 (NaN, infinities included)
        /// and the decoded distance always lands in [0, 65.535] mm.
        #[test]
        fn um_mm_never_panics(v in any::<f32>()) {
            let b = um(v);
            let back = mm(&b, 0);
            prop_assert!(back.is_finite());
            prop_assert!((0.0..=65.535).contains(&back));
        }

        /// In-range distances survive encode→decode within quantisation.
        #[test]
        fn um_mm_roundtrip_in_range(v in 0.0f32..=65.535) {
            let back = mm(&um(v), 0);
            let want = (v * 1000.0).round() / 1000.0;
            prop_assert!((back - want).abs() <= 0.0015, "{v} -> {back}, want {want}");
        }

        /// Arbitrary 64-byte replies never panic the geometry parser and
        /// every decoded slot stays inside the packed-field bounds.
        #[test]
        fn parse_key_slots_never_panics(data in prop::collection::vec(any::<u8>(), 0..=80), row in any::<u8>()) {
            let d = reply(&data);
            for slot in parse_key_slots(row, &d) {
                prop_assert_eq!(slot.row, row);
                prop_assert!(slot.col < 21);
                prop_assert!((0.0..=7.75).contains(&slot.y), "y={}", slot.y);
                prop_assert!((0.0..=31.75).contains(&slot.x), "x={}", slot.x);
                prop_assert!((1..=15).contains(&slot.size));
            }
        }

        /// Arbitrary replies never panic the perf parser; distances are
        /// always valid millimetre values.
        #[test]
        fn parse_key_perf_never_panics(data in prop::collection::vec(any::<u8>(), 0..=80)) {
            let d = reply(&data);
            let p = parse_key_perf(&d);
            for v in [p.normal_press, p.normal_release, p.rt_first_touch, p.rt_press, p.rt_release, p.press_deadzone, p.release_deadzone] {
                prop_assert!((0.0..=65.535).contains(&v), "{v}");
            }
        }

        /// encode→parse→encode is a fixed point: the packet parser sees
        /// exactly the quantised um() values it wrote, so a second encode
        /// of the parsed settings reproduces identical bytes.
        #[test]
        fn key_perf_packet_roundtrip_is_stable(
            row in any::<u8>(),
            col in any::<u8>(),
            mode in any::<u8>(),
            vals in prop::collection::vec(any::<f32>(), 7..=7),
            axis in any::<u8>(),
            calibrate in any::<u8>(),
            echoes in prop::collection::vec(any::<u16>(), 3..=3),
        ) {
            let p = KeyPerf {
                mode,
                normal_press: vals[0],
                normal_release: vals[1],
                rt_first_touch: vals[2],
                rt_press: vals[3],
                rt_release: vals[4],
                press_deadzone: vals[5],
                release_deadzone: vals[6],
                axis,
                calibrate,
                axis_v2_id: echoes[0],
                axis_range_max: echoes[1],
                axis_coefficient: echoes[2],
            };
            let pkt = key_perf_packet(row, col, &p);
            prop_assert_eq!(pkt.len(), 27);
            let mut d = [0u8; 64];
            d[..pkt.len()].copy_from_slice(&pkt);
            let parsed = parse_key_perf(&d);
            let pkt2 = key_perf_packet(row, col, &parsed);
            prop_assert_eq!(&pkt[..], &pkt2[..]);
        }
    }
}
