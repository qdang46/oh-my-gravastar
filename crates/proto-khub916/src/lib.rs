//! GravaStar K1 / K1 Pro / K1 Lite / K98 Pro "khub916" wired protocol
//! (Web HubX Pro `916` engine class `Ht`).
//!
//! Transport: numbered HID **feature** reports on the vendor collection
//! (usage page ≥ 0xFF00). Requests are a 519-byte payload zero-padded into
//! the feature report `[reportId][519 bytes]`; the device answers with a
//! feature report that **echoes the 7-byte request header** followed by a
//! variable-length payload. There is no checksum, sequence number or ACK on
//! this transport. See `docs/protocol-khub916.md` — it is the binding spec.
//!
//! Request header (7 bytes):
//! `[cmd, arg, 0x00, 0x01, 0x00, tagA, tagB]` — bytes 2/3/4 are constant in
//! every observed command (likely fixed version markers, spec §8) and
//! tagA/tagB look like an expected-response channel tag (semantics
//! unconfirmed). Responses echo all 7 bytes; the payload starts at offset 7
//! after the report id is stripped.
//!
//! # Safety (docs/plan.md §2 + docs/protocol-khub916.md §8)
//!
//! **Read-only by default.** Only query commands and three write commands
//! whose payload layout is documented in the spec are implemented:
//!
//! - reads: device info (130), keymap (131), profile (132), macro region
//!   (133), custom light colours (134), power (135), light colour data (138)
//! - writes: keymap (3), profile/config (4), custom light colours (6) —
//!   each performs a read-back verify before reporting success.
//!
//! Screen commands (11 clock sync, 12 frame data, 13 begin/end — see
//! `docs/protocol-khub916-screen.md`) are implemented as explicit named
//! methods ([`Khub916::screen_begin`], [`Khub916::screen_frame`],
//! [`Khub916::screen_push`], [`Khub916::screen_end`],
//! [`Khub916::set_screen_clock`]). They are fire-and-forget feature-report
//! writes, display-only, and **hardware-unverified** (no screen device was
//! ever attached; the K98 Pro screen is normally a separate HID interface
//! that uses the same packet layout).
//!
//! The `916_wireLess` 2.4 GHz dongle transport lives in [`wireless`]
//! (`Khub916Wireless`): 19-byte output reports, 14-byte chunked writes,
//! additive checksum, input-report reassembly — code-verified only.
//!
//! **Never implemented** (protocol blacklist / out of scope):
//!
//! - keyboard reset 17 (wired) and wireless cmd 6 factory reset
//! - SOCD/MT/TGL history write 18 and config read 146 (wired)
//! - macro region write 5 (wired; chunk semantics not fully proven)
//! - GIF light frames 8 (keyboard backlight, unrelated to the screen)
//! - no generic "send arbitrary command" API exists; [`Khub916::transact`]
//!   is private so unknown opcodes cannot be emitted, and the wireless
//!   chunked writer is private likewise.
//!
//! Write commands are *inferred* from the vendor JS (spec §6 marks the
//! payload layouts code-verified, not live-verified). Callers must gate
//! them behind explicit user confirmation; this crate performs no gating.

use std::fmt;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use omg_hid::devices::{KHUB916_WIRED, KHUB916_WIRED_USAGE_PAGE_MIN};
use omg_hid::Link;
use serde::Serialize;

pub mod wireless;

// ── Wire constants (docs/protocol-khub916.md §2/§6) ─────────────────────

/// Feature-report payload size: every request is zero-padded to this.
pub const FEATURE_PAYLOAD_BYTES: usize = 519;
/// Echoed request header length; payload starts right after it.
const HEADER_LEN: usize = 7;
/// Keymap write payload: 128 × u32 BE plus the `5A A5` end marker.
pub const KEYMAP_ENTRIES: usize = 128;
/// Custom-light write payload: 126 R + 126 G + 126 B plane bytes.
pub const CUSTOM_LIGHT_ENTRIES: usize = 126;

/// Response timeout. The JS driver uses 3000 ms; hidapi feature-report reads
/// are blocking control transfers, so this bounds retries, not the syscall.
const TRANSPORT_TIMEOUT: Duration = Duration::from_millis(3000);
const MAX_ATTEMPTS: usize = 3;

// Command opcodes (decimal values from spec §6).
const CMD_KEYMAP_WRITE: u8 = 3;
const CMD_PROFILE_WRITE: u8 = 4;
const CMD_CUSTOM_LIGHT_WRITE: u8 = 6;
const CMD_SCREEN_CLOCK: u8 = 11;
const CMD_SCREEN_FRAME: u8 = 12;
const CMD_SCREEN_BEGIN_END: u8 = 13;
const CMD_DEVICE_INFO: u8 = 130;
const CMD_KEYMAP_READ: u8 = 131;
const CMD_PROFILE_READ: u8 = 132;
const CMD_MACRO_READ: u8 = 133;
const CMD_CUSTOM_LIGHT_READ: u8 = 134;
const CMD_POWER_READ: u8 = 135;
const CMD_LIGHT_DATA_READ: u8 = 138;

// ── Device UUID / model catalog (spec §1, `Dp` table) ────────────────────

/// 6-byte device UUID burned into firmware. The vendor app treats it as the
/// "password": identity + license key in one. Serialized as `0x…` hex.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Uuid(pub [u8; 6]);

impl Uuid {
    /// Parse `"0x030000000197"` / `"030000000197"` (12 hex digits).
    pub fn parse_hex(s: &str) -> Result<Self> {
        let hex = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .unwrap_or(s);
        if hex.len() != 12 {
            bail!("khub916 UUID must be 6 bytes (12 hex digits), got {s:?}");
        }
        let mut out = [0u8; 6];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)
                .map_err(|_| anyhow!("invalid hex in UUID {s:?}"))?;
        }
        Ok(Uuid(out))
    }
}

impl fmt::Display for Uuid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "0x")?;
        for b in self.0 {
            write!(f, "{b:02x}")?;
        }
        Ok(())
    }
}

impl Serialize for Uuid {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// One row of the vendor `Dp` model catalog. `key_type` selects the vendor
/// legend table (`0` default, `3` JP); `None` = not established for that
/// entry. The wireless twin of a model shares the same UUID (`type:J`).
#[derive(Clone, Debug)]
pub struct CatalogEntry {
    pub model: &'static str,
    pub name: &'static str,
    pub uuid: Uuid,
    pub key_type: Option<u8>,
}

const fn u(hex: &[u8; 6]) -> Uuid {
    Uuid(*hex)
}

/// GravaStar entries of the vendor catalog (spec §1 table). Sub-model ↔
/// UUID pairing inside the JP/DE/K98 families follows the catalog listing
/// order [inferred]; the headline models are exact.
pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        model: "916_K1",
        name: "GravaStar Mercury K1",
        uuid: u(&[0x03, 0, 0, 0, 0x01, 0xb4]),
        key_type: Some(0),
    },
    CatalogEntry {
        model: "916_K1_PRO",
        name: "GravaStar Mercury K1 PRO",
        uuid: u(&[0x03, 0, 0, 0, 0x01, 0x97]),
        key_type: Some(0),
    },
    CatalogEntry {
        model: "916_K1_LITE",
        name: "GravaStar Mercury K1 LITE",
        uuid: u(&[0x03, 0, 0, 0, 0x01, 0xb5]),
        key_type: Some(0),
    },
    CatalogEntry {
        model: "916_K98Pro",
        name: "K98",
        uuid: u(&[0x06, 0, 0, 0, 0x00, 0xb3]),
        key_type: Some(0),
    },
    CatalogEntry {
        model: "916_GravaStar_Mercury_NP_PRO",
        name: "GravaStar Mercury NP PRO",
        uuid: u(&[0x06, 0, 0, 0, 0x00, 0xad]),
        key_type: Some(0),
    },
    CatalogEntry {
        model: "916_GravaStar_Mercury_NP",
        name: "GravaStar Mercury NP",
        uuid: u(&[0x06, 0, 0, 0, 0x00, 0xd4]),
        key_type: Some(0),
    },
    CatalogEntry {
        model: "916_K1_JP",
        name: "GravaStar Mercury K1 (JP)",
        uuid: u(&[0x03, 0, 0, 0, 0x04, 0x01]),
        key_type: Some(3),
    },
    CatalogEntry {
        model: "916_K1_LITE_JP",
        name: "GravaStar Mercury K1 LITE (JP)",
        uuid: u(&[0x03, 0, 0, 0, 0x04, 0x02]),
        key_type: Some(3),
    },
    CatalogEntry {
        model: "916_K1_LITE_PRO_JP",
        name: "GravaStar Mercury K1 LITE PRO (JP)",
        uuid: u(&[0x03, 0, 0, 0, 0x04, 0x00]),
        key_type: Some(3),
    },
    CatalogEntry {
        model: "916_K1_PRO_DE",
        name: "GravaStar Mercury K1 PRO (DE)",
        uuid: u(&[0x03, 0, 0, 0, 0x03, 0xf4]),
        key_type: None,
    },
    CatalogEntry {
        model: "916_K1_DE",
        name: "GravaStar Mercury K1 (DE)",
        uuid: u(&[0x03, 0, 0, 0, 0x03, 0xf5]),
        key_type: None,
    },
    CatalogEntry {
        model: "916_K1_LITE_DE",
        name: "GravaStar Mercury K1 LITE (DE)",
        uuid: u(&[0x03, 0, 0, 0, 0x03, 0xf6]),
        key_type: None,
    },
    CatalogEntry {
        model: "916_K98Pro_JP",
        name: "K98 (JP)",
        uuid: u(&[0x06, 0, 0, 0, 0x01, 0x0c]),
        key_type: Some(3),
    },
    CatalogEntry {
        model: "916_K98Pro_DE",
        name: "K98 (DE)",
        uuid: u(&[0x06, 0, 0, 0, 0x01, 0x04]),
        key_type: None,
    },
    CatalogEntry {
        model: "916_K98Pro_SE",
        name: "K98 (SE)",
        uuid: u(&[0x06, 0, 0, 0, 0x01, 0x10]),
        key_type: None,
    },
    CatalogEntry {
        model: "916_K98Pro_KR",
        name: "K98 (KR)",
        uuid: u(&[0x06, 0, 0, 0, 0x01, 0x13]),
        key_type: None,
    },
];

