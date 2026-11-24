//! khub916 macro region codec (wired cmd 133 read / cmd 5 write).
//!
//! Port of the vendor JS `extractPossibleHeaders` / `assembleGroupsWithLog`
//! / `getKeyBoardMacroKeyList` / `setKeyBoardMacroIndependent` paths
//! (`docs/research/khub-webapp/index-M8-m9qFR.deob.js`, class `Ht`;
//! spec `docs/protocol-khub916.md` §6 "Macro region"). **Code-verified
//! only** until exercised on hardware.
//!
//! # Wire layout (≤512 B region)
//!
//! ```text
//! [header table: N × 4 B][bodies, concatenated in order]
//! header i: [offsetLo, offsetHi, lenLo, lenHi]  (both u16 little-endian)
//!   offset = absolute position of body i in the region (≥ 4·N)
//!   len    = body length in bytes
//! body:    [nameLen u8][name UTF-8 (nameLen bytes)][steps × 4 B]
//! step:    [ (kindBase + action·8)<<4 | durHi, durMid, durLo, usage ]
//!   duration = 20-bit value ((byte0 & 0x0F)<<16 | byte1<<8 | byte2)
//!   kindBase: 0 = key, 1 = modifier, 2 = mouse
//!   action:   0 = down/press, 1 = up/release
//!   usage:    HID usage id / mouse button code (vendor `fe` table, u8)
//! ```
//!
//! The first header's `offset` doubles as the header-table length `r`
//! (`r = a[0] | a[1]<<8`, must be ≥4, ≤ region length, multiple of 4) —
//! the vendor scanner parses exactly `r/4` headers and then reads bodies
//! sequentially from offset `r`. `assembleGroupsWithLog` writes all
//! headers first, then all bodies, so `offset[i] = 4·N + Σ len[j<i]`.
//!
//! The vendor write path (`setKeyBoardMacroKey`, `deleteKeyBoardMacroKey`,
//! `setKeyBoardMacroIndependent`) always sends the region **zero-padded to
//! 512 bytes** in one cmd-5 feature report `[5,0,0,1,0,len&0xFF,0]` —
//! `len` is the padded length (512 → tag byte 0).

use anyhow::{bail, Result};
use serde::Serialize;

/// Macro region capacity on the wire (also the keymap payload size).
pub const MACRO_REGION_BYTES: usize = 512;
/// Vendor sanity bound on a single entry body length (`p < 1e4` check in
/// `extractPossibleHeaders`).
const MAX_ENTRY_LEN: usize = 10_000;
/// Largest storable step duration: the wire field is 20 bits —
/// `(byte0 & 0x0F) << 16 | byte1 << 8 | byte2` (spec §6; the vendor
/// recorder's `duration>>16&15` keeps only the low nibble of the top
/// byte, so durations ≥ 2^20 silently truncate — we reject them).
pub const MAX_STEP_DURATION: u32 = 0x000F_FFFF;

// ── Step / entry model ──────────────────────────────────────────────────

/// Step key class — the low 3 bits of the step's high nibble
/// (`kindBase` above). `Other` preserves an unrecognized raw nibble
/// verbatim on decode→encode round-trips.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    /// Plain key (nibble base 0).
    Key,
    /// Modifier key — Shift/Ctrl/Meta/Alt family (nibble base 1).
    Modifier,
    /// Mouse button (nibble base 2).
    Mouse,
    /// Unrecognized nibble, kept as the raw 4-bit value (3-7, 11-15).
    Other(u8),
}

impl StepKind {
    /// Nibble base written on encode (Key=0, Modifier=1, Mouse=2).
    fn base(self) -> Option<u8> {
        match self {
            StepKind::Key => Some(0),
            StepKind::Modifier => Some(1),
            StepKind::Mouse => Some(2),
            StepKind::Other(_) => None,
        }
    }
}

