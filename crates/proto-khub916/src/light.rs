//! khub916 keyboard lighting: effect-mode table, cmd-138 blob decode and
//! the wired cmd-10 light-data write.
//!
//! Everything here is ported from the vendor web driver
//! (`docs/research/khub-webapp/index-M8-m9qFR.deob.js`, wired class `Ht`,
//! alias `K` in the deobfuscated copy) — see `docs/protocol-khub916.md` §6
//! and `docs/lighting-schema.md` for the agent-facing schema.
//!
//! ## Vendor model (wired 916)
//!
//! - **Effect mode** lives in the profile blob: u16 at `raw[9..11]`
//!   (`raw[9]!=0 ? raw[9]<<8|raw[10] : raw[10]`). Per-mode speed/brightness
//!   records sit past the first `FF FF` pair at `base + mode*2 - 2`
//!   (brightness byte) and `base + mode*2 - 1` (packed `speed<<4 | type`).
//!   Modes `0, 19, 275, 277` are special and carry no record.
//! - **Packed type nibble**: low nibble `7` = colour-mixing effect
//!   (`color_model` 2 in the UI), `0` = monochrome single-colour
//!   (`color_model` 1). High nibble = speed `& 15`.
//! - **Light colour data** (cmd 138 read / cmd 10 write): a blob of
//!   21-byte groups, one per mode index — group `m` at offset `m*21`,
//!   bytes `0..3` = the mode's RGB colour (vendor `getGroupColor`), the
//!   remaining 18 bytes are a constant firmware template (verified live on
//!   K1 Pro: all 23 groups identical, semantics unknown). Modes ≥ 23 and
//!   the special modes have no group; the vendor `updateGroupColor`
//!   silently no-ops out of bounds.
//! - **Custom per-key colours** (cmd 134 read / cmd 6 write): 126 entries
//!   × R/G/B planes — used by the "Custom" effect (mode 277 on K1 Pro).
//!
//! ## Wired cmd 10 write (vendor `setKeyboardLight`, `type==1 && color`)
//!
//! Packet `[10, 0, 0, 0, 0, 0, 2]` + blob at offset 7, zero-padded to 519,
//! with the `5A A5` end marker pinned at **packet bytes 513/514** (the JS
//! writes `d[518-5]=90, d[518-4]=165` — fixed offsets, not end-of-data).
//! Fire-and-forget like every config write; verified by cmd-138 read-back.
//! This is a lighting-data write only — no reset/firmware path.
//!
//! The wireless `916_wireLess` equivalents are cmd 73 (read) and the
//! chunked cmd 9 write ([`crate::wireless::Khub916Wireless::write_light_color_data`],
//! already implemented). Its profile layout differs (mode at `raw[33]`,
//! bright `raw[34]`, packed `raw[35]` — vendor `zt` class) and is not yet
//! implemented here.

use anyhow::{bail, Result};
use serde::Serialize;
use std::time::Duration;

use crate::{
    Khub916, Profile, WriteOutcome, CUSTOM_LIGHT_ENTRIES, FEATURE_PAYLOAD_BYTES, HEADER_LEN,
};

/// RGB triple used by the lighting decode types (serialises as
/// `{r,g,b}`; the CLI formats `#rrggbb`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct RgbTrip {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

// ── Mode table (vendor `i("916")` + `Ct` list, index-cV1Bl4gC.js /
//    index-M8-m9qFR.js) ─────────────────────────────────────────────────

/// Vendor `ColorModelSupport` codes.
pub mod color_support {
    /// No colour UI (effect off).
    pub const OFF: u8 = 0;
    /// Single user colour (monochrome or mixing).
    pub const SINGLE: u8 = 1;
    /// Custom per-key colours (cmd 6 table).
    pub const CUSTOM: u8 = 2;
    /// Multi-colour built-in effect.
    pub const MULTI: u8 = 3;
}