/// Catalog row for a device UUID (the vendor "password" check).
pub fn catalog_lookup(uuid: &Uuid) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.uuid == *uuid)
}

/// Catalog UUID for a model id, e.g. `"916_K1_PRO"`. `None` = unknown model.
pub fn catalog_uuid(model: &str) -> Option<Uuid> {
    CATALOG.iter().find(|e| e.model == model).map(|e| e.uuid)
}

// ── Response types ───────────────────────────────────────────────────────

/// Screen geometry codes (`Ha` map, spec §4).
fn screen_size_dims(code: u8) -> Option<(u16, u16)> {
    Some(match code {
        1 => (128, 128),
        2 => (160, 80),
        3 => (240, 135),
        4 => (240, 240),
        5 => (320, 172),
        6 => (428, 142),
        7 => (170, 320),
        _ => return None,
    })
}

/// Device identity reply (cmd 130): 6-byte UUID + u16 BE version + screen
/// size byte. Verified live on K1 Pro → `0x030000000197`, ver `0x0100`.
#[derive(Clone, Debug, Serialize)]
pub struct DeviceInfo {
    pub uuid: Uuid,
    /// Raw firmware version word (`0x0100` observed).
    pub version: u16,
    /// Vendor screen-size code; 0 = no screen on the keyboard interface.
    pub screen_size: u8,
    /// Decoded screen geometry when `screen_size` is a known code.
    pub screen: Option<(u16, u16)>,
    /// Catalog model id when the UUID is known, e.g. `"916_K1_PRO"`.
    pub catalog_model: Option<String>,
    pub catalog_name: Option<String>,
}

/// Power/battery reply (cmd 135): `[level, flags]`. Live: `0x64` = 100 %,
/// flags `0x11` observed while charging+full — individual flag bits are not
/// confirmed (spec §8), so they are exposed raw.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct PowerInfo {
    /// Battery percent 0–100 as reported by the firmware.
    pub percent: u8,
    /// Raw status flags byte.
    pub flags: u8,
}

/// One custom-light colour slot (cmd 134): plane index `i` has
/// `pos = 8 + i*4` in the keymap domain and RGB from the three planes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LightColor {
    pub index: usize,
    pub pos: u16,
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Decoded keymap value (u32 big-endian, spec §6 "Key value encoding").
///
/// The vendor `Ca` name table (868 entries) is not mirrored; labels come
/// from [`omg_model::key_label`] for plain HID usages plus modifier
/// prefixes. Exotic encodings (mouse buttons, media keys, dual modifier
/// encodings noted in spec §8) decode conservatively — see [`KeyValue::label`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KeyValue {
    /// `0x00000000` — unassigned.
    Empty,
    /// Type tag 0: `(modifier_bits << 16) | HID_usage`.
    Normal {
        usage: u16,
        ctrl: bool,
        shift: bool,
        alt: bool,
        gui: bool,
    },
    /// Type tag `0x0D`: Fn layer key (`0x0D000000` = Fn, `0x0D010000` = Fn1).
    Fn {
        layer: u8,
    },
    /// Type tag 3: macro reference; bits 23..16 type, 15..8 number, 7..0 index.
    Macro {
        macro_type: u8,
        number: u8,
        index: u8,
    },
    /// Type tag 7: secondary-layer key (exact semantics unconfirmed).
    SecondaryLayer {
        raw: u32,
    },
    /// Type tags 32/33/34: SOCD / MT / TGL advanced-key slots.
    Socd {
        raw: u32,
    },
    Mt {
        raw: u32,
    },
    Tgl {
        raw: u32,
    },
    /// Anything else, kept verbatim.
    Unknown {
        raw: u32,
    },
}

/// Decode one big-endian u32 keymap value. Tag = bits 31..24 (spec §6).
pub fn decode_key_value(v: u32) -> KeyValue {
    if v == 0 {
        return KeyValue::Empty;
    }
    match v >> 24 {
        0x00 => KeyValue::Normal {
            usage: (v & 0xFFFF) as u16,
            ctrl: v & 0x0001_0000 != 0,
            shift: v & 0x0002_0000 != 0,
            alt: v & 0x0004_0000 != 0,
            gui: v & 0x0008_0000 != 0,
        },
        0x03 => KeyValue::Macro {
            macro_type: ((v >> 16) & 0xFF) as u8,
            number: ((v >> 8) & 0xFF) as u8,
            index: (v & 0xFF) as u8,
        },
        0x07 => KeyValue::SecondaryLayer { raw: v },
        0x0D => KeyValue::Fn {
            layer: ((v >> 16) & 0xFF) as u8,
        },
        0x20 => KeyValue::Socd { raw: v },
        0x21 => KeyValue::Mt { raw: v },
        0x22 => KeyValue::Tgl { raw: v },
        _ => KeyValue::Unknown { raw: v },
    }
}

impl KeyValue {
    /// Human-readable label. Plain HID usages go through
    /// [`omg_model::key_label`]; modifier order is Ctrl, Shift, Alt, GUI.
    pub fn label(&self) -> String {
        match self {
            KeyValue::Empty => String::new(),
            KeyValue::Normal {
                usage,
                ctrl,
                shift,
                alt,
                gui,
            } => {
                let mut mods = Vec::new();
                for (on, name) in [
                    (*ctrl, "Ctrl"),
                    (*shift, "Shift"),
                    (*alt, "Alt"),
                    (*gui, "Win"),
                ] {
                    if on {
                        mods.push(name);
                    }
                }
                // usage 0 with modifier bits set is how the firmware encodes
                // bare modifier keys (observed live: Shift/Ctrl/Win rows).
                if *usage == 0 {
                    return if mods.is_empty() {
                        String::new()
                    } else {
                        mods.join("+")
                    };
                }
                let mut s = mods.join("+");
                if !s.is_empty() {
                    s.push('+');
                }
                s.push_str(&usage_label(*usage));
                s
            }
            KeyValue::Fn { layer } => {
                if *layer == 0 {
                    "Fn".to_string()
                } else {
                    format!("Fn{layer}")
                }
            }
            KeyValue::Macro {
                macro_type,
                number,
                index,
            } => {
                format!("Macro({macro_type},{number},{index})")
            }
            KeyValue::SecondaryLayer { raw } => format!("Layer2(0x{raw:08X})"),
            KeyValue::Socd { .. } => "SOCD".to_string(),
            KeyValue::Mt { .. } => "MT".to_string(),
            KeyValue::Tgl { .. } => "TGL".to_string(),
            KeyValue::Unknown { raw } => format!("0x{raw:08X}"),
        }
    }
}