/// One macro step: press or release `usage` after `delay_ms`.
///
/// `action`: 0 = down/press, 1 = up/release (the vendor `action` field;
/// the wire nibble is `kindBase + action*8`). `delay_ms` is the stored
/// 20-bit duration — the vendor recorder stores the interval *following*
/// each event until the next one (device-side playback semantics are
/// code-verified only, spec §8).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MacroStep {
    /// 0 = down/press, 1 = up/release.
    pub action: u8,
    /// Stored duration in milliseconds (0..=`MAX_STEP_DURATION`).
    pub delay_ms: u32,
    /// Key code byte (HID usage or mouse button value, vendor `fe` table).
    pub usage: u8,
    /// Key class selecting the nibble base.
    pub kind: StepKind,
}

/// One named macro: UTF-8 name (≤255 bytes) plus its steps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MacroEntry {
    pub name: String,
    pub steps: Vec<MacroStep>,
}

impl MacroEntry {
    /// Wire body length: 1 (nameLen) + name bytes + 4·steps.
    pub fn body_len(&self) -> Result<usize> {
        let name_len = self.name.len(); // String::len is UTF-8 bytes
        if name_len > u8::MAX as usize {
            bail!("macro name too long: {name_len} bytes (max 255)");
        }
        let len = 1 + name_len + self.steps.len() * 4;
        if len > u16::MAX as usize {
            bail!("macro '{}' body too large: {len} bytes", self.name);
        }
        Ok(len)
    }
}

// ── Vendor `fe` key-name table (KeyboardEvent.code → usage value) ────────
//
// 110 entries extracted verbatim from the vendor JS. Values >255
// ("Fn" = 0x0D000000, "counter") cannot appear in a step's u8 usage byte —
// the vendor wraps them to 0; we reject them instead.

/// `(name, usage)` pairs in vendor table order (first match wins on
/// decode, exactly like `fe.find`).
pub const MACRO_KEY_TABLE: &[(&str, u32)] = &[
    ("ESC", 41), ("Backquote", 53), ("Tab", 43), ("CapsLock", 57),
    ("ShiftLeft", 225), ("ControlLeft", 224), ("Digit1", 30), ("KeyQ", 20),
    ("KeyA", 4), ("KeyZ", 29), ("MetaLeft", 227), ("F1", 58),
    ("Digit2", 31), ("KeyW", 26), ("KeyS", 22), ("KeyX", 27),
    ("AltLeft", 226), ("F2", 59), ("Digit3", 32), ("KeyE", 8),
    ("KeyD", 7), ("KeyC", 6), ("F3", 60), ("Digit4", 33),
    ("KeyR", 21), ("KeyF", 9), ("KeyV", 25), ("F4", 61),
    ("Digit5", 34), ("KeyT", 23), ("KeyG", 10), ("KeyB", 5),
    ("Space", 44), ("F5", 62), ("Digit6", 35), ("KeyY", 28),
    ("KeyH", 11), ("KeyN", 17), ("F6", 63), ("Digit7", 36),
    ("KeyU", 24), ("KeyJ", 13), ("KeyM", 16), ("F7", 64),
    ("Digit8", 37), ("KeyI", 12), ("KeyK", 14), ("Comma", 54),
    ("AltRight", 230), ("F8", 65), ("Digit9", 38), ("KeyO", 18),
    ("KeyL", 15), ("Period", 55), ("Fn", 218103808), ("F9", 66),
    ("Digit0", 39), ("KeyP", 19), ("Semicolon", 51), ("Slash", 56),
    ("ContextMenu", 101), ("F10", 67), ("Minus", 45), ("BracketLeft", 47),
    ("Quote", 52), ("F11", 68), ("Equal", 46), ("BracketRight", 48),
    ("Enter", 40), ("ShiftRight", 229), ("ControlRight", 228), ("F12", 69),
    ("Back", 42), ("Backslash", 49), ("Print", 70), ("Insert", 73),
    ("Delete", 76), ("ArrowLeft", 80), ("ScrollLock", 71), ("Home", 74),
    ("End", 77), ("ArrowUp", 82), ("ArrowDown", 81), ("Pause", 72),
    ("PageUp", 75), ("PageDown", 78), ("ArrowRight", 79),
    ("counter", 33554834), ("NumLock", 83), ("Numpad7", 95),
    ("Numpad4", 92), ("Numpad1", 89), ("Numpad0", 98),
    ("NumpadDivide", 84), ("Numpad8", 96), ("Numpad5", 93),
    ("Numpad2", 90), ("NumpadMultiply", 85), ("Numpad9", 97),
    ("Numpad6", 94), ("Numpad3", 91), ("NumpadDecimal", 99),
    ("NumpadSubtract", 86), ("NumpadAdd", 87), ("NumpadEnter", 88),
    ("MouseLeft", 1), ("MouseMiddle", 4), ("MouseRight", 2),
    ("MouseBack", 16), ("MouseForward", 8),
];