/// Vendor `colorModel` / `type` values passed to `setKeyboardLight`.
pub mod color_model {
    /// Monochrome: one RGB colour stored in the cmd-138 group; the profile
    /// record packs type code `0`.
    pub const MONOCHROME: u8 = 1;
    /// Colour mixing: firmware-owned palette; profile record packs `7`.
    pub const MIXING: u8 = 2;
}

/// One row of the vendor 916 lighting-effect table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LightModeInfo {
    /// Wire mode id (`setKeyboardLight` `mode`, profile `raw[9..11]`).
    pub id: u16,
    /// Vendor effect name (i18n key resolved to its canonical form).
    pub name: &'static str,
    /// [`color_support`] code.
    pub color_support: u8,
    /// Vendor default `colorModel` for this mode (1 or 2).
    pub default_color_model: u8,
    /// Vendor `speedShowStatus` — false for the custom effect (277) and
    /// always-on (1), which ignore the speed parameter.
    pub speed_adjustable: bool,
}

const fn mode(
    id: u16,
    name: &'static str,
    support: u8,
    default_cm: u8,
    speed_adjustable: bool,
) -> LightModeInfo {
    LightModeInfo {
        id,
        name,
        color_support: support,
        default_color_model: default_cm,
        speed_adjustable,
    }
}