/// Legend for a HID usage id; falls back to hex for usages the model table
/// does not name (mouse buttons `0x101xxxx`-style encodings land here as
/// their low u16 — decode is best-effort, spec §8).
fn usage_label(usage: u16) -> String {
    let label = omg_model::key_label(usage, false);
    if label.is_empty() {
        format!("0x{usage:02X}")
    } else {
        label
    }
}

/// Profile/config blob wrapper (cmd 132 read / cmd 4 write, ~128 B).
/// Field offsets below are code-verified from the vendor JS (spec §6);
/// they are exposed read-only and writes echo the blob verbatim.
#[derive(Clone, Debug, Serialize)]
pub struct Profile {
    pub raw: Vec<u8>,
}

impl Profile {
    /// Current light mode u16: `raw[9]!=0 ? raw[9]<<8|raw[10] : raw[10]`.
    pub fn light_mode(&self) -> Option<u16> {
        let e = &self.raw;
        if e.len() < 11 {
            return None;
        }
        Some(if e[9] != 0 {
            ((e[9] as u16) << 8) | e[10] as u16
        } else {
            e[10] as u16
        })
    }

    /// Keyboard sleep time in seconds (`profile[24]`).
    pub fn sleep_seconds(&self) -> Option<u8> {
        self.raw.get(24).copied()
    }
}

/// Result of a verified write: the mutation was sent AND the matching read
/// returned identical data.
#[derive(Clone, Debug, Serialize)]
pub struct WriteOutcome {
    pub command: u8,
    pub verified: bool,
}

// ── Session ──────────────────────────────────────────────────────────────

/// One open khub916 wired session. Feature-report reads are blocking; any
/// transport or framing error poisons the session (close and reopen).
pub struct Khub916 {
    link: Box<dyn Link>,
    report_id: u8,
    poisoned: bool,
}

impl Khub916 {
    pub fn new(link: Box<dyn Link>, report_id: u8) -> Self {
        Self {
            link,
            report_id,
            poisoned: false,
        }
    }

    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Discovery match: wired 916 VID/PID **and** the vendor usage page
    /// (≥ 0xFF00). `omg_hid::classify` already filters this way; this helper
    /// documents the requirement for callers matching raw triples.
    pub fn matches(vid: u16, pid: u16, usage_page: u16) -> bool {
        KHUB916_WIRED.contains(&(vid, pid)) && usage_page >= KHUB916_WIRED_USAGE_PAGE_MIN
    }

    fn guard<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        if self.poisoned {
            bail!("khub916 session poisoned by an earlier transport/framing error; close and reopen the device");
        }
        let result = f(self);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    /// Builds the 519-byte feature payload: 7-byte header + command payload,
    /// zero-padded. Bytes 2/3/4 are the constant `00 01 00` triple.
    fn packet(
        cmd: u8,
        arg: u8,
        tag_a: u8,
        tag_b: u8,
        payload: &[u8],
    ) -> Result<[u8; FEATURE_PAYLOAD_BYTES]> {
        if HEADER_LEN + payload.len() > FEATURE_PAYLOAD_BYTES {
            bail!(
                "khub916 packet too large: {} + {} > {FEATURE_PAYLOAD_BYTES}",
                HEADER_LEN,
                payload.len()
            );
        }
        let mut pkt = [0u8; FEATURE_PAYLOAD_BYTES];
        pkt[0] = cmd;
        pkt[1] = arg;
        pkt[3] = 0x01;
        pkt[5] = tag_a;
        pkt[6] = tag_b;
        pkt[HEADER_LEN..HEADER_LEN + payload.len()].copy_from_slice(payload);
        Ok(pkt)
    }

    /// Sends one feature report and returns the response payload (bytes
    /// after the echoed 7-byte header). Retries on echo mismatch / no
    /// answer; transport errors poison the session via [`Self::guard`].
    fn transact(&mut self, pkt: &[u8; FEATURE_PAYLOAD_BYTES]) -> Result<Vec<u8>> {
        let mut last = anyhow!("khub916: no attempt made");
        for _ in 0..MAX_ATTEMPTS {
            match self
                .link
                .feature_exchange(self.report_id, pkt, TRANSPORT_TIMEOUT)
                .map_err(|e| anyhow!("khub916 feature report failed: {e:#}"))
            {
                Ok(Some(resp)) if resp.len() >= HEADER_LEN => {
                    if resp[..HEADER_LEN] != pkt[..HEADER_LEN] {
                        last = anyhow!(
                            "khub916 echo mismatch: sent {:02x?}, got {:02x?}",
                            &pkt[..HEADER_LEN],
                            &resp[..HEADER_LEN]
                        );
                        continue;
                    }
                    return Ok(resp[HEADER_LEN..].to_vec());
                }
                Ok(Some(resp)) => {
                    last = anyhow!("khub916 short response: {} bytes", resp.len());
                }
                Ok(None) => last = anyhow!("khub916: no answer"),
                Err(e) => return Err(e),
            }
        }
        Err(last.context("khub916 command failed"))
    }

    /// Query helper: builds a header-only packet and returns payload bytes.
    fn query(&mut self, cmd: u8, arg: u8, tag_a: u8, tag_b: u8) -> Result<Vec<u8>> {
        let pkt = Self::packet(cmd, arg, tag_a, tag_b, &[])?;
        self.transact(&pkt)
    }

    // ── Reads (all live-verified query commands, spec §5/§6) ────────────

    /// Device info (cmd 130): UUID, firmware version, screen geometry.
    /// This is also the auth/identification step — the UUID is the catalog
    /// "password"; there is no challenge-response (spec §4).
    pub fn device_info(&mut self) -> Result<DeviceInfo> {
        self.guard(|s| {
            // Live request on K1 Pro: `82 01 00 01 00 0A 00` (arg=1, tags 10/0).
            let p = s.query(CMD_DEVICE_INFO, 0x01, 0x0A, 0x00)?;
            if p.len() < 9 {
                bail!("khub916 device info: short payload {} bytes", p.len());
            }
            let uuid = Uuid(p[0..6].try_into().expect("6 bytes"));
            let version = u16::from_be_bytes([p[6], p[7]]);
            let screen_size = p[8];
            let entry = catalog_lookup(&uuid);
            Ok(DeviceInfo {
                uuid,
                version,
                screen_size,
                screen: screen_size_dims(screen_size),
                catalog_model: entry.map(|e| e.model.to_string()),
                catalog_name: entry.map(|e| e.name.to_string()),
            })
        })
    }