/// Names the vendor treats as modifiers for the nibble base
/// (`ie`/`me`/`N`/`z`/`D` lists in the JS encode paths).
pub const MODIFIER_KEY_NAMES: &[&str] = &[
    "ShiftLeft", "ControlLeft", "MetaLeft", "AltLeft", "AltRight",
    "ShiftRight", "ControlRight",
];

/// Names the vendor treats as mouse buttons (nibble base 2).
pub const MOUSE_KEY_NAMES: &[&str] = &[
    "MouseLeft", "MouseRight", "MouseMiddle", "MouseForward", "MouseBack",
];

/// Usage value for a vendor key name (`fe.find(name)`); `None` = unknown.
pub fn macro_usage_for_name(name: &str) -> Option<u32> {
    MACRO_KEY_TABLE
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, v)| *v)
}

/// Vendor display name for a usage byte: the mouse special cases
/// (`MouseForward`=8 / `MouseBack`=16 only when the nibble is a mouse
/// action) then first-match `fe.find(value)`; `None` when unnamed.
pub fn macro_name_for_usage(usage: u8, kind: StepKind) -> Option<&'static str> {
    if kind == StepKind::Mouse {
        match usage {
            8 => return Some("MouseForward"),
            16 => return Some("MouseBack"),
            _ => {}
        }
    }
    MACRO_KEY_TABLE
        .iter()
        .find(|(_, v)| *v == usage as u32)
        .map(|(n, _)| *n)
}

/// Default [`StepKind`] for a vendor key name (modifier/mouse lists).
pub fn default_kind_for_name(name: &str) -> StepKind {
    if MODIFIER_KEY_NAMES.contains(&name) {
        StepKind::Modifier
    } else if MOUSE_KEY_NAMES.contains(&name) {
        StepKind::Mouse
    } else {
        StepKind::Key
    }
}

// ── Decode (vendor `extractPossibleHeaders` + `getKeyBoardMacroKeyList`) ──