/// The 916 wired effect table. Ids absent here (e.g. 14, which the vendor
/// mapper aliases to sine-wave, and 18+) are not in the vendor `Ct` list;
/// the wire still accepts any u16 mode bounded by the profile record table.
pub const LIGHT_MODES: &[LightModeInfo] = &[
    mode(0, "off", color_support::OFF, color_model::MIXING, true),
    mode(
        277,
        "custom",
        color_support::CUSTOM,
        color_model::MONOCHROME,
        false,
    ),
    mode(
        1,
        "always_on",
        color_support::SINGLE,
        color_model::MIXING,
        false,
    ),
    mode(
        2,
        "breathing",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(
        3,
        "dream_rainbow",
        color_support::MULTI,
        color_model::MIXING,
        true,
    ),
    mode(
        4,
        "one_touch",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(
        5,
        "rain_walk",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(
        6,
        "color_wheel",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(
        7,
        "key_ripple",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(8, "stars", color_support::SINGLE, color_model::MIXING, true),
    mode(
        9,
        "snow_trace",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(
        10,
        "flowing",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(11, "wave", color_support::SINGLE, color_model::MIXING, true),
    mode(
        12,
        "shadow",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(
        13,
        "sine_wave",
        color_support::SINGLE,
        color_model::MIXING,
        true,
    ),
    mode(
        15,
        "windmill",
        color_support::MULTI,
        color_model::MIXING,
        true,
    ),
    mode(
        16,
        "waterfall",
        color_support::MULTI,
        color_model::MIXING,
        true,
    ),
    mode(
        17,
        "blooming",
        color_support::MULTI,
        color_model::MIXING,
        true,
    ),
];

/// Table row for a mode id; `None` for ids outside the vendor list.
pub fn light_mode_info(id: u16) -> Option<&'static LightModeInfo> {
    LIGHT_MODES.iter().find(|m| m.id == id)
}

/// Modes with no per-mode speed/brightness record and no colour group
/// semantics (vendor exclusion lists `[0,19,275,277]` / `[277,0,19,275]`).
pub const LIGHT_SPECIAL_MODES: [u16; 4] = [0, 19, 275, 277];

// ── Profile light-state decode (vendor `getKeyboardLight`, wired `Ht`) ──

/// Decoded current lighting state from the profile blob.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LightState {
    /// Current effect mode (profile `raw[9..11]` u16).
    pub mode: u16,
    /// Effect speed (high nibble of the packed record byte; 0 for special
    /// modes and mode 1, matching the vendor decode).
    pub speed: u8,
    /// Brightness byte (0 for special modes).
    pub brightness: u8,
    /// Colour model actually stored for the current mode:
    /// 1 = monochrome, 2 = colour mixing.
    pub color_model: u8,
}

/// Index just past the first `FF FF` pair in the profile blob — the vendor
/// `findSecond255Index` (`Profile::with_light_mode` uses the same rule).
pub fn find_second_255_index(blob: &[u8]) -> Option<usize> {
    blob.windows(2)
        .position(|w| w == [0xFF, 0xFF])
        .map(|i| i + 2)
}

/// Decode the current light state exactly like the vendor
/// `getKeyboardLight`: the record index uses `raw[10]` (the mode's low
/// byte), speed is forced to 0 for special modes and mode 1, brightness
/// to 0 for special modes, and `color_model` is 1 unless the packed low
/// nibble is 7 (→ 2).
pub fn decode_light_state(profile: &Profile) -> Option<LightState> {
    let e = &profile.raw;
    if e.len() < 11 {
        return None;
    }
    let base = find_second_255_index(e)?;
    let mode = if e[9] != 0 {
        ((e[9] as u16) << 8) | e[10] as u16
    } else {
        e[10] as u16
    };
    // Vendor: bright at base + raw[10]*2 - 2, packed at +1.
    let idx = e[10] as usize;
    let bright_at = base.checked_add(idx.checked_mul(2)?)?.checked_sub(2)?;
    let packed_at = bright_at.checked_add(1)?;
    if packed_at >= e.len() {
        return None;
    }
    let packed = e[packed_at];
    let special = LIGHT_SPECIAL_MODES.contains(&mode);
    Some(LightState {
        mode,
        speed: if special || mode == 1 { 0 } else { packed >> 4 },
        brightness: if special || bright_at >= e.len() {
            0
        } else {
            e[bright_at]
        },
        color_model: if special {
            1
        } else if packed & 0x0F == 7 {
            color_model::MIXING
        } else {
            color_model::MONOCHROME
        },
    })
}

// ── Cmd-138 light-data blob decode ─────────────────────────────────────

/// Bytes per per-mode group in the light-data blob.
pub const LIGHT_GROUP_STRIDE: usize = 21;
/// RGB triple at the head of each group (vendor `getGroupColor`).
pub const LIGHT_GROUP_COLOR_LEN: usize = 3;

/// One 21-byte group of the light-data blob.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LightGroup {
    /// Group index = mode id the group belongs to.
    pub index: usize,
    /// Byte offset of the group inside the blob (`index * 21`).
    pub offset: usize,
    /// RGB colour — the group's first three bytes.
    pub color: RgbTrip,
    /// The full 21-byte group verbatim.
    pub raw: Vec<u8>,
}

/// Decoded cmd-138 light-data blob.
#[derive(Clone, Debug, Serialize)]
pub struct LightDataInfo {
    /// Blob length in bytes (483 = 23 groups on the K1 Pro).
    pub bytes: usize,
    /// Full 21-byte groups (`bytes / 21`).
    pub groups: Vec<LightGroup>,
    /// Trailing bytes that do not fill a whole group.
    pub tail_len: usize,
}

/// Decode a cmd-138 blob into per-mode groups. Only the first three bytes
/// of each group are interpreted (vendor `getGroupColor`); the rest is a
/// constant firmware template — kept verbatim in [`LightGroup::raw`].
pub fn decode_light_data(blob: &[u8]) -> LightDataInfo {
    let groups = blob
        .chunks_exact(LIGHT_GROUP_STRIDE)
        .enumerate()
        .map(|(i, g)| LightGroup {
            index: i,
            offset: i * LIGHT_GROUP_STRIDE,
            color: RgbTrip {
                r: g[0],
                g: g[1],
                b: g[2],
            },
            raw: g.to_vec(),
        })
        .collect();
    LightDataInfo {
        bytes: blob.len(),
        groups,
        tail_len: blob.len() % LIGHT_GROUP_STRIDE,
    }
}

/// Vendor `getGroupColor`: RGB at `mode * 21`; `None` when out of bounds
/// (special modes 275/277 always land here).
pub fn group_color(blob: &[u8], mode: u16) -> Option<RgbTrip> {
    let off = (mode as usize).checked_mul(LIGHT_GROUP_STRIDE)?;
    if off + LIGHT_GROUP_COLOR_LEN > blob.len() {
        return None;
    }
    Some(RgbTrip {
        r: blob[off],
        g: blob[off + 1],
        b: blob[off + 2],
    })
}

/// Vendor `updateGroupColor`: copy `blob` and overwrite the RGB triple at
/// `mode * 21`. Returns `None` when the group does not fit — the vendor
/// silently no-ops; callers should treat `None` as "mode has no colour".
pub fn with_group_color(blob: &[u8], mode: u16, color: RgbTrip) -> Option<Vec<u8>> {
    let mut out = blob.to_vec();
    let off = (mode as usize).checked_mul(LIGHT_GROUP_STRIDE)?;
    if off + LIGHT_GROUP_COLOR_LEN > out.len() {
        return None;
    }
    out[off] = color.r;
    out[off + 1] = color.g;
    out[off + 2] = color.b;
    Some(out)
}

// ── Wired cmd-10 light-data write ──────────────────────────────────────

/// Wired light-data write opcode (vendor `setKeyboardLight` colour branch:
/// `new Uint8Array([10,0,0,0,0,0,2,...])`). Distinct from the wireless
/// chunked cmd 9 and from every query opcode.
const CMD_LIGHT_DATA_WRITE: u8 = 10;
/// Largest blob the fixed-marker packet can carry: payload starts at
/// offset 7 and the `5A A5` marker is pinned at packet bytes 513/514, so
/// data may occupy bytes 7..=512 (506 bytes). The real blob is 483 B.
const LIGHT_DATA_MAX: usize = 506;

impl Khub916 {
    /// Write the per-mode light colour blob (wired cmd 10, fire-and-forget
    /// feature report — the vendor JS never reads a reply). `data` is the
    /// full ~483-byte blob as returned by [`Khub916::light_color_data`],
    /// typically modified via [`with_group_color`].
    ///
    /// Wire layout (vendor-verified): header `[10,0,0,0,0,0,2]` — note
    /// byte 3 is `0x00`, **not** the usual `0x01` constant — blob at offset
    /// 7, zero-pad to 519, `5A A5` pinned at packet bytes 513/514.
    ///
    /// Verify: cmd 138 read-back must reproduce `data` as a prefix (the
    /// device may pad/normalise the tail). A mismatch returns `Err`
    /// without poisoning the session.
    pub fn write_light_data(&mut self, data: &[u8]) -> Result<WriteOutcome> {
        if data.is_empty() || data.len() > LIGHT_DATA_MAX {
            bail!(
                "khub916 light data write needs 1..={LIGHT_DATA_MAX} bytes, got {}",
                data.len()
            );
        }
        let mut pkt = [0u8; FEATURE_PAYLOAD_BYTES];
        pkt[0] = CMD_LIGHT_DATA_WRITE;
        // Bytes 1..6 stay zero except the tag byte: [10,0,0,0,0,0,2].
        pkt[6] = 0x02;
        pkt[HEADER_LEN..HEADER_LEN + data.len()].copy_from_slice(data);
        // Vendor pins the end marker at fixed packet offsets 513/514
        // (`d[513]=90, d[514]=165`), inside the zero padding.
        pkt[513] = 0x5A;
        pkt[514] = 0xA5;
        self.config_write(&pkt)?;
        let back = self.light_color_data()?;
        if back.len() < data.len() || back[..data.len()] != data[..] {
            bail!("khub916 light data write not verified: read-back differs");
        }
        Ok(WriteOutcome {
            command: CMD_LIGHT_DATA_WRITE,
            verified: true,
        })
    }
}

// ── Cmd-8 GIF light frame stream (vendor `setGifLight`, wired `Ht`) ────
//
// Vendor JS (`index-M8-m9qFR.deob.js`, wired class `Ht.setGifLight`):
// a flat byte stream is split into 378-byte chunks; each chunk becomes one
// 512-byte packet `[8,0,0,1,0,122,1]` + data at offset 7, zero-padded into
// the 519-byte feature report and sent fire-and-forget through the same
// 30 ms-spaced command queue as every other write. There is **no** chunk
// index, frame count, checksum or `5A A5` marker — the device consumes the
// stream continuously (378 B = 126 keys × RGB, layout unverified; the
// cmd-6 planar `[R×126][G×126][B×126]` order is the working assumption).
//
// Whether the firmware needs a particular light mode active, and the
// maximum sustained rate, are hardware questions — see
// docs/research/music-reactive-feasibility.md §6 (TEST-001).

/// cmd 8 opcode (GIF light frames).
const CMD_GIF_LIGHT: u8 = 8;
/// RGB bytes per stream chunk — one full-keyboard frame.
pub const GIF_FRAME_BYTES: usize = 378;
/// The 7-byte packet prefix the vendor writes before each chunk
/// (`new Uint8Array([8,0,0,1,0,122,1])`).
pub const GIF_FRAME_PREFIX: [u8; HEADER_LEN] = [CMD_GIF_LIGHT, 0, 0, 0x01, 0, 0x7A, 0x01];
/// Vendor command-queue pacing: 30 ms between feature reports.
pub const GIF_FRAME_PACING: Duration = Duration::from_millis(30);

impl Khub916 {
    /// Build one cmd-8 packet: [`GIF_FRAME_PREFIX`] at offset 0, up to
    /// [`GIF_FRAME_BYTES`] data bytes at offset 7, zero-padded to the
    /// 519-byte feature payload. Pure — no device access.
    pub fn gif_frame_packet(data: &[u8]) -> Result<[u8; FEATURE_PAYLOAD_BYTES]> {
        if data.len() > GIF_FRAME_BYTES {
            bail!(
                "khub916 gif frame needs ≤ {GIF_FRAME_BYTES} bytes, got {}",
                data.len()
            );
        }
        let mut pkt = [0u8; FEATURE_PAYLOAD_BYTES];
        pkt[..HEADER_LEN].copy_from_slice(&GIF_FRAME_PREFIX);
        pkt[HEADER_LEN..HEADER_LEN + data.len()].copy_from_slice(data);
        Ok(pkt)
    }

    /// Fire-and-forget feature-report write for one cmd-8 packet. Unlike
    /// [`Khub916::config_write`] there is no settle delay — streaming needs
    /// the vendor's ~30 ms cadence, which the caller paces.
    fn gif_write(&mut self, pkt: &[u8; FEATURE_PAYLOAD_BYTES]) -> Result<()> {
        self.guard(|s| {
            s.link
                .feature_write(s.report_id, pkt)
                .map_err(|e| anyhow::anyhow!("khub916 gif feature write failed: {e:#}"))
        })
    }

    /// Send exactly one cmd-8 frame chunk (≤ [`GIF_FRAME_BYTES`] bytes).
    /// The caller paces — see [`GIF_FRAME_PACING`]. **Live-verified**:
    /// sustained 30–50 fps streams visibly animate the LEDs on K1 Pro
    /// (TEST-001, docs/research/music-reactive-feasibility.md §6).
    pub fn write_gif_frame(&mut self, frame: &[u8]) -> Result<()> {
        let pkt = Self::gif_frame_packet(frame)?;
        self.gif_write(&pkt)
    }

    /// Send `data` as a cmd-8 stream: split into [`GIF_FRAME_BYTES`]
    /// chunks, one feature report each, `delay` between sends (no delay
    /// after the last). Returns the number of packets sent. Bulk/one-shot
    /// helper — interactive streaming should call [`Self::write_gif_frame`]
    /// per frame instead.
    pub fn write_gif_light(&mut self, data: &[u8], delay: Duration) -> Result<usize> {
        if data.is_empty() {
            bail!("khub916 gif stream needs at least 1 byte");
        }
        let chunks: Vec<&[u8]> = data.chunks(GIF_FRAME_BYTES).collect();
        for (i, chunk) in chunks.iter().enumerate() {
            self.write_gif_frame(chunk)?;
            if i + 1 < chunks.len() && !delay.is_zero() {
                std::thread::sleep(delay);
            }
        }
        Ok(chunks.len())
    }
}

// ── Custom per-key colours (cmd 134/6) — thin helpers over the existing
//    verified read/write so lighting callers share one entry point ──────

/// Convert the cmd-134 plane decode into the cmd-6 write input.
pub fn custom_colors_to_rgb(colors: &[crate::LightColor]) -> Vec<crate::Rgb> {
    colors
        .iter()
        .map(|c| crate::Rgb {
            r: c.r,
            g: c.g,
            b: c.b,
        })
        .collect()
}

/// Number of custom-light slots (126; `pos = 8 + index*4`).
pub const CUSTOM_LIGHT_SLOTS: usize = CUSTOM_LIGHT_ENTRIES;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Khub916 as Session;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Duration;

    /// K1 Pro live profile shape: `FF FF` at 56-57 → table base 58,
    /// mode 15 → bright record at 86, packed at 87.
    fn live_profile() -> Profile {
        let mut raw = vec![0u8; 128];
        raw[56] = 0xFF;
        raw[57] = 0xFF;
        raw[9] = 0;
        raw[10] = 15;
        raw[86] = 10;
        raw[87] = 0x47; // speed 4 << 4 | type 7 → mixing
        raw[126] = 0x5A;
        raw[127] = 0xA5;
        Profile { raw }
    }

    #[test]
    fn decode_light_state_matches_vendor() {
        let s = decode_light_state(&live_profile()).unwrap();
        assert_eq!(s.mode, 15);
        assert_eq!(s.speed, 4);
        assert_eq!(s.brightness, 10);
        assert_eq!(s.color_model, color_model::MIXING);
        // Monochrome record: packed low nibble 0 → color_model 1.
        let mut p = live_profile();
        p.raw[87] = 0x40;
        assert_eq!(decode_light_state(&p).unwrap().color_model, 1);
        // Special mode 0: speed/brightness forced 0, model 1.
        let mut p0 = live_profile();
        p0.raw[10] = 0;
        let s0 = decode_light_state(&p0).unwrap();
        assert_eq!((s0.speed, s0.brightness, s0.color_model), (0, 0, 1));
        // Mode 1 (always_on): speed forced 0; its own record lives at
        // base+0/base+1 = 58/59 (bright 7, packed 0x45).
        let mut p1 = live_profile();
        p1.raw[10] = 1;
        p1.raw[58] = 7;
        p1.raw[59] = 0x45;
        let s1 = decode_light_state(&p1).unwrap();
        assert_eq!(s1.speed, 0);
        assert_eq!(s1.brightness, 7);
        // Short blob → None.
        assert!(decode_light_state(&Profile { raw: vec![0u8; 10] }).is_none());
    }

    #[test]
    fn decode_light_data_groups() {
        // 483 bytes = 23 groups like the live K1 Pro.
        let mut blob = vec![0u8; 483];
        for g in blob.chunks_exact_mut(21) {
            g[0] = 0xFF;
            g[1] = 0x00;
            g[2] = 0x00;
        }
        let d = decode_light_data(&blob);
        assert_eq!(d.bytes, 483);
        assert_eq!(d.groups.len(), 23);
        assert_eq!(d.tail_len, 0);
        assert_eq!(d.groups[15].offset, 315);
        assert_eq!(d.groups[15].color, RgbTrip { r: 255, g: 0, b: 0 });
        assert_eq!(d.groups[15].raw.len(), 21);
        // group_color bounds: mode 22 fits, 23+ does not.
        assert!(group_color(&blob, 22).is_some());
        assert!(group_color(&blob, 23).is_none());
        assert!(group_color(&blob, 277).is_none());
    }

    #[test]
    fn with_group_color_roundtrip() {
        let blob = vec![0u8; 483];
        let c = RgbTrip { r: 1, g: 2, b: 3 };
        let out = with_group_color(&blob, 7, c).unwrap();
        assert_eq!(&out[..3], &[0, 0, 0]); // group 0 untouched
        assert_eq!(group_color(&out, 7), Some(c));
        assert_eq!(group_color(&out, 8), Some(RgbTrip::default()));
        assert!(with_group_color(&blob, 23, c).is_none());
        assert!(with_group_color(&blob, 300, c).is_none()); // usize overflow guard
    }

    #[test]
    fn mode_table_coverage() {
        // Vendor 916 list: 18 ids.
        assert_eq!(LIGHT_MODES.len(), 18);
        assert_eq!(light_mode_info(277).unwrap().name, "custom");
        assert_eq!(
            light_mode_info(277).unwrap().color_support,
            color_support::CUSTOM
        );
        assert_eq!(light_mode_info(15).unwrap().name, "windmill");
        assert!(light_mode_info(14).is_none());
        assert!(light_mode_info(18).is_none());
        assert!(LIGHT_SPECIAL_MODES.contains(&19));
    }

    // ── cmd-10 write packet layout ─────────────────────────────────────

    #[derive(Default)]
    struct MockShared {
        feature_writes: Vec<(u8, Vec<u8>)>,
        /// Responses queued for feature_exchange (read-back verify).
        responses: std::collections::VecDeque<Result<Vec<u8>, String>>,
    }

    struct MockLink {
        shared: Rc<RefCell<MockShared>>,
    }

    impl omg_hid::Link for MockLink {
        fn write(&mut self, _report_id: u8, _data: &[u8]) -> Result<()> {
            Ok(())
        }
        fn read(&mut self, _timeout: Duration) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        fn feature_exchange(
            &mut self,
            _report_id: u8,
            _payload: &[u8],
            _timeout: Duration,
        ) -> Result<Option<Vec<u8>>> {
            match self.shared.borrow_mut().responses.pop_front() {
                Some(Ok(r)) => Ok(Some(r)),
                Some(Err(e)) => Err(anyhow::anyhow!(e)),
                None => Ok(None),
            }
        }
        fn feature_write(&mut self, report_id: u8, payload: &[u8]) -> Result<()> {
            self.shared
                .borrow_mut()
                .feature_writes
                .push((report_id, payload.to_vec()));
            Ok(())
        }
    }

    /// cmd-138 read response echoing `blob`.
    fn light_read_response(blob: &[u8]) -> Vec<u8> {
        let mut r = vec![0x8A, 0x00, 0x00, 0x01, 0x00, 0xE3, 0x01];
        r.extend_from_slice(blob);
        r
    }

    #[test]
    fn light_data_write_packet_and_verify() {
        let blob = vec![0xABu8; 483];
        let shared = Rc::new(RefCell::new(MockShared {
            responses: vec![Ok(light_read_response(&blob))].into(),
            ..Default::default()
        }));
        let link = MockLink {
            shared: shared.clone(),
        };
        let mut kb = Session::new(Box::new(link), 6);
        let outcome = kb.write_light_data(&blob).unwrap();
        assert!(outcome.verified);
        assert_eq!(outcome.command, CMD_LIGHT_DATA_WRITE);

        let sh = shared.borrow();
        assert_eq!(sh.feature_writes.len(), 1);
        let (id, pkt) = &sh.feature_writes[0];
        assert_eq!(*id, 6);
        assert_eq!(pkt.len(), FEATURE_PAYLOAD_BYTES);
        // Header [10,0,0,0,0,0,2] — byte 3 is 0x00, not the usual 0x01.
        assert_eq!(&pkt[..7], &[10, 0, 0, 0, 0, 0, 2]);
        assert_eq!(&pkt[HEADER_LEN..HEADER_LEN + blob.len()], &blob[..]);
        // Marker pinned at packet bytes 513/514.
        assert_eq!(pkt[513], 0x5A);
        assert_eq!(pkt[514], 0xA5);
        assert!(pkt[HEADER_LEN + blob.len()..513].iter().all(|&b| b == 0));
    }

    #[test]
    fn light_data_write_rejects_bad_length() {
        let shared = Rc::new(RefCell::new(MockShared::default()));
        let link = MockLink {
            shared: shared.clone(),
        };
        let mut kb = Session::new(Box::new(link), 6);
        assert!(kb.write_light_data(&[]).is_err());
        assert!(kb.write_light_data(&vec![0u8; LIGHT_DATA_MAX + 1]).is_err());
        assert!(shared.borrow().feature_writes.is_empty());
    }

    #[test]
    fn light_data_write_verify_mismatch_is_error() {
        let sent = vec![0x11u8; 483];
        let mut back = sent.clone();
        back[100] = 0x22;
        let shared = Rc::new(RefCell::new(MockShared {
            responses: vec![Ok(light_read_response(&back))].into(),
            ..Default::default()
        }));
        let link = MockLink {
            shared: shared.clone(),
        };
        let mut kb = Session::new(Box::new(link), 6);
        assert!(kb.write_light_data(&sent).is_err());
        assert!(!kb.is_poisoned());
    }

    // ── cmd-8 GIF frame packets ────────────────────────────────────────

    #[test]
    fn gif_frame_packet_layout() {
        let frame = vec![0x5Au8; GIF_FRAME_BYTES];
        let pkt = Session::gif_frame_packet(&frame).unwrap();
        assert_eq!(pkt.len(), FEATURE_PAYLOAD_BYTES);
        // Vendor prefix [8,0,0,1,0,122,1] verbatim.
        assert_eq!(&pkt[..HEADER_LEN], &[8, 0, 0, 1, 0, 122, 1]);
        // Data at offset 7, zero-padded to 519.
        assert_eq!(&pkt[HEADER_LEN..HEADER_LEN + GIF_FRAME_BYTES], &frame[..]);
        assert!(pkt[HEADER_LEN + GIF_FRAME_BYTES..].iter().all(|&b| b == 0));
        // Short chunk still pads; oversized rejected.
        let short = Session::gif_frame_packet(&[1, 2, 3]).unwrap();
        assert_eq!(&short[HEADER_LEN..HEADER_LEN + 3], &[1, 2, 3]);
        assert!(Session::gif_frame_packet(&vec![0u8; GIF_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn gif_light_stream_chunks_and_paces() {
        let shared = Rc::new(RefCell::new(MockShared::default()));
        let link = MockLink {
            shared: shared.clone(),
        };
        let mut kb = Session::new(Box::new(link), 6);
        // 2.5 frames → 3 packets (378+378+189 bytes of data).
        let data = vec![0xABu8; GIF_FRAME_BYTES * 2 + 189];
        let sent = kb.write_gif_light(&data, Duration::ZERO).unwrap();
        assert_eq!(sent, 3);
        let sh = shared.borrow();
        assert_eq!(sh.feature_writes.len(), 3);
        for (i, (id, pkt)) in sh.feature_writes.iter().enumerate() {
            assert_eq!(*id, 6);
            assert_eq!(&pkt[..HEADER_LEN], &[8, 0, 0, 1, 0, 122, 1]);
            let want = match i {
                2 => 189,
                _ => GIF_FRAME_BYTES,
            };
            assert!(pkt[HEADER_LEN..HEADER_LEN + want]
                .iter()
                .all(|&b| b == 0xAB));
            assert!(pkt[HEADER_LEN + want..].iter().all(|&b| b == 0));
        }
        assert!(kb.write_gif_light(&[], Duration::ZERO).is_err());
        assert!(kb.write_gif_frame(&vec![0u8; GIF_FRAME_BYTES + 1]).is_err());
    }
}