    /// Keymap values for one layer/system arg (cmd 131). `arg` uses the
    /// keymap encoding `layer & 3 | (system & 1) << 2`; the live-verified
    /// default read used arg 0. Response payload = N × u32 BE.
    pub fn key_values(&mut self, arg: u8) -> Result<Vec<u32>> {
        self.guard(|s| {
            // Tags 248/1.
            let p = s.query(CMD_KEYMAP_READ, arg, 0xF8, 0x01)?;
            if p.len() % 4 != 0 {
                bail!(
                    "khub916 keymap: payload {} bytes not a multiple of 4",
                    p.len()
                );
            }
            Ok(p.chunks_exact(4)
                .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]))
                .collect())
        })
    }

    /// Keymap decoded to [`KeyValue`]s (see [`decode_key_value`]).
    pub fn keymap(&mut self, arg: u8) -> Result<Vec<KeyValue>> {
        Ok(self
            .key_values(arg)?
            .iter()
            .map(|&v| decode_key_value(v))
            .collect())
    }

    /// Profile/config blob (cmd 132, ~128 B; live reply was 135 B total =
    /// 7 header + 128 payload). Field accessors live on [`Profile`].
    pub fn profile(&mut self) -> Result<Profile> {
        self.guard(|s| {
            // Tags 128/0 (tagB sent as 0 padding, echoed back).
            let p = s.query(CMD_PROFILE_READ, 0x00, 0x80, 0x00)?;
            Ok(Profile { raw: p })
        })
    }

    /// Power/battery (cmd 135): `[level, flags]` (tags 2/0).
    pub fn power(&mut self) -> Result<PowerInfo> {
        self.guard(|s| {
            let p = s.query(CMD_POWER_READ, 0x00, 0x02, 0x00)?;
            if p.len() < 2 {
                bail!("khub916 power: short payload {} bytes", p.len());
            }
            Ok(PowerInfo {
                percent: p[0],
                flags: p[1],
            })
        })
    }

    /// Custom light colours (cmd 134): 378-byte reply = 126 R + 126 G +
    /// 126 B plane bytes (tags 122/1). Entry `i`: `pos = 8 + i*4`.
    pub fn custom_light_colors(&mut self) -> Result<Vec<LightColor>> {
        self.guard(|s| {
            let p = s.query(CMD_CUSTOM_LIGHT_READ, 0x00, 0x7A, 0x01)?;
            if p.len() < CUSTOM_LIGHT_ENTRIES * 3 {
                bail!("khub916 custom light: short payload {} bytes", p.len());
            }
            Ok((0..CUSTOM_LIGHT_ENTRIES)
                .map(|i| LightColor {
                    index: i,
                    pos: (8 + i * 4) as u16,
                    r: p[i],
                    g: p[CUSTOM_LIGHT_ENTRIES + i],
                    b: p[2 * CUSTOM_LIGHT_ENTRIES + i],
                })
                .collect())
        })
    }

    /// Per-mode light colour/effect blob (cmd 138, ~480 B payload;
    /// live reply was 490 B total). Raw bytes: per-mode 21-byte RGB groups
    /// at `mode*21` per the vendor JS (spec §6).
    pub fn light_color_data(&mut self) -> Result<Vec<u8>> {
        self.guard(|s| {
            // Tags 227/1.
            s.query(CMD_LIGHT_DATA_READ, 0x00, 0xE3, 0x01)
        })
    }

    /// Macro region (cmd 133, ≤512 B payload; live reply filled the whole
    /// 519-byte report). Raw assembled table — 4-byte entry headers then
    /// bodies, UTF-8 names, 4-byte macro steps (spec §6); parsing is left
    /// to callers until the header semantics are proven.
    pub fn macro_region(&mut self) -> Result<Vec<u8>> {
        self.guard(|s| {
            // Tags 0/2.
            s.query(CMD_MACRO_READ, 0x00, 0x00, 0x02)
        })
    }

    // ── Writes (inferred from vendor JS; every one read-back verified) ──

    /// Write the full 128-entry keymap (cmd 3, tags 248/1). `layer`/`system`
    /// pack into `arg = layer & 3 | (system & 1) << 2`. Payload = 512 bytes
    /// of u32 BE values + `5A A5` end marker (spec §6).
    ///
    /// Verify: re-reads cmd 131 with the same arg and requires the returned
    /// u32 list to equal `values` exactly (length included). A mismatch
    /// returns `Err` — the session is *not* poisoned (the write landed, the
    /// data differs).
    pub fn write_keymap(&mut self, layer: u8, system: u8, values: &[u32]) -> Result<WriteOutcome> {
        if values.len() != KEYMAP_ENTRIES {
            bail!(
                "khub916 keymap write needs exactly {KEYMAP_ENTRIES} values, got {}",
                values.len()
            );
        }
        let arg = (layer & 3) | ((system & 1) << 2);
        let mut payload = Vec::with_capacity(KEYMAP_ENTRIES * 4 + 2);
        for v in values {
            payload.extend_from_slice(&v.to_be_bytes());
        }
        payload.extend_from_slice(&[0x5A, 0xA5]);
        let pkt = Self::packet(CMD_KEYMAP_WRITE, arg, 0xF8, 0x01, &payload)?;
        self.guard(|s| {
            s.transact(&pkt)?;
            let back = s.key_values(arg)?;
            if back != values {
                bail!("khub916 keymap write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: CMD_KEYMAP_WRITE,
                verified: true,
            })
        })
    }

    /// Write the profile/config blob (cmd 4, tags 128/0). `profile` is the
    /// ~128-byte blob as returned by [`Self::profile`]; pass it back
    /// (optionally modified) — this crate does not interpret fields for
    /// writing. Verify: cmd 132 read-back must equal the sent bytes.
    pub fn write_profile(&mut self, profile: &[u8]) -> Result<WriteOutcome> {
        if profile.is_empty() || profile.len() > FEATURE_PAYLOAD_BYTES - HEADER_LEN {
            bail!("khub916 profile write: bad length {}", profile.len());
        }
        let pkt = Self::packet(CMD_PROFILE_WRITE, 0x00, 0x80, 0x00, profile)?;
        self.guard(|s| {
            s.transact(&pkt)?;
            let back = s.query(CMD_PROFILE_READ, 0x00, 0x80, 0x00)?;
            if back != profile {
                bail!("khub916 profile write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: CMD_PROFILE_WRITE,
                verified: true,
            })
        })
    }

    /// Write custom light colours (cmd 6, tags 122/1). `colors` must have
    /// exactly [`CUSTOM_LIGHT_ENTRIES`] entries; the 378-byte payload is
    /// `[R×126][G×126][B×126]` (spec §6). Verify: cmd 134 read-back planes
    /// must reproduce the same colours.
    pub fn write_custom_light_colors(&mut self, colors: &[Rgb]) -> Result<WriteOutcome> {
        if colors.len() != CUSTOM_LIGHT_ENTRIES {
            bail!(
                "khub916 custom light write needs exactly {CUSTOM_LIGHT_ENTRIES} colours, got {}",
                colors.len()
            );
        }
        let mut payload = Vec::with_capacity(CUSTOM_LIGHT_ENTRIES * 3);
        for c in colors {
            payload.push(c.r);
        }
        for c in colors {
            payload.push(c.g);
        }
        for c in colors {
            payload.push(c.b);
        }
        let pkt = Self::packet(CMD_CUSTOM_LIGHT_WRITE, 0x00, 0x7A, 0x01, &payload)?;
        self.guard(|s| {
            s.transact(&pkt)?;
            let back = s.custom_light_colors()?;
            let matches = back.len() == colors.len()
                && back
                    .iter()
                    .zip(colors)
                    .all(|(b, w)| (b.r, b.g, b.b) == (w.r, w.g, w.b));
            if !matches {
                bail!("khub916 custom light write not verified: read-back differs");
            }
            Ok(WriteOutcome {
                command: CMD_CUSTOM_LIGHT_WRITE,
                verified: true,
            })
        })
    }
}

/// RGB triple for [`Khub916::write_custom_light_colors`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

// ── Screen commands (docs/protocol-khub916-screen.md) ────────────────────
//
// All screen commands are fire-and-forget feature-report writes: the JS
// `nn` screen class never reads responses and `Ht` only parses replies for
// query commands. **Hardware-unverified** — no screen device was attached;
// the packet layout is code-verified only.

/// Pixel bytes carried by one cmd-12 chunk packet (bytes 7..519).
pub const SCREEN_CHUNK_BYTES: usize = 512;
/// u8 limits on the wire format: ≤255 chunks per frame, ≤255 frames.
pub const SCREEN_MAX_CHUNKS_PER_FRAME: usize = 255;
pub const SCREEN_MAX_FRAMES: usize = 255;

/// Inter-packet pacing for screen transfers. The vendor JS waits 30 ms per
/// chunk on the keyboard interface (`Ht.setKeyBoardImg`) and 50 ms on the
/// separate screen interface (`nn.setKeyBoardImg`), plus one equal delay
/// after each frame finishes. Device tolerance for faster pacing is unknown.
#[derive(Clone, Copy, Debug)]
pub struct ScreenPacing {
    /// Delay after every cmd-12 chunk packet.
    pub chunk_delay: Duration,
    /// Extra delay after each frame's last chunk.
    pub frame_delay: Duration,
}