fn u16le(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

/// Decode one 4-byte step `[b0, b1, b2, b3]`:
/// `nibble = b0 >> 4`, `duration = (b0&15)<<16 | b1<<8 | b2`, `usage = b3`.
fn decode_step(b: &[u8]) -> MacroStep {
    debug_assert_eq!(b.len(), 4);
    let nibble = b[0] >> 4;
    // Vendor action map {0:0,1:0,8:1,9:1,2:0,10:1} — everything else → 0.
    let action = if matches!(nibble, 8..=10) { 1 } else { 0 };
    let kind = match nibble {
        0 | 8 => StepKind::Key,
        1 | 9 => StepKind::Modifier,
        2 | 10 => StepKind::Mouse,
        n => StepKind::Other(n),
    };
    MacroStep {
        action,
        delay_ms: (((b[0] & 0x0F) as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32,
        usage: b[3],
        kind,
    }
}

/// Parse the raw cmd-133 region into macro entries. Mirrors the vendor
/// `extractPossibleHeaders` scan exactly: `r = u16le(region[0..2])` is the
/// header-table length; headers are read while `s+3 < r`, a header is
/// accepted only when `len>0 && len<10000 && offset>=r && offset+len<=len(region)`
/// (scan stops at the first rejected header), then bodies are consumed
/// sequentially from `r`.
///
/// An all-zero or empty region yields `Ok(vec![])` — the vendor treats it
/// as "no macros". Malformed entries (short bodies, bad name length) are
/// decoded leniently rather than failing the whole region.
pub fn parse_macro_region(region: &[u8]) -> Result<Vec<MacroEntry>> {
    if region.len() < 4 {
        return Ok(Vec::new());
    }
    let r = u16le(region, 0) as usize;
    if r < 4 || r > region.len() || r % 4 != 0 {
        return Ok(Vec::new());
    }
    // Header scan (vendor: break on first invalid header).
    let mut headers: Vec<(usize, usize)> = Vec::new(); // (offset, length)
    let mut s = 0usize;
    while s + 3 < r {
        let off = u16le(region, s) as usize;
        let len = u16le(region, s + 2) as usize;
        let plausible = len > 0
            && len < MAX_ENTRY_LEN
            && off >= r
            && off < region.len()
            && off + len <= region.len();
        if plausible {
            headers.push((off, len));
            s += 4;
        } else {
            break;
        }
    }
    // Bodies are consumed sequentially from `r`, ignoring `offset` for
    // positioning (vendor `a.slice(o, o+len)`), exactly like the JS.
    let mut out = Vec::with_capacity(headers.len());
    let mut o = r;
    for &(_off, len) in &headers {
        if o + len > region.len() {
            break;
        }
        let body = &region[o..o + len];
        o += len;
        out.push(decode_body(body));
    }
    Ok(out)
}

/// Decode one entry body `[nameLen][name][steps…]` (lenient on truncation).
fn decode_body(body: &[u8]) -> MacroEntry {
    if body.is_empty() {
        return MacroEntry {
            name: String::new(),
            steps: Vec::new(),
        };
    }
    let name_len = body[0] as usize;
    let name_bytes = &body[1..body.len().min(1 + name_len)];
    // Vendor strips zero bytes before the UTF-8 decode.
    let name_bytes: Vec<u8> = name_bytes.iter().copied().filter(|&b| b != 0).collect();
    let name = String::from_utf8_lossy(&name_bytes).into_owned();
    let steps_start = 1 + name_len;
    let steps_raw = if steps_start <= body.len() {
        &body[steps_start..]
    } else {
        &[][..]
    };
    let steps = steps_raw
        .chunks_exact(4)
        .map(decode_step)
        .collect();
    MacroEntry { name, steps }
}

// ── Encode (vendor `assembleGroupsWithLog` write path) ──────────────────

/// Encode one step to its 4 wire bytes. `kind`/`action` select the nibble
/// exactly like the vendor (`base + action*8`); `Other(n)` writes the raw
/// nibble `n` and ignores `action`.
fn encode_step(step: &MacroStep) -> Result<[u8; 4]> {
    if step.action > 1 {
        bail!("macro step action must be 0 or 1, got {}", step.action);
    }
    if step.delay_ms > MAX_STEP_DURATION {
        bail!(
            "macro step delay {} ms exceeds 20-bit max {}",
            step.delay_ms,
            MAX_STEP_DURATION
        );
    }
    let nibble = match step.kind {
        StepKind::Other(n) => n,
        k => {
            let base = k
                .base()
                .expect("Other handled above");
            base + step.action * 8
        }
    };
    let d = step.delay_ms;
    Ok([
        ((nibble & 0x0F) << 4) | ((d >> 16) & 0x0F) as u8,
        ((d >> 8) & 0xFF) as u8,
        (d & 0xFF) as u8,
        step.usage,
    ])
}

/// Build the assembled (unpadded) macro region for `entries`:
/// `[4·N header bytes][bodies…]`. The result is at most
/// [`MACRO_REGION_BYTES`] - 4·N... actually the whole region must fit in
/// 512 B; pad with zeros for the wire via [`pad_macro_region`].
pub fn build_macro_region(entries: &[MacroEntry]) -> Result<Vec<u8>> {
    // Validate + encode bodies first.
    let mut bodies: Vec<Vec<u8>> = Vec::with_capacity(entries.len());
    for e in entries {
        let name_bytes = e.name.as_bytes();
        if name_bytes.len() > u8::MAX as usize {
            bail!("macro name too long: {} bytes (max 255)", name_bytes.len());
        }
        let mut body = Vec::with_capacity(e.body_len()?);
        body.push(name_bytes.len() as u8);
        body.extend_from_slice(name_bytes);
        for s in &e.steps {
            body.extend_from_slice(&encode_step(s)?);
        }
        bodies.push(body);
    }
    let n = entries.len();
    let header_table = 4 * n;
    let total: usize = header_table + bodies.iter().map(Vec::len).sum::<usize>();
    if total > MACRO_REGION_BYTES {
        bail!(
            "macro region needs {total} bytes, max {MACRO_REGION_BYTES} — delete unused macros first"
        );
    }
    // Headers: offset = absolute body position, len = body length (LE u16).
    let mut region = vec![0u8; total];
    let mut cursor = header_table;
    for (i, body) in bodies.iter().enumerate() {
        let off = cursor as u16;
        let len = body.len() as u16;
        let h = i * 4;
        region[h..h + 2].copy_from_slice(&off.to_le_bytes());
        region[h + 2..h + 4].copy_from_slice(&len.to_le_bytes());
        cursor += body.len();
    }
    let mut pos = header_table;
    for body in &bodies {
        region[pos..pos + body.len()].copy_from_slice(body);
        pos += body.len();
    }
    Ok(region)
}

/// Zero-pad an assembled region to the fixed 512-byte wire payload the
/// vendor always sends (`p.concat(zeros)` in the JS).
pub fn pad_macro_region(region: &[u8]) -> Result<Vec<u8>> {
    if region.len() > MACRO_REGION_BYTES {
        bail!(
            "macro region {} bytes exceeds {MACRO_REGION_BYTES}",
            region.len()
        );
    }
    let mut out = region.to_vec();
    out.resize(MACRO_REGION_BYTES, 0);
    Ok(out)
}

/// Vendor `findFirstNConsecutiveZeros(region, 4)` space check: returns the
/// number of bytes from the first run of ≥4 zero bytes to the end of the
/// region (0 when no such run exists). Used to pre-flight "is there room
/// for another macro" exactly like the MacroConfiguration page.
pub fn macro_free_space(region: &[u8]) -> usize {
    let mut run = 0usize;
    for (i, &b) in region.iter().enumerate() {
        if b == 0 {
            run += 1;
            if run == 4 {
                return region.len() - (i + 1 - 4);
            }
        } else {
            run = 0;
        }
    }
    0
}

/// Vendor estimate for the space a macro needs
/// (`5 + utf8(name).len + steps*4`, MacroConfiguration page `se()`).
pub fn macro_space_needed(name: &str, steps: usize) -> usize {
    5 + name.len() + steps * 4
}

/// Keymap tag-3 value binding a key slot to macro `index`
/// (`"0x03" + type + num + index` in the vendor JS):
/// `0x03<<24 | type<<16 | num<<8 | index`. `type` is the macro type byte
/// (vendor binds with 1) and `num` the loop count (vendor UI default 1).
pub fn macro_key_value(macro_type: u8, num: u8, index: u8) -> u32 {
    0x0300_0000 | ((macro_type as u32) << 16) | ((num as u32) << 8) | index as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(action: u8, delay: u32, usage: u8, kind: StepKind) -> MacroStep {
        MacroStep {
            action,
            delay_ms: delay,
            usage,
            kind,
        }
    }

    #[test]
    fn region_roundtrip_build_parse() {
        let entries = vec![
            MacroEntry {
                name: "hello".into(),
                steps: vec![
                    step(0, 8, 4, StepKind::Key),     // KeyA down, 8ms
                    step(1, 120, 4, StepKind::Key),  // KeyA up
                    step(0, 0, 225, StepKind::Modifier), // ShiftLeft down
                    step(1, 0, 1, StepKind::Mouse),  // MouseLeft up
                ],
            },
            MacroEntry {
                name: "second".into(),
                steps: vec![step(0, 1000, 30, StepKind::Key)],
            },
        ];
        let region = build_macro_region(&entries).unwrap();
        let padded = pad_macro_region(&region).unwrap();
        assert_eq!(padded.len(), MACRO_REGION_BYTES);
        // Header table = 8 bytes; first offset must be 8.
        assert_eq!(u16le(&padded, 0), 8);
        let parsed = parse_macro_region(&padded).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "hello");
        assert_eq!(parsed[0].steps.len(), 4);
        assert_eq!(parsed[0].steps[0], step(0, 8, 4, StepKind::Key));
        assert_eq!(parsed[0].steps[1], step(1, 120, 4, StepKind::Key));
        assert_eq!(parsed[0].steps[2], step(0, 0, 225, StepKind::Modifier));
        assert_eq!(parsed[0].steps[3], step(1, 0, 1, StepKind::Mouse));
        assert_eq!(parsed[1].name, "second");
        assert_eq!(parsed[1].steps[0].delay_ms, 1000);
    }

    #[test]
    fn empty_region_parses_empty() {
        assert!(parse_macro_region(&[]).unwrap().is_empty());
        assert!(parse_macro_region(&[0u8; 512]).unwrap().is_empty());
        // r < 4 → empty.
        assert!(parse_macro_region(&[2, 0, 0, 0]).unwrap().is_empty());
        // r odd → empty.
        assert!(parse_macro_region(&[3, 0, 0, 0, 0, 0, 0, 0]).unwrap().is_empty());
    }

    #[test]
    fn single_macro_wire_bytes() {
        // One macro "A", one step KeyA down 8ms / up 0ms — verify exact bytes.
        let entries = vec![MacroEntry {
            name: "A".into(),
            steps: vec![
                step(0, 8, 4, StepKind::Key),
                step(1, 0, 4, StepKind::Key),
            ],
        }];
        let region = build_macro_region(&entries).unwrap();
        // body = [1,'A', s0(4), s1(4)] = 10 bytes; header len field = 10.
        // header: offset=4, len=10 → [04 00 0A 00]; body at offset 4:
        // [nameLen=1,'A', step0(4B), step1(4B)].
        // step0: nibble 0, dur 8 → [0x00,0x00,0x08,0x04]
        // step1: nibble 8, dur 0 → [0x80,0x00,0x00,0x04]
        assert_eq!(
            &region[..14],
            &[
                0x04, 0x00, 0x0A, 0x00, 0x01, b'A', 0x00, 0x00, 0x08, 0x04, 0x80, 0x00, 0x00,
                0x04
            ]
        );
        assert_eq!(region.len(), 14);
        let parsed = parse_macro_region(&pad_macro_region(&region).unwrap()).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "A");
        assert_eq!(parsed[0].steps.len(), 2);
    }

    #[test]
    fn modifier_and_mouse_nibbles() {
        // ShiftLeft down → nibble 1; up → 9. MouseLeft down → 2; up → 10.
        assert_eq!(encode_step(&step(0, 0, 225, StepKind::Modifier)).unwrap()[0] >> 4, 1);
        assert_eq!(encode_step(&step(1, 0, 225, StepKind::Modifier)).unwrap()[0] >> 4, 9);
        assert_eq!(encode_step(&step(0, 0, 1, StepKind::Mouse)).unwrap()[0] >> 4, 2);
        assert_eq!(encode_step(&step(1, 0, 1, StepKind::Mouse)).unwrap()[0] >> 4, 10);
        // Decode maps them back.
        let s = decode_step(&[0x10, 0, 0, 225]);
        assert_eq!((s.action, s.kind), (0, StepKind::Modifier));
        let s = decode_step(&[0x90, 0, 0, 225]);
        assert_eq!((s.action, s.kind), (1, StepKind::Modifier));
        let s = decode_step(&[0x20, 0, 0, 1]);
        assert_eq!((s.action, s.kind), (0, StepKind::Mouse));
        let s = decode_step(&[0xA0, 0, 0, 1]);
        assert_eq!((s.action, s.kind), (1, StepKind::Mouse));
        // Unknown nibble preserved as Other (raw value kept).
        let s = decode_step(&[0xB0, 0, 0, 7]);
        assert_eq!((s.action, s.kind), (0, StepKind::Other(11)));
        // Other round-trips verbatim.
        let mut o = s;
        o.action = 1; // ignored for Other
        assert_eq!(encode_step(&o).unwrap()[0] >> 4, 11);
    }

    #[test]
    fn duration_is_20bit() {
        let s = step(0, 0xABCDE, 30, StepKind::Key);
        let b = encode_step(&s).unwrap();
        assert_eq!(b[0] & 0x0F, 0xA); // 0xABCDE >> 16 & 0xF
        assert_eq!(b[1], 0xBC);
        assert_eq!(b[2], 0xDE);
        assert_eq!(decode_step(&b).delay_ms, 0xABCDE);
        // 20-bit ceiling and just above it.
        assert!(encode_step(&step(0, MAX_STEP_DURATION, 1, StepKind::Key)).is_ok());
        assert!(encode_step(&step(0, MAX_STEP_DURATION + 1, 1, StepKind::Key)).is_err());
    }

    #[test]
    fn build_rejects_oversize() {
        // 128 steps × 4 B + name ≈ 512+ → too big with two entries.
        let big = MacroEntry {
            name: "x".into(),
            steps: vec![step(0, 0, 1, StepKind::Key); 120],
        };
        assert!(build_macro_region(&[big.clone(), big]).is_err());
        // Long name rejected.
        let long = MacroEntry {
            name: "n".repeat(256),
            steps: vec![],
        };
        assert!(build_macro_region(&[long]).is_err());
    }

    #[test]
    fn free_space_matches_vendor_scan() {
        // Region ending with ≥4 zeros → free = distance from first run.
        let mut r = vec![1u8, 2, 3, 4];
        r.extend_from_slice(&[0u8; 100]);
        assert_eq!(macro_free_space(&r), 100);
        // No 4-zero run → 0.
        assert_eq!(macro_free_space(&[1, 2, 3, 0, 1, 2, 3, 0]), 0);
        // Exactly at start.
        assert_eq!(macro_free_space(&[0u8; 512]), 512);
    }

    #[test]
    fn key_value_encoding() {
        // "0x03" + type + num + index.
        assert_eq!(macro_key_value(1, 1, 0), 0x0301_0100);
        assert_eq!(macro_key_value(1, 1, 5), 0x0301_0105);
        let v = macro_key_value(1, 2, 255);
        assert_eq!(v, 0x0301_02FF);
        // Round-trips through decode_key_value.
        let kv = crate::decode_key_value(v);
        assert_eq!(
            kv,
            crate::KeyValue::Macro {
                macro_type: 1,
                number: 2,
                index: 255
            }
        );
    }

    #[test]
    fn name_table_lookups() {
        assert_eq!(macro_usage_for_name("KeyA"), Some(4));
        assert_eq!(macro_usage_for_name("MouseLeft"), Some(1));
        assert_eq!(macro_usage_for_name("Nope"), None);
        // First match wins like fe.find: usage 4 → "KeyA" (before MouseMiddle).
        assert_eq!(macro_name_for_usage(4, StepKind::Key), Some("KeyA"));
        // Mouse special cases only under Mouse kind.
        assert_eq!(macro_name_for_usage(8, StepKind::Mouse), Some("MouseForward"));
        assert_eq!(macro_name_for_usage(8, StepKind::Key), Some("KeyE"));
        assert_eq!(macro_name_for_usage(16, StepKind::Mouse), Some("MouseBack"));
        assert_eq!(default_kind_for_name("ShiftLeft"), StepKind::Modifier);
        assert_eq!(default_kind_for_name("MouseRight"), StepKind::Mouse);
        assert_eq!(default_kind_for_name("KeyA"), StepKind::Key);
    }

    #[test]
    fn multi_entry_offsets() {
        let entries = vec![
            MacroEntry { name: "a".into(), steps: vec![step(0,1,1,StepKind::Key)] },
            MacroEntry { name: "bb".into(), steps: vec![] },
        ];
        let region = build_macro_region(&entries).unwrap();
        // N=2 → header table 8. body0 len = 1+1+4=6 → off0=8; body1 len=1+2=3 → off1=14.
        assert_eq!(u16le(&region, 0), 8);
        assert_eq!(u16le(&region, 2), 6);
        assert_eq!(u16le(&region, 4), 14);
        assert_eq!(u16le(&region, 6), 3);
        let parsed = parse_macro_region(&pad_macro_region(&region).unwrap()).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].name, "bb");
        assert!(parsed[1].steps.is_empty());
    }
}