impl ScreenPacing {
    /// Vendor pacing on the keyboard HID interface (`Ht`): 30 ms.
    pub fn keyboard_interface() -> Self {
        Self {
            chunk_delay: Duration::from_millis(30),
            frame_delay: Duration::from_millis(30),
        }
    }

    /// Vendor pacing on the separate screen interface (`nn`): 50 ms.
    pub fn screen_interface() -> Self {
        Self {
            chunk_delay: Duration::from_millis(50),
            frame_delay: Duration::from_millis(50),
        }
    }

    /// No pacing — only for tests/benchmarks; real devices should use the
    /// vendor pacing above until faster rates are proven on hardware.
    pub fn unpaced() -> Self {
        Self {
            chunk_delay: Duration::ZERO,
            frame_delay: Duration::ZERO,
        }
    }
}

impl Default for ScreenPacing {
    fn default() -> Self {
        Self::keyboard_interface()
    }
}

/// RTC value for the cmd-11 screen clock sync. `week` is the JS
/// `Date.getDay()` convention: 0 = Sunday … 6 = Saturday.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ScreenClock {
    /// Full year; sent little-endian (`year & 0xFF`, `year >> 8`).
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    /// 0 = Sunday … 6 = Saturday.
    pub week: u8,
}

impl ScreenClock {
    /// Validated constructor (the JS performs no validation, but sane RTC
    /// ranges are enforced here before anything is sent).
    pub fn new(
        year: u16,
        month: u8,
        day: u8,
        hour: u8,
        minute: u8,
        second: u8,
        week: u8,
    ) -> Result<Self> {
        if !(1..=12).contains(&month) {
            bail!("screen clock: month {month} out of range 1-12");
        }
        if !(1..=31).contains(&day) {
            bail!("screen clock: day {day} out of range 1-31");
        }
        if hour > 23 || minute > 59 || second > 59 {
            bail!("screen clock: time {hour:02}:{minute:02}:{second:02} out of range");
        }
        if week > 6 {
            bail!("screen clock: week {week} out of range 0-6");
        }
        Ok(Self {
            year,
            month,
            day,
            hour,
            minute,
            second,
            week,
        })
    }
}

/// Result of [`Khub916::screen_push`].
#[derive(Clone, Copy, Debug, Serialize)]
pub struct ScreenPushStats {
    pub frames: usize,
    pub chunks: usize,
    pub frame_bytes: usize,
}

/// Separate screen interface identity (screen spec §1 `va["916"][0]`):
/// screen-capable models expose the display as a second HID device, not
/// on the keyboard interface.
pub const SCREEN_INTERFACE_VID: u16 = 0x258A;
pub const SCREEN_INTERFACE_PID: u16 = 0x01B4;

/// Default frame geometry when the catalog `screen` field carries no
/// width/height — the K98 Pro vid/pid entry and spec §4's fallback.
pub const SCREEN_DEFAULT_WIDTH: u16 = 160;
pub const SCREEN_DEFAULT_HEIGHT: u16 = 80;

/// Frame cap enforced by the vendor GIF editor UI (spec §4); the wire
/// format itself allows up to [`SCREEN_MAX_FRAMES`] (255).
pub const SCREEN_UI_MAX_FRAMES: usize = 150;

/// How a catalog model's screen is attached (screen spec §1 `Dp` table).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScreenTopology {
    /// Screen shares the keyboard HID interface; pixel geometry comes
    /// from the cmd-130 `screen_size` code (916_K95 → 160×80).
    OnKeyboardInterface { width: u16, height: u16 },
    /// Screen is a second HID device at [`SCREEN_INTERFACE_VID`] /
    /// [`SCREEN_INTERFACE_PID`] (K98 Pro family, K80, Mercury NP PRO).
    /// Write-only: the JS screen class has no query/receive path.
    SeparateInterface,
}

/// Catalog screen topology for a model id (spec §1). `None` = the model
/// has no `screen` entry — treat it as screenless (e.g. K1 Pro).
pub fn catalog_screen(model: &str) -> Option<ScreenTopology> {
    Some(match model {
        "916_K95" => ScreenTopology::OnKeyboardInterface {
            width: 160,
            height: 80,
        },
        "916_K98Pro"
        | "916_K98Pro_JP"
        | "916_K98Pro_DE"
        | "916_K98Pro_SE"
        | "916_K98Pro_KR"
        | "916_K80"
        | "916_GravaStar_Mercury_NP_PRO"
        | "916_K98Pro_wireLess"
        | "916_K98Pro_JP_wireLess"
        | "916_K98Pro_DE_wireLess"
        | "916_K98Pro_KR_wireLess"
        | "916_K80_wireLess"
        | "916_GravaStar_Mercury_NP_PRO_wireLess" => ScreenTopology::SeparateInterface,
        _ => return None,
    })
}

/// One RGB888 triple → the two RGB565 big-endian bytes used on the wire
/// (screen spec §4: `((r>>3)&31)<<11 | ((g>>2)&63)<<5 | ((b>>3)&31)`,
/// high byte first; alpha is dropped).
pub fn rgb565_be(r: u8, g: u8, b: u8) -> [u8; 2] {
    let v = (((r >> 3) & 31) as u16) << 11
        | (((g >> 2) & 63) as u16) << 5
        | ((b >> 3) & 31) as u16;
    [(v >> 8) as u8, (v & 0xFF) as u8]
}

impl Khub916 {
    /// Build a screen packet: 7-byte prefix + payload at offset 7,
    /// zero-padded to 519. Works for all screen commands — cmd 12 simply
    /// uses its frame/chunk indices as prefix bytes 2/3.
    fn screen_packet(prefix: [u8; HEADER_LEN], payload: &[u8]) -> Result<[u8; FEATURE_PAYLOAD_BYTES]> {
        if payload.len() > FEATURE_PAYLOAD_BYTES - HEADER_LEN {
            bail!("khub916 screen packet too large: {} payload bytes", payload.len());
        }
        let mut pkt = [0u8; FEATURE_PAYLOAD_BYTES];
        pkt[..HEADER_LEN].copy_from_slice(&prefix);
        pkt[HEADER_LEN..HEADER_LEN + payload.len()].copy_from_slice(payload);
        Ok(pkt)
    }

    /// Fire-and-forget feature-report write (no response is read — the JS
    /// screen paths never call `receiveFeatureReport`).
    fn screen_write(&mut self, pkt: &[u8; FEATURE_PAYLOAD_BYTES]) -> Result<()> {
        self.guard(|s| {
            s.link
                .feature_write(s.report_id, pkt)
                .map_err(|e| anyhow!("khub916 screen feature write failed: {e:#}"))
        })
    }

    /// cmd 13 image-session begin. `frame_count` ≤ 255 and
    /// `frame_interval_ms` is the per-frame interval in milliseconds
    /// (`Math.round(1000/fps)` in the JS; the device-side unit is
    /// unverified — screen spec §8).
    ///
    /// **Hardware-unverified.** There is no width/height/format
    /// negotiation on the wire — geometry is fixed by the device model
    /// (screen spec §4/§8); frames must be `width*height*2` bytes of
    /// RGB565 big-endian data (160×80 → 25 600 B → 50 chunks is the common
    /// case).
    pub fn screen_begin(&mut self, frame_count: usize, frame_interval_ms: u16) -> Result<()> {
        if frame_count > SCREEN_MAX_FRAMES {
            bail!("khub916 screen: frame count {frame_count} exceeds {SCREEN_MAX_FRAMES}");
        }
        let payload = [
            0x40, // begin marker (footer sends 0x00)
            frame_count as u8,
            0x00, // frameCount high byte — always 0 on the wire
            frame_interval_ms as u8,
            (frame_interval_ms >> 8) as u8,
        ];
        let pkt = Self::screen_packet(
            [CMD_SCREEN_BEGIN_END, 0, 0, 0x01, 0, 0x05, 0x00],
            &payload,
        )?;
        self.screen_write(&pkt)
    }

    /// cmd 13 image-session end (footer). The JS repeats the frame count
    /// and interval from the begin packet with marker byte 0x00.
    pub fn screen_end(&mut self, frame_count: usize, frame_interval_ms: u16) -> Result<()> {
        if frame_count > SCREEN_MAX_FRAMES {
            bail!("khub916 screen: frame count {frame_count} exceeds {SCREEN_MAX_FRAMES}");
        }
        let payload = [
            0x00, // footer marker
            frame_count as u8,
            0x00,
            frame_interval_ms as u8,
            (frame_interval_ms >> 8) as u8,
        ];
        let pkt = Self::screen_packet(
            [CMD_SCREEN_BEGIN_END, 0, 0, 0x01, 0, 0x05, 0x00],
            &payload,
        )?;
        self.screen_write(&pkt)
    }

    /// cmd 12: send one frame of RGB565 big-endian pixel data as 512-byte
    /// chunk packets `[12,0,frameIdx,chunkIdx,0,0,2] + data`, paced by
    /// `pacing` (vendor: 30–50 ms per chunk plus a frame delay). Returns
    /// the number of chunk packets sent.
    ///
    /// `frame` must be non-empty and at most
    /// [`SCREEN_MAX_CHUNKS_PER_FRAME`] × [`SCREEN_CHUNK_BYTES`] bytes
    /// (≤130 560 B); `frame_index` must be < 256. On error the session may
    /// be left mid-animation — send [`Self::screen_end`] or reopen.
    /// **Hardware-unverified.**
    pub fn screen_frame(
        &mut self,
        frame_index: usize,
        frame: &[u8],
        pacing: ScreenPacing,
    ) -> Result<usize> {
        if frame_index >= 256 {
            bail!("khub916 screen: frame index {frame_index} exceeds u8");
        }
        if frame.is_empty() {
            bail!("khub916 screen: empty frame");
        }
        let chunks = frame.len().div_ceil(SCREEN_CHUNK_BYTES);
        if chunks > SCREEN_MAX_CHUNKS_PER_FRAME {
            bail!(
                "khub916 screen: frame needs {chunks} chunks, max {SCREEN_MAX_CHUNKS_PER_FRAME}"
            );
        }
        for chunk_index in 0..chunks {
            let start = chunk_index * SCREEN_CHUNK_BYTES;
            let end = (start + SCREEN_CHUNK_BYTES).min(frame.len());
            let mut data = [0u8; SCREEN_CHUNK_BYTES];
            data[..end - start].copy_from_slice(&frame[start..end]);
            let pkt = Self::screen_packet(
                [
                    CMD_SCREEN_FRAME,
                    0,
                    frame_index as u8,
                    chunk_index as u8,
                    0,
                    0,
                    0x02,
                ],
                &data,
            )?;
            self.screen_write(&pkt)?;
            if !pacing.chunk_delay.is_zero() {
                std::thread::sleep(pacing.chunk_delay);
            }
        }
        if !pacing.frame_delay.is_zero() {
            std::thread::sleep(pacing.frame_delay);
        }
        Ok(chunks)
    }

    /// High-level animation push: cmd-13 begin → all frames (chunked,
    /// paced) → cmd-13 end. `frames` are raw RGB565-BE pixel buffers
    /// (`width*height*2` bytes each); `frame_interval_ms` is the per-frame
    /// interval sent in the begin/end packets. Returns transfer stats.
    ///
    /// **Hardware-unverified** and slow at vendor pacing (~2.5 s per
    /// 160×80 frame on `screen_interface`, ~1.5 s on `keyboard_interface`).
    pub fn screen_push(
        &mut self,
        frames: &[&[u8]],
        frame_interval_ms: u16,
        pacing: ScreenPacing,
    ) -> Result<ScreenPushStats> {
        if frames.is_empty() || frames.len() > SCREEN_MAX_FRAMES {
            bail!(
                "khub916 screen: need 1..={SCREEN_MAX_FRAMES} frames, got {}",
                frames.len()
            );
        }
        self.screen_begin(frames.len(), frame_interval_ms)?;
        let mut chunks = 0usize;
        let mut bytes = 0usize;
        for (i, frame) in frames.iter().enumerate() {
            chunks += self.screen_frame(i, frame, pacing)?;
            bytes += frame.len();
        }
        self.screen_end(frames.len(), frame_interval_ms)?;
        Ok(ScreenPushStats {
            frames: frames.len(),
            chunks,
            frame_bytes: bytes,
        })
    }

    /// cmd 11 screen clock sync (wired keyboard interface only — the JS
    /// explicitly no-ops this on wireless models). Fire-and-forget.
    /// **Hardware-unverified**: whether the keyboard forwards this to a
    /// separate screen interface is unknown (screen spec §8).
    pub fn set_screen_clock(&mut self, clock: &ScreenClock) -> Result<()> {
        let payload = [
            0x00, 0x00, 0x00, // bytes 7-9 reserved
            clock.year as u8,
            (clock.year >> 8) as u8,
            clock.month,
            clock.day,
            clock.hour,
            clock.minute,
            clock.second,
            clock.week,
        ];
        let pkt = Self::screen_packet([CMD_SCREEN_CLOCK, 0, 0, 0x01, 0, 0x0E, 0x00], &payload)?;
        self.screen_write(&pkt)
    }
}

/// Probe a link for the khub916 feature-report id. The WebHID driver uses
/// `featureReports[0].reportId` (6 on the K1 Pro); hidapi does not expose
/// report descriptors, so this tries the known value first, then scans
/// 1..=32. Only the read-only device-info query (cmd 130) is ever sent.
pub fn probe_report_id(link: &mut dyn Link) -> Result<u8> {
    let candidates: Vec<u8> = std::iter::once(6)
        .chain((1..=32).filter(|&i| i != 6))
        .collect();
    let mut last_err = anyhow!("khub916: no report id answered");
    for id in candidates {
        let pkt = Khub916::packet(CMD_DEVICE_INFO, 0x01, 0x0A, 0x00, &[])?;
        match link.feature_exchange(id, &pkt, TRANSPORT_TIMEOUT) {
            Ok(Some(resp))
                if resp.len() >= HEADER_LEN + 9 && resp[..HEADER_LEN] == pkt[..HEADER_LEN] =>
            {
                return Ok(id);
            }
            Ok(Some(resp)) => {
                last_err = anyhow!(
                    "report id {id}: bad echo/short response ({} bytes)",
                    resp.len()
                );
            }
            Ok(None) => last_err = anyhow!("report id {id}: no answer"),
            Err(e) => last_err = anyhow!("report id {id}: {e:#}"),
        }
    }
    Err(last_err.context("khub916 report id probe failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Duration;

    /// Shared mock state so tests can inspect sent packets after the
    /// session owns the link.
    #[derive(Default)]
    struct MockShared {
        responses: VecDeque<Result<Vec<u8>, String>>,
        /// feature_exchange captures.
        sent: Vec<(u8, Vec<u8>)>,
        /// feature_write captures (screen commands).
        feature_writes: Vec<(u8, Vec<u8>)>,
    }

    /// Scripted feature-report link: pops queued responses per exchange.
    struct MockLink {
        shared: std::rc::Rc<std::cell::RefCell<MockShared>>,
    }

    impl MockLink {
        fn new(responses: Vec<Result<Vec<u8>, String>>) -> Self {
            Self {
                shared: std::rc::Rc::new(std::cell::RefCell::new(MockShared {
                    responses: responses.into(),
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
        fn write(&mut self, _report_id: u8, _data: &[u8]) -> Result<()> {
            Ok(())
        }
        fn read(&mut self, _timeout: Duration) -> Result<Option<Vec<u8>>> {
            Ok(None)
        }
        fn feature_exchange(
            &mut self,
            report_id: u8,
            payload: &[u8],
            _timeout: Duration,
        ) -> Result<Option<Vec<u8>>> {
            let mut sh = self.shared.borrow_mut();
            sh.sent.push((report_id, payload.to_vec()));
            match sh.responses.pop_front() {
                Some(Ok(r)) => Ok(Some(r)),
                Some(Err(e)) => Err(anyhow!(e)),
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

    /// Live-verified fixtures from docs/protocol-khub916.md §5.
    const INFO_HEADER: [u8; 7] = [0x82, 0x01, 0x00, 0x01, 0x00, 0x0A, 0x00];
    const KEYMAP_HEADER: [u8; 7] = [0x83, 0x00, 0x00, 0x01, 0x00, 0xF8, 0x01];
    const POWER_HEADER: [u8; 7] = [0x87, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00];

    fn info_response() -> Vec<u8> {
        // `82 01 00 01 00 0A 00 | 03 00 00 00 01 97 | 01 00 | 00`
        let mut r = INFO_HEADER.to_vec();
        r.extend_from_slice(&[0x03, 0x00, 0x00, 0x00, 0x01, 0x97, 0x01, 0x00, 0x00]);
        r
    }

    #[test]
    fn packet_layout_matches_spec() {
        let pkt = Khub916::packet(0x82, 0x01, 0x0A, 0x00, &[]).unwrap();
        assert_eq!(&pkt[..7], &INFO_HEADER);
        assert!(pkt[7..].iter().all(|&b| b == 0));
        // Constant triple 00 01 00 at bytes 2..5.
        let p2 = Khub916::packet(0x03, 0x00, 0xF8, 0x01, &[1, 2, 3]).unwrap();
        assert_eq!(&p2[..7], &[0x03, 0x00, 0x00, 0x01, 0x00, 0xF8, 0x01]);
        assert_eq!(&p2[7..10], &[1, 2, 3]);
        // Oversize payload refused before anything is sent.
        assert!(Khub916::packet(3, 0, 0xF8, 0x01, &[0u8; 600]).is_err());
    }

    #[test]
    fn device_info_parses_live_fixture() {
        let link = Box::new(MockLink::new(vec![Ok(info_response())]));
        let mut kb = Khub916::new(link, 6);
        let info = kb.device_info().unwrap();
        assert_eq!(info.uuid, Uuid([0x03, 0x00, 0x00, 0x00, 0x01, 0x97]));
        assert_eq!(info.uuid.to_string(), "0x030000000197");
        assert_eq!(info.version, 0x0100);
        assert_eq!(info.screen_size, 0);
        assert_eq!(info.screen, None);
        assert_eq!(info.catalog_model.as_deref(), Some("916_K1_PRO"));
        assert_eq!(
            info.catalog_name.as_deref(),
            Some("GravaStar Mercury K1 PRO")
        );
    }

    #[test]
    fn device_info_unknown_uuid_has_no_catalog_entry() {
        let mut r = INFO_HEADER.to_vec();
        r.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x00, 0x04]);
        let link = Box::new(MockLink::new(vec![Ok(r)]));
        let mut kb = Khub916::new(link, 6);
        let info = kb.device_info().unwrap();
        assert_eq!(info.uuid.to_string(), "0xdeadbeef0001");
        assert_eq!(info.catalog_model, None);
        assert_eq!(info.screen, Some((240, 240))); // screen_size 4
    }

    #[test]
    fn power_parses_live_fixture() {
        // `87 00 00 01 00 02 00 | 64 11` — level 100, flags 0x11.
        let mut r = POWER_HEADER.to_vec();
        r.extend_from_slice(&[0x64, 0x11]);
        let link = Box::new(MockLink::new(vec![Ok(r)]));
        let mut kb = Khub916::new(link, 6);
        let p = kb.power().unwrap();
        assert_eq!(p.percent, 100);
        assert_eq!(p.flags, 0x11);
    }

    #[test]
    fn keymap_decodes_live_prefix() {
        // Live K1 Pro reply starts with u32 BE 0x29 (ESC), 0x35 (`), 0x2B
        // (Tab), 0x39 (Caps) — spec §5.
        let mut r = KEYMAP_HEADER.to_vec();
        for v in [0x00000029u32, 0x00000035, 0x0000002B, 0x00000039] {
            r.extend_from_slice(&v.to_be_bytes());
        }
        let link = Box::new(MockLink::new(vec![Ok(r)]));
        let mut kb = Khub916::new(link, 6);
        let keys = kb.keymap(0).unwrap();
        assert_eq!(keys.len(), 4);
        assert_eq!(keys[0].label(), "Esc");
        assert_eq!(keys[1].label(), "`");
        assert_eq!(keys[2].label(), "Tab");
        assert_eq!(keys[3].label(), "Caps");
    }

    #[test]
    fn decode_key_value_tags() {
        assert_eq!(decode_key_value(0), KeyValue::Empty);
        assert_eq!(
            decode_key_value(0x00000029),
            KeyValue::Normal {
                usage: 0x29,
                ctrl: false,
                shift: false,
                alt: false,
                gui: false
            }
        );
        assert_eq!(
            decode_key_value(0x00040029),
            KeyValue::Normal {
                usage: 0x29,
                ctrl: false,
                shift: false,
                alt: true,
                gui: false
            }
        );
        assert_eq!(
            decode_key_value(0x03011234),
            KeyValue::Macro {
                macro_type: 1,
                number: 0x12,
                index: 0x34
            }
        );
        assert_eq!(decode_key_value(0x0D000000), KeyValue::Fn { layer: 0 });
        assert_eq!(decode_key_value(0x0D010000), KeyValue::Fn { layer: 1 });
        assert!(matches!(
            decode_key_value(0x20DEADBE),
            KeyValue::Socd { .. }
        ));
        assert!(matches!(decode_key_value(0x21000001), KeyValue::Mt { .. }));
        assert!(matches!(decode_key_value(0x22000002), KeyValue::Tgl { .. }));
        assert!(matches!(
            decode_key_value(0xDEADBEEF),
            KeyValue::Unknown { raw: 0xDEADBEEF }
        ));
        // Labels.
        assert_eq!(decode_key_value(0x0002001E).label(), "Shift+1");
        assert_eq!(decode_key_value(0x0D000000).label(), "Fn");
        assert_eq!(decode_key_value(0x0D010000).label(), "Fn1");
    }

    #[test]
    fn echo_mismatch_retries_then_fails() {
        // Wrong echo three times → error, session poisoned.
        let bad = vec![0xFFu8; 32];
        let link = Box::new(MockLink::new(vec![
            Ok(bad.clone()),
            Ok(bad.clone()),
            Ok(bad),
        ]));
        let mut kb = Khub916::new(link, 6);
        assert!(kb.device_info().is_err());
        assert!(kb.is_poisoned());
    }

    #[test]
    fn short_response_retries_then_fails() {
        let link = Box::new(MockLink::new(vec![Ok(vec![1, 2]), Ok(vec![3])]));
        let mut kb = Khub916::new(link, 6);
        assert!(kb.device_info().is_err());
        assert!(kb.is_poisoned());
    }

    #[test]
    fn custom_light_planes_decode() {
        // 378 B payload: R plane, G plane, B plane; entry i → pos 8+4i.
        let mut payload = vec![0u8; CUSTOM_LIGHT_ENTRIES * 3];
        payload[0] = 0x11; // R[0]
        payload[CUSTOM_LIGHT_ENTRIES] = 0x22; // G[0]
        payload[2 * CUSTOM_LIGHT_ENTRIES] = 0x33; // B[0]
        payload[1] = 0x44; // R[1]
        payload[CUSTOM_LIGHT_ENTRIES + 1] = 0x55;
        payload[2 * CUSTOM_LIGHT_ENTRIES + 1] = 0x66;
        // Header for cmd 134 read: 86 00 00 01 00 7A 01.
        let mut r = vec![0x86, 0x00, 0x00, 0x01, 0x00, 0x7A, 0x01];
        r.extend_from_slice(&payload);
        let link = Box::new(MockLink::new(vec![Ok(r)]));
        let mut kb = Khub916::new(link, 6);
        let colors = kb.custom_light_colors().unwrap();
        assert_eq!(colors.len(), CUSTOM_LIGHT_ENTRIES);
        assert_eq!(
            colors[0],
            LightColor {
                index: 0,
                pos: 8,
                r: 0x11,
                g: 0x22,
                b: 0x33
            }
        );
        assert_eq!(colors[1].pos, 12);
        assert_eq!((colors[1].r, colors[1].g, colors[1].b), (0x44, 0x55, 0x66));
    }

    #[test]
    fn catalog_lookup_roundtrip() {
        let k1p = catalog_uuid("916_K1_PRO").unwrap();
        assert_eq!(k1p.to_string(), "0x030000000197");
        let e = catalog_lookup(&k1p).unwrap();
        assert_eq!(e.name, "GravaStar Mercury K1 PRO");
        assert!(catalog_uuid("no_such_model").is_none());
        assert!(Uuid::parse_hex("0x030000000197").is_ok());
        assert!(Uuid::parse_hex("0x1234").is_err());
    }

    #[test]
    fn serde_device_info() {
        let link = Box::new(MockLink::new(vec![Ok(info_response())]));
        let mut kb = Khub916::new(link, 6);
        let info = kb.device_info().unwrap();
        let j = serde_json::to_value(&info).unwrap();
        assert_eq!(j["uuid"], "0x030000000197");
        assert_eq!(j["catalog_model"], "916_K1_PRO");
    }

    // ── Screen commands (docs/protocol-khub916-screen.md; unverified) ──

    #[test]
    fn screen_begin_packet_layout() {
        let link = MockLink::new(vec![]);
        let shared = link.shared();
        let mut kb = Khub916::new(Box::new(link), 6);
        kb.screen_begin(2, 33).unwrap();
        let sh = shared.borrow();
        assert_eq!(sh.feature_writes.len(), 1);
        let (id, pkt) = &sh.feature_writes[0];
        assert_eq!(*id, 6);
        // [13,0,0,1,0,5,0] + [0x40,count,0,intLo,intHi] + zero pad.
        assert_eq!(&pkt[..7], &[13, 0, 0, 1, 0, 5, 0]);
        assert_eq!(&pkt[7..12], &[0x40, 2, 0, 33, 0]);
        assert!(pkt[12..].iter().all(|&b| b == 0));
        assert_eq!(pkt.len(), FEATURE_PAYLOAD_BYTES);
        // No feature_exchange was used — screen writes are fire-and-forget.
        assert!(sh.sent.is_empty());
    }

    #[test]
    fn screen_end_packet_layout() {
        let link = MockLink::new(vec![]);
        let shared = link.shared();
        let mut kb = Khub916::new(Box::new(link), 6);
        kb.screen_end(2, 33).unwrap();
        let sh = shared.borrow();
        let (_, pkt) = &sh.feature_writes[0];
        assert_eq!(&pkt[..7], &[13, 0, 0, 1, 0, 5, 0]);
        assert_eq!(&pkt[7..12], &[0x00, 2, 0, 33, 0]); // marker 0x00 footer
    }

    #[test]
    fn screen_frame_chunks_and_indices() {
        // 600 bytes → 2 chunks (512 + 88 padded to 512).
        let frame: Vec<u8> = (0..600).map(|i| (i % 256) as u8).collect();
        let link = MockLink::new(vec![]);
        let shared = link.shared();
        let mut kb = Khub916::new(Box::new(link), 6);
        let chunks = kb.screen_frame(3, &frame, ScreenPacing::unpaced()).unwrap();
        assert_eq!(chunks, 2);
        let sh = shared.borrow();
        assert_eq!(sh.feature_writes.len(), 2);
        let (id, p0) = &sh.feature_writes[0];
        assert_eq!(*id, 6);
        // [12,0,frameIdx,chunkIdx,0,0,2] + 512 data bytes.
        assert_eq!(&p0[..7], &[12, 0, 3, 0, 0, 0, 2]);
        assert_eq!(&p0[7..12], &frame[..5]);
        assert_eq!(p0[7 + 512 - 1], frame[511]);
        let (_, p1) = &sh.feature_writes[1];
        assert_eq!(&p1[..7], &[12, 0, 3, 1, 0, 0, 2]);
        assert_eq!(&p1[7..7 + 88], &frame[512..]);
        assert!(p1[7 + 88..].iter().all(|&b| b == 0)); // zero-padded tail
    }

    #[test]
    fn screen_push_full_sequence() {
        let f0 = vec![0x11u8; 600];
        let f1 = vec![0x22u8; 100];
        let link = MockLink::new(vec![]);
        let shared = link.shared();
        let mut kb = Khub916::new(Box::new(link), 6);
        let stats = kb
            .screen_push(&[&f0, &f1], 40, ScreenPacing::unpaced())
            .unwrap();
        assert_eq!(stats.frames, 2);
        assert_eq!(stats.chunks, 2 + 1);
        assert_eq!(stats.frame_bytes, 700);
        let sh = shared.borrow();
        // begin + 3 chunks + end = 5 writes.
        assert_eq!(sh.feature_writes.len(), 5);
        assert_eq!(&sh.feature_writes[0].1[..12], &[13, 0, 0, 1, 0, 5, 0, 0x40, 2, 0, 40, 0]);
        assert_eq!(&sh.feature_writes[4].1[..12], &[13, 0, 0, 1, 0, 5, 0, 0x00, 2, 0, 40, 0]);
        // frame 1 chunk 0 carries frame_index=1.
        assert_eq!(&sh.feature_writes[3].1[..7], &[12, 0, 1, 0, 0, 0, 2]);
    }

    #[test]
    fn screen_frame_rejects_bad_input() {
        let link = MockLink::new(vec![]);
        let mut kb = Khub916::new(Box::new(link), 6);
        assert!(kb.screen_frame(256, &[1], ScreenPacing::unpaced()).is_err());
        assert!(kb.screen_frame(0, &[], ScreenPacing::unpaced()).is_err());
        assert!(kb.screen_frame(0, &[0u8; SCREEN_MAX_CHUNKS_PER_FRAME * SCREEN_CHUNK_BYTES + 1], ScreenPacing::unpaced()).is_err());
        assert!(kb.screen_begin(SCREEN_MAX_FRAMES + 1, 33).is_err());
        assert!(kb.screen_push(&[], 33, ScreenPacing::unpaced()).is_err());
    }

    #[test]
    fn screen_clock_packet_layout() {
        let link = MockLink::new(vec![]);
        let shared = link.shared();
        let mut kb = Khub916::new(Box::new(link), 6);
        // 2026-11-24 13:45:07, Tuesday → week 2.
        let clock = ScreenClock::new(2026, 11, 24, 13, 45, 7, 2).unwrap();
        kb.set_screen_clock(&clock).unwrap();
        let sh = shared.borrow();
        let (_, pkt) = &sh.feature_writes[0];
        assert_eq!(&pkt[..7], &[11, 0, 0, 1, 0, 14, 0]);
        // bytes 7-9 zero, then year LE, month, day, h, m, s, week.
        assert_eq!(
            &pkt[7..18],
            &[0, 0, 0, 0xEA, 0x07, 11, 24, 13, 45, 7, 2]
        );
        assert!(ScreenClock::new(2026, 13, 1, 0, 0, 0, 0).is_err());
        assert!(ScreenClock::new(2026, 1, 1, 24, 0, 0, 0).is_err());
        assert!(ScreenClock::new(2026, 1, 1, 0, 0, 0, 7).is_err());
    }

    #[test]
    fn rgb565_be_encoding() {
        // Pure red → 0xF800; green → 0x07E0; blue → 0x001F; white → 0xFFFF.
        assert_eq!(rgb565_be(255, 0, 0), [0xF8, 0x00]);
        assert_eq!(rgb565_be(0, 255, 0), [0x07, 0xE0]);
        assert_eq!(rgb565_be(0, 0, 255), [0x00, 0x1F]);
        assert_eq!(rgb565_be(255, 255, 255), [0xFF, 0xFF]);
        assert_eq!(rgb565_be(0, 0, 0), [0x00, 0x00]);
    }

    #[test]
    fn catalog_screen_topology() {
        // K98 Pro family → separate HID interface (spec §1).
        assert_eq!(
            catalog_screen("916_K98Pro"),
            Some(ScreenTopology::SeparateInterface)
        );
        assert_eq!(
            catalog_screen("916_K98Pro_JP"),
            Some(ScreenTopology::SeparateInterface)
        );
        // K95 → screen on the keyboard interface, 160×80.
        assert_eq!(
            catalog_screen("916_K95"),
            Some(ScreenTopology::OnKeyboardInterface {
                width: 160,
                height: 80
            })
        );
        // K1 Pro and unknown models have no screen entry.
        assert_eq!(catalog_screen("916_K1_PRO"), None);
        assert_eq!(catalog_screen("no_such_model"), None);
        // Serde shape for the CLI JSON output.
        let j = serde_json::to_value(ScreenTopology::SeparateInterface).unwrap();
        assert_eq!(j["type"], "separate_interface");
    }
}
